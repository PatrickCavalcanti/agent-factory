// Treino dentro do app (Task 13): serviço (casos→retrato→embed→worker→cabeça→invalidação), 409, 503, worker.
// Embedder falso, dataDir temporário e extrator falso: nada de banco, nem de logs reais.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarServicoDeTreino, lerOpcoes, ErroDeTreino } from '../treino/lib/servico.js';
import { treinarCabecaNoWorker } from '../treino/lib/worker-treino.js';
import { treinarCabeca, novaCabeca, serializarCabeca, montarIndice, exportarRetrato, carregarCabeca } from '../src/local/index.js';
import { tentarTravar, travado } from '../treino/lib/trava.js';
import { caminhoAtual, gravarVersao, lerHistorico, versaoAtual } from '../treino/lib/versoes.js';
import { resumirConferencia } from '../treino/lib/conferencia.js';
import { linhaSinalDoAnel } from '../treino/lib/linha-sinal.js';
import { gravarCaso, marcarValido, lerEstado, lerCasos } from '../treino/lib/registro.js';

// `obterPiso` é obrigatório no serviço: nos testes, um piso que não toca o catálogo falso (registry cheio, sem efeito nos rótulos)
const PISO_DE_TESTE = () => ({ ids: ['capacidade-inexistente'], fixas: [], powers: 1 });

const CHAVES = ['agenda', 'tarefa', 'nota', 'x'];
const emb = { modelSlug: 'falso', async embed(t) { const s = String(t); return CHAVES.map((k, i) => (s.includes(k) ? 1 : 0.01 * (i + 1))); } };
const capacidades = [
  { id: 'agenda', semanticText: 'agenda', tools: [{ name: 'a1', exemplos: ['agenda de hoje', 'agenda x'], semanticText: 'agenda tool' }, { name: 'a2', semanticText: 'agenda outra' }] },
  { id: 'tarefas', semanticText: 'tarefa', tools: [{ name: 't1', semanticText: 'tarefa abrir', exemplos: ['abrir tarefa'] }, { name: 't2', semanticText: 'tarefa fechar' }] },
  { id: 'notas', semanticText: 'nota', tools: [{ name: 'n1', description: 'nota criar' }, { name: 'n2', description: 'nota apagar' }] },
];
const casos = Array.from({ length: 180 }, (_, n) => ({
  ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00`,
  pedido: ['agenda de amanhã', 'tarefa aberta', 'nota sobre x'][n % 3],
  capacidades: [['agenda'], ['tarefas'], ['notas']][n % 3],
  funcoes: [['a1'], ['t1'], ['n1']][n % 3],
}));

async function dataDirComRetratos(aneis = ['provider', 'tool']) {
  const dir = mkdtempSync(join(tmpdir(), 'servico-'));
  mkdirSync(join(dir, 'decisoes', 'indice'), { recursive: true });
  for (const anel of aneis) {
    const ind = await montarIndice({ anel, capacidades, embedder: emb });
    writeFileSync(join(dir, 'decisoes', 'indice', `${anel}.json`), JSON.stringify(exportarRetrato(ind)));
  }
  return dir;
}
const extrairFalso = (dataDir) => async ({ dataDir: d }) => {
  assert.equal(d, dataDir);
  return { ok: true, casos, descartadas: 0, fora: 0, futuros: 0 };
};

test('lerOpcoes: defaults vêm do portão da config; o body sobrepõe margem/minAvaliacao/dias; chave removida, NaN/null e fora da faixa dão 400', () => {
  assert.deepEqual(lerOpcoes(undefined), { aneis: ['provider', 'tool'], minAvaliacao: 30, margem: 0, dias: 14 });
  assert.deepEqual(lerOpcoes(undefined, { margem: 0.05, minAvaliacao: 12, toleranciaVersao: 0.02 }), { aneis: ['provider', 'tool'], minAvaliacao: 12, margem: 0.05, dias: 14 });
  assert.deepEqual(lerOpcoes({ minAvaliacao: 7, margem: -1, dias: 3 }, { margem: 0.05, minAvaliacao: 12 }), { aneis: ['provider', 'tool'], minAvaliacao: 7, margem: -1, dias: 3 });
  assert.deepEqual(lerOpcoes({ aneis: ['tool', 'tool'] }).aneis, ['tool']);
  const ruins = [
    { aneis: ['skill'] }, { aneis: [] },
    { min: 10 }, { minRecentes: 3 }, { min: undefined }, // opções do portão por capacidade: removidas, não ignoradas em silêncio
    { minAvaliacao: 'x' }, { minAvaliacao: NaN }, { minAvaliacao: null }, { minAvaliacao: 1.5 }, { minAvaliacao: 0 },
    { margem: NaN }, { margem: null }, { margem: -2 }, { margem: 2 }, // margem ∈ [-1, 1], como em normalizarPortao
    { dias: 0 }, { dias: NaN }, { dias: null },
  ];
  for (const ruim of ruins) assert.throws(() => lerOpcoes(ruim), (e) => e instanceof ErroDeTreino && e.status === 400, JSON.stringify(ruim));
  assert.throws(() => lerOpcoes({ min: 10 }), /minAvaliacao/, 'a mensagem diz o que usar no lugar');
  // o que o CLI mandaria com `Number('abc')`: JSON.stringify(NaN) vira null — 400, não "padrão" em silêncio
  assert.throws(() => lerOpcoes(JSON.parse(JSON.stringify({ margem: Number('abc') }))), (e) => e.status === 400);
});

test('linha-sinal: aprovada / não ganhou / sem veredito (grava ou mantida) / piorou (mantida), com o diagnóstico', () => {
  const dg = (extra = {}) => ({ pareado: { cabecaVenceu: 30, baseVenceu: 8, empate: 68 }, minAvaliacao: 30, ...extra });
  assert.equal(linhaSinalDoAnel('provider', { anelAprovado: true, portao: 'aprovada', metricasAnel: { base: 0.42, cabeca: 0.56, n: 106 }, diagnostico: dg() }), 'OK provider: cabeça aprovada (R@3 0,56 × base 0,42, n=106; venceu 30, perdeu 8, empate 68)');
  assert.equal(linhaSinalDoAnel('tool', { anelAprovado: false, portao: 'nao-ganhou', metricasAnel: { base: 0.5, cabeca: 0.41, n: 64 }, diagnostico: dg({ pareado: { cabecaVenceu: 9, baseVenceu: 17, empate: 38 } }) }), 'OK tool: cabeça reprovada — não ganhou da base (n=64: cabeça 0,41 × base 0,50; venceu 9, perdeu 17, empate 38)');
  assert.equal(linhaSinalDoAnel('tool', { anelAprovado: false, portao: 'poucos-recentes', metricasAnel: { base: 0.5, cabeca: 0.58, n: 12 }, diagnostico: dg() }), 'OK tool: cabeça reprovada — poucos-recentes (n=12/30, sem veredito; R@3 0,58 × base 0,50)');
  assert.equal(linhaSinalDoAnel('provider', { mantida: true, versao: 3, anelAprovado: true, portao: 'piorou-frente-a-atual', motivo: 'piorou-frente-a-atual', metricasAnel: { base: 0.4, cabeca: 0.52, n: 106 }, diagnostico: dg({ emUso: { versao: 3, r3Nova: 0.52, r3Recalculado: 0.60, r3BaseNosMesmos: 0.45, comparou: 48 } }) }), 'OK provider: versão v3 mantida — nova 0,52 × atual 0,60 × base 0,45 nos mesmos 48 casos (piorou)');
  // v1 em uso que perdia da base nos mesmos casos: descartada como régua; a nova foi julgada só contra a base
  assert.equal(linhaSinalDoAnel('provider', { anelAprovado: true, versao: 2, portao: 'aprovada', metricasAnel: { base: 0.42, cabeca: 0.56, n: 106 }, diagnostico: dg({ emUso: { versao: 1, r3Recalculado: 0.40, r3BaseNosMesmos: 0.45, comparou: 48, descartada: 'perde-da-base' } }) }), 'OK provider: cabeça aprovada (R@3 0,56 × base 0,42, n=106; venceu 30, perdeu 8, empate 68) — versão v1 em uso descartada (atual 0,40 × base 0,45 nos mesmos 48 casos)');
  assert.equal(linhaSinalDoAnel('provider', { mantida: true, versao: 1, anelAprovado: true, portao: 'poucos-recentes', metricasAnel: { base: 0.5, cabeca: 0.58, n: 12 }, diagnostico: dg() }), 'OK provider: versão v1 mantida — poucos-recentes (n=12/30, sem veredito; R@3 0,58 × base 0,50)');
  assert.match(linhaSinalDoAnel('provider', { mantida: true, versao: null, portao: 'poucos-recentes', metricasAnel: { n: 0 }, diagnostico: dg() }), /^OK provider: versão em uso mantida — poucos-recentes \(n=0\/30, sem veredito; R@3 — × base —\)$/);
  assert.match(linhaSinalDoAnel('provider', { anelAprovado: false }), /^OK provider: cabeça reprovada \(R@3 — × base —, n=0\)$/, 'resumo sem métricas não lança');
});

test('worker devolve o mesmo formato que treinarCabeca (síncrono) para a mesma entrada', async () => {
  const entrada = { casos: [{ s: [1, 0, 0], pos: new Set([0]) }, { s: [0, 1, 0], pos: new Set([1]) }], P: [[1, 0, 0], [0, 1, 0]], epocas: 3, posto: 2 };
  const direto = treinarCabeca(entrada);
  const noWorker = await treinarCabecaNoWorker(entrada);
  assert.deepEqual(Object.keys(noWorker).sort(), Object.keys(direto).sort());
  assert.deepEqual(noWorker.cabeca, direto.cabeca);
  assert.deepEqual(noWorker.perdas, direto.perdas);
});

test('worker: erro do treino vira rejeição', async () => {
  await assert.rejects(treinarCabecaNoWorker({ casos: [], P: [[1]] }), /sem casos/);
});

test('sucesso: grava cabeças carregáveis, invalida cada anel e devolve resumo com métricas', async () => {
  const dir = await dataDirComRetratos();
  try {
    const invalidados = [];
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, invalidar: (d, a) => invalidados.push([d, a]), extrair: extrairFalso(dir) });
    const r = await servico.treinar({ margem: -1 });
    assert.equal(r.ok, true);
    assert.equal(r.casos, 180);
    for (const anel of ['provider', 'tool']) {
      assert.equal(r.aneis[anel].ok, true, r.aneis[anel].motivo);
      assert.ok(r.aneis[anel].capacidades >= 3);
      assert.equal(typeof r.aneis[anel].metricas.agenda.base, 'number');
      // portão POR ANEL no resumo da rota (o que o treinar.mjs imprime): anelAprovado, portao, metricasAnel
      assert.equal(typeof r.aneis[anel].anelAprovado, 'boolean');
      assert.equal(typeof r.aneis[anel].portao, 'string');
      assert.ok(r.aneis[anel].metricasAnel.n > 0 && Number.isFinite(r.aneis[anel].metricasAnel.cabeca) && Number.isFinite(r.aneis[anel].metricasAnel.base));
      assert.equal('aprovadas' in r.aneis[anel], false); assert.equal('aprovadasLista' in r.aneis[anel], false);
      assert.match(linhaSinalDoAnel(anel, r.aneis[anel]), new RegExp(`^OK ${anel}: cabeça (aprovada|reprovada)`));
      assert.ok(r.aneis[anel].diagnostico.n > 0 && r.aneis[anel].diagnostico.funil.log.brutos > 0, 'diagnóstico na rota');
      const retrato = JSON.parse(readFileSync(join(dir, 'decisoes', 'indice', `${anel}.json`), 'utf8'));
      const c = carregarCabeca({ arquivo: caminhoAtual(join(dir, 'decisoes'), anel), slug: 'falso', hash: retrato.hash, dim: 4 });
      assert.equal(c.ok, true, c.motivo);
      assert.equal(c.versaoDoArquivo, 2);
      assert.equal(c.anelAprovado, r.aneis[anel].anelAprovado);
      assert.deepEqual(c.metricasAnel, r.aneis[anel].metricasAnel);
      // versão v1 + ponteiro; legado cabecas/<anel>.json não é mais escrito
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decisoes', 'cabecas', anel, 'atual.json'), 'utf8')), { versao: 1, arquivo: 'v1.json' });
      assert.equal(existsSync(join(dir, 'decisoes', 'cabecas', `${anel}.json`)), false);
      assert.equal(r.aneis[anel].versao, 1);
      // reposição da base: casos centrados + rótulos por ref, sem texto
      const base = JSON.parse(readFileSync(join(dir, 'decisoes', 'base', `${anel}-reposicao.json`), 'utf8'));
      assert.equal(base.versao, 2); // formato 2: vetor CRU (não centrado)
      assert.equal(base.slug, 'falso');
      assert.ok(base.casos.length > 0 && base.casos.length <= 2000);
      for (const k of base.casos) { assert.deepEqual(Object.keys(k).sort(), ['rotulos', 'v']); assert.equal(k.v.length, 4); assert.ok(k.v.every((x) => Math.abs(x * 1e5 - Math.round(x * 1e5)) < 1e-6)); assert.ok(Array.isArray(k.rotulos)); }
      assert.equal(/agenda de amanh|tarefa aberta|nota sobre/.test(JSON.stringify(base)), false);
      // calibração MANTIDA: o treino completo é o único que grava `indice/<anel>-roubados.json` (versão adotada), com o formato que o runtime lê
      const cal = JSON.parse(readFileSync(join(dir, 'decisoes', 'indice', `${anel}-roubados.json`), 'utf8'));
      assert.deepEqual(Object.keys(cal).sort(), ['anel', 'cortesSugeridos', 'hash', 'regra', 'resumo', 'roubados', 'slug']);
      assert.deepEqual([cal.anel, cal.slug, cal.hash, cal.regra], [anel, 'falso', retrato.hash, 'irmao-nao-rouba']);
      assert.ok(Array.isArray(cal.roubados) && typeof cal.resumo.roubados === 'number');
      assert.equal(existsSync(join(dir, 'decisoes', 'indice', `${anel}-roubados.json.${process.pid}.tmp`)), false, 'escrita atômica não deixa tmp');
    }
    assert.deepEqual(invalidados, [[dir, 'provider'], [dir, 'tool']]);
    assert.equal(servico.ocupado, false);
    // pedidos do treino vão para o cache próprio; o compartilhado (produção) só recebe textos do catálogo
    const chavePedido = (t) => `falso#query#${createHash('sha256').update(t).digest('hex').slice(0, 16)}`;
    const compartilhado = JSON.parse(readFileSync(join(dir, 'igris', 'cache', 'selecao-embeddings.json'), 'utf8')).itens;
    const proprio = JSON.parse(readFileSync(join(dir, 'igris', 'cache', 'treino-pedidos-embeddings.json'), 'utf8')).itens;
    const pedidos = [...new Set(casos.map((c) => c.pedido))];
    assert.ok(pedidos.length > 0);
    for (const t of pedidos) {
      assert.ok(Array.isArray(proprio[chavePedido(t)]), `pedido "${t}" no cache próprio`);
      assert.equal(compartilhado[chavePedido(t)], undefined, `pedido "${t}" fora do cache compartilhado`);
    }
    assert.ok(Object.keys(compartilhado).length > 0, 'catálogo no cache compartilhado');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('anel sem retrato: ok=false naquele anel, sem gravar cabeça nem invalidar', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const invalidados = [];
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, invalidar: (d, a) => invalidados.push(a), extrair: extrairFalso(dir) });
    const r = await servico.treinar({ margem: -1 });
    assert.equal(r.aneis.provider.ok, true);
    assert.equal(r.aneis.tool.ok, false);
    assert.match(r.aneis.tool.motivo, /retrato/);
    assert.deepEqual(invalidados, ['provider']);
    assert.equal(existsSync(join(dir, 'decisoes', 'cabecas', 'tool.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('503 sem embedder, com FALTA: — e não deixa o serviço ocupado', async () => {
  const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => '/nao-usado', obterEmbedder: () => null, extrair: async () => { throw new Error('nao deveria extrair'); } });
  await assert.rejects(servico.treinar({}), (e) => e.status === 503 && /^FALTA:/.test(e.message));
  assert.equal(servico.ocupado, false);
});

test('409 em chamada concorrente; libera depois (inclusive depois de erro)', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    let solta; const portao = new Promise((r) => { solta = r; });
    let falhar = false;
    const extrair = async (a) => { await portao; if (falhar) throw new Error('boom'); return extrairFalso(dir)(a); };
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair });
    const primeira = servico.treinar({ aneis: ['provider'], margem: -1 });
    await assert.rejects(servico.treinar({ aneis: ['provider'] }), (e) => e.status === 409);
    solta();
    assert.equal((await primeira).ok, true);
    falhar = true;
    await assert.rejects(servico.treinar({ aneis: ['provider'] }), /boom/);
    assert.equal(servico.ocupado, false);
    falhar = false;
    assert.equal((await servico.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extração sem pasta de logs vira 503 FALTA:', async () => {
  const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => 'x', obterEmbedder: () => emb, extrair: async () => ({ ok: false, motivo: 'x/logs/sessions não existe' }) });
  await assert.rejects(servico.treinar({}), (e) => e.status === 503 && /^FALTA:/.test(e.message));
});

test('extrairCasos: pasta de interação sem data no nome é pulada (conta em fora)', async () => {
  const { extrairCasos } = await import('../treino/lib/extrair.js');
  const dir = mkdtempSync(join(tmpdir(), 'extrair-'));
  try {
    const inter = join(dir, 'logs', 'sessions', '2026-09', 's1', 'interactions');
    const boa = join(inter, '20260901-100000_interaction-a', 'artifacts');
    mkdirSync(boa, { recursive: true });
    writeFileSync(join(boa, 'execution-log.json'), JSON.stringify({ input: { userMessage: 'oi', channel: 'web' } }));
    mkdirSync(join(inter, 'lixo', 'artifacts'), { recursive: true });
    writeFileSync(join(inter, 'lixo', 'artifacts', 'execution-log.json'), JSON.stringify({ input: { userMessage: 'oi' } }));
    const r = await extrairCasos({ dataDir: dir, raizPowers: join(dir, 'sem-powers'), agora: new Date(2026, 9, 6) });
    assert.equal(r.ok, true);
    assert.equal(r.casos.length, 1);
    assert.equal(r.fora, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serviço repassa minAvaliacao ao treino (poucos-recentes: anel não aprovado)', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    const r = await servico.treinar({ aneis: ['provider'], margem: -1, minAvaliacao: 1000 });
    assert.equal(r.aneis.provider.anelAprovado, false);
    assert.equal(r.aneis.provider.portao, 'poucos-recentes');
    assert.equal(typeof r.aneis.provider.metricas.agenda.base, 'number', 'as métricas por capacidade seguem informativas');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('portão: o serviço lê a versão em uso; com ela e sem veredito (poucos casos) NADA é gravado (mantida), o cursor/contador andam e o histórico registra a rejeição', async () => {
  const dir = await dataDirComRetratos(['provider']);
  const dirDecisoes = join(dir, 'decisoes');
  try {
    const invalidados = [];
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, invalidar: (d, a) => invalidados.push(a), extrair: extrairFalso(dir) });
    marcarValido(join(dirDecisoes, 'registro'));
    gravarVersao(dirDecisoes, 'provider', serializarCabeca(novaCabeca({ d: 4, posto: 2 }), { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 80 } }));
    const antes = readFileSync(caminhoAtual(dirDecisoes, 'provider'), 'utf8');
    // calibração já mantida: versão `mantida` NÃO a troca
    const arqCal = join(dirDecisoes, 'indice', 'provider-roubados.json');
    writeFileSync(arqCal, JSON.stringify({ anel: 'provider', hash: 'h-antigo', slug: 'falso', regra: 'irmao-nao-rouba', roubados: [], resumo: null, cortesSugeridos: null }));
    const calAntes = readFileSync(arqCal, 'utf8');
    const r = await servico.treinar({ aneis: ['provider'], margem: -1, minAvaliacao: 1000 });
    assert.equal(readFileSync(arqCal, 'utf8'), calAntes, 'versão mantida não troca a calibração mantida');
    assert.equal(r.ok, true);
    const a = r.aneis.provider;
    assert.deepEqual([a.ok, a.mantida, a.motivo, a.versao, a.anelAprovado, a.portao], [true, true, 'poucos-recentes', 1, true, 'poucos-recentes']);
    assert.equal(a.diagnostico.emUso.versao, 1);
    assert.equal(versaoAtual(dirDecisoes, 'provider'), 1, 'nenhuma versão nova');
    assert.equal(readFileSync(caminhoAtual(dirDecisoes, 'provider'), 'utf8'), antes, 'a em uso intacta');
    assert.equal(existsSync(join(dirDecisoes, 'base', 'provider-reposicao.json')), false, 'nem reposição');
    assert.deepEqual(invalidados, [], 'nem invalida a seleção');
    const h = lerHistorico(dirDecisoes, 'provider');
    assert.equal(h.length, 1);
    assert.deepEqual([h[0].completo, h[0].rejeitada, h[0].mantida, h[0].anelAprovado, h[0].portao], [true, 'poucos-recentes', true, true, 'poucos-recentes']);
    assert.ok(h[0].diagnostico && h[0].metricasAnel && 'ate' in h[0] && Array.isArray(h[0].ids), 'diagnóstico, métricas da candidata e cursor (ate/ids) no histórico');
    assert.equal(h[0].versao, undefined, 'não é versão gravada');
    // consome o cursor e o contador (rejeição legítima, como no lote)
    const e = lerEstado(join(dirDecisoes, 'registro'));
    assert.equal(e.aneis.provider.validos, 0);
    // a conferência mostra a rejeição
    const conf = resumirConferencia([], { provider: h }, { desde: '2020-01-01' }).aneis.provider;
    assert.equal(conf.atualizacoes.length, 0);
    assert.equal(conf.rejeitadas.length, 1);
    assert.deepEqual([conf.rejeitadas[0].motivo, conf.rejeitadas[0].mantida], ['poucos-recentes', true]);
    assert.ok(conf.rejeitadas[0].resumo.diagnostico);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('portão: a versão em uso é a régua só se VÁLIDA — v1 no provider vale; v1 no tool, outro embedder e outra dimensão não (grava com o anel na base)', async () => {
  const dir = await dataDirComRetratos(['provider', 'tool']);
  const dirDecisoes = join(dir, 'decisoes');
  const v1 = (anel, extra = {}) => ({ versao: 1, anel, slug: 'falso', hash: 'h', ...novaCabeca({ d: 4, posto: 2 }), aprovadas: ['agenda'], cortes: { full: 0.5, candidate: 0.2 }, metricas: { agenda: { nTreino: 60 } }, ...extra });
  const semear = (anel, arquivo) => gravarVersao(dirDecisoes, anel, arquivo);
  try {
    const criar = () => criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    const avisos = []; const original = console.warn; console.warn = (m) => avisos.push(String(m));
    try {
      // provider com v1 em uso: válida ali (D3 não muda nada no provider) → sem veredito, ela continua
      semear('provider', v1('provider'));
      const prov = await criar().treinar({ aneis: ['provider'], margem: -1, minAvaliacao: 1000 });
      assert.deepEqual([prov.aneis.provider.mantida, prov.aneis.provider.portao, prov.aneis.provider.versao], [true, 'poucos-recentes', 1]);
      // tool com v1 em uso: a produção a IGNORA (centróides mudaram) → não há régua → a nova é gravada, anel na base
      semear('tool', v1('tool'));
      const tool = await criar().treinar({ aneis: ['tool'], margem: -1, minAvaliacao: 1000 });
      assert.equal(tool.aneis.tool.mantida, undefined);
      assert.deepEqual([tool.aneis.tool.ok, tool.aneis.tool.anelAprovado, tool.aneis.tool.portao, tool.aneis.tool.versao], [true, false, 'poucos-recentes', 2]);
      assert.equal(tool.aneis.tool.diagnostico.emUso, null, 'sem versão em uso válida');
      assert.equal(carregarCabeca({ arquivo: caminhoAtual(dirDecisoes, 'tool'), slug: 'falso', dim: 4 }).versaoDoArquivo, 2);
      // v2 em uso de OUTRO embedder: ignorada
      semear('provider', serializarCabeca(novaCabeca({ d: 4, posto: 2 }), { anel: 'provider', slug: 'outro-embedder', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.1, cabeca: 5, n: 99 } }));
      const outro = await criar().treinar({ aneis: ['provider'], margem: -1, minAvaliacao: 1000 });
      assert.deepEqual([outro.aneis.provider.mantida, outro.aneis.provider.anelAprovado, outro.aneis.provider.portao], [undefined, false, 'poucos-recentes']);
      // v2 em uso de OUTRA dimensão (a produção também a ignora): ignorada com aviso
      semear('provider', serializarCabeca(novaCabeca({ d: 6, posto: 2 }), { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 80 } }));
      const dimOutra = await criar().treinar({ aneis: ['provider'], margem: -1, minAvaliacao: 1000 });
      assert.deepEqual([dimOutra.aneis.provider.mantida, dimOutra.aneis.provider.portao], [undefined, 'poucos-recentes']);
      assert.match(dimOutra.aneis.provider.diagnostico.emUso.ignorada, /dimensão 6 ≠ 4/);
      assert.ok(avisos.some((m) => /versão em uso ignorada/.test(m)));
    } finally { console.warn = original; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('portão: piorar frente à versão em uso (recalculada nos mesmos casos) é rejeição no serviço — nada gravado, histórico rejeitada, linha-sinal "mantida"', async () => {
  const dir = await dataDirComRetratos(['tool']);
  const dirDecisoes = join(dir, 'decisoes');
  try {
    const criar = (extra = {}) => criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir), ...extra });
    // 1ª: treina normalmente (v1, a "boa")
    const r1 = await criar().treinar({ aneis: ['tool'], margem: -1, minAvaliacao: 5 });
    assert.equal(r1.aneis.tool.ok, true);
    assert.equal(r1.aneis.tool.versao, 1);
    // 2ª: o treino devolve uma cabeça com o ranking INVERTIDO (alfa < 0): pior que a v1 nos mesmos casos
    const invertida = async (a) => { const { cabeca, perdas } = treinarCabeca(a); return { cabeca: { ...cabeca, alfa: -Math.abs(cabeca.alfa) - 5 }, perdas }; };
    const invalidados = [];
    const r2 = await criar({ treinarCabecaFn: invertida, invalidar: (d, a) => invalidados.push(a) }).treinar({ aneis: ['tool'], margem: -1, minAvaliacao: 5 });
    const a = r2.aneis.tool;
    assert.deepEqual([a.ok, a.mantida, a.motivo, a.versao], [true, true, 'piorou-frente-a-atual', 1]);
    assert.ok(a.diagnostico.emUso.r3Nova < a.diagnostico.emUso.r3Recalculado - 0.02, JSON.stringify(a.diagnostico.emUso));
    assert.equal(versaoAtual(dirDecisoes, 'tool'), 1);
    assert.deepEqual(invalidados, []);
    assert.match(linhaSinalDoAnel('tool', a), /^OK tool: versão v1 mantida — nova \d,\d\d × atual \d,\d\d × base \d,\d\d nos mesmos \d+ casos \(piorou\)$/);
    const h = lerHistorico(dirDecisoes, 'tool');
    assert.equal(h.length, 2);
    assert.deepEqual([h[1].rejeitada, h[1].mantida, h[1].anelAprovado], ['piorou-frente-a-atual', true, r1.aneis.tool.anelAprovado]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('histórico do treino completo → conferência: anelAprovado, portao, metricasAnel, metricas e diagnostico no TOPO da entrada; atualizacoes[] não sai com null', async () => {
  const dir = await dataDirComRetratos(['provider', 'tool']);
  const dirDecisoes = join(dir, 'decisoes');
  try {
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    const r = await servico.treinar({ margem: -1, minAvaliacao: 5 });
    assert.equal(r.ok, true);
    for (const anel of ['provider', 'tool']) {
      const h = lerHistorico(dirDecisoes, anel);
      assert.equal(h.length, 1);
      const e = h[0];
      assert.equal(e.completo, true);
      assert.equal(typeof e.anelAprovado, 'boolean');
      assert.equal(typeof e.portao, 'string');
      assert.ok(e.metricasAnel && Number.isFinite(e.metricasAnel.cabeca) && Number.isFinite(e.metricasAnel.base) && e.metricasAnel.n > 0);
      assert.equal(typeof e.metricas.agenda.base, 'number');
      assert.ok(e.diagnostico && e.diagnostico.n === e.metricasAnel.n && e.diagnostico.funil && e.diagnostico.pareado);
      assert.equal(e.versao, 1);
      // a conferência lê do topo: nada pode sair null
      const [u] = resumirConferencia([], { [anel]: h }, { desde: '2020-01-01' }).aneis[anel].atualizacoes;
      assert.equal(u.versao, 1);
      assert.equal(u.anelAprovado, r.aneis[anel].anelAprovado);
      assert.deepEqual(u.metricasAnel, r.aneis[anel].metricasAnel);
      assert.notEqual(u.anelAprovado, null); assert.notEqual(u.metricasAnel, null);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extrairCasos: sem pasta de logs devolve ok=false (nada gravado)', async () => {
  const { extrairCasos } = await import('../treino/lib/extrair.js');
  const dir = mkdtempSync(join(tmpdir(), 'extrair-'));
  try {
    const r = await extrairCasos({ dataDir: dir });
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(dir, 'decisoes')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trava única: 409 com a trava tomada por outro nome (a atualização por lote); libera depois do treino', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    const liberar = tentarTravar('atualizacao');
    assert.equal(servico.ocupado, true);
    await assert.rejects(servico.treinar({ aneis: ['provider'] }), (e) => e.status === 409 && /atualizacao/.test(e.message));
    liberar();
    assert.equal(servico.ocupado, false);
    assert.equal((await servico.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
    assert.equal(travado(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('treino completo usa também o registro; sem logs, treina só com o registro', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const reg = join(dir, 'decisoes', 'registro');
    const vet = { agenda: [1, 0.02, 0.03, 0.04], tarefas: [0.01, 1, 0.03, 0.04], notas: [0.01, 0.02, 1, 0.04] };
    const caps = ['agenda', 'tarefas', 'notas'];
    for (let n = 0; n < 90; n++) {
      const cap = caps[n % 3];
      gravarCaso(reg, { ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00`, vetores: [vet[cap]], usadas: { capacidades: [cap], funcoes: [] }, carregadas: { provider: [cap] }, triagem: { valido: true, tipo: 'positivo' } });
    }
    gravarCaso(reg, { ts: '2026-09-20T00:00:00', vetores: [vet.agenda], usadas: { capacidades: ['agenda'], funcoes: [] }, triagem: { valido: false } }); // inválido não entra
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: async () => ({ ok: false, motivo: 'sem logs' }) });
    const r = await servico.treinar({ aneis: ['provider'], margem: -1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.registro, 90);
    assert.equal(r.aneis.provider.doRegistro, 90);
    // com logs + registro: somam
    const servico2 = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    const r2 = await servico2.treinar({ aneis: ['provider'], margem: -1 });
    assert.equal(r2.aneis.provider.treino + r2.aneis.provider.recentes, 180 + 90);
    assert.equal(r2.aneis.provider.versao, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sem logs e sem registro continua 503 FALTA:', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: async () => ({ ok: false, motivo: 'sem logs' }) });
    await assert.rejects(servico.treinar({ aneis: ['provider'] }), (e) => e.status === 503 && /^FALTA:/.test(e.message));
    assert.equal(servico.ocupado, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('treino completo zera o contador do registro (só com algum anel ok)', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const reg = join(dir, 'decisoes', 'registro');
    marcarValido(reg); marcarValido(reg);
    assert.equal(lerEstado(reg).validosDesdeUltima, 2);
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir) });
    // anel sem retrato falha: contador intacto
    assert.equal((await servico.treinar({ aneis: ['tool'], margem: -1 })).ok, false);
    assert.equal(lerEstado(reg).validosDesdeUltima, 2);
    assert.equal((await servico.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
    const e = lerEstado(reg);
    assert.equal(e.validosDesdeUltima, 0);
    assert.equal(e.versao, 1);
    assert.ok(e.ultimaAtualizacao);
    // só o anel que treinou avança o cursor e o contador; o outro mantém o dele
    assert.equal(e.aneis.provider.validos, 0);
    assert.equal(e.aneis.tool.validos, 2);
    assert.equal(e.aneis.tool.cursor, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D6: o relógio do treino completo é injetável (`agora`): o `quando` do histórico, o `desde` do extrator e o carimbo do contador/cursor usam ele, não o Date global', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const reg = join(dir, 'decisoes', 'registro');
    marcarValido(reg); // contador sem caso lido: o cursor cai no `quando` do serviço
    const instante = new Date('2026-10-09T09:00:00.000Z');
    let recebido = null;
    const extrair = async (a) => { recebido = a.agora; return extrairFalso(dir)(a); };
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair, agora: () => instante });
    const r = await servico.treinar({ aneis: ['provider'], margem: -1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(recebido instanceof Date && recebido.getTime() === instante.getTime(), 'o extrator recebe o agora injetado (o `ehFuturo` dele)');
    assert.equal(lerHistorico(join(dir, 'decisoes'), 'provider').at(-1).quando, '2026-10-09T09:00:00.000Z');
    const e = lerEstado(reg);
    assert.equal(e.ultimaAtualizacao, '2026-10-09T09:00:00.000Z');
    assert.equal(e.aneis.provider.cursor, '2026-10-09T09:00:00.000Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D6: sem `agora` injetado o padrão é o relógio do processo (new Date())', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    let recebido = null;
    const extrair = async (a) => { recebido = a.agora; return extrairFalso(dir)(a); };
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair });
    const antes = Date.now();
    assert.equal((await servico.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
    assert.ok(recebido instanceof Date && recebido.getTime() >= antes - 5 && recebido.getTime() <= Date.now() + 5);
    const quando = Date.parse(lerHistorico(join(dir, 'decisoes'), 'provider').at(-1).quando);
    assert.ok(quando >= antes - 5 && quando <= Date.now() + 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('contador sem perda no treino completo: caso gravado DURANTE o treino continua contado e entra no próximo lote', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const reg = join(dir, 'decisoes', 'registro');
    const vet = [1, 0.02, 0.03, 0.04];
    const valido = (ts) => ({ ts, vetores: [vet], usadas: { capacidades: ['agenda'], funcoes: [] }, triagem: { valido: true } });
    for (let n = 1; n <= 3; n++) gravarCaso(reg, valido(`2026-09-1${n}T00:00:00`));
    // o extrator (que roda depois do retrato do contador) grava mais um caso válido: simula turno durante o treino
    const extrair = async (a) => { gravarCaso(reg, valido('2026-09-20T00:00:00')); return extrairFalso(dir)(a); };
    const servico = criarServicoDeTreino({ obterPiso: PISO_DE_TESTE, obterDataDir: () => dir, obterEmbedder: () => emb, extrair });
    const r = await servico.treinar({ aneis: ['provider'], margem: -1 });
    assert.equal(r.ok, true);
    assert.equal(r.registro, 3); // o 4º não foi lido pelo treino
    const e = lerEstado(reg);
    assert.equal(e.validosDesdeUltima, 1);
    assert.equal(e.aneis.provider.cursor, '2026-09-13T00:00:00');
    assert.equal(e.aneis.provider.validos, 1);
    assert.equal(e.ultimaAtualizacao, '2026-09-13T00:00:00'); // ts do último consumido, não "agora"
    assert.deepEqual(lerCasos(reg, { desde: e.ultimaAtualizacao, validos: true }).map((c) => c.ts), ['2026-09-20T00:00:00']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('piso: o treino completo exclui só o piso INCONDICIONAL (dos manifestos) de rótulos, métricas e reposição; o condicional não entra', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const servico = criarServicoDeTreino({ obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir), obterPiso: () => ({ ids: ['agenda'], fixas: ['agenda/tool/a1'] }) });
    const r = await servico.treinar({ aneis: ['provider'], margem: -1 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const repo = JSON.parse(readFileSync(join(dir, 'decisoes', 'base', 'provider-reposicao.json'), 'utf8'));
    assert.ok(repo.casos.length > 0 && repo.casos.every((c) => !c.rotulos.includes('agenda')));
    assert.ok(!('agenda' in r.aneis.provider.metricas));
    const dir2 = await dataDirComRetratos(['provider']);
    try {
      const s2 = criarServicoDeTreino({ obterDataDir: () => dir2, obterEmbedder: () => emb, extrair: extrairFalso(dir2), obterPiso: () => ({ ids: ['capacidade-inexistente'], fixas: [] }) });
      const r2 = await s2.treinar({ aneis: ['provider'], margem: -1 });
      assert.ok('agenda' in r2.aneis.provider.metricas, 'sem piso incondicional, agenda segue no treino (o piso de um turno não vaza para cá)');
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('espelho do piso incondicional (fallback da CLI): alwaysLoaded (+ tela) e só as funções com fixa:true, como a produção', async () => {
  const { pisoIncondicional } = await import('../treino/lib/extrair.js');
  const raiz = mkdtempSync(join(tmpdir(), 'piso-'));
  try {
    const mk = (nome, m) => { mkdirSync(join(raiz, nome), { recursive: true }); writeFileSync(join(raiz, nome, 'power.json'), JSON.stringify(m)); };
    mk('memoria', { id: 'memoria', alwaysLoaded: true, functions: [{ name: 'mem_salvar', fixa: true }, { name: 'mem_listar' }, { name: 'mem_apagar', fixa: false }] });
    mk('agenda', { id: 'agenda', alwaysLoaded: false, functions: [{ name: 'ler', fixa: true }] });
    mk('tela', { id: 'tela', functions: [{ name: 'ver' }] });
    mk('async_shadows', { id: 'async_shadows', alwaysLoadedInBackground: true, functions: [{ name: 'x' }] });
    const p = pisoIncondicional({ raizPowers: raiz });
    assert.deepEqual(p.ids.sort(), ['memoria', 'tela']);
    assert.deepEqual(p.fixas.sort(), ['memoria/tool/mem_salvar'], 'função sem `fixa: true` entra por demanda, não é fixa');
    // raiz inexistente: volta vazio e AVISA (o treino não excluiria nada)
    const avisos = []; const w = console.warn; console.warn = (...x) => avisos.push(x.join(' '));
    try { assert.deepEqual(pisoIncondicional({ raizPowers: join(raiz, 'nao-existe') }), { ids: [], fixas: [] }); } finally { console.warn = w; }
    assert.ok(avisos.some((m) => /raiz dos powers não existe/.test(m)));
  } finally { rmSync(raiz, { recursive: true, force: true }); }
});

test('falha fechada: piso incondicional vazio com o catálogo presente → 503 sem-piso, nada treinado nem gravado, trava liberada', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    let chamadas = 0;
    const servico = criarServicoDeTreino({ obterDataDir: () => dir, obterEmbedder: () => emb, extrair: async (a) => { chamadas++; return extrairFalso(dir)(a); }, obterPiso: () => ({ ids: [], fixas: [] }) });
    await assert.rejects(servico.treinar({ aneis: ['provider'], margem: -1 }), (e) => e.name === 'ErroDeTreino' && e.status === 503 && e.motivo === 'sem-piso' && /registry de powers ainda não carregou, tente de novo/.test(e.message));
    assert.equal(chamadas, 0, 'nem extraiu os logs');
    assert.equal(existsSync(join(dir, 'decisoes', 'cabecas', 'provider')), false, 'nenhuma versão gravada');
    assert.equal(servico.ocupado, false, 'a trava foi liberada');
    // com o piso presente (registry carregado) o mesmo pedido treina
    const ok = criarServicoDeTreino({ obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir), obterPiso: () => ({ ids: ['capacidade-inexistente'], fixas: [] }) });
    assert.equal((await ok.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
    // sem catálogo (nenhum retrato legível) o piso vazio NÃO é o problema: segue o fluxo normal (falha por falta de retrato, não por sem-piso)
    const dir2 = mkdtempSync(join(tmpdir(), 'sempiso-'));
    try {
      const s2 = criarServicoDeTreino({ obterDataDir: () => dir2, obterEmbedder: () => emb, extrair: async () => ({ ok: false, motivo: 'sem logs' }), obterPiso: () => ({ ids: [], fixas: [] }) });
      await assert.rejects(s2.treinar({ aneis: ['provider'] }), (e) => e.motivo !== 'sem-piso' && /sem logs/.test(e.message));
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M-a: piso vazio com registry CHEIO (nenhum power de piso configurado) não recusa — segue com o piso vazio; registry vazio recusa', async () => {
  const dir = await dataDirComRetratos(['provider']);
  try {
    const cheio = criarServicoDeTreino({ obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir), obterPiso: () => ({ ids: [], fixas: [], powers: 12 }) });
    assert.equal((await cheio.treinar({ aneis: ['provider'], margem: -1 })).ok, true);
    const vazio = criarServicoDeTreino({ obterDataDir: () => dir, obterEmbedder: () => emb, extrair: extrairFalso(dir), obterPiso: () => ({ ids: [], fixas: [], powers: 0 }) });
    await assert.rejects(vazio.treinar({ aneis: ['provider'], margem: -1 }), (e) => e.status === 503 && e.motivo === 'sem-piso' && /ainda não carregou/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('M-b: `obterPiso` é obrigatório — sem ele o serviço nem é criado', () => {
  assert.throws(() => criarServicoDeTreino({ obterDataDir: () => 'x', obterEmbedder: () => null }), /obterPiso/);
  assert.throws(() => criarServicoDeTreino({ obterDataDir: () => 'x', obterEmbedder: () => null, obterPiso: 'nao-funcao' }), /obterPiso/);
});

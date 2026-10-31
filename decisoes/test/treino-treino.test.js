// packages/decisions/test/treino-treino.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PORTAO_PADRAO, normalizarPortao, dominioDoCaso } from '../treino/lib/dominio.js';
import { embedderTabela } from './helpers/fixtures.js';
import { dividirPorData, avaliarPortaoAnel, treinarAnel, montarIndiceDoRetrato, CEDER_A_CADA_CASOS } from '../treino/lib/treino.js';
import { comCacheEmDisco, embedderDoRoteamento } from '../treino/lib/embedder.js';
import { montarIndice, exportarRetrato, carregarCabeca, treinarCabeca, novaCabeca, calibrarCortes, semRoubados, consultaCentrada } from '../src/local/index.js';
import { atualizarPorLote } from '../treino/lib/lote.js';

const CHAVES = ['agenda', 'tarefa', 'nota', 'x'];
const emb = { modelSlug: 'falso', async embed(t) { const s = String(t); return CHAVES.map((k, i) => (s.includes(k) ? 1 : 0.01 * (i + 1))); } };

// Catálogo "de produção": exemplos, nós sem texto, capacidade com duas tools.
const capacidades = [
  { id: 'agenda', semanticText: ' agenda ', tools: [{ name: 'a1', exemplos: ['agenda de hoje', 'agenda x'], semanticText: 'agenda tool', description: 'd' }, { name: 'a2', semanticText: 'agenda outra' }] },
  { id: 'tarefas', semanticText: 'tarefa', tools: [{ name: 't1', semanticText: 'tarefa abrir', exemplos: ['abrir tarefa'] }] },
  { id: 'notas', semanticText: 'nota', tools: [{ name: 'n1', description: 'nota criar' }] },
  { id: 'so-exemplo', tools: [{ name: 's1', exemplos: ['x solto'] }] },
];

async function retratoReal(anel) {
  const ind = await montarIndice({ anel, capacidades, embedder: emb });
  assert.equal(ind.ok, true);
  return { ind, retrato: JSON.parse(JSON.stringify(exportarRetrato(ind))) }; // passa pelo JSON como no disco
}

const casos = Array.from({ length: 180 }, (_, n) => ({
  ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00`,
  pedido: ['agenda de amanhã', 'tarefa aberta', 'nota sobre x'][n % 3],
  capacidades: [['agenda'], ['tarefas'], ['notas']][n % 3],
  funcoes: [['a1'], ['t1'], ['n1']][n % 3],
}));

test('dividirPorData separa os últimos dias', () => {
  const { treino, recentes } = dividirPorData(casos, 14);
  assert.ok(treino.length > 0 && recentes.length > 0);
  assert.ok(treino.every((c) => c.ts < recentes[0].ts));
});

test('portão por anel: aprova se R@3 da cabeça (todas as capacidades) ≥ base + margem; empate com margem 0 aprova; não ganhar GRAVA com o anel na base (nao-ganhou)', () => {
  const g = (o) => avaliarPortaoAnel({ nAvaliacao: 106, ...o });
  assert.deepEqual(g({ r3Cabeca: 0.56, r3Base: 0.42 }), { acao: 'gravar', anelAprovado: true, motivo: 'aprovada' });
  assert.deepEqual(g({ r3Cabeca: 0.42, r3Base: 0.42 }), { acao: 'gravar', anelAprovado: true, motivo: 'aprovada' }, 'empate com margem 0 aprova');
  assert.deepEqual(g({ r3Cabeca: 0.40, r3Base: 0.42 }), { acao: 'gravar', anelAprovado: false, motivo: 'nao-ganhou' });
  assert.equal(g({ r3Cabeca: 0.50, r3Base: 0.42, margem: 0.1 }).motivo, 'nao-ganhou', 'a margem exige ganho');
  assert.equal(g({ r3Cabeca: 0.50, r3Base: 0.42, nAvaliacao: 30 }).motivo, 'aprovada', 'exatamente minAvaliacao casos já decide');
  assert.equal(g({ r3Cabeca: 0.50, r3Base: 0.42, nAvaliacao: 29 }).motivo, 'poucos-recentes');
});

test('portão por anel: sem veredito (n < minAvaliacao) a versão em uso VÁLIDA continua (mantida); sem versão em uso grava com o anel na base; não existe herança', () => {
  const emUso = { r3Atual: 0.5, r3Nova: 0.9 };
  assert.deepEqual(avaliarPortaoAnel({ r3Cabeca: 0.9, r3Base: 0.1, nAvaliacao: 5, emUso }), { acao: 'mantida', anelAprovado: false, motivo: 'poucos-recentes' });
  assert.deepEqual(avaliarPortaoAnel({ r3Cabeca: 0.9, r3Base: 0.1, nAvaliacao: 5 }), { acao: 'gravar', anelAprovado: false, motivo: 'poucos-recentes' }, 'sem versão em uso: a nova entra com o anel na base');
  assert.deepEqual(avaliarPortaoAnel({ r3Cabeca: 0.9, r3Base: 0.1, nAvaliacao: 0, minAvaliacao: 0 }), { acao: 'gravar', anelAprovado: true, motivo: 'aprovada' }, 'minAvaliacao configurável');
  assert.equal(avaliarPortaoAnel({ r3Cabeca: 0.9, r3Base: 0.1, nAvaliacao: 5, emUso: { r3Atual: null, r3Nova: null } }).acao, 'mantida', 'versão em uso sem comparação possível também continua');
});

test('portão por anel: piorar frente à versão em uso NOS MESMOS CASOS (r3Nova < r3Atual − tolerância) é rejeição (mantida); a fronteira passa; vem antes de nao-ganhou', () => {
  const g = (emUso, extra = {}) => avaliarPortaoAnel({ r3Cabeca: 0.6, r3Base: 0.4, nAvaliacao: 100, emUso, ...extra });
  assert.deepEqual(g({ r3Atual: 0.60, r3Nova: 0.58 }), { acao: 'gravar', anelAprovado: true, motivo: 'aprovada' }, '0,02 abaixo é empate (fronteira)');
  assert.deepEqual(g({ r3Atual: 0.60, r3Nova: 0.57 }), { acao: 'mantida', anelAprovado: false, motivo: 'piorou-frente-a-atual' });
  assert.equal(g({ r3Atual: 0.60, r3Nova: 0.57 }, { tolerancia: 0.05 }).acao, 'gravar', 'tolerância configurável');
  assert.equal(g({ r3Atual: 0.60, r3Nova: 0.70 }).motivo, 'aprovada');
  // nova pior que a atual E que a base: a em uso continua (rejeição), não grava um anel na base
  assert.equal(avaliarPortaoAnel({ r3Cabeca: 0.3, r3Base: 0.4, nAvaliacao: 100, emUso: { r3Atual: 0.6, r3Nova: 0.3 } }).motivo, 'piorou-frente-a-atual');
  // atual ruim (perde da base) e nova melhor que a atual mas ainda perde da base: grava com o anel na base
  assert.deepEqual(avaliarPortaoAnel({ r3Cabeca: 0.35, r3Base: 0.4, nAvaliacao: 100, emUso: { r3Atual: 0.3, r3Nova: 0.35 } }), { acao: 'gravar', anelAprovado: false, motivo: 'nao-ganhou' });
  // sem a régua (versão em uso sem pesos) não compara: decide pela base
  assert.equal(g({ r3Atual: null, r3Nova: null }).motivo, 'aprovada');
});

test('config do portão: padrão 0 / 30 / 0,02; override válido vence; inválido ou desconhecido cai no padrão e lista o motivo', () => {
  assert.deepEqual(PORTAO_PADRAO, { margem: 0, minAvaliacao: 30, toleranciaVersao: 0.02 });
  assert.deepEqual(normalizarPortao(undefined), { valor: PORTAO_PADRAO, motivos: [] });
  assert.deepEqual(normalizarPortao({ margem: 0.05, minAvaliacao: 12 }), { valor: { margem: 0.05, minAvaliacao: 12, toleranciaVersao: 0.02 }, motivos: [] });
  const ruim = normalizarPortao({ margem: 3, minAvaliacao: 0, toleranciaVersao: -0.1, extra: 1 });
  assert.deepEqual(ruim.valor, PORTAO_PADRAO);
  assert.equal(ruim.motivos.length, 4);
  assert.deepEqual(normalizarPortao({ minAvaliacao: 1.5 }).valor.minAvaliacao, 30, 'inteiro');
  assert.equal(normalizarPortao([1]).motivos.length, 1);
  assert.equal(normalizarPortao('x').valor.minAvaliacao, 30);
  assert.throws(() => { PORTAO_PADRAO.margem = 1; }, TypeError, 'o padrão é congelado');
  assert.match(ruim.motivos.find((m) => /margem/.test(m)), /\(3\)/, 'o motivo mostra o valor recusado');
  // chaves herdadas do Object.prototype não são "opções": desconhecidas, sem lançar (`in` as aceitaria)
  const hostil = normalizarPortao(JSON.parse('{"__proto__":1,"constructor":5,"toString":7,"margem":0.1}'));
  assert.deepEqual(hostil.valor, { ...PORTAO_PADRAO, margem: 0.1 });
  assert.equal(hostil.motivos.length, 3);
  assert.equal(Object.getPrototypeOf(hostil.valor), Object.prototype, 'a prototype do resultado não foi tocada');
});

for (const anel of ['provider', 'tool']) {
  test(`hash do índice re-montado a partir do retrato bate com o da produção (${anel})`, async () => {
    const { ind, retrato } = await retratoReal(anel);
    const re = await montarIndiceDoRetrato(anel, retrato.nos, emb);
    assert.equal(re.ok, true);
    assert.equal(re.hash, retrato.hash);
    assert.equal(re.hash, ind.hash);
    assert.deepEqual([...re.nos.keys()], [...ind.nos.keys()]);
    assert.deepEqual(re.nos.get([...re.nos.keys()][0]).centroide, ind.nos.get([...ind.nos.keys()][0]).centroide);
  });

  test(`treinarAnel devolve arquivo que carregarCabeca aceita contra o índice de produção (${anel})`, async () => {
    const { ind, retrato } = await retratoReal(anel);
    const r = await treinarAnel({ anel, retrato, casos, embedder: emb, margem: -1, diasRecentes: 14, epocas: 5 });
    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.arquivo.slug, 'falso');
    assert.equal(r.arquivo.hash, ind.hash);
    // v2: o portão é do ANEL; sem `aprovadas` nem `cortes` (os cortes são fixos de produto)
    assert.equal(r.arquivo.versao, 2);
    assert.equal(typeof r.arquivo.anelAprovado, 'boolean');
    assert.equal('aprovadas' in r.arquivo, false);
    assert.equal('cortes' in r.arquivo, false);
    assert.equal('cortesOrigem' in r.arquivo, false);
    assert.ok(r.arquivo.metricas.agenda && typeof r.arquivo.metricas.agenda.base === 'number');
    assert.ok(r.arquivo.metricas.agenda.nRecentes > 0);
    assert.ok(r.arquivo.metricasAnel.n > 0 && Number.isFinite(r.arquivo.metricasAnel.base) && Number.isFinite(r.arquivo.metricasAnel.cabeca));
    assert.equal(r.arquivo.metricasAnel.n, r.resumo.metricasAnel.n);
    // cortesSugeridos (p10/p98 das notas da cabeça nos recentes): só relatório
    assert.ok(Number.isFinite(r.arquivo.cortesSugeridos.full) && r.arquivo.cortesSugeridos.candidate <= r.arquivo.cortesSugeridos.full);
    const dir = mkdtempSync(join(tmpdir(), 'treino-'));
    try {
      const f = join(dir, 'cabeca.json');
      writeFileSync(f, JSON.stringify(r.arquivo));
      const c = carregarCabeca({ arquivo: f, slug: ind.slug, hash: ind.hash, dim: ind.dim });
      assert.equal(c.ok, true, c.motivo);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('retrato com hash diferente do re-montado: o treino segue e marca hashDiferente (o hash não trava mais)', async () => {
  const { retrato } = await retratoReal('provider');
  const r = await treinarAnel({ anel: 'provider', retrato: { ...retrato, hash: 'outro' }, casos, embedder: emb, margem: -1, epocas: 3 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.hashDiferente, true);
  assert.equal(r.arquivo.hash, 'outro'); // o hash gravado segue sendo o do retrato (informativo)
  const igual = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 3 });
  assert.equal(igual.resumo.hashDiferente, undefined);
});

test('casosRegistro entram no treino (vetor pronto, rótulo por ref); dedupe com os logs; reposição sem texto e limitada', async () => {
  const { retrato } = await retratoReal('tool');
  const vet = [1, 0.02, 0.03, 0.04];
  const reg = Array.from({ length: 12 }, (_, n) => ({ ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-i${n}`, vetores: [vet], usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] } }));
  const base = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, margem: -1, epocas: 2 });
  const comReg = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, margem: -1, epocas: 2, casosRegistro: reg, tamanhoReposicao: 40 });
  assert.equal(comReg.ok, true, comReg.motivo);
  assert.equal(comReg.resumo.doRegistro, 12);
  assert.equal(comReg.resumo.treino + comReg.resumo.recentes, base.resumo.treino + base.resumo.recentes + 12);
  assert.equal(comReg.reposicao.length, 40);
  assert.ok(comReg.reposicao.every((k) => Array.isArray(k.v) && k.v.length === 4 && Array.isArray(k.rotulos) && !('pedido' in k) && !('s' in k)));
  assert.deepEqual(comReg.reposicao.find((k) => k.rotulos.includes('agenda/tool/a1')).v, vet); // cru, não centrado
  assert.ok(comReg.reposicao.some((k) => k.rotulos.includes('agenda/tool/a1')));
  // mesma interação nos logs e no registro: o REGISTRO vence, o log daquela interação sai (não entra duas vezes)
  const duplicado = await treinarAnel({ anel: 'tool', retrato, casos: [{ ...casos[0], id: '20260901-100000_interaction-i0' }, ...casos.slice(1)], embedder: emb, margem: -1, epocas: 2, casosRegistro: reg });
  assert.equal(duplicado.resumo.doRegistro, 12);
  assert.equal(duplicado.resumo.logSubstituidosPeloRegistro, 1);
});

test('retrato de outro provider → FALTA', async () => {
  const { retrato } = await retratoReal('provider');
  const r = await treinarAnel({ anel: 'provider', retrato: { ...retrato, slug: 'outro' }, casos, embedder: emb });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /provider/);
});

test('sem retrato → FALTA', async () => {
  const r = await treinarAnel({ anel: 'tool', retrato: null, casos, embedder: emb });
  assert.equal(r.ok, false);
});

test('embedderDoRoteamento com resolver injetado adapta o provider; sem provider lança', async () => {
  const e = await embedderDoRoteamento({ resolver: async () => ({ slug: 'p', embed: async (ts, o) => ts.map(() => [o.kind === 'query' ? 1 : 2]) }) });
  assert.equal(e.modelSlug, 'p');
  assert.deepEqual(await e.embed('x'), [1]);
  await assert.rejects(embedderDoRoteamento({ resolver: async () => null }), /ausente/);
});

test('cache em disco: segundo embed não chama o provider; salvar persiste', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treino-cache-'));
  try {
    const arq = join(dir, 'sub', 'c.json');
    let chamadas = 0;
    const base = { modelSlug: 'm', async embed() { chamadas++; return [1, 2]; } };
    const c1 = comCacheEmDisco(base, arq);
    await c1.embed('a'); await c1.embed('a');
    assert.equal(chamadas, 1);
    c1.salvar();
    assert.equal(JSON.parse(readFileSync(arq, 'utf8')).versao, 1);
    const c2 = comCacheEmDisco(base, arq);
    await c2.embed('a');
    assert.equal(chamadas, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('laços de CPU cedem a thread a cada CEDER_A_CADA_CASOS casos e o resultado não muda', async () => {
  const { retrato } = await retratoReal('tool');
  const args = { anel: 'tool', retrato, casos, embedder: emb, margem: -1, diasRecentes: 14, epocas: 5 };
  const sem = await treinarAnel(args);
  let cedeu = 0;
  const original = globalThis.setImmediate;
  globalThis.setImmediate = (f, ...a) => { cedeu++; return original(f, ...a); };
  let com;
  try { com = await treinarAnel(args); } finally { globalThis.setImmediate = original; }
  assert.ok(cedeu >= Math.floor(casos.length / 2 / CEDER_A_CADA_CASOS), `cedeu ${cedeu}x`);
  assert.equal(com.ok, true, com.motivo);
  assert.deepEqual(com.arquivo.metricas, sem.arquivo.metricas);
  assert.deepEqual(com.resumo, sem.resumo);
});

test('cache em disco com roles: só o papel declarado é cacheado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treino-cache-roles-'));
  try {
    const arq = join(dir, 'c.json');
    let chamadas = 0;
    const base = { modelSlug: 'm', async embed() { chamadas++; return [1, 2]; } };
    const c = comCacheEmDisco(base, arq, { roles: ['query'] });
    await c.embed('a', 'query'); await c.embed('a', 'query');
    await c.embed('a', 'passage'); await c.embed('a', 'passage');
    assert.equal(chamadas, 3);
    c.salvar();
    assert.equal(Object.keys(JSON.parse(readFileSync(arq, 'utf8')).itens).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache em disco com mesclar: salvar preserva o que outro escritor gravou; sem mesclar sobrescreve', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'treino-cache-mesclar-'));
  try {
    const arq = join(dir, 'c.json');
    const base = { modelSlug: 'm', async embed() { return [1, 2]; } };
    const c = comCacheEmDisco(base, arq, { mesclar: true });
    const s = comCacheEmDisco(base, arq);
    await c.embed('a');
    // outro escritor (Kairos) grava depois da nossa leitura
    writeFileSync(arq, JSON.stringify({ versao: 1, itens: { 'm#passage#outro': [9, 9] } }));
    c.salvar();
    const itens = JSON.parse(readFileSync(arq, 'utf8')).itens;
    assert.deepEqual(itens['m#passage#outro'], [9, 9]);
    assert.equal(Object.keys(itens).length, 2);
    // sem mesclar: sobrescreve
    await s.embed('b');
    s.salvar();
    assert.equal(Object.keys(JSON.parse(readFileSync(arq, 'utf8')).itens).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const clonar = (x) => JSON.parse(JSON.stringify(x));
const emUsoDe = (extra = {}) => ({ cabeca: novaCabeca({ d: 4, posto: 2, seed: 7 }), d: 4, versao: 3, anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 80 }, ...extra });

test('sem veredito (poucos-recentes): com versão em uso VÁLIDA o treino completo devolve mantida (sem arquivo nem reposição); sem versão em uso grava com o anel na base', async () => {
  const { retrato } = await retratoReal('provider');
  const base = { anel: 'provider', retrato, casos, embedder: emb, minAvaliacao: 1000, margem: -1, epocas: 3 };
  const sem = await treinarAnel(base);
  assert.equal(sem.ok, true, sem.motivo);
  assert.equal(sem.mantida, undefined);
  assert.deepEqual([sem.arquivo.anelAprovado, sem.arquivo.portao], [false, 'poucos-recentes']);
  assert.ok(sem.arquivo.metricas.agenda.nRecentes > 0, 'as métricas por capacidade seguem informativas');
  assert.equal(sem.resumo.diagnostico.n, sem.arquivo.metricasAnel.n);
  assert.equal(sem.resumo.diagnostico.minAvaliacao, 1000);
  const com = await treinarAnel({ ...base, emUso: emUsoDe() });
  assert.equal(com.ok, true, com.motivo);
  assert.equal(com.mantida, true);
  assert.equal(com.motivo, 'poucos-recentes');
  assert.equal(com.arquivo, undefined); assert.equal(com.reposicao, undefined);
  assert.equal(com.resumo.anelAprovado, true, 'o estado da versão em uso, que continua');
  assert.equal(com.resumo.portao, 'poucos-recentes');
  assert.equal(com.resumo.diagnostico.emUso.versao, 3);
});

test('portão no treino completo: ganhar da base grava aprovada; não ganhar grava com o anel na base; piorar frente à versão em uso (recalculada nos mesmos casos) é mantida', async () => {
  const { retrato } = await retratoReal('provider');
  const base = { anel: 'provider', retrato, casos, embedder: emb, epocas: 3, minAvaliacao: 5 };
  const livre = await treinarAnel({ ...base, margem: -1 });
  assert.equal(livre.arquivo.anelAprovado, true);
  assert.equal(livre.arquivo.portao, 'aprovada');
  assert.ok(livre.arquivo.metricasAnel.n >= 5);
  const exigente = await treinarAnel({ ...base, margem: 2 }); // R@3 ∈ [0,1]: ninguém ganha por 2
  assert.equal(exigente.ok, true);
  assert.deepEqual([exigente.arquivo.anelAprovado, exigente.arquivo.portao], [false, 'nao-ganhou']);
  const piorou = await treinarAnel({ ...base, margem: -1, tolerancia: -1, emUso: emUsoDe() }); // nova >= atual + 1: impossível
  assert.equal(piorou.mantida, true);
  assert.equal(piorou.motivo, 'piorou-frente-a-atual');
  assert.equal(piorou.arquivo, undefined);
  const e = piorou.resumo.diagnostico.emUso;
  assert.ok(e.comparou > 0 && Number.isFinite(e.r3Nova) && Number.isFinite(e.r3Recalculado), JSON.stringify(e));
  assert.equal(e.r3Gravado, 0.5, 'o número gravado é só diagnóstico');
  assert.equal(piorou.resumo.metricasAnel.cabeca, livre.arquivo.metricasAnel.cabeca, 'as métricas da candidata rejeitada ficam no resumo');
});

test('a régua da versão em uso é RECALCULADA nos mesmos casos: a MESMA cabeça em outra amostra não é rejeitada por ruído, mesmo com um número gravado absurdo', async () => {
  const { retrato } = await retratoReal('provider');
  const emUso = emUsoDe({ metricasAnel: { base: 0.1, cabeca: 5, n: 99 } }); // gravado de OUTRA amostra e inalcançável
  const idem = async () => ({ cabeca: clonar(emUso.cabeca) });
  for (const amostra of [casos, casos.filter((c, n) => n % 2 === 0), casos.slice(60)]) {
    const r = await treinarAnel({ anel: 'provider', retrato, casos: amostra, embedder: emb, epocas: 2, minAvaliacao: 5, margem: -1, emUso, treinarCabecaFn: idem });
    assert.equal(r.ok, true, r.motivo);
    assert.notEqual(r.motivo, 'piorou-frente-a-atual');
    assert.equal(r.mantida, undefined, 'gravou: mesma cabeça, mesma régua, empate');
    const e = r.resumo.diagnostico.emUso;
    assert.ok(e.comparou > 0);
    assert.equal(e.r3Nova, e.r3Recalculado, 'a nova É a em uso: diferença exatamente zero em qualquer amostra');
  }
});

test('o registro de treino da janela conta no R@3 cabeça × base mas NÃO na régua da versão em uso (que o lote treinou nele)', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  const mk = (n, extra) => ({ ts: `2026-09-${String(20 + (n % 8)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-w${n}`, vetores: [vet], slug: 'falso', dim: 4, usadas: { capacidades: ['agenda'], funcoes: [] }, ...extra });
  const registro = [...Array.from({ length: 10 }, (_, n) => mk(n, { avaliacao: false })), ...Array.from({ length: 6 }, (_, n) => mk(100 + n, { avaliacao: true }))];
  const r = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, epocas: 2, minAvaliacao: 5, margem: -1, casosRegistro: registro, emUso: emUsoDe() });
  assert.equal(r.ok, true, r.motivo);
  const d = r.resumo.diagnostico;
  assert.equal(d.funil['registro-treino'].julgados, 10, 'os 10 de treino da janela entram no R@3 cabeça × base');
  assert.equal(d.funil['registro-avaliacao'].julgados, 6);
  assert.equal(d.n, d.funil.log.julgados + 6 + 10);
  assert.equal(d.emUso.comparou, d.funil.log.julgados + 6, 'a régua do atual: só log da janela + registro com avaliacao: true');
  // funil: cada origem fecha a conta
  for (const [fonte, f] of Object.entries(d.funil)) assert.equal(f.brutos, f.semDominio + f.semAlvo + f.jaAtivos + f.poucosCandidatos + f.julgados, fonte);
  assert.equal(d.n, Object.values(d.funil).reduce((t, f) => t + f.julgados, 0));
  // pareado: um registro por caso julgado
  assert.equal(d.pareado.cabecaVenceu + d.pareado.baseVenceu + d.pareado.empate, d.n);
});

test('piorou exige casos COMPARADOS ≥ minAvaliacao: com menos, não há veredito de piorou (segue só o portão contra a base), mesmo com tolerância impossível', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  const mk = (n, extra) => ({ ts: `2026-09-${String(20 + (n % 10))}T00:00:00`, interactionId: `interaction-c${n}`, vetores: [vet], slug: 'falso', dim: 4, usadas: { capacidades: ['agenda'], funcoes: [] }, ...extra });
  // log só ANTIGO (treina); a janela tem 30 casos de registro de treino (julgados, FORA da régua) e só 2 de avaliação (a régua)
  const logAntigo = casos.filter((c) => c.ts < '2026-09-10');
  const registro = [...Array.from({ length: 30 }, (_, n) => mk(n, { avaliacao: false })), ...Array.from({ length: 2 }, (_, n) => mk(100 + n, { avaliacao: true }))];
  const base = { anel: 'provider', retrato, casos: logAntigo, embedder: emb, epocas: 2, minAvaliacao: 5, margem: -1, tolerancia: -1, casosRegistro: registro, emUso: emUsoDe() };
  const poucos = await treinarAnel(base);
  assert.equal(poucos.ok, true, poucos.motivo);
  assert.equal(poucos.mantida, undefined, 'só 2 casos comparados (< 5): sem veredito de piorou');
  const e = poucos.resumo.diagnostico.emUso;
  assert.deepEqual([e.comparou, e.comparacaoSuficiente], [2, false]);
  assert.ok(poucos.resumo.diagnostico.n >= 30, 'o n de cabeça × base inclui o registro de treino da janela');
  assert.equal(poucos.arquivo.portao === 'piorou-frente-a-atual', false);
  // com minAvaliacao 2 a comparação passa a valer — e a tolerância impossível a rejeita
  const bastam = await treinarAnel({ ...base, minAvaliacao: 2 });
  assert.deepEqual([bastam.mantida, bastam.motivo], [true, 'piorou-frente-a-atual']);
  assert.equal(bastam.resumo.diagnostico.emUso.comparacaoSuficiente, true);
});

test('versão em uso SEM avaliação (v1, metricasAnel nulo) que perde da base nos mesmos casos não serve de régua: a nova é julgada só contra a base; a avaliada (v2) segue sendo régua; a v1 que vence a base também', async () => {
  const { retrato } = await retratoReal('provider');
  const base = { anel: 'provider', retrato, casos, embedder: emb, epocas: 2, minAvaliacao: 5, margem: -1, tolerancia: -1 }; // tolerância impossível: qualquer régua válida rejeita
  const boa = await treinarAnel({ ...base, tolerancia: 0.02 });
  assert.equal(boa.ok, true, boa.motivo);
  const pesos = (a) => ({ d: a.d, posto: a.posto, U: a.U, V: a.V, alfa: a.alfa, beta: a.beta });
  const ruim = { ...pesos(boa.arquivo), alfa: -50 }; // ranking invertido: o alvo fica por último → perde da base
  const v1 = (cabeca, extra = {}) => ({ cabeca, d: 4, versao: 1, anelAprovado: true, metricasAnel: null, ...extra });
  // v1 que PERDE da base: descartada, a nova é julgada só contra a base → grava (não é mantida, apesar da tolerância impossível)
  const descartada = await treinarAnel({ ...base, emUso: v1(ruim) });
  assert.equal(descartada.ok, true, descartada.motivo);
  assert.equal(descartada.mantida, undefined);
  const dd = descartada.resumo.diagnostico.emUso;
  assert.equal(dd.descartada, 'perde-da-base');
  assert.ok(dd.r3Recalculado < dd.r3BaseNosMesmos, `${dd.r3Recalculado} < ${dd.r3BaseNosMesmos}`);
  assert.deepEqual([descartada.arquivo.anelAprovado, descartada.arquivo.portao], [true, 'aprovada'], 'a nova (treinada) vence a base');
  // v1 que VENCE a base (ou empata): segue sendo régua → com a tolerância impossível, piorou → mantida
  const venceu = await treinarAnel({ ...base, emUso: v1(pesos(boa.arquivo)) });
  assert.deepEqual([venceu.mantida, venceu.motivo], [true, 'piorou-frente-a-atual']);
  assert.equal(venceu.resumo.diagnostico.emUso.descartada, undefined);
  // A MESMA cabeça ruim como "nova" (idêntica à em uso): v1 sem avaliação é descartada → julgada só contra a base → perde (nao-ganhou) e GRAVA com o
  // anel na base; já a versão AVALIADA (v2 com metricasAnel) foi julgada pelo portão dela e continua sendo régua → com a tolerância impossível, mantida.
  const idemRuim = async () => ({ cabeca: clonar(ruim) });
  const v1Ruim = await treinarAnel({ ...base, margem: 0, treinarCabecaFn: idemRuim, emUso: v1(ruim) });
  assert.equal(v1Ruim.mantida, undefined);
  assert.deepEqual([v1Ruim.arquivo.anelAprovado, v1Ruim.arquivo.portao, v1Ruim.resumo.diagnostico.emUso.descartada], [false, 'nao-ganhou', 'perde-da-base']);
  const avaliada = await treinarAnel({ ...base, treinarCabecaFn: idemRuim, emUso: v1(ruim, { metricasAnel: { base: 0.9, cabeca: 0.1, n: 80 }, anelAprovado: false }) });
  assert.deepEqual([avaliada.mantida, avaliada.motivo], [true, 'piorou-frente-a-atual']);
  assert.equal(avaliada.resumo.diagnostico.emUso.descartada, undefined);
  // com poucos casos comparados não há veredito nem de descarte: a v1 ruim fica como régua (poucos-recentes → mantida)
  const semCasos = await treinarAnel({ ...base, minAvaliacao: 1000, emUso: v1(ruim) });
  assert.deepEqual([semCasos.mantida, semCasos.motivo], [true, 'poucos-recentes']);
  assert.equal(semCasos.resumo.diagnostico.emUso.descartada, undefined);
});

test('versão em uso de OUTRA dimensão é ignorada com aviso (a produção também a ignora): sem régua, sem mantida', async () => {
  const { retrato } = await retratoReal('provider');
  const avisos = []; const original = console.warn; console.warn = (m) => avisos.push(String(m));
  try {
    const r = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, epocas: 2, minAvaliacao: 1000, margem: -1, emUso: emUsoDe({ cabeca: novaCabeca({ d: 6, posto: 2 }), d: 6 }) });
    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.mantida, undefined, 'sem versão em uso válida, poucos-recentes grava com o anel na base');
    assert.deepEqual([r.arquivo.anelAprovado, r.arquivo.portao], [false, 'poucos-recentes']);
    assert.match(r.resumo.diagnostico.emUso.ignorada, /dimensão 6 ≠ 4/);
    assert.ok(avisos.some((a) => /versão em uso ignorada/.test(a)), avisos.join('|'));
  } finally { console.warn = original; }
});

test('treino completo remonta o índice com a regra "irmão não rouba": o exemplo roubado por IRMÃO continua no centróide; o roubado por outra capacidade sai', async () => {
  const { calibrarCortes } = await import('../src/local/index.js');
  const TAB = {
    'x-texto': [1, 0, 0], x1: [0.99, 0.1, 0.05], 'x-irmao': [0.45, 0.8, 0.05], 'x-rouba': [0.45, 0.05, 0.8],
    'y-texto': [0, 1, 0], y1: [0.1, 0.98, 0.05], y2: [-0.1, 0.97, 0.1],
    'z-texto': [0, 0, 1], z1: [0.05, 0.1, 0.99], z2: [-0.05, -0.1, 0.98],
  };
  const embT = embedderTabela(TAB, 'tabela-t');
  const caps = [
    { id: 'a', tools: [{ name: 'x', semanticText: 'x-texto', exemplos: ['x1', 'x-irmao', 'x-rouba'] }, { name: 'y', semanticText: 'y-texto', exemplos: ['y1', 'y2'] }] },
    { id: 'b', tools: [{ name: 'z', semanticText: 'z-texto', exemplos: ['z1', 'z2'] }] },
  ];
  const ind = await montarIndice({ anel: 'tool', capacidades: caps, embedder: embT });
  const retrato = clonar(exportarRetrato(ind));
  const bruto = await montarIndiceDoRetrato('tool', retrato.nos, embT);
  const cal = await calibrarCortes(bruto);
  assert.ok(cal.roubados.some((x) => x.irmao === true) && cal.roubados.some((x) => x.irmao === false), 'o cenário tem um roubo por irmão e um por outra capacidade');
  const esperado = semRoubados(bruto, cal.roubados);
  const velhoSemIrmao = semRoubados(bruto, cal.roubados.map(({ irmao, ...resto }) => resto)); // regra antiga: todo roubado sai
  const refs = [...esperado.nos.keys()];
  const casosT = Array.from({ length: 40 }, (_, n) => ({ ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00`, pedido: ['x1', 'y1', 'z1'][n % 3], capacidades: [['a'], ['a'], ['b']][n % 3], funcoes: [['x'], ['y'], ['z']][n % 3] }));
  let args;
  const r = await treinarAnel({ anel: 'tool', retrato, casos: casosT, embedder: embT, epocas: 1, minAvaliacao: 1, margem: -1, treinarCabecaFn: async (a) => { args = a; return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  assert.deepEqual(args.P, refs.map((ref) => esperado.nos.get(ref).centroide), 'os centróides do treino são os da produção (irmão fica)');
  const iX = refs.indexOf('a/tool/x');
  assert.notDeepEqual(args.P[iX], velhoSemIrmao.nos.get('a/tool/x').centroide, 'e NÃO são os da regra antiga (que apagava o exemplo do irmão)');
  assert.equal(esperado.nos.get('a/tool/x').vetores.length, bruto.nos.get('a/tool/x').vetores.length - 1, 'só o roubado por outra capacidade saiu de x');
});

test('poucos positivos recentes: o treino NÃO falha mais — grava a cabeça com cortesSugeridos null (relatório) e portão por anel decidido', async () => {
  const { retrato } = await retratoReal('provider');
  const poucos = [...casos.filter((c) => c.ts < '2026-09-10'), ...casos.filter((c) => c.ts.startsWith('2026-09-28')).slice(0, 5)];
  const r = await treinarAnel({ anel: 'provider', retrato, casos: poucos, embedder: emb, epocas: 3 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.arquivo.cortesSugeridos, null);
  assert.equal('cortes' in r.arquivo, false);
  assert.equal(r.arquivo.anelAprovado, false, '5 casos de avaliação < minAvaliacao 30 e sem versão em uso → base');
  assert.equal(r.arquivo.portao, 'poucos-recentes');
});

test('casos incertos (só funções sumidas) saem do treino e são contados; embed que falha pula o caso', async () => {
  const { retrato } = await retratoReal('provider');
  const incertos = Array.from({ length: 7 }, (_, n) => ({ ts: '2026-09-15T00:00', pedido: 'agenda xyz', capacidades: [], funcoes: [], descartadas: ['sumiu'], n }));
  const quebra = Array.from({ length: 3 }, () => ({ ts: '2026-09-15T00:00', pedido: 'QUEBRA', capacidades: ['agenda'], funcoes: ['a1'], descartadas: [] }));
  const embQuebra = { modelSlug: 'falso', embed: (t, k) => (String(t) === 'QUEBRA' ? Promise.reject(new Error('boom')) : emb.embed(t, k)) };
  const r = await treinarAnel({ anel: 'provider', retrato, casos: [...casos, ...incertos, ...quebra], embedder: embQuebra, margem: -1, epocas: 3 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.incertos, 7);
  assert.equal(r.resumo.pulados, 3);
  assert.equal(r.resumo.treino + r.resumo.recentes, 180);
});

test('anel tool: domínio de treino = tools das usadas + até 5 capacidades distratoras (catálogo de 4 capacidades: cobre tudo); provider usa todos', async () => {
  const { retrato: rt } = await retratoReal('tool');
  const { retrato: rp } = await retratoReal('provider');
  let argsTool; let argsProv;
  const espia = (guarda) => async (a) => { guarda(a); return treinarCabeca(a); };
  const t = await treinarAnel({ anel: 'tool', retrato: rt, casos, embedder: emb, margem: -1, epocas: 2, treinarCabecaFn: espia((a) => { argsTool = a; }) });
  assert.equal(t.ok, true, t.motivo);
  assert.equal(argsTool.candidatosPorCaso.length, argsTool.casos.length);
  // 5 tools em 4 capacidades: a usada + até 5 distratoras cobrem o catálogo inteiro (a exclusão está no teste de `dominioDoCaso`) e o domínio sempre contém o positivo
  argsTool.casos.forEach((c, n) => { for (const j of c.pos) assert.ok(argsTool.candidatosPorCaso[n].includes(j)); });
  assert.ok(argsTool.candidatosPorCaso.every((d) => d.length === argsTool.P.length));
  await treinarAnel({ anel: 'provider', retrato: rp, casos, embedder: emb, margem: -1, epocas: 2, treinarCabecaFn: espia((a) => { argsProv = a; }) });
  assert.ok(argsProv.candidatosPorCaso.every((d) => d.length === argsProv.P.length), 'provider: sempre o domínio inteiro nos casos do log (o domínio por caso existe para o negativo fraco do registro)');
});

test('dominioDoCaso (tool): a capacidade usada + as 5 distratoras de maior nota base; as demais ficam de fora (nunca o catálogo inteiro)', async () => {
  const D = 8;
  const eixo = (k) => Array.from({ length: D }, (_, i) => (i === k ? 1 : 0));
  const tab = {}; const caps = Array.from({ length: D }, (_, k) => {
    tab[`c${k}-f`] = eixo(k); tab[`c${k}-g`] = eixo(k).map((x, i) => (i === (k + 1) % D ? 0.05 : x));
    return { id: `c${k}`, tools: [{ name: 'f', semanticText: `c${k}-f`, exemplos: [] }, { name: 'g', semanticText: `c${k}-g`, exemplos: [] }] };
  });
  const ind = await montarIndice({ anel: 'tool', capacidades: caps, embedder: embedderTabela(tab, 'tabela-d') });
  assert.equal(ind.ok, true);
  const refs = [...ind.nos.keys()];
  // pedido: c0 em cheio e c1..c7 em ordem decrescente de proximidade
  const v = eixo(0).map((x, i) => (i === 0 ? 1 : (8 - i) * 0.1));
  const s = consultaCentrada(ind, [v])[0];
  const dom = dominioDoCaso('tool', { s, capacidades: ['c0'], funcoes: ['f'] }, refs, ind);
  const capsDoDominio = new Set(dom.map((i) => refs[i].split('/tool/')[0]));
  assert.deepEqual([...capsDoDominio].sort(), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'], 'usada + 5 distratoras; c6 e c7 (as de menor nota) ficam fora');
  assert.equal(dom.length, 12);
  assert.equal(dominioDoCaso('tool', { s, capacidades: ['inexistente'], funcoes: [] }, refs, ind), null);
});

test('anel tool: caso recente com ≤ 3 candidatos não entra no recall (catálogo pequeno → n=0, sem cortesSugeridos, anel não aprovado)', async () => {
  const pequeno = capacidades.slice(0, 3).map((c) => ({ ...c, tools: c.tools.slice(0, 1) }));
  const ind = await montarIndice({ anel: 'tool', capacidades: pequeno, embedder: emb });
  const retrato = JSON.parse(JSON.stringify(exportarRetrato(ind)));
  const r = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, margem: -1, epocas: 2 });
  assert.equal(r.ok, true, r.motivo);
  assert.deepEqual(r.arquivo.metricasAnel, { base: null, cabeca: null, n: 0 });
  assert.equal(r.arquivo.cortesSugeridos, null);
  assert.equal(r.arquivo.anelAprovado, false);
  assert.equal(r.arquivo.portao, 'poucos-recentes');
});

test('avaliação no provider: caso do registro com ativasNoInicio conta só o que PRECISOU ENTRAR; caso cujas usadas já estavam ativas não entra na métrica; o treino (positivos) não muda', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  const av = (n, usadas, ativasNoInicio) => ({ ts: `2026-09-${String(15 + (n % 12)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-av${n}`, vetores: [vet], slug: 'falso', dim: 4, avaliacao: true, usadas: { capacidades: usadas, funcoes: [] }, ...(ativasNoInicio === undefined ? {} : { ativasNoInicio }) });
  const mk = (ativas) => [
    av(1, ['agenda'], ativas ? ['agenda'] : null), // tudo já ativo → fora da métrica
    av(2, ['agenda'], ativas ? ['agenda', 'notas'] : null), // idem
    av(3, ['tarefas'], ativas ? ['agenda'] : null), // precisou entrar → conta
    av(4, ['agenda', 'tarefas'], ativas ? ['agenda'] : null), // conta, só com `tarefas` de alvo
    av(5, ['notas'], ativas ? [] : null), // capturado e nada ativo → conta
    av(6, ['notas'], undefined), // ausente (artefato antigo / log) → todas as usadas → conta
  ];
  const treinados = [];
  const roda = (reg) => treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, minAvaliacao: 1, epocas: 2, casosRegistro: reg, treinarCabecaFn: async (a) => { treinados.push(a); return treinarCabeca(a); } });
  const sem = await roda(mk(false));
  const com = await roda(mk(true));
  assert.equal(com.ok, true, com.motivo); assert.equal(sem.ok, true, sem.motivo);
  assert.equal(sem.arquivo.metricasAnel.n - com.arquivo.metricasAnel.n, 2, 'os 2 casos com tudo já ativo saem da métrica');
  assert.equal(com.resumo.recentes, sem.resumo.recentes, 'seguem recentes (nota/cortes); só não entram no R@3');
  assert.equal(treinados[0].casos.length, treinados[1].casos.length, 'o treino não muda');
  assert.deepEqual(treinados[0].casos.map((c) => [...c.pos]), treinados[1].casos.map((c) => [...c.pos]));
  assert.deepEqual(com.arquivo.nTreinoPorCapacidade, sem.arquivo.nTreinoPorCapacidade);
  // por capacidade: `agenda` perde os 2 casos filtrados + o alvo `agenda` do caso 4
  assert.ok(com.arquivo.metricas.agenda.nRecentes < sem.arquivo.metricas.agenda.nRecentes);
  assert.equal(com.arquivo.metricas.tarefas.nRecentes, sem.arquivo.metricas.tarefas.nRecentes, 'o que precisou entrar continua contado');
});

test('avaliação no anel tool: ativasNoInicio não muda nada (a régua é o domínio do 2º estágio, dentro de dominioDoCaso)', async () => {
  const vet = [1, 0.02, 0.03, 0.04];
  const av = (n, ativasNoInicio) => ({ ts: `2026-09-${String(15 + (n % 12)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-t${n}`, vetores: [vet], slug: 'falso', dim: 4, avaliacao: true, usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] }, carregadas: { tool: [] }, ativasNoInicio });
  const { retrato } = await retratoReal('tool');
  const regSem = Array.from({ length: 6 }, (_, n) => av(n, null));
  const regCom = Array.from({ length: 6 }, (_, n) => av(n, ['agenda']));
  const a = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, margem: -1, minAvaliacao: 1, epocas: 2, casosRegistro: regSem });
  const b = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, margem: -1, minAvaliacao: 1, epocas: 2, casosRegistro: regCom });
  assert.deepEqual(b.arquivo.metricasAnel, a.arquivo.metricasAnel, 'tool: o domínio do 2º estágio já é a régua; ativasNoInicio não entra');
  assert.deepEqual(b.arquivo.metricas, a.arquivo.metricas);
});

test('fail-closed: treino que diverge devolve ok:false (treino-divergiu), sem arquivo e sem rodar o portão', async () => {
  const { retrato } = await retratoReal('tool');
  const comNaN = async () => { const c = novaCabeca({ d: 4, posto: 2 }); c.U[0][0] = NaN; c.alfa = NaN; return { cabeca: c, perdas: [NaN] }; };
  const a = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, epocas: 2, treinarCabecaFn: comNaN });
  assert.equal(a.ok, false);
  assert.match(a.motivo, /^treino-divergiu/);
  assert.equal(a.arquivo, undefined);
  const lanca = async () => { throw new Error('treino no worker: treino-divergiu: perda NaN'); };
  const b = await treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, epocas: 2, treinarCabecaFn: lanca });
  assert.equal(b.ok, false);
  assert.match(b.motivo, /^treino-divergiu/);
  const outro = async () => { throw new Error('boom'); };
  await assert.rejects(treinarAnel({ anel: 'tool', retrato, casos, embedder: emb, epocas: 2, treinarCabecaFn: outro }), /boom/);
});

test('dividirPorData ignora ts que não é data (sem RangeError)', () => {
  const r = dividirPorData([{ ts: 'interaction-xyz' }, { ts: '2026-09-01T00:00' }, { ts: '2026-09-30T00:00' }], 14);
  assert.equal(r.treino.length + r.recentes.length, 2);
});

test('dedupe do registro é por igualdade do interactionId (i1 não casa com interaction-i10)', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  const reg = ['interaction-i1', 'interaction-i10'].map((interactionId, n) => ({ ts: `2026-09-1${n}T00:00:00`, interactionId, vetores: [vet], usadas: { capacidades: ['agenda'], funcoes: [] } }));
  const r = await treinarAnel({ anel: 'provider', retrato, casos: [{ ...casos[0], id: '20260901-100000_interaction-i10' }, ...casos.slice(1)], embedder: emb, margem: -1, epocas: 2, casosRegistro: reg });
  assert.equal(r.resumo.doRegistro, 2); // o registro vence: o i10 entra pelo registro (e o log dele sai); o i1 não casa com o log do i10
  assert.equal(r.resumo.logSubstituidosPeloRegistro, 1);
});

test('registro: caso de outro embedder (slug/dim) é descartado e contado; caso de avaliação nunca treina, só julga', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  const base = (n, extra = {}) => ({ ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-r${n}`, vetores: [vet], usadas: { capacidades: ['agenda'], funcoes: [] }, ...extra });
  const reg = [base(1, { slug: 'outro' }), base(2, { dim: 9 }), base(3, { slug: 'falso', dim: 4 }), ...Array.from({ length: 6 }, (_, n) => base(10 + n, { avaliacao: true }))];
  let treinado;
  const espia = async (a) => { treinado = a; return treinarCabeca(a); };
  const sem = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 2 });
  const r = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 2, casosRegistro: reg, treinarCabecaFn: espia });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.embedderDiferente, 2);
  assert.equal(r.resumo.doRegistro, 7); // 1 normal + 6 de avaliação
  // os 6 de avaliação entram nos recentes, não no treino (treino cresce no máximo 1 caso normal)
  assert.ok(r.resumo.treino <= sem.resumo.treino + 1);
  assert.ok(r.resumo.recentes >= sem.resumo.recentes + 6);
  assert.equal(treinado.casos.length, r.resumo.treino);
});

test('I6 (spec §5): caso do registro de outro embedder COM texto é re-embedado com o embedder atual; sem texto, descartado; conta no resumo', async () => {
  const { retrato } = await retratoReal('provider');
  const base = (n, extra = {}) => ({ ts: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00`, interactionId: `interaction-q${n}`, vetores: [[9, 9, 9, 9, 9, 9]], usadas: { capacidades: ['agenda'], funcoes: [] }, ...extra });
  const reg = [
    base(1, { slug: 'outro', dim: 6, texto: 'agenda de hoje' }), // com texto: re-embeda
    base(2, { slug: 'outro', dim: 6, texto: 'minha agenda' }),
    base(3, { slug: 'outro', dim: 6 }), // sem texto: descartado
    base(4, { dim: 9, texto: 'agenda do mês' }), // dimensão diferente com texto: re-embeda
    base(5, { slug: 'falso', dim: 4, vetores: [[1, 0.02, 0.03, 0.04]] }), // do embedder atual: segue como está
    ...Array.from({ length: 6 }, (_, n) => base(10 + n, { avaliacao: true, slug: 'falso', dim: 4, vetores: [[1, 0.02, 0.03, 0.04]] })),
  ];
  let embedados = 0;
  const contando = { modelSlug: 'falso', async embed(t, papel) { embedados++; return emb.embed(t, papel); } };
  const antes = embedados;
  let treinado;
  const r = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, embedderPedidos: contando, margem: -1, epocas: 2, casosRegistro: reg, treinarCabecaFn: async (a) => { treinado = a; return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.reembedados, 3);
  assert.equal(r.resumo.embedderDiferente, 1, 'só o sem texto é descartado');
  assert.ok(embedados - antes >= 3);
  assert.ok(r.reposicao.every((x) => x.v.length === 4), 'a reposição guarda o vetor do embedder ATUAL');
  assert.ok(treinado.casos.length > 0);
});

test('piso: treinarAnel com `excluir` (provider: capacidade; tool: só a função fixa) não a tem em rótulos, candidatos, métricas nem na reposição', async () => {
  const { retrato } = await retratoReal('provider');
  const r = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 2, excluir: ['agenda'] });
  assert.equal(r.ok, true, r.motivo);
  assert.ok(!('agenda' in r.arquivo.metricas), 'sem métrica do piso');
  assert.ok(r.reposicao.length > 0 && r.reposicao.every((x) => !x.rotulos.includes('agenda')), 'sem o piso nos rótulos da reposição');
  const comPiso = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 2 });
  assert.ok('agenda' in comPiso.arquivo.metricas && comPiso.reposicao.some((x) => x.rotulos.includes('agenda')), 'controle: sem excluir o piso existe');
  let treinado;
  await treinarAnel({ anel: 'tool', retrato: (await retratoReal('tool')).retrato, casos, embedder: emb, margem: -1, epocas: 2, excluir: ['agenda/tool/a1'], treinarCabecaFn: async (a) => { treinado = a; return treinarCabeca(a); } });
  assert.ok(treinado.candidatosPorCaso.every((d) => d.every((j) => j < treinado.P.length)), 'domínio só com candidatos que existem sem a fixa');
  const sem = []; await treinarAnel({ anel: 'tool', retrato: (await retratoReal('tool')).retrato, casos, embedder: emb, margem: -1, epocas: 2, treinarCabecaFn: async (a) => { sem.push(a); return treinarCabeca(a); } });
  assert.equal(treinado.P.length, sem[0].P.length - 1, 'só a função fixa saiu; as outras funções da capacidade seguem no tool');
});

test('I-B: o MESMO caso do registro vira o mesmo item (alvos, domínio, peso) no treino completo e no lote — positivo com carga junto, fraco e piso do caso', async () => {
  for (const anel of ['provider', 'tool']) {
    const { retrato } = await retratoReal(anel);
    const bruto = await montarIndiceDoRetrato(anel, retrato.nos, emb);
    const cal = await calibrarCortes(bruto);
    const indice = semRoubados(bruto, cal.roubados);
    const refs = [...indice.nos.keys()];
    const vet = (k) => [0.01 + 0.0001 * k, 0.02, 0.03, 1];
    const base = { slug: 'falso', dim: 4, usadas: { capacidades: [], funcoes: [] }, pedidasPelaLlm: [], avaliacao: false };
    const casosReg = anel === 'provider'
      ? [
        { ...base, interactionId: 'p1', ts: '2026-09-02T00:00:00', vetores: [vet(1)], usadas: { capacidades: ['tarefas'], funcoes: [] }, carregadas: { provider: ['tarefas'] } },
        { ...base, interactionId: 'p2', ts: '2026-09-02T00:00:01', vetores: [vet(2)], usadas: { capacidades: ['notas'], funcoes: [] }, carregadas: { provider: ['notas'] }, piso: { ids: ['tarefas'], fixas: [] } },
        { ...base, interactionId: 'p3', ts: '2026-09-02T00:00:02', vetores: [vet(3)], usadas: { capacidades: ['agenda'], funcoes: [] }, pedidasPelaLlm: ['agenda'], carregadas: { provider: ['agenda', 'notas'] } }, // positivo: agenda foi usada (load_capability), notas não é punida
        { ...base, interactionId: 'p4', ts: '2026-09-02T00:00:03', vetores: [vet(4)], carregadas: { provider: ['tarefas'] } }, // fraco puro
      ]
      : [
        { ...base, interactionId: 't1', ts: '2026-09-02T00:00:00', vetores: [vet(1)], usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] }, carregadas: { tool: ['agenda/tool/a1', 'agenda/tool/a2'] } }, // a2 = carga junto
        { ...base, interactionId: 't2', ts: '2026-09-02T00:00:01', vetores: [vet(2)], usadas: { capacidades: ['tarefas'], funcoes: ['tarefas/tool/t1'] }, carregadas: { tool: ['tarefas/tool/t1', 'notas/tool/n1'] }, piso: { ids: [], fixas: ['notas/tool/n1'] } },
        { ...base, interactionId: 't3', ts: '2026-09-02T00:00:02', vetores: [vet(3)], carregadas: { tool: ['notas/tool/n1'] } }, // fraco
        { ...base, interactionId: 't4', ts: '2026-09-02T00:00:03', vetores: [vet(5)], usadas: { capacidades: [], funcoes: ['notas/tool/n1'] }, carregadas: { tool: ['notas/tool/n1'] }, piso: { ids: ['notas'], fixas: [] } }, // função NÃO fixa de capacidade piso: segue rótulo
      ];
    // treino completo: captura o que o treinarAnel entregou ao treino (identifica o caso pelo vetor centrado)
    let treinoCompleto;
    const rc = await treinarAnel({ anel, retrato, casos, embedder: emb, margem: -1, epocas: 1, casosRegistro: casosReg, treinarCabecaFn: async (a) => { treinoCompleto = a; return treinarCabeca(a); } });
    assert.equal(rc.ok, true, rc.motivo);
    // lote: mesmo índice
    const P = refs.map((r) => indice.nos.get(r).centroide);
    const { cabeca } = treinarCabeca({ casos: [{ s: P[0], pos: new Set([0]) }], P, epocas: 2, lr: 0.5, seed: 1, posto: 4 });
    let lote;
    const avs = Array.from({ length: 6 }, (_, i) => ({ ...base, interactionId: `av${i}`, vetores: [vet(100 + i)], avaliacao: true, usadas: anel === 'provider' ? { capacidades: ['agenda'], funcoes: [] } : { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] }, carregadas: { [anel]: [] } }));
    const rl = await atualizarPorLote({ anel, indice, atual: { cabeca, anelAprovado: false, metricasAnel: null }, casosNovos: casosReg, reposicao: [], recentes: avs, epocas: 1, minAvaliacao: 1, amostraReposicao: 0, treinarCabecaFn: async (a) => { lote = a; return treinarCabeca(a); } });
    assert.equal(rl.ok, true, `o lote rodou (${rl.motivo})`);
    assert.ok(lote, 'o lote treinou');
    const chave = (args, idx) => { const c = args.casos[idx]; return JSON.stringify({ pos: [...c.pos].sort(), peso: c.peso ?? 1, dom: [...args.candidatosPorCaso[idx]].sort() }); };
    for (const rg of casosReg) {
      const s = consultaCentrada(indice, rg.vetores)[0];
      const achar = (args) => args.casos.findIndex((c) => c.s.every((x, i) => Math.abs(x - s[i]) < 1e-9));
      const iC = achar(treinoCompleto); const iL = achar(lote);
      // um fraco acima do teto de metade pode ficar de fora de um dos dois; quando entra nos dois, o item é idêntico
      // TODOS os casos aparecem nos dois caminhos (os fracos cabem: há mais positivos que fracos) e são idênticos
      assert.ok(iC >= 0 && iL >= 0, `${anel} ${rg.interactionId} entra nos dois caminhos`);
      assert.equal(chave(treinoCompleto, iC), chave(lote, iL), `${anel} ${rg.interactionId}`);
    }
    // propriedades que os dois caminhos garantem (não só "iguais entre si")
    const idxDe = (args, id) => args.casos.findIndex((c) => { const rg = casosReg.find((x) => x.interactionId === id); const s = consultaCentrada(indice, rg.vetores)[0]; return c.s.every((x, i) => Math.abs(x - s[i]) < 1e-9); });
    if (anel === 'tool') {
      for (const args of [treinoCompleto, lote]) {
        const i1 = idxDe(args, 't1'); assert.ok(!args.candidatosPorCaso[i1].includes(refs.indexOf('agenda/tool/a2')), 'carga junto fora do domínio');
        const i2 = idxDe(args, 't2'); assert.ok(!args.candidatosPorCaso[i2].includes(refs.indexOf('notas/tool/n1')), 'a fixa do piso do caso fora do domínio');
        const i4 = idxDe(args, 't4'); assert.deepEqual([...args.casos[i4].pos], [refs.indexOf('notas/tool/n1')], 'a função não fixa do piso é alvo nos dois caminhos');
      }
    } else {
      for (const args of [treinoCompleto, lote]) {
        const i2 = idxDe(args, 'p2'); assert.ok(!args.candidatosPorCaso[i2].includes(refs.indexOf('tarefas')), 'a capacidade de piso do caso fora do domínio');
      }
    }
  }
});

test('M7/I-B: com `excluir` (piso incondicional) e com a REPOSIÇÃO, os dois caminhos continuam iguais', async () => {
  const anel = 'tool';
  const { retrato } = await retratoReal(anel);
  const excluir = ['so-exemplo/tool/s1'];
  const vet = (k) => [0.01 + 0.0001 * k, 0.02, 0.03, 1];
  const base = { slug: 'falso', dim: 4, usadas: { capacidades: [], funcoes: [] }, pedidasPelaLlm: [], avaliacao: false };
  const t1 = { ...base, interactionId: 't1', ts: '2026-09-02T00:00:00', vetores: [vet(1)], usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] }, carregadas: { tool: ['agenda/tool/a1', 'agenda/tool/a2', 'so-exemplo/tool/s1'] }, piso: { ids: [], fixas: ['notas/tool/n1'] } };
  const t3 = { ...base, interactionId: 't3', ts: '2026-09-02T00:00:02', vetores: [vet(3)], carregadas: { tool: ['notas/tool/n1', 'so-exemplo/tool/s1'] } };
  let completo;
  const rc = await treinarAnel({ anel, retrato, casos, embedder: emb, margem: -1, epocas: 1, casosRegistro: [t1, t3], excluir, treinarCabecaFn: async (a) => { completo = a; return treinarCabeca(a); } });
  assert.equal(rc.ok, true, rc.motivo);
  const bruto = await montarIndiceDoRetrato(anel, retrato.nos, emb);
  const indice = semRoubados(bruto, (await calibrarCortes(bruto)).roubados);
  const refs = [...indice.nos.keys()].filter((r) => !excluir.includes(r));
  assert.equal(completo.P.length, refs.length, 'o excluir tirou a função do índice nos dois');
  const P = refs.map((r) => indice.nos.get(r).centroide);
  const { cabeca } = treinarCabeca({ casos: [{ s: P[0], pos: new Set([0]) }], P, epocas: 2, lr: 0.5, seed: 1, posto: 4 });
  const avs = Array.from({ length: 6 }, (_, i) => ({ ...base, interactionId: `av${i}`, vetores: [vet(100 + i)], avaliacao: true, usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/a1'] }, carregadas: { tool: [] } }));
  let lote;
  const rl = await atualizarPorLote({ anel, indice, atual: { cabeca, anelAprovado: false, metricasAnel: null }, casosNovos: [t1, t3], reposicao: [], recentes: avs, epocas: 1, minAvaliacao: 1, excluir, treinarCabecaFn: async (a) => { lote = a; return treinarCabeca(a); } });
  assert.equal(rl.ok, true, rl.motivo);
  const achar = (args, rg) => { const s = consultaCentrada(indice, rg.vetores)[0]; return args.casos.findIndex((c) => c.s.every((x, i) => Math.abs(x - s[i]) < 1e-9)); };
  const chave = (args, i) => JSON.stringify({ pos: [...args.casos[i].pos].sort(), peso: args.casos[i].peso ?? 1, dom: [...args.candidatosPorCaso[i]].sort() });
  for (const rg of [t1, t3]) {
    const iC = achar(completo, rg); const iL = achar(lote, rg);
    assert.ok(iC >= 0 && iL >= 0, rg.interactionId);
    assert.equal(chave(completo, iC), chave(lote, iL), rg.interactionId);
  }
  // a REPOSIÇÃO que o treino completo gravou (com `neutras`), reaproveitada pelo lote, mantém o domínio do t1 (sem a2, sem a fixa do caso)
  const rep = rc.reposicao.find((x) => x.neutras?.includes('agenda/tool/a2'));
  assert.ok(rep, 'o treino completo grava `neutras` na reposição');
  let doRepo;
  await atualizarPorLote({ anel, indice, atual: { cabeca, anelAprovado: false, metricasAnel: null }, casosNovos: [], reposicao: [rep], slugReposicao: 'falso', recentes: avs, epocas: 1, minAvaliacao: 1, amostraReposicao: 5, excluir, treinarCabecaFn: async (a) => { doRepo = a; return treinarCabeca(a); } });
  assert.ok(doRepo, 'o lote treinou com a reposição');
  assert.ok(!doRepo.candidatosPorCaso[0].includes(refs.indexOf('agenda/tool/a2')) && !doRepo.candidatosPorCaso[0].includes(refs.indexOf('notas/tool/n1')));
});

test('I-2: o registro vence o log na mesma interação — um caso de AVALIAÇÃO do registro nunca treina pela versão de log', async () => {
  const { retrato } = await retratoReal('provider');
  const vet = [1, 0.02, 0.03, 0.04];
  // a interação existe no log (como caso de treino comum, antigo) e no registro como caso de AVALIAÇÃO
  const idLog = '20260901-100000_interaction-av0';
  const logAv = { id: idLog, ts: '2026-09-01T10:00', pedido: 'agenda de amanhã', capacidades: ['agenda'], funcoes: ['a1'] };
  const reg = [{ ts: '2026-09-27T00:00:00', interactionId: 'interaction-av0', avaliacao: true, vetores: [vet], slug: 'falso', dim: 4, usadas: { capacidades: ['agenda'], funcoes: [] } }];
  const pedidos = [];
  const embRastreado = { modelSlug: 'falso', async embed(t, papel) { pedidos.push(t); return emb.embed(t, papel); } };
  const comLog = await treinarAnel({ anel: 'provider', retrato, casos: [logAv, ...casos], embedder: emb, embedderPedidos: embRastreado, margem: -1, epocas: 2, casosRegistro: reg });
  assert.equal(comLog.ok, true, comLog.motivo);
  const semLog = await treinarAnel({ anel: 'provider', retrato, casos, embedder: emb, margem: -1, epocas: 2, casosRegistro: reg });
  assert.equal(comLog.resumo.logSubstituidosPeloRegistro, 1);
  assert.equal(comLog.resumo.treino, semLog.resumo.treino, 'o caso de avaliação do registro não entrou no treino por uma versão de log');
  assert.equal(comLog.resumo.recentes, semLog.resumo.recentes);
  assert.ok(!pedidos.includes('agenda de amanhã') || casos.some((c) => c.pedido === 'agenda de amanhã'), 'a versão de log nem foi embedada');
  // log de interação ausente do registro continua entrando
  const ausente = await treinarAnel({ anel: 'provider', retrato, casos: [{ ...logAv, id: '20260901-100000_interaction-outra' }, ...casos], embedder: emb, margem: -1, epocas: 2, casosRegistro: reg });
  assert.equal(ausente.resumo.logSubstituidosPeloRegistro, 0);
  assert.equal(ausente.resumo.treino, semLog.resumo.treino + 1);
});

test('I-1: nomes de operação do log — ref interna cap/tool/fn, nome cru e exposto cap__fn — dão os MESMOS alvos e o MESMO domínio do registro', async () => {
  const { casoDaInteracao, mapaDeFuncoes, resolverNomeDeOperacao } = await import('../treino/lib/casos.js');
  const { itemDoRegistro } = await import('../treino/lib/item-do-registro.js');
  const { alvosDoCaso, dominioDoCaso } = await import('../treino/lib/dominio.js');
  const { retrato } = await retratoReal('tool');
  const bruto = await montarIndiceDoRetrato('tool', retrato.nos, emb);
  const indice = semRoubados(bruto, (await calibrarCortes(bruto)).roubados);
  const refs = [...indice.nos.keys()];
  const mapa = mapaDeFuncoes(capacidades.map((c) => ({ id: c.id, functions: c.tools.map((t) => ({ name: t.name })) })), 'functions');
  const execLog = { input: { userMessage: 'agenda de amanhã' } };
  const s = consultaCentrada(indice, [[1, 0.02, 0.03, 0.04]])[0];
  for (const nome of ['agenda/tool/a1', 'a1', 'agenda__a1']) {
    // log
    const log = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog, timeline: { items: [] }, fabrica: { operacoes: [{ nome, ok: true }] }, mapa });
    assert.deepEqual(log.descartadas, [], `${nome}: nada descartado`);
    assert.deepEqual(log.capacidades, ['agenda'], nome);
    const alvosLog = alvosDoCaso('tool', log, refs);
    const domLog = dominioDoCaso('tool', { ...log, s }, refs, indice);
    // registro: o treino contínuo resolve o mesmo nome pelo MESMO resolvedor e grava a ref exata
    const r = resolverNomeDeOperacao(nome, mapa);
    const reg = { usadas: { capacidades: [r.cap], funcoes: [`${r.cap}/tool/${r.fn}`] }, carregadas: { tool: [`${r.cap}/tool/${r.fn}`] } };
    const it = itemDoRegistro({ anel: 'tool', caso: reg, s, refs, indice });
    assert.equal(it.tipo, 'positivo', nome);
    assert.deepEqual([...it.rotulos].sort(), [...alvosLog].sort(), `${nome}: mesmos alvos`);
    assert.deepEqual([...it.dom].sort(), [...domLog].sort(), `${nome}: mesmo domínio`);
  }
  // nome que nada resolve segue sendo descarte legítimo
  assert.equal(resolverNomeDeOperacao('inexistente_xyz', mapa), null);
  assert.equal(resolverNomeDeOperacao('capinexistente__fn', mapa), null);
});

test('I-A: ref do log cuja capacidade sumiu do índice (power removido, MCP desconectado) é INCERTO nos dois anéis; piso (fora) segue como antes', async () => {
  for (const anel of ['provider', 'tool']) {
    const { retrato } = await retratoReal(anel);
    const op = { treinar: true };
    const roda = (extra, excluir = []) => treinarAnel({ anel, retrato, casos: [...casos, ...extra], embedder: emb, margem: -1, epocas: 2, excluir });
    const base = await roda([]);
    // só ref de power removido / MCP fora do retrato → incerto, o treino não muda
    const fantasma = { id: 'f1', ts: '2026-09-02T00:00', pedido: 'agenda de amanhã', capacidades: ['powerremovido'], funcoes: ['fazer'], descartadas: [] };
    const mcp = { id: 'f2', ts: '2026-09-02T00:00', pedido: 'tarefa aberta', capacidades: ['mcp-velho'], funcoes: ['browser_click'], descartadas: [] };
    const r = await roda([fantasma, mcp]);
    assert.equal(r.resumo.incertos, base.resumo.incertos + 2, `${anel}: os dois viram incerto`);
    assert.equal(r.resumo.treino, base.resumo.treino, `${anel}: o treino não muda`);
    assert.equal(r.resumo.recentes, base.resumo.recentes);
    // caso misto (uma capacidade do índice + uma fantasma) segue positivo
    const misto = { id: 'f3', ts: '2026-09-02T00:00', pedido: 'agenda de amanhã', capacidades: ['agenda', 'powerremovido'], funcoes: ['a1', 'fazer'], descartadas: [] };
    const m = await roda([misto]);
    assert.equal(m.resumo.incertos, base.resumo.incertos);
    assert.equal(m.resumo.treino, base.resumo.treino + 1);
    // piso incondicional (em `fora`): continua entrando, como antes — não é descarte
    const so = { id: 'f4', ts: '2026-09-02T00:00', pedido: 'nota sobre x', capacidades: ['notas'], funcoes: ['n1'], descartadas: [] };
    const excluir = anel === 'provider' ? ['notas'] : ['notas/tool/n1'];
    const semPiso = await roda([], excluir); const comPiso = await roda([so], excluir);
    assert.equal(comPiso.resumo.incertos, semPiso.resumo.incertos, `${anel}: piso só não é incerto`);
    // provider: treina como "nada" (como antes). tool: a capacidade piso não tem função no índice → sem domínio, também como antes (não é incerto)
    assert.equal(comPiso.resumo.treino, semPiso.resumo.treino + (anel === 'provider' ? 1 : 0), `${anel}: e continua como antes`);
    void op;
  }
});

test('m-2: só o registro que foi JULGADO bloqueia o log; descarte por vetor (embedder diferente sem texto) não bloqueia', async () => {
  const { retrato } = await retratoReal('provider');
  const logDup = { id: '20260901-100000_interaction-dup', ts: '2026-09-01T10:00', pedido: 'agenda de amanhã', capacidades: ['agenda'], funcoes: ['a1'], descartadas: [] };
  const roda = (reg) => treinarAnel({ anel: 'provider', retrato, casos: [logDup, ...casos], embedder: emb, margem: -1, epocas: 2, casosRegistro: reg });
  const semReg = await roda([]);
  // registro com OUTRO embedder e sem texto: descartado por vetor — não opinou, o log entra
  const descartado = [{ ts: '2026-09-02T00:00:00', interactionId: 'interaction-dup', slug: 'outro', dim: 4, vetores: [[1, 0.02, 0.03, 0.04]], usadas: { capacidades: ['agenda'], funcoes: [] } }];
  const r1 = await roda(descartado);
  assert.equal(r1.resumo.embedderDiferente, 1);
  assert.equal(r1.resumo.logSubstituidosPeloRegistro, 0, 'o log da mesma interação NÃO foi bloqueado');
  assert.equal(r1.resumo.treino, semReg.resumo.treino);
  // registro julgado (virou item): bloqueia o log
  const julgado = [{ ts: '2026-09-02T00:00:00', interactionId: 'interaction-dup', slug: 'falso', dim: 4, vetores: [[1, 0.02, 0.03, 0.04]], usadas: { capacidades: ['agenda'], funcoes: [] } }];
  const r2 = await roda(julgado);
  assert.equal(r2.resumo.logSubstituidosPeloRegistro, 1);
  // registro julgado INCERTO (rótulo que sumiu do índice) também bloqueia: o registro opinou
  const incerto = [{ ts: '2026-09-02T00:00:00', interactionId: 'interaction-dup', slug: 'falso', dim: 4, vetores: [[1, 0.02, 0.03, 0.04]], usadas: { capacidades: ['powerremovido'], funcoes: [] } }];
  const r3 = await roda(incerto);
  assert.equal(r3.resumo.logSubstituidosPeloRegistro, 1);
  assert.ok(r3.resumo.incertos >= 1);
});

test('m-4: o resumo do treino completo documenta as limitações do log (peso 1 sem uso/só piso; trivial/sem-sinal do registro entra)', async () => {
  const { LIMITACOES_DO_LOG } = await import('../treino/lib/treino.js');
  assert.ok(LIMITACOES_DO_LOG.some((l) => /só o piso.*peso 1/.test(l)));
  assert.ok(LIMITACOES_DO_LOG.some((l) => /trivial ou sem-sinal ENTRA/.test(l)));
});

// packages/decisions/test/local-refinador.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { montarIndice } from '../src/local/indice.js';
import { consultaCentrada, pontuarNo } from '../src/local/pontuador.js';
import { novaCabeca, pontuarCabeca, serializarCabeca, carregarCabeca } from '../src/local/cabeca.js';
import { calibrarCortes, semRoubados } from '../src/local/cortes.js';
import { CORTES_FIXOS, FUNCAO_TRAZ_PADRAO } from '../src/local/cortes-fixos.js';
import { criarRefinadorLocal, estadoDoAnel } from '../src/local/refinador-local.js';
import { embedderFalso, embedderTabela, capsFalsas, TABELA, caps as capsTres } from './helpers/fixtures.js';

const item = (ref, position, proposedTier, meta = {}) => ({ ref, position, scores: { final: 0.5 }, proposedTier, meta });
const entrada = async (emb, texto, items, ring = 'provider', loaded = [], vetores = null) => ({
  ring, query: { text: texto, vectors: vetores ?? [await emb.embed(texto)] }, items,
  proposal: { full: items.filter((i) => i.proposedTier === 'full').map((i) => i.ref), candidates: items.filter((i) => i.proposedTier === 'candidate').map((i) => i.ref) },
  caps: { maxFull: 4, maxCandidates: 8, hard: { maxFull: 4, maxCandidates: 8 } }, state: { loadedProviders: loaded }, ctx: {}, budgetMs: 600,
});

// Cabeça REAL: criada, serializada (v2), gravada e recarregada com a amarração slug/dim. Devolve o que o estado do anel guarda.
const cabecaReal = (indice, { anelAprovado = true, nTreinoPorCapacidade = {}, seed = 3 } = {}) => {
  const arq = join(mkdtempSync(join(tmpdir(), 'ref-')), 'cabeca.json');
  const c = novaCabeca({ d: indice.dim, posto: 2, seed });
  writeFileSync(arq, JSON.stringify(serializarCabeca(c, { anel: indice.anel, slug: indice.slug, hash: indice.hash, anelAprovado, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, metricas: {}, nTreinoPorCapacidade, cortesSugeridos: null })));
  const r = carregarCabeca({ arquivo: arq, slug: indice.slug, dim: indice.dim });
  assert.equal(r.ok, true);
  assert.equal(r.versaoDoArquivo, 2);
  return { cabeca: r.cabeca, anelAprovado: r.anelAprovado, nTreinoPorCapacidade: r.nTreinoPorCapacidade };
};

// Estado do anel no contrato novo. `minCasosCapacidade: 0` desliga a D5 nos testes que não são dela.
const cortesEm = (over = {}) => ({ cabeca: { ...CORTES_FIXOS.cabeca }, base: { ...CORTES_FIXOS.base }, promocao: CORTES_FIXOS.promocao, ...over });
const baseCom = (full, candidate, over = {}) => cortesEm({ base: { full, candidate }, ...over });
const estadoDe = (indice, { cortes = cortesEm(), cabeca = null, funcaoTraz = { ...FUNCAO_TRAZ_PADRAO }, minCasosCapacidade = 0, tetoProvider } = {}) => ({
  indice, cortes, cabeca, funcaoTraz, minCasosCapacidade, ...(tetoProvider === undefined ? {} : { tetoProvider }),
});
const estado = (indice, opcoes) => () => estadoDe(indice, opcoes);

// Catálogo gradual (embedderFalso): para a consulta 'agenda', agenda é a casada, tarefas é parcial, notas/busca são distantes.
const capsGradual = () => [
  { id: 'agenda', semanticText: 'agenda' },
  { id: 'tarefas', semanticText: 'agenda tarefa' },
  { id: 'notas', semanticText: 'nota' },
  { id: 'busca', semanticText: 'busca' },
];
// Catálogo para D4a/D4b: `docs` tem uma função que casa 'agenda' exatamente e uma parcial; docs em si não casa nada.
const capsFuncoes = (docsTools) => [
  { id: 'docs', semanticText: 'doc', tools: docsTools ?? [{ name: 'exata', semanticText: 'agenda' }, { name: 'parcial', semanticText: 'agenda tarefa' }, { name: 'outra', semanticText: 'busca' }] },
  { id: 'agenda', semanticText: 'agenda', tools: [{ name: 'listar', semanticText: 'agenda tarefa' }] },
  { id: 'tarefas', semanticText: 'agenda tarefa', tools: [{ name: 'abrir', semanticText: 'tarefa' }] },
  { id: 'notas', semanticText: 'nota', tools: [{ name: 'ler', semanticText: 'nota' }] },
  { id: 'busca', semanticText: 'busca', tools: [{ name: 'web', semanticText: 'busca' }] },
];

test('estadoDoAnel: cabeça só com versão aprovada pelo portão do anel; skill nunca; sem estado = base', () => {
  const aprovado = { cabeca: { cabeca: { d: 1 }, anelAprovado: true } };
  assert.equal(estadoDoAnel(aprovado, 'provider'), 'cabeca');
  assert.equal(estadoDoAnel(aprovado, 'tool'), 'cabeca');
  assert.equal(estadoDoAnel(aprovado, 'skill'), 'base');
  assert.equal(estadoDoAnel({ cabeca: { cabeca: { d: 1 }, anelAprovado: false } }, 'provider'), 'base');
  assert.equal(estadoDoAnel({ cabeca: null }, 'provider'), 'base');
  assert.equal(estadoDoAnel(null, 'tool'), 'base');
  assert.equal(estadoDoAnel({ indice: null, motivo: 'x' }, 'provider'), 'base');
});

test('provider: decide pelos cortes, explica a origem e respeita o teto de full', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: baseCom(0.5, 0.1) }) });
  const r = await refinar(await entrada(emb, 'minhas tarefa', [item('google-calendar', 0, 'full'), item('tarefas', 1, 'discard')]));
  assert.deepEqual(r.full, ['tarefas']);
  assert.ok(!r.full.includes('google-calendar'));
  assert.match(r.explain.tarefas.reason, /^local:base/);
  assert.equal(typeof r.explain.tarefas.confidence, 'number');
  assert.match(r.explain.tarefas.casou, /^(texto|exemplo:\d+)$/);
});

test('provider já carregado nunca cai abaixo do proposto', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: baseCom(0.99, 0.98) }) });
  const r = await refinar(await entrada(emb, 'xyz', [item('google-calendar', 0, 'full')], 'provider', ['google-calendar']));
  assert.deepEqual(r.full, ['google-calendar']);
});

test('degradado devolve a proposta do motor e nunca lança', async () => {
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: () => ({ indice: null, motivo: 'indice-montando' }) });
  const emb = embedderFalso();
  const inp = await entrada(emb, 'agenda', [item('google-calendar', 0, 'full'), item('tarefas', 1, 'candidate')]);
  const r = await refinar(inp);
  assert.deepEqual([r.full, r.candidates], [['google-calendar'], ['tarefas']]);
  assert.equal(r.explain['google-calendar'].reason, 'local:degradado (indice-montando)');
  const r2 = await criarRefinadorLocal({ anel: 'provider', obterEstado: () => { throw new Error('boom'); } })(inp);
  assert.match(r2.explain['google-calendar'].reason, /local:degradado \(erro: boom\)/);
});

test('cortes fixos ausentes ou inválidos no estado (formato antigo {full,candidate}, sem promocao, não finito) → degradado (sem-cortes-fixos)', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const inp = await entrada(emb, 'agenda', [item('google-calendar', 0, 'full'), item('tarefas', 1, 'candidate')]);
  const invalidos = [{ full: 0.5, candidate: 0.1 }, undefined, cortesEm({ promocao: undefined }), cortesEm({ base: { full: NaN, candidate: 0.1 } }), cortesEm({ cabeca: { full: 0.3 } })];
  for (const cortes of invalidos) {
    const r = await criarRefinadorLocal({ anel: 'provider', obterEstado: () => ({ ...estadoDe(indice), cortes }) })(inp);
    assert.deepEqual([r.full, r.candidates], [['google-calendar'], ['tarefas']]);
    assert.equal(r.explain.tarefas.reason, 'local:degradado (sem-cortes-fixos)');
  }
});

test('query.vectors vazio ou de dimensão errada → degradado (sem-vetor-de-consulta)', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice) });
  for (const vetores of [[], [[1, 2]], undefined]) {
    const inp = await entrada(emb, 'agenda', [item('google-calendar', 0, 'full'), item('tarefas', 1, 'candidate')]);
    inp.query.vectors = vetores;
    const r = await refinar(inp);
    assert.deepEqual([r.full, r.candidates], [['google-calendar'], ['tarefas']]);
    assert.equal(r.explain.tarefas.reason, 'local:degradado (sem-vetor-de-consulta)');
  }
});

test('D1: anel aprovado → nota da cabeça para TODAS as capacidades (inclusive sem casos), cortes fixos da cabeça, ordem pela nota', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const cab = cabecaReal(indice, { nTreinoPorCapacidade: { agenda: 80, tarefas: 80 } }); // notas e busca: sem casos de treino
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab, minCasosCapacidade: 50 }) }); // cortes fixos: 0,30 / 0,15
  const vetores = [await emb.embed('agenda')];
  // tarefas vem ANTES de agenda na entrada (position menor): quem ordena é a nota
  const r = await refinar(await entrada(emb, 'agenda', [item('busca', 0, 'discard'), item('notas', 1, 'discard'), item('tarefas', 2, 'discard'), item('agenda', 3, 'discard')], 'provider', [], vetores));
  const s = consultaCentrada(indice, vetores);
  const nota = (ref) => Math.max(...s.map((x) => pontuarCabeca(cab.cabeca, x, indice.nos.get(ref).centroide)));
  for (const ref of ['agenda', 'tarefas', 'notas', 'busca']) {
    assert.equal(r.explain[ref].reason, 'local:cabeca', ref);
    assert.equal(r.explain[ref].casou, 'cabeca');
    assert.equal(r.explain[ref].confidence, nota(ref));
  }
  // pré-condições dos cortes fixos da cabeça (0,30 full / 0,15 candidate)
  assert.ok(nota('tarefas') >= 0.30 && nota('tarefas') < nota('agenda'), `tarefas ${nota('tarefas')} agenda ${nota('agenda')}`);
  assert.ok(nota('notas') < 0.15 && nota('busca') < 0.15);
  assert.deepEqual(r.full, ['agenda', 'tarefas']);
  assert.deepEqual(r.candidates, []);
});

test('D1: anel NÃO aprovado → base para todas, cortes fixos da base; a cabeça é ignorada inteira', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const cab = cabecaReal(indice, { anelAprovado: false });
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab }) }); // cortes fixos: base 0,35 / 0,25
  const vetores = [await emb.embed('agenda')];
  const r = await refinar(await entrada(emb, 'agenda', [item('agenda', 0, 'discard'), item('tarefas', 1, 'discard'), item('notas', 2, 'discard')], 'provider', [], vetores));
  const q = consultaCentrada(indice, vetores);
  for (const ref of ['agenda', 'tarefas', 'notas']) {
    assert.match(r.explain[ref].reason, /^local:base/, ref);
    assert.equal(r.explain[ref].confidence, pontuarNo(indice, q, ref).nota);
  }
  // com a cabeça valendo, tarefas (≈ 0,37 > 0,30) seria full; na base (≈ 0,29, entre 0,25 e 0,35) é candidate
  assert.deepEqual(r.full, ['agenda']);
  assert.deepEqual(r.candidates, ['tarefas']);
});

test('D2: os cortes vêm do estado, um par por caminho — cabeca.* na cabeça, base.* na base; o outro par é ignorado', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const itens = () => [item('agenda', 0, 'discard'), item('tarefas', 1, 'discard'), item('notas', 2, 'discard')];
  // cabeça: full 0,5 / candidate 0,2 (override); o par da base é absurdo (tudo full) e não pode vazar
  const cab = cabecaReal(indice);
  const absurdo = { full: -1, candidate: -1 };
  const rc = await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab, cortes: cortesEm({ cabeca: { full: 0.5, candidate: 0.2 }, base: absurdo }) }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  assert.deepEqual([rc.full, rc.candidates], [['agenda'], ['tarefas']]); // tarefas ≈ 0,37: entre 0,2 e 0,5
  // base: full 0,2 / candidate 0,1; o par da cabeça é absurdo e não pode vazar
  const rb = await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: cortesEm({ base: { full: 0.2, candidate: 0.1 }, cabeca: absurdo }) }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  assert.deepEqual([rb.full, rb.candidates], [['agenda', 'tarefas'], []]); // tarefas ≈ 0,29 ≥ 0,2
  // o índice não carrega corte nenhum: o que decide é só o estado
  assert.equal('cortes' in indice, false);
});

test('D5: capacidade com poucos casos cuja nota da cabeça não passa entra pela BASE se base ≥ cortes.base.full, depois dos itens da cabeça', async () => {
  const emb = embedderFalso();
  // o centróide da agenda (texto + exemplos de outros assuntos) fica longe do pedido; o máximo do texto na base é exato
  const capsD5 = [
    { id: 'agenda', semanticText: 'agenda', tools: [{ name: 'x', exemplos: ['nota', 'busca', 'tarefa'] }] },
    { id: 'tarefas', semanticText: 'agenda tarefa' },
    { id: 'notas', semanticText: 'nota' },
    { id: 'busca', semanticText: 'busca' },
  ];
  const indice = await montarIndice({ anel: 'provider', capacidades: capsD5, embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const q = consultaCentrada(indice, vetores);
  const cab = (n) => cabecaReal(indice, { nTreinoPorCapacidade: n });
  const cortes = cortesEm({ cabeca: { full: 0.30, candidate: 0.20 } }); // base fixa: 0,35 / 0,25
  const itens = () => [item('agenda', 0, 'discard'), item('tarefas', 1, 'discard'), item('notas', 2, 'discard')];
  const rodar = async (n, teto, min = 50) => {
    const c = cab(n);
    return { c, r: await criarRefinadorLocal({ anel: 'provider', tetoFull: teto, obterEstado: estado(indice, { cabeca: c, cortes, minCasosCapacidade: min }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores)) };
  };
  const notaCab = (c, ref) => Math.max(...q.map((x) => pontuarCabeca(c.cabeca, x, indice.nos.get(ref).centroide)));

  // agenda sem casos (n=0 < 50): cabeça não passa (< 0,20), base 1,0 ≥ 0,35 → entra pela base, DEPOIS de tarefas (cabeça), apesar da nota maior
  const { c, r } = await rodar({}, 2);
  assert.ok(notaCab(c, 'agenda') < 0.20, `pré-condição: cabeça da agenda ${notaCab(c, 'agenda')} < 0,20`);
  assert.ok(notaCab(c, 'tarefas') >= 0.30, `pré-condição: cabeça de tarefas ${notaCab(c, 'tarefas')} ≥ 0,30`);
  assert.ok(pontuarNo(indice, q, 'agenda').nota >= 0.35);
  assert.deepEqual(r.full, ['tarefas', 'agenda']);
  assert.equal(r.explain.agenda.reason, 'local:base (texto)');
  assert.equal(r.explain.agenda.confidence, pontuarNo(indice, q, 'agenda').nota);
  assert.equal(r.explain.tarefas.reason, 'local:cabeca');
  // capacidade que a base também não traz (notas) segue pela cabeça
  assert.equal(r.explain.notas.reason, 'local:cabeca');
  assert.ok(!r.full.includes('notas') && !r.candidates.includes('notas'));

  // teto 1: a vaga é de quem veio pela cabeça; a que entrou pela base vira candidate
  const um = await rodar({}, 1);
  assert.deepEqual([um.r.full, um.r.candidates], [['tarefas'], ['agenda']]);

  // agenda COM casos suficientes (80 ≥ 50): a D5 não vale, a cabeça decide (discard)
  const com = await rodar({ agenda: 80 }, 2);
  assert.deepEqual([com.r.full, com.r.candidates], [['tarefas'], []]);
  assert.equal(com.r.explain.agenda.reason, 'local:cabeca');

  // D5 desligada pelo limiar (0 casos não é "< 0"): idem
  const desl = await rodar({}, 2, 0);
  assert.deepEqual(desl.r.full, ['tarefas']);

  // base NÃO passa no corte full (1,5), mas passa no candidate (0,25): com poucos casos vale o maior nível → candidate pela base
  // (09/10: a cabeça não rebaixa o que a base daria). Com a base abaixo também do candidate, fica a cabeça (discard).
  const rBaixa = await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab({}), cortes: cortesEm({ cabeca: { full: 0.30, candidate: 0.20 }, base: { full: 1.5, candidate: 0.25 } }), minCasosCapacidade: 50 }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  assert.deepEqual([rBaixa.full, rBaixa.candidates], [['tarefas'], ['agenda']]);
  assert.equal(rBaixa.explain.agenda.reason, 'local:base (texto)');
  const rNada = await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab({}), cortes: cortesEm({ cabeca: { full: 0.30, candidate: 0.20 }, base: { full: 1.5, candidate: 1.4 } }), minCasosCapacidade: 50 }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  assert.deepEqual([rNada.full, rNada.candidates], [['tarefas'], []]);
  assert.equal(rNada.explain.agenda.reason, 'local:cabeca');
});

test('D5 no anel tool: a contagem de casos é da CAPACIDADE (prefixo do ref), não do ref da função', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const cortes = cortesEm({ cabeca: { full: 0.9, candidate: 0.8 }, base: { full: 0.2, candidate: 0.1 } });
  const rodar = async (n) => criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tool, { cabeca: cabecaReal(tool, { nTreinoPorCapacidade: n }), cortes, minCasosCapacidade: 50 }) })(
    await entrada(emb, 'agenda', [item('agenda/tool/listar', 0, 'candidate')], 'tool', ['agenda'], vetores));
  // listar: cabeça ≈ 0,33 < 0,8 (discard); base ≈ 0,26 ≥ 0,2 → com poucos casos da capacidade `agenda`, entra pela base (full)
  const poucos = await rodar({ agenda: 3 });
  assert.deepEqual(poucos.full, ['agenda/tool/listar']);
  assert.match(poucos.explain['agenda/tool/listar'].reason, /^local:base/);
  // casos suficientes na capacidade: a cabeça decide (discard) e "tool nunca rebaixa" devolve o candidate proposto
  const muitos = await rodar({ agenda: 80 });
  assert.deepEqual([muitos.full, muitos.candidates], [[], ['agenda/tool/listar']]);
  assert.equal(muitos.explain['agenda/tool/listar'].reason, 'local:cabeca');
  // contagem registrada no ref da função não conta: a chave é a capacidade (80 casos em `agenda` vence o 3 do ref)
  const chaveDoRef = await rodar({ agenda: 80, 'agenda/tool/listar': 3 });
  assert.deepEqual([chaveDoRef.full, chaveDoRef.candidates], [[], ['agenda/tool/listar']]);
});

test('D4a (tool): função de capacidade NÃO carregada só é full com nota ≥ cortes.promocao; abaixo fica candidate; carregada usa o corte normal', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const q = consultaCentrada(tool, vetores);
  const nExata = pontuarNo(tool, q, 'docs/tool/exata').nota;
  const nParcial = pontuarNo(tool, q, 'docs/tool/parcial').nota;
  const nListar = pontuarNo(tool, q, 'agenda/tool/listar').nota;
  assert.ok(nExata >= CORTES_FIXOS.promocao && nParcial < CORTES_FIXOS.promocao && nParcial >= 0.2 && nListar >= 0.2, `${nExata} ${nParcial} ${nListar}`);
  const itens = () => [item('docs/tool/exata', 0, 'discard'), item('docs/tool/parcial', 1, 'discard'), item('agenda/tool/listar', 2, 'candidate')];
  // o provider tem estado EXPLÍCITO e sem cabeça (base): só assim a promoção por `so-provider-na-base` (padrão) fica liberada
  const prov = await montarIndice({ anel: 'provider', capacidades: capsFuncoes(), embedder: emb });
  const rodar = async (cortes) => criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tool, { cortes }), obterEstadoDe: (a) => (a === 'provider' ? estadoDe(prov) : null) })(
    await entrada(emb, 'agenda', itens(), 'tool', ['agenda'], vetores));

  // corte base 0,20/0,10: as três passam o corte normal; só a exata (1,0 ≥ 0,70) é full entre as NÃO carregadas; a parcial cai a candidate
  const r = await rodar(baseCom(0.20, 0.10));
  assert.deepEqual(r.full, ['agenda/tool/listar', 'docs/tool/exata']); // `listar` é do turno (corte normal 0,20) e vem antes da capacidade nova
  assert.deepEqual(r.candidates, ['docs/tool/parcial']);
  assert.equal(r.explain['docs/tool/parcial'].reason, 'local:base (texto) (promocao)'); // rebaixa pelo D4a deixa rastro; a nota segue a que ela teve
  assert.equal(r.explain['docs/tool/parcial'].confidence, nParcial);
  assert.ok(!r.explain['docs/tool/exata'].reason.includes('promocao') && !r.explain['agenda/tool/listar'].reason.includes('promocao')); // quem não foi rebaixado fica sem sufixo

  // fronteira inclusiva: promocao == nota da exata ainda é full; um pouco acima, candidate
  const igual = await rodar(baseCom(0.20, 0.10, { promocao: nExata }));
  assert.ok(igual.full.includes('docs/tool/exata'));
  const acima = await rodar(baseCom(0.20, 0.10, { promocao: nExata + 1e-9 }));
  assert.ok(!acima.full.includes('docs/tool/exata'));
  assert.deepEqual(acima.candidates, ['docs/tool/exata', 'docs/tool/parcial']); // ordem pela nota
  // com a promoção em 0,2 a parcial (≈ 0,26) também vira full
  const baixa = await rodar(baseCom(0.20, 0.10, { promocao: 0.2 }));
  assert.deepEqual(baixa.full, ['agenda/tool/listar', 'docs/tool/exata', 'docs/tool/parcial']);
});

test('D4a (tool): promoverFull decide pelo estado do provider — "so-provider-na-base" com o provider na cabeça nunca promove; "sempre" promove; "nunca" não', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const prov = await montarIndice({ anel: 'provider', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const cortes = baseCom(0.20, 0.10);
  const itens = () => [item('docs/tool/exata', 0, 'discard'), item('docs/tool/parcial', 1, 'discard'), item('agenda/tool/listar', 2, 'candidate')];
  const provNaCabeca = estadoDe(prov, { cabeca: cabecaReal(prov) });
  const provNaBase = estadoDe(prov, { cabeca: cabecaReal(prov, { anelAprovado: false }) });
  const consultados = [];
  const rodar = async (promoverFull, estadoProvider) => criarRefinadorLocal({
    anel: 'tool',
    obterEstado: estado(tool, { cortes, funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull } }),
    obterEstadoDe: (a) => { consultados.push(a); return a === 'provider' ? estadoProvider : null; },
  })(await entrada(emb, 'agenda', itens(), 'tool', ['agenda'], vetores));

  const naBase = await rodar('so-provider-na-base', provNaBase);
  assert.deepEqual(naBase.full, ['agenda/tool/listar', 'docs/tool/exata']);
  const naCabeca = await rodar('so-provider-na-base', provNaCabeca);
  assert.deepEqual(naCabeca.full, ['agenda/tool/listar']); // só a de capacidade carregada
  assert.deepEqual(naCabeca.candidates, ['docs/tool/exata', 'docs/tool/parcial']);
  // provider DESCONHECIDO conta como cabeça: na dúvida, não promove (só o estado explícito sem cabeça libera)
  for (const [nome, desconhecido] of [['null', null], ['índice montando', { indice: null, motivo: 'indice-montando' }], ['undefined', undefined]]) {
    const r = await rodar('so-provider-na-base', desconhecido);
    assert.deepEqual(r.full, ['agenda/tool/listar'], nome);
    assert.deepEqual(r.candidates, ['docs/tool/exata', 'docs/tool/parcial'], nome);
    assert.equal(r.explain['docs/tool/exata'].reason, 'local:base (texto) (promocao)', nome);
  }
  // getter ausente e getter que lança: idem, e o anel NÃO degrada (as notas seguem sendo as da base do tool)
  const semGetter = await criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tool, { cortes }) })(await entrada(emb, 'agenda', itens(), 'tool', ['agenda'], vetores));
  assert.deepEqual(semGetter.full, ['agenda/tool/listar']);
  const lancando = await criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tool, { cortes }), obterEstadoDe: () => { throw new Error('boom'); } })(await entrada(emb, 'agenda', itens(), 'tool', ['agenda'], vetores));
  assert.deepEqual([lancando.full, lancando.candidates], [['agenda/tool/listar'], ['docs/tool/exata', 'docs/tool/parcial']]);
  assert.ok(Object.values(lancando.explain).every((x) => !x.reason.startsWith('local:degradado')));
  // `sempre` e `nunca` não dependem do estado do provider
  const semEstadoSempre = await rodar('sempre', null);
  assert.deepEqual(semEstadoSempre.full, ['agenda/tool/listar', 'docs/tool/exata']);
  const sempre = await rodar('sempre', provNaCabeca);
  assert.deepEqual(sempre.full, ['agenda/tool/listar', 'docs/tool/exata']);
  const nunca = await rodar('nunca', provNaBase);
  assert.deepEqual(nunca.full, ['agenda/tool/listar']);
  assert.ok(consultados.every((a) => a === 'provider'));
});

test('teto de promoção (tool): só as tetoProvider capacidades NÃO carregadas de maior nota mantêm funções em full; as excedentes viram candidate com " (teto-promocao)"; carregadas não contam nem são afetadas', async () => {
  // consulta q; as funções das capacidades a, b, c, l ficam próximas dela (notas decrescentes), x é só ruído
  const emb = embedderTabela({
    q: [1, 0, 0, 0], fa: [1, 0.02, 0, 0], fb: [1, 0.12, 0, 0], fc: [1, 0.22, 0, 0], fl: [1, 0.07, 0, 0],
    r1: [0, 1, 0, 0], r2: [0, 0, 1, 0], r3: [0, 0, 0, 1],
  });
  const capsBase = () => [
    { id: 'a', tools: [{ name: 'f', semanticText: 'fa' }] },
    { id: 'b', tools: [{ name: 'f', semanticText: 'fb' }] },
    { id: 'c', tools: [{ name: 'f', semanticText: 'fc' }] },
    { id: 'l', tools: [{ name: 'f', semanticText: 'fl' }] },
    { id: 'x', tools: [{ name: 'r1', semanticText: 'r1' }, { name: 'r2', semanticText: 'r2' }, { name: 'r3', semanticText: 'r3' }] },
  ];
  const tool = await montarIndice({ anel: 'tool', capacidades: capsBase(), embedder: emb });
  const vetores = [await emb.embed('q')];
  const q = consultaCentrada(tool, vetores);
  const nota = (ref) => pontuarNo(tool, q, ref).nota;
  assert.ok(nota('a/tool/f') > nota('b/tool/f') && nota('b/tool/f') > nota('c/tool/f') && nota('c/tool/f') >= CORTES_FIXOS.promocao, 'pré-condição: a > b > c ≥ 0,70');
  assert.ok(nota('l/tool/f') >= CORTES_FIXOS.promocao);

  // c vem PRIMEIRO na entrada (position 0): quem decide é a nota, não a posição. `l` é de capacidade carregada.
  const itens = () => [item('c/tool/f', 0, 'discard'), item('b/tool/f', 1, 'discard'), item('a/tool/f', 2, 'discard'), item('l/tool/f', 3, 'candidate')];
  const sempre = { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'sempre' };
  const rodar = async (opcoes = {}, tools = tool, itensDe = itens) => criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tools, { funcaoTraz: sempre, tetoProvider: 2, ...opcoes }) })(
    await entrada(emb, 'q', itensDe(), 'tool', ['l'], vetores));

  // tetoProvider 2 explícito: a e b mantêm full; c vira candidate; l (carregada) não conta e continua full
  const r = await rodar();
  assert.deepEqual(r.full, ['l/tool/f', 'a/tool/f', 'b/tool/f']); // a do turno (l, carregada) primeiro; entre as novas, pela nota
  assert.deepEqual(r.candidates, ['c/tool/f']);
  assert.equal(r.explain['c/tool/f'].reason, 'local:base (texto) (teto-promocao)');
  assert.equal(r.explain['c/tool/f'].confidence, nota('c/tool/f')); // a nota continua sendo a da função
  for (const ref of ['a/tool/f', 'b/tool/f', 'l/tool/f']) assert.ok(!r.explain[ref].reason.includes('teto-promocao'), ref);

  // controle: com tetoProvider 3 as três novas passam (e o teto de funções do anel, 4, ainda comporta)
  const tres = await rodar({ tetoProvider: 3 });
  assert.deepEqual(tres.full, ['l/tool/f', 'a/tool/f', 'b/tool/f', 'c/tool/f']);
  assert.ok(!tres.explain['c/tool/f'].reason.includes('teto-promocao'));
  // tetoProvider vem do estado: 1 → só a; 0 → nenhuma capacidade nova, só a carregada
  const um = await rodar({ tetoProvider: 1 });
  assert.deepEqual([um.full, um.candidates], [['l/tool/f', 'a/tool/f'], ['b/tool/f', 'c/tool/f']]);
  assert.match(um.explain['b/tool/f'].reason, /\(teto-promocao\)$/);
  assert.match(um.explain['c/tool/f'].reason, /\(teto-promocao\)$/);
  const zero = await rodar({ tetoProvider: 0 });
  assert.deepEqual([zero.full, zero.candidates], [['l/tool/f'], ['a/tool/f', 'b/tool/f', 'c/tool/f']]);
  // valor inválido (ou ausente) no estado = SEM teto de promoção (padrão): as três novas passam
  for (const sem of [-1, 1.5, null, undefined]) {
    const lixo = await rodar({ tetoProvider: sem });
    assert.deepEqual(lixo.full, tres.full, String(sem));
    assert.ok(Object.values(lixo.explain).every((x) => !x.reason.includes('teto-promocao')));
  }

  // o teto é por CAPACIDADE, não por função: duas funções de `a` ocupam uma só vaga
  const capsDuas = capsBase();
  capsDuas[0] = { id: 'a', tools: [{ name: 'f', semanticText: 'fa' }, { name: 'g', semanticText: 'fa' }] };
  const toolDuas = await montarIndice({ anel: 'tool', capacidades: capsDuas, embedder: emb });
  assert.ok(pontuarNo(toolDuas, consultaCentrada(toolDuas, vetores), 'c/tool/f').nota >= CORTES_FIXOS.promocao, 'pré-condição: c segue ≥ 0,70');
  const duas = await rodar({}, toolDuas, () => [...itens(), item('a/tool/g', 4, 'discard')]);
  assert.deepEqual(duas.full.sort(), ['a/tool/f', 'a/tool/g', 'b/tool/f', 'l/tool/f']);
  assert.deepEqual(duas.candidates, ['c/tool/f']);

  // quem já foi para candidate pelo D4a (promoverFull 'nunca') não recebe o sufixo: o teto só rebaixa o que seria full
  const nunca = await rodar({ funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'nunca' } });
  assert.deepEqual(nunca.full, ['l/tool/f']);
  assert.ok(['a/tool/f', 'b/tool/f', 'c/tool/f'].every((ref) => !nunca.explain[ref].reason.includes('teto-promocao')));
});

test('carregada NO TURNO (tool): capacidade fora de loadedProviders mas com item de proposedTier ≠ discard usa o corte normal, não o da promoção; pinned não conta', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const nParcial = pontuarNo(tool, consultaCentrada(tool, vetores), 'docs/tool/parcial').nota;
  const cortes = baseCom(0.20, 0.10); // normal 0,20; promoção 0,70
  assert.ok(nParcial >= 0.20 && nParcial < CORTES_FIXOS.promocao, `pré-condição: ${nParcial} entre o corte normal e a promoção`);
  const rodar = async (itens, loaded = []) => criarRefinadorLocal({ anel: 'tool', obterEstado: estado(tool, { cortes }) })(await entrada(emb, 'agenda', itens, 'tool', loaded, vetores));

  // docs NÃO está em loadedProviders, mas o provider acabou de trazê-la neste turno: o kairos entrega a função como `candidate`
  const noTurno = await rodar([item('docs/tool/parcial', 0, 'candidate')]);
  assert.deepEqual([noTurno.full, noTurno.candidates], [['docs/tool/parcial'], []]);
  assert.ok(!noTurno.explain['docs/tool/parcial'].reason.includes('promocao'));
  // o mesmo item como `discard` (capacidade fora do turno) cai a candidate pelo D4a, com rastro
  const fora = await rodar([item('docs/tool/parcial', 0, 'discard')]);
  assert.deepEqual([fora.full, fora.candidates], [[], ['docs/tool/parcial']]);
  assert.equal(fora.explain['docs/tool/parcial'].reason, 'local:base (texto) (promocao)');
  // basta UMA função da capacidade vir fora de `discard` para a capacidade inteira ser do turno
  const irma = await rodar([item('docs/tool/outra', 0, 'candidate'), item('docs/tool/parcial', 1, 'discard')]);
  assert.ok(irma.full.includes('docs/tool/parcial'));
  // pinned é `full` em qualquer capacidade candidata: NÃO prova que a capacidade está no turno
  const pinned = await rodar([item('docs/tool/outra', 0, 'full', { pinned: true }), item('docs/tool/parcial', 1, 'discard')]);
  assert.deepEqual(pinned.full, ['docs/tool/outra']); // só o fixo; a parcial segue como capacidade nova
  assert.deepEqual(pinned.candidates, ['docs/tool/parcial']);
  // em loadedProviders continua valendo, como antes
  const carregada = await rodar([item('docs/tool/parcial', 0, 'discard')], ['docs']);
  assert.deepEqual(carregada.full, ['docs/tool/parcial']);
});

test('teto de promoção: duas capacidades do turno com função full proposta pelo motor ficam como estão; a de fora só entra se houver vaga (teto de capacidades novas e teto de funções)', async () => {
  const emb = embedderTabela({
    q: [1, 0, 0, 0], fa: [1, 0.02, 0, 0], fb: [1, 0.12, 0, 0], fc: [1, 0.22, 0, 0], fl: [1, 0.07, 0, 0],
    r1: [0, 1, 0, 0], r2: [0, 0, 1, 0], r3: [0, 0, 0, 1],
  });
  const capacidades = [
    { id: 'a', tools: [{ name: 'f', semanticText: 'fa' }] },
    { id: 'b', tools: [{ name: 'f', semanticText: 'fb' }] },
    { id: 'c', tools: [{ name: 'f', semanticText: 'fc' }] },
    { id: 'l', tools: [{ name: 'f', semanticText: 'fl' }] },
    { id: 'x', tools: [{ name: 'r1', semanticText: 'r1' }, { name: 'r2', semanticText: 'r2' }, { name: 'r3', semanticText: 'r3' }] },
  ];
  const tool = await montarIndice({ anel: 'tool', capacidades, embedder: emb });
  const vetores = [await emb.embed('q')];
  const q = consultaCentrada(tool, vetores);
  for (const ref of ['a', 'b', 'c', 'l']) assert.ok(pontuarNo(tool, q, `${ref}/tool/f`).nota >= CORTES_FIXOS.promocao, ref);
  const sempre = { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'sempre' };
  // a e b: capacidades do turno (o motor propôs full), mas loadedProviders está vazio; c é a de fora
  const itens = (extra = []) => [item('c/tool/f', 0, 'discard'), item('a/tool/f', 1, 'full'), item('b/tool/f', 2, 'full'), ...extra];
  const rodar = async (opcoes = {}, extra = [], tetoFull) => criarRefinadorLocal({ anel: 'tool', tetoFull: tetoFull ?? 4, obterEstado: estado(tool, { funcaoTraz: sempre, tetoProvider: 2, ...opcoes }) })(
    await entrada(emb, 'q', itens(extra), 'tool', [], vetores));

  // as do turno não gastam o teto de capacidades novas: c, sozinha, entra (3 funções ≤ teto 4 do anel)
  const r = await rodar();
  assert.deepEqual(r.full, ['a/tool/f', 'b/tool/f', 'c/tool/f']);
  assert.ok(Object.values(r.explain).every((x) => !x.reason.includes('promocao')));
  // sem vaga para capacidade nova (tetoProvider 0): c cai a candidate com o sufixo; a e b NÃO são tocadas
  const sem = await rodar({ tetoProvider: 0 });
  assert.deepEqual([sem.full, sem.candidates], [['a/tool/f', 'b/tool/f'], ['c/tool/f']]);
  assert.equal(sem.explain['c/tool/f'].reason, 'local:base (texto) (teto-promocao)');
  assert.ok(!sem.explain['a/tool/f'].reason.includes('promocao') && !sem.explain['b/tool/f'].reason.includes('promocao'));
  // duas de fora (c e l) disputam: com tetoProvider 1 fica a de maior nota (l); as do turno seguem intactas
  const uma = await rodar({ tetoProvider: 1 }, [item('l/tool/f', 3, 'discard')]);
  assert.deepEqual(uma.full, ['a/tool/f', 'b/tool/f', 'l/tool/f']);
  assert.deepEqual(uma.candidates, ['c/tool/f']);
  assert.match(uma.explain['c/tool/f'].reason, /\(teto-promocao\)$/);
  // com o teto padrão (2) as duas de fora entram — e o teto de FUNÇÕES do anel (4) comporta a, b, c, l
  const duas = await rodar({}, [item('l/tool/f', 3, 'discard')]);
  assert.deepEqual([...duas.full].sort(), ['a/tool/f', 'b/tool/f', 'c/tool/f', 'l/tool/f']);
  assert.deepEqual(duas.candidates, []);
});

// Fixture das vagas de full do anel tool: b e c são capacidades do turno (o motor propôs full); a e l são de fora e têm notas MAIS ALTAS.
async function fixtureVagas() {
  const emb = embedderTabela({
    q: [1, 0, 0, 0], fa: [1, 0.02, 0, 0], fb: [1, 0.12, 0, 0], fc: [1, 0.22, 0, 0], fl: [1, 0.07, 0, 0],
    r1: [0, 1, 0, 0], r2: [0, 0, 1, 0], r3: [0, 0, 0, 1],
  });
  const capacidades = ['a', 'b', 'c', 'l'].map((id) => ({ id, tools: [{ name: 'f', semanticText: `f${id}` }] }))
    .concat([{ id: 'x', tools: [{ name: 'r1', semanticText: 'r1' }, { name: 'r2', semanticText: 'r2' }, { name: 'r3', semanticText: 'r3' }] }]);
  const tool = await montarIndice({ anel: 'tool', capacidades, embedder: emb });
  const vetores = [await emb.embed('q')];
  const q = consultaCentrada(tool, vetores);
  const nota = (c) => pontuarNo(tool, q, `${c}/tool/f`).nota;
  assert.ok(nota('a') > nota('l') && nota('l') > nota('b') && nota('b') > nota('c') && nota('c') >= CORTES_FIXOS.promocao, 'pré-condição: a > l > b > c ≥ 0,70');
  const rodar = async ({ tetoFull, itens, opcoes = {}, loaded = [] }) => criarRefinadorLocal({
    anel: 'tool', tetoFull, obterEstado: estado(tool, { funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'sempre' }, ...opcoes }),
  })(await entrada(emb, 'q', itens, 'tool', loaded, vetores));
  return { rodar };
}

test('vagas de full do anel tool com tetoFull apertado: as funções do TURNO vêm antes das de capacidade nova; a nova só usa a sobra; dentro de cada grupo, pela nota', async () => {
  const { rodar } = await fixtureVagas();
  const item = (ref, position, proposedTier) => ({ ref, position, scores: { final: 0.5 }, proposedTier, meta: {} });
  // a e l entram PRIMEIRO na lista e têm as maiores notas, mas b e c são do turno
  const itens = () => [item('a/tool/f', 0, 'discard'), item('l/tool/f', 1, 'discard'), item('c/tool/f', 2, 'full'), item('b/tool/f', 3, 'full')];
  const com = async (tetoFull, opcoes) => rodar({ tetoFull, itens: itens(), opcoes });

  const quatro = await com(4);
  assert.deepEqual(quatro.full, ['b/tool/f', 'c/tool/f', 'a/tool/f', 'l/tool/f']); // turno (b > c pela nota), depois as novas (a > l)
  assert.deepEqual(quatro.candidates, []);
  const tres = await com(3);
  assert.deepEqual([tres.full, tres.candidates], [['b/tool/f', 'c/tool/f', 'a/tool/f'], ['l/tool/f']]);
  const dois = await com(2); // a sonda dos revisores: antes, a e l (notas altas) empurravam b e c para fora do prompt
  assert.deepEqual([dois.full, dois.candidates], [['b/tool/f', 'c/tool/f'], ['a/tool/f', 'l/tool/f']]);
  assert.ok(Object.values(dois.explain).every((x) => !x.reason.includes('promocao')), 'a perda da vaga por teto de funções não é rebaixa de promoção');
  const um = await com(1); // dentro do grupo do turno vale a nota: b antes de c
  assert.deepEqual([um.full, um.candidates], [['b/tool/f'], ['c/tool/f', 'a/tool/f', 'l/tool/f']]);
  // o teto de capacidades novas continua valendo por cima: tetoProvider 0 + tetoFull 2 → mesma saída, agora com o sufixo nas novas
  const semNovas = await rodar({ tetoFull: 2, itens: itens(), opcoes: { tetoProvider: 0 } });
  assert.deepEqual([semNovas.full, semNovas.candidates], [['b/tool/f', 'c/tool/f'], ['a/tool/f', 'l/tool/f']]);
  assert.match(semNovas.explain['a/tool/f'].reason, /\(teto-promocao\)$/);
  assert.ok(!semNovas.explain['b/tool/f'].reason.includes('promocao'));
  // "do turno" também vale por loadedProviders ou por proposta `candidate` (corte normal): mesma prioridade sobre a nova
  const carregada = await rodar({ tetoFull: 1, itens: [item('a/tool/f', 0, 'discard'), item('b/tool/f', 1, 'discard')], loaded: ['b'] });
  assert.deepEqual([carregada.full, carregada.candidates], [['b/tool/f'], ['a/tool/f']]);
  const candidata = await rodar({ tetoFull: 1, itens: [item('a/tool/f', 0, 'discard'), item('c/tool/f', 1, 'candidate')] });
  assert.deepEqual([candidata.full, candidata.candidates], [['c/tool/f'], ['a/tool/f']]);
});

test('state.loadedProviders que não é array (string, objeto, null) é ignorado — não vira um Set de caracteres', async () => {
  const { rodar } = await fixtureVagas();
  const item = (ref, position, proposedTier) => ({ ref, position, scores: { final: 0.5 }, proposedTier, meta: {} });
  const itens = () => ['a', 'b', 'c', 'l'].map((c, i) => item(`${c}/tool/f`, i, 'discard'));
  const base = await rodar({ tetoFull: 4, itens: itens(), opcoes: { tetoProvider: 2 } }); // nenhuma carregada: só as 2 novas de maior nota (a, l) ficam em full
  assert.deepEqual(base.full, ['a/tool/f', 'l/tool/f']);
  // 'abc' como string viraria {a, b, c} (ids de uma letra): as três contariam como carregadas e entrariam em full
  for (const lixo of ['abc', { a: 1, b: 1, c: 1 }, null, 7]) {
    const r = await rodar({ tetoFull: 4, itens: itens(), loaded: lixo, opcoes: { tetoProvider: 2 } });
    assert.deepEqual(r.full, base.full, JSON.stringify(lixo));
  }
});

test('D5: vale o MAIOR nível entre cabeça e base — cabeça candidate + base ≥ base.full dá full (via base, depois dos da cabeça); sem poucos casos ou com base abaixo do full, fica candidate', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const q = consultaCentrada(indice, vetores);
  const itens = () => [item('tarefas', 0, 'discard'), item('agenda', 1, 'discard')];
  // cabeça: full 0,6 / candidate 0,15 → agenda (≈ 0,95) full, tarefas (≈ 0,37) candidate. Base: full 0,25 → tarefas (≈ 0,29) é full na base.
  const cortes = cortesEm({ cabeca: { full: 0.6, candidate: 0.15 }, base: { full: 0.25, candidate: 0.2 } });
  const rodar = async (n, opcoes = {}) => {
    const cab = cabecaReal(indice, { nTreinoPorCapacidade: n });
    return { cab, r: await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab, cortes, minCasosCapacidade: 50, ...opcoes }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores)) };
  };
  const { cab, r } = await rodar({});
  const cabTarefas = Math.max(...q.map((s) => pontuarCabeca(cab.cabeca, s, indice.nos.get('tarefas').centroide)));
  assert.ok(cabTarefas >= 0.15 && cabTarefas < 0.6, `pré-condição: cabeça de tarefas ${cabTarefas} é candidate`);
  const baseTarefas = pontuarNo(indice, q, 'tarefas').nota;
  assert.ok(baseTarefas >= 0.25, `pré-condição: base de tarefas ${baseTarefas} ≥ 0,25`);
  assert.deepEqual(r.full, ['agenda', 'tarefas']); // agenda pela cabeça; tarefas SOBE de candidate a full pela base, depois dela
  assert.equal(r.explain.agenda.reason, 'local:cabeca');
  assert.equal(r.explain.tarefas.reason, 'local:base (texto)');
  assert.equal(r.explain.tarefas.confidence, baseTarefas);
  // a vaga é de quem veio pelo caminho do anel: com teto 1, tarefas fica como candidate
  const um = await criarRefinadorLocal({ anel: 'provider', tetoFull: 1, obterEstado: estado(indice, { cabeca: cab, cortes, minCasosCapacidade: 50 }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  assert.deepEqual([um.full, um.candidates], [['agenda'], ['tarefas']]);
  // casos suficientes (80 ≥ 50): a D5 não vale, fica o candidate da cabeça
  const muitos = await rodar({ tarefas: 80 });
  assert.deepEqual([muitos.r.full, muitos.r.candidates], [['agenda'], ['tarefas']]);
  assert.equal(muitos.r.explain.tarefas.reason, 'local:cabeca');
  // base abaixo do full (0,5): não sobe; fica candidate pela cabeça
  const baixa = await rodar({}, { cortes: cortesEm({ cabeca: { full: 0.6, candidate: 0.15 }, base: { full: 0.5, candidate: 0.2 } }) });
  assert.deepEqual([baixa.r.full, baixa.r.candidates], [['agenda'], ['tarefas']]);
  assert.equal(baixa.r.explain.tarefas.reason, 'local:cabeca');
});

test('D6 (provider, cabeça): carrega sozinha só com nota ≥ comKairos.full; entre o mínimo e ali, só com o Kairos propondo full; senão candidate; null desliga', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const q = consultaCentrada(indice, vetores);
  const cab = cabecaReal(indice);
  const notaCab = (ref) => Math.max(...q.map((s) => pontuarCabeca(cab.cabeca, s, indice.nos.get(ref).centroide)));
  assert.ok(notaCab('agenda') >= 0.6, `pré-condição: agenda ${notaCab('agenda')} ≥ 0,60`);
  assert.ok(notaCab('tarefas') >= 0.3 && notaCab('tarefas') < 0.6, `pré-condição: tarefas ${notaCab('tarefas')} entre 0,30 e 0,60`);
  const rodar = async (comKairos, tierTarefas) => criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cab, cortes: cortesEm({ comKairos }) }) })(
    await entrada(emb, 'agenda', [item('tarefas', 0, tierTarefas), item('agenda', 1, 'discard')], 'provider', [], vetores));
  const regra = { full: 0.6, minimo: 0.15 };
  // sem o aval do Kairos: o par cabeca (0,30) daria full, a D6 deixa candidate; agenda passa sozinha
  const semAval = await rodar(regra, 'candidate');
  assert.deepEqual([semAval.full, semAval.candidates], [['agenda'], ['tarefas']]);
  assert.equal(semAval.explain.tarefas.reason, 'local:cabeca');
  assert.equal(semAval.explain.agenda.reason, 'local:cabeca');
  // as duas notas vão ao explain (10/10): a da cabeça e a da base do mesmo item
  assert.equal(semAval.explain.tarefas.notaCabeca, notaCab('tarefas'));
  assert.equal(semAval.explain.tarefas.notaBase, pontuarNo(indice, q, 'tarefas').nota);
  // com o Kairos propondo full: carrega, e o reason diz por quê
  const comAval = await rodar(regra, 'full');
  assert.deepEqual(comAval.full.sort(), ['agenda', 'tarefas']);
  assert.equal(comAval.explain.tarefas.reason, 'local:cabeca (com-kairos)');
  // mínimo acima da nota: nem o aval do Kairos carrega
  const minimoAlto = await rodar({ full: 0.6, minimo: 0.5 }, 'full');
  assert.deepEqual([minimoAlto.full, minimoAlto.candidates], [['agenda'], ['tarefas']]);
  // null desliga: volta o par cabeca puro (tarefas ≥ 0,30 é full mesmo sem o Kairos)
  const desligada = await rodar(null, 'candidate');
  assert.deepEqual(desligada.full.sort(), ['agenda', 'tarefas']);
});

test('D5 no degrau candidate (dono, 09/10): capacidade não treinada com cabeça discard + base candidate fica candidate — a cabeça não rebaixa a base', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const itens = () => [item('tarefas', 0, 'discard'), item('agenda', 1, 'discard')];
  // cabeça: candidate 0,5 → tarefas (≈ 0,37) é discard pela cabeça. Base: candidate 0,2 / full 0,5 → tarefas (≈ 0,29) é candidate na base.
  const cortes = cortesEm({ cabeca: { full: 0.6, candidate: 0.5 }, base: { full: 0.5, candidate: 0.2 } });
  const rodar = async (n) => criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: cabecaReal(indice, { nTreinoPorCapacidade: n }), cortes, minCasosCapacidade: 50 }) })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  const r = await rodar({});
  assert.deepEqual([r.full, r.candidates], [['agenda'], ['tarefas']]);
  assert.equal(r.explain.tarefas.reason, 'local:base (texto)');
  // treinada (80 ≥ 50): vale só a cabeça, e ela descarta
  const treinada = await rodar({ tarefas: 80 });
  assert.deepEqual([treinada.full, treinada.candidates], [['agenda'], []]);
});

test('funcaoTraz parcial no estado (só {ativo:true}) completa com o padrão; {ativo:false} desliga; ausente = padrão', async () => {
  const emb = embedderFalso();
  const prov = await montarIndice({ anel: 'provider', capacidades: capsFuncoes(), embedder: emb });
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const itens = () => [item('docs', 0, 'discard'), item('agenda', 1, 'discard'), item('notas', 2, 'discard')];
  const rodar = async (funcaoTraz) => criarRefinadorLocal({ anel: 'provider', obterEstado: () => ({ ...estadoDe(prov), funcaoTraz }), obterEstadoDe: (a) => (a === 'tool' ? estadoDe(tool) : null) })(
    await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  for (const ft of [{ ativo: true }, {}, undefined, null, { n: 3 }]) {
    const r = await rodar(ft);
    assert.ok(r.candidates.includes('docs'), JSON.stringify(ft)); // n e candidata vêm do padrão (5 / 0,40): antes `candidata` undefined nunca promovia
    assert.match(r.explain.docs.reason, /^local:funcao-trouxe \(docs\/tool\/exata /);
  }
  const off = await rodar({ ativo: false });
  assert.ok(!off.candidates.includes('docs'));
});

test('refinar(undefined), refinar(null) e entrada sem items/proposal não lançam — devolvem vazio', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  for (const obterEstado of [estado(indice), () => ({ indice: null, motivo: 'x' }), () => { throw new Error('boom'); }]) {
    const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado });
    for (const entradaRuim of [undefined, null, {}]) {
      const r = await refinar(entradaRuim);
      assert.deepEqual([r.full, r.candidates, r.explain], [[], [], {}]);
    }
  }
});

test('D4a preguiçoso (tool): o estado do provider só é consultado quando um item precisa — função de capacidade fora do turno que chega a full com "so-provider-na-base" —, no máximo uma vez por refine', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const prov = await montarIndice({ anel: 'provider', capacidades: capsFuncoes(), embedder: emb });
  const provNaBase = estadoDe(prov, { cabeca: cabecaReal(prov, { anelAprovado: false }) });
  const cortes = baseCom(0.20, 0.10);
  const itens = () => [item('docs/tool/exata', 0, 'discard'), item('docs/tool/parcial', 1, 'discard'), item('agenda/tool/listar', 2, 'candidate')];
  const rodar = async ({ query = 'agenda', loaded = ['agenda'], promoverFull = 'so-provider-na-base', itensDe = itens } = {}) => {
    const consultados = [];
    const r = await criarRefinadorLocal({
      anel: 'tool',
      obterEstado: estado(tool, { cortes, funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull } }),
      obterEstadoDe: (a) => { consultados.push(a); return provNaBase; },
    })(await entrada(emb, query, itensDe(), 'tool', loaded, [await emb.embed(query)]));
    return { r, consultados };
  };
  // (1) precisa: a exata (nota 1,0) é de capacidade fora do turno e chega a full → UMA consulta (mesmo com duas funções de capacidade nova)
  const precisa = await rodar();
  assert.deepEqual(precisa.consultados, ['provider']);
  assert.ok(precisa.r.full.includes('docs/tool/exata'), 'o estado consultado (base) libera a promoção');
  // (2) todas as funções são de capacidade do turno (carregada, ou com item do motor fora de discard) → nenhuma consulta
  assert.deepEqual((await rodar({ loaded: ['agenda', 'docs'] })).consultados, []);
  assert.deepEqual((await rodar({ itensDe: () => [item('docs/tool/exata', 0, 'candidate'), item('agenda/tool/listar', 1, 'candidate')] })).consultados, [], 'item do motor fora de discard torna a capacidade "do turno"');
  // (3) função de capacidade nova que NÃO chega a full (abaixo do corte) → nenhuma consulta: nada a decidir
  const semFull = await rodar({ query: 'nota', itensDe: () => [item('docs/tool/exata', 0, 'discard'), item('agenda/tool/listar', 1, 'candidate')] });
  assert.deepEqual(semFull.consultados, []);
  assert.ok(!semFull.r.full.includes('docs/tool/exata'));
  // (4) "sempre" e "nunca" decidem sem olhar o provider
  assert.deepEqual((await rodar({ promoverFull: 'sempre' })).consultados, []);
  assert.deepEqual((await rodar({ promoverFull: 'nunca' })).consultados, []);
  // (5) o anel provider não consulta o getter do provider (e o D4b segue consultando o do tool)
  const consultadosP = [];
  await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(prov, { cortes }), obterEstadoDe: (a) => { consultadosP.push(a); return null; } })(await entrada(emb, 'agenda', [item('agenda', 0, 'discard')], 'provider', [], [await emb.embed('agenda')]));
  assert.deepEqual(consultadosP, ['tool']);
});

test('D4b (provider): das n melhores descartadas, função ≥ funcaoTraz.candidata (pontuada com o estado do anel TOOL) sobe a capacidade a candidate, dentro de caps.hard.maxCandidates; explain nomeia a função', async () => {
  const emb = embedderFalso();
  const caps = capsFuncoes();
  const prov = await montarIndice({ anel: 'provider', capacidades: caps, embedder: emb });
  const tool = await montarIndice({ anel: 'tool', capacidades: caps, embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const chamadas = [];
  const getter = (a) => { chamadas.push(a); return a === 'tool' ? estadoDe(tool) : null; };
  const itens = () => [item('docs', 0, 'discard'), item('agenda', 1, 'discard'), item('tarefas', 2, 'discard'), item('notas', 3, 'discard'), item('busca', 4, 'discard')];
  const cortes = baseCom(0.5, 0.25); // tarefas (base ≈ 0,39) fica entre os dois cortes: candidate pela nota própria
  const rodar = async (opcoes = {}, ajusta = null, g = getter) => {
    const inp = await entrada(emb, 'agenda', itens(), 'provider', [], vetores);
    if (ajusta) ajusta(inp);
    return criarRefinadorLocal({ anel: 'provider', obterEstado: estado(prov, { cortes, ...opcoes }), obterEstadoDe: g })(inp);
  };

  const r = await rodar();
  assert.deepEqual(chamadas, ['tool']);
  // nota própria: agenda full (1,0), tarefas candidate (entre 0,25 e 0,5), docs/notas/busca descartadas
  assert.deepEqual(r.full, ['agenda']);
  assert.match(r.explain.tarefas.reason, /^local:base/);
  assert.ok(r.explain.tarefas.confidence >= 0.25 && r.explain.tarefas.confidence < 0.5);
  assert.ok(r.explain.docs.confidence < 0.25);
  // docs sobe a candidate pela função exata (1,000), depois de tarefas (ordem pela nota própria)
  assert.deepEqual(r.candidates, ['tarefas', 'docs']);
  assert.equal(r.explain.docs.reason, 'local:funcao-trouxe (docs/tool/exata 1.000)');
  assert.equal(r.explain.docs.casou, 'funcao');
  // a função que trouxe a capacidade e a nota dela vão no explain (o reason só mostra 3 casas); a confidence segue sendo a da capacidade
  assert.equal(r.explain.docs.funcao.ref, 'docs/tool/exata');
  assert.equal(r.explain.docs.funcao.nota.toFixed(3), '1.000');
  assert.equal(r.explain.docs.funcao.nota, pontuarNo(tool, consultaCentrada(tool, vetores), 'docs/tool/exata').nota, 'nota crua, sem arredondar');
  assert.equal(r.explain.tarefas.funcao, undefined, 'só a capacidade trazida por função leva o campo');
  assert.equal(r.explain.docs.confidence, pontuarNo(prov, consultaCentrada(prov, vetores), 'docs').nota); // a confiança segue sendo a da capacidade
  // as outras descartadas não têm função forte: ficam fora, com a explicação de sempre
  assert.match(r.explain.notas.reason, /^local:base/);
  assert.ok(!r.candidates.includes('notas') && !r.candidates.includes('busca'));

  // a nota da função usa a consulta centrada pela média do índice TOOL (cada anel tem a sua)
  const certa = pontuarNo(tool, consultaCentrada(tool, vetores), 'docs/tool/exata').nota;
  const errada = pontuarNo(tool, consultaCentrada(prov, vetores), 'docs/tool/exata').nota;
  assert.equal(certa.toFixed(3), '1.000');
  assert.notEqual(errada.toFixed(3), certa.toFixed(3), 'pré-condição: centrar pelo índice errado muda a nota');

  // caps.hard.maxCandidates: o corte pela cauda tira a trazida pela função primeiro
  const um = await rodar({}, (inp) => { inp.caps.hard.maxCandidates = 1; });
  assert.deepEqual(um.candidates, ['tarefas']);
  const zero = await rodar({}, (inp) => { inp.caps.hard.maxCandidates = 0; });
  assert.deepEqual([zero.full, zero.candidates], [['agenda'], []]);
});

test('D4b: respeita n (as n melhores descartadas), a nota mínima da função e o estado do anel tool (cabeça ou base)', async () => {
  const emb = embedderFalso();
  const caps = capsFuncoes();
  const capsDois = capsFuncoes();
  capsDois[3] = { id: 'notas', semanticText: 'nota', tools: [{ name: 'forte', semanticText: 'agenda' }] }; // notas também tem função forte
  const prov = await montarIndice({ anel: 'provider', capacidades: caps, embedder: emb });
  const toolDois = await montarIndice({ anel: 'tool', capacidades: capsDois, embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const itens = () => [item('docs', 0, 'discard'), item('agenda', 1, 'discard'), item('notas', 2, 'discard'), item('busca', 3, 'discard')];
  const rodar = async (funcaoTraz, toolIdx, estadoTool = {}) => criarRefinadorLocal({
    anel: 'provider',
    obterEstado: estado(prov, { funcaoTraz }),
    obterEstadoDe: (a) => (a === 'tool' ? estadoDe(toolIdx, estadoTool) : null),
  })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));

  // n=5: docs e notas (ambas descartadas, ambas com função exata) sobem
  const todas = await rodar({ ...FUNCAO_TRAZ_PADRAO, n: 5 }, toolDois);
  assert.ok(todas.explain.docs.confidence > todas.explain.notas.confidence, 'pré-condição: docs pontua acima de notas');
  assert.deepEqual(todas.candidates, ['docs', 'notas']); // pela nota própria
  assert.match(todas.explain.notas.reason, /^local:funcao-trouxe \(notas\/tool\/forte /);
  // n=1: só a MELHOR descartada (docs) é examinada
  const uma = await rodar({ ...FUNCAO_TRAZ_PADRAO, n: 1 }, toolDois);
  assert.deepEqual(uma.candidates, ['docs']);
  assert.match(uma.explain.notas.reason, /^local:base/);

  // função abaixo de `candidata` (0,40) não traz: a única função de docs fala de outro assunto
  const toolFraco = await montarIndice({ anel: 'tool', capacidades: capsFuncoes([{ name: 'fraca', semanticText: 'nota' }]), embedder: emb });
  const nFraca = pontuarNo(toolFraco, consultaCentrada(toolFraco, vetores), 'docs/tool/fraca').nota;
  assert.ok(nFraca < FUNCAO_TRAZ_PADRAO.candidata, `pré-condição: função fraca ${nFraca} < 0,40`);
  const fraca = await rodar({ ...FUNCAO_TRAZ_PADRAO }, toolFraco);
  assert.deepEqual(fraca.candidates, []);
  assert.match(fraca.explain.docs.reason, /^local:base/);
  // fronteira do limiar, nos dois lados: nota == candidata traz (inclusivo); um pouco acima, não
  // (o limiar baixo deixa outras capacidades de funções igualmente fracas entrarem também; o que importa aqui é a docs)
  const noLimiar = await rodar({ ...FUNCAO_TRAZ_PADRAO, candidata: nFraca }, toolFraco);
  assert.ok(noLimiar.candidates.includes('docs'));
  assert.equal(noLimiar.explain.docs.reason, `local:funcao-trouxe (docs/tool/fraca ${nFraca.toFixed(3)})`);
  const acimaDoLimiar = await rodar({ ...FUNCAO_TRAZ_PADRAO, candidata: nFraca + 1e-9 }, toolFraco);
  assert.ok(!acimaDoLimiar.candidates.includes('docs'));
  assert.match(acimaDoLimiar.explain.docs.reason, /^local:base/);

  // o anel tool na CABEÇA: a nota da função é a da cabeça (centroide do nó, consulta centrada pelo índice tool)
  const cabTool = cabecaReal(toolDois);
  const naCabeca = await rodar({ ...FUNCAO_TRAZ_PADRAO, n: 1 }, toolDois, { cabeca: cabTool });
  const sTool = consultaCentrada(toolDois, vetores);
  const notaCabeca = Math.max(...sTool.map((x) => pontuarCabeca(cabTool.cabeca, x, toolDois.nos.get('docs/tool/exata').centroide)));
  assert.equal(naCabeca.explain.docs.reason, `local:funcao-trouxe (docs/tool/exata ${notaCabeca.toFixed(3)})`);
  assert.notEqual(notaCabeca.toFixed(3), '1.000', 'pré-condição: a nota da cabeça difere da base');
});

test('D4b desligado (ativo:false), sem obterEstadoDe, ou sem estado/índice do anel tool → nada muda', async () => {
  const emb = embedderFalso();
  const caps = capsFuncoes();
  const prov = await montarIndice({ anel: 'provider', capacidades: caps, embedder: emb });
  const tool = await montarIndice({ anel: 'tool', capacidades: caps, embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const itens = () => [item('docs', 0, 'discard'), item('agenda', 1, 'discard'), item('tarefas', 2, 'discard')];
  const chamadas = [];
  const cortes = baseCom(0.5, 0.25); // tarefas (base ≈ 0,39) é candidate pela nota própria
  const sem = async (opcoes, getter) => criarRefinadorLocal({ anel: 'provider', obterEstado: estado(prov, { cortes, ...opcoes }), obterEstadoDe: getter })(await entrada(emb, 'agenda', itens(), 'provider', [], vetores));
  const esperado = (r) => { assert.deepEqual([r.full, r.candidates], [['agenda'], ['tarefas']]); assert.match(r.explain.docs.reason, /^local:base/); };

  esperado(await sem({ funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, ativo: false } }, (a) => { chamadas.push(a); return estadoDe(tool); }));
  assert.deepEqual(chamadas, []); // desligado nem consulta o outro anel
  esperado(await sem({}, null));
  esperado(await sem({}, () => null));
  esperado(await sem({}, () => ({ indice: null, motivo: 'indice-montando' })));
  esperado(await sem({}, () => { throw new Error('boom'); })); // getter que lança: D4b desligado, o anel NÃO degrada
  // controle: ligado de verdade, a mesma entrada muda
  const ligado = await sem({}, () => estadoDe(tool));
  assert.ok(ligado.candidates.includes('docs'));
});

test('tool: não rebaixa e não mexe em pinned', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'tool', capacidades: capsFalsas(), embedder: emb });
  const refinar = criarRefinadorLocal({ anel: 'tool', obterEstado: estado(indice, { cortes: baseCom(0.99, 0.98) }) });
  const r = await refinar(await entrada(emb, 'xyz', [item('tarefas/tool/task_listar', 0, 'candidate'), item('google-calendar/tool/gcal_listar_eventos', 1, 'full', { pinned: true })], 'tool'));
  assert.deepEqual(r.candidates, ['tarefas/tool/task_listar']);
  assert.deepEqual(r.full, ['google-calendar/tool/gcal_listar_eventos']);
});

test('pinned proposto candidate não é promovido mesmo com nota alta', async () => {
  const emb = embedderFalso();
  const capsTool = [{ id: 'x', tools: [{ name: 'a', semanticText: 'agenda' }, { name: 'c', semanticText: 'tarefa' }] }];
  const indice = await montarIndice({ anel: 'tool', capacidades: capsTool, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nota = pontuarNo(indice, q, 'x/tool/a').nota;
  const refinar = criarRefinadorLocal({ anel: 'tool', obterEstado: estado(indice, { cortes: baseCom(nota - 0.01, nota - 0.5) }) });
  const r = await refinar(await entrada(emb, 'agenda', [item('x/tool/a', 0, 'candidate', { pinned: true })], 'tool'));
  assert.deepEqual([r.full, r.candidates], [[], ['x/tool/a']]);
  assert.equal(r.explain['x/tool/a'], undefined);
});

test('itens fixos ficam por ÚLTIMO na saída e NÃO consomem vaga do teto (igual ao Jev)', async () => {
  const emb = embedderFalso();
  const capsTool = [{ id: 'x', tools: [{ name: 'a', semanticText: 'agenda' }, { name: 'b', semanticText: 'agenda' }, { name: 'd', semanticText: 'agenda' }, { name: 'c', semanticText: 'tarefa' }] }];
  const indice = await montarIndice({ anel: 'tool', capacidades: capsTool, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nota = pontuarNo(indice, q, 'x/tool/a').nota;
  const cortes = baseCom(nota - 0.01, nota - 0.5, { promocao: 0 });
  // três intocáveis em full + a e b: com teto 1, só uma vaga entre os avaliados (a de menor position); fixos ficam fora
  const refinar1 = criarRefinadorLocal({ anel: 'tool', tetoFull: 1, obterEstado: estado(indice, { cortes }) });
  const r = await refinar1(await entrada(emb, 'agenda', [
    item('x/tool/a', 4, 'discard'), item('x/tool/b', 3, 'discard'),
    item('x/tool/p1', 0, 'full', { pinned: true }), item('x/tool/p2', 1, 'full', { hasManual: true }), item('x/tool/p3', 2, 'full', { pinned: true }),
  ], 'tool', ['x']));
  assert.deepEqual(r.full, ['x/tool/b', 'x/tool/p1', 'x/tool/p2', 'x/tool/p3']); // avaliado antes dos fixos (ordem do Jev)
  assert.deepEqual(r.candidates, ['x/tool/a']);
  // fixos sozinhos acima do teto: ficam como estão; o avaliado ainda tem a vaga dele
  const refinar2 = criarRefinadorLocal({ anel: 'tool', tetoFull: 1, obterEstado: estado(indice, { cortes }) });
  const r2 = await refinar2(await entrada(emb, 'agenda', [
    item('x/tool/a', 3, 'discard'), item('x/tool/p1', 0, 'full', { pinned: true }), item('x/tool/p2', 1, 'full', { pinned: true }), item('x/tool/p3', 2, 'full', { pinned: true }),
  ], 'tool', ['x']));
  assert.deepEqual(r2.full, ['x/tool/a', 'x/tool/p1', 'x/tool/p2', 'x/tool/p3']);
  assert.deepEqual(r2.candidates, []);
});

test('ordem final como a do Jev: avaliados por nota decrescente, fixos por último (corte pela cauda nunca come avaliado antes de fixo)', async () => {
  const emb = embedderFalso();
  const capsTool = [{ id: 'x', tools: [{ name: 'a', semanticText: 'agenda' }, { name: 'c', semanticText: 'tarefa' }] }];
  const indice = await montarIndice({ anel: 'tool', capacidades: capsTool, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const na = pontuarNo(indice, q, 'x/tool/a').nota; const nc = pontuarNo(indice, q, 'x/tool/c').nota;
  assert.ok(na > nc);
  const cortes = baseCom(nc - 0.01, nc - 0.5, { promocao: 0 });
  const refinar = criarRefinadorLocal({ anel: 'tool', tetoFull: 4, obterEstado: estado(indice, { cortes }) });
  const r = await refinar(await entrada(emb, 'agenda', [
    item('x/tool/p1', 0, 'full', { pinned: true }), item('x/tool/c', 1, 'discard'), item('x/tool/a', 2, 'discard'), item('x/tool/p2', 3, 'full', { hasManual: true }),
  ], 'tool', ['x']));
  assert.deepEqual(r.full, ['x/tool/a', 'x/tool/c', 'x/tool/p1', 'x/tool/p2']);
});

test('ordem final: avaliados pela nota decrescente — o que o motor propunha full NÃO tem prioridade (propFull saiu)', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nAgenda = pontuarNo(indice, q, 'agenda').nota; const nTarefas = pontuarNo(indice, q, 'tarefas').nota;
  assert.ok(nAgenda > nTarefas);
  const cortes = baseCom(nTarefas - 0.01, nTarefas - 0.5);
  // tarefas era `full` no motor e tem position melhor; agenda era `discard` mas tem a nota maior → leva a única vaga
  const um = await criarRefinadorLocal({ anel: 'provider', tetoFull: 1, obterEstado: estado(indice, { cortes }) })(await entrada(emb, 'agenda', [item('tarefas', 0, 'full'), item('agenda', 5, 'discard')]));
  assert.deepEqual([um.full, um.candidates], [['agenda'], ['tarefas']]);
  // com as duas vagas, a saída segue a nota, não a entrada
  const dois = await criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: estado(indice, { cortes }) })(await entrada(emb, 'agenda', [item('tarefas', 0, 'full'), item('agenda', 5, 'discard')]));
  assert.deepEqual(dois.full, ['agenda', 'tarefas']);
});

test('ordem: quem não veio pelo caminho do anel (queda para a base por falta de centroide) vem DEPOIS dos da cabeça, mesmo com nota maior', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsGradual(), embedder: emb });
  const semCentroideNaAgenda = { ...indice, nos: new Map([...indice.nos].map(([ref, no]) => [ref, ref === 'agenda' ? { ...no, centroide: undefined } : no])) };
  const cab = cabecaReal(indice);
  const r = await criarRefinadorLocal({ anel: 'provider', obterEstado: estado(semCentroideNaAgenda, { cabeca: cab }) })(await entrada(emb, 'agenda', [item('agenda', 0, 'discard'), item('tarefas', 1, 'discard')]));
  assert.equal(r.explain.agenda.reason, 'local:base (texto)'); // nota base 1,0 ≥ 0,35: full
  assert.equal(r.explain.tarefas.reason, 'local:cabeca'); // nota ≈ 0,37 ≥ 0,30: full
  assert.deepEqual(r.full, ['tarefas', 'agenda']);
});

test('2 pinned + 1 hasManual em full + 3 tools propostas full: as 3 propostas ficam full (teto 4 do anel)', async () => {
  const emb = embedderFalso();
  const capsTool = [{ id: 'x', tools: [{ name: 'a', semanticText: 'agenda' }, { name: 'b', semanticText: 'agenda' }, { name: 'd', semanticText: 'agenda' }] }];
  const indice = await montarIndice({ anel: 'tool', capacidades: capsTool, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nota = pontuarNo(indice, q, 'x/tool/a').nota;
  const refinar = criarRefinadorLocal({ anel: 'tool', obterEstado: estado(indice, { cortes: baseCom(nota - 0.01, nota - 0.5, { promocao: 0 }) }) });
  const r = await refinar(await entrada(emb, 'agenda', [
    item('x/tool/p1', 0, 'full', { pinned: true }), item('x/tool/p2', 1, 'full', { pinned: true }), item('x/tool/m', 2, 'full', { hasManual: true }),
    item('x/tool/a', 3, 'full'), item('x/tool/b', 4, 'full'), item('x/tool/d', 5, 'full'),
  ], 'tool', ['x']));
  assert.deepEqual(r.full, ['x/tool/a', 'x/tool/b', 'x/tool/d', 'x/tool/p1', 'x/tool/p2', 'x/tool/m']);
  assert.deepEqual(r.candidates, []);
});

test('item sem nota (fora do índice) mantém o proposedTier, vai por último na saída e não consome vaga do teto', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: baseCom(0.5, 0.1) }) });
  const r = await refinar(await entrada(emb, 'minhas tarefa', [item('tarefas', 0, 'discard'), item('fora-1', 1, 'full'), item('fora-2', 2, 'full'), item('fora-3', 3, 'candidate')]));
  assert.deepEqual(r.full, ['tarefas', 'fora-1', 'fora-2']);
  assert.deepEqual(r.candidates, ['fora-3']);
  assert.equal(r.explain['fora-1'], undefined);
});

test('empate de nota: ordena por position (ausente = Infinity), não pela ordem de entrada', async () => {
  const emb = embedderFalso();
  const capsEmpate = [{ id: 'x', semanticText: 'agenda' }, { id: 'y', semanticText: 'agenda' }, { id: 'z', semanticText: 'tarefa' }];
  const indice = await montarIndice({ anel: 'provider', capacidades: capsEmpate, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nota = pontuarNo(indice, q, 'x').nota;
  assert.equal(nota, pontuarNo(indice, q, 'y').nota);
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: baseCom(nota - 0.01, nota - 0.5) }) });
  const r1 = await refinar(await entrada(emb, 'agenda', [item('y', 1, 'discard'), item('x', 0, 'discard')]));
  assert.deepEqual(r1.full, ['x', 'y']);
  const semPosicao = { ...item('y', undefined, 'discard') };
  const r2 = await refinar(await entrada(emb, 'agenda', [semPosicao, item('x', 5, 'discard')]));
  assert.deepEqual(r2.full, ['x', 'y']);
  const r3 = await refinar(await entrada(emb, 'agenda', [item('x', 0, 'discard'), item('y', 1, 'discard')]));
  assert.deepEqual(r3.full, ['x', 'y']);
});

test('caps.hard limita o teto de full e o de candidates', async () => {
  const emb = embedderFalso();
  const capsEmpate = [{ id: 'x', semanticText: 'agenda' }, { id: 'y', semanticText: 'agenda' }, { id: 'z', semanticText: 'tarefa' }];
  const indice = await montarIndice({ anel: 'provider', capacidades: capsEmpate, embedder: emb });
  const q = consultaCentrada(indice, [await emb.embed('agenda')]);
  const nota = pontuarNo(indice, q, 'x').nota;
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: baseCom(nota - 0.01, nota - 0.5) }) });
  const inp = await entrada(emb, 'agenda', [item('x', 0, 'discard'), item('y', 1, 'discard')]);
  inp.caps.hard = { maxFull: 1, maxCandidates: 8 };
  const r = await refinar(inp);
  assert.deepEqual([r.full, r.candidates], [['x'], ['y']]);
  inp.caps.hard = { maxFull: 1, maxCandidates: 0 };
  const r2 = await refinar(inp);
  assert.deepEqual([r2.full, r2.candidates], [['x'], []]);
});

test('skill: nunca usa a cabeça (estado do anel = base), mesmo com a cabeça aprovada', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'skill', capacidades: capsFalsas(), embedder: emb });
  const cab = cabecaReal(indice); // anelAprovado: true
  const e = estadoDe(indice, { cabeca: cab, cortes: baseCom(-1, -1) });
  assert.equal(estadoDoAnel(e, 'skill'), 'base');
  const vetores = [await emb.embed('nota rotina')];
  const r = await criarRefinadorLocal({ anel: 'skill', obterEstado: () => e })(await entrada(emb, 'nota rotina', [item('tarefas/skill/rotina', 0, 'discard')], 'skill', [], vetores));
  assert.match(r.explain['tarefas/skill/rotina'].reason, /^local:base/);
  assert.equal(r.explain['tarefas/skill/rotina'].confidence, pontuarNo(indice, consultaCentrada(indice, vetores), 'tarefas/skill/rotina').nota);
  assert.deepEqual(r.full, ['tarefas/skill/rotina']);
});

test('cabeça real: com o anel aprovado vale para TODAS as capacidades, usa o centroide e o máximo sobre a consulta', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const cabeca = cabecaReal(indice);
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cortes: cortesEm({ cabeca: { full: 0.99, candidate: 0.98 } }), cabeca }) });
  const vetores = [await emb.embed('xyz'), await emb.embed('minhas tarefa')];
  const r = await refinar(await entrada(emb, 'minhas tarefa', [item('google-calendar', 0, 'discard'), item('tarefas', 1, 'discard')], 'provider', [], vetores));
  const consulta = consultaCentrada(indice, vetores);
  const esperado = Math.max(...consulta.map((s) => pontuarCabeca(cabeca.cabeca, s, indice.nos.get('tarefas').centroide)));
  assert.equal(r.explain.tarefas.reason, 'local:cabeca');
  assert.equal(r.explain.tarefas.casou, 'cabeca');
  assert.equal(r.explain.tarefas.confidence, esperado);
  assert.notEqual(esperado, pontuarCabeca(cabeca.cabeca, consulta[0], indice.nos.get('tarefas').centroide)); // o máximo não é o 1º vetor
  assert.equal(r.explain['google-calendar'].reason, 'local:cabeca'); // antes só as "aprovadas" iam pela cabeça
});

test('ponta a ponta: cabeça sobre índice que passou por semRoubados usa o centroide recalculado', async () => {
  const emb = embedderTabela(TABELA);
  const cheio = await montarIndice({ anel: 'provider', capacidades: capsTres(), embedder: emb });
  const cortes = await calibrarCortes(cheio, { parametros: { minExemplos: 1 } });
  assert.equal(cortes.roubados.length, 1);
  const limpo = semRoubados(cheio, cortes.roubados);
  const cabeca = cabecaReal(limpo);
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(limpo, { cortes: cortesEm({ cabeca: { full: 0.9, candidate: 0.5 } }), cabeca }) });
  const vetores = [await emb.embed('b1')];
  const r = await refinar(await entrada(emb, 'b1', [item('tarefas', 0, 'discard'), item('agenda', 1, 'discard')], 'provider', [], vetores));
  const s = consultaCentrada(limpo, vetores)[0];
  assert.equal(r.explain.tarefas.reason, 'local:cabeca');
  assert.equal(r.explain.tarefas.confidence, pontuarCabeca(cabeca.cabeca, s, limpo.nos.get('tarefas').centroide));
  assert.notEqual(r.explain.tarefas.confidence, pontuarCabeca(cabeca.cabeca, s, cheio.nos.get('tarefas').centroide));
});

test('sem centroide no nó, a cabeça não vale para o item (cai na base)', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const semCentroide = { ...indice, nos: new Map([...indice.nos].map(([ref, no]) => [ref, { ...no, centroide: undefined }])) };
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(semCentroide, { cabeca: cabecaReal(indice), cortes: baseCom(0.5, 0.1) }) });
  const r = await refinar(await entrada(emb, 'minhas tarefa', [item('tarefas', 0, 'discard')]));
  assert.match(r.explain.tarefas.reason, /^local:base/);
});

test('nota da cabeça não finita (NaN) cai na nota base', async () => {
  const emb = embedderFalso();
  const indice = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const boa = cabecaReal(indice);
  const nan = { ...boa, cabeca: { ...boa.cabeca, alfa: NaN } };
  const refinar = criarRefinadorLocal({ anel: 'provider', obterEstado: estado(indice, { cabeca: nan, cortes: baseCom(0.5, 0.1) }) });
  const r = await refinar(await entrada(emb, 'minhas tarefa', [item('tarefas', 0, 'discard')]));
  assert.match(r.explain.tarefas.reason, /^local:base/);
  assert.ok(Number.isFinite(r.explain.tarefas.confidence));
});

// ---- Revisão do conjunto (08/10): índices montados à mão, com nota base conhecida (cosseno com a consulta e0).
const noCom = (v) => { const n = Math.hypot(...v); const u = v.map((x) => x / n); return { textos: [], vetores: [u], origens: [{ tipo: 'texto', i: 0 }], centroide: u }; };
const comNota = (c) => [c, Math.sqrt(1 - c * c), 0, 0];
const indiceAMao = (anel, notas) => ({ anel, dim: 4, media: [0, 0, 0, 0], slug: 's', nos: new Map(Object.entries(notas).map(([ref, c]) => [ref, noCom(comNota(c))])) });
const estadoBase = (indice, over = {}) => ({ indice, cortes: CORTES_FIXOS, cabeca: null, funcaoTraz: { ...FUNCAO_TRAZ_PADRAO }, minCasosCapacidade: 50, ...over });

test('D4b ignora capacidade JÁ carregada: com n=1 avalia a descartada nova (docs), não a carregada (notas); com maxCandidates=1 a vaga é da descartada que a função traz', async () => {
  const prov = indiceAMao('provider', { notas: 0.24, docs: 0.22, outra: 0.10 }); // as três abaixo do candidate da base (0,25)
  const tool = indiceAMao('tool', { 'notas/tool/ler': 0.60, 'docs/tool/buscar': 0.50, 'outra/tool/x': 0.05 });
  const entradaD = (maxCandidates) => ({
    query: { vectors: [[1, 0, 0, 0]] },
    items: ['notas', 'docs', 'outra'].map((ref, i) => ({ ref, position: i, proposedTier: 'discard' })),
    proposal: { full: [], candidates: [] }, caps: { hard: { maxFull: 2, maxCandidates } }, state: { loadedProviders: ['notas'] },
  });
  for (const [n, maxC] of [[1, 5], [5, 1]]) {
    const e = estadoBase(prov); e.funcaoTraz.n = n;
    const r = await criarRefinadorLocal({ anel: 'provider', obterEstado: () => e, obterEstadoDe: (a) => (a === 'tool' ? estadoBase(tool) : null) })(entradaD(maxC));
    assert.deepEqual(r.candidates, ['docs'], `n=${n} maxCandidates=${maxC}`);
    assert.match(r.explain.docs.reason, /^local:funcao-trouxe \(docs\/tool\/buscar 0\.500\)/);
    assert.doesNotMatch(r.explain.notas.reason, /funcao-trouxe/, 'a carregada nunca é promovida pela função: já tem o tier do motor');
  }
  // sem carregadas o comportamento é o de antes: a melhor nota entre as descartadas (notas, 0,24) ocupa a única posição de n=1
  const e0 = estadoBase(prov); e0.funcaoTraz.n = 1;
  const r0 = await criarRefinadorLocal({ anel: 'provider', obterEstado: () => e0, obterEstadoDe: (a) => (a === 'tool' ? estadoBase(tool) : null) })({ ...entradaD(5), state: { loadedProviders: [] } });
  assert.deepEqual(r0.candidates, ['notas']);
});

test('anel provider: as vagas de full vão primeiro às capacidades NOVAS; a carregada segue full no tier mas, se perde a vaga, vai para candidates (sem prejuízo: o kairos a hidrata)', async () => {
  const indice = indiceAMao('provider', { 'md-notes': 0.60, 'skill-system': 0.50, 'gestao-documentos': 0.40 }); // base: full 0,35
  const e = estadoBase(indice, { funcaoTraz: { ativo: false } });
  const items = ['md-notes', 'skill-system', 'gestao-documentos'].map((ref, i) => ({ ref, position: i, proposedTier: 'discard' }));
  const refinar = criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: () => e });
  const base = { query: { vectors: [[1, 0, 0, 0]] }, items, proposal: { full: [], candidates: [] }, caps: { hard: { maxFull: 5, maxCandidates: 8 } } };
  // md-notes e skill-system carregadas; gestao-documentos nova acima do corte: a nova leva uma das 2 vagas, a carregada de maior nota a outra
  const r = await refinar({ ...base, state: { loadedProviders: ['md-notes', 'skill-system'] } });
  assert.deepEqual(r.full, ['gestao-documentos', 'md-notes']);
  assert.deepEqual(r.candidates, ['skill-system']);
  // ninguém carregado: ordem pela nota, como sempre
  assert.deepEqual((await refinar({ ...base, state: { loadedProviders: [] } })).full, ['md-notes', 'skill-system']);
  // todas carregadas: nenhuma nova disputa, a nota decide como antes
  const um = await refinar({ ...base, state: { loadedProviders: ['md-notes', 'skill-system', 'gestao-documentos'] } });
  assert.deepEqual(um.full, ['md-notes', 'skill-system'], 'todas carregadas: a nota decide, como antes');
  // só md-notes carregada, 2 vagas: as duas novas (skill-system, gestao-documentos) levam as vagas; a carregada vai para candidates
  const duas = await refinar({ ...base, caps: { hard: { maxFull: 2, maxCandidates: 8 } }, state: { loadedProviders: ['md-notes'] } });
  assert.deepEqual(duas.full, ['skill-system', 'gestao-documentos']);
  assert.deepEqual(duas.candidates, ['md-notes']);
});

test('anel provider: "carregada" na ordem das vagas = ativa ANTES do turno (ativasNoInicio); o que o 1º refine pôs em full e o 2º vê em loadedProviders não passa a nova na frente (teto 2 mantido)', async () => {
  // Caso da bancada 3a221a70: 2º refine do turno (promoção do kairos). google-calendar e tarefas foram postas em full pelo 1º refine
  // e agora constam em loadedProviders; nada estava ativo no início (ativasNoInicio []). O navegador (nova, nota menor) não toma a vaga.
  const indice = indiceAMao('provider', { 'google-calendar': 0.83, tarefas: 0.65, navegador: 0.37 }); // base: full 0,35 — as três acima
  const e = (extra) => estadoBase(indice, { funcaoTraz: { ativo: false }, ...extra });
  const items = [item('google-calendar', 0, 'full'), item('tarefas', 1, 'full'), item('navegador', 2, 'discard')];
  const base = { query: { vectors: [[1, 0, 0, 0]] }, items, proposal: { full: ['google-calendar', 'tarefas'], candidates: [] }, caps: { hard: { maxFull: 5, maxCandidates: 8 } } };
  const rodar = (est, loaded) => criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: () => est })({ ...base, state: { loadedProviders: loaded } });
  const r = await rodar(e({ ativasNoInicio: [] }), ['google-calendar', 'tarefas']);
  assert.deepEqual(r.full, ['google-calendar', 'tarefas'], 'a nota decide: ninguém era antiga');
  assert.deepEqual(r.candidates, ['navegador']);
  assert.equal(r.full.length, 2, 'teto de 2 capacidades full');
  // controle: sem ativasNoInicio (sem trace) vale o loadedProviders do refine — é o comportamento de antes, em que a nova passava na frente
  const antes = await rodar(e(), ['google-calendar', 'tarefas']);
  assert.deepEqual(antes.full, ['navegador', 'google-calendar']);
  const nulo = await rodar(e({ ativasNoInicio: null }), ['google-calendar', 'tarefas']);
  assert.deepEqual(nulo.full, ['navegador', 'google-calendar'], 'ativasNoInicio null (não capturada) cai no loadedProviders');
  // com 1 vaga só: a nota decide; quem perde a vaga fica em candidates (o kairos hidrata as carregadas de qualquer jeito)
  const menor = await criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: () => e({ ativasNoInicio: [] }) })({ ...base, caps: { hard: { maxFull: 1, maxCandidates: 8 } }, state: { loadedProviders: ['google-calendar', 'tarefas'] } });
  assert.deepEqual(menor.full, ['google-calendar']);
  assert.deepEqual(menor.candidates, ['tarefas', 'navegador']);

  // caso do I1: md-notes e skill-system ativas desde o início; a nova gestao-documentos tem prioridade sobre as duas — mesmo que o
  // state do refine corrente não as liste (ativasNoInicio manda)
  const ind2 = indiceAMao('provider', { 'md-notes': 0.60, 'skill-system': 0.50, 'gestao-documentos': 0.40 });
  const items2 = ['md-notes', 'skill-system', 'gestao-documentos'].map((ref, i) => item(ref, i, 'discard'));
  const e2 = estadoBase(ind2, { funcaoTraz: { ativo: false }, ativasNoInicio: ['md-notes', 'skill-system'] });
  const i1 = await criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: () => e2 })({ query: { vectors: [[1, 0, 0, 0]] }, items: items2, proposal: { full: [], candidates: [] }, caps: { hard: { maxFull: 5, maxCandidates: 8 } }, state: { loadedProviders: [] } });
  assert.deepEqual(i1.full, ['gestao-documentos', 'md-notes']);
  assert.deepEqual(i1.candidates, ['skill-system']);
  // e ativasNoInicio [] com todas no state: ninguém é antiga, a nota decide
  const e3 = estadoBase(ind2, { funcaoTraz: { ativo: false }, ativasNoInicio: [] });
  const i3 = await criarRefinadorLocal({ anel: 'provider', tetoFull: 2, obterEstado: () => e3 })({ query: { vectors: [[1, 0, 0, 0]] }, items: items2, proposal: { full: [], candidates: [] }, caps: { hard: { maxFull: 5, maxCandidates: 8 } }, state: { loadedProviders: ['md-notes', 'skill-system', 'gestao-documentos'] } });
  assert.deepEqual(i3.full, ['md-notes', 'skill-system']);
});

// ---- T7 (revisão do conjunto, C1): `explain[ref].doMotor = true` marca o ref que terminou em `full` SÓ porque o anel não rebaixa abaixo da
// proposta do kairos (tool: sempre; provider: capacidade carregada) — a nota dele ficou abaixo do corte. As listas `full`/`candidates` NÃO mudam.
const entradaMotor = (items, loaded, maxFull = 5) => ({
  query: { vectors: [[1, 0, 0, 0]] }, items,
  proposal: { full: items.filter((i) => i.proposedTier === 'full').map((i) => i.ref), candidates: items.filter((i) => i.proposedTier === 'candidate').map((i) => i.ref) },
  caps: { hard: { maxFull, maxCandidates: 8 } }, state: { loadedProviders: loaded },
});
// agenda traz pela nota (o kairos propunha candidate); memoria o kairos propõe full com nota abaixo do corte da base (0,35 / 0,25); busca/web discard
const indiceMotorTool = () => indiceAMao('tool', { 'agenda/tool/listar': 0.60, 'memoria/tool/ler': 0.10, 'memoria/tool/gravar': 0.30, 'notas/tool/ler': 0.30, 'busca/tool/web': 0.05, 'web/tool/pesquisar': 0.90 });
const itensMotorTool = () => [
  item('agenda/tool/listar', 0, 'candidate'), item('memoria/tool/ler', 1, 'full'), item('memoria/tool/gravar', 2, 'full'),
  item('notas/tool/ler', 3, 'candidate'), item('busca/tool/web', 4, 'discard'), item('web/tool/pesquisar', 5, 'discard'),
];
const rodarMotorTool = (promoverFull) => criarRefinadorLocal({
  anel: 'tool', obterEstado: () => estadoBase(indiceMotorTool(), { funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, ativo: false, promoverFull }, minCasosCapacidade: 0 }),
})(entradaMotor(itensMotorTool(), ['memoria']));
const indiceMotorProvider = () => indiceAMao('provider', { 'google-calendar': 0.10, tarefas: 0.60, navegador: 0.20, 'md-notes': 0.55 });
// google-calendar estava ativa ANTES do turno; navegador entrou no meio (P1 do kairos: o 2º refine a vê em loadedProviders); md-notes também, mas com nota acima do corte
const itensMotorProvider = () => [item('google-calendar', 0, 'full'), item('navegador', 1, 'full'), item('tarefas', 2, 'discard'), item('md-notes', 3, 'full')];
const rodarMotorProvider = (tetoFull) => criarRefinadorLocal({
  anel: 'provider', ...(tetoFull ? { tetoFull } : {}),
  obterEstado: () => estadoBase(indiceMotorProvider(), { funcaoTraz: { ativo: false }, ativasNoInicio: ['google-calendar'], minCasosCapacidade: 0 }),
})(entradaMotor(itensMotorProvider(), ['google-calendar', 'navegador', 'md-notes']));

test('doMotor: as listas full/candidates são as MESMAS de antes da marca (elevação à proposta no tool; carregada que nunca cai no provider) e o explain mantém reason/confidence/casou', async () => {
  // Valores capturados com o refinador de antes da T7 (HEAD 2fc85a655): a marca só ACRESCENTA um campo ao explain.
  const t = await rodarMotorTool('so-provider-na-base');
  assert.deepEqual([t.full, t.candidates], [['agenda/tool/listar', 'memoria/tool/gravar', 'memoria/tool/ler'], ['notas/tool/ler', 'web/tool/pesquisar']]);
  assert.equal(t.explain['web/tool/pesquisar'].reason, 'local:base (texto) (promocao)', 'a promoção D4a segue com o sufixo no reason');
  const ts = await rodarMotorTool('sempre');
  assert.deepEqual([ts.full, ts.candidates], [['agenda/tool/listar', 'memoria/tool/gravar', 'memoria/tool/ler', 'web/tool/pesquisar'], ['notas/tool/ler']]);
  const p5 = await rodarMotorProvider(5);
  assert.deepEqual([p5.full, p5.candidates], [['tarefas', 'md-notes', 'navegador', 'google-calendar'], []]);
  const p2 = await rodarMotorProvider(2); // teto EXPLÍCITO 2: as duas carregadas de nota baixa perdem a vaga e vão a candidates
  assert.deepEqual([p2.full, p2.candidates], [['tarefas', 'md-notes'], ['navegador', 'google-calendar']]);
  for (const r of [t, ts, p5, p2]) for (const e of Object.values(r.explain)) {
    assert.match(e.reason, /^local:base \(texto\)/);
    assert.equal(typeof e.confidence, 'number');
    assert.equal(e.casou, 'texto');
  }
});

test('doMotor (tool): o ref que ficou full só porque o kairos propôs full (nota abaixo do corte) leva doMotor; o que o local trouxe pela nota, o candidate e a promoção D4a não', async () => {
  const t = await rodarMotorTool('so-provider-na-base');
  assert.equal(t.explain['memoria/tool/ler'].doMotor, true, 'nota 0,10 < candidate 0,25: o local diria discard; o kairos propôs full');
  assert.equal(t.explain['memoria/tool/gravar'].doMotor, true, 'nota 0,30 entre candidate e full: o local diria candidate; o kairos propôs full');
  assert.equal('doMotor' in t.explain['agenda/tool/listar'], false, 'trazida pela nota (0,60 ≥ 0,35), o kairos propunha candidate: decisão do local');
  assert.equal('doMotor' in t.explain['notas/tool/ler'], false, 'candidate, não full');
  assert.equal('doMotor' in t.explain['busca/tool/web'], false, 'discard');
  assert.equal('doMotor' in t.explain['web/tool/pesquisar'], false, 'função de capacidade nova rebaixada pela promoção D4a: candidate, decisão do local');
  // promoverFull "sempre": a função nova entra em full pela nota (0,90 ≥ promoção 0,70) — decisão do local, sem marca
  const ts = await rodarMotorTool('sempre');
  assert.ok(ts.full.includes('web/tool/pesquisar'));
  assert.equal('doMotor' in ts.explain['web/tool/pesquisar'], false);
  assert.deepEqual(Object.entries(ts.explain).filter(([, e]) => e.doMotor).map(([ref]) => ref).sort(), ['memoria/tool/gravar', 'memoria/tool/ler']);
  // o valor é sempre `true` quando existe (ausente = o local decidiu, nunca `false`)
  for (const e of Object.values(t.explain)) assert.ok(e.doMotor === undefined || e.doMotor === true);
  // pinned/hasManual e item sem nota seguem fixos: sem explain, portanto sem marca (já ficam fora da carga nova por não terem nota)
  const emb = embedderFalso();
  const capsTool = [{ id: 'x', tools: [{ name: 'a', semanticText: 'agenda' }] }];
  const indice = await montarIndice({ anel: 'tool', capacidades: capsTool, embedder: emb });
  const fixos = await criarRefinadorLocal({ anel: 'tool', obterEstado: estado(indice) })(await entrada(emb, 'agenda', [item('x/tool/a', 0, 'full', { pinned: true }), item('fora/tool/b', 1, 'full')], 'tool'));
  assert.deepEqual(fixos.full.sort(), ['fora/tool/b', 'x/tool/a']);
  assert.deepEqual(fixos.explain, {});
});

test('doMotor (tool): função que o kairos propôs full leva a marca com QUALQUER nota — também a que o local aprova (0,80 ≥ corte): o full dela não depende da nota nem do corte, e o resultado é o mesmo com o corte padrão e com o corte acima de tudo', async () => {
  const indice = indiceAMao('tool', { 'agenda/tool/listar': 0.80 });
  const rodar = (base) => criarRefinadorLocal({ anel: 'tool', obterEstado: () => estadoBase(indice, { cortes: { ...CORTES_FIXOS, base }, funcaoTraz: { ativo: false }, minCasosCapacidade: 0 }) })(
    entradaMotor([item('agenda/tool/listar', 0, 'full')], ['agenda']));
  const padrao = await rodar({ ...CORTES_FIXOS.base });
  const alto = await rodar({ full: 1.01, candidate: 1.005 });
  for (const [nome, r] of Object.entries({ padrao, alto })) {
    assert.deepEqual(r.full, ['agenda/tool/listar'], `${nome}: o tool não rebaixa`);
    assert.equal(r.explain['agenda/tool/listar'].doMotor, true, `${nome}: proposta full do kairos = full independente da nota (0,80) e do corte`);
  }
  assert.ok(padrao.explain['agenda/tool/listar'].confidence >= CORTES_FIXOS.base.full, 'pré-condição: no corte padrão a nota também passaria do corte');
  // proposta candidate da mesma função: aí a nota decide (full pelo corte padrão, candidate com o corte acima) e não há marca em nenhum dos dois
  const cand = (base) => criarRefinadorLocal({ anel: 'tool', obterEstado: () => estadoBase(indice, { cortes: { ...CORTES_FIXOS, base }, funcaoTraz: { ativo: false }, minCasosCapacidade: 0 }) })(
    entradaMotor([item('agenda/tool/listar', 0, 'candidate')], ['agenda']));
  const cPadrao = await cand({ ...CORTES_FIXOS.base });
  const cAlto = await cand({ full: 1.01, candidate: 1.005 });
  assert.deepEqual([cPadrao.full, cAlto.full, cAlto.candidates], [['agenda/tool/listar'], [], ['agenda/tool/listar']]);
  assert.equal('doMotor' in cPadrao.explain['agenda/tool/listar'], false);
  assert.equal('doMotor' in cAlto.explain['agenda/tool/listar'], false);
});

test('doMotor (provider): a capacidade carregada que "nunca cai" (ativa antes do turno ou promovida pela P1 no meio dele) e que o kairos propõe full leva doMotor com QUALQUER nota; só quando termina em full', async () => {
  const p = await rodarMotorProvider(5);
  assert.equal(p.explain['google-calendar'].doMotor, true, 'ativa antes do turno, nota 0,10 < corte');
  assert.equal(p.explain.navegador.doMotor, true, 'promovida no meio do turno (está em loadedProviders mas não em ativasNoInicio), nota 0,20 < corte');
  assert.equal('doMotor' in p.explain.tarefas, false, 'nova acima do corte: decisão do local');
  assert.equal(p.explain['md-notes'].doMotor, true, 'carregada e proposta full: marcada mesmo com a nota (0,55) acima do corte — o full dela não depende do corte');
  // teto 2: as duas carregadas de nota baixa perdem a vaga de full e vão a candidates — não terminaram em full, sem marca
  const p2 = await rodarMotorProvider(2);
  assert.deepEqual(p2.candidates, ['navegador', 'google-calendar']);
  assert.equal('doMotor' in p2.explain.navegador, false);
  assert.equal('doMotor' in p2.explain['google-calendar'], false);
  // proposta candidate de capacidade carregada: sobe a candidate (não é full), sem marca; capacidade NÃO carregada neste refine é livre para o
  // corte (o provider rebaixa até discard): proposta full com nota baixa sai, e não há o que marcar
  const e = estadoBase(indiceMotorProvider(), { funcaoTraz: { ativo: false }, minCasosCapacidade: 0 });
  const itens = [item('google-calendar', 0, 'candidate'), item('navegador', 1, 'full')];
  const r = await criarRefinadorLocal({ anel: 'provider', obterEstado: () => e, tetoFull: 5 })(entradaMotor(itens, ['google-calendar']));
  assert.deepEqual([r.full, r.candidates], [[], ['google-calendar']]);
  assert.equal('doMotor' in r.explain['google-calendar'], false);
  assert.equal('doMotor' in r.explain.navegador, false);
});

test('getters de estado recebem o input do refino (obterEstado(input) e obterEstadoDe(anel, input))', async () => {
  const emb = embedderFalso();
  const tool = await montarIndice({ anel: 'tool', capacidades: capsFuncoes(), embedder: emb });
  const prov = await montarIndice({ anel: 'provider', capacidades: capsFuncoes(), embedder: emb });
  const vetores = [await emb.embed('agenda')];
  const input = await entrada(emb, 'agenda', [item('docs/tool/exata', 0, 'discard'), item('agenda/tool/listar', 1, 'candidate')], 'tool', ['agenda'], vetores);
  const recebidoE = []; const recebidoDe = [];
  await criarRefinadorLocal({
    anel: 'tool',
    obterEstado: (...args) => { recebidoE.push(args); return estadoDe(tool, { cortes: baseCom(0.20, 0.10) }); },
    obterEstadoDe: (...args) => { recebidoDe.push(args); return args[0] === 'provider' ? estadoDe(prov) : null; },
  })(input);
  assert.equal(recebidoE.length, 1);
  assert.equal(recebidoE[0][0], input);
  assert.ok(recebidoDe.length >= 1, 'a D4a (exata fora do turno em full) consulta o provider');
  assert.equal(recebidoDe[0][0], 'provider');
  assert.equal(recebidoDe[0][1], input);
});

// ---- Sem tetos por padrão (ajuste de 09/10, caso 23c23ea8): quem filtra é o corte; teto só se for passado explicitamente.
test('sem teto (padrão): função da capacidade carregada com nota de base ≥ corte entra em full junto de 5 funções de outras capacidades carregadas com nota maior — antes o teto 4 a cortava', async () => {
  const notas = { 'mcp-home-assistant/tool/hassturnon': 0.38 };
  for (const c of ['navegador', 'desktop', 'arquivos', 'agenda', 'web']) notas[`${c}/tool/f`] = 0.60;
  const indice = indiceAMao('tool', notas);
  const itens = Object.keys(notas).map((ref, i) => item(ref, i, 'candidate'));
  const rodar = (extra = {}) => criarRefinadorLocal({ anel: 'tool', ...extra, obterEstado: () => estadoBase(indice, { funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, ativo: false }, minCasosCapacidade: 0 }) })(
    entradaMotor(itens, ['mcp-home-assistant', 'navegador', 'desktop', 'arquivos', 'agenda', 'web'], 20));
  const r = await rodar();
  assert.equal(r.full.length, 6, 'tudo acima do corte (base full 0,35) entra');
  assert.ok(r.full.includes('mcp-home-assistant/tool/hassturnon'));
  assert.deepEqual(r.candidates, []);
  // o mecanismo de teto continua: com teto EXPLÍCITO 4 as 4 de maior nota ficam e a da base cai a candidate
  const t4 = await rodar({ tetoFull: 4 });
  assert.equal(t4.full.length, 4);
  assert.ok(t4.candidates.includes('mcp-home-assistant/tool/hassturnon'));
  // caps.hard do motor continua limitando
  const hard = await criarRefinadorLocal({ anel: 'tool', obterEstado: () => estadoBase(indice, { funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, ativo: false }, minCasosCapacidade: 0 }) })(entradaMotor(itens, ['mcp-home-assistant', 'navegador', 'desktop', 'arquivos', 'agenda', 'web'], 3));
  assert.equal(hard.full.length, 3);
});

test('sem teto de promoção (padrão): todas as capacidades novas com função ≥ promoção (0,70) promovem; abaixo de 0,70 ficam candidate com " (promocao)" (D4a intacto)', async () => {
  const alto = indiceAMao('tool', { 'a/tool/f': 0.90, 'b/tool/f': 0.85, 'c/tool/f': 0.80, 'd/tool/f': 0.75 });
  const baixo = indiceAMao('tool', { 'a/tool/f': 0.60, 'b/tool/f': 0.55, 'c/tool/f': 0.50 });
  const rodar = (indice, refs) => criarRefinadorLocal({ anel: 'tool', obterEstado: () => estadoBase(indice, { funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'sempre' }, minCasosCapacidade: 0 }) })(
    entradaMotor(refs.map((ref, i) => item(ref, i, 'discard')), [], 20));
  const a = await rodar(alto, [...alto.nos.keys()]);
  assert.equal(a.full.length, 4, 'nenhum teto: as 4 capacidades novas promovem');
  assert.ok(Object.values(a.explain).every((x) => !x.reason.includes('promocao')));
  const b = await rodar(baixo, [...baixo.nos.keys()]);
  assert.deepEqual(b.full, []);
  assert.equal(b.candidates.length, 3);
  assert.ok(Object.values(b.explain).every((x) => x.reason.endsWith('(promocao)')), 'abaixo de 0,70: D4a rebaixa a candidate');
  // teto de promoção explícito segue valendo
  const c = await criarRefinadorLocal({ anel: 'tool', obterEstado: () => estadoBase(alto, { tetoProvider: 2, funcaoTraz: { ...FUNCAO_TRAZ_PADRAO, promoverFull: 'sempre' }, minCasosCapacidade: 0 }) })(
    entradaMotor([...alto.nos.keys()].map((ref, i) => item(ref, i, 'discard')), [], 20));
  assert.equal(c.full.length, 2);
});

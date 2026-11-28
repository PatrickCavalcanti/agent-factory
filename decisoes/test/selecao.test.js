// Decisor local de seleção por host (portado de packages/executor/test/fabrica-selecao.test.js do Igris): config por objeto, dataDir temporário, limiares/embedder por parâmetro.
// Decisor local de seleção na fábrica: o índice de cada anel é DERIVADO do `RefineInput` que o Kairos entrega
// (`input.semantica` + `item.semantica`); nada é montado nem aquecido fora do input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashDosNos, nosDoAnel, CORTES_FIXOS, FUNCAO_TRAZ_PADRAO, novaCabeca, serializarCabeca } from '../src/local/index.js';
import { gravarVersao } from '../treino/lib/versoes.js';
import { montarCaso, cargaNovaDe } from '../treino/lib/caso.js';
import { configDaSelecao as configDaSelecaoReal, cortesDaBaseDoModelo, SELECAO_PADRAO, criarSelecaoLocal, registrarCatalogoSemantico, serializarSelecao, registrarDecisao, registrarPromovidasNoTurno, indiceEmUso, invalidarSelecaoLocal, _limparSelecaoParaTestes, _memoDeDerivacoesParaTestes, MEMO_MAX } from '../src/local/selecao.js';

// Tabela de limiares do HOST (no Igris, `@igris/embeddings/limiares`): a base do e5 como padrão e uma linha extra para o modelo fake.
const LINHAS = { 'modelo-fake': { decisorBase: { full: 0.61, candidate: 0.51 } } };
const limiaresDoModelo = (slug) => ({ slug, decisorBase: LINHAS[slug]?.decisorBase ?? CORTES_FIXOS.base });
/** A config como o host a monta: com a linha de limiares por modelo (sem ela a base é a fixa do produto, origem `fixo`). */
const configDaSelecao = (bruto, opcoes = {}) => configDaSelecaoReal(bruto, { limiaresDoModelo, ...opcoes });

const emb = { modelSlug: 'falso', async embed(t) { const s = String(t); return [s.includes('agenda') ? 1 : 0.01, s.includes('tarefa') ? 1 : 0.01, 0.01, 0.01]; } };
const exemplos = (p, extra = []) => [...Array.from({ length: 12 }, (_, i) => `${p} ${i}`), ...extra];
const caps = (extra = []) => [
  { id: 'agenda', semanticText: 'agenda', tools: [{ name: 'gcal', exemplos: exemplos('agenda', extra) }] },
  { id: 'tarefas', semanticText: 'tarefa', tools: [{ name: 'task', exemplos: exemplos('tarefa') }] },
];
const nova = (cfg = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  return { dir, sel: criarSelecaoLocal({ dataDir: dir, config: configDaSelecao(cfg) }) };
};
const novoTrace = () => ({ porAnel: {}, sombras: [] });
const entradaProvider = async (e = emb) => ({
  ring: 'provider', query: { text: 'agenda', vectors: [await e.embed('agenda')] },
  items: [{ ref: 'agenda', position: 0, scores: {}, proposedTier: 'candidate', meta: {} }, { ref: 'tarefas', position: 1, scores: {}, proposedTier: 'candidate', meta: {} }],
  proposal: { full: [], candidates: ['agenda', 'tarefas'] }, caps: {}, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600,
});
const jevProvider = { provider: async (i) => ({ full: [], candidates: i.items.map((x) => x.ref), explain: {} }) };
const tick = () => new Promise((r) => setTimeout(r, 15));
/** Grava a calibração MANTIDA (o que o treino completo grava) em `indice/<anel>-roubados.json`. */
const gravarCalibracaoMantida = (dir, anel, { roubados = [], resumo = { roubados: roubados.length, roubadosIrmaos: roubados.filter((r) => r.irmao).length, roubadosMascarados: 0 }, cortesSugeridos = null, slug = 'falso', hash = 'h-treino' } = {}) => {
  mkdirSync(join(dir, 'decisoes', 'indice'), { recursive: true });
  writeFileSync(join(dir, 'decisoes', 'indice', `${anel}-roubados.json`), JSON.stringify({ anel, hash, slug, regra: 'irmao-nao-rouba', roubados, resumo, cortesSugeridos }));
};

/** Captura os console.warn de `fn` e devolve a lista. */
const capturarAvisos = (fn) => {
  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => { avisos.push(a.join(' ')); };
  try { fn(); } finally { console.warn = original; }
  return avisos;
};
const comAvisosCapturados = async (fn) => {
  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => { avisos.push(a.join(' ')); };
  try { await fn(); } finally { console.warn = original; }
  return avisos;
};

// ---- A semântica do Kairos, construída das capacidades de teste (mesmos textos que `nosDoAnel`, vetores brutos do embedder) ----
/** Por nó do anel: `{ texto:{texto,vetor}, exemplos:[{texto,vetor}] }`; `media` = média dos vetores brutos do anel (como o Kairos). */
const semanticaDoKairos = async (anel, capacidades, embedder) => {
  const brutos = [];
  const porRef = new Map();
  for (const no of nosDoAnel(anel, capacidades)) {
    const sem = { texto: null, exemplos: [] };
    for (const { tipo, texto } of no.textos) {
      const vetor = await embedder.embed(texto, 'query');
      if (Array.isArray(vetor)) brutos.push(vetor);
      if (tipo === 'texto') sem.texto = { texto, vetor }; else sem.exemplos.push({ texto, vetor });
    }
    porRef.set(no.ref, sem);
  }
  const media = brutos.length ? brutos[0].map((_, i) => brutos.reduce((t, v) => t + v[i], 0) / brutos.length) : null;
  return { porRef, media };
};
/**
 * `input` + `semantica` do Kairos para o anel do input. No anel provider leva também `funcoes` por item e `mediaFuncoes` (D4b).
 * Opções: `versao`, `exemploExtra {ref,texto}`, `semFuncoes`, `semSemanticaDe [refs]`.
 */
const K = async (input, capacidades, embedder, { versao = 'v-teste', exemploExtra = null, semFuncoes = false, semSemanticaDe = [] } = {}) => {
  const anel = input.ring;
  const k = await semanticaDoKairos(anel, capacidades, embedder);
  if (exemploExtra) k.porRef.get(exemploExtra.ref).exemplos.push({ texto: exemploExtra.texto, vetor: await embedder.embed(exemploExtra.texto, 'query') });
  let items = input.items.map((it) => (k.porRef.has(it.ref) && !semSemanticaDe.includes(it.ref) ? { ...it, semantica: k.porRef.get(it.ref) } : it));
  const semantica = { media: k.media, slug: embedder.modelSlug, versao };
  if (anel === 'provider' && !semFuncoes) {
    const f = await semanticaDoKairos('tool', capacidades, embedder);
    items = items.map((it) => {
      if (semSemanticaDe.includes(it.ref)) return it;
      const funcoes = [...f.porRef].filter(([ref]) => ref.startsWith(`${it.ref}/tool/`)).map(([ref, s]) => ({ ref, ...s }));
      return funcoes.length ? { ...it, semantica: { ...it.semantica, funcoes } } : it;
    });
    if (f.media) semantica.mediaFuncoes = f.media;
  }
  return { ...input, items, semantica };
};

/**
 * O que o orchestrator entrega depois do `reindex` (`manager.semantica()`, Kairos 0.838): o catálogo INTEIRO por anel, e
 * `registrarCatalogoSemantico` o transforma no retrato e no índice do treino. `aneis` limita os anéis; anel sem nós/média fica de fora.
 */
const snapshotDoCatalogo = async (capacidades, embedder, { versao = 'v-cat', aneis = ['provider', 'tool', 'skill'] } = {}) => {
  const out = {};
  for (const anel of aneis) {
    const k = await semanticaDoKairos(anel, capacidades, embedder);
    if (k.media && k.porRef.size) out[anel] = { itens: k.porRef, media: k.media, versao };
  }
  return { slug: embedder.modelSlug, aneis: out };
};
const registrarK = async (dir, capacidades, embedder, opts) => { registrarCatalogoSemantico(dir, await snapshotDoCatalogo(capacidades, embedder, opts)); };

test('config: padrão, override válido e inválido', () => {
  _limparSelecaoParaTestes();
  capturarAvisos(() => {
    assert.deepEqual(configDaSelecao({}).modos, SELECAO_PADRAO.modos);
    assert.equal(configDaSelecao({"modos":{"tool":"jev"}}).modos.tool, 'jev');
    assert.equal(configDaSelecao({"modos":{"tool":"xpto"}}).modos.tool, SELECAO_PADRAO.modos.tool);
    assert.deepEqual(configDaSelecao(undefined).modos, SELECAO_PADRAO.modos);
  });
});

test('config: cortes fixos padrão; override por origem (cabeca/base/promocao), funcaoTrazCapacidade e minCasosCapacidade válidos', () => {
  _limparSelecaoParaTestes();
  const padrao = configDaSelecao({});
  assert.deepEqual(padrao.cortes, CORTES_FIXOS);
  assert.deepEqual(padrao.cortesOrigem, { cabeca: 'fixo', base: 'modelo', promocao: 'fixo', comKairos: 'fixo' });
  assert.deepEqual(padrao.funcaoTrazCapacidade, FUNCAO_TRAZ_PADRAO);
  assert.equal(padrao.minCasosCapacidade, 50);
  assert.deepEqual(SELECAO_PADRAO.cortes, CORTES_FIXOS);
  assert.notStrictEqual(padrao.cortes, CORTES_FIXOS, 'cópia: mutar a config não corrompe o padrão do processo');
  const env = {
    cortes: { cabeca: { full: 0.4, candidate: 0.2 }, promocao: 0.8 },
    funcaoTrazCapacidade: { n: 3, promoverFull: 'sempre', candidata: 0.5, ativo: false },
    minCasosCapacidade: 10,
  };
  const c = configDaSelecao(env);
  assert.deepEqual(c.cortes, { cabeca: { full: 0.4, candidate: 0.2 }, base: CORTES_FIXOS.base, promocao: 0.8, comKairos: CORTES_FIXOS.comKairos });
  assert.deepEqual(c.cortesOrigem, { cabeca: 'override', base: 'modelo', promocao: 'override', comKairos: 'fixo' });
  assert.deepEqual(c.funcaoTrazCapacidade, { ativo: false, n: 3, candidata: 0.5, promoverFull: 'sempre' });
  assert.equal(c.minCasosCapacidade, 10);
  assert.equal(configDaSelecao({"minCasosCapacidade":0}).minCasosCapacidade, 0, 'zero é válido (desliga a D5)');
});

test('config: atrasoSombraJevMs padrão 500, override inteiro ≥ 0, inválido cai no padrão', () => {
  _limparSelecaoParaTestes();
  assert.equal(configDaSelecao({}).atrasoSombraJevMs, 500);
  assert.equal(configDaSelecao({"atrasoSombraJevMs":0}).atrasoSombraJevMs, 0);
  assert.equal(configDaSelecao({"atrasoSombraJevMs":-1}).atrasoSombraJevMs, 500);
});

test('config: inválidos caem no padrão; o formato antigo cortes.<anel> é ignorado; cada aviso sai UMA vez por processo', () => {
  _limparSelecaoParaTestes();
  const env = {
    cortes: { provider: { full: 0.5, candidate: 0.1 }, base: { full: 2, candidate: 0 }, promocao: 7 },
    funcaoTrazCapacidade: { n: 99, promoverFull: 'xpto' },
    minCasosCapacidade: -1,
  };
  let cfg;
  const primeira = capturarAvisos(() => { cfg = configDaSelecao(env); });
  assert.deepEqual(cfg.cortes, CORTES_FIXOS, 'tudo inválido: padrão');
  assert.deepEqual(cfg.cortesOrigem, { cabeca: 'fixo', base: 'modelo', promocao: 'fixo', comKairos: 'fixo' });
  assert.deepEqual(cfg.funcaoTrazCapacidade, FUNCAO_TRAZ_PADRAO);
  assert.equal(cfg.minCasosCapacidade, 50);
  const texto = primeira.join('\n');
  assert.match(texto, /formato antigo por anel ignorado/);
  assert.match(texto, /cortes\.base inválido/);
  assert.match(texto, /cortes\.promocao inválido/);
  assert.match(texto, /funcaoTrazCapacidade\.n inválido/);
  assert.match(texto, /funcaoTrazCapacidade\.promoverFull inválido/);
  assert.match(texto, /minCasosCapacidade inválido/);
  assert.equal(new Set(primeira).size, primeira.length, 'sem aviso repetido dentro da mesma chamada');
  // configDaSelecao roda a cada SESSÃO: a segunda e a terceira não repetem nenhum aviso
  const depois = capturarAvisos(() => { configDaSelecao(env); configDaSelecao(env); });
  assert.deepEqual(depois, []);
  // o que não é objeto (a fábrica não faz JSON.parse: o host entrega o objeto) também avisa uma vez só; `undefined` não avisa
  const naoObjeto = capturarAvisos(() => { configDaSelecao('{quebrado'); configDaSelecao('{quebrado'); configDaSelecao([1]); configDaSelecao(null); });
  assert.equal(naoObjeto.filter((m) => /configuração não é objeto/.test(m)).length, 1);
  assert.deepEqual(capturarAvisos(() => { configDaSelecao(undefined); }), []);
});

test('config: chave de topo desconhecida e `modos` que não é objeto avisam UMA vez cada (nunca um aviso por caractere); chave desconhecida em cortes também; config toda válida não avisa nada', () => {
  _limparSelecaoParaTestes();
  const env = { modoz: { tool: 'jev' }, modos: 'local', cortes: { 'cabeça': { full: 0.4, candidate: 0.2 } } };
  let cfg;
  const primeira = capturarAvisos(() => { cfg = configDaSelecao(env); });
  assert.deepEqual(cfg.modos, SELECAO_PADRAO.modos, 'modos string: padrão');
  assert.deepEqual(cfg.cortes, CORTES_FIXOS, 'a chave desconhecida de cortes não vale como override');
  assert.deepEqual(primeira, [
    '[fabrica] seleção: opção desconhecida modoz — ignorada',
    '[fabrica] seleção: modos inválido (objeto anel → modo) — usando o padrão',
    '[fabrica] seleção: cortes.cabeça: chave desconhecida — ignorada — usando o padrão',
  ]);
  assert.deepEqual(capturarAvisos(() => { configDaSelecao(env); configDaSelecao(env); }), [], 'a cada sessão roda de novo, mas cada motivo vale uma vez por processo');
  // modos de outro tipo que não objeto: um aviso cada (null e array também), nunca um por elemento/caractere
  for (const modos of [['tool', 'jev'], 42, null, 'provider']) {
    _limparSelecaoParaTestes();
    const avisos = capturarAvisos(() => { configDaSelecao({ modos }); });
    assert.deepEqual(avisos, ['[fabrica] seleção: modos inválido (objeto anel → modo) — usando o padrão'], JSON.stringify(modos));
  }
  // as quatro chaves documentadas, todas válidas: nenhum aviso (modos ausente também não avisa)
  _limparSelecaoParaTestes();
  const limpo = capturarAvisos(() => {
    configDaSelecao({ modos: { tool: 'jev' }, cortes: { cabeca: { full: 0.4, candidate: 0.2 }, base: { full: 0.4, candidate: 0.2 }, promocao: 0.8 }, funcaoTrazCapacidade: { n: 3 }, minCasosCapacidade: 10 });
    configDaSelecao({ minCasosCapacidade: 10 });
  });
  assert.deepEqual(limpo, []);
});

test('modoDe devolve o modo configurado do anel', () => {
  const { sel } = nova({"modos":{"tool":"local"}});
  assert.equal(sel.modoDe('tool'), 'local');
  assert.equal(sel.modoDe('provider'), 'local+sombra-jev');
  assert.equal(sel.modoDe('skill'), 'jev+sombra-local');
});

// ---- Índice derivado do RefineInput ----
test('(a) o 1º refine de uma sessão NOVA já decide: índice derivado do input, nada montado fora dele (sem aquecimento nem espera)', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const t0 = Date.now();
  const r1 = await refs.provider(await K(await entradaProvider(), caps(), emb));
  assert.ok(Date.now() - t0 < 250);
  assert.equal(trace.porAnel.provider.estado, 'pronto');
  assert.equal(trace.porAnel.provider.versaoKairos, 'v-teste');
  assert.equal(trace.porAnel.provider.itensSemSemantica, 0);
  assert.deepEqual(trace.porAnel.provider.calibracao, { origem: 'ausente', hash: null });
  assert.deepEqual(r1.full, ['agenda']);
  assert.equal(trace.decisoes.provider.degradado, false);
  // sombra do Jev (modo padrão do provider) registrada normalmente — sem o atraso padrão de 500 ms, para o tick bastar
  const { sel: selSemAtraso } = nova({"atrasoSombraJevMs":0});
  const trace2 = novoTrace();
  const refs2 = selSemAtraso.refinadores({ jev: jevProvider, trace: trace2 });
  await refs2.provider(await K(await entradaProvider(), caps(), emb));
  await tick();
  const ultima = trace2.sombras.at(-1);
  assert.equal(ultima.estado, 'respondida');
  assert.equal(ultima.principalDe, 'local');
  assert.equal(ultima.sombraDe, 'jev');
  assert.deepEqual(ultima.principal.full, ['agenda']);
  // o decisor não grava cache de embeddings: o do catálogo é do orchestrator (cache-semantica)
  assert.ok(!existsSync(join(dir, 'igris', 'cache', 'selecao-embeddings.json')));
  // nem a calibração: só o treino completo
  assert.ok(!existsSync(join(dir, 'decisoes', 'indice', 'provider-roubados.json')));
});

test('(b) a mesma `versao` da semântica reusa o memo (mesmo objeto de índice, mesmo entre sessões); versão nova deriva de novo; o memo é pequeno', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  const entrada = await entradaProvider();
  assert.equal(_memoDeDerivacoesParaTestes(), 0);
  await refs.provider(await K(entrada, caps(), emb));
  // o anel (1) e, se a D4b consultou, as funções do provider (1): `n1` derivações, nunca mais que isso por versão
  const n1 = _memoDeDerivacoesParaTestes();
  assert.ok(n1 >= 1 && n1 <= 2, `n1=${n1}`);
  await refs.provider(await K(entrada, caps(), emb));
  assert.equal(_memoDeDerivacoesParaTestes(), n1, 'mesma versão e mesmas refs: reusa');
  // outra sessão do mesmo processo e dataDir
  const refsB = criarSelecaoLocal({ dataDir: dir, config: configDaSelecao({}) }).refinadores({ jev: {}, trace: novoTrace() });
  await refsB.provider(await K(entrada, caps(), emb));
  assert.equal(_memoDeDerivacoesParaTestes(), n1, 'a segunda sessão reusa a derivação');
  // versão nova (catálogo mudou)
  await refs.provider(await K(entrada, caps(['agenda 99']), emb, { versao: 'v2' }));
  assert.equal(_memoDeDerivacoesParaTestes(), n1 * 2, 'a versão nova soma as suas derivações');
  // teto do memo
  for (let i = 0; i < MEMO_MAX + 3; i++) await refs.provider(await K(entrada, caps(), emb, { versao: `vv${i}` }));
  assert.equal(_memoDeDerivacoesParaTestes(), MEMO_MAX);
});

test('(b) sem `versao` não há memo, mas o refine funciona (deriva a cada chamada)', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  const entrada = await entradaProvider();
  const semVersao = async () => { const k = await K(entrada, caps(), emb); k.semantica.versao = undefined; return k; };
  assert.deepEqual((await refs.provider(await semVersao())).full, ['agenda']);
  assert.equal(_memoDeDerivacoesParaTestes(), 0);
});

test('C1: dois turnos com o MESMO número de itens e refs diferentes não compartilham o índice (a chave do memo leva as refs, em ordem)', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova({ modos: { tool: 'local' } });
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  const t1 = novoTrace(); const t2 = novoTrace(); const t3 = novoTrace();
  const r1 = sel.refinadores({ jev: {}, trace: t1 }).tool;
  const r2 = sel.refinadores({ jev: {}, trace: t2 }).tool;
  const r3 = sel.refinadores({ jev: {}, trace: t3 }).tool;
  void refs;
  await r1(await kTool(['a/tool/x', 'a/tool/y']));
  assert.equal(_memoDeDerivacoesParaTestes(), 1);
  const res2 = await r2(await kTool(['a/tool/y', 'b/tool/z']));
  assert.equal(_memoDeDerivacoesParaTestes(), 2, 'mesmo n (2), outro conjunto: outra derivação, não o índice do turno anterior');
  assert.ok(Number.isFinite(res2.explain['b/tool/z']?.confidence), 'z existe no índice do 2º turno (com o índice do 1º ficaria sem nota)');
  assert.match(String(res2.explain['b/tool/z'].reason), /^local:/);
  assert.doesNotMatch(String(res2.explain['b/tool/z'].reason), /degradado/);
  await r3(await kTool(['a/tool/y', 'b/tool/z']));
  assert.equal(_memoDeDerivacoesParaTestes(), 2, 'mesmas refs na mesma ordem: reusa');
  await r3(await kTool(['b/tool/z', 'a/tool/y']));
  assert.equal(_memoDeDerivacoesParaTestes(), 3, 'a ordem das refs faz parte da chave');
});

test('(c) sem `semantica` no input: degradado `sem-semantica` com a proposta do motor, sem lançar e sem índice em uso; semântica sem média idem', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const input = await entradaProvider();
  const r = await refs.provider(input);
  assert.match(r.explain.agenda.reason, /local:degradado \(sem-semantica\)/);
  assert.deepEqual(r.candidates, input.proposal.candidates, 'a proposta do motor');
  assert.deepEqual(trace.porAnel.provider, { estado: 'degradado', motivo: 'sem-semantica' });
  assert.equal(trace.decisoes.provider.degradado, true);
  assert.equal(indiceEmUso(dir, 'provider'), null);
  const semMedia = await refs.provider({ ...input, semantica: { slug: 'falso', versao: 'v-x' } });
  assert.match(semMedia.explain.agenda.reason, /local:degradado \(sem-semantica\)/);
  assert.deepEqual(trace.porAnel.provider, { estado: 'degradado', motivo: 'sem-semantica', versaoKairos: 'v-x' });
  // semântica boa logo depois: o anel decide (nada ficou preso)
  assert.deepEqual((await refs.provider(await K(input, caps(), emb))).full, ['agenda']);
  assert.equal(trace.porAnel.provider.estado, 'pronto');
});

test('embedder que não devolve vetor: média ausente → degradado `sem-semantica`; anel sem nenhum item com semântica → `sem-nos`', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const mudo = { modelSlug: 'falso', async embed() { return null; } };
  const r = await refs.provider(await K(await entradaProvider(), caps(), mudo));
  assert.match(r.explain.agenda.reason, /local:degradado \(sem-semantica\)/);
  const r2 = await refs.provider(await K(await entradaProvider(), caps(), emb, { semSemanticaDe: ['agenda', 'tarefas'], semFuncoes: true }));
  assert.match(r2.explain.agenda.reason, /local:degradado \(sem-nos\)/);
  assert.equal(trace.porAnel.provider.motivo, 'sem-nos');
});

test('itens sem semântica ficam como o motor propôs e são contados no trace (`itensSemSemantica`), sem derrubar o anel', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const r = await refs.provider(await K(await entradaProvider(), caps(), emb, { semSemanticaDe: ['tarefas'] }));
  assert.equal(trace.porAnel.provider.estado, 'pronto');
  assert.equal(trace.porAnel.provider.itensSemSemantica, 1);
  assert.deepEqual(r.full, ['agenda']);
  assert.ok(r.candidates.includes('tarefas'), 'sem nota: fica como o motor propôs (fixo)');
  assert.equal(r.explain.tarefas, undefined);
});

test('(e) retrato (`indice/<anel>.json`): gravado pelo CATÁLOGO INTEIRO, só quando a `versao` muda, com `hash` = hashDosNos dos nós com texto (não a versão do Kairos), mesma regra e mesmo formato', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  const arq = join(dir, 'decisoes', 'indice', 'provider.json');
  const entrada = await entradaProvider();
  // o turno NÃO grava retrato (mesmo com itens e semântica no input)
  await refs.provider(await K(entrada, caps(), emb));
  assert.ok(!existsSync(arq), 'o turno não grava retrato');
  assert.equal(indiceEmUso(dir, 'provider'), null, 'nem alimenta indiceEmUso');
  await registrarK(dir, caps(), emb);
  const r1 = JSON.parse(readFileSync(arq, 'utf8'));
  assert.equal(r1.hash, hashDosNos(nosDoAnel('provider', caps())), 'hash do retrato = hashDosNos(nós com textos), o que o treino compara');
  assert.notEqual(r1.hash, 'v-teste');
  assert.equal(r1.versao, 1);
  assert.equal(r1.anel, 'provider');
  assert.equal(r1.slug, 'falso');
  assert.equal(r1.regra, 'irmao-nao-rouba');
  assert.deepEqual(r1.nos, nosDoAnel('provider', caps()), 'nós no formato de nosDoAnel');
  // mesma versão: não revisita o arquivo (adulterado fica como está)
  writeFileSync(arq, JSON.stringify({ ...r1, hash: 'adulterado' }));
  await registrarK(dir, caps(), emb);
  await registrarK(dir, caps(), emb);
  await refs.provider(await K(entrada, caps(), emb, { versao: 'v-outra' })); // o turno com outra versão também não mexe
  assert.equal(JSON.parse(readFileSync(arq, 'utf8')).hash, 'adulterado', 'mesma versão: nada regravado');
  // versão nova: regravado
  await registrarK(dir, caps(['agenda 99']), emb, { versao: 'v2' });
  const r2 = JSON.parse(readFileSync(arq, 'utf8'));
  assert.equal(r2.hash, hashDosNos(nosDoAnel('provider', caps(['agenda 99']))));
  // versão nova mas conteúdo igual ao já gravado: não reescreve (geradoEm intacto)
  await registrarK(dir, caps(['agenda 99']), emb, { versao: 'v3' });
  assert.equal(JSON.parse(readFileSync(arq, 'utf8')).geradoEm, r2.geradoEm);
  // retrato de antes da regra (sem `regra`) com o mesmo hash é regravado
  const { regra, ...velho } = r2;
  writeFileSync(arq, JSON.stringify({ ...velho, geradoEm: 'antigo' }));
  await registrarK(dir, caps(['agenda 99']), emb, { versao: 'v4' });
  const r4 = JSON.parse(readFileSync(arq, 'utf8'));
  assert.equal(r4.regra, 'irmao-nao-rouba');
  assert.notEqual(r4.geradoEm, 'antigo');
  assert.ok(!existsSync(join(dir, 'decisoes', 'indice', 'provider-roubados.json')), 'o runtime nunca grava a calibração');
});

test('retrato e índice em uso vêm do catálogo INTEIRO, não dos itens do turno (C2): turno com 1 item, catálogo com 2 capacidades', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const entrada = await entradaProvider();
  const soAgenda = { ...entrada, items: entrada.items.filter((it) => it.ref === 'agenda') };
  await sel.refinadores({ jev: {}, trace: novoTrace() }).provider(await K(soAgenda, caps(), emb));
  await registrarK(dir, caps(), emb);
  const ret = JSON.parse(readFileSync(join(dir, 'decisoes', 'indice', 'provider.json'), 'utf8'));
  assert.deepEqual(ret.nos.map((n) => n.ref), ['agenda', 'tarefas'], 'n nós = catálogo');
  assert.deepEqual([...indiceEmUso(dir, 'provider').indice.nos.keys()], ['agenda', 'tarefas']);
  // anel tool: o catálogo inteiro de funções (não só as do turno)
  assert.deepEqual([...indiceEmUso(dir, 'tool').indice.nos.keys()], ['agenda/tool/gcal', 'tarefas/tool/task']);
  assert.equal(indiceEmUso(dir, 'skill'), null, 'anel sem nós no catálogo: nada em uso');
  // snapshot nulo / sem anéis / lixo: não faz nada e não lança
  assert.doesNotThrow(() => { registrarCatalogoSemantico(dir, null); registrarCatalogoSemantico(dir, {}); registrarCatalogoSemantico(dir, { aneis: { provider: { itens: null, media: [1], versao: 'x' } } }); });
});

test('(f) indiceEmUso: null antes do catálogo do Kairos; depois o índice do catálogo (com o hash do retrato) e a cabeça daquele estado, no formato v2 do anel', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  assert.equal(indiceEmUso(dir, 'provider'), null);
  const c = novaCabeca({ d: 4, posto: 2, seed: 0 });
  const v = gravarVersao(join(dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.55, n: 60 }, metricas: {}, nTreinoPorCapacidade: { agenda: 80, tarefas: 3 } }));
  assert.equal(v.ok, true);
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: jevProvider, trace });
  await refs.provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual(trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
  assert.equal(indiceEmUso(dir, 'provider'), null, 'o turno não alimenta o índice em uso');
  await registrarK(dir, caps(), emb, { aneis: ['provider'] });
  const e = indiceEmUso(dir, 'provider');
  assert.deepEqual(Object.keys(e).sort(), ['anelAprovado', 'cabeca', 'indice', 'metricasAnel', 'nTreinoPorCapacidade', 'slug'], 'sem aprovadas nem cortes');
  assert.ok(e.indice.nos.has('agenda'));
  assert.equal(e.indice.hash, hashDosNos(nosDoAnel('provider', caps())), 'o hash que o lote grava na cabeça é o do retrato');
  assert.equal(e.slug, 'falso');
  assert.equal(e.cabeca.posto, 2);
  assert.equal(e.anelAprovado, true);
  assert.deepEqual(e.metricasAnel, { base: 0.4, cabeca: 0.55, n: 60 });
  assert.deepEqual(e.nTreinoPorCapacidade, { agenda: 80, tarefas: 3 });
  assert.equal(indiceEmUso('/outro-dir', 'provider'), null);
  assert.equal(indiceEmUso(dir, 'tool'), null, 'cada anel tem o seu');
  // catálogo novo (versão nova) → índice novo
  await registrarK(dir, caps(['agenda 99']), emb, { versao: 'v2', aneis: ['provider'] });
  assert.equal(indiceEmUso(dir, 'provider').indice.nos.get('agenda').textos.length, 14);
  // anel sem cabeça: defaults seguros (o lote trata como "sem versão em uso")
  const { dir: dir2, sel: sel2 } = nova();
  await registrarK(dir2, caps(), emb);
  const vazio = indiceEmUso(dir2, 'provider');
  assert.equal(vazio.cabeca, null); assert.equal(vazio.anelAprovado, false); assert.equal(vazio.metricasAnel, null); assert.deepEqual(vazio.nTreinoPorCapacidade, {});
});

test('(g) invalidarSelecaoLocal: descarta só o anel/dataDir pedidos; a cabeça é RELIDA no refine seguinte e o índice em uso é remontado do último catálogo com a cabeça nova', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const entrada = await entradaProvider();
  await refs.provider(await K(entrada, caps(), emb));
  await registrarK(dir, caps(), emb);
  assert.equal(trace.porAnel.provider.estadoDoAnel, 'base');
  assert.deepEqual(trace.porAnel.provider.cabeca, { motivo: 'sem-arquivo' });
  assert.equal(indiceEmUso(dir, 'provider').anelAprovado, false);
  // o treino grava a cabeça nova DEPOIS: sem invalidar o processo segue com o que leu
  const c = novaCabeca({ d: 4, posto: 2, seed: 0 });
  assert.equal(gravarVersao(join(dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, nTreinoPorCapacidade: { agenda: 80 } })).ok, true);
  await refs.provider(await K(entrada, caps(), emb));
  assert.equal(trace.porAnel.provider.estadoDoAnel, 'base', 'cabeça em cache: ainda a antiga');
  assert.equal(invalidarSelecaoLocal(dir, 'skill'), 0); // outro anel: nada
  assert.equal(invalidarSelecaoLocal('/outro-dir', 'provider'), 0); // outro dataDir: nada
  assert.ok(indiceEmUso(dir, 'provider'));
  assert.ok(invalidarSelecaoLocal(dir, 'provider') > 0);
  assert.equal(invalidarSelecaoLocal(dir, 'provider'), 0); // idempotente
  const retratoAntes = readFileSync(join(dir, 'decisoes', 'indice', 'provider.json'), 'utf8');
  assert.equal(indiceEmUso(dir, 'provider').anelAprovado, true, 'remontado do último catálogo com a cabeça NOVA: o lote nunca treina com a velha nem fica sem índice');
  assert.equal(readFileSync(join(dir, 'decisoes', 'indice', 'provider.json'), 'utf8'), retratoAntes, 'a remontagem não regrava o retrato');
  assert.equal(invalidarSelecaoLocal('/outro-dir', 'provider'), 0);
  await refs.provider(await K(entrada, caps(), emb));
  assert.equal(trace.porAnel.provider.estadoDoAnel, 'cabeca', 'a cabeça nova foi relida');
  assert.deepEqual(trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
  assert.equal(indiceEmUso(dir, 'provider').anelAprovado, true);
});

test('modo jev sem cliente: anel fica sem refinador', () => {
  const { sel } = nova({"modos":{"skill":"jev"}});
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  assert.equal(refs.skill, undefined);
});

test('ativo=false (DECISOR=0): sem refinadores locais e o trace registra o motivo', () => {
  const { sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace, ativo: false });
  assert.deepEqual(refs, {});
  assert.equal(serializarSelecao(trace).desligado, 'decisor-0');
});

test('serializarSelecao não leva mais `igualdade` (a transição acabou) nem a cobertura', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const trace = novoTrace();
  await sel.refinadores({ jev: {}, trace }).provider(await K(await entradaProvider(), caps(), emb));
  const s = serializarSelecao(trace);
  assert.equal('igualdade' in s, false);
  assert.equal(JSON.stringify(s).includes('igualdade'), false);
});

test('override de cortes pela config chega ao estado como origem: override; a calibração não recebe mais override e só sugere', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova({"cortes":{"cabeca":{"full":0.5,"candidate":0.1}}});
  gravarCalibracaoMantida(dir, 'provider', { slug: 'falso', cortesSugeridos: { origem: 'calculado', full: 0.3, candidate: 0.1 } });
  const trace = novoTrace();
  await sel.refinadores({ jev: {}, trace }).provider(await K(await entradaProvider(), caps(), emb));
  const p = trace.porAnel.provider;
  assert.deepEqual(p.cortes, { origem: { cabeca: 'override', base: 'modelo', promocao: 'fixo', comKairos: 'fixo' }, cabeca: { full: 0.5, candidate: 0.1 }, base: CORTES_FIXOS.base, promocao: CORTES_FIXOS.promocao, comKairos: CORTES_FIXOS.comKairos });
  // cortesSugeridos é o que o histórico (p10/p98) sugeriria — vem da calibração mantida, nunca do override
  assert.equal(p.cortesSugeridos.origem, 'calculado');
  assert.equal(typeof p.cortesSugeridos.full, 'number');
  assert.ok(p.cortesSugeridos.candidate <= p.cortesSugeridos.full);
});

test('estado do anel no trace: base sem cabeça; cabeça v2 aprovada → cabeca; anel reprovado → base', async () => {
  _limparSelecaoParaTestes();
  const sem = nova();
  const t1 = novoTrace();
  await sem.sel.refinadores({ jev: {}, trace: t1 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.equal(t1.porAnel.provider.estadoDoAnel, 'base');
  assert.deepEqual(t1.porAnel.provider.cortes.origem, { cabeca: 'fixo', base: 'modelo', promocao: 'fixo', comKairos: 'fixo' });
  assert.deepEqual(t1.porAnel.provider.cabeca, { motivo: 'sem-arquivo' });

  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const c = novaCabeca({ d: 4, posto: 2, seed: 0 });
  assert.equal(gravarVersao(join(dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, nTreinoPorCapacidade: { agenda: 80 } })).ok, true);
  const t2 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t2 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.equal(t2.porAnel.provider.estadoDoAnel, 'cabeca');
  assert.deepEqual(t2.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
  // anel reprovado (anelAprovado:false) na mesma versão: a cabeça existe mas o anel fica na base
  _limparSelecaoParaTestes();
  const { dir: dir3, sel: sel3 } = nova();
  gravarVersao(join(dir3, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: false }));
  const t3 = novoTrace();
  await sel3.refinadores({ jev: {}, trace: t3 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.equal(t3.porAnel.provider.estadoDoAnel, 'base');
  assert.deepEqual(t3.porAnel.provider.cabeca, { anelAprovado: false, versaoDoArquivo: 2 });
});

test('a cabeça é presa à dimensão da semântica do Kairos: cabeça de outra dimensão é ignorada com um aviso', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const c = novaCabeca({ d: 3, posto: 2, seed: 0 });
  assert.equal(gravarVersao(join(dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true })).ok, true);
  const trace = novoTrace();
  const avisos = await comAvisosCapturados(async () => {
    const refs = sel.refinadores({ jev: {}, trace });
    await refs.provider(await K(await entradaProvider(), caps(), emb));
    await refs.provider(await K(await entradaProvider(), caps(), emb, { versao: 'v2' }));
  });
  assert.equal(trace.porAnel.provider.estadoDoAnel, 'base');
  assert.deepEqual(trace.porAnel.provider.cabeca, { motivo: 'outra-dimensao' });
  assert.equal(avisos.filter((a) => /cabeça ignorada \(outra-dimensao\)/.test(a)).length, 1);
});

test('cabeça com slug divergente: usa a base e avisa uma vez só', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  mkdirSync(join(dir, 'decisoes', 'cabecas'), { recursive: true });
  writeFileSync(join(dir, 'decisoes', 'cabecas', 'provider.json'), JSON.stringify({ versao: 1, slug: 'outro-modelo', hash: 'x', d: 4 }));
  const trace = novoTrace();
  const avisos = await comAvisosCapturados(async () => {
    const refs = sel.refinadores({ jev: {}, trace });
    const input = await entradaProvider();
    await refs.provider(await K(input, caps(), emb));
    await refs.provider(await K(input, caps(['agenda 77']), emb, { versao: 'v2' })); // catálogo novo: o motivo é o mesmo
    const r = await refs.provider(await K(input, caps(['agenda 77']), emb, { versao: 'v2' }));
    assert.deepEqual(r.full, ['agenda'], 'usa a base');
    assert.deepEqual(trace.porAnel.provider.cabeca, { motivo: 'outro-provider' });
  });
  assert.equal(avisos.filter((a) => a.includes('cabeça ignorada (outro-provider)')).length, 1);
});

test('ponteiro atual.json quebrado não cai em silêncio no legado: UM aviso por motivo, cabeca.legado:true no trace; sem legado, avisa e usa a base; ponteiro saudável e legado puro seguem sem aviso nem marca', async () => {
  const c = novaCabeca({ d: 4, posto: 2, seed: 0 });
  const cabeca = () => serializarCabeca(c, { anel: 'provider', slug: 'falso', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, nTreinoPorCapacidade: { agenda: 80 } });
  const rodar = async (sel, dir) => {
    const trace = novoTrace();
    const avisos = await comAvisosCapturados(async () => {
      const refs = sel.refinadores({ jev: jevProvider, trace });
      const input = await entradaProvider();
      await refs.provider(await K(input, caps(), emb)); await refs.provider(await K(input, caps(), emb));
      await registrarK(dir, caps(), emb);
    });
    return { trace, avisos: avisos.filter((m) => /atual\.json/.test(m)) };
  };
  const decisoes = (dir) => join(dir, 'decisoes');
  const legadoEm = (dir) => { mkdirSync(join(decisoes(dir), 'cabecas'), { recursive: true }); writeFileSync(join(decisoes(dir), 'cabecas', 'provider.json'), JSON.stringify(cabeca())); };
  const ponteiroEm = (dir, texto) => { mkdirSync(join(decisoes(dir), 'cabecas', 'provider'), { recursive: true }); writeFileSync(join(decisoes(dir), 'cabecas', 'provider', 'atual.json'), texto); };

  // (a) atual.json ilegível + legado válido: o legado serve, com aviso e marca no trace
  _limparSelecaoParaTestes();
  const a = nova(); legadoEm(a.dir); ponteiroEm(a.dir, '{quebrado');
  const ra = await rodar(a.sel, a.dir);
  assert.deepEqual(ra.avisos, ['[fabrica] seleção provider: atual.json ponteiro-ilegivel — usando a cabeça legada cabecas/provider.json']);
  assert.deepEqual(ra.trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2, legado: true });
  assert.equal(ra.trace.porAnel.provider.estadoDoAnel, 'cabeca', 'a decisão do turno não muda: a cabeça legada continua valendo');
  assert.equal(indiceEmUso(a.dir, 'provider').anelAprovado, true);

  // (b) ponteiro para versão que não existe: outro motivo, mesma forma
  _limparSelecaoParaTestes();
  const b = nova(); legadoEm(b.dir); ponteiroEm(b.dir, JSON.stringify({ versao: 3, arquivo: 'v3.json' }));
  const rb = await rodar(b.sel, b.dir);
  assert.deepEqual(rb.avisos, ['[fabrica] seleção provider: atual.json versao-ausente — usando a cabeça legada cabecas/provider.json']);
  assert.deepEqual(rb.trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2, legado: true });

  // (c) ponteiro quebrado e SEM legado: não há cabeça nenhuma; avisa que usa a base (não menciona legado) e o trace não finge legado
  _limparSelecaoParaTestes();
  const d = nova(); ponteiroEm(d.dir, '{quebrado');
  const rd = await rodar(d.sel, d.dir);
  assert.deepEqual(rd.avisos, ['[fabrica] seleção provider: atual.json ponteiro-ilegivel e sem cabeça legada — usando a base']);
  assert.deepEqual(rd.trace.porAnel.provider.cabeca, { motivo: 'sem-arquivo' });
  assert.equal(rd.trace.porAnel.provider.estadoDoAnel, 'base');

  // (d) o aviso é por processo: catálogo novo não repete; o treino reabre via invalidarSelecaoLocal (a cabeça pode ter mudado)
  _limparSelecaoParaTestes();
  const e = nova(); legadoEm(e.dir); ponteiroEm(e.dir, '{quebrado');
  const trace = novoTrace();
  const avisos = await comAvisosCapturados(async () => {
    const refs = e.sel.refinadores({ jev: jevProvider, trace });
    const input = await entradaProvider();
    await refs.provider(await K(input, caps(), emb));
    await refs.provider(await K(input, caps(['agenda 77']), emb, { versao: 'v2' }));
    assert.equal(trace.porAnel.provider.cabeca.legado, true);
    invalidarSelecaoLocal(e.dir, 'provider');
    await refs.provider(await K(input, caps(['agenda 77']), emb, { versao: 'v2' }));
  });
  assert.equal(avisos.filter((m) => /atual\.json/.test(m)).length, 2, 'uma vez por vida do aviso: a invalidação do treino o reabre');

  // (e) controles: ponteiro saudável e legado puro (sem atual.json) — nenhum aviso, nenhuma marca
  _limparSelecaoParaTestes();
  const f = nova();
  assert.equal(gravarVersao(decisoes(f.dir), 'provider', cabeca()).ok, true);
  const rf = await rodar(f.sel, f.dir);
  assert.deepEqual(rf.avisos, []); assert.deepEqual(rf.trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
  _limparSelecaoParaTestes();
  const g = nova(); legadoEm(g.dir);
  const rg = await rodar(g.sel, g.dir);
  assert.deepEqual(rg.avisos, []); assert.deepEqual(rg.trace.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
});

test('skill em jev+sombra-local ponta a ponta: Jev decide, local roda em sombra — e as skills de um 2º turno também entram no índice (vêm do input)', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const capsSkill = () => [{ id: 'hab', tools: [], skillsDeclaradas: [
    { key: 'agendar', semanticText: 'agenda', exemplos: exemplos('agenda') },
    { key: 'listar', semanticText: 'tarefa', exemplos: exemplos('tarefa') },
  ] }];
  const trace = novoTrace();
  const jev = { skill: async () => ({ full: ['hab/skill/listar'], candidates: [], explain: {} }) };
  const refs = sel.refinadores({ jev, trace });
  const input = {
    ring: 'skill', query: { text: 'agenda', vectors: [await emb.embed('agenda')] },
    items: [{ ref: 'hab/skill/agendar', position: 0, scores: {}, proposedTier: 'candidate', meta: {} }, { ref: 'hab/skill/listar', position: 1, scores: {}, proposedTier: 'candidate', meta: {} }],
    proposal: { full: [], candidates: ['hab/skill/agendar', 'hab/skill/listar'] }, caps: {}, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600,
  };
  const r = await refs.skill(await K(input, capsSkill(), emb));
  assert.deepEqual(r.full, ['hab/skill/listar'], 'o Jev decide');
  await tick();
  const s = trace.sombras.at(-1);
  assert.equal(s.principalDe, 'jev');
  assert.equal(s.sombraDe, 'local');
  assert.equal(s.estado, 'respondida');
  assert.equal(s.degradadoSombra, undefined, 'já no 1º refine o local da skill tem índice');
  assert.deepEqual(s.sombra.full, ['hab/skill/agendar'], 'o local, em sombra, escolheria outra');
  // 2º turno da sessão (o caminho próprio perdia as skills daqui em diante): o índice vem do input de novo
  const trace2 = novoTrace();
  const refs2 = sel.refinadores({ jev, trace: trace2 });
  await refs2.skill(await K(input, capsSkill(), emb));
  await tick();
  assert.deepEqual(trace2.sombras.at(-1).sombra.full, ['hab/skill/agendar']);
  assert.equal(trace2.porAnel.skill.estado, 'pronto');
});

test('treino contínuo: o trace recebe vetoresConsulta na primeira chamada e serializarSelecao não os leva', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: jevProvider, trace });
  const input = await entradaProvider();
  await refs.provider(await K(input, caps(), emb));
  assert.deepEqual(trace.vetoresConsulta, input.query.vectors);
  assert.notStrictEqual(trace.vetoresConsulta, input.query.vectors); // cópia rasa
  const outro = await entradaProvider();
  outro.query.vectors = [[9, 9, 9, 9]];
  await refs.provider(await K(outro, caps(), emb));
  assert.deepEqual(trace.vetoresConsulta, input.query.vectors, 'só a primeira chamada do turno guarda');
  assert.equal(JSON.stringify(serializarSelecao(trace)).includes('vetoresConsulta'), false);
});

test('contrato: query.vectors[0] é o vetor do PEDIDO — o trace guarda a lista na mesma ordem (o lote usa vetores[0])', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: jevProvider, trace });
  const input = await entradaProvider();
  const pista = [0.5, 0.5, 0.5, 0.5];
  input.query.vectors = [input.query.vectors[0], pista];
  await refs.provider(await K(input, caps(), emb));
  assert.deepEqual(trace.vetoresConsulta[0], await emb.embed('agenda'));
  assert.deepEqual(trace.vetoresConsulta[1], pista);
});

test('teto de full do local vem de config.tetos (ausente = sem limite); o maxFull do refino do Jev não vale mais para o local', async () => {
  _limparSelecaoParaTestes();
  const cortes = { base: { full: -1, candidate: -1 } }; // base: tudo passa a full
  const capsTres = () => ['agenda', 'agenda2', 'agenda3'].map((id, i) => ({ id, semanticText: 'agenda', tools: [{ name: 'a', exemplos: exemplos(`agenda ${i}`) }] }));
  const rodar = async (tetos, refino) => {
    const { sel } = nova({ modos: { provider: 'local' }, cortes, ...(tetos === undefined ? {} : { tetos }) });
    const trace = novoTrace();
    const refs = sel.refinadores({ jev: {}, trace, ...(refino ? { refino } : {}) });
    const input = await entradaProvider();
    input.items = ['agenda', 'agenda2', 'agenda3'].map((ref, position) => ({ ref, position, scores: {}, proposedTier: 'candidate', meta: {} }));
    const r = await refs.provider(await K(input, capsTres(), emb));
    return { r, trace };
  };
  const sem = await rodar(undefined);
  assert.equal(sem.r.full.length, 3, 'sem tetos: sem limite');
  assert.deepEqual(sem.trace.tetos, { provider: null, tool: null, promocao: null });
  assert.deepEqual(serializarSelecao(sem.trace).tetos, { provider: null, tool: null, promocao: null }, 'o trace leva os tetos efetivos ao fabrica.json');
  assert.equal((await rodar(undefined, { provider: { maxFull: 1 } })).r.full.length, 3, 'maxFull do refino do Jev não limita o local');
  const um = await rodar({ provider: 1 });
  assert.equal(um.r.full.length, 1);
  assert.equal(um.r.candidates.length, 2);
  assert.deepEqual(um.trace.tetos, { provider: 1, tool: null, promocao: null });
  assert.equal((await rodar({ provider: 0 })).r.full.length, 0);
  assert.equal((await rodar({ provider: 5 })).r.full.length, 3);
  assert.equal((await rodar({ provider: 'x' })).r.full.length, 3, 'inválido: ignorado (sem teto)');
});

test('configDaSelecao: tetos {provider, tool, promocao, kairosTools} — válido, inválido (avisa e ignora a chave) e ausente (sem limite)', () => {
  const avisos = [];
  const orig = console.warn; console.warn = (m) => avisos.push(String(m));
  try {
    _limparSelecaoParaTestes();
    assert.deepEqual(configDaSelecao({}).tetos, {});
    assert.deepEqual(configDaSelecao({}).tetos, {});
    assert.deepEqual(configDaSelecao({"tetos":{"provider":3,"tool":0,"promocao":2,"kairosTools":8}}).tetos, { provider: 3, tool: 0, promocao: 2, kairosTools: 8 });
    assert.equal(avisos.length, 0, 'válido não avisa');
    const ruim = configDaSelecao({"tetos":{"provider":-1,"tool":1.5,"promocao":"x","kairosTools":0,"skill":2}}).tetos;
    assert.deepEqual(ruim, {}, 'toda chave inválida é ignorada');
    for (const k of ['tetos.provider', 'tetos.tool', 'tetos.promocao', 'tetos.kairosTools', 'tetos.skill']) assert.ok(avisos.some((m) => m.includes(k)), `avisou ${k}`);
    assert.deepEqual(configDaSelecao({"tetos":{"provider":2,"tool":-3}}).tetos, { provider: 2 });
    avisos.length = 0;
    assert.deepEqual(configDaSelecao({"tetos":[1]}).tetos, {});
    assert.ok(avisos.some((m) => m.includes('tetos inválido')));
  } finally { console.warn = orig; }
});

test('treino contínuo: o trace registra SEMPRE a decisão do local (modo local sem sombra; local como sombra) e serializarSelecao a leva', async () => {
  _limparSelecaoParaTestes();
  // base.candidate -1: "tarefas" (fora do pedido, mas dentro da faixa) fica como candidate mesmo com os cortes fixos de produto
  const { sel } = nova({"modos":{"provider":"local","skill":"jev+sombra-local"},"cortes":{"base":{"full":0.35,"candidate":-1}}});
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: jevProvider, trace });
  await refs.provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual({ ...trace.decisoes.provider, notas: undefined }, { full: ['agenda'], candidates: ['tarefas'], degradado: false, notas: undefined });
  assert.equal(trace.decisoes.provider.notas.agenda.origem, 'base', 'nota e origem (base|cabeca|funcao) por ref');
  assert.match(trace.decisoes.provider.notas.agenda.reason, /^local:base \(/, 'e o motivo cru do refinador');
  assert.equal(typeof trace.decisoes.provider.notas.agenda.nota, 'number');
  assert.equal(trace.sombras.length, 0, 'modo local: nenhuma sombra');
  assert.deepEqual(serializarSelecao(trace).decisoes.provider.full, ['agenda']);
  // anel desligado do local (modo jev) não registra decisão
  const t2 = novoTrace();
  sel.refinadores({ jev: jevProvider, trace: t2 });
  assert.equal(t2.decisoes, undefined);
  assert.equal('decisoes' in serializarSelecao(t2), false);
});


// Anel tool: a/tool/x e a/tool/y são irmãs (mesma capacidade 'a'); b/tool/z é de outra capacidade. 'x-irmao' está em x mas casa melhor
// com y (irmã); 'x-rouba' está em x mas casa melhor com z (outra capacidade). Mesmo cenário de local-cortes.test.js (D3).
const TABELA_TOOL = {
  'x-texto': [1, 0, 0], x1: [0.99, 0.1, 0.05], 'x-irmao': [0.45, 0.8, 0.05], 'x-rouba': [0.45, 0.05, 0.8],
  'y-texto': [0, 1, 0], y1: [0.1, 0.98, 0.05], y2: [-0.1, 0.97, 0.1],
  'z-texto': [0, 0, 1], z1: [0.05, 0.1, 0.99], z2: [-0.05, -0.1, 0.98],
  pedido: [0.6, 0.6, 0.1],
};
const embTool = { modelSlug: 'falso-tool', async embed(t) { return TABELA_TOOL[String(t)] ?? null; } };
const capsTool = () => [
  { id: 'a', tools: [
    { name: 'x', semanticText: 'x-texto', exemplos: ['x1', 'x-irmao', 'x-rouba'] },
    { name: 'y', semanticText: 'y-texto', exemplos: ['y1', 'y2'] },
  ] },
  { id: 'b', tools: [{ name: 'z', semanticText: 'z-texto', exemplos: ['z1', 'z2'] }] },
];
const entradaTool = async (itens = ['a/tool/x', 'a/tool/y', 'b/tool/z'], extra = {}) => ({
  ring: 'tool', query: { text: 'pedido', vectors: [await embTool.embed('pedido')] },
  items: itens.map((ref, i) => ({ ref, position: i, scores: {}, proposedTier: 'candidate', meta: {} })),
  proposal: { full: [], candidates: itens }, caps: {}, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600, ...extra,
});
const kTool = async (itens, extra, opts) => K(await entradaTool(itens, extra), capsTool(), embTool, opts);

test('calibração mantida no app: aplica por ref+texto (irmão fica); trace separa removidos × irmãos; o runtime não recalibra nem regrava o arquivo', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const roubados = [
    { ref: 'a/tool/x', i: 1, texto: 'x-irmao', para: 'a/tool/y', irmao: true },
    { ref: 'a/tool/x', i: 99, texto: 'x-rouba', para: 'b/tool/z', irmao: false }, // `i` velho: o casamento é por texto
  ];
  gravarCalibracaoMantida(dir, 'tool', { slug: 'falso-tool', roubados, hash: 'h-do-treino' });
  const arq = join(dir, 'decisoes', 'indice', 'tool-roubados.json');
  const antes = readFileSync(arq, 'utf8');
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  await refs.tool(await kTool());
  assert.equal(trace.porAnel.tool.estado, 'pronto');
  assert.deepEqual(trace.porAnel.tool.roubados, { removidos: 1, irmaos: 1, mascarados: 0 });
  assert.deepEqual(trace.porAnel.tool.calibracao, { origem: 'mantida', hash: 'h-do-treino' });
  await registrarK(dir, capsTool(), embTool, { aneis: ['tool'] });
  const x = indiceEmUso(dir, 'tool').indice.nos.get('a/tool/x');
  assert.equal(x.vetores.length, 3, 'texto + 3 exemplos - 1 roubado por OUTRA capacidade');
  assert.ok(x.origens.some((o) => o.tipo === 'exemplo' && o.i === 1), 'o exemplo roubado pela irmã (i=1) continua');
  assert.ok(!x.origens.some((o) => o.tipo === 'exemplo' && o.i === 2), 'o roubado por outra capacidade (i=2) saiu');
  assert.equal(readFileSync(arq, 'utf8'), antes, 'o runtime não regrava a calibração mantida');
  // o retrato não perde nenhum exemplo (o treino remonta e aplica a mesma regra)
  const ret = JSON.parse(readFileSync(join(dir, 'decisoes', 'indice', 'tool.json'), 'utf8'));
  assert.equal(ret.nos.find((n) => n.ref === 'a/tool/x').textos.length, 4);
  assert.equal(ret.hash, hashDosNos(nosDoAnel('tool', capsTool())), 'e o hash é o dos nós COM todos os textos');
});

test('calibração mantida vazia NÃO é recalibrada: o roubo real (x-rouba) fica no índice; nó/texto novo fica inteiro', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  gravarCalibracaoMantida(dir, 'tool', { slug: 'falso-tool', roubados: [] });
  const trace = novoTrace();
  await sel.refinadores({ jev: {}, trace }).tool(await kTool());
  await registrarK(dir, capsTool(), embTool, { aneis: ['tool'] });
  assert.equal(indiceEmUso(dir, 'tool').indice.nos.get('a/tool/x').vetores.length, 4, 'nada removido: calibrar no runtime removeria x-rouba');
  assert.deepEqual(trace.porAnel.tool.roubados.removidos, 0);
});

test('sem calibração mantida (ausente, ilegível ou de outro embedder): deriva SEM remover, calibracao.origem=ausente, UM aviso por anel/processo, nada gravado', async () => {
  for (const [rotulo, prep, motivo] of [
    ['ausente', () => {}, 'sem-arquivo'],
    ['ilegivel', (dir) => { mkdirSync(join(dir, 'decisoes', 'indice'), { recursive: true }); writeFileSync(join(dir, 'decisoes', 'indice', 'tool-roubados.json'), '{quebrado'); }, 'ilegivel'],
    ['outro slug', (dir) => gravarCalibracaoMantida(dir, 'tool', { slug: 'outro', roubados: [{ ref: 'a/tool/x', i: 2, texto: 'x-rouba', para: 'b/tool/z', irmao: false }] }), 'outro-embedder'],
  ]) {
    _limparSelecaoParaTestes();
    const { dir, sel } = nova();
    prep(dir);
    const arq = join(dir, 'decisoes', 'indice', 'tool-roubados.json');
    const antes = existsSync(arq) ? readFileSync(arq, 'utf8') : null;
    const trace = novoTrace();
    const avisos = await comAvisosCapturados(async () => {
      const refs = sel.refinadores({ jev: {}, trace });
      await refs.tool(await kTool());
      invalidarSelecaoLocal(dir, 'zzz'); // outro anel: não reabre
      await refs.tool(await kTool());
    });
    assert.deepEqual(trace.porAnel.tool.calibracao, { origem: 'ausente', hash: null }, rotulo);
    await registrarK(dir, capsTool(), embTool, { aneis: ['tool'] });
    assert.equal(indiceEmUso(dir, 'tool').indice.nos.get('a/tool/x').vetores.length, 4, rotulo);
    const dos = avisos.filter((a) => /sem calibração mantida/.test(a));
    assert.equal(dos.length, 1, rotulo);
    assert.equal(dos[0], `[fabrica] seleção tool: sem calibração mantida (${motivo}) — índice sem remoção de roubados; rode o treino`);
    assert.equal(existsSync(arq) ? readFileSync(arq, 'utf8') : null, antes, `${rotulo}: o runtime não grava nada no lugar`);
  }
});

test('calibração mantida: a leitura boa é memorizada (arquivo trocado por fora não vale até invalidar); o arquivo que aparece depois entra sem invalidar; invalidarSelecaoLocal o relê', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const removidos = async () => { await refs.tool(await kTool()); return trace.porAnel.tool.roubados.removidos; };
  assert.equal(await removidos(), 0, 'sem arquivo: nada removido (e nada memorizado)');
  const roubo = [{ ref: 'a/tool/x', i: 2, texto: 'x-rouba', para: 'b/tool/z', irmao: false }];
  gravarCalibracaoMantida(dir, 'tool', { slug: 'falso-tool', roubados: roubo });
  assert.equal(await removidos(), 1, 'o treino gravou o arquivo: entra no refine seguinte, sem invalidar');
  gravarCalibracaoMantida(dir, 'tool', { slug: 'falso-tool', roubados: [] });
  assert.equal(await removidos(), 1, 'a leitura boa vem do memo');
  invalidarSelecaoLocal(dir, 'tool');
  assert.equal(await removidos(), 0, 'depois de invalidar o arquivo é relido');
});

test('cabeça v1 fora do provider é ignorada (centróides do tool/skill mudaram com "irmão não rouba"); no provider a v1 segue valendo; um aviso por processo', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const c = novaCabeca({ d: 3, posto: 2, seed: 1 });
  const v1 = (anel) => ({ versao: 1, anel, slug: 'falso-tool', hash: 'h', d: c.d, posto: c.posto, U: c.U, V: c.V, alfa: c.alfa, beta: c.beta, aprovadas: ['a'], cortes: { full: 0.3, candidate: 0.1 }, metricas: { a: { nTreino: 60 } } });
  assert.equal(gravarVersao(join(dir, 'decisoes'), 'tool', v1('tool')).ok, true);
  const trace = novoTrace();
  const avisos = await comAvisosCapturados(async () => {
    const refs = sel.refinadores({ jev: {}, trace });
    await refs.tool(await kTool());
    await refs.tool(await kTool());
    await refs.tool(await kTool(undefined, undefined, { versao: 'v2' }));
  });
  assert.deepEqual(trace.porAnel.tool.cabeca, { motivo: 'v1-fora-do-provider' });
  assert.equal(trace.porAnel.tool.estadoDoAnel, 'base');
  assert.equal(avisos.filter((a) => /cabeça v1 ignorada/.test(a)).length, 1);
  // a mesma v1 no provider vale (anelAprovado herdado: havia aprovadas)
  _limparSelecaoParaTestes();
  const { dir: dirP, sel: selP } = nova();
  const capsP = () => [{ id: 'a', semanticText: 'x-texto', tools: [{ name: 'x', exemplos: ['x1', 'x-irmao', 'x-rouba'] }] }, { id: 'b', semanticText: 'z-texto', tools: [{ name: 'z', exemplos: ['z1', 'z2'] }] }];
  assert.equal(gravarVersao(join(dirP, 'decisoes'), 'provider', v1('provider')).ok, true);
  const tP = novoTrace();
  const inP = { ...(await entradaTool(['a', 'b'])), ring: 'provider' };
  await selP.refinadores({ jev: {}, trace: tP }).provider(await K(inP, capsP(), embTool));
  assert.deepEqual(tP.porAnel.provider.cabeca, { anelAprovado: true, versaoDoArquivo: 1 });
  assert.equal(tP.porAnel.provider.estadoDoAnel, 'cabeca');
});

test('cabeça v2 aceita no anel tool; o legado cabecas/tool.json em v1 é ignorado (v1-fora-do-provider) com um aviso', async () => {
  const c = novaCabeca({ d: 3, posto: 2, seed: 1 });
  // (a) versão v2 aprovada, pelo ponteiro (atual.json): vale no tool, sem aviso
  _limparSelecaoParaTestes();
  const a = nova();
  assert.equal(gravarVersao(join(a.dir, 'decisoes'), 'tool', serializarCabeca(c, { anel: 'tool', slug: 'falso-tool', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, nTreinoPorCapacidade: { a: 60 } })).ok, true);
  const trA = novoTrace();
  const avisosA = await comAvisosCapturados(async () => {
    await a.sel.refinadores({ jev: {}, trace: trA }).tool(await kTool());
  });
  assert.deepEqual(trA.porAnel.tool.cabeca, { anelAprovado: true, versaoDoArquivo: 2 });
  assert.equal(trA.porAnel.tool.estadoDoAnel, 'cabeca');
  assert.deepEqual(avisosA.filter((m) => /cabeça/.test(m)), []);
  await registrarK(a.dir, capsTool(), embTool, { aneis: ['tool'] });
  const em = indiceEmUso(a.dir, 'tool');
  assert.equal(em.anelAprovado, true); assert.deepEqual(em.nTreinoPorCapacidade, { a: 60 });
  // (b) legado cabecas/tool.json (sem ponteiro) em v1: ignorado no tool
  _limparSelecaoParaTestes();
  const b = nova();
  mkdirSync(join(b.dir, 'decisoes', 'cabecas'), { recursive: true });
  writeFileSync(join(b.dir, 'decisoes', 'cabecas', 'tool.json'), JSON.stringify({ versao: 1, anel: 'tool', slug: 'falso-tool', hash: 'h', d: c.d, posto: c.posto, U: c.U, V: c.V, alfa: c.alfa, beta: c.beta, aprovadas: ['a'], cortes: { full: 0.3, candidate: 0.1 }, metricas: { a: { nTreino: 60 } } }));
  const trB = novoTrace();
  const avisosB = await comAvisosCapturados(async () => {
    const refs = b.sel.refinadores({ jev: {}, trace: trB });
    await refs.tool(await kTool()); await refs.tool(await kTool());
  });
  assert.deepEqual(trB.porAnel.tool.cabeca, { motivo: 'v1-fora-do-provider' });
  assert.equal(trB.porAnel.tool.estadoDoAnel, 'base');
  assert.equal(avisosB.filter((m) => /cabeça v1 ignorada/.test(m)).length, 1);
  await registrarK(b.dir, capsTool(), embTool, { aneis: ['tool'] });
  assert.equal(indiceEmUso(b.dir, 'tool').anelAprovado, false, 'o lote enxerga o anel sem cabeça em uso');
});

// Cenário dos anéis cruzados: `docs` tem duas funções (buscar, listar); o pedido ("pedido") está colado em docs/tool/buscar.
// Eixos: [agenda, docs-buscar, docs-listar, outra].
const TABELA_FN = {
  'ag-texto': [1, 0, 0, 0], 'ag-ler': [1, 0, 0, 0.05], ag1: [0.95, 0.1, 0, 0], ag2: [0.9, 0, 0.1, 0],
  'docs-texto': [0, 0.2, 0.2, 0], 'docs-buscar': [0, 1, 0, 0], bus1: [0.1, 0.95, 0, 0], bus2: [0, 0.9, 0.1, 0],
  'docs-listar': [0, 0, 1, 0], lis1: [0, 0.1, 0.95, 0],
  'outra-texto': [0, 0, 0, 1], out1: [0, 0, 0.1, 0.95], out2: [0.05, 0, 0, 0.9],
  pedido: [0.05, 1, 0.02, 0],
};
const embFn = { modelSlug: 'falso-fn', async embed(t) { return TABELA_FN[String(t)] ?? null; } };
const capsFn = () => [
  { id: 'agenda', semanticText: 'ag-texto', tools: [{ name: 'ler', semanticText: 'ag-ler', exemplos: ['ag1', 'ag2'] }] },
  { id: 'docs', semanticText: 'docs-texto', tools: [
    { name: 'buscar', semanticText: 'docs-buscar', exemplos: ['bus1', 'bus2'] },
    { name: 'listar', semanticText: 'docs-listar', exemplos: ['lis1'] },
  ] },
  { id: 'outra', semanticText: 'outra-texto', tools: [{ name: 'fazer', exemplos: ['out1', 'out2'] }] },
];
const entradaFn = async (ring, refs, extra = {}) => ({
  ring, query: { text: 'pedido', vectors: [await embFn.embed('pedido')] },
  items: refs.map((ref, position) => ({ ref, position, scores: {}, proposedTier: ring === 'tool' ? 'discard' : 'candidate', meta: {} })),
  proposal: { full: [], candidates: ring === 'tool' ? [] : refs }, caps: {}, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600, ...extra,
});
const kFn = async (ring, refs, extra, opts) => K(await entradaFn(ring, refs, extra), capsFn(), embFn, opts);
/** Cortes que descartam tudo no caminho da base do provider (nota < 1); a função é que traz a capacidade. */
const CFG_D4B = { modos: { provider: 'local', tool: 'local' }, cortes: { base: { full: 1, candidate: 1 } }, funcaoTrazCapacidade: { candidata: 0.3 } };

test('(d) D4b: o refinador do provider pontua as `funcoes` do próprio input — a função forte de uma capacidade descartada a traz como candidate, sem índice tool montado e sem gravar no trace do tool', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova(CFG_D4B);
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const r = await refs.provider(await kFn('provider', ['agenda', 'docs', 'outra']));
  assert.equal(trace.porAnel.provider.estado, 'pronto', 'já no 1º refine');
  assert.deepEqual(r.candidates, ['docs'], 'a função docs/tool/buscar (colada no pedido) traz a capacidade; agenda e outra seguem descartadas');
  assert.deepEqual(r.full, []);
  assert.match(r.explain.docs.reason, /^local:funcao-trouxe \(docs\/tool\/buscar 0\.\d{3}\)$/);
  assert.equal(trace.porAnel.tool, undefined, 'o getter cruzado não grava no trace.porAnel do outro anel');
  assert.deepEqual(trace.porAnel.provider.cruzado, { tool: 'pronto' });
  assert.equal(trace.decisoes.provider.notas.docs.origem, 'funcao', 'o caso do treino registra a origem funcao');
  assert.match(trace.decisoes.provider.notas.docs.reason, /^local:funcao-trouxe/);
  // o caso do treino guarda QUAL função trouxe a capacidade e a nota dela (a `nota` da entrada segue sendo a da capacidade)
  const nd = trace.decisoes.provider.notas.docs;
  assert.equal(nd.funcao.ref, 'docs/tool/buscar');
  assert.ok(nd.funcao.nota >= 0.3 && nd.funcao.nota <= 1);
  assert.equal(nd.funcao.nota, Math.round(nd.funcao.nota * 1e4) / 1e4, 'arredondada a 4 casas como a nota');
  assert.equal(nd.nota, Math.round(r.explain.docs.confidence * 1e4) / 1e4);
  assert.equal(trace.decisoes.provider.notas.agenda, undefined, 'só candidate/full têm nota registrada');
  // o anel tool não foi montado nem lido: nenhum índice em uso para ele
  assert.equal(indiceEmUso(dir, 'tool'), null);
});

test('D4b sem `funcoes` no input: desligada (o provider não degrada, nada traz a capacidade) e o cruzado diz `falhou`; semântica das funções quebrada diz `erro`', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova(CFG_D4B);
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  const r = await refs.provider(await kFn('provider', ['agenda', 'docs', 'outra'], undefined, { semFuncoes: true }));
  assert.deepEqual([r.full, r.candidates], [[], []]);
  assert.ok(Object.values(r.explain).every((x) => !x.reason.startsWith('local:degradado')), 'o provider não degrada por causa do tool');
  assert.deepEqual(trace.porAnel.provider.cruzado, { tool: 'falhou' });
  // semântica das funções que lança ao ser lida: cruzado `erro`, refine segue
  const quebrada = await kFn('provider', ['agenda', 'docs', 'outra']);
  const semantica = { ...quebrada.semantica };
  Object.defineProperty(semantica, 'mediaFuncoes', { get() { throw new Error('boom'); }, enumerable: true });
  const rq = await refs.provider({ ...quebrada, semantica });
  assert.deepEqual(trace.porAnel.provider.cruzado, { tool: 'erro' });
  assert.ok(Object.values(rq.explain).every((x) => !x.reason.startsWith('local:degradado')), 'erro no getter não derruba o refine');
});

test('D4b desligado por config (funcaoTrazCapacidade.ativo=false): nada muda mesmo com as funções no input, e o outro anel nem é consultado', async () => {
  _limparSelecaoParaTestes();
  const cfg = { modos: { provider: 'local', tool: 'local' }, cortes: { base: { full: 1, candidate: 1 } }, funcaoTrazCapacidade: { candidata: 0.3, ativo: false } };
  const { sel } = nova(cfg);
  const trace = novoTrace();
  const r = await sel.refinadores({ jev: {}, trace }).provider(await kFn('provider', ['agenda', 'docs', 'outra']));
  assert.deepEqual([r.full, r.candidates], [[], []]);
  assert.equal(trace.porAnel.provider.cruzado, undefined);
});

test('D4a: o refinador do tool lê só a cabeça do provider (marcador de índice) — sem cabeça (base) promove; na cabeça nunca promove; promoverFull "sempre" ignora o estado', async () => {
  const cfg = { modos: { provider: 'local', tool: 'local' }, cortes: { promocao: 0.2 } };
  const itens = ['docs/tool/buscar'];
  // (1) provider na BASE (sem cabeça): a função de capacidade nova (nota >= promocao) vira full — é a P1 do kairos
  _limparSelecaoParaTestes();
  const a = nova(cfg);
  await registrarK(a.dir, capsFn(), embFn, { aneis: ['provider'] });
  const trA = novoTrace();
  const base = await a.sel.refinadores({ jev: {}, trace: trA }).tool(await kFn('tool', itens));
  assert.deepEqual(base.full, itens);
  assert.match(base.explain['docs/tool/buscar'].reason, /^local:base \(/);
  assert.doesNotMatch(base.explain['docs/tool/buscar'].reason, /promocao/);
  assert.equal(trA.porAnel.provider, undefined, 'getter não grava no trace do provider');
  assert.deepEqual(trA.porAnel.tool.cruzado, { provider: 'pronto' });
  assert.notEqual(indiceEmUso(a.dir, 'provider').indice.somenteDaCabeca, true, 'o marcador não vira índice em uso do provider: o que está em uso é o índice do catálogo');
  // (2) provider na CABEÇA (v2 aprovada): nunca promove
  _limparSelecaoParaTestes();
  const b = nova(cfg);
  const c = novaCabeca({ d: 4, posto: 2, seed: 0 });
  assert.equal(gravarVersao(join(b.dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso-fn', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 } })).ok, true);
  await registrarK(b.dir, capsFn(), embFn, { aneis: ['provider'] });
  const trB = novoTrace();
  const cabeca = await b.sel.refinadores({ jev: {}, trace: trB }).tool(await kFn('tool', itens));
  assert.deepEqual([cabeca.full, cabeca.candidates], [[], itens]);
  assert.match(cabeca.explain['docs/tool/buscar'].reason, /\(promocao\)$/);
  // (3) promoverFull "sempre" ignora o estado do provider
  _limparSelecaoParaTestes();
  const d = nova({ modos: { provider: 'local', tool: 'local' }, cortes: { promocao: 0.2 }, funcaoTrazCapacidade: { promoverFull: 'sempre' } });
  assert.equal(gravarVersao(join(d.dir, 'decisoes'), 'provider', serializarCabeca(c, { anel: 'provider', slug: 'falso-fn', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 } })).ok, true);
  await registrarK(d.dir, capsFn(), embFn, { aneis: ['provider'] });
  assert.deepEqual((await d.sel.refinadores({ jev: {}, trace: novoTrace() }).tool(await kFn('tool', itens))).full, itens);
  // (5) M3: provider SEM catálogo (nenhum índice em uso): desconhecido, não "base" — não promove e o cruzado diz `falhou`
  _limparSelecaoParaTestes();
  const g = nova(cfg);
  const trG = novoTrace();
  const semCat = await g.sel.refinadores({ jev: {}, trace: trG }).tool(await kFn('tool', itens));
  assert.deepEqual([semCat.full, semCat.candidates], [[], itens]);
  assert.deepEqual(trG.porAnel.tool.cruzado, { provider: 'falhou' });
  // ...e catálogo registrado só do OUTRO embedder também não conta
  await registrarK(g.dir, capsFn(), { ...embFn, modelSlug: 'outro-slug' }, { aneis: ['provider'] });
  assert.deepEqual((await g.sel.refinadores({ jev: {}, trace: novoTrace() }).tool(await kFn('tool', itens))).full, []);
  // (4) capacidade do turno: o refine nem consulta o provider
  _limparSelecaoParaTestes();
  const e = nova(cfg);
  const trE = novoTrace();
  await e.sel.refinadores({ jev: {}, trace: trE }).tool(await kFn('tool', itens, { state: { loadedProviders: ['docs'] } }));
  assert.equal(trE.porAnel.tool.cruzado, undefined);
});

// Catálogo do teto de promoção: quatro capacidades de agenda (empate de nota) + uma de tarefas; o pedido é "agenda".
const capsTeto = () => [
  ...['a1', 'a2', 'a3', 'a4'].map((id) => ({ id, semanticText: 'agenda', tools: [{ name: 'f', semanticText: 'agenda', exemplos: ['agenda um', 'agenda dois'] }] })),
  { id: 'tarefas', semanticText: 'tarefa', tools: [{ name: 'g', semanticText: 'tarefa', exemplos: ['tarefa um'] }] },
];
/** Entrada do anel tool: as funções de `loaded` vêm como candidate (capacidade do turno), as outras como discard (capacidade de fora). */
const entradaTeto = async (loaded = [], caps4 = ['a1', 'a2', 'a3', 'a4']) => K({
  ring: 'tool', query: { text: 'agenda', vectors: [await emb.embed('agenda')] },
  items: caps4.map((id, position) => ({ ref: `${id}/tool/f`, position, scores: {}, proposedTier: loaded.includes(id) ? 'candidate' : 'discard', meta: {} })),
  proposal: { full: [], candidates: [] }, caps: {}, state: { loadedProviders: loaded }, ctx: {}, budgetMs: 600,
}, capsTeto(), emb);
const capsDeFull = (r) => [...new Set(r.full.map((ref) => ref.split('/')[0]))];

const cfgPromove = (promocao) => ({ modos: { tool: 'local' }, funcaoTrazCapacidade: { promoverFull: 'sempre' }, ...(promocao === undefined ? {} : { tetos: { promocao } }) });

test('teto de promoção: sem tetos.promocao nenhuma capacidade nova é barrada (só o corte filtra); tetos.promocao N limita a N; o maxFull do refino do Jev não vale', async () => {
  const turno = (promocao, refino = {}) => { _limparSelecaoParaTestes(); const { sel } = nova(cfgPromove(promocao)); const trace = novoTrace(); return { refs: sel.refinadores({ jev: {}, trace, refino }), trace }; };
  const sem = turno(undefined, { provider: { maxFull: 1 } });
  const dSem = await sem.refs.tool(await entradaTeto());
  assert.equal(dSem.full.length, 4, 'sem teto: as 4 capacidades novas ganham função full');
  assert.deepEqual(dSem.candidates, []);
  assert.equal(sem.trace.tetos.promocao, null);
  const dois = turno(2);
  const d2 = await dois.refs.tool(await entradaTeto());
  assert.equal(d2.full.length, 2);
  assert.match(d2.explain['a3/tool/f'].reason, /\(teto-promocao\)$/);
  assert.deepEqual(d2.candidates, ['a3/tool/f', 'a4/tool/f']);
  assert.equal(dois.trace.tetos.promocao, 2);
  assert.equal((await turno(1).refs.tool(await entradaTeto())).full.length, 1);
  assert.equal((await turno(3).refs.tool(await entradaTeto())).full.length, 3);
  assert.equal((await turno(0).refs.tool(await entradaTeto())).full.length, 0);
  assert.equal((await turno('x').refs.tool(await entradaTeto())).full.length, 4, 'inválido: ignorado (sem teto)');
});

test('teto de promoção POR TURNO: duas chamadas do tool no mesmo trace — no total, no máximo tetos.promocao capacidades novas ganham função full', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova(cfgPromove(2));
  const trace = novoTrace(); // um turno: um trace, um conjunto de refinadores
  const refs = sel.refinadores({ jev: {}, trace, refino: {} });
  assert.equal(trace.promovidasNoTurno, undefined);
  const d1 = await refs.tool(await entradaTeto());
  assert.deepEqual(capsDeFull(d1), ['a1', 'a2'], 'discover #1: duas novas ganham full; a3/a4 ficam em candidate (teto-promocao)');
  assert.deepEqual([...trace.promovidasNoTurno].sort(), ['a1', 'a2']);
  // discover #2 (I3a): o kairos promoveu os providers de d1 para loadedProviders; a3 e a4 seguem de fora
  const d2 = await refs.tool(await entradaTeto(['a1', 'a2']));
  assert.deepEqual(capsDeFull(d2).sort(), ['a1', 'a2'], 'sem vaga: a3/a4 não passam, mesmo sendo "novas" para esta chamada');
  assert.match(d2.explain['a3/tool/f'].reason, /\(teto-promocao\)$/);
  assert.match(d2.explain['a4/tool/f'].reason, /\(teto-promocao\)$/);
  const total = new Set([...d1.full, ...d2.full].map((r) => r.split('/')[0]));
  assert.equal(total.size, 2, 'no turno inteiro: 2 capacidades novas, não 4');
  assert.deepEqual([...trace.promovidasNoTurno].sort(), ['a1', 'a2'], 'as já carregadas não entram no Set');
  assert.equal(JSON.stringify(serializarSelecao(trace)).includes('promovidasNoTurno'), false, 'contabilidade interna: o fabrica.json não a leva');
  // a contabilidade é por trace: outro turno (outro trace) começa do zero
  const outro = sel.refinadores({ jev: {}, trace: novoTrace(), refino: {} });
  assert.deepEqual(capsDeFull(await outro.tool(await entradaTeto())), ['a1', 'a2']);
});

test('teto de promoção por turno: metade do teto já usada deixa a outra metade; tetos.promocao 1 esgota na 1ª chamada; só conta resposta do local que decide o anel e que não é degradada', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova(cfgPromove(3));
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace, refino: {} });
  // 1ª chamada só com a1 e a2 em jogo: 2 de 3 do teto usados
  const d1 = await refs.tool(await entradaTeto([], ['a1', 'a2']));
  assert.deepEqual(capsDeFull(d1), ['a1', 'a2']);
  // 2ª: sobra 1 vaga para as outras duas capacidades novas
  const d2 = await refs.tool(await entradaTeto(['a1', 'a2'], ['a1', 'a2', 'a3', 'a4']));
  assert.deepEqual(capsDeFull(d2).sort(), ['a1', 'a2', 'a3'], 'a3 usa a vaga que sobrou; a4 fica fora');
  assert.deepEqual([...trace.promovidasNoTurno].sort(), ['a1', 'a2', 'a3']);
  // maxFull 1: a 1ª chamada esgota o teto do turno
  const refs2 = nova(cfgPromove(1)).sel.refinadores({ jev: {}, trace: novoTrace(), refino: {} });
  assert.deepEqual(capsDeFull(await refs2.tool(await entradaTeto())), ['a1']);
  assert.deepEqual(capsDeFull(await refs2.tool(await entradaTeto())), [], 'a1 ainda é "nova" para o kairos (P1 recusada) mas o teto do turno já foi usado');
  // resposta degradada (sem semântica) é a proposta do motor, não decisão do local: não gasta o teto
  const t4 = novoTrace();
  const refs4 = sel.refinadores({ jev: {}, trace: t4, refino: {} });
  const { semantica, ...semSemantica } = await entradaTeto();
  await refs4.tool(semSemantica);
  assert.equal(t4.promovidasNoTurno, undefined);
  // modo em que o local é só sombra (jev+sombra-local): a resposta dele não vai ao kairos e não gasta o teto
  const { sel: selS } = nova({ modos: { tool: 'jev+sombra-local' }, funcaoTrazCapacidade: { promoverFull: 'sempre' }, tetos: { promocao: 2 } });
  const t3 = novoTrace();
  const refs3 = selS.refinadores({ jev: { tool: async () => ({ full: [], candidates: [], explain: {} }) }, trace: t3, refino: {} });
  await refs3.tool(await entradaTeto()); await tick();
  assert.equal(t3.promovidasNoTurno, undefined);
});

test('ativasNoInicio: o trace guarda state.loadedProviders da PRIMEIRA chamada do anel provider (mesmo degradada); só o provider; serializarSelecao o leva (sem o vetor)', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova({"modos":{"provider":"local","tool":"local"}});
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  // tool antes: não define
  await refs.tool({ ...(await entradaProvider()), ring: 'tool', items: [], state: { loadedProviders: ['tarefas'] } });
  assert.equal(trace.ativasNoInicio, undefined, 'só o anel provider define ativasNoInicio');
  // provider sem loadedProviders: não define
  const semEstado = await entradaProvider(); delete semEstado.state;
  await refs.provider(await K(semEstado, caps(), emb));
  assert.equal(trace.ativasNoInicio, undefined);
  const loaded = ['agenda'];
  const primeira = await entradaProvider(); primeira.state = { loadedProviders: loaded };
  await refs.provider(await K(primeira, caps(), emb));
  assert.deepEqual(trace.ativasNoInicio, ['agenda']);
  assert.notStrictEqual(trace.ativasNoInicio, loaded, 'cópia');
  loaded.push('mutado-depois');
  assert.deepEqual(trace.ativasNoInicio, ['agenda'], 'a mutação posterior do array do kairos não vaza');
  const segunda = await entradaProvider(); segunda.state = { loadedProviders: ['agenda', 'tarefas'] };
  await refs.provider(await K(segunda, caps(), emb));
  assert.deepEqual(trace.ativasNoInicio, ['agenda'], 'só a primeira chamada do turno vale');
  assert.deepEqual(serializarSelecao(trace).ativasNoInicio, ['agenda'], 'sai no fabrica.json (o inspetor explica a origem com ele); o vetor da consulta continua fora');
  assert.equal(JSON.stringify(serializarSelecao(trace)).includes('vetoresConsulta'), false);
  // lista vazia (nada carregado no início) é um valor válido e fica registrado como []
  const t2 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t2 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual(t2.ativasNoInicio, []);
  // sem semântica o refine degrada, mas registra do mesmo jeito
  const t3 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t3 }).provider(await entradaProvider());
  assert.deepEqual(t3.ativasNoInicio, []);
});

test('ativasNoInicio chega ao refinador do provider A CADA chamada: o 2º refine do turno não trata como "carregada" a que o 1º pôs em full', async () => {
  _limparSelecaoParaTestes();
  // base.full = -1: as duas capacidades passam a full; tetos.provider = 1 → só a ORDEM das vagas decide quem fica
  const cfg = { modos: { provider: 'local' }, cortes: { base: { full: -1, candidate: -1 } }, funcaoTrazCapacidade: { ativo: false }, tetos: { provider: 1 } };
  const { sel } = nova(cfg);
  const turno = (trace) => sel.refinadores({ jev: {}, trace, refino: {} });
  const com = async (loaded) => { const i = await entradaProvider(); i.state = { loadedProviders: loaded }; return K(i, caps(), emb); };
  // turno 1: nada ativo no início
  const t1 = novoTrace();
  const r1 = turno(t1);
  const a = await r1.provider(await com([]));
  assert.deepEqual(t1.ativasNoInicio, []);
  assert.deepEqual(a.full, ['agenda'], '1º refine: a nota decide, agenda fica com a única vaga');
  // 2º refine do mesmo turno (promoção do kairos): agenda já está em loadedProviders; mas não estava ativa NO INÍCIO → continua na frente
  const b = await r1.provider(await com(['agenda']));
  assert.deepEqual(b.full, ['agenda'], 'carregada = ativa antes do turno: agenda (posta em full pelo 1º refine) não cede a vaga a tarefas');
  assert.deepEqual(b.candidates, ['tarefas']);
  // turno 2: agenda JÁ estava ativa no início → é "carregada": tarefas (nova) passa na frente, agenda vai para candidates
  const t2 = novoTrace();
  const c = await turno(t2).provider(await com(['agenda']));
  assert.deepEqual(t2.ativasNoInicio, ['agenda']);
  assert.deepEqual(c.full, ['tarefas']);
  assert.deepEqual(c.candidates, ['agenda']);
  // a cópia é por chamada: o turno 1 (ativasNoInicio []) continua dando o resultado dele depois do turno 2 (sem vazar um para o outro)
  assert.deepEqual((await r1.provider(await com(['agenda']))).full, ['agenda']);
});

test('info.cruzado: o anel que consulta o outro registra em que pé ele estava (pronto | falhou | erro) no PRÓPRIO trace, sem escrever no do outro', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova(CFG_D4B);
  const trace = novoTrace();
  const refs = sel.refinadores({ jev: {}, trace });
  await refs.provider(await kFn('provider', ['agenda', 'docs', 'outra']));
  assert.deepEqual(trace.porAnel.provider.cruzado, { tool: 'pronto' });
  assert.equal(trace.porAnel.tool, undefined, 'nada no trace do outro anel');
  assert.deepEqual(serializarSelecao(trace).porAnel.provider.cruzado, { tool: 'pronto' }, 'vai ao fabrica.json');
  // o `info` não é compartilhado entre turnos: o próximo refine começa sem `cruzado`
  const trace2 = novoTrace();
  await sel.refinadores({ jev: {}, trace: trace2, ativo: true }).provider(await kFn('provider', ['agenda', 'docs', 'outra'], undefined, { semFuncoes: true }));
  assert.deepEqual(trace2.porAnel.provider.cruzado, { tool: 'falhou' });
  // tool consultando o provider (D4a preguiçoso): só aparece quando um item precisa — função de capacidade de fora que chega a full
  _limparSelecaoParaTestes();
  const b = nova({ modos: { provider: 'local', tool: 'local' }, cortes: { promocao: 0.2 } });
  await registrarK(b.dir, capsFn(), embFn, { aneis: ['provider'] });
  const trB = novoTrace();
  const refsB = b.sel.refinadores({ jev: {}, trace: trB });
  await refsB.tool(await kFn('tool', ['docs/tool/buscar']));
  assert.deepEqual(trB.porAnel.tool.cruzado, { provider: 'pronto' });
  await refsB.tool(await kFn('tool', ['docs/tool/buscar'], { state: { loadedProviders: ['docs'] } }));
  assert.equal(trB.porAnel.tool.cruzado, undefined, 'capacidade do turno: o refine nem consulta o provider');
});

test('ponta a ponta (tool): o ref que o kairos propôs full com nota abaixo do corte chega ao caso com doMotor e fica FORA da carga à toa nova — com vaga sobrando no teto, subir o corte tira só o que o local trouxe pela nota', async () => {
  const entrada = async () => {
    const itens = [['a/tool/x', 'full'], ['a/tool/y', 'discard']]; // x o kairos mantém (capacidade do turno); y só o local traz, se a nota passar
    return {
      ring: 'tool', query: { text: 'pedido', vectors: [[0.1, 0.9, 0.1]] }, // mais perto de y (y-texto = [0,1,0]) que de x (x-texto = [1,0,0])
      items: itens.map(([ref, proposedTier], i) => ({ ref, position: i, scores: {}, proposedTier, meta: {} })),
      proposal: { full: ['a/tool/x'], candidates: [] }, caps: {}, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600,
    };
  };
  // Roda o tool do turno com o corte de `full` dado e devolve o caso montado do que o registro guardaria.
  const rodar = async (corteFull) => {
    _limparSelecaoParaTestes();
    const cfg = { modos: { provider: 'local', tool: 'local' }, cortes: { base: { full: corteFull, candidate: Math.min(corteFull, 0.0) } } };
    const { sel } = nova(cfg);
    const trace = novoTrace();
    const refs = sel.refinadores({ jev: {}, trace });
    const r = await refs.tool(await K(await entrada(), capsTool(), embTool));
    const selecao = serializarSelecao(trace);
    const caso = montarCaso({ ts: '2026-10-08T12:00:00.000Z', interactionId: 'e2e', texto: 'pedido', vetores: [[1, 0, 0, 0]], operacoes: [], selecao, guardarTexto: false, embedderSlug: 'falso-tool' });
    return { r, caso, notas: selecao.decisoes.tool.notas };
  };
  const probe = await rodar(1); // nada passa pela nota: só sobra o que o kairos propôs
  const nx = probe.notas['a/tool/x'].nota; const ny = probe.notas['a/tool/y'].nota;
  assert.ok(ny > nx, `pré-condição do cenário: y (${ny}) acima de x (${nx})`);
  const corte = Math.round(((nx + ny) / 2) * 1e4) / 1e4; // x abaixo, y acima
  const padrao = await rodar(corte);
  assert.deepEqual(padrao.r.full.slice().sort(), ['a/tool/x', 'a/tool/y']);
  assert.equal(padrao.notas['a/tool/x'].doMotor, true, 'x: full só porque o kairos propôs (nota abaixo do corte)');
  assert.equal('doMotor' in padrao.notas['a/tool/y'], false, 'y: o local trouxe pela nota');
  assert.deepEqual(cargaNovaDe(padrao.caso, 'tool'), ['a/tool/y'], 'a carga nova é só o que o local trouxe e ninguém usou');
  // corte acima de qualquer nota: y sai do full; x continua (o tool não rebaixa) e segue fora da carga nova — o que o corte mexe é o que ele muda.
  // Aqui o teto de vagas está folgado (2 itens); com o teto cheio o corte TROCA a função da vaga em vez de tirar (C2 da re-revisão do conjunto).
  const alto = await rodar(1);
  assert.deepEqual(alto.r.full, ['a/tool/x']);
  assert.deepEqual(cargaNovaDe(alto.caso, 'tool'), []);
  // caso gravado antes da marca (carimbo antigo): não há como separar o que o motor manteve — n/d, nunca um número
  assert.equal(cargaNovaDe({ ...padrao.caso, regra: 'cortes-composicao-v1' }, 'tool'), null);
});


test('registrarPromovidasNoTurno: só função full de capacidade NOVA (fora de loadedProviders, sem item do motor fora de discard), não fixa, em resposta não degradada', () => {
  const it = (ref, proposedTier, meta = {}) => ({ ref, position: 0, scores: {}, proposedTier, meta });
  const input = { items: [it('novo/tool/a', 'discard'), it('novo2/tool/a', 'discard'), it('carregado/tool/a', 'discard'), it('doMotor/tool/a', 'discard'), it('doMotor/tool/b', 'candidate'), it('fixa/tool/a', 'discard', { pinned: true }), it('manual/tool/a', 'discard', { hasManual: true })], state: { loadedProviders: ['carregado'] } };
  const trace = {};
  registrarPromovidasNoTurno(trace, input, { full: ['novo/tool/a', 'carregado/tool/a', 'doMotor/tool/a', 'fixa/tool/a', 'manual/tool/a', 'fantasma/tool/a'], candidates: ['novo2/tool/a'], explain: {} });
  assert.deepEqual([...trace.promovidasNoTurno], ['novo'], 'candidate não conta; carregada, "do motor", fixa e ref fora do input também não');
  registrarPromovidasNoTurno(trace, input, { full: ['novo2/tool/a'], candidates: [], explain: { 'novo2/tool/a': { reason: 'local:degradado (sem-semantica)' } } });
  assert.deepEqual([...trace.promovidasNoTurno], ['novo'], 'resposta degradada é a proposta do motor, não decisão do local');
  registrarPromovidasNoTurno(trace, input, { full: ['novo2/tool/a'], candidates: [], explain: {} });
  assert.deepEqual([...trace.promovidasNoTurno], ['novo', 'novo2'], 'Set acumula e deduplica');
  registrarPromovidasNoTurno(trace, { items: undefined, state: undefined }, { full: ['x/tool/a'], candidates: [], explain: {} });
  registrarPromovidasNoTurno(trace, input, null);
  assert.deepEqual([...trace.promovidasNoTurno], ['novo', 'novo2'], 'entradas malformadas não lançam nem contam');
});

test('serializarSelecao: pendente vira sem-resposta e principal/sombra perdem o explain', () => {
  const s = serializarSelecao({
    porAnel: { provider: { estado: 'pronto' } },
    sombras: [
      { anel: 'provider', principalDe: 'local', sombraDe: 'jev', estado: 'pendente', msPrincipal: 3, msSombra: null, erro: null, principal: { full: ['a'], candidates: [], explain: { a: { reason: 'x' } } }, sombra: null },
      { estado: 'respondida', principal: null, sombra: { full: [], candidates: ['b'], explain: {} } },
    ],
  });
  assert.deepEqual(s.sombras.map((x) => x.estado), ['sem-resposta', 'respondida']);
  assert.deepEqual(s.sombras[0].principal, { full: ['a'], candidates: [] });
  assert.equal(s.sombras[0].principalDe, 'local');
  assert.equal(s.sombras[0].msPrincipal, 3);
  assert.deepEqual(s.sombras[1].sombra, { full: [], candidates: ['b'] });
  assert.equal('explain' in s.sombras[0].principal, false);
  assert.equal(serializarSelecao(null), null);
});

test('serializarSelecao: degradado (jev: ou local:) em qualquer ponta marca o registro; resposta normal não', () => {
  const normal = { anel: 'provider', estado: 'respondida', principal: { full: ['a'], candidates: [], explain: { a: { reason: 'local:base (x)' } } }, sombra: { full: ['a'], candidates: [], explain: { a: { reason: 'jev: noul 0.90' } } } };
  const sombraDeg = { ...normal, sombra: { full: ['a'], candidates: [], explain: { a: { reason: 'jev:degradado (timeout)' } } } };
  const principalDeg = { ...normal, principal: { full: ['a'], candidates: [], explain: { a: { reason: 'local:degradado (sem-semantica)' } } } };
  const s = serializarSelecao({ porAnel: {}, sombras: [normal, sombraDeg, principalDeg] });
  assert.deepEqual(s.sombras.map((x) => x.degradado === true), [false, true, true]);
  // por decisor: sombra (jev) degradada ≠ principal (local) degradada
  assert.deepEqual(s.sombras.map((x) => [x.degradadoPrincipal === true, x.degradadoSombra === true]), [[false, false], [false, true], [true, false]]);
});

test('registrarDecisao: une full/candidates entre chamadas do turno e uma chamada degradada nunca sobrescreve uma decisão boa', async () => {
  const ok = (full, candidates, explain = {}) => ({ full, candidates, explain });
  const deg = { full: ['m'], candidates: [], explain: { m: { reason: 'local:degradado (sem-semantica)' } } };
  const t = {};
  registrarDecisao(t, 'provider', deg);
  assert.equal(t.decisoes.provider.degradado, true);
  registrarDecisao(t, 'provider', ok(['a'], ['b'], { a: { reason: 'local:cabeca', confidence: 0.91234567 }, b: { reason: 'local:base (texto)', confidence: 0.3 } }));
  assert.deepEqual([t.decisoes.provider.degradado, t.decisoes.provider.full, t.decisoes.provider.candidates], [false, ['a'], ['b']], 'a boa substitui a degradada sem unir com ela');
  assert.deepEqual(t.decisoes.provider.notas.a, { nota: 0.9123, origem: 'cabeca', reason: 'local:cabeca' });
  registrarDecisao(t, 'provider', ok(['b', 'c'], ['d']));
  assert.deepEqual([t.decisoes.provider.full, t.decisoes.provider.candidates], [['a', 'b', 'c'], ['d']], 'união; full vence candidate');
  registrarDecisao(t, 'provider', deg);
  assert.deepEqual(t.decisoes.provider.full, ['a', 'b', 'c'], 'degradada depois da boa não sobrescreve');
  assert.equal(t.decisoes.provider.degradado, false);
});

test('registrarDecisao: origem cabeca | funcao | base pelo prefixo do reason; o reason cru (sufixos incluídos) vai em notas[ref].reason, truncado em 80', () => {
  const t = {};
  const longo = `local:base (${'x'.repeat(200)})`;
  registrarDecisao(t, 'tool', {
    full: ['a', 'b', 'c'], candidates: ['d', 'e', 'f'],
    explain: {
      a: { reason: 'local:cabeca', confidence: 0.9 },
      b: { reason: 'local:cabeca (teto-promocao)', confidence: 0.8 },
      c: { reason: 'local:base (texto)', confidence: 0.7 },
      d: { reason: 'local:funcao-trouxe (docs/tool/buscar 0.512)', confidence: 0.1 },
      e: { reason: 'local:base (exemplo) (promocao)', confidence: 0.6 },
      f: { reason: longo, confidence: 0.5 },
    },
  });
  const n = t.decisoes.tool.notas;
  assert.deepEqual([n.a.origem, n.b.origem, n.c.origem, n.d.origem, n.e.origem, n.f.origem], ['cabeca', 'cabeca', 'base', 'funcao', 'base', 'base']);
  assert.equal(n.b.reason, 'local:cabeca (teto-promocao)');
  assert.equal(n.d.reason, 'local:funcao-trouxe (docs/tool/buscar 0.512)');
  assert.equal(n.e.reason, 'local:base (exemplo) (promocao)');
  assert.equal(n.f.reason.length, 80);
  assert.equal(n.f.reason, longo.slice(0, 80));
  // origem funcao leva a função que trouxe a capacidade (nota arredondada a 4 casas); nas outras origens o campo não é gravado
  const t2 = {};
  registrarDecisao(t2, 'provider', { full: [], candidates: ['docs', 'agenda', 'tarefas'], explain: {
    docs: { reason: 'local:funcao-trouxe (docs/tool/buscar 0.512)', confidence: 0.1234567, funcao: { ref: 'docs/tool/buscar', nota: 0.51234 } },
    agenda: { reason: 'local:base (texto)', confidence: 0.3, funcao: { ref: 'agenda/tool/ler', nota: 0.9 } },
    tarefas: { reason: 'local:funcao-trouxe (tarefas/tool/abrir 0.4)', confidence: 0.2, funcao: { ref: 7, nota: 'x' } },
  } });
  assert.deepEqual(t2.decisoes.provider.notas.docs, { nota: 0.1235, origem: 'funcao', reason: 'local:funcao-trouxe (docs/tool/buscar 0.512)', funcao: { ref: 'docs/tool/buscar', nota: 0.5123 } });
  assert.equal('funcao' in t2.decisoes.provider.notas.agenda, false, 'funcao fora da origem funcao é ignorada');
  assert.equal('funcao' in t2.decisoes.provider.notas.tarefas, false, 'funcao malformada é ignorada, sem lançar');
  // sem reason: base e reason vazio (nunca lança)
  registrarDecisao(t, 'tool', { full: ['g'], candidates: [], explain: { g: { confidence: 0.4 } } });
  assert.deepEqual(t.decisoes.tool.notas.g, { nota: 0.4, origem: 'base', reason: '' });
});

test('registrarDecisao: `doMotor` do refinador vai para notas[ref].doMotor (campo próprio, nunca sufixo do reason); só o literal true; sem a marca o campo não existe; o último refine que pontuou o ref manda', () => {
  const t = {};
  const longo = `local:base (${'y'.repeat(100)})`; // o reason é cortado em 80: uma marca em sufixo se perderia aqui
  registrarDecisao(t, 'tool', {
    full: ['m', 'n', 'o', 'p'], candidates: ['q'],
    explain: {
      m: { reason: 'local:base (texto)', confidence: 0.1, doMotor: true },
      n: { reason: longo, confidence: 0.2, doMotor: true },
      o: { reason: 'local:cabeca', confidence: 0.9 },
      p: { reason: 'local:base (texto)', confidence: 0.3, doMotor: 'sim' },
      q: { reason: 'local:base (texto)', confidence: 0.2, doMotor: false },
    },
  });
  const n = t.decisoes.tool.notas;
  assert.deepEqual(n.m, { nota: 0.1, origem: 'base', reason: 'local:base (texto)', doMotor: true });
  assert.equal(n.n.doMotor, true);
  assert.equal(n.n.reason, longo.slice(0, 80), 'o reason segue cortado em 80, sem sufixo de marca');
  assert.equal('doMotor' in n.o, false, 'decisão do local: sem a chave');
  assert.equal('doMotor' in n.p, false, 'só o literal true vale');
  assert.equal('doMotor' in n.q, false, 'false não é gravado');
  // o anel é refinado mais de uma vez: a nota é a do último refine que pontuou o ref; o motor que já o segurava num refine anterior continua segurando
  registrarDecisao(t, 'tool', { full: ['m'], candidates: [], explain: { m: { reason: 'local:base (texto)', confidence: 0.5 } } });
  assert.deepEqual(t.decisoes.tool.notas.m, { nota: 0.5, origem: 'base', reason: 'local:base (texto)', doMotor: true }, 'marcado num refine anterior: a marca fica (o corte nunca o moveu)');
  assert.equal(t.decisoes.tool.notas.n.doMotor, true, 'ref que o refine seguinte não pontuou mantém a nota (e a marca) do anterior');
});

test('registrarDecisao entre refines do turno: a proposta full que é CONSEQUÊNCIA de um full anterior pela nota não vira marca; a que veio de outra fonte (P1 sobre candidate/ausente) vira', () => {
  const t = {};
  // refine 1 do provider: x e y em full pela nota, z só candidate
  registrarDecisao(t, 'provider', { full: ['x', 'y'], candidates: ['z'], explain: {
    x: { reason: 'local:base (texto)', confidence: 0.8 }, y: { reason: 'local:base (texto)', confidence: 0.7 }, z: { reason: 'local:base (texto)', confidence: 0.3 },
  } });
  // refine 2 (depois da promoção do kairos): as três constam em loadedProviders e vêm com proposta full → o refinador marca as três.
  // x e y já eram full pela nota no refine 1: o 2º refine só as vê carregadas por causa dele — o corte ainda as controla, sem marca.
  // z era candidate: quem a carregou foi outra fonte (P1 por função full do tool, skill) — marcada. Os cortes são por origem (compartilhados pelos
  // dois anéis; não existe corte "do provider"), e a P1 depende da nota da função no tool: subir o corte pode tirar essa função e, com ela, a
  // carga de z. Marcar z é subcontagem conhecida da carga nova (M2 da re-revisão do conjunto), não independência do corte.
  registrarDecisao(t, 'provider', { full: ['x', 'y', 'z'], candidates: [], explain: {
    x: { reason: 'local:base (texto)', confidence: 0.8, doMotor: true }, y: { reason: 'local:base (texto)', confidence: 0.7, doMotor: true }, z: { reason: 'local:base (texto)', confidence: 0.3, doMotor: true },
  } });
  const n = t.decisoes.provider.notas;
  assert.deepEqual(t.decisoes.provider.full, ['x', 'y', 'z']);
  assert.equal('doMotor' in n.x, false);
  assert.equal('doMotor' in n.y, false);
  assert.equal(n.z.doMotor, true);
  // ref que o 1º refine nem viu (ausente) e o 2º traz carregado/proposto full: outra fonte, marcado
  registrarDecisao(t, 'provider', { full: ['w'], candidates: [], explain: { w: { reason: 'local:base (texto)', confidence: 0.1, doMotor: true } } });
  assert.equal(t.decisoes.provider.notas.w.doMotor, true);
  // 3º refine repete x: o 2º não o marcou e nenhum refine anterior o segurou por motor — segue sem marca
  registrarDecisao(t, 'provider', { full: ['x'], candidates: [], explain: { x: { reason: 'local:base (texto)', confidence: 0.8, doMotor: true } } });
  assert.equal('doMotor' in t.decisoes.provider.notas.x, false);
});

test('trace do catálogo: `catalogo {versao, nos, retrato}` entra no porAnel depois do registro do Kairos — gravado na 1ª vez, igual quando a versão nova tem o mesmo retrato; sem registro, nada', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  const t0 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t0 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.equal(t0.porAnel.provider.catalogo, undefined, 'antes do catálogo do Kairos o trace não inventa');
  await registrarK(dir, caps(), emb, { versao: 'v1', aneis: ['provider'] });
  const t1 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t1 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual(t1.porAnel.provider.catalogo, { versao: 'v1', nos: 2, retrato: 'gravado' });
  assert.deepEqual(serializarSelecao(t1).porAnel.provider.catalogo, { versao: 'v1', nos: 2, retrato: 'gravado' }, 'vai para o fabrica.json');
  // versão nova do Kairos com o MESMO conteúdo: o retrato (hash) bate com o anterior
  await registrarK(dir, caps(), emb, { versao: 'v2', aneis: ['provider'] });
  const t2 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t2 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual(t2.porAnel.provider.catalogo, { versao: 'v2', nos: 2, retrato: 'igual' });
  // catálogo que muda o retrato: 'gravado' de novo
  await registrarK(dir, caps(['agenda 99']), emb, { versao: 'v3', aneis: ['provider'] });
  const t4 = novoTrace();
  await sel.refinadores({ jev: {}, trace: t4 }).provider(await K(await entradaProvider(), caps(), emb));
  assert.equal(t4.porAnel.provider.catalogo.retrato, 'gravado');
});

test('M-a: catálogo do anel sem nós com semântica falha UMA vez por versão — `indiceEmUso` não remonta a cada chamada; versão nova tenta de novo; o trace diz nao-gravado', async () => {
  _limparSelecaoParaTestes();
  const { dir, sel } = nova();
  let leituras = 0;
  class Contador extends Map {
    [Symbol.iterator]() { leituras++; return super[Symbol.iterator](); }
    entries() { leituras++; return super.entries(); }
    values() { leituras++; return super.values(); }
    keys() { leituras++; return super.keys(); }
    forEach(...a) { leituras++; return super.forEach(...a); }
  }
  const semNo = (versao) => ({ slug: 'falso', aneis: { provider: { itens: new Contador([['agenda', { texto: null, exemplos: [] }]]), media: [1, 0], versao } } });
  registrarCatalogoSemantico(dir, semNo('vz1'));
  assert.equal(indiceEmUso(dir, 'provider'), null);
  const depoisDoRegistro = leituras;
  assert.ok(depoisDoRegistro > 0, 'o registro tentou montar');
  for (let i = 0; i < 5; i++) assert.equal(indiceEmUso(dir, 'provider'), null);
  assert.equal(leituras, depoisDoRegistro, 'indiceEmUso não remonta a cada chamada');
  registrarCatalogoSemantico(dir, semNo('vz1'));
  assert.equal(leituras, depoisDoRegistro, 'mesma versão no reindex seguinte: nada de remontar');
  registrarCatalogoSemantico(dir, semNo('vz2'));
  assert.ok(leituras > depoisDoRegistro, 'versão nova tenta de novo');
  const t = novoTrace();
  await sel.refinadores({ jev: {}, trace: t }).provider(await K(await entradaProvider(), caps(), emb));
  assert.deepEqual(t.porAnel.provider.catalogo, { versao: 'vz2', nos: 0, retrato: 'nao-gravado' });
  // invalidar reabre a tentativa
  const antes = leituras;
  invalidarSelecaoLocal(dir, 'provider');
  assert.equal(indiceEmUso(dir, 'provider'), null);
  assert.ok(leituras > antes);
});

test('M-b: acerto do memo renova a posição — a derivação reusada não é a próxima a ser descartada', async () => {
  _limparSelecaoParaTestes();
  const { sel } = nova();
  const refs = sel.refinadores({ jev: {}, trace: novoTrace() });
  const entrada = await entradaProvider();
  let vetoresLidos = 0;
  const comContador = (input) => {
    for (const it of input.items) {
      const t = it.semantica?.texto;
      if (!t) continue;
      const v = t.vetor;
      Object.defineProperty(t, 'vetor', { get() { vetoresLidos++; return v; }, enumerable: true, configurable: true });
    }
    return input;
  };
  const v0 = comContador(await K(entrada, caps(), emb, { versao: 'm0', semFuncoes: true }));
  await refs.provider(v0);
  for (let i = 1; i < MEMO_MAX; i++) await refs.provider(await K(entrada, caps(), emb, { versao: `m${i}`, semFuncoes: true }));
  assert.equal(_memoDeDerivacoesParaTestes(), MEMO_MAX);
  const lidosAntes = vetoresLidos;
  await refs.provider(v0); // acerto: m0 passa a ser a mais nova
  assert.equal(vetoresLidos, lidosAntes, 'acerto não rederiva');
  await refs.provider(await K(entrada, caps(), emb, { versao: 'm-novo', semFuncoes: true })); // estoura: sai a mais antiga (m1), não m0
  assert.equal(_memoDeDerivacoesParaTestes(), MEMO_MAX);
  await refs.provider(v0);
  assert.equal(vetoresLidos, lidosAntes, 'm0 sobreviveu ao descarte porque foi renovada');
});

test('Kairos sem semântica do catálogo (snapshot null ou sem anéis): UM aviso por processo e nada em uso', async () => {
  _limparSelecaoParaTestes();
  const { dir } = nova();
  const avisos = capturarAvisos(() => { registrarCatalogoSemantico(dir, null); registrarCatalogoSemantico(dir, {}); registrarCatalogoSemantico(dir, { slug: 'x', aneis: {} }); });
  assert.deepEqual(avisos, ['[fabrica] seleção: Kairos sem semântica do catálogo — retrato e lote sem índice']);
  assert.equal(indiceEmUso(dir, 'provider'), null);
  assert.ok(!existsSync(join(dir, 'decisoes', 'indice', 'provider.json')));
});

test('cortes da base vêm da linha do modelo quando não há override (a tabela é do host: entra por parâmetro)', () => {
  assert.deepEqual(cortesDaBaseDoModelo('multilingual-e5-small', limiaresDoModelo), { full: 0.35, candidate: 0.25 });
  assert.deepEqual(cortesDaBaseDoModelo('modelo-x', limiaresDoModelo), { full: 0.35, candidate: 0.25 });
  assert.deepEqual(cortesDaBaseDoModelo('modelo-fake', limiaresDoModelo), { full: 0.61, candidate: 0.51 });
});

test('cortes.base: lido por turno (config criada com embedder nulo vale a linha do slug de depois); override do dono vence a linha; CORTES_FIXOS.base = e5', () => {
  let slug = null;
  const cfg = configDaSelecao({}, { slug: () => slug });
  assert.deepEqual({ ...cfg.cortes.base }, { full: 0.35, candidate: 0.25 });
  assert.equal(cfg.cortesOrigem.base, 'modelo');
  slug = 'modelo-fake';
  assert.deepEqual({ ...cfg.cortes.base }, { full: 0.61, candidate: 0.51 });
  const comOverride = configDaSelecao({ cortes: { base: { full: 0.5, candidate: 0.4 } } }, { slug: () => 'modelo-fake' });
  assert.deepEqual({ ...comOverride.cortes.base }, { full: 0.5, candidate: 0.4 });
  assert.equal(comOverride.cortesOrigem.base, 'override');
});

test('sem limiaresDoModelo (host sem tabela por modelo): a base é a fixa do produto e a origem fica fixo', () => {
  const cfg = configDaSelecaoReal({}, { slug: () => 'modelo-fake' });
  assert.deepEqual(cfg.cortes, CORTES_FIXOS);
  assert.equal(cfg.cortesOrigem.base, 'fixo');
});

test('criarSelecaoLocal({ limiaresDoModelo, embedder }): põe a base do modelo na config que veio sem ela (embedder objeto ou função, lido a cada acesso); override do dono vence; a config recebida não é mutada', async () => {
  _limparSelecaoParaTestes();
  const baseNoTrace = async (sel) => {
    const trace = novoTrace();
    await sel.refinadores({ jev: {}, trace }).provider(await K(await entradaProvider(), caps(), emb));
    return trace.porAnel.provider.cortes;
  };
  const dir = mkdtempSync(join(tmpdir(), 'sel-'));
  const crua = configDaSelecaoReal({});
  assert.equal(crua.cortesOrigem.base, 'fixo');
  // embedder como função: o slug só existe depois de a sessão nascer
  let atual = null;
  const sel = criarSelecaoLocal({ dataDir: dir, config: crua, limiaresDoModelo, embedder: () => atual });
  assert.equal(crua.cortesOrigem.base, 'fixo', 'a config do host não é mutada');
  let c = await baseNoTrace(sel);
  assert.equal(c.origem.base, 'modelo');
  assert.deepEqual(c.base, { full: 0.35, candidate: 0.25 }, 'embedder ainda nulo: linha padrão');
  atual = { modelSlug: 'modelo-fake' };
  c = await baseNoTrace(sel);
  assert.deepEqual(c.base, { full: 0.61, candidate: 0.51 }, 'o slug é lido a cada acesso, sem recriar a seleção');
  // embedder como objeto
  const selObj = criarSelecaoLocal({ dataDir: dir, config: configDaSelecaoReal({}), limiaresDoModelo, embedder: { modelSlug: 'modelo-fake' } });
  assert.deepEqual((await baseNoTrace(selObj)).base, { full: 0.61, candidate: 0.51 });
  // override do dono vence a linha do modelo
  const selOv = criarSelecaoLocal({ dataDir: dir, config: configDaSelecaoReal({ cortes: { base: { full: 0.5, candidate: 0.4 } } }), limiaresDoModelo, embedder: { modelSlug: 'modelo-fake' } });
  c = await baseNoTrace(selOv);
  assert.equal(c.origem.base, 'override');
  assert.deepEqual(c.base, { full: 0.5, candidate: 0.4 });
  // config que já resolveu a base (configDaSelecao com limiares) não é refeita: vale o slug dela, não o do embedder
  const selJa = criarSelecaoLocal({ dataDir: dir, config: configDaSelecao({}, { slug: () => 'modelo-fake' }), limiaresDoModelo, embedder: { modelSlug: 'outro' } });
  assert.deepEqual((await baseNoTrace(selJa)).base, { full: 0.61, candidate: 0.51 });
  // sem limiaresDoModelo: a config vale como veio
  const selSem = criarSelecaoLocal({ dataDir: dir, config: configDaSelecaoReal({}), embedder: { modelSlug: 'modelo-fake' } });
  c = await baseNoTrace(selSem);
  assert.equal(c.origem.base, 'fixo');
  assert.deepEqual(c.base, CORTES_FIXOS.base);
});

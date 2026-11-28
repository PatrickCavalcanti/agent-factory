// Fiação do decisor por anel (refinadoresDoTurno/normalizarRefino/REFINO_PADRAO/comTardias), portada do Igris
// (`packages/executor/test/fabrica-refino.test.js`). Cobre só a FIAÇÃO (cliente → funções de anel, defaults, validação
// do objeto de refino, memoização/cache por turno); a lógica de classificação dos anéis é de `refinadores.test.js` e
// `refinadores-chat.test.js`. Diferença do Igris: `normalizarRefino(obj)` recebe o objeto já lido pelo host (a fábrica
// não lê env nem faz JSON.parse).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { refinadoresDoTurno, normalizarRefino, REFINO_PADRAO, comTardias } from '../src/refinadores/turno.js';
// Q3 (correção do review da Fase 3): `REFINO_PADRAO.{provider,tool,skill}` agora vem por SPREAD
// destes, não mais duplicado como literal — o teste abaixo compara contra a FONTE real, não
// contra um segundo literal que poderia divergir em silêncio.
import { PADRAO_PROVIDER, PADRAO_TOOL, PADRAO_SKILL } from '../src/refinadores/index.js';

/** Cliente fake: responde `noul` por chave (default 0). Registra cada `questions` recebido. */
function clienteFake(respostasPorChave = {}, chamadas = []) {
  return {
    modelo: 'fake',
    async decidir({ questions }) {
      chamadas.push(questions);
      const answers = {};
      for (const chave of Object.keys(questions)) answers[chave] = { noul: respostasPorChave[chave] ?? 0 };
      return { answers, usage: { input_tokens: 1, cost: 0 }, ms: 1, modelo: 'fake' };
    },
  };
}

/** `input` mínimo do contrato `RingRefiner` do kairos (`@okds/kairos/dist/resolve/refiners.d.ts`,
 * confirmado contra `criarRefinadorJev`, `packages/decisions/src/refinadores/criar-refinador-jev.js`):
 * `query.text`, `items[].{ref,position,proposedTier,meta}`, `proposal.{full,candidates}`,
 * `budgetMs`. */
function inputMinimo(refs) {
  return {
    query: { text: 'pedido de teste' },
    items: refs.map((ref, i) => ({ ref, position: i, proposedTier: 'candidate', meta: { description: `desc ${ref}` } })),
    proposal: { full: [], candidates: refs },
    caps: {},
    budgetMs: 600,
  };
}

test('sem cliente: refinadoresDoTurno devolve {} (R1 — sem refiners, kairos decide sozinho)', () => {
  assert.deepEqual(refinadoresDoTurno({ cliente: null }), {});
});

// Modo combinado (22/09, padrão): default de `refinadoresDoTurno` (sem `config` explícito,
// então `normalizarRefino()` interno) constrói os TRÊS anéis — `aneisComJev` default do
// `REFINO_PADRAO` inclui `tool`, o Jev decide também as funções.
test('cliente fake: refinadoresDoTurno default (modo combinado) devolve os tres aneis provider/tool/skill', () => {
  const refinadores = refinadoresDoTurno({ cliente: clienteFake() });
  assert.deepEqual(Object.keys(refinadores).sort(), ['provider', 'skill', 'tool']);
  for (const anel of ['provider', 'skill', 'tool']) assert.equal(typeof refinadores[anel], 'function');
});

test('cada anel, chamado com um input minimo do contrato do kairos, faz UMA chamada ao cliente (modo combinado, os tres aneis)', async () => {
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'] };
  for (const anel of ['provider', 'tool', 'skill']) {
    const chamadas = [];
    const cliente = clienteFake({}, chamadas);
    const refinadores = refinadoresDoTurno({ cliente, config: configCombinado });
    await refinadores[anel](inputMinimo([`${anel}-a`, `${anel}-b`]));
    assert.equal(chamadas.length, 1, `${anel}: cliente.decidir deveria ser chamado exatamente uma vez`);
  }
});

// F1 (correção da revisão final do conjunto): I3a pode disparar um SEGUNDO `bridge.prepareTurn`
// no mesmo turno (`orquestrador/src/index.js do @okds/agent-factory`, bloco "I3a") — que roda um SEGUNDO
// `discover()`, chamando de novo cada anel com refinador registrado. Sem memoização, isso é uma
// chamada A MAIS ao Jev por anel presente no mesmo turno (até +800ms medidos, spec). A
// memoização vive DENTRO do objeto devolvido por UMA chamada de `refinadoresDoTurno` — como
// `turno.js` chama esta função uma vez por turno (nunca reusa entre turnos), o cache nasce vazio
// a cada turno.
test('memoizacao por turno (I3a): dois refine do MESMO anel com o MESMO texto fazem UMA chamada ao cliente', async () => {
  const chamadas = [];
  const cliente = clienteFake({}, chamadas);
  const refinadores = refinadoresDoTurno({ cliente });
  const input = inputMinimo(['provider-a', 'provider-b']);
  const [r1, r2] = await Promise.all([refinadores.provider(input), refinadores.provider(input)]);
  assert.equal(chamadas.length, 1, 'a segunda chamada (mesmo anel, mesmo texto) deveria reusar o cache do turno, nao chamar o cliente de novo');
  assert.deepEqual(r1, r2, 'as duas chamadas devolvem a MESMA resposta (a promise cacheada)');
});

// N1 (correção do re-review final): `tool` NUNCA memoiza a PROMISE inteira — o universo de
// itens que o anel `tool` avalia cresce entre o primeiro e o segundo `discover` do mesmo turno
// (I3a promove um provider, o motor hidrata as tools dele com `proposedTier: 'full'` só na
// segunda chamada). Se a resposta memoizada do primeiro `discover` fosse reusada, essas tools
// novas ficariam fora do universo avaliado e, por R2 do kairos, virariam `discard` em vez de
// hidratar. `provider` continua memoizado (a lista de providers candidatos não muda entre os
// dois `discover`).
// 22/09 (Task 2, "anel tool grava as próprias respostas"): sem memoizar a PROMISE, o anel
// `tool` ainda evita reperguntar itens que ELE MESMO já respondeu neste turno — via o cache POR
// REF (o mesmo `cache` que o anel `provider` grava, agora também escrito pelo próprio `tool`,
// gancho `aoResponder` de `criarRefinadorJev`). Por isso duas chamadas com o MESMO conjunto de
// itens agora fazem só UMA chamada ao Jev (a segunda é 100% cache hit) — o teste abaixo prova o
// caso real do I3a: o universo CRESCE entre as duas chamadas, e só o item novo é perguntado de
// novo.
test('memoizacao por turno (N1) + cache por ref (Task 2): tool nao memoiza a promise (pergunta de novo a cada chamada), mas reusa via cache quem ja respondeu — so o item novo (universo cresceu, I3a) e perguntado', async () => {
  // Modo combinado explícito (Task 21/09): `tool` só ganha refinador do Jev com `aneisComJev`
  // incluindo `tool` — o default do modo V1 deixa `tool` de fora.
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'] };
  const chamadasTool = [];
  const clienteTool = clienteFake({}, chamadasTool);
  const refinadoresTool = refinadoresDoTurno({ cliente: clienteTool, config: configCombinado });
  await refinadoresTool.tool(inputMinimo(['tool-a', 'tool-b']));
  assert.equal(chamadasTool.length, 1, 'primeira chamada pergunta pelos dois itens');
  assert.deepEqual(Object.keys(chamadasTool[0]).sort(), ['fn_tool-a', 'fn_tool-b']);
  // I3a: segundo discover do MESMO turno traz um item NOVO (`tool-c`) junto dos dois antigos.
  await refinadoresTool.tool(inputMinimo(['tool-a', 'tool-b', 'tool-c']));
  assert.equal(chamadasTool.length, 2, 'segunda chamada ainda vai ao Jev — o universo cresceu, tool nao memoiza a promise inteira');
  assert.deepEqual(Object.keys(chamadasTool[1]), ['fn_tool-c'], 'tool-a/tool-b ja tem resposta no cache do turno (Task 2); so tool-c, o item novo, e perguntado de novo');

  const chamadasProvider = [];
  const clienteProvider = clienteFake({}, chamadasProvider);
  const refinadoresProvider = refinadoresDoTurno({ cliente: clienteProvider });
  const inputProvider = inputMinimo(['provider-a', 'provider-b']);
  await refinadoresProvider.provider(inputProvider);
  await refinadoresProvider.provider(inputProvider);
  assert.equal(chamadasProvider.length, 1, 'provider: continua memoizado dentro do mesmo turno');
});

test('memoizacao por turno: o MESMO anel com textos DIFERENTES (turno.texto mudou) faz DUAS chamadas', async () => {
  const chamadas = [];
  const cliente = clienteFake({}, chamadas);
  const refinadores = refinadoresDoTurno({ cliente });
  await refinadores.provider(inputMinimo(['provider-a']));
  const inputOutroTexto = { ...inputMinimo(['provider-a']), query: { text: 'outro pedido de teste' } };
  await refinadores.provider(inputOutroTexto);
  assert.equal(chamadas.length, 2, 'textos diferentes nao podem compartilhar o cache do turno');
});

test('memoizacao por turno: DUAS chamadas de refinadoresDoTurno (dois turnos) NAO compartilham cache entre si', async () => {
  const chamadas = [];
  const cliente = clienteFake({}, chamadas);
  const input = inputMinimo(['provider-a']);
  await refinadoresDoTurno({ cliente }).provider(input);
  await refinadoresDoTurno({ cliente }).provider(input);
  assert.equal(chamadas.length, 2, 'cada chamada de refinadoresDoTurno (um turno novo) precisa comecar com cache vazio');
});

test('REFINO_PADRAO tem os defaults da spec por anel (por spread de decisoes/refinadores) e os orcamentos do refino', () => {
  // Task 3 (2026-09-21-ajustes-de-uso-da-fabrica): cada anel agora tambem carrega o proprio
  // `prazoMs` (override do global) — o spread de `PADRAO_PROVIDER`/`PADRAO_TOOL`/`PADRAO_SKILL`
  // continua valendo para os demais campos (cortes/tetos), so `prazoMs` diverge da fonte.
  assert.deepEqual(REFINO_PADRAO.provider, { ...PADRAO_PROVIDER, prazoMs: 1500 });
  assert.deepEqual(REFINO_PADRAO.tool, { ...PADRAO_TOOL, prazoMs: 1100 });
  assert.deepEqual(REFINO_PADRAO.skill, { ...PADRAO_SKILL, prazoMs: 1500 });
  // Prova de que é SPREAD (cópia), não a mesma referência — `normalizarRefino`/o merge raso
  // (`{ ...REFINO_PADRAO.provider, ...json.provider }`) não pode mutar o objeto de
  // `decisoes`, que é compartilhado por qualquer outro consumidor do pacote.
  assert.notEqual(REFINO_PADRAO.provider, PADRAO_PROVIDER);
  assert.notEqual(REFINO_PADRAO.tool, PADRAO_TOOL);
  assert.notEqual(REFINO_PADRAO.skill, PADRAO_SKILL);
  assert.equal(REFINO_PADRAO.prazoMs, 1600);
  assert.equal(REFINO_PADRAO.prazoGeralMs, 3600);
  assert.equal(REFINO_PADRAO.candidateProvidersForRefine, 8);
  assert.equal(REFINO_PADRAO.maxActivate, 2);
  // Modo combinado (22/09, padrão): o Jev decide os três anéis, e o anel `provider` pergunta
  // pelas funções das capacidades na mesma chamada — modo V1 (sem `tool`, sem a chamada
  // combinada) só entra por env agora.
  assert.deepEqual(REFINO_PADRAO.aneisComJev, ['provider', 'tool', 'skill']);
  assert.equal(REFINO_PADRAO.funcoesNaChamadaDeCapacidades, true);
});

test('refinadoresDoTurno: cache por turno — provider grava as respostas das funções, tool consome; turno novo começa vazio (modo combinado, config explicito)', async () => {
  const chamadas = [];
  const cliente = { async decidir({ questions }) { chamadas.push(Object.keys(questions)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.8 }; return { answers, ms: 5 }; } };
  const funcoesDe = (id) => (id === 'cal' ? [{ ref: 'cal/tool/listar', descricao: 'lista', pinned: false }] : []);
  const base = (ring, items) => ({ ring, query: { text: 'agenda', vectors: [] }, items, proposal: { full: [], candidates: items.map((i) => i.ref) }, caps: { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 8 } }, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600 });
  const it = (ref, meta = {}) => ({ ref, position: 0, scores: { final: 0.5 }, proposedTier: 'candidate', meta });
  // Este cenário (provider pergunta funções na mesma chamada, tool lê do cache) só existe no
  // modo combinado — o modo V1 (default) nem constrói o anel `tool`, e o anel `provider` nunca
  // manda `funcoesDe` sem a flag ligada.
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'], funcoesNaChamadaDeCapacidades: true };

  const t1 = refinadoresDoTurno({ cliente, funcoesDe, config: configCombinado });
  await t1.provider(base('provider', [it('cal', { description: 'agenda' })]));
  assert.deepEqual(chamadas[0], ['cap_cal', 'fn_cal/tool/listar']);
  const out = await t1.tool(base('tool', [it('cal/tool/listar', { providerId: 'cal', description: 'lista' })]));
  assert.equal(chamadas.length, 1, 'tool não chamou o Jev: tudo veio do cache');
  assert.equal(out.explain['cal/tool/listar'].reason, 'jev: noul 0.80 (cache)');

  const t2 = refinadoresDoTurno({ cliente, funcoesDe, config: configCombinado });
  await t2.tool(base('tool', [it('cal/tool/listar', { providerId: 'cal', description: 'lista' })]));
  assert.equal(chamadas.length, 2, 'turno novo = cache vazio = pergunta de novo');
});

// 23/09 (ajuste pontual): capacidadesDePiso cobre o gap de state.loadedProviders vazio no
// PRIMEIRO turno de refino da sessão (medição de 21/09, sessões 40d6f594/27a76c4c) —
// refinadoresDoTurno repassa o getter ao anel provider, que passa a perguntar pelas funções do
// piso na mesma chamada mesmo sem loadedProviders.
test('refinadoresDoTurno: capacidadesDePiso leva as funcoes do piso na primeira chamada do provider, mesmo com state.loadedProviders vazio; tool depois responde do cache', async () => {
  const chamadas = [];
  const cliente = { async decidir({ questions }) { chamadas.push(Object.keys(questions)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.8 }; return { answers, ms: 5 }; } };
  const funcoesDe = (id) => (id === 'memoria' ? [{ ref: 'memoria/tool/mem_ler', descricao: 'le memoria', pinned: false }] : []);
  const base = (ring, items) => ({ ring, query: { text: 'agenda', vectors: [] }, items, proposal: { full: [], candidates: items.map((i) => i.ref) }, caps: { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 8 } }, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600 });
  const it = (ref, meta = {}) => ({ ref, position: 0, scores: { final: 0.5 }, proposedTier: 'candidate', meta });
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'], funcoesNaChamadaDeCapacidades: true };

  const t = refinadoresDoTurno({ cliente, funcoesDe, capacidadesDePiso: () => ['memoria'], config: configCombinado });
  await t.provider(base('provider', [it('cal', { description: 'agenda' })]));
  assert.deepEqual(chamadas[0], ['cap_cal', 'fn_memoria/tool/mem_ler'], 'a chamada do provider leva a funcao do piso mesmo com loadedProviders vazio (primeiro turno)');

  const out = await t.tool(base('tool', [it('memoria/tool/mem_ler', { providerId: 'memoria', description: 'le memoria' })]));
  assert.equal(chamadas.length, 1, 'tool nao chamou o Jev: a resposta ja veio do cache gravado pelo provider');
  assert.equal(out.explain['memoria/tool/mem_ler'].reason, 'jev: noul 0.80 (cache)');
});

/** Cliente fake que também captura o `state` (não só `questions`, como `clienteFake` acima) —
 * é o que permite ver `state.contexto` (onde `estadoDoHost` entra). */
function clienteCapturaEstado(chamadas = []) {
  return {
    async decidir({ state, questions }) {
      chamadas.push({ state, questions });
      const answers = {};
      for (const chave of Object.keys(questions)) answers[chave] = { noul: 0.8 };
      return { answers, ms: 1 };
    },
  };
}

// 2026-09-23 (dar ao Jev o contexto da conversa): `estadoDoHost` da fábrica devolve `{ conversa }`
// do turno (`sessao.turnoAtual.conversa`, `turno.js`) — mesmo gancho que antes desta mudança
// devolvia sempre `() => null`. Os três anéis (provider/tool/skill) compartilham o MESMO
// `estadoDoHost` (`refinadoresDoChat`, `decisoes/refinadores`) — cobre os três.
test('conversaDoHost: estadoDoHost devolve { conversa } do turno para os tres aneis (provider/tool/skill)', async () => {
  const conversa = [
    { papel: 'usuario', texto: 'e depois de amanha?' },
    { papel: 'assistente', texto: '(agenda de hoje)' },
  ];
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'] };
  for (const anel of ['provider', 'tool', 'skill']) {
    const chamadas = [];
    const cliente = clienteCapturaEstado(chamadas);
    const refinadores = refinadoresDoTurno({ cliente, config: configCombinado, conversaDoHost: () => conversa });
    await refinadores[anel](inputMinimo([`${anel}-a`]));
    assert.deepEqual(chamadas[0]?.state.contexto, { conversa }, `${anel}: state.contexto deveria carregar { conversa } do host`);
  }
});

test('sem conversaDoHost (ou conversa vazia): estadoDoHost volta ao null de antes — state sem a chave contexto', async () => {
  const chamadas1 = [];
  const refinadores1 = refinadoresDoTurno({ cliente: clienteCapturaEstado(chamadas1), conversaDoHost: () => [] });
  await refinadores1.provider(inputMinimo(['provider-a']));
  assert.equal('contexto' in chamadas1[0].state, false, 'conversa vazia nao deveria criar state.contexto');

  const chamadas2 = [];
  const refinadores2 = refinadoresDoTurno({ cliente: clienteCapturaEstado(chamadas2) });
  await refinadores2.provider(inputMinimo(['provider-a']));
  assert.equal('contexto' in chamadas2[0].state, false, 'sem conversaDoHost nenhum (getter ausente) tambem nao cria state.contexto');
});

test('REFINO_PADRAO: prazos por anel — skill/provider com mais folga que tool; prazoMs global e o teto do kairos, acima de todos', () => {
  assert.equal(REFINO_PADRAO.prazoMs, 1600);
  assert.equal(REFINO_PADRAO.prazoGeralMs, 3600);
  assert.equal(REFINO_PADRAO.provider.prazoMs, 1500);
  assert.equal(REFINO_PADRAO.tool.prazoMs, 1100);
  assert.equal(REFINO_PADRAO.skill.prazoMs, 1500);
  for (const anel of ['provider', 'tool', 'skill']) assert.ok(REFINO_PADRAO[anel].prazoMs + 50 <= REFINO_PADRAO.prazoMs, `${anel}: prazo do anel + margem tem que caber no teto do kairos`);
});

test('normalizarRefino({}): devolve REFINO_PADRAO (copia, nao a mesma referencia)', () => {
  const config = normalizarRefino({});
  assert.deepEqual(config, REFINO_PADRAO);
  // Item 2 (acabamento do review de qualidade da Fase 2): os early-returns agora devolvem uma
  // COPIA rasa por anel de REFINO_PADRAO, nunca a referência direta — sem isto, um chamador que
  // mutasse o objeto devolvido (ex.: `config.provider.maxFull = 1`) corromperia o default
  // compartilhado por toda chamada futura de normalizarRefino/refinadoresDoTurno no processo.
  assert.notEqual(config, REFINO_PADRAO);
  assert.notEqual(config.provider, REFINO_PADRAO.provider);
  assert.notEqual(config.tool, REFINO_PADRAO.tool);
  assert.notEqual(config.skill, REFINO_PADRAO.skill);
  assert.notEqual(config.aneisComJev, REFINO_PADRAO.aneisComJev, 'aneisComJev tambem e copia, nao a mesma referencia de array');
});

test('refino sobrescreve por anel, RASO — nao apaga os demais campos do anel nem os demais aneis', () => {
  const config = normalizarRefino({ provider: { maxFull: 1 } });
  assert.equal(config.provider.maxFull, 1);
  assert.equal(config.provider.corteFull, REFINO_PADRAO.provider.corteFull, 'demais campos do anel provider preservados');
  assert.deepEqual(config.tool, REFINO_PADRAO.tool, 'anel tool nao tocado permanece default');
  assert.deepEqual(config.skill, REFINO_PADRAO.skill, 'anel skill nao tocado permanece default');
});

// A fábrica não lê env nem faz JSON.parse: o host entrega o objeto já lido. `undefined` = sem config (default, sem
// aviso); o que não é objeto simples (null, array, string, número) avisa e cai no padrão — nunca derruba o turno.
test('normalizarRefino sem argumento (undefined): default, sem aviso', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    assert.deepEqual(normalizarRefino(), REFINO_PADRAO);
    assert.equal(warn.mock.calls.length, 0);
  } finally { mock.restoreAll(); }
});

for (const [rotulo, valor] of [['null', null], ['array', []], ['string', 'x'], ['numero', 42]]) {
  test(`normalizarRefino(${rotulo}): avisa e ignora, devolve REFINO_PADRAO (nunca derruba o turno)`, () => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const config = normalizarRefino(valor);
      assert.deepEqual(config, REFINO_PADRAO);
      assert.notEqual(config, REFINO_PADRAO);
      assert.ok(warn.mock.calls.length >= 1, `deveria ter avisado que ${rotulo} nao e um objeto de refino`);
    } finally { mock.restoreAll(); }
  });
}

test('normalizarRefino nao le o ambiente do processo: dois objetos diferentes em sequencia valem cada um o seu', () => {
  assert.equal(normalizarRefino({ provider: { maxFull: 1 } }).provider.maxFull, 1);
  assert.equal(normalizarRefino({}).provider.maxFull, REFINO_PADRAO.provider.maxFull);
  assert.equal(normalizarRefino({ provider: { maxFull: 1 } }).tool.maxFull, REFINO_PADRAO.tool.maxFull);
});

test('comTardias (21/09): mescla msReal/msPrazo da resposta tardia no anel que o kairos reportou, sem criar anel novo', () => {
  const refino = { msTotal: 553, degradado: 'parcial', porAnel: { provider: { enviados: 3, respondidos: 3, ms: 523 }, skill: { enviados: 35, respondidos: 0, ms: 553 } } };
  const out = comTardias(refino, { skill: { msReal: 1830, ms: 553, degradado: 'timeout' }, tool: { msReal: 900, ms: 550, degradado: 'timeout' } });
  assert.equal(out.porAnel.skill.msReal, 1830);
  assert.equal(out.porAnel.skill.msPrazo, 553);
  assert.equal(out.porAnel.provider.msReal, undefined, 'anel sem resposta tardia nao ganha msReal');
  assert.equal(out.porAnel.tool, undefined, 'nao inventa anel que o kairos nao reportou');
  assert.equal(refino.porAnel.skill.msReal, undefined, 'nao muta o refino original');
  assert.equal(comTardias(null, { skill: { msReal: 1 } }), null);
  assert.equal(comTardias(refino, {}), refino);
});

test('refinadoresDoTurno repassa aoChegarTarde ao refinador: resposta do Jev depois do prazo chega com msReal', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 80)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 80 }; } };
  const tardias = [];
  // Task 3: `config.<anel>.prazoMs` vence o `prazoMs` global (`REFINO_PADRAO.provider.prazoMs`
  // já é 1100 por default) — para este teste forçar o timeout com um cliente de 80ms, o prazo
  // curto precisa ir no anel `provider`, não só no topo (que hoje é só o teto do kairos).
  const config = { ...normalizarRefino({}), prazoMs: 30, provider: { ...normalizarRefino({}).provider, prazoMs: 30 } };
  const refs = refinadoresDoTurno({ cliente: clienteLento, config, aoChegarTarde: (t) => tardias.push(t) });
  const input = { ring: 'provider', query: { text: 'agenda', vectors: [] }, items: [{ ref: 'cal', position: 0, scores: { final: 0.9 }, proposedTier: 'full', meta: { description: 'agenda' } }], proposal: { full: ['cal'], candidates: [] }, caps: { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 8 } }, state: { loadedProviders: [] }, ctx: {}, budgetMs: 600 };
  const out = await refs.provider(input);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(tardias.length, 1);
  assert.equal(tardias[0].anel, 'provider');
  assert.ok(tardias[0].msReal >= 70, `msReal deveria ser a latencia real (~80ms), veio ${tardias[0].msReal}`);
});

// Task 7 (2026-09-21-ajustes-de-uso-da-fabrica): validação de shape de `o objeto de refino`
// — até aqui `normalizarRefino` só checava "é objeto", não o conteúdo. `mock.method(console, 'warn')`
// (node:test) para capturar as chamadas sem substituir `console.warn` na mão; `mock.restoreAll()`
// no `finally` de cada teste, como o resto do arquivo já faz com o `try/finally` manual.
test('refino: anel que nao e objeto ("x") avisa e usa o padrao do anel', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ provider: 'x' });
    assert.deepEqual(config.provider, REFINO_PADRAO.provider);
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que provider nao e objeto');
  } finally {
    mock.restoreAll();
  }
});

test('refino: valor nao numerico ("2") avisa e mantem o numero do padrao', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ provider: { maxFull: '2' } });
    assert.equal(config.provider.maxFull, REFINO_PADRAO.provider.maxFull);
    assert.equal(typeof config.provider.maxFull, 'number');
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que maxFull nao e numero finito');
  } finally {
    mock.restoreAll();
  }
});

test('refino: campo valido numerico aplica, chave desconhecida avisa e ignora', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ provider: { maxFull: 3, foo: 1 } });
    assert.equal(config.provider.maxFull, 3);
    assert.ok(!('foo' in config.provider), 'chave desconhecida nao deveria entrar no config');
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado sobre a chave foo desconhecida');
  } finally {
    mock.restoreAll();
  }
});

// Modo V1 (21/09): validação dos dois campos de topo novos — `aneisComJev`/
// `funcoesNaChamadaDeCapacidades` — mesma garantia dos demais campos (nunca derruba o turno,
// warn + padrão para valor de shape errado).
test('refino: aneisComJev que nao e array de aneis validos ("x") avisa e mantem o padrao', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ aneisComJev: 'x' });
    assert.deepEqual(config.aneisComJev, REFINO_PADRAO.aneisComJev);
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que aneisComJev nao e um array valido');
  } finally {
    mock.restoreAll();
  }
});

test('refino: funcoesNaChamadaDeCapacidades que nao e boolean ("sim") avisa e mantem o padrao', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ funcoesNaChamadaDeCapacidades: 'sim' });
    assert.equal(config.funcoesNaChamadaDeCapacidades, REFINO_PADRAO.funcoesNaChamadaDeCapacidades);
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que funcoesNaChamadaDeCapacidades nao e boolean');
  } finally {
    mock.restoreAll();
  }
});

test('refino: aneisComJev/funcoesNaChamadaDeCapacidades validos aplicam sem warn', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ aneisComJev: ['provider', 'tool', 'skill'], funcoesNaChamadaDeCapacidades: true });
    assert.deepEqual(config.aneisComJev, ['provider', 'tool', 'skill']);
    assert.equal(config.funcoesNaChamadaDeCapacidades, true);
    assert.equal(warn.mock.calls.length, 0, 'campos validos nao deveriam gerar warn');
  } finally {
    mock.restoreAll();
  }
});

test('refino: prazoMs de topo nao numerico ("abc") avisa e mantem o padrao (1600)', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ prazoMs: 'abc' });
    assert.equal(config.prazoMs, 1600);
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que prazoMs nao e numero finito');
  } finally {
    mock.restoreAll();
  }
});

test('refino: skill.prazoMs valido aplica sem warn', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    // Item 3 (acabamento): 1200, nao 2000 — 2000 violaria a invariante `<anel>.prazoMs + 50 <=
    // prazoMs` (topo, default 1600) e geraria warn (ver os testes da invariante mais abaixo).
    // 1200 + 50 = 1250 <= 1600: valido por si só E coerente com o teto global, mesmo sendo
    // diferente do default do anel (1500) — o que este teste quer provar.
    const config = normalizarRefino({ skill: { prazoMs: 1200 } });
    assert.equal(config.skill.prazoMs, 1200);
    assert.equal(warn.mock.calls.length, 0, 'campo valido nao deveria gerar warn');
  } finally {
    mock.restoreAll();
  }
});

// Item 3 (acabamento do review de qualidade da Fase 2, plano 2026-09-21-ajustes-de-uso-da-
// fabrica.md): Task 7 só validava "é número finito" — um corte fora de [0,1] passava direto
// (`corteFull: 70` virava o `noul` de corte, sem nunca classificar nada como `full`).
test('refino: corteFull fora de [0,1] avisa e mantem o padrao do anel', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ provider: { corteFull: 70 } });
    assert.equal(config.provider.corteFull, REFINO_PADRAO.provider.corteFull);
    assert.equal(config.provider.corteFull, 0.7);
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado que corteFull esta fora da faixa [0,1]');
  } finally {
    mock.restoreAll();
  }
});

// Item 3: a invariante compara `<anel>.prazoMs` contra `prazoMs` de TOPO — quando a env só
// mexe no topo (aqui, 100ms) e os três anéis ficam nos defaults (1100/1100/1500), a invariante
// falha para os três. A regra escolhida (documentada em `normalizarRefino`): quem se corrige é o
// TETO GLOBAL, não os anéis — `prazoMs` de topo volta ao padrão (1600), os anéis continuam
// como estavam (aqui, os defaults, porque não foram tocados pela env).
test('refino: prazoMs de topo que fere a invariante dos tres aneis avisa por anel e o topo volta ao padrao (1600)', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ prazoMs: 100 });
    assert.equal(config.prazoMs, 1600, 'prazoMs de topo volta ao padrao, nao fica em 100');
    assert.deepEqual(config.provider, REFINO_PADRAO.provider, 'aneis nao tocados pela env continuam default');
    assert.deepEqual(config.tool, REFINO_PADRAO.tool);
    assert.deepEqual(config.skill, REFINO_PADRAO.skill);
    assert.ok(warn.mock.calls.length >= 3, 'deveria ter avisado uma vez por anel (provider/tool/skill) sobre a invariante ferida');
  } finally {
    mock.restoreAll();
  }
});

// Item 3 (acabamento do review final): quando o TOPO já é o padrão (a env não tocou `prazoMs`
// de topo) e só o `skill.prazoMs` fere a invariante, resetar o topo (que já era 1600) não
// corrige nada — o warn antigo prometia isso e mentia. A correção agora é do PRÓPRIO anel: volta
// ao padrão do anel (1500), o topo continua 1600.
test('refino: skill.prazoMs fere a invariante com o topo JA no padrao — quem volta ao padrao e o ANEL, nao o topo', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ skill: { prazoMs: 2000 } });
    assert.equal(config.prazoMs, 1600, 'topo ja era o padrao, continua 1600');
    assert.equal(config.skill.prazoMs, 1500, 'skill.prazoMs volta ao padrao do anel, nao ao valor da env');
    assert.ok(warn.mock.calls.length >= 1, 'deveria ter avisado sobre a invariante ferida');
  } finally {
    mock.restoreAll();
  }
});

// Item 3: topo e anel juntos, sem violar a invariante (1300 + 50 = 1350 <= 1700, e os demais
// aneis nao tocados — provider 1500/tool 1100 — tambem cabem no topo 1700) — nenhum dos dois
// precisa voltar ao padrao, e nao pode haver warn. Modo V1 (21/09): topo precisa acomodar o
// default de `provider.prazoMs` (1500) tambem, nao só o `skill.prazoMs` da env.
test('refino: topo e skill.prazoMs juntos, dentro da invariante — aplica os dois sem warn', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = normalizarRefino({ prazoMs: 1700, skill: { prazoMs: 1300 } });
    assert.equal(config.prazoMs, 1700);
    assert.equal(config.skill.prazoMs, 1300);
    assert.equal(warn.mock.calls.length, 0, 'invariante respeitada (todos os aneis + 50 <= 1700), nao deveria avisar');
  } finally {
    mock.restoreAll();
  }
});


// Instrumentação completa do turno pela fábrica (2026-09-23, decisão do dono: "tudo que a
// fábrica faz tem que ir para o Tracer"): `refinadoresDoTurno` repassa `aoChamarJev` aos três
// anéis — `turno.js` usa isto para acumular a chamada BRUTA (state/questions/answers/meta) de
// cada anel no artefato do turno, com a origem já identificada (`refino:<anel>`).
test('refinadoresDoTurno repassa aoChamarJev: um registro por anel chamado, cada um com seu `anel`', async () => {
  const configCombinado = { ...normalizarRefino({}), aneisComJev: ['provider', 'tool', 'skill'] };
  const registros = [];
  const refinadores = refinadoresDoTurno({ cliente: clienteFake(), config: configCombinado, aoChamarJev: (r) => registros.push(r) });
  await refinadores.provider(inputMinimo(['provider-a']));
  await refinadores.tool(inputMinimo(['tool-a']));
  await refinadores.skill(inputMinimo(['skill-a']));
  assert.deepEqual(registros.map((r) => r.anel).sort(), ['provider', 'skill', 'tool']);
  for (const r of registros) {
    assert.equal(r.chamouJev, true);
    assert.ok(r.state, 'state bruto presente');
    assert.ok(r.questions, 'questions bruto presente');
    assert.ok(r.answers, 'answers bruto presente');
    assert.equal(typeof r.meta.ms, 'number');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir, montarPerguntas, aquecerDecisao, RESPOND, TETO_PERGUNTAS } from '../src/index.js';
import { SEM_ARGUMENTO } from '../src/perguntas.js';

const catalogo = [{ name: 'a', power: 'pa', desc: 'A. Mais.' }, { name: 'g', power: 'pg', desc: 'G.', prefetch: true }];
const clienteFake = (answers, ms = 5) => ({ modelo: 'fake', decidir: async ({ state, questions }) => ({ answers, usage: { input_tokens: 100, cost: 0.000004 }, modelo: 'fake', ms, _state: state, _questions: questions }) });

test('monta as perguntas: next_tool, pronto, prefetch por tool marcada, args por candidato, perguntas dos powers', () => {
  const q = montarPerguntas({ catalogo, candidatos: { a: { id: [['1', 'um'], ['2', 'dois']] } }, perguntasDosPowers: { okapp: { precisa_schema: { type: 'noul', instructions: 'x' } } } });
  assert.deepEqual(Object.keys(q).sort(), ['arg_a_id', 'next_tool', 'power_okapp_precisa_schema', 'prefetch_g', 'pronto']);
  assert.equal(Object.keys(q.arg_a_id.criteria).length, 3); // 2 candidatos + nenhum
});

// Adendo §14 — prefetch com argumento de domínio fechado.
test('montarPerguntas: tool de prefetch com enum gera pfarg_<tool>_<param>; tool de prefetch sem enum não gera pfarg_*', () => {
  const catalogoEnum = [
    { name: 'g', power: 'pg', desc: 'G.', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', 'amanha'] }] },
    { name: 'h', power: 'ph', desc: 'H.', prefetch: true, params: [{ name: 'id' }] }, // sem enum
  ];
  const q = montarPerguntas({ catalogo: catalogoEnum });
  assert.deepEqual(Object.keys(q).sort(), ['next_tool', 'pfarg_g_periodo', 'prefetch_g', 'prefetch_h', 'pronto']);
  assert.deepEqual(Object.keys(q.pfarg_g_periodo.criteria).sort(), ['amanha', 'hoje', SEM_ARGUMENTO].sort());
});

test('montarPerguntas: pfarg_* usa enumDescriptions quando presente, senão cai no próprio valor', () => {
  const catalogoEnum = [{ name: 'g', power: 'pg', desc: 'G.', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', 'amanha'], enumDescriptions: ['O dia de hoje'] }] }];
  const q = montarPerguntas({ catalogo: catalogoEnum });
  assert.equal(q.pfarg_g_periodo.criteria.hoje, 'O dia de hoje');
  assert.equal(q.pfarg_g_periodo.criteria.amanha, 'amanha');
});

// Correção 1 (review Fase 1): predicado único de enum utilizável (enumUtilizavelDePrefetch,
// perguntas.js) — mesmo critério usado por aplicarGates (gates.test.js). Enum não utilizável
// não gera pfarg_* nenhuma, mas a tool continua gerando prefetch_<tool> normalmente.
test('montarPerguntas: enum com sentinela sem_argumento, ou com mais de 254 valores, não gera pfarg_* (mesmo predicado do gate)', () => {
  const enumGigante = Array.from({ length: 255 }, (_, i) => `v${i}`);
  const catalogoNaoUtilizavel = [
    { name: 'g', power: 'pg', desc: 'G.', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', SEM_ARGUMENTO] }] },
    { name: 'h', power: 'ph', desc: 'H.', prefetch: true, params: [{ name: 'p', enum: enumGigante }] },
  ];
  const q = montarPerguntas({ catalogo: catalogoNaoUtilizavel });
  assert.deepEqual(Object.keys(q).sort(), ['next_tool', 'prefetch_g', 'prefetch_h', 'pronto']);
});

// Correção (review do conjunto): predicado simétrico ao de aplicarGates (`t.prefetch ===
// true`, comparação estrita) — antes montarPerguntas usava truthy (`if (t.prefetch)`), então
// um valor truthy não-boolean gerava pergunta que o gate nunca aceitaria de volta.
test('montarPerguntas: tool com prefetch truthy mas não booleano (string "true") não gera prefetch_<tool> nem pfarg_* (predicado === true, simétrico ao gate)', () => {
  const catalogoStr = [{ name: 'g', power: 'pg', desc: 'G.', prefetch: 'true', params: [{ name: 'periodo', enum: ['hoje', 'amanha'] }] }];
  const q = montarPerguntas({ catalogo: catalogoStr });
  assert.deepEqual(Object.keys(q).sort(), ['next_tool', 'pronto']);
});

// Correção 3 (review do conjunto): enum com valor cujo String(v).trim() é vazio invalida o
// enum inteiro (mesma classe de "não utilizável" de SEM_ARGUMENTO/>254 valores).
test('montarPerguntas: enum contendo valor vazio (após trim) não é utilizável — não gera pfarg_*', () => {
  const catalogoVazio = [{ name: 'g', power: 'pg', desc: 'G.', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', '   '] }] }];
  const q = montarPerguntas({ catalogo: catalogoVazio });
  assert.deepEqual(Object.keys(q).sort(), ['next_tool', 'prefetch_g', 'pronto']);
});

// Correção (review do conjunto): candidato de arg_<tool>_<param> cujo String(v) colide com o
// sentinela NENHUM não pode sobrescrever a entrada `nenhum_dos_candidatos` do criteria — mesmo
// predicado usado por aplicarGates ao casar a resposta (candidatoUtilizavel, perguntas.js).
test('montarPerguntas: candidato de arg_* cujo String(v) colide com NENHUM é ignorado — criteria mantém DESC_NENHUM intacto', () => {
  const q = montarPerguntas({ catalogo, candidatos: { a: { id: [['nenhum_dos_candidatos', 'Rótulo confuso'], ['1', 'um']] } } });
  assert.deepEqual(Object.keys(q.arg_a_id.criteria).sort(), ['1', 'nenhum_dos_candidatos']);
  assert.equal(q.arg_a_id.criteria.nenhum_dos_candidatos, 'Nenhum dos candidatos listados é o valor certo para este parâmetro neste pedido.');
});

// Correção (review do conjunto): colisão de chave pfarg_<tool>_<param> entre tool "a_b"+param
// "c" e tool "a"+param "b_c" — mesma string "pfarg_a_b_c". A segunda não pode sobrescrever a
// pergunta da primeira; pula com warn nomeado. As duas tools continuam gerando prefetch_<tool>
// normalmente (só o pfarg_* colide, prefetch_* não).
test('montarPerguntas: colisão de chave pfarg_<tool>_<param> entre tools diferentes — só a primeira gera a pergunta, a segunda é pulada com warn', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const catalogoColisao = [
      { name: 'a_b', power: 'p', desc: 'AB.', prefetch: true, params: [{ name: 'c', enum: ['x', 'y'] }] },
      { name: 'a', power: 'p', desc: 'A.', prefetch: true, params: [{ name: 'b_c', enum: ['p', 'q'] }] },
    ];
    const q = montarPerguntas({ catalogo: catalogoColisao });
    assert.deepEqual(Object.keys(q).sort(), ['next_tool', 'pfarg_a_b_c', 'prefetch_a', 'prefetch_a_b', 'pronto']);
    // a chave sobrevivente pertence à primeira tool do catálogo (a_b, param c) — criteria com
    // x/y, não p/q.
    assert.deepEqual(Object.keys(q.pfarg_a_b_c.criteria).sort(), ['sem_argumento', 'x', 'y'].sort());
    assert.ok(avisos.some((a) => a.includes('pfarg_a_b_c') && a.includes('colis')), `esperava warn de colisão nomeando a chave — veio ${JSON.stringify(avisos)}`);
  } finally {
    console.warn = warnOriginal;
  }
});

test('montarPerguntas: teto de 60 nunca corta pfarg_* (classe protegida como prefetch_*)', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const paramsMuitos = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, enum: ['x', 'y'] }));
    const catalogoEnum = [{ name: 'g', power: 'pg', desc: 'G.', prefetch: true, params: paramsMuitos }];
    const perguntasDosPowers = { testpower: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) };
    const q = montarPerguntas({ catalogo: catalogoEnum, perguntasDosPowers });
    const chaves = Object.keys(q);
    assert.equal(chaves.filter((k) => k.startsWith('pfarg_')).length, 5, 'as 5 pfarg_* sobrevivem ao teto inteiras');
    assert.equal(chaves.length, TETO_PERGUNTAS);
  } finally {
    console.warn = warnOriginal;
  }
});

test('fluxo feliz devolve Decisao com meta', async () => {
  const d = await decidir({ estado: { pedido: 'liste minha agenda' }, catalogo, cliente: clienteFake({ next_tool: { choice: 'a', probabilities: { a: 0.8 }, confidence: 0.8 }, pronto: { noul: 0.1 }, prefetch_g: { noul: 0.9 } }) });
  assert.deepEqual(d.sugestao.map((h) => h.tool), ['a']);
  assert.deepEqual(d.prefetch.map((p) => p.tool), ['g']);
  assert.equal(d.meta.degradado, false);
  assert.equal(d.meta.tokens, 100);
});

test('erro do cliente → degradado, sem lançar', async () => {
  const d = await decidir({ estado: { pedido: 'p' }, catalogo, cliente: { decidir: async () => { throw new Error('decisions: timeout após 1500ms'); } } });
  assert.equal(d.meta.degradado, 'timeout');
  assert.deepEqual(d.sugestao, []); assert.deepEqual(d.hidratar, []); assert.deepEqual(d.prefetch, []);
  assert.equal(d.indice.length, 2);
});

test('sem cliente → degradado sem-chave', async () => {
  const d = await decidir({ estado: { pedido: 'p' }, catalogo, cliente: null });
  assert.equal(d.meta.degradado, 'sem-chave');
});

test('catálogo vazio não chama o cliente', async () => {
  let chamou = false;
  const d = await decidir({ estado: { pedido: 'p' }, catalogo: [], cliente: { decidir: async () => { chamou = true; } } });
  assert.equal(chamou, false); assert.equal(d.meta.degradado, 'catalogo-vazio');
});

test('catálogo malformado (string, não array) degrada em vez de lançar', async () => {
  // guard antigo era `!catalogo?.length`: string não-vazia tem .length e passava,
  // derrubando a promise mais adiante em catalogo.filter/.map (TypeError fora do try/catch).
  let chamou = false;
  const d = await decidir({ estado: { pedido: 'p' }, catalogo: 'nao-e-array', cliente: { decidir: async () => { chamou = true; } } });
  assert.equal(chamou, false);
  assert.equal(d.meta.degradado, 'catalogo-vazio');
});

test('decidir() repassa perguntasDosPowers ao gate: power com underscore ponta a ponta', async () => {
  const perguntasDosPowers = { gestao_documentos: { precisa_schema: { type: 'noul', instructions: 'x' } } };
  const cliente = clienteFake({
    next_tool: { choice: RESPOND, probabilities: {}, confidence: 0 },
    pronto: { noul: 0.9 },
    'power_gestao_documentos_precisa_schema': { type: 'noul', noul: 0.8 },
  });
  const d = await decidir({ estado: { pedido: 'p' }, catalogo, perguntasDosPowers, cliente });
  assert.deepEqual(d.respostasDosPowers, { gestao_documentos: { precisa_schema: { type: 'noul', noul: 0.8 } } });
});

// Correção 2 (review Fase 4, Task 13b): teto de 60 perguntas — a contagem de `questions` não
// tinha nenhum teto (todo eixo de TAMANHO já tinha: regras 500, estado 4000/24000, candidatos
// 60/lista, next_tool 254 opções). Corte de trás para frente: power_* primeiro (extras),
// depois arg_* (reforço); prefetch_*/next_tool/pronto nunca são cortados.
const catalogoSemPrefetch = [{ name: 'a', power: 'pa', desc: 'A.' }];

test('montarPerguntas: teto de 60 — com 80 perguntas de power, corta 22 (só power_*); next_tool e pronto sobrevivem', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const perguntasDosPowers = { testpower: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) };
    const q = montarPerguntas({ catalogo: catalogoSemPrefetch, perguntasDosPowers });
    const chaves = Object.keys(q);
    assert.equal(chaves.length, TETO_PERGUNTAS);
    assert.ok(chaves.includes('next_tool') && chaves.includes('pronto'));
    assert.ok(chaves.every((k) => k === 'next_tool' || k === 'pronto' || k.startsWith('power_')));
    assert.equal(chaves.filter((k) => k.startsWith('power_')).length, TETO_PERGUNTAS - 2);
    assert.ok(avisos.some((a) => a.includes('power_*') && a.includes('22')), `esperava um warn só, nomeando power_* e a contagem 22 — veio ${JSON.stringify(avisos)}`);
    assert.equal(avisos.length, 1, 'um warn por classe cortada, não um por pergunta');
  } finally {
    console.warn = warnOriginal;
  }
});

test('montarPerguntas: teto de 60 — muitos arg_* e muitos power_*, power_* é cortado inteiro antes de qualquer arg_*', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const perguntasDosPowers = { testpower: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) };
    const candidatosMuitos = { toolX: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`p${i}`, [['v', 'r']]])) };
    const q = montarPerguntas({ catalogo: catalogoSemPrefetch, candidatos: candidatosMuitos, perguntasDosPowers });
    const chaves = Object.keys(q);
    assert.equal(chaves.length, TETO_PERGUNTAS);
    assert.equal(chaves.filter((k) => k.startsWith('power_')).length, 0, 'os 10 power_* deveriam ser cortados inteiros primeiro');
    assert.equal(chaves.filter((k) => k.startsWith('arg_')).length, 58, '70 arg_* menos os 12 que faltavam cortar depois do power_*');
    assert.ok(avisos.some((a) => a.includes('power_*') && a.includes('10')));
    assert.ok(avisos.some((a) => a.includes('arg_*') && a.includes('12')));
  } finally {
    console.warn = warnOriginal;
  }
});

// Correção 2 (review Fase 1): quando power_* e arg_* já foram cortados por inteiro (ou nem
// existiam) e o teto AINDA estoura só com classes protegidas (next_tool/pronto/prefetch_*/
// pfarg_*, que a regra A5 proíbe cortar), isso passava em silêncio — nenhum warn, corpo HTTP
// maior que o teto sem aviso nenhum. Cenário: 70 tools de prefetch sem enum e sem
// power_*/arg_* nenhum — next_tool + pronto + 70 prefetch_* = 72, 12 acima do teto, e as
// classes cortáveis não têm nada pra ceder.
test('montarPerguntas: teto excedido só por classes protegidas (prefetch_* sozinho > 60) emite warn e NÃO corta nada', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const catalogoMuitoPrefetch = Array.from({ length: 70 }, (_, i) => ({ name: `t${i}`, power: 'pg', desc: 'T.', prefetch: true }));
    const q = montarPerguntas({ catalogo: catalogoMuitoPrefetch });
    const chaves = Object.keys(q);
    assert.equal(chaves.length, 72, 'nada é cortado: next_tool + pronto + 70 prefetch_*');
    assert.equal(chaves.filter((k) => k.startsWith('prefetch_')).length, 70);
    assert.ok(
      avisos.some((a) => a.includes('excedido') && a.includes('protegidas') && a.includes('12')),
      `esperava um warn citando "excedido", "protegidas" e a contagem 12 acima do teto — veio ${JSON.stringify(avisos)}`,
    );
  } finally {
    console.warn = warnOriginal;
  }
});

test('montarPerguntas: caso normal (poucas perguntas) não corta nada e não emite warn', () => {
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  try {
    const q = montarPerguntas({ catalogo, candidatos: { a: { id: [['1', 'um'], ['2', 'dois']] } }, perguntasDosPowers: { okapp: { precisa_schema: { type: 'noul', instructions: 'x' } } } });
    assert.deepEqual(Object.keys(q).sort(), ['arg_a_id', 'next_tool', 'power_okapp_precisa_schema', 'prefetch_g', 'pronto']);
    assert.equal(avisos.length, 0);
  } finally {
    console.warn = warnOriginal;
  }
});

test('decisão A: _cortes não vai para o modelo, mas fica em meta.cortes', async () => {
  const estadoGrande = { pedido: 'p', mensagens: Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: 'x'.repeat(1000) })) };
  const cliente = clienteFake({ next_tool: { choice: RESPOND, probabilities: {}, confidence: 0 }, pronto: { noul: 0.9 } });
  const d = await decidir({ estado: estadoGrande, catalogo, cliente, tetoChars: 500 });
  // o cliente fake captura o state enviado em result._state — mas decidir() não propaga
  // esse retorno cru ao chamador; a única forma de inspecionar é o próprio meta.estado,
  // que a decisão A define como sendo exatamente o state enviado (sem _cortes).
  assert.equal('_cortes' in d.meta.estado, false);
  assert.ok(Array.isArray(d.meta.cortes));
  assert.ok(d.meta.cortes.length > 0);
});

test('decidir(): sempre devolve prefetchDescartados, inclusive degradado', async () => {
  const d1 = await decidir({ estado: { pedido: 'p' }, catalogo, cliente: null });
  assert.deepEqual(d1.prefetchDescartados, []);
  const d2 = await decidir({
    estado: { pedido: 'p' },
    catalogo,
    cliente: clienteFake({ next_tool: { choice: RESPOND, probabilities: {}, confidence: 0 }, pronto: { noul: 0.9 } }),
  });
  assert.deepEqual(d2.prefetchDescartados, []);
});

// Adendo §14 — aquecerDecisao: aquecimento com decisão real (POST minúscula), nunca lança.
test('aquecerDecisao: cliente null devolve false, nunca lança', async () => {
  const r = await aquecerDecisao(null);
  assert.equal(r, false);
});

test('aquecerDecisao: sucesso do cliente devolve true, com uma única pergunta noul minúscula e genérica', async () => {
  let capturado = null;
  const cliente = { decidir: async ({ state, questions }) => { capturado = { state, questions }; return { answers: { pronto: { noul: 0.9 } } }; } };
  const r = await aquecerDecisao(cliente);
  assert.equal(r, true);
  assert.deepEqual(Object.keys(capturado.questions), ['pronto']);
  assert.equal(capturado.questions.pronto.type, 'noul');
  assert.equal(typeof capturado.state, 'object');
});

test('aquecerDecisao: erro do cliente nunca lança, devolve false', async () => {
  const cliente = { decidir: async () => { throw new Error('decisions: timeout após 1500ms'); } };
  const r = await aquecerDecisao(cliente);
  assert.equal(r, false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarGates, CORTES_PADRAO } from '../src/gates.js';
import { SEM_ARGUMENTO } from '../src/perguntas.js';

const catalogo = [{ name: 'a', power: 'pa' }, { name: 'b', power: 'pb' }, { name: 'c', power: 'pc' }, { name: 'g', power: 'pg', prefetch: true }];
const answers = (conf, probs, extra = {}) => ({ next_tool: { type: 'choice', choice: Object.keys(probs)[0], probabilities: probs, confidence: conf }, pronto: { type: 'noul', noul: 0.2 }, ...extra });

// Fase 1 (H5, adendo §15): o antigo campo `hidratar` (top-k de next_tool) virou `sugestao` —
// só alimenta a dica "Sugestão do roteador" (blocoDecisoes, executor), não hidrata power mais
// nenhum. `d.hidratar` (novo, testado em hidratar-power.test.js) é o `noul` por power.
test('conf < 0.3: não sugere; índice tem tudo', () => {
  const d = aplicarGates(answers(0.2, { a: 0.5, b: 0.3, c: 0.2 }), { catalogo });
  assert.deepEqual(d.sugestao, []);
  assert.equal(d.indice.length, 4);
});
test('0.3 ≤ conf < 0.5: sugere só a primeira', () => {
  const d = aplicarGates(answers(0.4, { a: 0.5, b: 0.3, c: 0.2 }), { catalogo });
  assert.deepEqual(d.sugestao.map((h) => h.tool), ['a']);
});
test('conf ≥ 0.5: top-3 não-zero, sem respond_to_user', () => {
  const d = aplicarGates(answers(0.7, { a: 0.5, respond_to_user: 0.3, b: 0.2, c: 0 }), { catalogo });
  assert.deepEqual(d.sugestao.map((h) => h.tool), ['a', 'b']);
  assert.ok(!d.indice.find((i) => i.tool === 'a'));
});
test('respond_to_user escolhido: nada sugerido, mesmo com conf alta', () => {
  const d = aplicarGates(answers(0.95, { respond_to_user: 0.9, a: 0.1 }), { catalogo });
  assert.deepEqual(d.sugestao, []);
});
test('prefetch por noul ≥ 0.7', () => {
  const d = aplicarGates(answers(0.2, { a: 1 }, { prefetch_g: { type: 'noul', noul: 0.75 } }), { catalogo });
  // (d) tool de prefetch sem parâmetro `enum` no catálogo: segue como hoje, args vazio.
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.75, args: {} }]);
  assert.deepEqual(d.prefetchDescartados, []);
  const d2 = aplicarGates(answers(0.2, { a: 1 }, { prefetch_g: { type: 'noul', noul: 0.6 } }), { catalogo });
  assert.deepEqual(d2.prefetch, []);
});
// E10 (review Fase 3): montarPerguntas (index.js) só gera prefetch_<tool> para tool com
// prefetch===true no catálogo. aplicarGates precisa revalidar a mesma flag ao ler a
// resposta — aceitar qualquer prefetch_<tool> cuja tool exista no catálogo (sem checar a
// flag) abriria caminho para uma chave que ninguém perguntou (desvio de formato do modelo,
// alucinação, conteúdo malicioso) executar uma tool com args {}.
test('prefetch: chave prefetch_<tool> cuja tool NÃO tem prefetch:true no catálogo é ignorada, mesmo com noul alto (E10)', () => {
  const d = aplicarGates(answers(0.2, { a: 1 }, { prefetch_a: { type: 'noul', noul: 0.95 } }), { catalogo });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados, []);
});
// Adendo §14 — prefetch com argumento de domínio fechado.
const catalogoArgs = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', 'amanha', 'semana'] }] }];

test('prefetch com args: valor do enum aceito com confidence ≥ corte', () => {
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: 'amanha', confidence: 0.85 },
  }), { catalogo: catalogoArgs });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: { periodo: 'amanha' }, argsConfidence: 0.85 }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('prefetch com args: sem_argumento omite o parâmetro (args vazio, item aceito)', () => {
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: SEM_ARGUMENTO, confidence: 0.95 },
  }), { catalogo: catalogoArgs });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: {} }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('prefetch com args: resposta ausente descarta o item (argumento-sem-resposta)', () => {
  const d = aplicarGates(answers(0.2, { x: 1 }, { prefetch_g: { type: 'noul', noul: 0.9 } }), { catalogo: catalogoArgs });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados, [{ tool: 'g', motivo: 'argumento-sem-resposta', param: 'periodo' }]);
});

test('prefetch com args: confidence abaixo do corte descarta (argumento-incerto)', () => {
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: 'amanha', confidence: 0.5 },
  }), { catalogo: catalogoArgs });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados, [{ tool: 'g', motivo: 'argumento-incerto', param: 'periodo' }]);
});

test('prefetch com args: valor fora do enum descarta (argumento-invalido)', () => {
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: 'ontem', confidence: 0.9 },
  }), { catalogo: catalogoArgs });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados, [{ tool: 'g', motivo: 'argumento-invalido', param: 'periodo' }]);
});

test('prefetch com args: argsConfidence é o mínimo entre múltiplos parâmetros', () => {
  const catalogoDois = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', 'amanha'] }, { name: 'status', enum: ['pending', 'done'] }] }];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: 'amanha', confidence: 0.95 },
    pfarg_g_status: { type: 'choice', choice: 'pending', confidence: 0.72 },
  }), { catalogo: catalogoDois });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: { periodo: 'amanha', status: 'pending' }, argsConfidence: 0.72 }]);
});

// Correção 1 (review Fase 1): predicado único de enum utilizável (enumUtilizavelDePrefetch,
// perguntas.js), aplicado por aplicarGates.
test('prefetch com args: enum numérico é aceito e args[param] devolve o valor ORIGINAL (number), não a string escolhida', () => {
  const catalogoNumerico = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'prioridade', enum: [1, 2, 3] }] }];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_prioridade: { type: 'choice', choice: '2', confidence: 0.9 },
  }), { catalogo: catalogoNumerico });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: { prioridade: 2 }, argsConfidence: 0.9 }]);
  assert.equal(typeof d.prefetch[0].args.prioridade, 'number');
  assert.deepEqual(d.prefetchDescartados, []);
});

test('prefetch com args: enum contendo o sentinela sem_argumento não é utilizável — item aceito sem pergunta exigida, args vazio', () => {
  const catalogoColisao = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', SEM_ARGUMENTO] }] }];
  const d = aplicarGates(answers(0.2, { x: 1 }, { prefetch_g: { type: 'noul', noul: 0.9 } }), { catalogo: catalogoColisao });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: {} }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('prefetch com args: enum com mais de 254 valores não é utilizável — item aceito sem pergunta exigida, args vazio', () => {
  const enumGigante = Array.from({ length: 255 }, (_, i) => `v${i}`);
  const catalogoGigante = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'p', enum: enumGigante }] }];
  const d = aplicarGates(answers(0.2, { x: 1 }, { prefetch_g: { type: 'noul', noul: 0.9 } }), { catalogo: catalogoGigante });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: {} }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('prefetch com args: enum com duplicatas — valor deduplicado aceito normalmente', () => {
  const catalogoDup = [{ name: 'g', power: 'pg', prefetch: true, params: [{ name: 'periodo', enum: ['hoje', 'hoje', 'amanha'] }] }];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_g: { type: 'noul', noul: 0.9 },
    pfarg_g_periodo: { type: 'choice', choice: 'hoje', confidence: 0.9 },
  }), { catalogo: catalogoDup });
  assert.deepEqual(d.prefetch, [{ tool: 'g', power: 'pg', noul: 0.9, args: { periodo: 'hoje' }, argsConfidence: 0.9 }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('dicas de argumento com conf ≥ 0.7 e nunca "nenhum"', () => {
  const extra = { 'arg_a_id': { type: 'choice', choice: '42', confidence: 0.9, probabilities: { 42: 0.9 } }, 'arg_a_entidade': { type: 'choice', choice: 'nenhum_dos_candidatos', confidence: 0.9 }, 'arg_b_x': { type: 'choice', choice: 'v', confidence: 0.5 } };
  const d = aplicarGates(answers(0.7, { a: 1 }, extra), { catalogo, candidatos: { a: { id: [['42', 'Registro 42']], entidade: [['e', 'E']] }, b: { x: [['v', 'V']] } } });
  assert.deepEqual(d.dicas, { a: { id: { valor: '42', rotulo: 'Registro 42', confidence: 0.9 } } });
});

// Correção (review do conjunto): irmã do fix de enum numérico em pfarg_* (correção 1). `cands.
// find(([v]) => v === a.choice)` nunca casava com candidato numérico — a.choice é sempre string
// (chave do criteria, montada como String(v) em montarPerguntas), mas v aqui pode ser number.
test('dicas de argumento: candidato numérico é aceito (comparação por String(v)) e devolve o valor ORIGINAL (number)', () => {
  const extra = { 'arg_a_id': { type: 'choice', choice: '42', confidence: 0.9 } };
  const d = aplicarGates(answers(0.7, { a: 1 }, extra), { catalogo, candidatos: { a: { id: [[42, 'Registro 42'], [7, 'Registro 7']] } } });
  assert.deepEqual(d.dicas, { a: { id: { valor: 42, rotulo: 'Registro 42', confidence: 0.9 } } });
  assert.equal(typeof d.dicas.a.id.valor, 'number');
});

// Correção (review do conjunto): candidato cujo String(v) colide com o sentinela NENHUM
// (mesmo predicado usado por montarPerguntas ao montar o criteria — candidatoUtilizavel,
// perguntas.js) não pode virar dica, mesmo que o modelo devolva exatamente essa string como
// choice (nesse caso já é descartado antes, por `a.choice === NENHUM`).
test('dicas de argumento: candidato cujo String(v) colide com o sentinela NENHUM nunca vira dica', () => {
  const extra = { 'arg_a_id': { type: 'choice', choice: 'nenhum_dos_candidatos', confidence: 0.9 } };
  const d = aplicarGates(answers(0.7, { a: 1 }, extra), { catalogo, candidatos: { a: { id: [['nenhum_dos_candidatos', 'Rótulo confuso'], ['1', 'um']] } } });
  assert.deepEqual(d.dicas, {});
});

// Correção (review do conjunto): predicado simétrico — aplicarGates já exigia `t.prefetch ===
// true` (comparação estrita); montarPerguntas (index.js) usava truthy. Um valor truthy
// não-boolean (string 'true') agora não gera nem prefetch_<tool> nem pfarg_*.
test('prefetch: t.prefetch truthy mas não booleano (string "true") não é tratado como prefetch (predicado === true, simétrico a montarPerguntas)', () => {
  const catalogoStr = [{ name: 'g', power: 'pg', prefetch: 'true' }];
  const d = aplicarGates(answers(0.2, { a: 1 }, { prefetch_g: { type: 'noul', noul: 0.95 } }), { catalogo: catalogoStr });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados, []);
});

// Correção (ajuste pontual pós-review do conjunto): colisão de chave pfarg_<tool>_<param> entre
// tool "a_b"+param "c" e tool "a"+param "b_c" (mesma string "pfarg_a_b_c") — montarPerguntas
// (index.js) gera a pergunta só para a PRIMEIRA tool do catálogo (o "dono" da chave, via
// mapearChavesPfarg, perguntas.js); a segunda não tem pergunta própria. Antes deste fix,
// aplicarGates reconstruía a chave sozinho e lia `answers[chave]` para a tool pulada também,
// sob a semântica do dono — caindo em 'argumento-sem-resposta'/'argumento-invalido' por
// acidente de enum. Agora usa a mesma `mapearChavesPfarg` para saber que "a" perdeu a chave e
// descarta direto por 'argumento-colisao', sem olhar a resposta. Caso 1: sem nenhuma resposta
// pra chave — a vencedora ("a_b") cai em 'argumento-sem-resposta' (ela é a dona, mas não
// respondida); a pulada ("a") cai em 'argumento-colisao' independente de resposta.
test('prefetch com args: colisão de chave pfarg_* — sem nenhuma resposta pra chave compartilhada, a vencedora cai em argumento-sem-resposta e a pulada em argumento-colisao', () => {
  const catalogoColisao = [
    { name: 'a_b', power: 'p', prefetch: true, params: [{ name: 'c', enum: ['x', 'y'] }] },
    { name: 'a', power: 'p', prefetch: true, params: [{ name: 'b_c', enum: ['p', 'q'] }] },
  ];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_a_b: { type: 'noul', noul: 0.9 },
    prefetch_a: { type: 'noul', noul: 0.9 },
  }), { catalogo: catalogoColisao });
  assert.deepEqual(d.prefetch, []);
  assert.deepEqual(d.prefetchDescartados.sort((x, y) => x.tool.localeCompare(y.tool)), [
    { tool: 'a', motivo: 'argumento-colisao', param: 'b_c' },
    { tool: 'a_b', motivo: 'argumento-sem-resposta', param: 'c' },
  ]);
});

// Mesmo cenário, mas com resposta real (só a vencedora, "a_b", foi de fato perguntada — é a
// única pergunta que existiu): a vencedora lê a resposta normalmente e é aceita; a tool pulada
// ("a") é descartada por 'argumento-colisao' sem sequer olhar `answers[pfarg_a_b_c]` — não
// importa se o valor lido seria válido para o enum dela (domínios disjuntos ou não).
test('prefetch com args: colisão de chave pfarg_* — com resposta real (só da vencedora), a tool pulada é descartada por argumento-colisao, sem ler a resposta', () => {
  const catalogoColisao = [
    { name: 'a_b', power: 'p', prefetch: true, params: [{ name: 'c', enum: ['x', 'y'] }] },
    { name: 'a', power: 'p', prefetch: true, params: [{ name: 'b_c', enum: ['p', 'q'] }] },
  ];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_a_b: { type: 'noul', noul: 0.9 },
    prefetch_a: { type: 'noul', noul: 0.9 },
    pfarg_a_b_c: { type: 'choice', choice: 'x', confidence: 0.9 },
  }), { catalogo: catalogoColisao });
  assert.deepEqual(d.prefetch, [{ tool: 'a_b', power: 'p', noul: 0.9, args: { c: 'x' }, argsConfidence: 0.9 }]);
  assert.deepEqual(d.prefetchDescartados, [{ tool: 'a', motivo: 'argumento-colisao', param: 'b_c' }]);
});

// A tool vencedora continua funcionando normalmente mesmo quando `sem_argumento` é a resposta
// (não é caso de descarte) — a pulada segue caindo em 'argumento-colisao' de qualquer forma.
test('prefetch com args: colisão de chave pfarg_* — resposta sem_argumento na vencedora: ela é aceita sem o param; a pulada continua em argumento-colisao', () => {
  const catalogoColisao = [
    { name: 'a_b', power: 'p', prefetch: true, params: [{ name: 'c', enum: ['x', 'y'] }] },
    { name: 'a', power: 'p', prefetch: true, params: [{ name: 'b_c', enum: ['p', 'q'] }] },
  ];
  const d = aplicarGates(answers(0.2, { x: 1 }, {
    prefetch_a_b: { type: 'noul', noul: 0.9 },
    prefetch_a: { type: 'noul', noul: 0.9 },
    pfarg_a_b_c: { type: 'choice', choice: SEM_ARGUMENTO, confidence: 0.9 },
  }), { catalogo: catalogoColisao });
  assert.deepEqual(d.prefetch, [{ tool: 'a_b', power: 'p', noul: 0.9, args: {} }]);
  assert.deepEqual(d.prefetchDescartados, [{ tool: 'a', motivo: 'argumento-colisao', param: 'b_c' }]);
});
test('perguntas dos powers voltam agrupadas', () => {
  const perguntasDosPowers = { okapp: { precisa_schema: { type: 'noul', instructions: 'x' } } };
  const d = aplicarGates(answers(0.2, { a: 1 }, { 'power_okapp_precisa_schema': { type: 'noul', noul: 0.8 } }), { catalogo, perguntasDosPowers });
  assert.deepEqual(d.respostasDosPowers, { okapp: { precisa_schema: { type: 'noul', noul: 0.8 } } });
});
test('power com underscore no nome e pergunta com underscore no nome: sem split posicional', () => {
  // regex antigo /^power_([^_]+)_(.+)$/ parava no primeiro "_" e devolvia power 'gestao',
  // pergunta 'documentos_precisa_schema' — ninguém procura por essa chave.
  const perguntasDosPowers = { gestao_documentos: { precisa_schema: { type: 'noul', instructions: 'x' } } };
  const d = aplicarGates(
    answers(0.2, { a: 1 }, { 'power_gestao_documentos_precisa_schema': { type: 'noul', noul: 0.9 } }),
    { catalogo, perguntasDosPowers },
  );
  assert.deepEqual(d.respostasDosPowers, { gestao_documentos: { precisa_schema: { type: 'noul', noul: 0.9 } } });
});
test('sem next_tool nas respostas: não lança, sugestao vazia, hidratar vazio, pronto 0', () => {
  const d = aplicarGates({}, { catalogo });
  assert.deepEqual(d.sugestao, []);
  assert.deepEqual(d.hidratar, []);
  assert.equal(d.pronto, 0);
  assert.deepEqual(d.prefetchDescartados, []);
});
test('cortes padrão expostos', () => { assert.deepEqual(CORTES_PADRAO, { semHidratacao: 0.3, topK: 0.5, k: 3, hidratarItem: 0.2, hidratarPower: 0.7, prefetch: 0.7, dica: 0.7, prefetchArg: 0.7 }); });

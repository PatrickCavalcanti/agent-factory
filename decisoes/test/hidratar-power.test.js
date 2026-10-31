// Fase 1 (Task 1.1, adendo §15 da spec, H1-H7): hidratação por power — um `noul` por power
// CANDIDATO NÃO ATIVO (`powersCandidatos: [{id, desc}]`), corte `cortes.hidratarPower` (0,7),
// em vez do `choice` de `next_tool` (que soma 1 entre as opções e nunca serviu bem para
// "quais" powers, só para "qual tool"). O texto de `hidratar_<id>` é o B1 da bancada
// (`eval/resultados/2026-09-18-hidratacao-bracos-3.json`, `textos.b1`) — venceu `choice` e o
// texto "refinado" nos dois eixos de erro medidos (spec §15.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarGates, CORTES_PADRAO } from '../src/gates.js';
import { montarPerguntas, decidir, TETO_PERGUNTAS } from '../src/index.js';
import { instrucoesHidratarPower, CRITERIA_HIDRATAR_POWER } from '../src/perguntas.js';

const catalogo = [{ name: 'a', power: 'pa' }];
const respostaBase = { next_tool: { type: 'choice', choice: 'respond_to_user', probabilities: {}, confidence: 0 }, pronto: { type: 'noul', noul: 0.5 } };

// --- H1/H2: corte 0,7, um noul por power candidato ------------------------------------------

test('dois powers acima do corte (0,7) entram em hidratar, ordenados por noul desc', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }, { id: 'google-calendar', desc: 'Gerencia agenda.' }];
  const answers = { ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.75 }, 'hidratar_google-calendar': { type: 'noul', noul: 0.91 } };
  const d = aplicarGates(answers, { catalogo, powersCandidatos });
  assert.deepEqual(d.hidratar, [{ power: 'google-calendar', noul: 0.91 }, { power: 'tarefas', noul: 0.75 }]);
});

test('0,69 fica fora do corte de 0,7', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }];
  const answers = { ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.69 } };
  const d = aplicarGates(answers, { catalogo, powersCandidatos });
  assert.deepEqual(d.hidratar, []);
});

test('0,7 exato entra — corte é ≥, não >', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }];
  const answers = { ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.7 } };
  const d = aplicarGates(answers, { catalogo, powersCandidatos });
  assert.deepEqual(d.hidratar, [{ power: 'tarefas', noul: 0.7 }]);
});

test('corte configurável por cortes.hidratarPower', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }];
  const answers = { ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.5 } };
  const d = aplicarGates(answers, { catalogo, powersCandidatos, cortes: { hidratarPower: 0.4 } });
  assert.deepEqual(d.hidratar, [{ power: 'tarefas', noul: 0.5 }]);
});

test('power candidato sem resposta na chave hidratar_<id> não entra (nunca lança)', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }];
  const d = aplicarGates({ ...respostaBase }, { catalogo, powersCandidatos });
  assert.deepEqual(d.hidratar, []);
});

// --- H4: power já ativo não é perguntado / não é hidratado de novo --------------------------

test('H4: power ativo não perguntado — quando não vem em powersCandidatos, montarPerguntas não gera a chave, e uma resposta perdida para ela é ignorada por aplicarGates', () => {
  const q = montarPerguntas({ catalogo, powersCandidatos: [] });
  assert.ok(!('hidratar_tarefas' in q));
  // defesa: mesmo que uma resposta apareça para uma chave que nunca foi perguntada (ex.
  // contaminação, bug de outro caminho), aplicarGates só lê o que está em powersCandidatos.
  const d = aplicarGates({ ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.99 } }, { catalogo, powersCandidatos: [] });
  assert.deepEqual(d.hidratar, []);
});

test('H4 (cinto e suspensório): candidato que por acaso já esteja em powersAtivos é ignorado mesmo com noul alto', () => {
  const powersCandidatos = [{ id: 'tarefas', desc: 'Gerencia tarefas.' }];
  const answers = { ...respostaBase, hidratar_tarefas: { type: 'noul', noul: 0.95 } };
  const d = aplicarGates(answers, { catalogo, powersCandidatos, powersAtivos: ['tarefas'] });
  assert.deepEqual(d.hidratar, []);
});

// --- H5: sugestao preserva o comportamento antigo do top-k de next_tool com piso ------------
// Mudança de NOME do campo (não de comportamento): o que antes se chamava `hidratar` (top-k
// de next_tool, piso por item CORTES_PADRAO.hidratarItem) agora é `sugestao` — só alimenta a
// dica "Sugestão do roteador" no executor. Casos completos (piso ínfimo, dúvida entre dois
// powers, piso configurável) continuam em hidratar-piso.test.js, agora lendo `d.sugestao`;
// aqui, dois casos representativos para confirmar que a Fase 1 não tocou nesse comportamento.
test('H5: sugestao é o antigo top-k de next_tool com piso por item — top muito confiante, resto ínfimo', () => {
  const catalogoNextTool = [{ name: 'task_listar', power: 'tarefas' }, { name: 'executar_tool_em_background', power: 'async-shadows' }];
  const d = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.92, probabilities: { task_listar: 0.93, executar_tool_em_background: 0.01 } } }, { catalogo: catalogoNextTool });
  assert.deepEqual(d.sugestao.map((h) => h.power), ['tarefas']);
});

test('H5: sugestao — dúvida real entre dois powers, os dois acima do piso entram', () => {
  const catalogoNextTool = [{ name: 'task_listar', power: 'tarefas' }, { name: 'gcal_listar_eventos', power: 'google-calendar' }];
  const d = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.5, probabilities: { task_listar: 0.5, gcal_listar_eventos: 0.35 } } }, { catalogo: catalogoNextTool });
  assert.deepEqual(d.sugestao.map((h) => h.power), ['tarefas', 'google-calendar']);
});

// --- Degradado: listas vazias, nunca lança ---------------------------------------------------

test('degradado (sem cliente): hidratar e sugestao vazios mesmo com powersCandidatos preenchido', async () => {
  const d = await decidir({ estado: { pedido: 'p' }, catalogo, cliente: null, powersCandidatos: [{ id: 'tarefas', desc: 'x' }] });
  assert.equal(d.meta.degradado, 'sem-chave');
  assert.deepEqual(d.hidratar, []);
  assert.deepEqual(d.sugestao, []);
});

test('degradado (catálogo vazio): hidratar e sugestao vazios', async () => {
  const d = await decidir({ estado: { pedido: 'p' }, catalogo: [], cliente: { decidir: async () => { throw new Error('não deveria chamar'); } }, powersCandidatos: [{ id: 'tarefas', desc: 'x' }] });
  assert.equal(d.meta.degradado, 'catalogo-vazio');
  assert.deepEqual(d.hidratar, []);
  assert.deepEqual(d.sugestao, []);
});

test('aplicarGates sem powersCandidatos (default []): hidratar vazio, não lança', () => {
  const d = aplicarGates(respostaBase, { catalogo });
  assert.deepEqual(d.hidratar, []);
});

// --- H1/A1: texto de hidratar_<id> é o B1 exato da bancada, com <id>/<desc> interpolados -----

test('texto de hidratar_<id> é exatamente o B1 da bancada, com <id>/<desc> interpolados', () => {
  const q = montarPerguntas({ catalogo, powersCandidatos: [{ id: 'gestao_pessoal', desc: 'Gerencia tarefas pessoais e rotinas.' }] });
  assert.equal(q.hidratar_gestao_pessoal.type, 'noul');
  assert.equal(
    q.hidratar_gestao_pessoal.instructions,
    'Para atender este pedido, o assistente vai precisar usar alguma tool do power gestao_pessoal — "Gerencia tarefas pessoais e rotinas."? Verdadeiro só se o pedido exigir; falso se não tiver relação.',
  );
  assert.equal(q.hidratar_gestao_pessoal.instructions, instrucoesHidratarPower('gestao_pessoal', 'Gerencia tarefas pessoais e rotinas.'));
  assert.deepEqual(q.hidratar_gestao_pessoal.criteria, { true: 'o pedido exige usar alguma tool deste power', false: 'o pedido não tem relação com este power, ou já está resolvido sem ele' });
  assert.deepEqual(q.hidratar_gestao_pessoal.criteria, CRITERIA_HIDRATAR_POWER);
});

// --- H6: hidratar_* é protegido do teto de 60, igual a prefetch_*/pfarg_* -------------------

test('H6: hidratar_* nunca é cortado pelo teto de 60 — power_* cede primeiro', () => {
  const perguntasDosPowers = { testpower: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`q${i}`, { type: 'noul', instructions: 'x' }])) };
  const powersCandidatos = [{ id: 'tarefas', desc: 'x' }, { id: 'google-calendar', desc: 'y' }];
  const q = montarPerguntas({ catalogo, perguntasDosPowers, powersCandidatos });
  const chaves = Object.keys(q);
  assert.equal(chaves.length, TETO_PERGUNTAS);
  assert.ok(chaves.includes('hidratar_tarefas') && chaves.includes('hidratar_google-calendar'), 'hidratar_* não pode ser cortado');
  assert.equal(chaves.filter((k) => k.startsWith('power_')).length, TETO_PERGUNTAS - 4, 'next_tool + pronto + as 2 hidratar_* sobrevivem, o resto do orçamento é power_*');
});

test('cortes padrão inclui hidratarPower: 0.7', () => {
  assert.equal(CORTES_PADRAO.hidratarPower, 0.7);
});

// --- decidir() de ponta a ponta (review do conjunto, item 3): cliente fake confere as perguntas
// hidratar_<id> recebidas (texto B1 exato, igual ao teste de texto acima) e devolve respostas;
// confirma hidratar + sugestao juntos na mesma Decisao, e que powersAtivos (vindo de `estado`,
// não filtrado por quem monta `powersCandidatos`) descarta um candidato já ativo — H4 cinto e
// suspensório, mas agora exercitado pelo caminho público (`decidir()`), não só por `aplicarGates`
// isolado como os testes acima.
test('decidir() de ponta a ponta: powersCandidatos gera hidratar_<id> com o texto B1, resposta popula hidratar e sugestao juntos, powersAtivos filtra quem já está ativo', async () => {
  const catalogoTurno = [
    { name: 'task_listar', power: 'tarefas', desc: 'Lista tarefas.' },
    { name: 'gcal_listar_eventos', power: 'google-calendar', desc: 'Lista eventos.' },
  ];
  const powersCandidatos = [
    { id: 'tarefas', desc: 'Gerencia tarefas.' },
    { id: 'google-calendar', desc: 'Gerencia agenda.' },
    { id: 'ja-ativo', desc: 'Já carregado.' },
  ];
  let questionsRecebidas = null;
  const cliente = {
    decidir: async ({ questions }) => {
      questionsRecebidas = questions;
      return {
        answers: {
          next_tool: { choice: 'task_listar', confidence: 0.9, probabilities: { task_listar: 0.9, gcal_listar_eventos: 0.05 } },
          pronto: { noul: 0.2 },
          hidratar_tarefas: { noul: 0.85 },
          'hidratar_google-calendar': { noul: 0.72 },
          'hidratar_ja-ativo': { noul: 0.99 },
        },
        usage: { input_tokens: 50, cost: 0.000002 },
        modelo: 'fake',
        ms: 10,
      };
    },
  };
  const d = await decidir({
    estado: { pedido: 'agenda uma reunião e lista minhas tarefas', powersAtivos: ['ja-ativo'] },
    catalogo: catalogoTurno,
    cliente,
    powersCandidatos,
  });
  // as três perguntas foram enviadas ao Jev (montarPerguntas não filtra por powersAtivos — só
  // aplicarGates filtra a RESPOSTA, defensivamente, H4), com o texto B1 exato.
  assert.equal(questionsRecebidas.hidratar_tarefas.instructions, instrucoesHidratarPower('tarefas', 'Gerencia tarefas.'));
  assert.equal(questionsRecebidas['hidratar_google-calendar'].instructions, instrucoesHidratarPower('google-calendar', 'Gerencia agenda.'));
  assert.ok(questionsRecebidas['hidratar_ja-ativo'], 'pergunta de power já ativo ainda é enviada — o filtro é na resposta, não na pergunta');
  assert.equal(d.meta.degradado, false);
  assert.deepEqual(d.hidratar, [{ power: 'tarefas', noul: 0.85 }, { power: 'google-calendar', noul: 0.72 }]);
  assert.deepEqual(d.sugestao.map((s) => ({ tool: s.tool, power: s.power })), [{ tool: 'task_listar', power: 'tarefas' }]);
});

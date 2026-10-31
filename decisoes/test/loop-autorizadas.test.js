import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rodarLoop, PISO_ESCRITA } from '../src/loop/index.js';
import { perguntasDoPasso } from '../src/loop/passo.js';

const luz = { nome: 'autorizada_a1', descricao: 'ligar luz do escritório', capacidade: 'mcp-ha', autorizada: { id: 'a1', args: { area: 'escritório' } }, params: async () => [] };
const leitura = { nome: 'task_listar', descricao: 'lista', capacidade: 'tarefas', params: async () => [] };
function clienteQue(acao, conf, probs) {
  const chamadas = [];
  return { chamadas, async decidir({ state, questions }) {
    chamadas.push({ state, questions });
    return { answers: { acao: { choice: chamadas.length === 1 ? acao : 'pronto', confidence: conf, probabilities: probs ?? { [acao]: conf } }, mais: { choice: 'nao', confidence: 0.99 } }, ms: 3 };
  } };
}
const base = { candidatas: [], comArgs: [], rastro: [] };

test('pergunta marca AUTORIZADA e inclui exceção só quando há autorizada', () => {
  const q = perguntasDoPasso({ ...base, funcoes: [luz] });
  assert.match(JSON.stringify(q.acao), /AUTORIZADA/);
  assert.match(JSON.stringify(q.acao), /exceção/);
  assert.doesNotMatch(JSON.stringify(perguntasDoPasso({ ...base, funcoes: [leitura] }).acao), /AUTORIZADA|exceção/);
});

test('escrita com confiança alta executa e a flag chega à pergunta', async () => {
  const chamadas = [];
  const cliente = clienteQue(luz.nome, 0.95);
  const r = await rodarLoop({ pergunta: 'Liga a luz.', espaco: { funcoes: [luz], candidatas: [] }, cliente, executar: async (fn) => { chamadas.push(fn); return '{"ok":true}'; } });
  assert.deepEqual(chamadas.map(f => f.nome), [luz.nome]);
  assert.deepEqual(chamadas[0].autorizada, luz.autorizada);
  assert.equal(r.rastro[0].fn, luz.nome);
  assert.match(JSON.stringify(cliente.chamadas[0].questions.acao), /AUTORIZADA/);
  assert.ok(!Object.keys(cliente.chamadas[0].questions).some(k => k.startsWith('arg_')));
});

test('escrita abaixo de 0,7 não executa e vai para o modelo', async () => {
  assert.equal(PISO_ESCRITA, 0.7);
  const chamadas = [];
  const r = await rodarLoop({ pergunta: 'Liga a luz.', espaco: { funcoes: [luz], candidatas: [] }, cliente: clienteQue(luz.nome, 0.55), executar: async (fn) => { chamadas.push(fn.nome); return '{}'; } });
  assert.deepEqual(chamadas, []);
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.paraOModelo, [{ nome: luz.nome, capacidade: luz.capacidade }]);
});

test('leitura continua executando a 0,55', async () => {
  const chamadas = [];
  await rodarLoop({ pergunta: 'minhas tarefas', espaco: { funcoes: [leitura], candidatas: [] }, cliente: clienteQue(leitura.nome, 0.55), executar: async fn => { chamadas.push(fn.nome); return '[]'; } });
  assert.deepEqual(chamadas, [leitura.nome]);
});

test('cortes.escrita é configurável e respeita o piso geral', async () => {
  for (const [cortes, esperado] of [[{ escrita: 0.5 }, [luz.nome]], [{ escrita: 0.5, execucao: 0.6 }, []]]) {
    const chamadas = [];
    await rodarLoop({ pergunta: 'Liga a luz.', espaco: { funcoes: [luz], candidatas: [] }, cortes, cliente: clienteQue(luz.nome, 0.55), executar: async fn => { chamadas.push(fn.nome); return '{}'; } });
    assert.deepEqual(chamadas, esperado);
  }
});

test('soma de probabilidades não promove ação autorizada abaixo do corte de ação', async () => {
  const chamadas = [];
  const r = await rodarLoop({ pergunta: 'Liga a luz.', espaco: { funcoes: [luz, leitura], candidatas: [] }, cortes: { acao: 0.8, escrita: 0.5 }, cliente: clienteQue(luz.nome, 0.55, { [luz.nome]: 0.55, [leitura.nome]: 0.4 }), executar: async fn => { chamadas.push(fn.nome); return '{}'; } });
  assert.deepEqual(chamadas, []);
  assert.equal(r.estado, 'pronto');
});

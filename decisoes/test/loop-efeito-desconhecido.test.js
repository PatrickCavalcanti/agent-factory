import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rodarLoop } from '../src/loop/index.js';

const luz = {
  nome: 'autorizada_a1',
  descricao: 'ligar luz do escritório',
  capacidade: 'mcp-ha',
  autorizada: { id: 'a1', args: { area: 'escritório' } },
  params: async () => [],
};

const leitura = {
  nome: 'task_listar',
  descricao: 'lista tarefas',
  capacidade: 'tarefas',
  params: async () => [],
};

function clienteQue(acao, conf) {
  const chamadas = [];
  return {
    chamadas,
    async decidir({ state, questions }) {
      chamadas.push({ state, questions });
      return {
        answers: {
          acao: { choice: chamadas.length === 1 ? acao : 'pronto', confidence: conf, probabilities: { [acao]: conf } },
          mais: { choice: 'nao', confidence: 0.99 },
        },
        ms: 3,
      };
    },
  };
}

test('ação autorizada cujo executar estoura prazo -> efeitoDesconhecido: true, erro: prazo da execução, estado: estourado', async () => {
  const r = await rodarLoop({
    pergunta: 'Liga a luz.',
    espaco: { funcoes: [luz], candidatas: [] },
    cliente: clienteQue(luz.nome, 0.95),
    executar: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return '{}';
    },
    orcamento: { prazoTotalMs: 400, prazoPassoMs: 200 },
  });

  assert.equal(r.estado, 'estourado');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].efeitoDesconhecido, true);
  assert.equal(r.rastro[0].erro, 'prazo da execução');
});

test('função de leitura cujo executar estoura prazo -> efeitoDesconhecido indefinido', async () => {
  const r = await rodarLoop({
    pergunta: 'listar tarefas',
    espaco: { funcoes: [leitura], candidatas: [] },
    cliente: clienteQue(leitura.nome, 0.95),
    executar: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return '[]';
    },
    orcamento: { prazoTotalMs: 400, prazoPassoMs: 200 },
  });

  assert.equal(r.estado, 'estourado');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].efeitoDesconhecido, undefined);
  assert.equal(r.rastro[0].erro, 'prazo da execução');
});

test('execução que lança erro comum numa autorizada -> efeitoDesconhecido indefinido (falha confirmada)', async () => {
  const r = await rodarLoop({
    pergunta: 'Liga a luz.',
    espaco: { funcoes: [luz], candidatas: [] },
    cliente: clienteQue(luz.nome, 0.95),
    executar: async () => {
      throw new Error('dispositivo offline');
    },
    orcamento: { prazoTotalMs: 1000, prazoPassoMs: 500 },
  });

  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].efeitoDesconhecido, undefined);
  assert.equal(r.rastro[0].erro, 'dispositivo offline');
});

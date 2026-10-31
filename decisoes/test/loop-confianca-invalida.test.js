import test from 'node:test';
import assert from 'node:assert/strict';
import { rodarLoop } from '../src/loop/index.js';

function jevRoteirizado(roteiro) {
  const chamadas = [];
  return {
    chamadas,
    async decidir({ state, questions }) {
      chamadas.push({ state, questions });
      const r = roteiro[Math.min(chamadas.length - 1, roteiro.length - 1)];
      const answers = { acao: { choice: r.acao, confidence: r.conf ?? 0.9, probabilities: r.probs ?? { [r.acao]: r.conf ?? 0.9 } } };
      for (const [param, valor] of Object.entries(r.args ?? {})) answers[`arg_${r.acao}_${param}`] = { choice: valor, confidence: r.confArgs ?? 0.9 };
      if (r.mais !== undefined) answers.mais = { choice: r.mais, confidence: r.confMais ?? 0.9 };
      return { answers, ms: 3 };
    },
  };
}

const autorizada = {
  nome: 'autorizada_a1',
  descricao: 'ligar luz',
  capacidade: 'mcp-ha',
  autorizada: { id: 'a1', args: {} },
  params: async () => [],
};

const leitura = {
  nome: 'ler_luz',
  descricao: 'ler luz',
  capacidade: 'mcp-ha',
  params: async () => [],
};

test('confidence 0.95 executa ação autorizada (1 chamada)', async () => {
  let chamadas = 0;
  const cliente = jevRoteirizado([{ acao: autorizada.nome, conf: 0.95, mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'liga a luz',
    espaco: { funcoes: [autorizada], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"ok":true}'; },
  });
  assert.equal(chamadas, 1);
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].fn, autorizada.nome);
});

test('confidence 1e400 (Infinity) NÃO executa ação autorizada', async () => {
  let chamadas = 0;
  const cliente = jevRoteirizado([{ acao: autorizada.nome, conf: Infinity, mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'liga a luz',
    espaco: { funcoes: [autorizada], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"ok":true}'; },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'pronto');
});

test('confidence -1 NÃO executa ação autorizada', async () => {
  let chamadas = 0;
  const cliente = jevRoteirizado([{ acao: autorizada.nome, conf: -1, mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'liga a luz',
    espaco: { funcoes: [autorizada], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"ok":true}'; },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'pronto');
});

test('confidence NaN NÃO executa ação autorizada', async () => {
  let chamadas = 0;
  const cliente = jevRoteirizado([{ acao: autorizada.nome, conf: NaN, mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'liga a luz',
    espaco: { funcoes: [autorizada], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"ok":true}'; },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'pronto');
});

test("confidence '0.95' (string) NÃO executa ação autorizada", async () => {
  let chamadas = 0;
  const cliente = jevRoteirizado([{ acao: autorizada.nome, conf: '0.95', mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'liga a luz',
    espaco: { funcoes: [autorizada], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"ok":true}'; },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'pronto');
});

test('função de LEITURA com 1e400 (Infinity) NÃO executa e vai para paraOModelo', async () => {
  let chamadas = 0;
  // probs válidas somam acima do corte de ação (0,4), mas a confiança individual da ação é Infinity (inválida -> 0)
  // piso de leitura (0,4) barra a execução e devolve a função em paraOModelo
  const probs = { [leitura.nome]: 0.9 };
  const cliente = jevRoteirizado([{ acao: leitura.nome, conf: Infinity, probs, mais: 'nao' }]);
  const r = await rodarLoop({
    pergunta: 'como está a luz',
    espaco: { funcoes: [leitura], candidatas: [] },
    cliente,
    executar: async () => { chamadas++; return '{"estado":"on"}'; },
  });
  assert.equal(chamadas, 0);
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.paraOModelo, [{ nome: leitura.nome, capacidade: leitura.capacidade }]);
});

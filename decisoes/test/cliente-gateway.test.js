// packages/decisions/test/cliente-gateway.test.js
// Cliente do Jev pelo gateway (Task 1.2) — cumpre o mesmo contrato de criarCliente
// (../cliente.js): decidir({state, questions}) -> {answers, usage, modelo, id, ms, cost}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarClienteDoGateway } from '../src/cliente-gateway.js';
import { perguntar } from '../src/nucleo/perguntar.js';

test('criarClienteDoGateway: protocolo com decide() é obrigatório', () => {
  assert.throws(() => criarClienteDoGateway({ protocolo: null }), /protocolo/);
  assert.throws(() => criarClienteDoGateway({ protocolo: {} }), /protocolo/);
});

test('criarClienteDoGateway: consumer é obrigatório (sem padrão do Igris)', () => {
  const protocolo = { decide: async () => ({ answers: {} }) };
  assert.throws(() => criarClienteDoGateway({ protocolo }), /consumer/);
  assert.throws(() => criarClienteDoGateway({ protocolo, consumer: '' }), /consumer/);
});

test('decidir: chama protocolo.decide() com state, questions, timeoutMs e routing (_consumer/_slot)', async () => {
  let recebido = null;
  const protocolo = {
    decide: async (args) => { recebido = args; return { answers: { a: true }, usage: { inputTokens: 1 } }; },
  };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  await c.decidir({ state: { pedido: 'oi' }, questions: { a: { type: 'noul', instructions: 'x' } } });

  assert.deepEqual(recebido.state, { pedido: 'oi' });
  assert.deepEqual(recebido.questions, { a: { type: 'noul', instructions: 'x' } });
  assert.equal(recebido.timeoutMs, 1500);
  assert.equal(recebido._consumer, 'module:executor');
  assert.equal(recebido._slot, 'decision');
});

test('decidir: consumer/slot/timeoutMs customizados na fábrica chegam no decide()', async () => {
  let recebido = null;
  const protocolo = { decide: async (args) => { recebido = args; return { answers: {} }; } };
  const c = criarClienteDoGateway({ protocolo, consumer: 'power:x', slot: 'outro', timeoutMs: 900 });
  await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });

  assert.equal(recebido._consumer, 'power:x');
  assert.equal(recebido._slot, 'outro');
  assert.equal(recebido.timeoutMs, 900);
});

test('decidir: mapeia answers/usage/model/cost da resposta do protocolo', async () => {
  const protocolo = {
    decide: async () => ({
      answers: { cap_x: true },
      usage: { inputTokens: 10, outputTokens: 3 },
      provider: 'openrouter',
      model: 'typesafe/jev-1.13',
      cost: { credits: 1, pricingVersion: 'v1', pricedByFallback: false },
    }),
  };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });

  assert.deepEqual(r.answers, { cap_x: true });
  assert.equal(r.modelo, 'typesafe/jev-1.13');
  assert.deepEqual(r.cost, { credits: 1, pricingVersion: 'v1', pricedByFallback: false });
  assert.ok(r.ms >= 0);
});

test('decidir: usage normalizado com input_tokens/output_tokens/cost (formato que perguntar() lê), sem perder os campos originais do gateway', async () => {
  const protocolo = {
    decide: async () => ({
      answers: { cap_x: true },
      usage: { inputTokens: 10, outputTokens: 3 },
      model: 'typesafe/jev-1.13',
      cost: { credits: 2, pricingVersion: 'v1', pricedByFallback: false },
    }),
  };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });

  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.usage.output_tokens, 3);
  assert.equal(r.usage.cost, 2);
  // Campos originais do gateway continuam presentes (camelCase), por completude.
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.usage.outputTokens, 3);
});

test('decidir: usage sem inputTokens/outputTokens/cost do gateway normaliza para 0, nunca undefined', async () => {
  const protocolo = { decide: async () => ({ answers: {} }) };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });

  assert.equal(r.usage.input_tokens, 0);
  assert.equal(r.usage.output_tokens, 0);
  assert.equal(r.usage.cost, 0);
});

test('decidir: sem model na resposta, modelo cai no default "gateway:decision"', async () => {
  const protocolo = { decide: async () => ({ answers: { a: true } }) };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.equal(r.modelo, 'gateway:decision');
});

test('modelo: propriedade do cliente é o default antes de qualquer chamada', () => {
  const protocolo = { decide: async () => ({ answers: {} }) };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  assert.equal(c.modelo, 'gateway:decision');
});

test('fim a fim: perguntar() com cliente do gateway devolve meta.tokens e meta.custo > 0 (correção do review — antes saíam 0, formato OpenRouter vs gateway)', async () => {
  const protocolo = {
    decide: async () => ({
      answers: { cap_x: true },
      usage: { inputTokens: 42, outputTokens: 7 },
      model: 'typesafe/jev-1.13',
      cost: { credits: 5, pricingVersion: 'v1', pricedByFallback: false },
    }),
  };
  const cliente = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  const { answers, meta } = await perguntar({
    state: { pedido: 'oi' },
    questions: { cap_x: { type: 'noul', instructions: 'x' } },
    cliente,
  });

  assert.deepEqual(answers, { cap_x: true });
  assert.ok(meta.tokens > 0, `meta.tokens deveria ser > 0, veio ${meta.tokens}`);
  assert.ok(meta.custo > 0, `meta.custo deveria ser > 0, veio ${meta.custo}`);
  assert.equal(meta.degradado, false);
});

test('decidir: erro do protocolo propaga (perguntar() do núcleo é quem degrada)', async () => {
  const protocolo = { decide: async () => { throw new Error('gateway indisponível'); } };
  const c = criarClienteDoGateway({ protocolo, consumer: 'module:executor' });
  await assert.rejects(
    () => c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } }),
    /gateway indisponível/,
  );
});

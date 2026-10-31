import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarCliente } from '../src/cliente.js';

const respostaOk = { model: 'typesafe/jev-1.13', answers: { q: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, output_tokens: 0, cost: 0.0000004 } };
const fetchQue = (fila) => async (url, init) => {
  const item = fila.shift();
  if (item instanceof Error) throw item;
  return { status: item.status, text: async () => JSON.stringify(item.body), ok: item.status === 200 };
};

test('sucesso devolve answers, usage e ms', async () => {
  const c = criarCliente({ chave: 'k', fetchImpl: fetchQue([{ status: 200, body: respostaOk }]) });
  const r = await c.decidir({ state: {}, questions: { q: { type: 'noul', instructions: 'x' } } });
  assert.deepEqual(r.answers, respostaOk.answers);
  assert.equal(r.usage.input_tokens, 10);
  assert.ok(r.ms >= 0);
});

test('429 e 529 tentam de novo; 3ª tentativa sobe erro', async () => {
  const c = criarCliente({ chave: 'k', fetchImpl: fetchQue([{ status: 429, body: {} }, { status: 529, body: {} }, { status: 200, body: respostaOk }]), esperaMs: 0 });
  const r = await c.decidir({ state: {}, questions: {} });
  assert.equal(r.answers.q.noul, 0.8);
  const c2 = criarCliente({ chave: 'k', fetchImpl: fetchQue([{ status: 429, body: {} }, { status: 429, body: {} }, { status: 429, body: {} }]), esperaMs: 0 });
  await assert.rejects(() => c2.decidir({ state: {}, questions: {} }), /HTTP 429/);
});

test('401 não tenta de novo', async () => {
  const fila = [{ status: 401, body: { error: { message: 'no auth' } } }, { status: 200, body: respostaOk }];
  const c = criarCliente({ chave: 'k', fetchImpl: fetchQue(fila), esperaMs: 0 });
  await assert.rejects(() => c.decidir({ state: {}, questions: {} }), /HTTP 401/);
  assert.equal(fila.length, 1);
});

test('timeout aborta e sobe erro com nome', async () => {
  const fetchLento = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const c = criarCliente({ chave: 'k', fetchImpl: fetchLento, timeoutMs: 20 });
  await assert.rejects(() => c.decidir({ state: {}, questions: {} }), /timeout/);
});

test('200 com corpo que não é JSON', async () => {
  const c = criarCliente({ chave: 'k', fetchImpl: async () => ({ status: 200, ok: true, text: async () => 'isso não é json{' }) });
  await assert.rejects(() => c.decidir({ state: {}, questions: {} }), /não é JSON/);
});

test('200 com JSON válido mas sem answers', async () => {
  const c = criarCliente({ chave: 'k', fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ usage: { input_tokens: 1 } }) }) });
  await assert.rejects(() => c.decidir({ state: {}, questions: {} }), /sem answers/);
});

test('sem chave lança antes de chamar', async () => {
  const c = criarCliente({ chave: '', fetchImpl: async () => { throw new Error('não deveria chamar'); } });
  await assert.rejects(() => c.decidir({ state: {}, questions: {} }), /chave/);
});

test('X-Title: padrão neutro "agent-factory"; o host passa o dele (Igris: "igris-decisions")', async () => {
  const titulos = [];
  const f = async (_u, o) => { titulos.push(o.headers['X-Title']); return { status: 200, ok: true, text: async () => JSON.stringify(respostaOk) }; };
  await criarCliente({ chave: 'k', fetchImpl: f }).decidir({ state: {}, questions: {} });
  await criarCliente({ chave: 'k', fetchImpl: f, xTitle: 'igris-decisions' }).decidir({ state: {}, questions: {} });
  assert.deepEqual(titulos, ['agent-factory', 'igris-decisions']);
});

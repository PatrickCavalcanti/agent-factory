// Prazo macio de decidir(): o turno recebe a decisão degradada no prazo, e a resposta que
// chega depois é entregue a `aoChegarTarde` com o ms real (diagnóstico, nunca aplicada).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir } from '../src/index.js';

const catalogo = [{ name: 'task_listar', power: 'tarefas', desc: 'Lista tarefas.', prefetch: true, params: [{ name: 'status', enum: ['pending', 'done'] }] }];
const respostas = {
  next_tool: { type: 'choice', choice: 'task_listar', confidence: 0.9 },
  pronto: { type: 'noul', noul: 0.1 },
  prefetch_task_listar: { type: 'noul', noul: 0.95 },
  pfarg_task_listar_status: { type: 'choice', choice: 'pending', confidence: 0.99 },
};
const clienteQueDemora = (ms, resultado) => ({ decidir: () => new Promise((res, rej) => setTimeout(() => (resultado instanceof Error ? rej(resultado) : res(resultado)), ms)) });

test('estoura o prazo: devolve degradado timeout na hora e entrega a resposta tardia', async () => {
  let tardia;
  const chegou = new Promise((res) => { tardia = res; });
  const t0 = Date.now();
  const d = await decidir({ estado: { pedido: 'x' }, catalogo, cliente: clienteQueDemora(120, { answers: respostas, ms: 120 }), prazoMs: 30, aoChegarTarde: (r) => tardia(r) });
  assert.equal(d.meta.degradado, 'timeout');
  assert.ok(Date.now() - t0 < 110, 'não esperou a resposta');
  const r = await chegou;
  assert.equal(r.meta.degradado, false);
  assert.deepEqual(r.prefetch.map((p) => [p.tool, p.args]), [['task_listar', { status: 'pending' }]]);
  assert.ok(r.meta.msReal >= 100);
});

test('responde dentro do prazo: decisão normal, sem resposta tardia', async () => {
  let chamouTarde = false;
  const d = await decidir({ estado: { pedido: 'x' }, catalogo, cliente: clienteQueDemora(5, { answers: respostas, ms: 5 }), prazoMs: 200, aoChegarTarde: () => { chamouTarde = true; } });
  assert.equal(d.meta.degradado, false);
  assert.equal(d.prefetch.length, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(chamouTarde, false);
});

test('erro antes do prazo continua degradando pelo erro', async () => {
  const d = await decidir({ estado: { pedido: 'x' }, catalogo, cliente: clienteQueDemora(5, new Error('decisions: HTTP 500 após 1 tentativas')), prazoMs: 200 });
  assert.equal(d.meta.degradado, 'erro');
});

test('erro depois do prazo chega como tardia degradada, sem rejeição solta', async () => {
  let tardia;
  const chegou = new Promise((res) => { tardia = res; });
  const d = await decidir({ estado: { pedido: 'x' }, catalogo, cliente: clienteQueDemora(60, new Error('decisions: timeout após 15000ms')), prazoMs: 10, aoChegarTarde: (r) => tardia(r) });
  assert.equal(d.meta.degradado, 'timeout');
  const r = await chegou;
  assert.equal(r.meta.degradado, 'timeout');
});

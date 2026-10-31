// Estratégias de candidatos: valores do pedido viram opções de baixa confiança para
// parâmetros de texto livre das tools de prefetch (candidatos.js + gates.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entreAspas, aplicarEstrategiasDeCandidatos, decidir, montarPerguntas, aplicarGates } from '../src/index.js';

const catalogo = [
  { name: 'listar', power: 'p', desc: 'Lista itens.', prefetch: true, params: [{ name: 'grupo', type: 'string' }, { name: 'status', type: 'string', enum: ['aberto', 'fechado'] }] },
  { name: 'criar', power: 'p', desc: 'Cria item.', params: [{ name: 'titulo', type: 'string' }] },
];

test('entreAspas pega aspas retas e tipográficas, ignora vazio e longo demais', () => {
  assert.deepEqual(entreAspas({ pedido: 'use "aberto" e “Grupo A”' }), ['aberto', 'Grupo A']);
  assert.deepEqual(entreAspas({ pedido: 'valor "' + 'x'.repeat(90) + '" é longo' }), []);
  assert.deepEqual(entreAspas({ pedido: 'vazio "" não conta' }), []);
  assert.deepEqual(entreAspas({ pedido: 'sem aspas' }), []);
});

test('só parâmetro string sem enum, de tool de prefetch, recebe candidatos', () => {
  const c = aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'status "aberto", grupo "Grupo A"' });
  const listar = c.find((t) => t.name === 'listar');
  assert.deepEqual(listar.params[0].enum, ['aberto', 'Grupo A']);
  assert.equal(listar.params[0].candidatoDinamico, true);
  assert.deepEqual(listar.params[1].enum, ['aberto', 'fechado']); // enum do schema intacto
  assert.equal(c.find((t) => t.name === 'criar').params[0].enum, undefined); // não é prefetch
  assert.equal(aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'nada citado' }), catalogo);
});

test('montarPerguntas gera pfarg para o parâmetro com candidatos', () => {
  const c = aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'grupo "Grupo A"' });
  const q = montarPerguntas({ catalogo: c });
  assert.ok(q.pfarg_listar_grupo);
  assert.ok('Grupo A' in q.pfarg_listar_grupo.criteria);
});

const base = { next_tool: { choice: 'listar', confidence: 0.9 }, prefetch_listar: { noul: 0.95 }, pfarg_listar_status: { choice: 'aberto', confidence: 0.99 } };

test('gate: candidato escolhido com confiança entra nos args', () => {
  const c = aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'grupo "Grupo A"' });
  const d = aplicarGates({ ...base, pfarg_listar_grupo: { choice: 'Grupo A', confidence: 0.9 } }, { catalogo: c });
  assert.deepEqual(d.prefetch[0].args, { grupo: 'Grupo A', status: 'aberto' });
});

test('gate: candidato incerto só omite o parâmetro, não descarta o item', () => {
  const c = aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'grupo "Grupo A"' });
  const d = aplicarGates({ ...base, pfarg_listar_grupo: { choice: 'Grupo A', confidence: 0.4 } }, { catalogo: c });
  assert.equal(d.prefetch.length, 1);
  assert.deepEqual(d.prefetch[0].args, { status: 'aberto' });
  assert.deepEqual(d.prefetch[0].argsOmitidos, [{ param: 'grupo', motivo: 'argumento-incerto' }]);
  assert.deepEqual(d.prefetchDescartados, []);
});

test('gate: enum do schema incerto continua descartando o item (A3)', () => {
  const c = aplicarEstrategiasDeCandidatos(catalogo, { pedido: 'grupo "Grupo A"' });
  const d = aplicarGates({ ...base, pfarg_listar_status: { choice: 'aberto', confidence: 0.4 }, pfarg_listar_grupo: { choice: 'Grupo A', confidence: 0.9 } }, { catalogo: c });
  assert.equal(d.prefetch.length, 0);
  assert.equal(d.prefetchDescartados[0].motivo, 'argumento-incerto');
});

test('decidir aplica a estratégia a partir do pedido', async () => {
  let perguntas;
  const cliente = { decidir: async ({ questions }) => { perguntas = questions; return { answers: { ...base, pfarg_listar_grupo: { choice: 'Grupo A', confidence: 0.9 } }, ms: 1 }; } };
  const d = await decidir({ estado: { pedido: 'consulte o grupo "Grupo A"' }, catalogo, cliente });
  assert.ok(perguntas.pfarg_listar_grupo);
  assert.deepEqual(d.prefetch[0].args, { grupo: 'Grupo A', status: 'aberto' });
});

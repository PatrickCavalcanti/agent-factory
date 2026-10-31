import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacidadesDoLoop } from '../src/loop-do-turno.js';

test('capacidade carregada por fonte de memória entra no espaço do loop', () => {
  const ids = capacidadesDoLoop({ explain: [], promocoes: [], deFontes: ['mcp-home-assistant'], capacidades: [{ id: 'mcp-home-assistant', preExecucao: true }] });
  assert.deepEqual([...ids], ['mcp-home-assistant']);
});

test('preExecucao:false continua fora, mesmo vindo de fonte', () => {
  const ids = capacidadesDoLoop({ explain: [], promocoes: [], deFontes: ['mcp-x'], capacidades: [{ id: 'mcp-x', preExecucao: false }] });
  assert.deepEqual([...ids], []);
});

test('sem deFontes o comportamento é o de antes', () => {
  const ids = capacidadesDoLoop({ explain: [{ ring: 'provider', tier: 'full', ref: 'tarefas' }], promocoes: ['agenda'], capacidades: [] });
  assert.deepEqual([...ids].sort(), ['agenda', 'tarefas']);
});

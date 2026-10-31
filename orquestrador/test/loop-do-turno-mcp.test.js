import { test } from 'node:test';
import assert from 'node:assert/strict';
import { espacoDoLoop, capacidadesDoLoop } from '../src/loop-do-turno.js';

const tool = (name, effect) => ({ name, effect, description: name, handler: async () => '{}' });
const cap = (id, tools, extra = {}) => ({ id, descricao: id, tools, preExecucao: true, ...extra });
const paramsDe = async () => [];

test('servidor MCP com preExecucao ligado: só as funções anotadas como leitura entram', () => {
  const capacidades = [cap('mcp-nidavellir', [tool('mcp_n_list', 'read'), tool('mcp_n_close', 'write')])];
  const espaco = espacoDoLoop({ capacidades, carregadas: ['mcp-nidavellir'], candidatas: [], paramsDe });
  assert.deepEqual(espaco.funcoes.map((f) => f.tool.name), ['mcp_n_list']);
});

test('servidor MCP sem nenhuma anotação (tudo write, como o Home Assistant): espaço vazio e sem candidata', () => {
  const capacidades = [cap('mcp-home-assistant', [tool('mcp_ha_turnon', 'write'), tool('mcp_ha_context', 'write')])];
  const espaco = espacoDoLoop({ capacidades, carregadas: ['mcp-home-assistant'], candidatas: ['mcp-home-assistant'], paramsDe });
  assert.deepEqual(espaco.funcoes, []);
  assert.deepEqual(espaco.candidatas, []);
});

test('servidor com preExecucao:false não entra nem por fonte, nem por candidata', () => {
  const capacidades = [cap('mcp-lento', [tool('mcp_l_read', 'read')], { preExecucao: false })];
  const ids = capacidadesDoLoop({ explain: [], promocoes: [], deFontes: ['mcp-lento'], capacidades });
  assert.deepEqual([...ids], []);
  const espaco = espacoDoLoop({ capacidades, carregadas: ['mcp-lento'], candidatas: ['mcp-lento'], paramsDe });
  assert.deepEqual(espaco.funcoes, []);
  assert.deepEqual(espaco.candidatas, []);
});

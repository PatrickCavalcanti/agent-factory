import { test } from 'node:test';
import assert from 'node:assert/strict';
import { espacoDoLoop, entregaDoLoop } from '../src/loop-do-turno.js';

const handler = async () => '{}';
const ha = { id: 'mcp-home-assistant', descricao: 'Home Assistant', preExecucao: true, tools: [
  { name: 'turnon', effect: 'write', description: 'liga', handler },
  { name: 'context', effect: 'write', description: 'contexto', handler },
] };
const paramsDe = async () => [];
const aut = (id, funcao, args, rotulo) => ({ id, capacidade: ha.id, funcao, args, rotulo });
const espaco = (autorizacoes, extra = {}) => espacoDoLoop({ capacidades: [ha], carregadas: [ha.id], candidatas: [], paramsDe, autorizacoes, ...extra });

test('ação autorizada oferece a ferramenta real e argumentos fixos, sem perguntas', async () => {
  const args = { area: 'escritório', domain: ['light'] };
  const e = espaco([aut('a1', 'turnon', args, 'ligar luz do escritório')]);
  assert.equal(e.funcoes.length, 1);
  const [f] = e.funcoes;
  assert.equal(f.nome, 'autorizada_a1');
  assert.match(f.descricao, /ligar luz do escritório/);
  assert.equal(f.tool, ha.tools[0]);
  assert.deepEqual(f.autorizada, { id: 'a1', args });
  assert.deepEqual(await f.params(), []);
});

test('duas chamadas da mesma função são opções diferentes', () => {
  const e = espaco([aut('a1', 'turnon', { domain: ['light'] }, 'luz'), aut('a2', 'turnon', { domain: ['climate'] }, 'ar')]);
  assert.deepEqual(e.funcoes.map(f => f.nome), ['autorizada_a1', 'autorizada_a2']);
});

test('autorizadas vêm antes das leituras', () => {
  const tarefas = { id: 'tarefas', prefixarTools: false, tools: [{ name: 'task_listar', effect: 'read', handler }] };
  const e = espaco([aut('a1', 'turnon', {}, 'luz')], { capacidades: [tarefas, ha], carregadas: ['tarefas', ha.id] });
  assert.deepEqual(e.funcoes.map(f => f.nome), ['autorizada_a1', 'task_listar']);
});

test('fora do turno não oferece; candidata oferece ao carregar', () => {
  const autorizacoes = [aut('a1', 'turnon', {}, 'luz')];
  assert.deepEqual(espaco(autorizacoes, { carregadas: [] }).funcoes, []);
  const e = espaco(autorizacoes, { carregadas: [], candidatas: [ha.id] });
  assert.deepEqual(e.candidatas.map(c => c.id), [ha.id]);
  assert.deepEqual(e.funcoesDe(ha.id).map(f => f.nome), ['autorizada_a1']);
});

test('ferramenta ausente e servidor desligado não oferecem autorização', () => {
  assert.deepEqual(espaco([aut('a1', 'ausente', {}, 'x')]).funcoes, []);
  const e = espaco([aut('a1', 'turnon', {}, 'luz')], { capacidades: [{ ...ha, preExecucao: false }] });
  assert.deepEqual(e.funcoes, []);
  assert.deepEqual(e.funcoesDe(ha.id), []);
});

test('sem autorizações nenhuma escrita entra', () => {
  assert.deepEqual(espaco(undefined).funcoes, []);
});

test('entrega mostra nome e argumentos reais e avisa da escrita executada', () => {
  const args = { area: 'escritório', domain: ['light'] };
  const autorizadas = new Map([['autorizada_a1', { toolName: 'mcp-home-assistant__turnon', args }]]);
  const rastro = [{ passo: 1, fn: 'autorizada_a1', args: {}, confianca: 0.9, resultado: '{"ok":true}' }];
  const { historico, bloco } = entregaDoLoop({ estado: 'pronto', rastro }, { autorizadas });
  assert.equal(historico[1].toolName, 'mcp-home-assistant__turnon');
  assert.deepEqual(historico[1].metadata.args, args);
  assert.deepEqual(JSON.parse(historico[0].content).blocos[0].comandos[0], { tool: 'mcp-home-assistant__turnon', args: JSON.stringify(args) });
  assert.match(bloco, /ESCRITAS.*FORAM executadas/);
  assert.doesNotMatch(bloco, /autorizada_a1/);
  for (const item of [{ ...rastro[0], confianca: 0.5 }, { ...rastro[0], erro: 'offline' }]) {
    const entrega = entregaDoLoop({ estado: 'pronto', rastro: [item] }, { autorizadas });
    assert.match(entrega.bloco, /mcp-home-assistant__turnon/);
    assert.doesNotMatch(entrega.bloco, /autorizada_a1/);
  }
});

test('entrega sem autorizadas mantém texto de leitura', () => {
  const { bloco } = entregaDoLoop({ estado: 'pronto', rastro: [{ passo: 1, fn: 'task_listar', args: {}, confianca: 0.9, resultado: '[]' }] });
  assert.match(bloco, /consultas de leitura/);
  assert.doesNotMatch(bloco, /ações autorizadas|ESCRITAS/);
});

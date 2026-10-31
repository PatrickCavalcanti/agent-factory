import test from 'node:test';
import assert from 'node:assert/strict';
import { funcoesParaIntencao, lerIntencao, textoDaIntencao, TETO_ITENS_INTENCAO } from '../src/intencao.js';

const capacidades = [
  { id: 'conhecimento', tools: [
    { name: 'kb_no_ler', effect: 'read', description: 'Lê a árvore de nós.' },
    { name: 'kb_no_gravar', effect: 'write', description: 'Cria ou edita nó.' },
  ] },
  { id: 'memoria', prefixarTools: false, tools: [{ name: 'mem_buscar', effect: 'read', description: 'Busca memórias.' }] },
];

test('funcoesParaIntencao: nome exposto → meta', () => {
  const f = funcoesParaIntencao(capacidades);
  assert.deepEqual(f.get('conhecimento__kb_no_gravar'), { exposto: 'conhecimento__kb_no_gravar', capacidade: 'conhecimento', tool: 'kb_no_gravar', effect: 'write', descricao: 'Cria ou edita nó.' });
  assert.ok(f.has('mem_buscar'));
});

test('lerIntencao: válida, com args', () => {
  const funcoes = funcoesParaIntencao(capacidades);
  const r = lerIntencao('[{"funcao":"conhecimento__kb_no_ler","args":{"base":"principal"}},{"funcao":"conhecimento__kb_no_gravar"}]', { funcoes });
  assert.equal(r.erro, null);
  assert.deepEqual(r.itens, [
    { funcao: 'conhecimento__kb_no_ler', capacidade: 'conhecimento', tool: 'kb_no_ler', effect: 'read', args: { base: 'principal' } },
    { funcao: 'conhecimento__kb_no_gravar', capacidade: 'conhecimento', tool: 'kb_no_gravar', effect: 'write' },
  ]);
});

test('lerIntencao: descarta desconhecida, repetida e acima do teto', () => {
  const funcoes = funcoesParaIntencao(capacidades);
  const lista = [{ funcao: 'xx__nada' }, { funcao: 'conhecimento__kb_no_ler' }, { funcao: 'conhecimento__kb_no_ler' }];
  const r = lerIntencao(JSON.stringify(lista), { funcoes });
  assert.equal(r.itens.length, 1);
  assert.deepEqual(r.descartados.map((d) => d.motivo), ['funcao-desconhecida', 'repetida']);
  // Teto com funções DISTINTAS (repetidas cairiam antes, como `repetida`, sem exercitar o teto).
  const n = TETO_ITENS_INTENCAO + 2;
  const muitasCaps = [{ id: 'x', tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}`, effect: 'read' })) }];
  const funcoesX = funcoesParaIntencao(muitasCaps);
  const r2 = lerIntencao(JSON.stringify(Array.from({ length: n }, (_, i) => ({ funcao: `x__t${i}` }))), { funcoes: funcoesX });
  assert.equal(r2.itens.length, TETO_ITENS_INTENCAO);
  assert.deepEqual(r2.descartados.map((d) => d.motivo), ['acima-do-teto', 'acima-do-teto']);
});

test('lerIntencao: null, "null", JSON inválido, não-lista', () => {
  const funcoes = funcoesParaIntencao(capacidades);
  assert.deepEqual(lerIntencao(null, { funcoes }), { itens: [], descartados: [], erro: null });
  assert.deepEqual(lerIntencao('null', { funcoes }), { itens: [], descartados: [], erro: null });
  assert.equal(lerIntencao('[{', { funcoes }).erro, 'json-invalido');
  assert.equal(lerIntencao('{"funcao":"x"}', { funcoes }).erro, 'nao-e-lista');
});

test('textoDaIntencao: nome + descrição', () => {
  const funcoes = funcoesParaIntencao(capacidades);
  const { itens } = lerIntencao('[{"funcao":"conhecimento__kb_no_gravar"}]', { funcoes });
  assert.equal(textoDaIntencao(itens, funcoes), 'conhecimento__kb_no_gravar: Cria ou edita nó.');
});

// Revisão do conjunto, I3: o nome da função vem do modelo em três formas (exposto, cru, ref `cap/tool/fn`) — a mesma regra
// de `mapaDeFuncoesDoTurno`; o item guardado leva sempre o nome EXPOSTO.
test('lerIntencao: nome cru (aliasCru) e ref cap/tool/fn são aceitos e normalizados para o nome exposto', () => {
  const caps = [
    { id: 'tarefas', aliasCru: true, tools: [{ name: 'task_listar', effect: 'read', description: 'Lista.' }] },
    { id: 'memoria', prefixarTools: false, tools: [{ name: 'mem_buscar', effect: 'read' }] },
  ];
  const funcoes = funcoesParaIntencao(caps);
  const r = lerIntencao(JSON.stringify([
    { funcao: 'task_listar', args: { status: 'pending' } }, // cru
    { funcao: 'memoria/tool/mem_buscar' }, // ref
    { funcao: 'tarefas__task_listar' }, // exposto, repetida do cru
  ]), { funcoes });
  assert.deepEqual(r.itens.map((i) => i.funcao), ['tarefas__task_listar', 'mem_buscar']);
  assert.deepEqual(r.itens[0], { funcao: 'tarefas__task_listar', capacidade: 'tarefas', tool: 'task_listar', effect: 'read', args: { status: 'pending' } });
  assert.deepEqual(r.descartados.map((d) => d.motivo), ['repetida'], 'cru e exposto são a MESMA função');
  // textoDaIntencao procura pelo nome do item (exposto).
  assert.equal(textoDaIntencao(r.itens, funcoes), 'tarefas__task_listar: Lista.; mem_buscar');
});

test('lerIntencao: nome cru sem aliasCru ou ambíguo entre capacidades continua desconhecido', () => {
  const sem = funcoesParaIntencao([{ id: 'tarefas', tools: [{ name: 'task_listar', effect: 'read' }] }]);
  assert.equal(lerIntencao('[{"funcao":"task_listar"}]', { funcoes: sem }).descartados[0]?.motivo, 'funcao-desconhecida');
  const ambiguo = funcoesParaIntencao([
    { id: 'a', aliasCru: true, tools: [{ name: 'ler', effect: 'read' }] },
    { id: 'b', aliasCru: true, tools: [{ name: 'ler', effect: 'read' }] },
  ]);
  assert.equal(lerIntencao('[{"funcao":"ler"}]', { funcoes: ambiguo }).descartados[0]?.motivo, 'funcao-desconhecida');
  assert.equal(lerIntencao('[{"funcao":"a/tool/ler"}]', { funcoes: ambiguo }).itens[0]?.funcao, 'a__ler');
});

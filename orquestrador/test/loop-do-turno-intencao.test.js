import test from 'node:test';
import assert from 'node:assert/strict';
import { refsDaIntencao, espacoDoLoop } from '../src/loop-do-turno.js';

const capacidades = [{ id: 'conhecimento', tools: [{ name: 'kb_no_ler' }, { name: 'kb_no_gravar' }] }];

test('refsDaIntencao: todas as declaradas (leitura e escrita) que existem no catálogo', () => {
  const intencao = [
    { funcao: 'conhecimento__kb_no_ler', capacidade: 'conhecimento', tool: 'kb_no_ler', effect: 'read' },
    { funcao: 'conhecimento__kb_no_gravar', capacidade: 'conhecimento', tool: 'kb_no_gravar', effect: 'write' },
    { funcao: 'x__y', capacidade: 'x', tool: 'y', effect: 'read' },
  ];
  assert.deepEqual(refsDaIntencao({ intencao, capacidades }), ['conhecimento/tool/kb_no_ler', 'conhecimento/tool/kb_no_gravar']);
});

test('refsDaIntencao: vazio sem intenção', () => {
  assert.deepEqual(refsDaIntencao({ intencao: null, capacidades }), []);
});

test('espacoDoLoop: capacidade só presente na intenção entra como candidata', () => {
  const intencaoAnterior = [{ capacidade: 'conhecimento' }];
  const idsCandidatos = [];
  const capacidadesDaIntencao = intencaoAnterior.map((i) => i?.capacidade).filter((id) => typeof id === 'string');
  const espaco = espacoDoLoop({
    capacidades: [{ id: 'conhecimento', descricao: 'x', tools: [{ name: 'kb_no_ler', effect: 'read' }] }],
    carregadas: [],
    candidatas: [...new Set([...idsCandidatos, ...capacidadesDaIntencao])],
    paramsDe: () => [],
  });
  assert.deepEqual(espaco.funcoes, []);
  assert.deepEqual(espaco.candidatas, [{ id: 'conhecimento', descricao: 'x' }]);
});

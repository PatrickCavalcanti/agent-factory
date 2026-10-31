import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOMES_PADRAO, removerBlocosDeOperacoes } from '../src/prompt-builder.js';

test('NOMES_PADRAO é exportado e traz o nome padrão de operações', () => {
  assert.equal(NOMES_PADRAO.operacoes, 'turn_operations');
});

test('remove blocos fechados, um ou vários, e preserva o resto do texto', () => {
  assert.equal(removerBlocosDeOperacoes('a<turn_operations>x</turn_operations>b'), 'ab');
  assert.equal(removerBlocosDeOperacoes('a<turn_operations>x</turn_operations><turn_operations>y</turn_operations>b'), 'ab');
  assert.equal(removerBlocosDeOperacoes('sem bloco'), 'sem bloco');
});

test('bloco aberto sem fechamento descarta o resto', () => {
  assert.equal(removerBlocosDeOperacoes('Pronto.<turn_operations>aberto e mais'), 'Pronto.');
});

test('aceita outro nome de tag', () => {
  assert.equal(removerBlocosDeOperacoes('a<ops>x</ops>b', 'ops'), 'ab');
  assert.equal(removerBlocosDeOperacoes('a<turn_operations>x</turn_operations>b', 'ops'), 'a<turn_operations>x</turn_operations>b');
});

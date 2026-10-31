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

test('bloco aberto sem fechamento mantém o texto intacto', () => {
  assert.equal(removerBlocosDeOperacoes('Pronto.<turn_operations>aberto e mais'), 'Pronto.<turn_operations>aberto e mais');
});

test('tag citada em prosa não leva a resposta embora', () => {
  const prosa = 'Nada hoje. Veja o <turn_operations> acima? Sim, e amanhã você tem reunião às 10h. Quer que eu marque?';
  assert.equal(removerBlocosDeOperacoes(prosa), prosa);
  // citação em prosa + bloco imitado completo depois: só o bloco completo sai
  assert.equal(removerBlocosDeOperacoes('Veja o <turn_operations> acima. Fim.<turn_operations>x</turn_operations>'), 'Veja o <turn_operations> acima. Fim.');
  // fechamento solto (sem abertura) também fica
  assert.equal(removerBlocosDeOperacoes('a</turn_operations>b'), 'a</turn_operations>b');
});

test('aceita outro nome de tag', () => {
  assert.equal(removerBlocosDeOperacoes('a<ops>x</ops>b', 'ops'), 'ab');
  assert.equal(removerBlocosDeOperacoes('a<turn_operations>x</turn_operations>b', 'ops'), 'a<turn_operations>x</turn_operations>b');
});

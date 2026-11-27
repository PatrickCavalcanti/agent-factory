import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contribuicaoBateComChaves, validarChavesDasContribuicoes } from '../src/chaves.js';

test('contribuicaoBateComChaves: sem chaves declaradas, sempre entra (base)', () => {
  assert.equal(contribuicaoBateComChaves({ ref: 'a/b/c' }, []), true);
});

test('contribuicaoBateComChaves: com chave, entra só se alguma bate', () => {
  const c = { ref: 'a/b/c', chaves: ['grafico', 'painel'] };
  assert.equal(contribuicaoBateComChaves(c, ['painel']), true);
  assert.equal(contribuicaoBateComChaves(c, ['kanban']), false);
  assert.equal(contribuicaoBateComChaves(c, []), false);
});

test('validarChavesDasContribuicoes: recusa chave fora do catálogo', () => {
  const erros = validarChavesDasContribuicoes([{ ref: 'a/b/c', floor: true, chaves: ['xpto'] }], ['grafico']);
  assert.deepEqual(erros, ['a/b/c: chave "xpto" fora do catálogo']);
});

test('validarChavesDasContribuicoes: recusa chaves vazias e chave em semântica', () => {
  const erros = validarChavesDasContribuicoes([
    { ref: 'a/b/c', floor: true, chaves: [] },
    { ref: 'a/b/d', floor: false, chaves: ['grafico'] },
  ], ['grafico']);
  assert.deepEqual(erros, [
    'a/b/c: `chaves` vazia — omita o campo para contribuição base',
    'a/b/d: `chaves` só vale em contribuição de piso (`floor: true`)',
  ]);
});

test('validarChavesDasContribuicoes: sem catálogo, não confere nome', () => {
  assert.deepEqual(validarChavesDasContribuicoes([{ ref: 'a/b/c', floor: true, chaves: ['qualquer'] }], undefined), []);
});

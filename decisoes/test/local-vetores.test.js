// packages/decisions/test/local-vetores.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizar, media, centrar, produto, percentil, vetorValido } from '../src/local/vetores.js';

test('normalizar devolve norma 1 e não muda vetor nulo', () => {
  const v = normalizar([3, 4]);
  assert.ok(Math.abs(v[0] - 0.6) < 1e-9 && Math.abs(v[1] - 0.8) < 1e-9);
  assert.deepEqual(normalizar([0, 0]), [0, 0]);
});

test('media, centrar e produto', () => {
  assert.deepEqual(media([[1, 3], [3, 5]]), [2, 4]);
  const c = centrar([3, 4], [0, 0]);
  assert.ok(Math.abs(produto(c, c) - 1) < 1e-9);
});

test('percentil pega o valor da posição floor(p*(n-1)) do vetor ordenado', () => {
  assert.equal(percentil([5, 1, 3, 2, 4], 0), 1);
  assert.equal(percentil([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentil([5, 1, 3, 2, 4], 1), 5);
  assert.equal(percentil([], 0.5), null);
});

test('vetorValido exige array finito de dimensão d', () => {
  assert.equal(vetorValido([0.1, 0.2], 2), true);
  assert.equal(vetorValido([0.1, NaN], 2), false);
  assert.equal(vetorValido([0.1], 2), false);
  assert.equal(vetorValido(null, 2), false);
});

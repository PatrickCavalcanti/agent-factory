import test from 'node:test';
import assert from 'node:assert/strict';
import { tentarTravar, travado, quemTravou } from '../treino/lib/trava.js';

test('uma trava por processo: segunda tentativa devolve null até liberar', () => {
  assert.equal(travado(), false);
  const liberar = tentarTravar('treino-completo');
  assert.equal(typeof liberar, 'function');
  assert.equal(travado(), true);
  assert.equal(quemTravou(), 'treino-completo');
  assert.equal(tentarTravar('atualizacao'), null);
  liberar();
  assert.equal(travado(), false);
  assert.equal(quemTravou(), null);
  const outra = tentarTravar('atualizacao');
  assert.equal(typeof outra, 'function');
  outra();
});

test('liberar é idempotente e um liberar antigo não solta a trava de outro dono', () => {
  const l1 = tentarTravar('a');
  l1();
  const l2 = tentarTravar('b');
  l1(); // liberar velho: não pode soltar a trava de 'b'
  assert.equal(quemTravou(), 'b');
  l2(); l2();
  assert.equal(travado(), false);
});

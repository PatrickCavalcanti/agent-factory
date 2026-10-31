import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entregarSemanticaDoCatalogo } from '../src/index.js';

test('entregarSemanticaDoCatalogo: entrega o snapshot de manager.semantica()', () => {
  const snap = { slug: 's', aneis: {} };
  const vistos = [];
  entregarSemanticaDoCatalogo({ semantica: () => snap }, (s) => vistos.push(s));
  assert.deepEqual(vistos, [snap]);
  assert.equal(vistos[0], snap);
});

test('entregarSemanticaDoCatalogo: snapshot null também é entregue', () => {
  const vistos = [];
  entregarSemanticaDoCatalogo({ semantica: () => null }, (s) => vistos.push(s));
  assert.deepEqual(vistos, [null]);
});

test('entregarSemanticaDoCatalogo: manager sem semantica() (kairos < 0.838) ou sem callback não faz nada', () => {
  let chamado = 0;
  entregarSemanticaDoCatalogo({}, () => { chamado++; });
  entregarSemanticaDoCatalogo(null, () => { chamado++; });
  assert.equal(chamado, 0);
  assert.doesNotThrow(() => entregarSemanticaDoCatalogo({ semantica: () => ({}) }, undefined));
});

test('entregarSemanticaDoCatalogo: exceção do callback ou de semantica() nunca derruba o catálogo', () => {
  assert.doesNotThrow(() => entregarSemanticaDoCatalogo({ semantica: () => ({}) }, () => { throw new Error('boom'); }));
  assert.doesNotThrow(() => entregarSemanticaDoCatalogo({ semantica: () => { throw new Error('boom'); } }, () => {}));
});

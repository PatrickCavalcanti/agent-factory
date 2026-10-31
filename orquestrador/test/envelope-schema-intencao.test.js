import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_COMPLETA, SCHEMA_HEADLESS } from '../src/protocolo/envelope-schema.js';

const blocoDe = (s) => s.schema.properties.blocos.items;

test('variante completa tem _intencao string|null, obrigatório, depois de comandos', () => {
  const b = blocoDe(SCHEMA_COMPLETA);
  assert.deepEqual(b.properties._intencao, { type: ['string', 'null'] });
  assert.ok(b.required.includes('_intencao'));
  const chaves = Object.keys(b.properties);
  assert.equal(chaves[chaves.length - 1], '_intencao');
});

test('variante headless não tem _intencao', () => {
  assert.equal(blocoDe(SCHEMA_HEADLESS).properties._intencao, undefined);
});

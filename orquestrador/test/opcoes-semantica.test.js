import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opcoesDeSemantica } from '../src/index.js';

test('opcoesDeSemantica: sem config ou sem aneis → {}', () => {
  assert.deepEqual(opcoesDeSemantica(undefined), {});
  assert.deepEqual(opcoesDeSemantica({}), {});
  assert.deepEqual(opcoesDeSemantica({ aneis: [] }), {});
  assert.deepEqual(opcoesDeSemantica({ arquivoCache: 'x.json' }), {});
});

test('opcoesDeSemantica: com aneis e sem arquivoCache → só `semantica`', () => {
  const o = opcoesDeSemantica({ aneis: ['provider'] });
  assert.deepEqual(o, { semantica: { aneis: ['provider'] } });
  assert.ok(!('cacheVetores' in o));
});

test('opcoesDeSemantica: completa → `semantica` e `cacheVetores` (get/set/flush)', () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'opcoes-sem-')), 'sel.json');
  const o = opcoesDeSemantica({ aneis: ['provider', 'tool'], arquivoCache: arquivo });
  assert.deepEqual(o.semantica, { aneis: ['provider', 'tool'] });
  for (const m of ['get', 'set', 'flush']) assert.equal(typeof o.cacheVetores[m], 'function');
});

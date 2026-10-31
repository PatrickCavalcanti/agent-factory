import { test } from 'node:test';
import assert from 'node:assert/strict';

test('o pacote resolve o @okds/kairos', async () => {
  const mod = await import('@okds/kairos/assemble');
  assert.equal(typeof mod.assemble, 'function');
});

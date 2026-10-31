import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centeredStrategy } from '@okds/kairos/index/similarity';
import { opcoesDeLimiares } from '../src/index.js';

test('sem limiares não passa nada ao kairos', () => {
  assert.deepEqual(opcoesDeLimiares(undefined), {});
});

test('provider mantém a base da estratégia e sobrescreve por chave', () => {
  const o = opcoesDeLimiares({ zCandidate: -1.01 });
  assert.deepEqual(o.thresholds.provider, { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 });
  assert.equal(o.similarityByBucket, undefined);
});

test('skill: corte vai em thresholds.skill e centralizar liga a estratégia centrada só no bucket skill', () => {
  const o = opcoesDeLimiares({ skill: { centralizar: true, candidate: 0.1 } });
  assert.deepEqual(o.thresholds, { skill: { candidate: 0.1 } });
  assert.equal(o.similarityByBucket.skill, centeredStrategy);
  assert.deepEqual(Object.keys(o.similarityByBucket), ['skill']);
});

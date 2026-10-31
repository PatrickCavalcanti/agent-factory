import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESPOND } from '../src/index.js';

test('pacote carrega e exporta RESPOND', () => { assert.equal(RESPOND, 'respond_to_user'); });

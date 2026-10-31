import test from 'node:test';
import assert from 'node:assert/strict';
import { criarPonteDoTurno } from '../src/pista-contexto.js';

function managerFalso() {
  const recebidos = [];
  return {
    recebidos,
    manager: {
      registry: {}, store: {}, emitter: { onEvent: () => () => {} },
      async discover(input) { recebidos.push(input); return { providers: { load: [] }, tools: { hydrate: [], conscious: [] }, explain: [] }; },
    },
  };
}

test('ponte injeta trivial:false no discover', async () => {
  const { manager, recebidos } = managerFalso();
  const { manager: m } = criarPonteDoTurno({ manager, can: () => true, trivial: false });
  await m.discover({ text: 'ok', ctx: {}, state: { loadedProviders: [] } });
  assert.equal(recebidos[0].trivial, false);
});

test('ponte sem trivial repassa o input intacto', async () => {
  const { manager, recebidos } = managerFalso();
  const { manager: m } = criarPonteDoTurno({ manager, can: () => true });
  const input = { text: 'ok', ctx: {}, state: { loadedProviders: [] } };
  await m.discover(input);
  assert.equal(recebidos[0], input);
});

test('ponte com hints e trivial junta os dois', async () => {
  const { manager, recebidos } = managerFalso();
  const { manager: m } = criarPonteDoTurno({ manager, can: () => true, hints: ['pista'], trivial: false });
  await m.discover({ text: 'ok', ctx: {}, state: { loadedProviders: [] } });
  assert.deepEqual(recebidos[0].hints, ['pista']);
  assert.equal(recebidos[0].trivial, false);
});

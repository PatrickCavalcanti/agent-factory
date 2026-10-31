import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { montarProviders } from '../src/capacidades.js';

const tool = {
  name: 'listar', description: 'Lista.', schema: z.object({}),
  inputSchema: { type: 'object', properties: {} }, handler: async () => ({}),
};

test('instrucoes vence descricao em Provider.instructions; descricao segue no index', () => {
  const [{ provider }] = montarProviders([{
    id: 'agenda', descricao: 'Consulta a agenda.', instrucoes: 'MANUAL LONGO da capacidade.', tools: [tool],
  }]);
  assert.equal(provider.description, 'Consulta a agenda.');
  assert.equal(provider.instructions, 'MANUAL LONGO da capacidade.');
});

test('sem instrucoes, comportamento anterior: descricao alimenta os dois', () => {
  const [{ provider }] = montarProviders([{ id: 'agenda', descricao: 'Consulta a agenda.', tools: [tool] }]);
  assert.equal(provider.instructions, 'Consulta a agenda.');
});

test('instrucoes vazia cai em descricao (nao apaga instructions)', () => {
  const [{ provider }] = montarProviders([{ id: 'agenda', descricao: 'Consulta a agenda.', instrucoes: '', tools: [tool] }]);
  assert.equal(provider.instructions, 'Consulta a agenda.');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };

test('a fábrica chama config.provider com o ctx de CADA turno', async () => {
  const recebidos = [];
  const orq = criarOrquestrador({
    base: () => [], capacidades: [], protocolo: 'fence', decorarTool: (_n, d) => d,
    provider: (ctx) => {
      recebidos.push(ctx);
      return {
        name: 'fake', model: 'f',
        capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: false, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
        async generate() { return { text: 'ok', stopReason: 'completed' }; },
      };
    },
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO, ctx: { conversaId: 'c1', perfilDeModelo: 'padrao' } });
  await orq.executarTurno({ texto: 'oi de novo', estado: ESTADO, ctx: { conversaId: 'c2', perfilDeModelo: 'outro' } });
  assert.equal(recebidos.length, 2);
  assert.equal(recebidos[0].perfilDeModelo, 'padrao');
  assert.equal(recebidos[1].perfilDeModelo, 'outro');
});

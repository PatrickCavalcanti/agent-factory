import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };

const provider = () => ({
  name: 'fake', model: 'fake-1',
  capabilities: { streaming: false, usage: true, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
  async generate() { return { text: 'oi', stopReason: 'completed', usage: { inputTokens: 10, outputTokens: 5 } }; },
});

async function custos(extra) {
  const eventos = [];
  const orq = criarOrquestrador({
    base: () => [], capacidades: [], protocolo: 'fence', provider,
    decorarTool: (_n, d) => d, aoEvento: (e) => eventos.push(e), ...extra,
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  return eventos.filter((e) => e.type === 'provider.completed').map((e) => e.costUsd);
}

test('pricingResolver da config chega ao genos: costUsd sai calculado', async () => {
  const chamadas = [];
  const pricingResolver = { estimateCostUsd: (i) => { chamadas.push(i); return 0.25; } };
  const c = await custos({ pricingResolver });
  assert.deepEqual(c, [0.25]);
  assert.equal(chamadas[0].model, 'fake-1');
});

test('sem pricingResolver, costUsd segue null', async () => {
  assert.deepEqual(await custos({}), [null]);
});

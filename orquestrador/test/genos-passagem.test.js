import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };

const providerDe = (nome, chamadas) => () => ({
  name: nome, model: 'fake-1',
  capabilities: { streaming: false, usage: true, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
  async generate() { chamadas.push(nome); return { text: 'oi', stopReason: 'completed', usage: { inputTokens: 1, outputTokens: 1 } }; },
});

async function rodar(extra) {
  const eventos = [];
  const chamadas = [];
  const orq = criarOrquestrador({
    base: () => [], capacidades: [], protocolo: 'fence', decorarTool: (_n, d) => d,
    provider: providerDe('da-fabrica', chamadas), aoEvento: (e) => eventos.push(e), ...extra,
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  return { eventos, chamadas };
}

test('config.genos: chave que a fábrica não define chega ao genos', async () => {
  const { eventos } = await rodar({ genos: { pricingResolver: { estimateCostUsd: () => 0.5 } } });
  assert.deepEqual(eventos.filter((e) => e.type === 'provider.completed').map((e) => e.costUsd), [0.5]);
});

test('config.genos: chave que a fábrica define NÃO é sobrescrita', async () => {
  const intrusos = [];
  const { chamadas } = await rodar({ genos: { provider: providerDe('intruso', intrusos), maxIterations: 1 } });
  assert.deepEqual(chamadas, ['da-fabrica']);
  assert.deepEqual(intrusos, []);
});

test('sem config.genos nada muda', async () => {
  const { chamadas } = await rodar({});
  assert.deepEqual(chamadas, ['da-fabrica']);
});

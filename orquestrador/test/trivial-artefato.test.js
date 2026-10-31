// Spec 2026-10-14 §7.1: o artefato do trivial é `{ valor, motivo, enviadoAoKairos }` — no retorno do
// turno e no `aoMontar` (mesmo valor nos dois).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const estado = () => ({ system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO });

function orquestrador(aoMontar) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'agenda',
      descricao: 'Consulta a capacidade agenda.',
      tools: [{ name: 'consultar', description: 'Consulta itens.', schema: z.object({ q: z.string() }), handler: async () => ({ itens: [] }) }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: () => ({
      name: 'fake', model: 'fake-1',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
      async generate() { return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
    }),
    decorarTool: (nome, definicao) => definicao,
    aoMontar,
  });
}

test('trivial do host: o retorno e o aoMontar trazem { valor, motivo, enviadoAoKairos:true }', async () => {
  const montados = [];
  const saida = await orquestrador((info) => montados.push(info))
    .executarTurno({ texto: 'ok', estado: estado(), trivial: false, motivoTrivial: 'pergunta+curta' });
  const esperado = { valor: false, motivo: 'pergunta+curta', enviadoAoKairos: true };
  assert.deepEqual(saida.trivial, esperado);
  assert.deepEqual(montados[0].trivial, esperado);
});

test('trivial do host sem motivo informado: motivo "host"', async () => {
  const saida = await orquestrador().executarTurno({ texto: 'ok', estado: estado(), trivial: true });
  assert.deepEqual(saida.trivial, { valor: true, motivo: 'host', enviadoAoKairos: true });
});

test('sem trivial na entrada: regra do kairos, enviadoAoKairos:false', async () => {
  const saida = await orquestrador().executarTurno({ texto: 'ok', estado: estado() });
  assert.deepEqual(saida.trivial, { valor: true, motivo: 'regra-kairos', enviadoAoKairos: false });
});

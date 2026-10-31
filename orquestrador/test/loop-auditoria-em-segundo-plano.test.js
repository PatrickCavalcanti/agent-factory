import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';

const argsFixos = { area: 'escritório', domain: ['light'] };
const autorizacao = { id: 'a1', capacidade: 'mcp-home-assistant', funcao: 'turnon', args: argsFixos, rotulo: 'ligar luz do escritório' };

function montar({ autorizacoes, aoUsarAutorizacao, handler, rodar, requests, chamadas }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Teste.</identidade>' }],
    capacidades: [{
      id: 'mcp-home-assistant', descricao: 'HA', piso: false, preExecucao: true, prefixarTools: true,
      semanticText: 'DOC_HA ligar luz',
      tools: [{ name: 'turnon', description: 'liga', effect: 'write', inputSchema: { type: 'object', properties: {} }, schema: z.object({}).passthrough(), handler }],
    }],
    embedder: { modelSlug: 'fake-test-v1', async embed(texto) { return texto.includes('DOC_HA') || texto.includes('MARCADOR') ? [1, 0] : [0, 0]; } },
    protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: () => ({ name: 'fake', model: 'fake-1',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
      async generate(request) { requests.push(request); return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
    }),
    decorarTool: (_n, d) => d,
    aoChamada: c => chamadas.push(c),
    loop: { autorizacoes, aoUsarAutorizacao, paramsDe: async () => [], rodar },
  });
}

test('aoUsarAutorizacao que nunca resolve roda em segundo plano e executar resolve em menos de 300 ms', async () => {
  const requests = [], chamadas = [], handlers = [];
  let duracaoExecutar = 0;
  const orq = montar({
    requests,
    chamadas,
    autorizacoes: async () => [autorizacao],
    aoUsarAutorizacao: () => new Promise(() => {}), // NUNCA resolve
    handler: async (args) => {
      handlers.push(args);
      return '{"ok":true}';
    },
    rodar: async (e) => {
      const fn = e.espaco.funcoes[0];
      const t0 = performance.now();
      const resultado = await e.executar(fn, {});
      duracaoExecutar = performance.now() - t0;
      return {
        estado: 'pronto',
        rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.95, resultado }],
        carregadas: [],
        passos: [],
        ms: Math.round(duracaoExecutar),
      };
    },
  });

  try {
    const saida = await orq.executarTurno({ texto: 'MARCADOR Liga a luz.' });

    assert.ok(duracaoExecutar < 300, `executar demorou ${duracaoExecutar}ms (deve ser < 300ms)`);
    assert.deepEqual(handlers, [argsFixos]);
    assert.equal(saida.loop.estado, 'pronto');
    assert.equal(saida.operacoes[0].ok, true);
    assert.equal(requests.length, 1);
  } finally {
    await orq.fechar();
  }
});

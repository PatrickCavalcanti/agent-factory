import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';

// Mesmo provider e embedder do harness de loop-do-jev.test.js; fonte falsa sem banco.
function montar({ incluidos = [], loop }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'memoria', descricao: 'Memória.', piso: true,
      tools: [{ name: 'memoria_ler', description: 'Lê memória.', effect: 'read', schema: z.object({}), handler: async () => '{}' }],
      fonte: {
        piso: [],
        selecionar: async () => ({ incluidos: incluidos.map((i) => ({ conteudo: i.valorCompleto ?? i.valor, ...i })), candidatos: [], carregar: [], semear: [], enriquecer: null }),
      },
    }, {
      id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda',
      tools: [{ name: 'agenda_ler', description: 'Lê agenda.', effect: 'read', schema: z.object({}), handler: async () => '{}' }],
    }],
    embedder: {
      modelSlug: 'fake-test-v1',
      async embed(texto) {
        if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR') || texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
        return [0, 0];
      },
    },
    protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: () => ({
      name: 'fake', model: 'fake-1',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
      async generate() { return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
    }),
    decorarTool: (_nome, definicao) => definicao,
    loop: { paramsDe: async () => [], ...loop },
  });
}

async function executar(incluidos, memoria) {
  let recebido;
  const orq = montar({ incluidos, loop: { memoria, rodar: async (e) => {
    recebido = e;
    return { estado: 'pronto', rastro: [], carregadas: [], passos: [], ms: 1 };
  } } });
  try {
    await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR Liga a luz.' });
    assert.ok(recebido, 'o loop rodou');
    return recebido;
  } finally { await orq.fechar(); }
}

test('o loop recebe contexto com as memórias do turno, as de ação primeiro', async () => {
  const recebido = await executar([
    { ref: 'memoria/memory/preferences.cor', valor: 'cor favorita: azul', carrega: [] },
    { ref: 'memoria/memory/preferences.luz', valor: 'luz do escritório. Chamadas:\n- x({"a":1})', carrega: ['power/mcp-home-assistant'] },
  ], { maxChars: 2500, itemMaxChars: 800 });
  assert.deepEqual(recebido.contexto.map((m) => m.ref), ['memoria/memory/preferences.luz', 'memoria/memory/preferences.cor']);
  assert.equal(recebido.contexto[0].acao, true);
});

test('sem memória selecionada, contexto é lista vazia', async () => {
  assert.deepEqual((await executar([])).contexto, []);
});

test('usa valorCompleto, acima do corte de 600 do trace, respeitando o teto do host', async () => {
  const valorCompleto = 'x'.repeat(700);
  const recebido = await executar([{ ref: 'memoria/memory/preferences.longa', valor: 'x'.repeat(600) + '…', valorCompleto }], { maxChars: 2500, itemMaxChars: 800 });
  assert.equal(recebido.contexto[0].valor, valorCompleto);
  const cortado = await executar([{ ref: 'memoria/memory/preferences.longa', valorCompleto }], { maxChars: 2500, itemMaxChars: 650 });
  assert.equal(cortado.contexto[0].valor.length, 650);
});

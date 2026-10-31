import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';

// Spec 2026-10-14 §7.1 (revisão da Fase 2): o julgamento do Jev sobre a intenção declarada e as
// refs hidratadas por causa dela precisam chegar ao retorno do turno (`loop.intencao`,
// `loop.intencaoHidratada`) — é de onde `fabrica/turno.js` monta o artefato.

function embedderFalso() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
      return [0, 0];
    },
  };
}

function providerFalso() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
    async generate() {
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

function montar({ rodar }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'agenda', descricao: 'Agenda e compromissos.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda compromissos amanhã',
      tools: [
        { name: 'listar_eventos', description: 'Lista eventos.', effect: 'read', inputSchema: { type: 'object', properties: {} }, schema: z.object({}).passthrough(), handler: async () => ({ eventos: [] }) },
        { name: 'criar_evento', description: 'Cria evento.', effect: 'write', schema: z.object({}).passthrough(), handler: async () => ({}) },
      ],
    }],
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFalso(),
    decorarTool: (nome, definicao) => definicao,
    loop: { rodar, paramsDe: () => [], corteHistorico: 0.7 },
  });
}

const intencaoAnterior = [
  { funcao: 'criar_evento', capacidade: 'agenda', tool: 'criar_evento', effect: 'write', args: { titulo: 'x' } },
];

function loopFalso(intencao) {
  return async () => ({ estado: 'pronto', rastro: [], carregadas: [], passos: [], ms: 1, ...(intencao ? { intencao } : {}) });
}

test('loop.intencao e loop.intencaoHidratada chegam ao retorno do turno quando o Jev julgou vale:true', async () => {
  const orq = montar({ rodar: loopFalso({ vale: true, confianca: 0.9 }) });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR sim, pode marcar', intencaoAnterior });
    assert.deepEqual(saida.loop.intencao, { vale: true, confianca: 0.9 });
    assert.deepEqual(saida.loop.intencaoHidratada, ['agenda/tool/criar_evento']);
  } finally {
    await orq.fechar();
  }
});

test('vale:false: o julgamento chega, mas nada é registrado como hidratado pela intenção', async () => {
  const orq = montar({ rodar: loopFalso({ vale: false, confianca: 0.2 }) });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR não, outra coisa', intencaoAnterior });
    assert.deepEqual(saida.loop.intencao, { vale: false, confianca: 0.2 });
    assert.equal('intencaoHidratada' in saida.loop, false);
  } finally {
    await orq.fechar();
  }
});

test('sem intenção no loop: os campos ficam omitidos', async () => {
  const orq = montar({ rodar: loopFalso(null) });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR oi' });
    assert.equal('intencao' in saida.loop, false);
    assert.equal('intencaoHidratada' in saida.loop, false);
  } finally {
    await orq.fechar();
  }
});

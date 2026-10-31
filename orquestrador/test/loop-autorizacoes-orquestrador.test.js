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

test('usa argumentos fixos, nomes reais na entrega/operações/chips e audita o id', async () => {
  const handlers = [], requests = [], chamadas = [], usos = [];
  const ctx = { sessionId: 's1' };
  let recebido;
  const orq = montar({ requests, chamadas,
    autorizacoes: async info => { recebido = info.ctx; return [autorizacao]; },
    aoUsarAutorizacao: async id => usos.push(id),
    handler: async args => { handlers.push(args); return '{"ok":true}'; },
    rodar: async e => {
      assert.deepEqual(e.espaco.funcoes.map(f => f.nome), ['autorizada_a1']);
      const fn = e.espaco.funcoes[0];
      const resultado = await e.executar(fn, { area: 'sala', domain: ['climate'] });
      return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.95, resultado }], carregadas: [], passos: [], ms: 1 };
    },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'MARCADOR Liga a luz.', ctx });
    assert.equal(recebido, ctx);
    assert.deepEqual(handlers, [argsFixos]);
    assert.deepEqual(usos, ['a1']);
    const fim = chamadas.find(c => c.fase === 'fim' && c.origem === 'jev');
    assert.equal(fim.nome, 'mcp-home-assistant__turnon');
    assert.equal(fim.autorizacaoId, 'a1');
    assert.deepEqual(fim.args, argsFixos);
    assert.equal(saida.operacoes[0].nome, fim.nome);
    assert.equal(saida.operacoes[0].autorizacaoId, 'a1');
    assert.deepEqual(saida.operacoes[0].args, argsFixos);
    assert.equal(saida.loop.rastro[0].autorizacaoId, 'a1');
    const semeada = requests[0].messages.find(m => m.role === 'tool_result');
    assert.equal(semeada.toolName, fim.nome);
    assert.deepEqual(semeada.metadata.args, argsFixos);
    assert.doesNotMatch(JSON.stringify(requests[0].messages), /autorizada_a1/);
  } finally { await orq.fechar(); }
});

test('registro ausente ou que lança falha fechado, sem escrita', async () => {
  for (const autorizacoes of [undefined, async () => { throw new Error('registro offline'); }]) {
    let espaco;
    const handlers = [], requests = [], chamadas = [];
    const orq = montar({ requests, chamadas, autorizacoes,
      handler: async args => { handlers.push(args); return '{}'; },
      rodar: async e => { espaco = e.espaco; return { estado: 'vazio', rastro: [], carregadas: [], passos: [], ms: 0 }; },
    });
    try {
      await orq.executarTurno({ texto: 'MARCADOR Liga a luz.' });
      assert.deepEqual(espaco.funcoes, []);
      assert.deepEqual(handlers, []);
      assert.equal(requests.length, 1);
    } finally { await orq.fechar(); }
  }
});

test('falha da ferramenta não marca uso; falha da auditoria não derruba sucesso', async () => {
  for (const falha of [true, false]) {
    const requests = [], chamadas = [], usos = [];
    const orq = montar({ requests, chamadas, autorizacoes: async () => [autorizacao],
      aoUsarAutorizacao: async id => { usos.push(id); throw new Error('auditoria offline'); },
      handler: async () => falha ? '{"ok":false,"error":"offline"}' : '{"ok":true}',
      rodar: async e => {
        const fn = e.espaco.funcoes[0];
        let resultado, erro;
        try { resultado = await e.executar(fn, {}); } catch (err) { erro = err.message; }
        return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.95, resultado, ...(erro ? { erro } : {}) }], carregadas: [], passos: [], ms: 1 };
      },
    });
    try {
      const saida = await orq.executarTurno({ texto: 'MARCADOR Liga a luz.' });
      assert.equal(saida.loop.estado, 'pronto');
      assert.deepEqual(usos, falha ? [] : ['a1']);
      assert.equal(saida.operacoes[0].ok, !falha);
    } finally { await orq.fechar(); }
  }
});

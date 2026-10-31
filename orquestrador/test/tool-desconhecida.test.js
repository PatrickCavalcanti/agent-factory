import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador, mensagemDeToolDesconhecida } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };

test('nome de catálogo chamado direto: a mensagem ensina call_capability com a mesma ref', () => {
  const msg = mensagemDeToolDesconhecida('etapa__ler');
  assert.match(msg, /call_capability/);
  assert.match(msg, /"ref": "etapa__ler"/);
  assert.match(msg, /load_capability/);
});

test('nome que não é de catálogo, meta-tool ou não-string fica com a mensagem padrão do genos', () => {
  assert.equal(mensagemDeToolDesconhecida('inexistente'), undefined);
  assert.equal(mensagemDeToolDesconhecida('call_capability'), undefined);
  assert.equal(mensagemDeToolDesconhecida(undefined), undefined);
});

const CAP = [{ id: 'etapa', descricao: 'Etapa.', tools: [{ name: 'ler', description: 'Lê.', schema: z.object({}), handler: async () => ({}) }] }];

/** Provider que chama `etapa__ler` direto e devolve os tool_results que viu na 2a chamada. */
async function resultadoDaToolDesconhecida(protocolo, chamada) {
  let n = 0;
  let vistos = '';
  const provider = () => ({
    name: 'fake', model: 'f',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: protocolo === 'nativo', backgroundRuns: false, preferredToolProtocol: protocolo === 'nativo' ? 'provider_native' : 'command_fence' },
    async generate(req) {
      n += 1;
      if (n === 1) return chamada();
      vistos = JSON.stringify(req.messages);
      return { text: 'fim', stopReason: 'completed' };
    },
  });
  const orq = criarOrquestrador({
    base: () => [], capacidades: CAP, protocolo, ...(protocolo === 'envelope' ? { protocoloOpts: { headless: true } } : {}),
    provider, decorarTool: (_n, d) => d,
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  return vistos;
}

test('nativo: tool de catálogo chamada direto devolve a orientação de call_capability', async () => {
  const vistos = await resultadoDaToolDesconhecida('nativo', () => ({
    text: '', stopReason: 'tool_calls', toolCalls: [{ id: 't1', toolName: 'etapa__ler', args: {} }],
  }));
  assert.match(vistos, /Unknown tool/);
  assert.match(vistos, /não se chama pelo nome direto/);
});

test('envelope: a orientação de call_capability NÃO é injetada (lá o nome direto é a porta)', async () => {
  const vistos = await resultadoDaToolDesconhecida('envelope', () => ({
    text: JSON.stringify({ blocos: [{ chat: 'x', comandos: [{ tool: 'outra__coisa', args: '{}' }] }] }), stopReason: 'completed',
  }));
  assert.match(vistos, /Unknown tool/);
  assert.doesNotMatch(vistos, /não se chama pelo nome direto/);
});

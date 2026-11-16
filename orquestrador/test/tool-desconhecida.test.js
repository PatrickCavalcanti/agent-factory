import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador, mensagemDeToolDesconhecida, provedorComAtalhoDoCatalogo } from '../src/index.js';
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

test('nativo: nome com cara de catálogo que não está no catálogo continua recebendo a orientação de call_capability', async () => {
  const vistos = await resultadoDaToolDesconhecida('nativo', () => ({
    text: '', stopReason: 'tool_calls', toolCalls: [{ id: 't1', toolName: 'etapa__inexistente', args: {} }],
  }));
  assert.match(vistos, /Unknown tool/);
  assert.match(vistos, /não se chama pelo nome direto/);
});

/**
 * Turno nativo em que o modelo chama `etapa__ler` pelo nome do catálogo. Devolve o que o handler recebeu, a chamada
 * que o histórico guardou (2ª ida ao provider) e os resultados de tool que o modelo viu.
 */
async function turnoComChamadaDireta({ requires, can, toolName = 'etapa__ler', args = { nome: 'x' } } = {}) {
  let n = 0;
  let historico = null;
  const recebidos = [];
  const cap = [{
    id: 'etapa', descricao: 'Etapa.',
    tools: [{
      name: 'ler', description: 'Lê.', schema: z.object({ nome: z.string() }),
      ...(requires ? { requires } : {}),
      handler: async (a) => { recebidos.push(a); return { ok: true, lido: a.nome }; },
    }],
  }];
  const provider = () => ({
    name: 'fake', model: 'f',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: true, backgroundRuns: false, preferredToolProtocol: 'provider_native' },
    async generate(req) {
      n += 1;
      if (n === 1) return { text: '', stopReason: 'tool_call', toolCalls: [{ id: 't1', toolName, args }] };
      historico = req.messages;
      return { text: 'fim', stopReason: 'completed' };
    },
  });
  const orq = criarOrquestrador({
    base: () => [], capacidades: cap, protocolo: 'nativo', provider, decorarTool: (_n, d) => d,
    ...(can ? { can } : {}),
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  const chamadas = (historico ?? []).flatMap((m) => m?.metadata?.nativeToolCalls ?? []);
  const resultados = (historico ?? []).filter((m) => m.role === 'tool_result').map((m) => String(m.content));
  return { recebidos, chamadas, resultados };
}

test('nativo: função do catálogo chamada pelo nome executa pela porta de call_capability, sem volta perdida', async () => {
  const { recebidos, chamadas, resultados } = await turnoComChamadaDireta();
  assert.deepEqual(recebidos, [{ nome: 'x' }]);
  // O histórico guarda a forma certa: é o exemplo que o modelo vê na volta seguinte.
  assert.deepEqual(chamadas, [{ id: 't1', toolName: 'call_capability', args: { ref: 'etapa__ler', args: { nome: 'x' } } }]);
  assert.equal(resultados.some((r) => /Unknown tool/.test(r)), false);
});

test('nativo: o atalho não pula a permissão do kairos (call_capability confere can)', async () => {
  const { recebidos, resultados } = await turnoComChamadaDireta({
    requires: ['admin'], can: (requires) => !requires || !requires.includes('admin'),
  });
  assert.deepEqual(recebidos, []);
  assert.match(resultados.join('\n'), /permissão negada/);
});

test('provedorComAtalhoDoCatalogo: o streaming também troca a chamada, e nome nativo ou fora do catálogo fica como veio', async () => {
  const pedido = { tools: [{ name: 'call_capability' }, { name: 'load_capability' }, { name: 'finalizar' }] };
  const base = {
    name: 'fake', model: 'f', capabilities: {},
    async generate() { return { text: '', stopReason: 'tool_call', toolCalls: [] }; },
    async *stream() {
      yield { type: 'text', text: 'a' };
      yield {
        type: 'response.completed',
        response: {
          text: '', stopReason: 'tool_call',
          toolCalls: [
            { id: 'a', toolName: 'etapa__ler', args: { nome: 'x' } },
            { id: 'b', toolName: 'finalizar', args: {} },
            { id: 'c', toolName: 'outra__coisa', args: {} },
            { id: 'd', toolName: 'call_capability', args: { ref: 'etapa__ler', args: {} } },
          ],
        },
      };
    },
  };
  const embrulhado = provedorComAtalhoDoCatalogo(base, new Map([['etapa__ler', 'etapa__ler']]));
  assert.equal(embrulhado.name, 'fake');
  const eventos = [];
  for await (const e of embrulhado.stream(pedido)) eventos.push(e);
  assert.deepEqual(eventos[0], { type: 'text', text: 'a' });
  assert.deepEqual(eventos[1].response.toolCalls, [
    { id: 'a', toolName: 'call_capability', args: { ref: 'etapa__ler', args: { nome: 'x' } } },
    { id: 'b', toolName: 'finalizar', args: {} },
    { id: 'c', toolName: 'outra__coisa', args: {} },
    { id: 'd', toolName: 'call_capability', args: { ref: 'etapa__ler', args: {} } },
  ]);
});

test('provedorComAtalhoDoCatalogo: sem call_capability no pedido não troca nada', async () => {
  const resposta = { text: '', stopReason: 'tool_call', toolCalls: [{ id: 'a', toolName: 'etapa__ler', args: {} }] };
  const embrulhado = provedorComAtalhoDoCatalogo({ name: 'f', model: 'f', capabilities: {}, generate: async () => resposta }, new Map([['etapa__ler', 'etapa__ler']]));
  assert.equal(await embrulhado.generate({ tools: [{ name: 'etapa__ler' }] }), resposta);
});

test('envelope: a orientação de call_capability NÃO é injetada (lá o nome direto é a porta)', async () => {
  const vistos = await resultadoDaToolDesconhecida('envelope', () => ({
    text: JSON.stringify({ blocos: [{ chat: 'x', comandos: [{ tool: 'outra__coisa', args: '{}' }] }] }), stopReason: 'completed',
  }));
  assert.match(vistos, /Unknown tool/);
  assert.doesNotMatch(vistos, /não se chama pelo nome direto/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * `toolsDoTurno`: o handler de uma tool de capacidade recebe, no ctx, o PRÓPRIO registry do turno
 * (`registryDoTurno`) — é por ele que o poder `roteiros` (`recebeCallTool`) alcança as outras tools na
 * fábrica. Sem isto o `executar_roteiro` respondia `sem_call_tool` em toda chamada.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

function providerDeTexto(textos) {
  let i = 0;
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() { const t = textos[Math.min(i, textos.length - 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
  });
}

function turnoChamando({ tool, args, chat }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = chat;
  return JSON.stringify(exemplo);
}

const FECHA = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });
const MARCA = Symbol('marca-de-chamada-interna');

function montar({ aoRodar, primeiroTurno = turnoChamando({ tool: 'ferramentas__encadear', args: {}, chat: 'Encadeando.' }) }) {
  const alvoChamado = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [
      {
        id: 'agenda',
        prefixarTools: true,
        aliasCru: true,
        descricao: 'Consulta a agenda do usuário.',
        tools: [{
          name: 'listar',
          description: 'Lista eventos.',
          schema: z.object({ dia: z.string() }),
          handler: async (args, ctx) => {
            alvoChamado.push({ args, emit: typeof ctx?.emit, marca: ctx?.[MARCA], nomeDaChamada: ctx?.nomeDaChamada });
            return { eventos: ['reuniao'] };
          },
        }],
      },
      {
        id: 'ferramentas',
        descricao: 'Encadeia outras tools.',
        tools: [{
          name: 'encadear',
          description: 'Chama outra tool do turno.',
          schema: z.object({}),
          handler: aoRodar,
        }],
      },
    ],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([primeiroTurno, FECHA]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
  return { orq, alvoChamado };
}

test('o handler recebe toolsDoTurno: .get(nome) devolve a definição REAL (nome exposto e sinônimo cru) e roda a tool', async () => {
  let visto = null;
  const { orq, alvoChamado } = montar({
    aoRodar: async (_args, ctx) => {
      const tools = ctx.toolsDoTurno;
      const exposta = tools.get('agenda__listar');
      const crua = tools.get('listar');
      // Contexto interno como `criarCallTool` monta: herda `emit` por PROTÓTIPO e leva uma marca própria.
      const ctxInterno = Object.create(ctx);
      ctxInterno[MARCA] = true;
      const r = await exposta.handler({ dia: 'hoje' }, ctxInterno);
      visto = { temExposta: typeof exposta?.handler, temCrua: typeof crua?.handler, temSchema: typeof exposta?.argsSchema?.safeParseAsync, r };
      return { ok: true };
    },
  });

  const { resultado } = await orq.executarTurno({ texto: 'encadeia', estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.deepEqual(visto, { temExposta: 'function', temCrua: 'function', temSchema: 'function', r: { eventos: ['reuniao'] } });
  assert.equal(alvoChamado.length, 1, 'o handler REAL da tool alvo rodou uma vez');
  assert.deepEqual(alvoChamado[0].args, { dia: 'hoje' });
  assert.equal(alvoChamado[0].emit, 'function', 'emit herdado por protótipo sobrevive ao spread do orquestrador');
  assert.equal(alvoChamado[0].marca, true, 'a marca da chamada interna chega ao handler da tool alvo');
  assert.equal(alvoChamado[0].nomeDaChamada, 'agenda__listar');
});

test('toolsDoTurno é o registry do turno: contém as meta-tools (o modelo as usa; o roteiro as recusa em criarCallTool) e as tools expostas', async () => {
  let nomes = null;
  const { orq } = montar({
    aoRodar: async (_args, ctx) => {
      nomes = ctx.toolsDoTurno.entries().map(([n]) => n);
      return { ok: true };
    },
  });
  await orq.executarTurno({ texto: 'encadeia', estado: ESTADO_INICIAL });
  for (const esperado of ['call_capability', 'agenda__listar', 'ferramentas__encadear']) {
    assert.ok(nomes.includes(esperado), `faltou ${esperado}: ${nomes}`);
  }
});

// ── Meta-tool (`call_capability`): mesmo contexto do caminho direto ──
// Antes, o ctx da meta-tool era `{ ...ctxDoGenos, ...ctx }`: sem `toolsDoTurno` (roteiro chamado por `call_capability`
// respondia `sem_call_tool`) e sem achatar o ctx herdado por protótipo (a tool alvo perdia `emit`/`signal` e lançava
// DEPOIS de gravar, em `emitToolResult`).

test('roteiro chamado via call_capability recebe toolsDoTurno (não cai em sem_call_tool)', async () => {
  let visto = null;
  const { orq } = montar({
    primeiroTurno: turnoChamando({ tool: 'call_capability', args: { ref: 'ferramentas/tool/encadear', args: {} }, chat: 'Encadeando.' }),
    aoRodar: async (_args, ctx) => {
      visto = { tem: typeof ctx.toolsDoTurno?.get, agenda: typeof ctx.toolsDoTurno?.get('agenda__listar')?.handler };
      return { ok: true };
    },
  });
  const { resultado } = await orq.executarTurno({ texto: 'encadeia', estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.deepEqual(visto, { tem: 'function', agenda: 'function' });
});

test('call_capability chamada com ctx herdado por protótipo (de dentro de um roteiro) preserva emit e a marca na tool alvo', async () => {
  let r = null;
  const { orq, alvoChamado } = montar({
    aoRodar: async (_args, ctx) => {
      const ctxInterno = Object.create(ctx);
      ctxInterno[MARCA] = true;
      r = await ctx.toolsDoTurno.get('call_capability').handler({ ref: 'agenda/tool/listar', args: { dia: 'hoje' } }, ctxInterno);
      return { ok: true };
    },
  });
  await orq.executarTurno({ texto: 'encadeia', estado: ESTADO_INICIAL });

  assert.equal(alvoChamado.length, 1, `a tool alvo deveria ter rodado uma vez; r=${JSON.stringify(r)}`);
  assert.equal(alvoChamado[0].emit, 'function', 'emit herdado por protótipo sobrevive ao spread da meta-tool');
  assert.equal(alvoChamado[0].marca, true, 'a marca da chamada interna chega à tool alvo pela meta-tool');
});

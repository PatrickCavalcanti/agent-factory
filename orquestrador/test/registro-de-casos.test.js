import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * Registro de casos para treino (0.3.0): `config.aoRegistrarCaso(caso, insumos)` é chamado no fecho de cada turno NÃO
 * trivial, com o caso montado por `montarCaso` (decisoes/treino/lib/caso.js) a partir do que a fábrica tem na mão:
 * texto, vetores da consulta, operações (com o nome da função resolvido para `capacidade/tool/função`),
 * `discover.explain` e as capacidades ativas no início. O que só o host tem (a decisão do local por anel, o slug do
 * embedder, a sessão) chega por `config.dadosDoCaso(ctx)`.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const TEXTO = 'qual a agenda de hoje por favor, preciso organizar o dia';
const FECHA = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

function turnoChamando({ tool, args }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = 'Consultando.';
  return JSON.stringify(exemplo);
}

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

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'agenda',
      descricao: 'Consulta a agenda.',
      tools: [{ name: 'listar', description: 'Lista itens.', schema: z.object({}).passthrough(), handler: async () => ({ itens: [] }) }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([turnoChamando({ tool: 'agenda__listar', args: { dia: 'hoje' } }), FECHA]),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...extra,
  });
}

test('turno não trivial: um caso, montado por montarCaso, com texto, vetor, função chamada e insumos', async () => {
  const casos = [];
  const insumos = [];
  const orq = fabrica({ aoRegistrarCaso: (caso, extra) => { casos.push(caso); insumos.push(extra); }, dadosDoCaso: () => ({ guardarTexto: true }) });
  const saida = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL, vetoresDaPergunta: [[0.123456789, 0.5]] });

  assert.equal(casos.length, 1);
  const caso = casos[0];
  assert.equal(caso.versao, 1);
  assert.equal(caso.texto, TEXTO, 'guardarTexto vem do host');
  assert.equal(caso.trivial, false);
  assert.deepEqual(caso.vetores, [[0.12346, 0.5]], 'o vetor da consulta, com 5 casas (regra do montarCaso)');
  assert.equal(caso.dim, 2);
  assert.deepEqual(caso.usadas.funcoes, ['agenda/tool/listar'], 'a função chamada sai resolvida para capacidade/tool/função');
  assert.deepEqual(caso.usadas.capacidades, ['agenda']);
  assert.deepEqual(caso.usadas.funcoesCruas, [], 'o nome exposto é resolvido pelo catálogo da fábrica: não sobra nome cru');
  assert.deepEqual(caso.ativasNoInicio, [], 'capturado: nada estava carregado no início do turno');
  assert.equal(caso.origem, 'chat');
  assert.deepEqual(insumos[0].operacoes, saida.operacoes, 'o host recebe as operações para completar o caso');
  assert.equal(insumos[0].texto, TEXTO);
  assert.equal(insumos[0].discover, saida.discover);
});

test('o host completa o caso com o que só ele tem: decisão do local, slug, sessão, origem', async () => {
  const casos = [];
  const orq = fabrica({
    aoRegistrarCaso: (caso) => casos.push(caso),
    dadosDoCaso: (ctx) => ({
      sessionId: ctx.sessao, interactionId: 'i-1', origem: 'fundo', embedderSlug: 'e5-small',
      selecao: { decisoes: { provider: { full: ['agenda'], candidates: [] } }, sombras: [] },
      ativasNoInicio: ['agenda'],
    }),
  });
  await orq.executarTurno({ texto: TEXTO, ctx: { sessao: 's-9' }, estado: ESTADO_INICIAL, vetoresDaPergunta: [[1, 0]] });
  const caso = casos[0];
  assert.equal(caso.sessionId, 's-9');
  assert.equal(caso.chave, 'i-1');
  assert.equal(caso.origem, 'fundo');
  assert.equal(caso.slug, 'e5-small');
  assert.deepEqual(caso.carregadas.provider, ['agenda']);
  assert.deepEqual(caso.ativasNoInicio, ['agenda']);
});

test('sem `dadosDoCaso`, o texto não é guardado (o host precisa optar)', async () => {
  const casos = [];
  const orq = fabrica({ aoRegistrarCaso: (caso) => casos.push(caso) });
  await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(casos.length, 1);
  assert.equal('texto' in casos[0], false);
});

test('turno trivial: nenhum caso', async () => {
  const casos = [];
  const orq = fabrica({ aoRegistrarCaso: (caso) => casos.push(caso), provider: providerDeTexto([FECHA]) });
  const saida = await orq.executarTurno({ texto: 'x', estado: ESTADO_INICIAL });
  assert.equal(saida.trivial.valor, true, 'pré-condição: o turno é trivial');
  assert.equal(casos.length, 0);
});

test('trivial decidido pelo host (`entrada.trivial`) também não registra', async () => {
  const casos = [];
  const orq = fabrica({ aoRegistrarCaso: (caso) => casos.push(caso) });
  await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL, trivial: true });
  assert.equal(casos.length, 0);
});

test('gancho que lança não derruba o turno: erro em renderErrors com ref `registro-de-casos`', async () => {
  const orq = fabrica({ aoRegistrarCaso: () => { throw new Error('banco fora'); } });
  const saida = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  const erro = saida.renderErrors.find((e) => e.ref === 'registro-de-casos');
  assert.ok(erro, 'o erro do gancho vai a renderErrors');
  assert.match(erro.error, /banco fora/);
});

test('gancho assíncrono que rejeita: não é aguardado e o erro também vai a renderErrors', async () => {
  let rejeitar;
  const pendente = new Promise((_, rej) => { rejeitar = rej; });
  const orq = fabrica({ aoRegistrarCaso: () => pendente });
  const saida = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed', 'o turno terminou sem esperar a promessa do gancho');
  rejeitar(new Error('gravação lenta falhou'));
  await new Promise((r) => setImmediate(r));
  assert.ok(saida.renderErrors.some((e) => e.ref === 'registro-de-casos' && /gravação lenta falhou/.test(e.error)));
});

test('gancho assíncrono que rejeita depois do retorno: o erro também sai por `aoEvento` (fabrica:registro-de-casos), em try/catch', async () => {
  let rejeitar;
  const pendente = new Promise((_, rej) => { rejeitar = rej; });
  const eventos = [];
  const orq = fabrica({
    aoRegistrarCaso: () => pendente,
    aoEvento: (e) => { eventos.push(e); throw new Error('handler quebrado'); },
  });
  const saida = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  assert.ok(!eventos.some((e) => e.tipo === 'fabrica:registro-de-casos'), 'nada emitido enquanto a promessa está pendente');
  rejeitar(new Error('gravação lenta falhou'));
  await new Promise((r) => setImmediate(r));
  const evento = eventos.find((e) => e.tipo === 'fabrica:registro-de-casos');
  assert.ok(evento, JSON.stringify(eventos));
  assert.match(evento.erro, /gravação lenta falhou/);
  assert.ok(saida.renderErrors.some((e) => e.ref === 'registro-de-casos'), 'renderErrors continua recebendo');
});

test('erro síncrono do gancho NÃO emite evento (já está em renderErrors, que o host vê no retorno)', async () => {
  const eventos = [];
  await fabrica({ aoRegistrarCaso: () => { throw new Error('banco fora'); }, aoEvento: (e) => eventos.push(e) })
    .executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(!eventos.some((e) => e.tipo === 'fabrica:registro-de-casos'));
});

test('sem `aoRegistrarCaso`, os argumentos do caso nem são calculados (refs por nome, conjunto de capacidades ativas)', async () => {
  let lidos = 0;
  const capacidades = [{
    id: 'agenda',
    descricao: 'Consulta a agenda.',
    get tools() { lidos += 1; return [{ name: 'listar', description: 'Lista itens.', schema: z.object({}).passthrough(), handler: async () => ({ itens: [] }) }]; },
  }];
  const saida = await fabrica({ capacidades }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  const semGancho = lidos;
  lidos = 0;
  await fabrica({ capacidades, aoRegistrarCaso: () => {} }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(lidos > 0);
  assert.ok(semGancho < lidos, `com gancho lê mais (${lidos}) do que sem (${semGancho})`);
});

test('`dadosDoCaso` que lança também cai em renderErrors e o turno completa', async () => {
  const casos = [];
  const orq = fabrica({ aoRegistrarCaso: (caso) => casos.push(caso), dadosDoCaso: () => { throw new Error('sem trace'); } });
  const saida = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  assert.equal(casos.length, 0);
  assert.ok(saida.renderErrors.some((e) => e.ref === 'registro-de-casos' && /sem trace/.test(e.error)));
});

test('sem `aoRegistrarCaso`, nada muda (host que não declara não paga)', async () => {
  const saida = await fabrica().executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  assert.ok(!saida.renderErrors.some((e) => e.ref === 'registro-de-casos'));
});

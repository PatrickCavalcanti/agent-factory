import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Contribuição de piso por CHAVE (`contribuicoes[].chaves`, `config.chaves`, `config.catalogoDeChaves`):
 * entra no prompt só quando o turno traz uma das chaves dela. Sem `chaves`, é base. Host que não declara
 * chave não muda de comportamento.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const TEXTO = 'qual a agenda de hoje por favor, preciso organizar o dia';

function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

const capacidade = {
  id: 'agenda',
  descricao: 'Consulta a agenda.',
  tools: [{ name: 'listar', description: 'Lista itens.', schema: z.object({ dia: z.string() }), handler: async () => ({ itens: [] }) }],
};

const piso = (ref, texto, extra = {}) => ({
  ref, kind: 'regra', description: `Regra ${ref}.`, floor: true, volatil: false,
  destination: 'system:stable', priority: 10, read: async () => texto, ...extra,
});

const BASE = piso('informacoes/regra/base', 'TEXTO_BASE');
const GRAFICO = piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', { chaves: ['grafico'], priority: 20 });

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...extra,
  });
}

test('a contribuição com chave só entra quando o turno traz a chave — mesmo orquestrador, turnos seguidos', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], chaves: (ctx) => ctx.chaves });

  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(t1.payload.system.includes('TEXTO_BASE'), 'a base entra sempre');
  assert.ok(!t1.payload.system.includes('TEXTO_GRAFICO'), 'sem a chave, a contribuição não entra');

  const t2 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.ok(t2.payload.system.includes('TEXTO_BASE'));
  assert.ok(t2.payload.system.includes('TEXTO_GRAFICO'), 'com a chave, a contribuição entra');

  // A chave some: o texto que já estava acumulado sai do prompt.
  const t3 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: t2.estado });
  assert.ok(t3.payload.system.includes('TEXTO_BASE'));
  assert.ok(!t3.payload.system.includes('TEXTO_GRAFICO'), 'a chave saiu do turno: o texto acumulado sai junto');
});

test('turno trivial (discover pulado) também relê a contribuição com chave', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], chaves: (ctx) => ctx.chaves });

  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(!t1.payload.system.includes('TEXTO_GRAFICO'));

  const t2 = await orq.executarTurno({ texto: 'x', ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.ok(t2.payload.system.includes('TEXTO_GRAFICO'), 'a chave chegou num turno trivial: tem de entrar');

  const t3 = await orq.executarTurno({ texto: 'x', ctx: { chaves: [] }, estado: t2.estado });
  assert.ok(!t3.payload.system.includes('TEXTO_GRAFICO'), 'a chave saiu num turno trivial: tem de sair');
  assert.ok(t3.payload.system.includes('TEXTO_BASE'));
});

test('sem `config.chaves`, o turno tem todas as chaves: as contribuições com chave entram (host que não passa `chaves` não muda)', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO] });
  const { payload } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(payload.system.includes('TEXTO_BASE'));
  assert.ok(payload.system.includes('TEXTO_GRAFICO'));
});

test('chave fora de `catalogoDeChaves` recusa a montagem', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], catalogoDeChaves: ['painel'] });
  await assert.rejects(
    () => orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    (erro) => /fora do catálogo/.test(erro.message) && erro.message.includes('informacoes/regra/grafico'),
  );
});

test('`chaves` em contribuição semântica ou vazia recusa a montagem', async () => {
  const semantica = { ref: 'informacoes/regra/sem', kind: 'regra', description: 'x', floor: false, destination: 'turn:context', read: async () => 'S', chaves: ['grafico'] };
  await assert.rejects(
    () => fabrica({ contribuicoes: [semantica] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /só vale em contribuição de piso/,
  );
  await assert.rejects(
    () => fabrica({ contribuicoes: [piso('informacoes/regra/vazia', 'V', { chaves: [] })] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /`chaves` vazia/,
  );
});

test('`aoMontar` traz `chaves: { doTurno, entraram, ficaram }`', async () => {
  const infos = [];
  const orq = fabrica({
    contribuicoes: [BASE, GRAFICO],
    chaves: (ctx) => ctx.chaves,
    aoMontar: (info) => infos.push(info),
  });
  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.deepEqual(infos[0].chaves, {
    doTurno: [],
    entraram: [],
    ficaram: ['informacoes/regra/grafico'],
  });
  await orq.executarTurno({ texto: TEXTO, ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.deepEqual(infos[1].chaves, {
    doTurno: ['grafico'],
    entraram: ['informacoes/regra/grafico'],
    ficaram: [],
  });
});

test('host sem `chaves` em nenhuma contribuição e sem `config.chaves`: system idêntico e `aoMontar` sem a chave `chaves`', async () => {
  const infos = [];
  const semNada = fabrica({ contribuicoes: [BASE], aoMontar: (i) => infos.push(i) });
  const a = await semNada.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  const b = await fabrica({ contribuicoes: [BASE], chaves: () => ['qualquer'], catalogoDeChaves: ['qualquer'] })
    .executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(a.payload.system, b.payload.system, 'ligar `chaves`/`catalogoDeChaves` sem contribuição com chave não muda o system');
  assert.ok(a.payload.system.includes('TEXTO_BASE'));
  assert.ok(!('chaves' in infos[0]), 'sem contribuição com chave, o payload do aoMontar não ganha campo novo');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Lacuna 2 — `conversa`: itens DINÂMICOS no canal de conversa do kairos.
 *
 * A fábrica já alimentava o canal `conversation` a partir de contribuições
 * `floor: false` (lista ESTÁTICA — uma contribuição, um item). O orquestrador
 * de tela do Ariadne precisa de outra coisa: um array VARIÁVEL por turno,
 * montado do `ctx` (`turno.ts:123-129` — 0, 1 ou 2 itens conforme haja
 * registro/emissão abertos). `config.conversa(ctx)` cobre isso; os itens que
 * devolve SOMAM aos de contribuição `floor: false`, nunca substituem.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

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

const capacidade = (id, extra = {}) => ({
  id,
  descricao: `Consulta a capacidade ${id}.`,
  tools: [{
    name: 'consultar',
    description: `Consulta itens de ${id}.`,
    schema: z.object({ q: z.string() }),
    handler: async () => ({ itens: [] }),
  }],
  ...extra,
});

const base = () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }];

function fabrica(overrides) {
  return criarOrquestrador({
    base,
    capacidades: [capacidade('agenda')],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...overrides,
  });
}

// Texto NÃO-trivial: 'oi' cai em `unchanged` no kairos e o canal `conversation`
// nunca é avaliado nesse turno — não provaria nada sobre `conversa()`.
const TEXTO_NAO_TRIVIAL = 'preciso entender o estado atual do projeto antes de continuar o trabalho';

/** `threshold: 0` garante inclusão mesmo sem embedder (score léxico >= 0 sempre passa). */
const item = (ref, content, extra = {}) => ({ ref, content, threshold: 0, ...extra });

test('`conversa()` devolvendo 2 itens: os dois são avaliados pelo canal `conversation`', async () => {
  const orq = fabrica({
    conversa: () => [
      item('registro/aberto/123', 'Registro aberto: pedido #123'),
      item('emissao/aberta/456', 'Emissão em curso: relatório #456'),
    ],
  });

  const { resultado, discover } = await orq.executarTurno({
    texto: TEXTO_NAO_TRIVIAL,
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  const refsAvaliadas = discover.explain
    .filter((e) => e.ring === 'conversation')
    .map((e) => e.ref);
  assert.ok(refsAvaliadas.includes('registro/aberto/123'), 'o primeiro item dinâmico não chegou ao canal `conversation`');
  assert.ok(refsAvaliadas.includes('emissao/aberta/456'), 'o segundo item dinâmico não chegou ao canal `conversation`');
});

test('`ref` duplicado entre `conversa()` e uma contribuição `floor: false` recusa a montagem, nomeando o ref', async () => {
  const orq = fabrica({
    contribuicoes: [{
      ref: 'registro/aberto/123',
      kind: 'registro',
      floor: false,
      read: async () => 'Registro (contribuição).',
    }],
    conversa: () => [item('registro/aberto/123', 'Registro (dinâmico).')],
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /ref duplicado/);
      assert.match(err.message, /registro\/aberto\/123/, 'a mensagem tem de nomear QUAL ref colidiu');
      return true;
    },
  );
});

test('`aoIncluirConversa` recebe as refs que de fato entraram no prompt', async () => {
  const chamadas = [];
  const orq = fabrica({
    conversa: () => [item('registro/aberto/123', 'Registro aberto: pedido #123')],
    aoIncluirConversa: (ctx, refs) => chamadas.push(refs),
  });

  const { resultado } = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1, 'aoIncluirConversa tem que ser chamado exatamente uma vez por turno');
  assert.deepEqual(chamadas[0], ['registro/aberto/123']);
});

test('`conversa()` que lança vira `renderErrors`, e o turno completa', async () => {
  const orq = fabrica({
    conversa: () => { throw new Error('falha ao ler o registro aberto'); },
  });

  const { resultado, renderErrors } = await orq.executarTurno({
    texto: TEXTO_NAO_TRIVIAL,
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.ok(
    renderErrors.some((e) => /falha ao ler o registro aberto/.test(e.error)),
    'o erro do `conversa()` tinha que aparecer em renderErrors',
  );
});

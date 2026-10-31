import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Lacuna 1 — `can`: gate de permissão por TOOL.
 *
 * Antes desta lacuna a fábrica cravava `can: () => true` ao montar a ponte
 * genos (e o `createManager` do kairos) — nenhum host tinha como filtrar
 * tools por ator. É a mais simples das três lacunas e a mais importante,
 * porque é segurança: sem um `can` real, migrar um host que dependia de
 * filtro por permissão (o orquestrador de tela do Ariadne, `criarCan()`)
 * removeria a filtragem em silêncio.
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

const base = () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }];

/** Uma capacidade PISO com duas tools: uma livre, uma que exige `admin`. */
const capacidadeComRequires = () => ({
  id: 'admin',
  descricao: 'Área administrativa.',
  tools: [
    {
      name: 'listar',
      description: 'Lista os itens da área administrativa.',
      schema: z.object({}),
      handler: async () => ({ itens: [] }),
    },
    {
      name: 'apagar',
      description: 'Apaga um item da área administrativa.',
      schema: z.object({ id: z.string() }),
      handler: async () => ({ ok: true }),
      requires: ['admin'],
    },
  ],
});

function fabrica(overrides) {
  return criarOrquestrador({
    base,
    capacidades: [capacidadeComRequires()],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...overrides,
  });
}

// Texto NÃO-trivial: texto trivial ("oi") faz o discover devolver `unchanged`,
// e a reconstrução de piso da fábrica (`reconstruirBlocosDoTurno`) lê contratos
// direto do registry sem passar pelo `can()` por tool — não provaria nada
// sobre a gate. O caminho de `can()` por tool só roda dentro de `hydrateProvider`
// (kairos), que só é exercitado quando o discover roda de verdade.
const TEXTO_NAO_TRIVIAL = 'preciso consultar e também apagar um item da área administrativa agora';

test('`can` que recusa uma tool faz ela não aparecer no prompt montado', async () => {
  const orq = fabrica({
    can: (requires) => !requires || !requires.includes('admin'),
  });

  const { resultado, payload } = await orq.executarTurno({
    texto: TEXTO_NAO_TRIVIAL,
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.match(payload.system, /admin__listar/, 'a tool liberada precisa continuar no prompt');
  assert.doesNotMatch(payload.system, /admin__apagar/, 'a tool negada por `can` não pode aparecer no prompt');
});

test('sem `can` (default), as duas tools aparecem no prompt', async () => {
  const orq = fabrica();

  const { resultado, payload } = await orq.executarTurno({
    texto: TEXTO_NAO_TRIVIAL,
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.match(payload.system, /admin__listar/);
  assert.match(payload.system, /admin__apagar/, 'sem `can`, o default `() => true` libera tudo — comportamento anterior');
});

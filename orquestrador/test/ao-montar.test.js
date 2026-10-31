import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Lacuna 3 — `aoMontar`: emite o PAYLOAD montado do turno.
 *
 * Hoje o turno monta o prompt (`construtor.montar(...)`) e ninguém de fora
 * vê. Dois consumidores precisam: o tracer do orquestrador de tela
 * (`src/orquestrador/tracer.ts#payload`) e um inspetor ao vivo futuro.
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

// Não-trivial: precisa que o discover rode de verdade para a capacidade
// carregar e `entraram` ter algo além do vazio.
const TEXTO_NAO_TRIVIAL = 'preciso consultar a agenda de reuniões desta semana, pode me ajudar';

test('`aoMontar` é chamado uma vez por turno, com `system` não-vazio e `entraram` populado quando uma capacidade carrega', async () => {
  const chamadas = [];
  const orq = fabrica({
    aoMontar: (info) => chamadas.push(info),
  });

  const { resultado } = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1, 'aoMontar tem que ser chamado exatamente uma vez por turno');

  const info = chamadas[0];
  assert.ok(typeof info.system === 'string' && info.system.length > 0, 'system tem que vir não-vazio');
  assert.ok(Array.isArray(info.mensagens) && info.mensagens.length > 0);
  assert.ok(typeof info.mensagemDoTurno === 'string');
  assert.ok(Array.isArray(info.secoes));
  assert.ok(Array.isArray(info.entraram));
  assert.ok(Array.isArray(info.sairam));
  assert.ok(info.entraram.some((ref) => ref.startsWith('agenda/')), 'entraram tem que refletir a capacidade que carregou neste turno');
  assert.ok(info.discover && Array.isArray(info.discover.explain), 'discover tem que ser o discoverResult do turno');
});

// F5 (correção da revisão final do conjunto): o docblock da Task 11 em `test/refino.test.js`
// cita este arquivo como quem checa `info.refino` chegando a `aoMontar` — mas até esta correção
// nenhum teste aqui de fato exercitava `refino`. `config.aoMontar` já RECEBE `refino` desde a
// Task 11 (`src/index.js`, dentro do `config.aoMontar?.({...})`) — este teste só fecha a lacuna
// de cobertura, com um refinador fake que garante `refino` não-null.
test('`aoMontar` recebe `info.refino` com o MESMO valor que `executarTurno` devolve', async () => {
  const chamadas = [];
  const refinadorProvider = (input) => ({ full: input.proposal.full, candidates: input.proposal.candidates });
  const orq = fabrica({
    aoMontar: (info) => chamadas.push(info),
    refinadores: { provider: refinadorProvider },
  });

  const { resultado, refino } = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1, 'aoMontar tem que ser chamado exatamente uma vez por turno');
  assert.ok(refino, 'refino nao pode ser null com refinador provider registrado');
  assert.deepEqual(
    chamadas[0].refino, refino,
    'info.refino (aoMontar) precisa ser o MESMO valor que executarTurno devolve em refino',
  );
});

test('`aoMontar` que lança não derruba o turno', async () => {
  const orq = fabrica({
    aoMontar: () => { throw new Error('inspetor quebrado'); },
  });

  const { resultado } = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
});

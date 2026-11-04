import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * `separarSystemVolatil` de ponta a ponta: a fábrica repassa a opção ao construtor, entrega as refs de piso
 * `volatil: true` à montagem e as DUAS mensagens `developer` chegam ao provider do genos, em ordem,
 * antes do histórico e do pedido.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const TEXTO = 'preciso consultar a agenda de reuniões desta semana, pode me ajudar';

function providerQueCapta(pedidos) {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate(request) {
      pedidos.push(request.messages);
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

const capacidade = {
  id: 'agenda',
  descricao: 'Consulta a agenda.',
  piso: true,
  tools: [{
    name: 'consultar', description: 'Consulta itens da agenda.', schema: z.object({ q: z.string() }), handler: async () => ({ itens: [] }),
  }],
};

function contribuicoes(worktree) {
  return [
    {
      ref: 'papel/piso/projeto', kind: 'context', floor: true, volatil: false, destination: 'system:stable',
      priority: 60, description: 'Projeto', read: async () => 'projeto estavel do job',
    },
    {
      ref: 'papel/piso/worktree', kind: 'context', floor: true, volatil: true, destination: 'system:stable',
      priority: 61, description: 'Worktree', read: async () => worktree,
    },
  ];
}

function fabrica(pedidos, { worktree = 'tentativa 1', separar } = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade],
    contribuicoes: contribuicoes(worktree),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerQueCapta(pedidos),
    decorarTool: (nome, definicao) => definicao,
    ...(separar === undefined ? {} : { separarSystemVolatil: separar }),
  });
}

test('ligada: o provider recebe duas mensagens developer, a estável primeiro e a volátil depois, antes do pedido', async () => {
  const pedidos = [];
  const orq = fabrica(pedidos, { separar: true });
  const { resultado } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');

  const msgs = pedidos[0];
  const devs = msgs.filter((m) => m.role === 'developer');
  assert.equal(devs.length, 2, 'duas mensagens developer chegam ao provider');
  assert.equal(msgs.indexOf(devs[0]), 0);
  assert.equal(msgs.indexOf(devs[1]), 1);
  assert.ok(devs[0].content.includes('projeto estavel do job'));
  assert.ok(!devs[0].content.includes('tentativa 1'));
  assert.ok(devs[1].content.startsWith('<info source="papel/piso/worktree">'));
  assert.equal(msgs[2].role, 'user');
});

test('a primeira mensagem é igual entre jobs que só diferem no piso volátil', async () => {
  const a = []; const b = [];
  await fabrica(a, { worktree: 'tentativa 1 branch a', separar: true }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  await fabrica(b, { worktree: 'tentativa 4 branch b commit c', separar: true }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(a[0][0].content, b[0][0].content);
  assert.notEqual(a[0][1].content, b[0][1].content);
});

test('desligada (padrão): uma mensagem developer só, com o system inteiro', async () => {
  const pedidos = [];
  const info = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade],
    contribuicoes: contribuicoes('tentativa 1'),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerQueCapta(pedidos),
    decorarTool: (nome, definicao) => definicao,
    aoMontar: (i) => info.push(i),
  });
  await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  const devs = pedidos[0].filter((m) => m.role === 'developer');
  assert.equal(devs.length, 1);
  assert.equal(devs[0].content, info[0].system);
});

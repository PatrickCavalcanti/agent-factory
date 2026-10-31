// packages/decisions/test/provedor-gateway.test.js
// Task 1.2 — obter() do provedor procura conta `protocol === 'gateway'` (nunca mais
// `openrouter`) e monta o cliente via `criarProtocoloDoGateway` injetado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarProvedorDeCliente } from '../src/nucleo/index.js';

// O Igris passa 'module:executor' (antes era o padrão do pacote; agora é obrigatório).
const CONSUMER_IGRIS = 'module:executor';

test('obter: com conta gateway e criarProtocoloDoGateway, devolve cliente do gateway com decidir()', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  let contaRecebida = null;
  const criarProtocoloDoGateway = (conta) => { contaRecebida = conta; return { decide: async () => ({ answers: { a: true } }) }; };
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, listarContas, criarProtocoloDoGateway });

  const c = await provedor.obter();
  assert.ok(c && typeof c.decidir === 'function');
  assert.equal(contaRecebida.id, 'acc-1');

  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.deepEqual(r.answers, { a: true });
});

test('obter: sem conta gateway devolve null sem lançar', async () => {
  const listarContas = async () => [];
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, listarContas, criarProtocoloDoGateway: () => ({ decide: async () => ({}) }) });
  const c = await provedor.obter();
  assert.equal(c, null);
});

test('obter: conta gateway existe mas criarProtocoloDoGateway não foi injetado — devolve null sem lançar', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, listarContas });
  const c = await provedor.obter();
  assert.equal(c, null);
});

test('obter: nenhuma conta OpenRouter é consultada — só gateway é procurada (prova de J1)', async () => {
  // Fixture com SÓ conta openrouter — igual à "conta antiga" que valia antes da migração.
  const listarContas = async () => [{ protocol: 'openrouter', api_key: 'sk-test-123' }];
  const criarProtocoloDoGateway = () => { throw new Error('não deveria montar protocolo — não há conta gateway'); };
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, listarContas, criarProtocoloDoGateway });
  const c = await provedor.obter();
  assert.equal(c, null, 'openrouter sozinha não deveria produzir cliente — só gateway monta cliente em produção');
});

test('obter: criarProtocoloDoGateway lançando devolve null sem lançar', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const avisoOriginal = console.warn;
  console.warn = () => {};
  try {
    const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS,
      listarContas,
      criarProtocoloDoGateway: () => { throw new Error('token ausente'); },
    });
    const c = await provedor.obter();
    assert.equal(c, null);
  } finally {
    console.warn = avisoOriginal;
  }
});

// O pacote não lê env: o host (Igris) calcula `modoBancada` de IGRIS_TEST=1 / NODE_ENV=test /
// IGRIS_DECISOES_BANCADA=1 e passa `chaveDeBancada` (IGRIS_DECISOES_CHAVE). M-1: sem `modoBancada: true`
// a chave é sempre ignorada.
test('obter: chaveDeBancada sobrepõe o gateway quando modoBancada=true', async () => {
  const provedor = criarProvedorDeCliente({
    consumer: CONSUMER_IGRIS,
    modoBancada: true,
    chaveDeBancada: 'sk-env-999',
    listarContas: async () => { throw new Error('não deveria consultar contas — a chave tem prioridade'); },
    criarProtocoloDoGateway: () => { throw new Error('não deveria montar protocolo do gateway — a chave tem prioridade'); },
  });
  const c = await provedor.obter();
  assert.ok(c && typeof c.decidir === 'function');
});

test('obter: chaveDeBancada é ignorada sem modoBancada (M-1) — cai no gateway normal', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const criarProtocoloDoGateway = () => ({ decide: async () => ({ answers: { a: true } }) });
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, chaveDeBancada: 'sk-env-999', listarContas, criarProtocoloDoGateway });
  const c = await provedor.obter();
  assert.ok(c && typeof c.decidir === 'function', 'sem opt-in, cai no gateway normal, não na chave');
  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.deepEqual(r.answers, { a: true }, 'resposta veio do protocolo do gateway (fake), não de um cliente OpenRouter direto');
});

test('obter: chaveDeBancada sem conta de gateway e sem modoBancada devolve null (não cai na chave)', async () => {
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, chaveDeBancada: 'sk-env-999', listarContas: async () => [], criarProtocoloDoGateway: () => ({ decide: async () => ({}) }) });
  assert.equal(await provedor.obter(), null);
});

test('obter: modoBancada=true sem chaveDeBancada não vira cliente direto — segue o gateway', async () => {
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, modoBancada: true, listarContas: async () => [], criarProtocoloDoGateway: () => ({ decide: async () => ({}) }) });
  assert.equal(await provedor.obter(), null);
});

test('criarProvedorDeCliente: consumer é obrigatório; chega ao decide() do gateway', async () => {
  assert.throws(() => criarProvedorDeCliente({ listarContas: async () => [] }), /consumer/);
  let recebido = null;
  const provedor = criarProvedorDeCliente({
    consumer: 'host:x',
    listarContas: async () => [{ protocol: 'gateway', id: 'a' }],
    criarProtocoloDoGateway: () => ({ decide: async (args) => { recebido = args; return { answers: {} }; } }),
  });
  const c = await provedor.obter();
  await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.equal(recebido._consumer, 'host:x');
});

test('obter: xTitle chega no header do cliente de bancada (padrão agent-factory)', async () => {
  const headers = [];
  const fetchImpl = async (_u, o) => { headers.push(o.headers['X-Title']); return { status: 200, text: async () => JSON.stringify({ answers: {} }) }; };
  for (const xTitle of [undefined, 'igris-decisions']) {
    const p = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, modoBancada: true, chaveDeBancada: 'k', xTitle, fetchImpl, listarContas: async () => [] });
    await (await p.obter()).decidir({ state: {}, questions: {} });
  }
  assert.deepEqual(headers, ['agent-factory', 'igris-decisions']);
});

test('aquecer: não faz GET de transporte (aquecerTransporte saiu) — transporte sempre false no retorno', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const criarProtocoloDoGateway = () => ({ decide: async () => ({ answers: { pronto: true } }) });
  let recebeuCliente;
  const aquecerDecisao = async (cliente) => { recebeuCliente = cliente; return true; };
  const provedor = criarProvedorDeCliente({ consumer: CONSUMER_IGRIS, listarContas, criarProtocoloDoGateway, aquecerDecisao });

  const r = await provedor.aquecer();
  assert.deepEqual(r, { transporte: false, decisao: true });
  assert.ok(recebeuCliente && typeof recebeuCliente.decidir === 'function');
});

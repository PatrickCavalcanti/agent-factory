// packages/decisions/test/provedor-gateway.test.js
// Task 1.2 — obter() do provedor procura conta `protocol === 'gateway'` (nunca mais
// `openrouter`) e monta o cliente via `criarProtocoloDoGateway` injetado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarProvedorDeCliente } from '../src/nucleo/index.js';

test('obter: com conta gateway e criarProtocoloDoGateway, devolve cliente do gateway com decidir()', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  let contaRecebida = null;
  const criarProtocoloDoGateway = (conta) => { contaRecebida = conta; return { decide: async () => ({ answers: { a: true } }) }; };
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway });

  const c = await provedor.obter();
  assert.ok(c && typeof c.decidir === 'function');
  assert.equal(contaRecebida.id, 'acc-1');

  const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
  assert.deepEqual(r.answers, { a: true });
});

test('obter: sem conta gateway devolve null sem lançar', async () => {
  const listarContas = async () => [];
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway: () => ({ decide: async () => ({}) }) });
  const c = await provedor.obter();
  assert.equal(c, null);
});

test('obter: conta gateway existe mas criarProtocoloDoGateway não foi injetado — devolve null sem lançar', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const provedor = criarProvedorDeCliente({ listarContas });
  const c = await provedor.obter();
  assert.equal(c, null);
});

test('obter: nenhuma conta OpenRouter é consultada — só gateway é procurada (prova de J1)', async () => {
  // Fixture com SÓ conta openrouter — igual à "conta antiga" que valia antes da migração.
  const listarContas = async () => [{ protocol: 'openrouter', api_key: 'sk-test-123' }];
  const criarProtocoloDoGateway = () => { throw new Error('não deveria montar protocolo — não há conta gateway'); };
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway });
  const c = await provedor.obter();
  assert.equal(c, null, 'openrouter sozinha não deveria produzir cliente — só gateway monta cliente em produção');
});

test('obter: criarProtocoloDoGateway lançando devolve null sem lançar', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const avisoOriginal = console.warn;
  console.warn = () => {};
  try {
    const provedor = criarProvedorDeCliente({
      listarContas,
      criarProtocoloDoGateway: () => { throw new Error('token ausente'); },
    });
    const c = await provedor.obter();
    assert.equal(c, null);
  } finally {
    console.warn = avisoOriginal;
  }
});

// Salva e limpa as três envs de opt-in (IGRIS_TEST, NODE_ENV, IGRIS_DECISOES_BANCADA) para
// garantir estado "nenhuma setada" independente do que o shell/CI ambiente já tinha — restaura
// tudo no finally do teste que usar.
function semOptIn() {
  const original = {
    IGRIS_TEST: process.env.IGRIS_TEST,
    NODE_ENV: process.env.NODE_ENV,
    IGRIS_DECISOES_BANCADA: process.env.IGRIS_DECISOES_BANCADA,
  };
  delete process.env.IGRIS_TEST;
  delete process.env.NODE_ENV;
  delete process.env.IGRIS_DECISOES_BANCADA;
  return () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// M-1 (segunda revisão final): a versão anterior liberava `IGRIS_DECISOES_CHAVE` quando
// `NODE_ENV !== 'production'` — o Igris (Electron) NUNCA seta `NODE_ENV=production` (usa
// `app.isPackaged`), então essa trava não valia nada no app empacotado: uma env solta
// contornava o gateway (o canal oficial, J1) em silêncio. Agora é opt-in EXPLÍCITO por uma de
// três envs (`IGRIS_TEST=1`, `NODE_ENV=test`, `IGRIS_DECISOES_BANCADA=1`) — sem nenhuma delas,
// a chave é sempre ignorada, não importa o valor de `NODE_ENV`.
test('obter: IGRIS_DECISOES_CHAVE (env, bancada) sobrepõe o gateway quando IGRIS_DECISOES_BANCADA=1', async () => {
  const restaurar = semOptIn();
  const chaveOriginal = process.env.IGRIS_DECISOES_CHAVE;
  process.env.IGRIS_DECISOES_CHAVE = 'sk-env-999';
  process.env.IGRIS_DECISOES_BANCADA = '1';
  try {
    const provedor = criarProvedorDeCliente({
      listarContas: async () => { throw new Error('não deveria consultar contas — env tem prioridade'); },
      criarProtocoloDoGateway: () => { throw new Error('não deveria montar protocolo do gateway — env tem prioridade'); },
    });
    const c = await provedor.obter();
    assert.ok(c && typeof c.decidir === 'function');
  } finally {
    if (chaveOriginal === undefined) delete process.env.IGRIS_DECISOES_CHAVE;
    else process.env.IGRIS_DECISOES_CHAVE = chaveOriginal;
    restaurar();
  }
});

test('obter: IGRIS_DECISOES_CHAVE é ignorada sem nenhum opt-in explícito (M-1) — cai no gateway normal', async () => {
  const restaurar = semOptIn();
  const chaveOriginal = process.env.IGRIS_DECISOES_CHAVE;
  process.env.IGRIS_DECISOES_CHAVE = 'sk-env-999';
  try {
    const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
    const criarProtocoloDoGateway = () => ({ decide: async () => ({ answers: { a: true } }) });
    const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway });

    const c = await provedor.obter();
    assert.ok(c && typeof c.decidir === 'function', 'sem opt-in, cai no gateway normal, não na chave da env');
    const r = await c.decidir({ state: {}, questions: { a: { type: 'noul', instructions: 'x' } } });
    assert.deepEqual(r.answers, { a: true }, 'resposta veio do protocolo do gateway (fake), não de um cliente OpenRouter direto');
  } finally {
    if (chaveOriginal === undefined) delete process.env.IGRIS_DECISOES_CHAVE;
    else process.env.IGRIS_DECISOES_CHAVE = chaveOriginal;
    restaurar();
  }
});

test('obter: IGRIS_DECISOES_CHAVE sem conta de gateway e sem opt-in explícito devolve null (não cai na env)', async () => {
  const restaurar = semOptIn();
  const chaveOriginal = process.env.IGRIS_DECISOES_CHAVE;
  process.env.IGRIS_DECISOES_CHAVE = 'sk-env-999';
  try {
    const listarContas = async () => [];
    const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway: () => ({ decide: async () => ({}) }) });
    const c = await provedor.obter();
    assert.equal(c, null, 'sem opt-in e sem conta de gateway, a env não vira fallback — null, mesmo padrão de sempre');
  } finally {
    if (chaveOriginal === undefined) delete process.env.IGRIS_DECISOES_CHAVE;
    else process.env.IGRIS_DECISOES_CHAVE = chaveOriginal;
    restaurar();
  }
});

test('aquecer: não faz GET de transporte (aquecerTransporte saiu) — transporte sempre false no retorno', async () => {
  const listarContas = async () => [{ protocol: 'gateway', id: 'acc-1' }];
  const criarProtocoloDoGateway = () => ({ decide: async () => ({ answers: { pronto: true } }) });
  let recebeuCliente;
  const aquecerDecisao = async (cliente) => { recebeuCliente = cliente; return true; };
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway, aquecerDecisao });

  const r = await provedor.aquecer();
  assert.deepEqual(r, { transporte: false, decisao: true });
  assert.ok(recebeuCliente && typeof recebeuCliente.decidir === 'function');
});

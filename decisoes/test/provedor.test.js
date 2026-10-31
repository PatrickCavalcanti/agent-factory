// Núcleo genérico (Fase 0, Task 0.2): criarProvedorDeCliente — cliente compartilhado (N3).
// Cache só de sucesso, nova tentativa só depois de 60s (relógio injetado), marcarFalha:false
// não abre a janela de retry, sem conta gateway devolve null sem lançar, aquecer() nunca
// lança.
//
// Task 1.2 (J1/J8, 2026-09-19): `obter()` procura conta `protocol === 'gateway'` (não mais
// `openrouter`) e monta o cliente via `criarProtocoloDoGateway` injetado — os testes deste
// arquivo foram ajustados para essa fixture; a prova de que `openrouter` nunca é consultada em
// produção mora em `provedor-gateway.test.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarProvedorDeCliente } from '../src/nucleo/index.js';

const contaGateway = { protocol: 'gateway', id: 'acc-gw' };
const protocoloFake = () => ({ decide: async () => ({ answers: {} }) });

test('criarProvedorDeCliente: listarContas é obrigatório', () => {
  assert.throws(() => criarProvedorDeCliente({}), /listarContas/);
});

test('obter: sem conta gateway devolve null sem lançar', async () => {
  const provedor = criarProvedorDeCliente({ listarContas: async () => [], criarProtocoloDoGateway: protocoloFake });
  const c = await provedor.obter();
  assert.equal(c, null);
});

test('obter: listarContas() lançando também devolve null sem lançar', async () => {
  const avisoOriginal = console.warn;
  console.warn = () => {};
  try {
    const provedor = criarProvedorDeCliente({
      listarContas: async () => { throw new Error('banco fora do ar'); },
      criarProtocoloDoGateway: protocoloFake,
    });
    const c = await provedor.obter();
    assert.equal(c, null);
  } finally {
    console.warn = avisoOriginal;
  }
});

test('obter: com conta gateway, devolve cliente com decidir()', async () => {
  const listarContas = async () => [contaGateway];
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway: protocoloFake });
  const c = await provedor.obter();
  assert.ok(c && typeof c.decidir === 'function');
});

test('obter: cache só de sucesso — chamada seguinte nem consulta contas de novo', async () => {
  let chamadas = 0;
  const listarContas = async () => { chamadas++; return [contaGateway]; };
  const provedor = criarProvedorDeCliente({ listarContas, criarProtocoloDoGateway: protocoloFake });
  const c1 = await provedor.obter();
  const c2 = await provedor.obter({ listarContas: async () => { throw new Error('não deveria consultar — sucesso deveria estar cacheado'); } });
  assert.equal(c1, c2);
  assert.equal(chamadas, 1);
});

test('obter: falha não cacheia e só tenta de novo depois de 60s (relógio injetado)', async () => {
  let chamadas = 0;
  const semConta = async () => { chamadas++; return []; };
  let t = 1_000_000;
  const agora = () => t;
  const provedor = criarProvedorDeCliente({ listarContas: semConta, agora, criarProtocoloDoGateway: protocoloFake });

  const c1 = await provedor.obter();
  assert.equal(c1, null);
  assert.equal(chamadas, 1);

  // dentro dos 60s: não recacheia, não consulta o banco de novo
  t += 30_000;
  const c2 = await provedor.obter();
  assert.equal(c2, null);
  assert.equal(chamadas, 1, 'antes do intervalo de retry, não deveria consultar contas de novo');

  // depois de 60s: tenta de novo, agora com sucesso
  t += 30_001;
  const comConta = async () => { chamadas++; return [contaGateway]; };
  const c3 = await provedor.obter({ listarContas: comConta });
  assert.ok(c3 && typeof c3.decidir === 'function');
  assert.equal(chamadas, 2);

  // sucesso fica cacheado
  const c4 = await provedor.obter({ listarContas: async () => { throw new Error('não deveria consultar — cacheado'); } });
  assert.equal(c4, c3);
});

test('obter: marcarFalha:false não marca a janela de retry — a chamada seguinte tenta de novo mesmo sem esperar 60s', async () => {
  let chamadas = 0;
  const semConta = async () => { chamadas++; return []; };
  let t = 1_000_000;
  const agora = () => t;
  const provedor = criarProvedorDeCliente({ listarContas: semConta, agora, criarProtocoloDoGateway: protocoloFake });

  const c1 = await provedor.obter({ marcarFalha: false });
  assert.equal(c1, null);
  assert.equal(chamadas, 1);

  t += 10; // bem dentro da janela de 60s, se tivesse marcado
  const comConta = async () => { chamadas++; return [contaGateway]; };
  const c2 = await provedor.obter({ listarContas: comConta });
  assert.ok(c2 && typeof c2.decidir === 'function');
  assert.equal(chamadas, 2, 'marcarFalha:false não deveria ter gravado a janela de retry');
});

test('obter: marcarFalha default (true) continua marcando a janela de retry normalmente', async () => {
  let chamadas = 0;
  const semConta = async () => { chamadas++; return []; };
  let t = 1_000_000;
  const agora = () => t;
  const provedor = criarProvedorDeCliente({ listarContas: semConta, agora, criarProtocoloDoGateway: protocoloFake });

  const c1 = await provedor.obter();
  assert.equal(c1, null);
  assert.equal(chamadas, 1);

  t += 10;
  const c2 = await provedor.obter({ listarContas: async () => { throw new Error('não deveria consultar — dentro da janela'); } });
  assert.equal(c2, null);
  assert.equal(chamadas, 1, 'dentro da janela, não deveria ter tentado de novo');
});

// M-1 (segunda revisão final): a chave da env só vale com opt-in explícito
// (IGRIS_TEST=1 / NODE_ENV=test / IGRIS_DECISOES_BANCADA=1) — sem isso o Igris empacotado
// (que nunca seta NODE_ENV=production) contornava o gateway em silêncio. Prova completa das
// três variantes em `provedor-gateway.test.js`; aqui só confere que o opt-in de bancada
// funciona neste outro arquivo de teste também.
test('obter: IGRIS_DECISOES_CHAVE (env) sobrepõe listarContas quando IGRIS_DECISOES_BANCADA=1', async () => {
  const chaveOriginal = process.env.IGRIS_DECISOES_CHAVE;
  const bancadaOriginal = process.env.IGRIS_DECISOES_BANCADA;
  process.env.IGRIS_DECISOES_CHAVE = 'sk-env-999';
  process.env.IGRIS_DECISOES_BANCADA = '1';
  try {
    const provedor = criarProvedorDeCliente({ listarContas: async () => { throw new Error('não deveria consultar contas — env tem prioridade'); } });
    const c = await provedor.obter();
    assert.ok(c && typeof c.decidir === 'function');
  } finally {
    if (chaveOriginal === undefined) delete process.env.IGRIS_DECISOES_CHAVE;
    else process.env.IGRIS_DECISOES_CHAVE = chaveOriginal;
    if (bancadaOriginal === undefined) delete process.env.IGRIS_DECISOES_BANCADA;
    else process.env.IGRIS_DECISOES_BANCADA = bancadaOriginal;
  }
});

test('_resetParaTeste: limpa cache e janela de retry desta instância', async () => {
  let chamadas = 0;
  const semConta = async () => { chamadas++; return []; };
  const provedor = criarProvedorDeCliente({ listarContas: semConta, criarProtocoloDoGateway: protocoloFake });
  await provedor.obter(); // marca falha
  provedor._resetParaTeste();
  const comConta = async () => { chamadas++; return [contaGateway]; };
  const c = await provedor.obter({ listarContas: comConta });
  assert.ok(c);
  assert.equal(chamadas, 2, 'depois do reset, a janela de retry não deveria valer mais');
});

// --- aquecer() -----------------------------------------------------------------------------
// Aquecimento de transporte (GET hardcoded na OpenRouter) saiu daqui em J1 — aquecer() nunca
// mais chama fetchImpl; só obtém o cliente e dispara aquecerDecisao (quando injetada).

test('aquecer: nunca lança — sem aquecerDecisao injetada, devolve {transporte:false, decisao:false}', async () => {
  const provedor = criarProvedorDeCliente({ listarContas: async () => [contaGateway], criarProtocoloDoGateway: protocoloFake });
  const r = await provedor.aquecer();
  assert.deepEqual(r, { transporte: false, decisao: false });
});

test('aquecer: NUNCA chama fetchImpl (GET de transporte saiu); chama aquecerDecisao(cliente) injetada; marcarFalha:false não marca a janela', async () => {
  let chamouTransporte = 0;
  const fetchImpl = async () => { chamouTransporte++; return { status: 200, ok: true, text: async () => '' }; };
  let recebeuCliente;
  const aquecerDecisao = async (cliente) => { recebeuCliente = cliente; return true; };
  let chamadasContas = 0;
  const listarContas = async () => { chamadasContas++; return []; }; // sem conta -> cliente null

  const provedor = criarProvedorDeCliente({ listarContas, fetchImpl, aquecerDecisao, criarProtocoloDoGateway: protocoloFake });
  const r = await provedor.aquecer();
  assert.equal(chamouTransporte, 0, 'aquecer() não faz mais GET de transporte');
  assert.equal(recebeuCliente, null, 'sem conta, aquecerDecisao recebe cliente null (mesmo contrato de aquecerDecisao(null) -> false — quem decide isso é a função injetada)');
  assert.equal(r.transporte, false);

  // marcarFalha:false do aquecimento: tentativa seguinte de obter() não deveria estar presa
  // numa janela de retry.
  const comConta = async () => { chamadasContas++; return [contaGateway]; };
  const c = await provedor.obter({ listarContas: comConta });
  assert.ok(c);
  assert.equal(chamadasContas, 2, 'aquecer() não deveria ter marcado a janela de retry');
});

test('aquecer: {transporte:false} explícito continua sem GET (compatibilidade de assinatura), obtém cliente e chama aquecerDecisao', async () => {
  let chamouTransporte = 0;
  const fetchImpl = async () => { chamouTransporte++; return { status: 200, ok: true, text: async () => '' }; };
  let recebeuCliente;
  const aquecerDecisao = async (cliente) => { recebeuCliente = cliente; return true; };
  const listarContas = async () => [contaGateway];

  const provedor = criarProvedorDeCliente({ listarContas, fetchImpl, aquecerDecisao, criarProtocoloDoGateway: protocoloFake });
  const r = await provedor.aquecer({ transporte: false });
  assert.equal(chamouTransporte, 0);
  assert.equal(r.transporte, false);
  assert.equal(r.decisao, true);
  assert.ok(recebeuCliente && typeof recebeuCliente.decidir === 'function');
});

test('aquecer: aquecerDecisao lançando não propaga — fica a critério da função injetada, mas se ela devolver false, aquecer() não lança', async () => {
  const provedor = criarProvedorDeCliente({
    listarContas: async () => [contaGateway],
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '' }),
    aquecerDecisao: async () => false,
    criarProtocoloDoGateway: protocoloFake,
  });
  const r = await provedor.aquecer();
  assert.equal(r.decisao, false);
});

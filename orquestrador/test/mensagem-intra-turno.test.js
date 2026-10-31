// Mensagem intra-turno (spec 2026-10-28 §4.2): a fábrica liga a porta do ctx ao genos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { perfilShadowLoop } from '../src/perfis/shadow-loop.js';
import { criarOrquestrador } from '../src/index.js';
import { formatarMensagensIntraTurno } from '../src/mensagem-intra-turno.js';

const manifest = { id: 'intra.teste', description: 'Grava notas.', maxTurns: 2 };

const comComando = JSON.stringify({
  blocos: [{ chat: 'Gravando.', comandos: [{ tool: 'gravar', args: '{"t":"x"}' }] }],
});

function orquestradorCom(generate, { aterrissarNoTeto = true, extra = {} } = {}) {
  return criarOrquestrador({
    ...(aterrissarNoTeto ? { aterrissarNoTeto: true } : {}),
    ...perfilShadowLoop({
      manifest,
      systemPrompt: 'Você grava notas.',
      ...extra,
      tools: [{
        name: 'gravar', description: 'Grava.', schema: z.object({ t: z.string() }),
        handler: async () => null,
      }],
      provider: () => ({
        name: 'fake', model: 'f',
        capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
        generate,
      }),
    }),
  });
}

function ctxComPorta() {
  const recebidas = [];
  let alvo = null;
  return {
    conversaId: 'c1',
    recebidas,
    sobras: null,
    registrarAlvoDeMensagem(fn) { alvo = fn; },
    removerAlvoDeMensagem(sobras = []) { alvo = null; this.sobras = sobras; },
    entregar(m) { return alvo ? alvo(m) : { aceita: false }; },
  };
}

test('enquadramento: uma e várias mensagens, numeradas', () => {
  const um = formatarMensagensIntraTurno([{ id: 'a', content: 'usa a pasta X' }]);
  assert.ok(um.startsWith('[Mensagem do usuário enviada enquanto você trabalhava]'));
  assert.ok(um.includes('1. "usa a pasta X"'));
  const dois = formatarMensagensIntraTurno([{ id: 'a', content: 'um' }, { id: 'b', content: 'dois' }]);
  assert.ok(dois.includes('1. "um"\n2. "dois"'));
});

test('enquadramento: a próxima fala responde à mensagem com as palavras do modelo, e só quando muda algo', () => {
  const um = formatarMensagensIntraTurno([{ id: 'a', content: 'usa a pasta X' }]);
  assert.ok(um.includes('Na sua próxima fala, deixe claro que recebeu e entendeu a mensagem'));
  assert.ok(um.includes('nunca repita a mensagem'));
  assert.ok(um.includes('Se ela não muda nada (um "ok", um "isso"), siga sem comentar.'));
  // As opções de tratamento são decisão do modelo, não texto para ele repetir (dono, 29/10: "vou mudar o caminho" saiu ao pé da letra).
  assert.ok(!um.includes('mudar o caminho'));
  assert.ok(!um.includes('pause'));
  // Decisão do dono (29/10): UMA linha neutra depois da lista, exatamente este texto.
  assert.equal(um, [
    '[Mensagem do usuário enviada enquanto você trabalhava]',
    '1. "usa a pasta X"',
    'Vem do usuário, não de uma ferramenta. Avalie se ela muda o que você está fazendo e decida como tratar (agora, junto do que já faz, ou no fim), sem refazer o que já foi feito. Na sua próxima fala, deixe claro que recebeu e entendeu a mensagem, com as suas palavras; nunca repita a mensagem. Se ela não muda nada (um "ok", um "isso"), siga sem comentar.',
  ].join('\n'));
  // Aviso do sistema não é mensagem do usuário: não pede confirmação de recebimento.
  const so = formatarMensagensIntraTurno([{ id: 'aviso-de-prazo', content: '[Aviso do sistema] x', metadata: { sistema: true } }]);
  assert.ok(!so.includes('próxima fala'));
});

test('mensagem entregue no meio do turno chega ao modelo enquadrada e entra no historico', async () => {
  const ctx = ctxComPorta();
  const pedidos = [];
  let chamada = 0;
  const orq = orquestradorCom(async (pedido) => {
    pedidos.push(pedido);
    chamada += 1;
    if (chamada === 1) {
      assert.deepEqual(ctx.entregar({ id: 'm1', texto: 'na verdade, só a primeira' }), { aceita: true });
      return { text: comComando, stopReason: 'completed' };
    }
    return { text: JSON.stringify({ blocos: [{ chat: 'ok, só a primeira', comandos: [] }] }), stopReason: 'completed' };
  });

  const saida = await orq.executarTurno({ texto: 'grava as notas', ctx });

  const ultimaDoPedido2 = pedidos[1].messages.at(-1);
  assert.equal(ultimaDoPedido2.role, 'user');
  assert.ok(String(ultimaDoPedido2.content).includes('1. "na verdade, só a primeira"'));
  const papeis = saida.historico.slice(-3).map((m) => [m.id.replace(/\d+/, 'N'), m.role]);
  assert.deepEqual(papeis, [['uN', 'user'], ['uN.1', 'user'], ['aN', 'assistant']]);
  assert.equal(saida.historico.at(-2).content, 'na verdade, só a primeira');
  assert.deepEqual(ctx.sobras, []);
});

test('o host recebe no user_message_delivered o enquadramento exato e o lote (para gravar no fabrica.json)', async () => {
  const ctx = ctxComPorta();
  const eventos = [];
  let chamada = 0;
  const orq = orquestradorCom(async () => {
    chamada += 1;
    if (chamada === 1) {
      ctx.entregar({ id: 'm1', texto: 'primeira' });
      ctx.entregar({ id: 'm2', texto: 'segunda' });
      return { text: comComando, stopReason: 'completed' };
    }
    return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
  }, { extra: { aoEvento: (e) => eventos.push(e) } });

  await orq.executarTurno({ texto: 'grava as notas', ctx });

  const entregue = eventos.find((e) => e.type === 'user_message_delivered');
  assert.deepEqual(entregue.messageIds, ['m1', 'm2']);
  assert.equal(entregue.iteration, 2);
  assert.equal(entregue.enquadramento, formatarMensagensIntraTurno([{ id: 'm1', content: 'primeira' }, { id: 'm2', content: 'segunda' }]));
  assert.deepEqual(entregue.mensagens, [
    { id: 'm1', texto: 'primeira', sistema: false },
    { id: 'm2', texto: 'segunda', sistema: false },
  ]);
});

test('ctx sem a porta (literal de teste/shadow): o turno roda como antes', async () => {
  const fecha = JSON.stringify({ blocos: [{ chat: 'pronto', comandos: [] }] });
  const orq = orquestradorCom(async () => ({ text: fecha, stopReason: 'completed' }));
  const saida = await orq.executarTurno({ texto: 'oi', ctx: { conversaId: 'c1' } });
  assert.equal(saida.resultado.type, 'completed');
});

test('teto de iterações com mensagem aceita e não entregue: tetoAtingido e a mensagem volta em ctx.sobras', async () => {
  const ctx = ctxComPorta();
  let chamada = 0;
  // O provider pede a mesma tool para sempre; a mensagem chega durante a última chamada
  // (a que estoura o teto), depois da última fronteira de drenagem.
  const orq = orquestradorCom(async () => {
    chamada += 1;
    if (chamada === 2) ctx.entregar({ id: 'm9', texto: 'esquece isso' });
    return { text: comComando, stopReason: 'completed' };
  });

  const saida = await orq.executarTurno({ texto: 'grava uma nota sobre a reunião', ctx });

  assert.equal(saida.tetoAtingido, true);
  assert.equal(ctx.sobras.length, 1);
  assert.deepEqual(ctx.sobras[0], { id: 'm9', texto: 'esquece isso' });
});

test('aviso do sistema na fila: sai sem o cabeçalho de mensagem do usuário', () => {
  const so = formatarMensagensIntraTurno([{ id: 'aviso-de-prazo', content: '[Aviso do sistema] tempo acabando', metadata: { sistema: true } }]);
  assert.equal(so, '[Aviso do sistema] tempo acabando');
  const misto = formatarMensagensIntraTurno([
    { id: 'm1', content: 'usa a pasta X' },
    { id: 'aviso-de-prazo', content: '[Aviso do sistema] tempo acabando', metadata: { sistema: true } },
  ]);
  assert.ok(misto.startsWith('[Mensagem do usuário enviada enquanto você trabalhava]\n1. "usa a pasta X"'));
  assert.ok(misto.endsWith('[Aviso do sistema] tempo acabando'));
});

test('prazo da etapa perto de vencer: o aviso chega ao modelo e não entra no histórico como fala do usuário', async () => {
  const ctx = { ...ctxComPorta(), prazoDaEtapaEm: Date.now() };
  const pedidos = [];
  let chamada = 0;
  const orq = orquestradorCom(async (pedido) => {
    pedidos.push(pedido);
    chamada += 1;
    if (chamada === 1) {
      await new Promise((r) => setTimeout(r, 30));
      return { text: comComando, stopReason: 'completed' };
    }
    return { text: JSON.stringify({ blocos: [{ chat: 'O tempo acabou; falta renderizar. Posso continuar?', comandos: [] }] }), stopReason: 'completed' };
  });

  const saida = await orq.executarTurno({ texto: 'grava as notas', ctx });

  const ultima = String(pedidos[1].messages.at(-1).content);
  assert.ok(ultima.includes('[Aviso do sistema] O tempo desta mensagem está acabando'), ultima);
  assert.ok(!ultima.includes('[Mensagem do usuário'), ultima);
  assert.ok(!saida.historico.some((m) => String(m.content).includes('[Aviso do sistema]')));
});

test('mensagem enviada durante a conversa por voz ganha a marca no enquadramento', () => {
  const texto = formatarMensagensIntraTurno([
    { id: 'a', content: 'muda pra quinta', metadata: { modoVoz: 'conversa' } },
    { id: 'b', content: 'e avisa ele' },
  ]);
  assert.match(texto, /1\. "muda pra quinta" \(enviada durante a conversa por voz\)/);
  assert.match(texto, /2\. "e avisa ele"$/m);
});

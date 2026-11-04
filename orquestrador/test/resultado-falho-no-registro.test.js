import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * O registro de operações do turno (`operacoes`, o bloco `<turn_operations>`) marcava `ok` toda função
 * que voltava sem lançar: o genos emite `tool.completed` sempre que o handler retorna, e o dispatcher do
 * kairos devolve `{ ok: true, result }` mesmo quando o handler devolve `{ ok: false }`. Uma recusa
 * (falta de autorização, por exemplo) saía como `resultado: ok` e o modelo podia dizer que fez.
 * A regra de falha é a de `falhaDoResultado` (a mesma do loop do Jev); aqui só se prova a ligação.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

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

function turnoChamando({ tool, args, chat }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = chat;
  return JSON.stringify(exemplo);
}

const FECHA = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

/** Roda um turno em que o modelo chama `tool` uma vez e o handler de `pedidos/abrir` devolve `retorno`. */
async function rodar({ tool, args = {}, retorno }) {
  const chamadas = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'pedidos',
      descricao: 'Abre pedidos.',
      tools: [{
        name: 'abrir',
        description: 'Abre um pedido.',
        schema: z.object({}).passthrough(),
        handler: async () => (typeof retorno === 'function' ? retorno() : retorno),
      }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([turnoChamando({ tool, args, chat: 'Abrindo.' }), FECHA]),
    decorarTool: DECORAR_TOOL_NO_OP,
    aoChamada: (c) => chamadas.push(c),
  });
  const saida = await orq.executarTurno({ texto: 'abre o pedido pra mim', estado: ESTADO_INICIAL });
  assert.equal(saida.resultado.type, 'completed');
  assert.equal(saida.operacoes.length, 1);
  return { ...saida, fins: chamadas.filter((c) => c.fase === 'fim') };
}

const DIRETA = { tool: 'pedidos__abrir' };
const PELA_META = { tool: 'call_capability', args: { ref: 'pedidos/tool/abrir', args: {} } };

for (const [via, chamada] of [['chamada direta', DIRETA], ['call_capability', PELA_META]]) {
  test(`${via}: recusa { ok: false, error } sem lançar sai como falha, com o motivo`, async () => {
    const { operacoes, fins, historico } = await rodar({ ...chamada, retorno: { ok: false, error: { code: 'sem_autorizacao', message: 'sem autorização para abrir pedido' } } });
    assert.equal(operacoes[0].ok, false);
    assert.equal(operacoes[0].erro, 'sem autorização para abrir pedido');
    assert.equal(fins[0].ok, false);
    assert.equal(fins[0].erro, 'sem autorização para abrir pedido');
    const resposta = historico.find((m) => m.role === 'assistant').content;
    assert.match(resposta, /pedidos(__|\/tool\/)abrir \{\} → erro\n\s+sem autorização para abrir pedido/);
  });

  test(`${via}: recusa em string ("Erro: ...") sai como falha`, async () => {
    const { operacoes } = await rodar({ ...chamada, retorno: 'Erro: sem autorização para abrir pedido' });
    assert.equal(operacoes[0].ok, false);
    assert.equal(operacoes[0].erro, 'Erro: sem autorização para abrir pedido');
  });

  test(`${via}: recusa em JSON string sai como falha`, async () => {
    const { operacoes } = await rodar({ ...chamada, retorno: JSON.stringify({ ok: false, reason: 'cota esgotada' }) });
    assert.equal(operacoes[0].ok, false);
    assert.equal(operacoes[0].erro, 'cota esgotada');
  });

  test(`${via}: sucesso continua ok, com e sem a chave ok`, async () => {
    for (const retorno of [{ ok: true, id: 'p1' }, { id: 'p1' }, 'pedido p1 aberto', JSON.stringify({ ok: true })]) {
      const { operacoes, fins, historico } = await rodar({ ...chamada, retorno });
      assert.equal(operacoes[0].ok, true, JSON.stringify(retorno));
      assert.equal(operacoes[0].erro, undefined);
      assert.equal(fins[0].ok, true);
      assert.match(historico.find((m) => m.role === 'assistant').content, /pedidos(__|\/tool\/)abrir \{\} → ok/);
    }
  });
}

test('call_capability: recusa do próprio dispatcher (ref inexistente) sai como falha', async () => {
  const { operacoes } = await rodar({ tool: 'call_capability', args: { ref: 'pedidos/tool/nao_existe', args: {} }, retorno: { ok: true } });
  assert.equal(operacoes[0].ok, false);
  assert.match(operacoes[0].erro, /nao_existe/);
});

test('o resultado de uma chamada não vaza para a seguinte do mesmo nome', async () => {
  const retornos = [{ ok: false, error: 'recusado' }, { ok: true }];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'pedidos', descricao: 'Abre pedidos.',
      tools: [{ name: 'abrir', description: 'Abre.', schema: z.object({ n: z.number() }), handler: async () => retornos.shift() }],
    }],
    protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'pedidos__abrir', args: { n: 1 }, chat: 'Um.' }),
      turnoChamando({ tool: 'pedidos__abrir', args: { n: 2 }, chat: 'Dois.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
  const { operacoes } = await orq.executarTurno({ texto: 'abre dois pedidos pra mim', estado: ESTADO_INICIAL });
  assert.deepEqual(operacoes.map((o) => o.ok), [false, true]);
});


test('o motivo de qualquer forma de recusa chega ao registro (erro, mensagem, motivo, code, faltas)', async () => {
  const casos = [
    [{ ok: false, erro: 'sem autorização' }, 'sem autorização'],
    [{ ok: false, code: 'sem_autorizacao', mensagem: 'sem autorização para abrir' }, 'sem autorização para abrir'],
    [{ ok: false, motivo: 'cota esgotada' }, 'cota esgotada'],
    [{ ok: false, faltas: ['titulo'] }, 'ok: false'],
  ];
  for (const via of [DIRETA, PELA_META]) {
    for (const [retorno, motivo] of casos) {
      const { operacoes, historico } = await rodar({ ...via, retorno });
      assert.equal(operacoes[0].ok, false);
      assert.equal(operacoes[0].erro, motivo);
      assert.ok(historico.find((m) => m.role === 'assistant').content.includes(motivo));
    }
  }
});

test('retorno MCP com isError sai como falha, com o texto do content', async () => {
  const retorno = { isError: true, content: [{ type: 'text', text: 'servidor recusou' }] };
  for (const via of [DIRETA, PELA_META]) {
    const { operacoes } = await rodar({ ...via, retorno });
    assert.equal(operacoes[0].ok, false);
    assert.equal(operacoes[0].erro, 'servidor recusou');
  }
});

test('motivo longo é cortado em 300 caracteres, no registro e no histórico', async () => {
  const longo = 'x'.repeat(5000);
  for (const via of [DIRETA, PELA_META]) {
    const { operacoes, historico, fins } = await rodar({ ...via, retorno: { ok: false, erro: longo } });
    assert.equal(operacoes[0].erro.length, 300);
    assert.ok(operacoes[0].erro.endsWith('…'));
    assert.equal(fins[0].erro.length, 300);
    assert.ok(!historico.find((m) => m.role === 'assistant').content.includes('x'.repeat(301)));
  }
  const curto = 'y'.repeat(300);
  const { operacoes } = await rodar({ ...DIRETA, retorno: { ok: false, erro: curto } });
  assert.equal(operacoes[0].erro, curto, '300 exatos não são cortados');
});

test('aoChamada: o fim traz "desfecho" — recusa devolvida, exceção lançada e conclusão se distinguem', async () => {
  const devolvida = await rodar({ ...DIRETA, retorno: { ok: false, erro: 'recusado' } });
  assert.equal(devolvida.fins[0].ok, false);
  assert.equal(devolvida.fins[0].desfecho, 'recusa');
  const concluida = await rodar({ ...DIRETA, retorno: { ok: true } });
  assert.equal(concluida.fins[0].ok, true);
  assert.equal(concluida.fins[0].desfecho, 'concluiu');
  const lancada = await rodar({ ...DIRETA, retorno: () => { throw new Error('quebrou'); } });
  assert.equal(lancada.fins[0].ok, false);
  assert.equal(lancada.fins[0].desfecho, 'lancou');
  assert.match(String(lancada.fins[0].erro), /quebrou/);
  assert.equal(lancada.operacoes[0].ok, false);
});

test('isError com JSON do host: o registro mostra só o motivo; o corte de 300 não pega mensagem que cabe', async () => {
  const doHost = (message) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'validation', message } }) }, { type: 'text', text: 'dica extra' }] });
  for (const via of [DIRETA, PELA_META]) {
    const curta = await rodar({ ...via, retorno: doHost('título é obrigatório') });
    assert.equal(curta.operacoes[0].erro, 'título é obrigatório');
    const cabe = 'm'.repeat(300);
    const exata = await rodar({ ...via, retorno: doHost(cabe) });
    assert.equal(exata.operacoes[0].erro, cabe, 'mensagem de 300 não é cortada, mesmo com o JSON passando de 300');
    const longa = await rodar({ ...via, retorno: doHost('n'.repeat(900)) });
    assert.equal(longa.operacoes[0].erro.length, 300);
    assert.ok(longa.operacoes[0].erro.endsWith('…'));
  }
});

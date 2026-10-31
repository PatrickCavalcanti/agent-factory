// A-I6 (fechamento do bloco 2): o teto de iterações do laço agêntico termina o turno com aviso
// (aterrissagem suave, como a V1), em vez de derrubá-lo com `Max iterations exceeded`.
// Só esse erro é capturado; qualquer outro continua subindo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { perfilShadowLoop } from '../src/perfis/shadow-loop.js';
import { criarOrquestrador, AVISO_TETO_DE_ITERACOES } from '../src/index.js';

const manifest = { id: 'teto.teste', description: 'Grava sem parar.', maxTurns: 2 };

const comComando = JSON.stringify({
  blocos: [{ chat: 'Gravando.', comandos: [{ tool: 'gravar', args: '{"t":"x"}' }] }],
});

function orquestradorCom(generate, { aterrissarNoTeto = true } = {}) {
  return criarOrquestrador({
    ...(aterrissarNoTeto ? { aterrissarNoTeto: true } : {}),
    ...perfilShadowLoop({
    manifest,
    systemPrompt: 'Você grava notas.',
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

test('estouro do teto de iterações: o turno conclui com o aviso, sem lançar', async () => {
  // O provider ignora o fechamento e pede a mesma tool para sempre: o laço bate no teto.
  const orq = orquestradorCom(async () => ({ text: comComando, stopReason: 'completed' }));
  const saida = await orq.executarTurno({ texto: 'grava uma nota sobre a reunião', ctx: { conversaId: 'c1' } });

  assert.equal(saida.resultado.type, 'completed');
  assert.equal(saida.tetoAtingido, true);
  assert.equal(saida.aviso, AVISO_TETO_DE_ITERACOES);
  assert.match(saida.aviso, /^Atingi o limite de tentativas desta ação e não consegui concluir tudo\./);
  assert.equal(saida.texto, '', 'o modelo não deu resposta final: o aviso é do host, não texto do modelo');
  const ultima = saida.historico.at(-1);
  assert.equal(ultima.role, 'assistant');
  assert.ok(ultima.content.includes(AVISO_TETO_DE_ITERACOES), 'o aviso entra no histórico: o "sim, continua" seguinte precisa dele');
});

test('sem aterrissarNoTeto (perfil de shadow/agente), o estouro rejeita com Max iterations exceeded', async () => {
  const orq = orquestradorCom(
    async () => ({ text: comComando, stopReason: 'completed' }),
    { aterrissarNoTeto: false },
  );
  await assert.rejects(
    () => orq.executarTurno({ texto: 'grava uma nota sobre a reunião', ctx: { conversaId: 'c1' } }),
    /Max iterations exceeded/i,
  );
});

test('turno que conclui antes do teto não traz tetoAtingido nem aviso', async () => {
  const fecha = JSON.stringify({ blocos: [{ chat: 'pronto', comandos: [] }] });
  const orq = orquestradorCom(async () => ({ text: fecha, stopReason: 'completed' }));
  const saida = await orq.executarTurno({ texto: 'oi, tudo bem por aí', ctx: { conversaId: 'c1' } });

  assert.equal(saida.resultado.type, 'completed');
  assert.equal(saida.tetoAtingido, false);
  assert.equal('aviso' in saida, false);
});

test('outro erro do laço continua subindo (só o teto é capturado)', async () => {
  const orq = orquestradorCom(async () => { throw new Error('falha do provider'); });
  await assert.rejects(
    () => orq.executarTurno({ texto: 'grava uma nota sobre a reunião', ctx: { conversaId: 'c1' } }),
    (erro) => {
      assert.match(erro.message, /falha do provider/);
      assert.doesNotMatch(erro.message, /Max iterations exceeded/i);
      return true;
    },
  );
});

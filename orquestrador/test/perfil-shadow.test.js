import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { perfilShadowLoop, FORMA_HEADLESS } from '../src/perfis/shadow-loop.js';

const manifest = { id: 'md_notes.writer', description: 'Escreve notas.', maxTurns: 6 };
const tools = [{ name: 'gravar', description: 'Grava.', schema: z.object({}), handler: async () => null }];
const provider = () => ({});

test('o perfil traduz o manifesto para a config da fábrica', () => {
  const c = perfilShadowLoop({ manifest, systemPrompt: 'Você escreve notas.', tools, provider });
  assert.equal(c.protocolo, 'envelope');
  assert.deepEqual(c.protocoloOpts, { headless: true });
  assert.equal(c.maxIteracoes, 6);
  assert.equal(c.limiteDeTools, 1);
  assert.equal(c.capacidades.length, 1);
  assert.equal(c.capacidades[0].piso, true);
});

test('o id da capacidade é aceito pelo defineProvider do kairos', async () => {
  const { montarProviders } = await import('../src/capacidades.js');
  const c = perfilShadowLoop({ manifest, systemPrompt: 'x', tools, provider });
  // Não afirma a forma do id — afirma que ele PASSA na validação do kairos,
  // que é o que importa. O id do shadow tem ponto e underscore e seria
  // rejeitado cru (kairos aceita só `^[a-z0-9][a-z0-9-]*$`).
  assert.doesNotThrow(() => montarProviders(c.capacidades));
});

test('a forma headless não menciona fala nem layout', () => {
  for (const campo of ['_fala', 'layout']) {
    assert.ok(!FORMA_HEADLESS.includes(campo));
  }
});

test('shadow loop sem tools vira modo prosa: capacidades vazias, protocolo nativo, sem envelope no base()', () => {
  const c = perfilShadowLoop({ manifest, systemPrompt: 'Você escreve notas.', tools: [], provider });
  assert.deepEqual(c.capacidades, []);
  assert.equal(c.protocolo, 'nativo');
  assert.equal(c.protocoloOpts, undefined);
  assert.equal(c.limiteDeTools, undefined);
  const secoes = c.base({});
  assert.ok(!secoes.some((s) => s.nome === 'formato'), 'não deveria haver seção de formato sem tools');
  const textoDoBase = secoes.map((s) => s.conteudo).join('\n');
  assert.ok(!textoDoBase.includes('<formato_da_resposta>'), 'base() não deveria descrever um envelope que não existe');
});

test('shadow loop sem tools roda de ponta a ponta na fábrica e devolve a prosa limpa (não o envelope)', async () => {
  const { criarOrquestrador } = await import('../src/index.js');
  const prosa = 'Aqui está o texto final do compositor, sem JSON nenhum.';
  const orq = criarOrquestrador(perfilShadowLoop({
    manifest: { id: 'redator.compositor', description: 'Compõe a resposta final.', maxTurns: 1 },
    systemPrompt: 'Você é o compositor.',
    tools: [],
    provider: () => ({
      name: 'fake', model: 'f',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: false, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'provider_native' },
      async generate() { return { text: prosa, stopReason: 'completed' }; },
    }),
  }));
  const saida = await orq.executarTurno({ texto: 'componha a resposta', ctx: { conversaId: 'c1' } });
  assert.equal(saida.resultado.type, 'completed');
  assert.equal(saida.texto, prosa, 'saida.texto deveria ser a prosa crua, sem desembrulho de envelope');
});

test('o perfil roda de ponta a ponta na fábrica, sem decorarTool', async () => {
  const { criarOrquestrador } = await import('../src/index.js');
  const chamadas = [];
  // Correção 2 (Fase 4, paridade): catálogo fechado (uma capacidade só) expõe
  // o nome CRU da tool — `prefixarTools: false` em perfilShadowLoop. Nome
  // exposto = "gravar", não "md-notes-writer__gravar" (o prefixo só serve para
  // desambiguar ENTRE capacidades, que não existem aqui).
  const comComando = JSON.stringify({
    blocos: [{ chat: 'Gravando.', comandos: [{ tool: 'gravar', args: '{"t":"x"}' }] }],
  });
  const fecha = JSON.stringify({ blocos: [{ chat: 'pronto', comandos: [] }] });
  let i = 0;
  const orq = criarOrquestrador(perfilShadowLoop({
    manifest,
    systemPrompt: 'Você escreve notas.',
    tools: [{
      name: 'gravar', description: 'Grava.', schema: z.object({ t: z.string() }),
      handler: async (a) => { chamadas.push(a); return null; },
    }],
    provider: () => ({
      name: 'fake', model: 'f',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
      async generate() { const t = [comComando, fecha][Math.min(i, 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
    }),
  }));
  const saida = await orq.executarTurno({ texto: 'grava uma nota sobre a reunião', ctx: { conversaId: 'c1' } });
  assert.equal(saida.resultado.type, 'completed');
  assert.deepEqual(chamadas, [{ t: 'x' }], 'a tool do shadow não foi chamada pelo nome exposto');
  // O nome anunciado no prompt tem que ser o MESMO que o genos registrou e
  // executou — "gravar", sem prefixo. Correção 2 tocou capacidades.js/index.js
  // para não prefixar; esta asserção prova que anúncio e execução continuam
  // de acordo depois da mudança.
  //
  // Verifica o atributo `name=` da tag de função, não mais uma linha de
  // índice separada: a tool do shadow é PISO, hidrata já no primeiro turno, e
  // desde a Mudança 2 (2026-09-18) uma função com manual só aparece no grupo
  // "disponíveis" (`<function name="...">manual</function>`) — a linha de
  // índice (`gravar — Grava.`) nunca chega a ser impressa para ela, de
  // propósito: mostrar as duas era a duplicação que a mudança elimina.
  assert.ok(saida.payload.system.includes('name="gravar"'), 'a tag de função não anunciou o nome cru "gravar"');
  assert.ok(saida.payload.system.includes('Grava.'), 'o manual da função não entrou no prompt');
  assert.ok(!saida.payload.system.includes('md-notes-writer__gravar'), 'o prompt não deveria anunciar o nome prefixado');
});

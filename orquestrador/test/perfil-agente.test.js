import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { perfilAgenteLlm } from '../src/perfis/agente-llm.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

const agent = {
  name: 'monitor de temperatura',
  nome_proprio: 'Arthur',
  descricao: 'Vigia a temperatura da sala.',
  mode: 'llm',
  motor: 'llm',
  system_prompt: 'Você é o Arthur e vigia a temperatura.',
  mensagem_padrao: 'Cheque a temperatura agora.',
  tools: ['ha_estado'],
  carrega: [],
  max_turns: 4,
};

const tools = [
  { name: 'ha_estado', description: 'Lê um sensor.', schema: z.object({ id: z.string() }), handler: async () => null },
  { name: 'notificar_do_agente', description: 'Avisa o usuário.', schema: z.object({ titulo: z.string() }), handler: async () => null },
  { name: 'concluir_execucao', description: 'Encerra.', schema: z.object({}), handler: async () => null },
];

const provider = () => ({});

/**
 * Monta um turno a partir do EXEMPLO CANÔNICO que a própria estratégia ensina,
 * em vez de escrever o envelope à mão (mesmo padrão de fabrica.test.js /
 * perfil-shadow.test.js — não fabricar fixture desconectado do que o prompt
 * de fato ensina).
 */
function turnoDoExemplo({ tool, args, chat }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  assert.equal(typeof comando.args, 'string', 'o exemplo canônico deixou de usar args como string');
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = chat;
  return JSON.stringify(exemplo);
}

test('a linha vira a config da fábrica', () => {
  // `maxTurns` chega já coagido de fora (é o que `motor-llm.js` faz com
  // `manifesto.maxTurns`) — ver os dois testes de `maxIteracoes` abaixo para
  // a trava de que o perfil NÃO lê `agent.max_turns` por conta própria.
  const c = perfilAgenteLlm({ agent, tools, provider, maxTurns: agent.max_turns });
  assert.equal(c.protocolo, 'envelope');
  assert.deepEqual(c.protocoloOpts, { headless: true });
  assert.equal(c.maxIteracoes, 4);
  assert.equal(c.limiteDeTools, 3);
  assert.equal(c.capacidades.length, 1);
  assert.equal(c.capacidades[0].piso, true);
});

// Correção 1 (review de fim de Fase 5): antes desta correção o perfil lia
// `agent.max_turns ?? 12` diretamente — uma SEGUNDA fonte da mesma regra que
// `montarManifesto` (async-shadows/agents/motor-llm.js) já calcula em
// `manifesto.maxTurns`. As duas regras divergem no caso normal (agente sem
// `max_turns` declarado: `entities/agent.js` normaliza para `null`, o legado
// cai em 8, a fábrica caía em 12) — 50% mais turnos/custo sem que a paridade
// da Fase 7 pudesse distinguir "fábrica gastou mais" de "fábrica é diferente".
test('maxIteracoes vem do maxTurns explicito recebido, nunca da linha crua do agente', () => {
  const c = perfilAgenteLlm({ agent: { ...agent, max_turns: 999 }, tools, provider, maxTurns: 4 });
  assert.equal(c.maxIteracoes, 4, 'leu agent.max_turns em vez do maxTurns explicito');
});

test('sem maxTurns explicito, o default e 12 — nao a linha crua do agente', () => {
  const c = perfilAgenteLlm({ agent: { ...agent, max_turns: 999 }, tools, provider });
  assert.equal(c.maxIteracoes, 12);
});

test('o system_prompt da linha vira a identidade', () => {
  const c = perfilAgenteLlm({ agent, tools, provider });
  const [identidade] = c.base();
  assert.equal(identidade.nome, 'identidade');
  assert.equal(identidade.conteudo, 'Você é o Arthur e vigia a temperatura.');
});

test('sem system_prompt, a identidade é montada de nome_proprio + descricao', () => {
  const semPrompt = { ...agent, system_prompt: undefined };
  const c = perfilAgenteLlm({ agent: semPrompt, tools, provider });
  const [identidade] = c.base();
  assert.equal(identidade.conteudo, 'Você é Arthur. Vigia a temperatura da sala.');
});

test('motor diferente de llm lança', () => {
  const outroMotor = { ...agent, motor: 'igris' };
  assert.throws(
    () => perfilAgenteLlm({ agent: outroMotor, tools, provider }),
    /motor 'llm'.*motor "igris"/,
  );
});

test('as duas tools sempre-presentes do runtime chegam', () => {
  const c = perfilAgenteLlm({ agent, tools, provider });
  const nomes = c.capacidades[0].tools.map((t) => t.name);
  assert.ok(nomes.includes('notificar_do_agente'));
  assert.ok(nomes.includes('concluir_execucao'));
});

test('o nome exposto de notificar_do_agente é EXATAMENTE notificar_do_agente, sem prefixo', async () => {
  const { montarProviders, toolsExpostas } = await import('../src/capacidades.js');
  const c = perfilAgenteLlm({ agent, tools, provider });

  // Face de EXECUÇÃO (genos): o nome que o modelo de fato chama.
  const expostas = toolsExpostas(c.capacidades);
  const exposta = expostas.find((t) => t.description === 'Avisa o usuário.');
  assert.ok(exposta, 'notificar_do_agente não apareceu nas tools expostas');
  assert.equal(exposta.nome, 'notificar_do_agente');

  // Face de REGISTRO (kairos): não deveria lançar, e o provider registrado
  // usa o id fixo 'agente' — sem prefixo por tool.
  assert.doesNotThrow(() => montarProviders(c.capacidades));
});

test('ponta a ponta na fábrica, sem decorarTool: notificar_do_agente executa pelo nome cru', async () => {
  const { criarOrquestrador } = await import('../src/index.js');
  const chamadas = [];
  const comComando = turnoDoExemplo({
    tool: 'notificar_do_agente',
    args: { titulo: 'Temperatura alta' },
    chat: 'Avisando.',
  });
  const fecha = JSON.stringify({ blocos: [{ chat: 'pronto', comandos: [] }] });
  let i = 0;

  const orq = criarOrquestrador(perfilAgenteLlm({
    agent,
    tools: [
      tools[0],
      {
        name: 'notificar_do_agente', description: 'Avisa o usuário.', schema: z.object({ titulo: z.string() }),
        handler: async (args) => { chamadas.push(args); return null; },
      },
      tools[2],
    ],
    provider: () => ({
      name: 'fake', model: 'f',
      capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
      async generate() { const t = [comComando, fecha][Math.min(i, 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
    }),
  }));

  const saida = await orq.executarTurno({ texto: 'monitora a temperatura', ctx: { conversaId: 'c1' } });
  assert.equal(saida.resultado.type, 'completed');
  assert.deepEqual(chamadas, [{ titulo: 'Temperatura alta' }], 'notificar_do_agente não foi chamada pelo nome exposto');
  assert.ok(saida.payload.system.includes('notificar_do_agente'), 'o índice não anunciou o nome cru "notificar_do_agente"');
  assert.ok(!saida.payload.system.includes('agente__notificar_do_agente'), 'o prompt não deveria anunciar o nome prefixado');
});

test('prefixoDoEnvelope vai para protocoloOpts e dá nome ao schema do turno; sem ele, nome neutro', () => {
  const com = perfilAgenteLlm({ agent, tools, provider, prefixoDoEnvelope: 'igris' });
  assert.deepEqual(com.protocoloOpts, { headless: true, prefixoDoEnvelope: 'igris' });
  assert.equal(estrategiaEnvelope(com.protocoloOpts).schema().name, 'igris_envelope_headless');
  const sem = perfilAgenteLlm({ agent, tools, provider });
  assert.deepEqual(sem.protocoloOpts, { headless: true });
  assert.equal(estrategiaEnvelope(sem.protocoloOpts).schema().name, 'envelope_headless');
});

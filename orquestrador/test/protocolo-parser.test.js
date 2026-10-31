// Prova que o texto que ENSINA o protocolo descreve o que o parser REAL do
// genos aceita. Sem isto, a coerência entre os dois é convenção — e uma mudança
// no parser (outro repo, outro ciclo) passaria em silêncio até um modelo falhar
// em produção.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator, InMemoryRunStore, ToolRegistry } from 'genos-orchestrator';
import { z } from 'zod';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';
import { estrategiaFence } from '../src/protocolo/fence.js';

/**
 * Extrai o exemplo canônico `{"blocos": ...}` de dentro do texto do INVARIANTE
 * do envelope. Se o INVARIANTE perder o exemplo (virar casca vazia, ou o
 * exemplo mudar de forma a ponto de não começar mais com `{"blocos"`), isto
 * falha alto e claro em vez de deixar o teste seguinte silenciosamente montar
 * um fixture desconectado do texto.
 */
function extrairExemploEnvelope(conteudo) {
  const linha = conteudo.split('\n').find((l) => l.trim().startsWith('{"blocos"'));
  assert.ok(linha, 'o INVARIANTE do envelope perdeu o exemplo canônico ({"blocos":...})');
  return JSON.parse(linha.trim());
}

/**
 * Extrai o exemplo canônico de dentro da cerca ```command``` do INVARIANTE do
 * fence. Mesma lógica de "falha alto se sumir" do extrator do envelope acima.
 */
function extrairExemploFence(conteudo) {
  const match = /```command\r?\n([\s\S]*?)\r?\n```/.exec(conteudo);
  assert.ok(match, 'o INVARIANTE do fence perdeu o exemplo de cerca canônico');
  return JSON.parse(match[1]);
}

/** Provider falso: devolve textos escriptados, um por iteração. */
function providerDeTexto(textos) {
  let i = 0;
  return {
    name: 'fake',
    model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      const text = textos[Math.min(i, textos.length - 1)];
      i += 1;
      return { text, stopReason: 'completed' };
    },
  };
}

test('o envelope descrito pela seção invariante é executado pelo parser do genos', async () => {
  const estrategia = estrategiaEnvelope({ headless: true });
  const { conteudo } = estrategia.secaoInvariante();

  // O fixture NÃO é escrito à mão: é o exemplo canônico extraído do próprio
  // texto que o modelo lê. Isso é o que liga "o texto ensina" a "o parser
  // aceita" — sem isto, provar que o parser aceita um objeto que EU escrevi diz
  // zero sobre se ele aceita o que o INVARIANTE ensina.
  const exemplo = extrairExemploEnvelope(conteudo);

  // Direcionais: sobrevivem à inversão da instrução (ao contrário de um
  // `.includes('"args": "{}"')` solto, que continua verdadeiro numa frase
  // invertida — ver o teste da regra em protocolo.test.js). Aqui a checagem é
  // ESTRUTURAL sobre o exemplo derivado, não sobre uma substring da prosa.
  const comando = exemplo?.blocos?.[0]?.comandos?.[0];
  assert.ok(
    comando && Object.prototype.hasOwnProperty.call(comando, 'tool'),
    'o exemplo canônico do envelope não usa "tool" como chave da tool',
  );
  assert.equal(
    typeof comando.args,
    'string',
    'o exemplo canônico do envelope não ensina args como string — inverter a regra pra objeto quebra aqui',
  );

  // Ida e volta real: pega o exemplo (derivado do texto), troca só o nome da
  // tool e os args pelos do teste, e alimenta o parser DE VERDADE do genos.
  comando.tool = 'somar';
  comando.args = JSON.stringify({ a: 2, b: 3 });

  const chamadas = [];
  const tools = new ToolRegistry();
  tools.register('somar', {
    description: 'Soma dois números.',
    argsSchema: z.object({ a: z.number(), b: z.number() }),
    effect: 'read',
    handler: async (args) => { chamadas.push(args); return { total: args.a + args.b }; },
  });

  const comComando = JSON.stringify(exemplo);
  const semComando = JSON.stringify({ blocos: [{ chat: 'Dá 5.', comandos: [] }] });

  const orchestrator = createOrchestrator({
    provider: providerDeTexto([comComando, semComando]),
    runStore: new InMemoryRunStore(),
    tools,
    initialMessages: [{ id: 's', role: 'developer', content: 'x' }],
    toolProtocol: estrategia.toolProtocol,
    maxIterations: 4,
  });

  const resultado = await orchestrator.start({ runId: 'r1' });

  assert.equal(resultado.type, 'completed');
  assert.deepEqual(chamadas, [{ a: 2, b: 3 }], 'o parser não extraiu a chamada do exemplo ensinado pelo INVARIANTE');
});

test('o fence descrito pela seção invariante é executado pelo parser do genos (ida e volta)', async () => {
  const estrategia = estrategiaFence();
  const { conteudo } = estrategia.secaoInvariante();

  const exemplo = extrairExemploFence(conteudo);

  // Direcionais, espelhando o par de checagens do envelope acima — mas com a
  // forma OPOSTA: no fence a chave da tool é `type` (não `tool`) e `args` é
  // OBJETO (não string). Confirmado contra o parser real do genos
  // (`directToolEnvelopeSchema`/`execEnvelopeSchema`, stream-processor.ts): se
  // o texto trocar `type` por `tool`, ou a regra virar "args é string", isto
  // quebra aqui antes mesmo de chegar no round-trip.
  assert.ok(
    Object.prototype.hasOwnProperty.call(exemplo, 'type'),
    'o exemplo canônico do fence não usa "type" como chave da tool',
  );
  assert.equal(
    typeof exemplo.args,
    'object',
    'o exemplo canônico do fence não ensina args como objeto',
  );
  assert.ok(exemplo.args !== null && !Array.isArray(exemplo.args), 'args do exemplo do fence não é um objeto simples');

  exemplo.type = 'somar';
  exemplo.args = { a: 2, b: 3 };

  const chamadas = [];
  const tools = new ToolRegistry();
  tools.register('somar', {
    description: 'Soma dois números.',
    argsSchema: z.object({ a: z.number(), b: z.number() }),
    effect: 'read',
    handler: async (args) => { chamadas.push(args); return { total: args.a + args.b }; },
  });

  // Cerca real, no formato exato que o INVARIANTE do fence ensina: exatamente
  // três crases, tipo `command`, um objeto JSON por cerca. O segundo turno
  // fecha o loop em texto normal, sem cerca — como o próprio INVARIANTE ensina.
  const comComando = '```command\n' + JSON.stringify(exemplo) + '\n```';
  const semComando = 'Pronto.';

  const orchestrator = createOrchestrator({
    provider: providerDeTexto([comComando, semComando]),
    runStore: new InMemoryRunStore(),
    tools,
    initialMessages: [{ id: 's', role: 'developer', content: 'x' }],
    toolProtocol: estrategia.toolProtocol,
    maxIterations: 4,
  });

  const resultado = await orchestrator.start({ runId: 'r-fence' });

  assert.equal(resultado.type, 'completed');
  assert.deepEqual(chamadas, [{ a: 2, b: 3 }], 'o parser não extraiu a chamada da cerca ensinada pelo INVARIANTE do fence');
});

test('args que desserializa para não-objeto vira erro de parse, não chamada', async () => {
  const chamadas = [];
  const tools = new ToolRegistry();
  tools.register('somar', {
    description: 'Soma.',
    argsSchema: z.object({ a: z.number(), b: z.number() }),
    effect: 'read',
    handler: async (args) => { chamadas.push(args); return null; },
  });

  // `args` string cujo conteúdo NÃO é um objeto. O parser trata isso como
  // falha do MODELO (argsParseError): nunca vira chamada, e nunca evapora em
  // silêncio — sai como fence_parse_error para o mecanismo de feedback.
  const errado = JSON.stringify({
    blocos: [{ chat: null, comandos: [{ tool: 'somar', args: '"cinco"' }] }],
  });
  const fecha = JSON.stringify({ blocos: [{ chat: 'fim', comandos: [] }] });
  const eventos = [];

  const orchestrator = createOrchestrator({
    provider: providerDeTexto([errado, fecha]),
    runStore: new InMemoryRunStore(),
    tools,
    initialMessages: [{ id: 's', role: 'developer', content: 'x' }],
    toolProtocol: 'json_output',
    maxIterations: 4,
    onEvent: (e) => eventos.push(e.type),
  });
  await orchestrator.start({ runId: 'r2' });

  assert.deepEqual(chamadas, [], 'args inválido virou chamada');
  assert.ok(eventos.includes('fence_parse_error'), 'o erro evaporou em silêncio');
});

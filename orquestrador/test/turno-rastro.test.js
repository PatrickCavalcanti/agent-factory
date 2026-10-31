import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

// Os dois bugs documentados em fabrica.test.js (default de `decorarTool`
// corrompendo toda tool, e default de `estado` sem a chave `kairos`) foram
// corrigidos — ver correções C1/C2 do review de Fase 3. `estado.kairos` e
// `decorarTool` seguem explícitos aqui só para deixar o fixture legível, não
// mais para contornar um crash.
const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
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

const capacidade = (chamadas) => ({
  id: 'agenda',
  descricao: 'Consulta a agenda do usuário.',
  tools: [{
    name: 'listar',
    description: 'Lista eventos de um dia.',
    schema: z.object({ dia: z.string() }),
    handler: async (args) => { chamadas.push(args); return { eventos: [] }; },
  }],
});

/** Mesma capacidade, mas o handler LANÇA — para exercitar o caminho `tool.failed`. */
const capacidadeFalha = () => ({
  id: 'agenda',
  descricao: 'Consulta a agenda do usuário.',
  tools: [{
    name: 'listar',
    description: 'Lista eventos de um dia.',
    schema: z.object({ dia: z.string() }),
    handler: async () => { throw new Error('agenda indisponível'); },
  }],
});

/**
 * Copiada de fabrica.test.js: monta um turno a partir do EXEMPLO CANÔNICO que
 * a própria estratégia ensina, em vez de escrever o envelope à mão — um
 * fixture escrito à mão provaria só que o parser aceita o que EU escrevi, não
 * o que o prompt ensina.
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

/** Monta a fábrica + os dois turnos de provider (chama a tool, depois fecha). */
function montarComTool(capacidadeDoTeste, extra = {}) {
  const comComando = turnoDoExemplo({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });
  return criarOrquestrador({
    base: () => [],
    capacidades: [capacidadeDoTeste],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([comComando, fecha]),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...extra,
  });
}

const ENTRADA = {
  texto: 'o que tenho hoje?',
  estado: { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO },
};

test('a operação executada aparece em operacoes, com args', async () => {
  const chamadas = [];
  const orq = montarComTool(capacidade(chamadas));
  const { resultado, operacoes } = await orq.executarTurno(ENTRADA);

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].ok, true);
  assert.deepEqual(operacoes[0].args, { dia: 'hoje' });
});

test('o histórico leva o bloco de operações costurado na resposta', async () => {
  const orq = montarComTool(capacidade([]));
  const { historico } = await orq.executarTurno(ENTRADA);

  const ultima = historico[historico.length - 1];
  assert.equal(ultima.role, 'assistant');
  // `nomes.operacoes` default é `turn_operations` (prompt-builder.js,
  // renomeado de `operacoes_do_turno` em 2026-09-18) — é a marca do bloco. O
  // nome do argumento usado ("dia") também precisa sobreviver, senão o
  // modelo não sabe com que chamou a tool.
  assert.ok(ultima.content.includes('turn_operations'), 'bloco de operações não entrou na resposta');
  assert.ok(ultima.content.includes('dia'), 'o argumento da chamada não sobreviveu no bloco');
});

test('o histórico guarda o texto CRU do usuário', async () => {
  const orq = montarComTool(capacidade([]));
  const { historico } = await orq.executarTurno(ENTRADA);

  const penultima = historico[historico.length - 2];
  assert.equal(penultima.role, 'user');
  assert.equal(penultima.content, ENTRADA.texto);
});

test('aoChamada recebe início e fim da MESMA chamada', async () => {
  const eventos = [];
  const orq = montarComTool(capacidade([]), { aoChamada: (c) => eventos.push(`${c.fase}:${c.id}`) });
  await orq.executarTurno(ENTRADA);

  assert.deepEqual(eventos, ['inicio:c1', 'fim:c1']);
});

// Sessão 74dc43a0 (2026-10-20): `navegador__clicar {"ref":"e10"}` virou a chamada "e10" com
// `powerId: null` no registro — `abrir()` lia `args.ref` de QUALQUER tool como a ref interna
// da meta-tool `call_capability`. Função com argumento próprio chamado `ref` mantém o nome.
test('tool com argumento `ref` próprio mantém o nome e os args na chamada e em operacoes', async () => {
  const eventos = [];
  const cap = {
    id: 'navegador',
    descricao: 'Controla o navegador.',
    tools: [{
      name: 'clicar',
      description: 'Clica num elemento do snapshot.',
      schema: z.object({ ref: z.string(), aba: z.string() }),
      handler: async () => ({ ok: true }),
    }],
  };
  const comComando = turnoDoExemplo({ tool: 'navegador__clicar', args: { ref: 'e10', aba: 'A1' }, chat: 'Clicando.' });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });
  const orq = criarOrquestrador({
    base: () => [], capacidades: [cap], protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTexto([comComando, fecha]), decorarTool: DECORAR_TOOL_NO_OP,
    aoChamada: (c) => eventos.push(c),
  });
  const { operacoes } = await orq.executarTurno(ENTRADA);

  assert.deepEqual(eventos.map(e => e.nome), ['navegador__clicar', 'navegador__clicar']);
  assert.deepEqual(eventos[0].args, { ref: 'e10', aba: 'A1' });
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].nome, 'navegador__clicar');
});

test('renderErrors sai do turno', async () => {
  const orq = montarComTool(capacidade([]));
  const { renderErrors } = await orq.executarTurno(ENTRADA);

  assert.ok(Array.isArray(renderErrors));
});

test('tool que FALHA vira operação com ok:false e mantém a correlação', async () => {
  const eventos = [];
  const orq = montarComTool(capacidadeFalha(), { aoChamada: (c) => eventos.push(`${c.fase}:${c.id}`) });
  const { resultado, operacoes } = await orq.executarTurno(ENTRADA);

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].ok, false);
  assert.ok(operacoes[0].erro, 'a mensagem de erro não chegou em operacoes');
  assert.deepEqual(eventos, ['inicio:c1', 'fim:c1']);
});

/**
 * I4 (review de Fase 3): a fábrica cria o `InMemoryRunStore` internamente e,
 * antes desta correção, não devolvia nem ele nem o `runId` — o consumidor não
 * tinha como recuperar o histórico de MENSAGENS do genos (`tool_result`
 * incluído), que é o que a verificação de efeito de uma tool ou um behavior de
 * tracing precisam. É OUTRA COISA do `historico` devolvido pelo turno (esse é
 * do prompt-builder: texto cru do usuário + bloco de operações).
 */
test('runId e runStore saem do turno, e runStore.load(runId) devolve um snapshot com mensagens', async () => {
  const orq = montarComTool(capacidade([]));
  const { runId, runStore } = await orq.executarTurno(ENTRADA);

  assert.ok(typeof runId === 'string' && runId.length > 0, 'runId não saiu do turno');
  assert.ok(runStore, 'runStore não saiu do turno');

  const snapshot = await runStore.load(runId);
  assert.ok(snapshot, 'runStore.load(runId) não encontrou o run deste turno');
  assert.ok(Array.isArray(snapshot.history) && snapshot.history.length > 0, 'o snapshot não trouxe mensagens');
});

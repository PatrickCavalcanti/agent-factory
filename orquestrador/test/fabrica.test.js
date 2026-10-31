import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * BUG ENCONTRADO E CORRIGIDO (review de Fase 3, correção C2):
 * `executarTurno` sem `entrada.estado` caía no default `{ system: systemVazio(),
 * turno: 0 }`, que NÃO tinha a chave `kairos`. Esse `undefined` virava `state`
 * no `manager.discover()` do kairos, que o desreferencia sem checar
 * (`state.recentUse` dentro do objeto passado a `rankProviders`) — qualquer
 * texto NÃO trivial (>=4 chars, não só stopword) no primeiro turno crashava com
 * "Cannot read properties of undefined (reading 'recentUse')". Os testes com
 * texto trivial ('x') não pegavam isso porque `isTrivial()` retorna cedo, antes
 * do dereference. O default de `estado` agora inclui `kairos: initialSessionState()`
 * (`@okds/kairos/session`) — `ESTADO_KAIROS_VAZIO` aqui só documenta a MESMA
 * forma, para deixar o fixture explícito e legível.
 */
const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };

/**
 * BUG ENCONTRADO E CORRIGIDO (review de Fase 3, correção C1 — era MAIS GRAVE
 * que o de cima):
 * `const IDENTIDADE = (x) => x;` em `src/index.js` era o default de
 * `config.decorarTool`, mas `registryDoTurno` chama SEMPRE com dois
 * argumentos — `decorar(nome, comCtx)`. `IDENTIDADE` devolvia só o PRIMEIRO
 * argumento (`nome`, uma STRING), descartando `comCtx`/`definicao` inteiros.
 * Resultado: `registry.register(nome, decorar(nome, comCtx))` virava
 * `registry.register(nome, nome)` — toda tool (as 3 meta-tools do kairos MAIS
 * `agenda__listar`) era registrada no genos com a própria STRING do nome como
 * "definição", sem `argsSchema`/`handler`/`description`. `config.tools.
 * toJsonSchemas()` (chamado a cada iteração do loop, antes de qualquer
 * `generate()`) tentava descrever esse "schema" inexistente e crashava em
 * `unwrapSchema`: "Cannot read properties of undefined (reading '_def')".
 *
 * Isso quebrava o caminho DEFAULT inteiro (`criarOrquestrador` sem
 * `decorarTool`) — não era caso de borda. Corrigido: `IDENTIDADE` agora é
 * `(_nome, definicao) => definicao`. `DECORAR_TOOL_NO_OP` aqui é redundante com
 * o novo default, mas fica explícito no fixture de propósito.
 */
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

/**
 * Monta um turno a partir do EXEMPLO CANÔNICO que a própria estratégia ensina,
 * em vez de escrever o envelope à mão.
 *
 * Por que isso importa: um fixture escrito à mão prova "o parser aceita este
 * objeto que eu escrevi", não "o parser aceita o que o prompt ensina" — e nada
 * liga os dois. A bateria de mutação da Fase 2 mediu isso: apagar o texto
 * invariante inteiro deixava a suíte verde.
 */
function turnoDoExemplo({ tool, args, chat }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  // O texto do INVARIANTE também MENCIONA a forma (`{"blocos": [...]}`, com
  // espaço e reticências, na explicação em prosa) antes de mostrar o EXEMPLO
  // real — `.*\}` genérico casa com a menção primeiro. `"comandos"` só existe
  // no exemplo de verdade, então ancora nele.
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

test('a fábrica monta o prompt, roda o loop e executa a tool pelo nome exposto', async () => {
  const chamadas = [];
  const comComando = turnoDoExemplo({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Nada hoje.', comandos: [] }] });

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade(chamadas)],
    protocolo: 'envelope',
    protocoloOpts: { headless: true, prefixoDoEnvelope: 'igris' },
    provider: providerDeTexto([comComando, fecha]),
    // ver "BUG ENCONTRADO #2" no topo do arquivo: sem isto, o default
    // `IDENTIDADE` corrompe toda tool registrada no genos.
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, payload, schema } = await orq.executarTurno({
    texto: 'o que tenho hoje?',
    // ver comentário no topo do arquivo: contorna o `kairos` ausente do
    // default de `estado` para textos não triviais.
    estado: { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO },
  });

  assert.equal(resultado.type, 'completed');
  assert.deepEqual(chamadas, [{ dia: 'hoje' }]);
  // o prefixo da config chega ao schema entregue ao turno (e ao provider)
  assert.equal(schema.name, 'igris_envelope_headless');
  // I1: afirmar a PRESENÇA antes de comparar a ordem — `indexOf('<protocolo>')`
  // devolve -1 se a tag não estiver lá, e `-1 < n` é verdadeiro para qualquer
  // n >= 0. Sem isto, apagar a seção de protocolo inteira deixava a suíte verde.
  assert.ok(payload.system.includes('<protocolo>'), 'a seção de protocolo não entrou no system');
  assert.ok(payload.system.includes('<identidade>'), 'a seção de identidade não entrou no system');
  // O protocolo entra ANTES da identidade — é a parte mais estável do prefixo.
  assert.ok(payload.system.indexOf('<protocolo>') < payload.system.indexOf('<identidade>'));
  // O bloco de funções anuncia o nome exposto.
  assert.ok(payload.system.includes('agenda__listar'));
  // Capacidade piso = tools pinned = o CONTRATO hidrata já no primeiro turno.
  assert.ok(payload.system.includes('Args:'), 'o contrato pinned não hidratou');
  // O2 (guarda antiga) verificava a LINHA DE ÍNDICE crua (`tool.indexLine`)
  // sobrevivendo no system, distinta do contrato — para pegar `linhasDeIndice`
  // devolvendo `[]` em silêncio (o manual ainda entraria pela rota de
  // fallback do prompt-builder, só que rotulado com o nome exposto em vez da
  // indexLine). A Mudança 2 (2026-09-18) tornou essa asserção IMPOSSÍVEL de
  // reescrever aqui: uma função com manual carregado agora só aparece no
  // grupo "disponíveis" (o manual, ver `renderizarCapacidade`) — o texto da
  // indexLine nunca é impresso para uma função hidratada, em desenho nenhum,
  // porque mostrar as duas era exatamente a duplicação que a mudança elimina.
  // O guard equivalente (nome exposto sobrevivendo mesmo que `linhasDeIndice`
  // quebre) está coberto por `card-com-funcoes.test.js` — lá a função fica
  // CARREGÁVEL (sem manual), e é só nesse grupo que `f.indice`/a indexLine
  // aparecem no prompt.
});

/**
 * C1+C2 (review de Fase 3): o caminho REALMENTE default — sem `decorarTool` E
 * sem `estado` — nunca era exercitado por nenhum teste desta suíte; todos os
 * outros contornam um dos dois (ou os dois) explicitamente. Texto NÃO trivial
 * é essencial aqui: com texto trivial ('x'), `isTrivial()` do kairos retorna
 * antes de desreferenciar `state.recentUse`, e o default de `estado` sem
 * `kairos` (a mutação #2 da bateria) passaria despercebido.
 */
test('caminho DEFAULT completo (sem decorarTool, sem estado, texto não-trivial) não crasha', async () => {
  const fecha = JSON.stringify({ blocos: [{ chat: 'Nada hoje.', comandos: [] }] });
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([fecha]),
    // SEM decorarTool, DE PROPÓSITO — é o default `IDENTIDADE` que este teste exercita.
  });

  // SEM `estado`, DE PROPÓSITO — é o default `initialSessionState()` que este teste exercita.
  const { resultado, estado } = await orq.executarTurno({ texto: 'o que tenho hoje de compromissos?' });

  assert.equal(resultado.type, 'completed');
  assert.equal(estado.turno, 1);
});

test('o ctx do turno chega ao handler da tool exposta (enxerto de registryDoTurno)', async () => {
  let ctxRecebido;
  const capacidadeComCtx = {
    id: 'agenda',
    descricao: 'Consulta a agenda do usuário.',
    tools: [{
      name: 'listar',
      description: 'Lista eventos de um dia.',
      schema: z.object({ dia: z.string() }),
      handler: async (args, ctx) => { ctxRecebido = ctx; return { eventos: [] }; },
    }],
  };
  const comComando = turnoDoExemplo({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidadeComCtx],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([comComando, fecha]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  await orq.executarTurno({
    texto: 'o que tenho hoje?',
    ctx: { marcador: 'veio-do-turno' },
    estado: { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO },
  });

  assert.ok(ctxRecebido, 'o handler da tool nunca rodou');
  assert.equal(ctxRecebido.marcador, 'veio-do-turno', 'o ctx do turno não chegou ao handler — o enxerto quebrou');
});

test('responseSchema e promptCacheKey (por conversaId) viajam no metadata do provider', async () => {
  const metadatasVistos = [];
  const fecha = JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] });
  const providerQueRegistraMetadata = () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate(request) {
      metadatasVistos.push(request.metadata);
      return { text: fecha, stopReason: 'completed' };
    },
  });

  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    provider: providerQueRegistraMetadata,
  });

  await orq.executarTurno({ texto: 'x', ctx: { conversaId: 'conversa-42' } });

  assert.equal(metadatasVistos.length, 1);
  assert.equal(
    metadatasVistos[0].promptCacheKey, 'conversa-42',
    'promptCacheKey ignorou ctx.conversaId — caiu no runId, que muda a cada turno',
  );
  assert.ok(metadatasVistos[0].responseSchema, 'responseSchema não chegou no metadata do provider');
});

test('validateTurn do host pode pedir reemissão de uma resposta fora do envelope', async () => {
  const respostaValida = JSON.stringify({ blocos: [{ chat: 'Corrigido.', comandos: [] }] });
  const validacoes = [];
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    outputMode: 'streaming',
    provider: providerDeTexto(['texto fora do envelope', respostaValida]),
    validateTurn: ({ assistantText, iteration }) => {
      validacoes.push({ assistantText, iteration });
      return assistantText === 'texto fora do envelope'
        ? { retry: true, message: 'Reemita o envelope completo.' }
        : { retry: false };
    },
  });

  const { resultado } = await orq.executarTurno({
    texto: 'responda',
    estado: { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO },
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(validacoes.length, 2, `validateTurn deveria receber a resposta inválida e a reemissão: ${JSON.stringify(validacoes)}`);
  assert.equal(validacoes[0].assistantText, 'texto fora do envelope');
  assert.ok(validacoes[1].iteration > validacoes[0].iteration, 'a validação seguinte deve ser de uma nova iteração');
});

test('capacidade semântica sem embedder lança com mensagem acionável', async () => {
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [{ ...capacidade([]), piso: false }],
    protocolo: 'envelope',
    provider: providerDeTexto(['{}']),
  });
  await assert.rejects(() => orq.executarTurno({ texto: 'x' }), /nenhum embedder/);
});

test('decorarTool embrulha toda tool entregue ao genos', async () => {
  const vistas = [];
  const fecha = JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] });
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    provider: providerDeTexto([fecha]),
    decorarTool: (nome, definicao) => { vistas.push(nome); return definicao; },
  });
  await orq.executarTurno({ texto: 'x' });
  assert.ok(vistas.includes('call_capability'), `decorarTool não viu as meta-tools: ${vistas.join(', ')}`);
  assert.ok(vistas.includes('agenda__listar'), `decorarTool não viu as tools expostas: ${vistas.join(', ')}`);
});

/**
 * C4 (review de Fase 3): nenhum teste desta suíte, antes desta correção, rodava
 * um SEGUNDO turno passando `estado`/`historico` de volta — é a causa raiz de
 * C3 (o bridge produzia um `estado.kairos` novo a cada turno e a fábrica o
 * jogava fora, devolvendo sempre `estadoAnterior.kairos`) ter passado
 * despercebido, e de uma mutação que mata `acumular` inteiro (`anterior:
 * systemVazio()` sempre) sair verde.
 */
test('dois turnos: o prefixo do system sobrevive, o turno avança, e o estado do kairos FECHA (não é o do turno anterior)', async () => {
  const chamadas = [];
  const comComando = turnoDoExemplo({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' });
  const fechaTurno1 = JSON.stringify({ blocos: [{ chat: 'Nada hoje.', comandos: [] }] });
  const fechaTurno2 = JSON.stringify({ blocos: [{ chat: 'Também nada amanhã.', comandos: [] }] });

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade(chamadas)],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([comComando, fechaTurno1, fechaTurno2]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const t1 = await orq.executarTurno({
    texto: 'o que tenho hoje?',
    estado: { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO },
  });
  assert.equal(t1.estado.turno, 1, 'o turno 1 devolvido deveria avançar para 1');

  // O turno 2 recebe o `estado` E o `historico` que o turno 1 devolveu — é
  // assim que um chamador real encadeia turnos.
  const t2 = await orq.executarTurno({
    texto: 'e amanhã, tenho algo marcado?',
    estado: t1.estado,
    historico: t1.historico,
  });
  assert.equal(t2.estado.turno, 2, 'o turno 2 devolvido deveria avançar para 2');

  // (c) — a prova direta de C3: o `estado.kairos` do turno 2 não pode ser nem
  // o MESMO OBJETO nem ter o MESMO CONTEÚDO do turno 1. `agenda` é piso
  // (`loading.always`), então ela aparece em `providers.load` nos dois turnos
  // e `applySessionPolicy` atualiza `recentUse`/`lastUsedTurn` para o turno
  // corrente — se a fábrica devolvesse `estadoAnterior.kairos` (o bug), os
  // dois seriam idênticos byte a byte.
  assert.notStrictEqual(t2.estado.kairos, t1.estado.kairos, 'estado.kairos é a MESMA referência entre os dois turnos');
  assert.notDeepEqual(t2.estado.kairos, t1.estado.kairos, 'estado.kairos tem o MESMO CONTEÚDO entre os dois turnos — recentUse não avançou');

  // (a) — o prefixo do turno 1 sobrevive por inteiro no turno 2 (mesma
  // comparação de prefixo comum que `prefixo.test.js` já usa — `startsWith`
  // exigiria B ser mais longo que A, o que nem sempre é o caso).
  const a = t1.payload.system;
  const b = t2.payload.system;
  let comum = 0;
  while (comum < a.length && comum < b.length && a[comum] === b[comum]) comum += 1;
  assert.equal(comum, a.length, 'o prefixo do system do turno 1 não sobreviveu por inteiro no turno 2');
});

/**
 * Fecha a mutação `acumular` recebendo `systemVazio()` em vez de
 * `estadoAnterior.system`, de um jeito que NÃO depende de a capacidade ser
 * piso: a capacidade `agenda([])` deste arquivo é `piso` (pinned) e re-hidrata
 * em TODO turno (`resolve/hydrate.ts:116` — pinned ignora score), então o
 * teste de dois turnos acima reconstrói o mesmo conteúdo do zero mesmo com a
 * mutação aplicada, e não a pega.
 *
 * Este teste INJETA uma capacidade "fantasma" (manual já congelado) dentro de
 * `estado.system`, que o registry desta fábrica NUNCA registrou e que o
 * discover deste turno não tem como reconstruir. `acumular` não toca o
 * registry — ela só soma `input.anterior` ao que o discover trouxe agora — e
 * a renderização (`secoesDoSystem`) também é pura síntese de texto a partir do
 * `SystemAcumulado`. Se a fábrica de fato repassa `estadoAnterior.system`
 * como `anterior`, o manual fantasma sobrevive no prompt; se ela troca por
 * `systemVazio()`, ele desaparece sem deixar rastro.
 */
/**
 * Correção 1 (Fase 4, paridade): antes desta correção, `saida.texto` era o
 * envelope JSON cru (`'{"blocos":[{"chat":"feito","comandos":[]}]}'`), não a
 * prosa `"feito"` que o modelo escreveu para o leitor — quebrava o
 * `shadows.output-validator` (behavior default, contra schema `output`) e o
 * compositor do power `redator`, que documenta "a resposta do modelo É o
 * texto final do run (result.value)".
 */
test('saida.texto é o texto desembrulhado do envelope, não o JSON cru', async () => {
  const fecha = JSON.stringify({ blocos: [{ chat: 'feito', comandos: [] }] });
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([fecha]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { texto } = await orq.executarTurno({ texto: 'o que tenho hoje?' });

  assert.equal(texto, 'feito', 'saida.texto deveria ser a prosa, não o envelope inteiro');
});

test('o system anterior (estado.system) é repassado a `acumular`, não descartado', async () => {
  const fecha = JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] });
  const sistemaComFantasma = {
    capacidades: [{
      id: 'fantasma',
      descricao: 'Capacidade fantasma — nunca registrada nesta fábrica.',
      funcoes: [{
        ref: 'fantasma/tool/x', nome: 'fantasma_x',
        indice: 'x — indice fantasma', manual: 'MANUAL_FANTASMA_CONGELADO',
      }],
    }],
    fixas: [], estaveis: [], dinamicas: [],
  };

  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [capacidade([])],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([fecha]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { payload } = await orq.executarTurno({
    texto: 'o que tenho hoje de compromissos?',
    estado: { system: sistemaComFantasma, turno: 3, kairos: ESTADO_KAIROS_VAZIO },
  });

  assert.ok(
    payload.system.includes('MANUAL_FANTASMA_CONGELADO'),
    '`acumular` não recebeu o `estado.system` anterior — o conteúdo congelado foi perdido',
  );
});

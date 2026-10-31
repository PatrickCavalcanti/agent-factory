import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

// embedderFalso(): copiado de test/refino.test.js (mesmo corpo de `embedderVetorial`, sem o
// array de chamadas — este arquivo não precisa inspecionar quantos embeds rodaram).
function embedderFalso() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('ENRIQUECIDO')) return [0, 1];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_TAREFAS')) return [0, 1];
      return [0, 0];
    },
  };
}

function providerQueGuarda(requests) {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
    async generate(request) {
      requests.push(request);
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

// Provider com SCRIPT de respostas (copiado de guarda-manual.test.js) — precisa devolver o
// envelope que chama a função direto, para provar que o handler REAL roda (não a recusa
// `manual_nao_carregado`), e também guarda os `requests` (como `providerQueGuarda` acima) para
// inspecionar o prompt enviado.
function providerDeTextoQueGuarda(textos, requests) {
  let i = 0;
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
    async generate(request) {
      requests.push(request);
      const t = textos[Math.min(i, textos.length - 1)];
      i += 1;
      return { text: t, stopReason: 'completed' };
    },
  });
}

// Copiada de guarda-manual.test.js: monta um turno chamando `tool` a partir do EXEMPLO CANÔNICO
// que a própria estratégia ensina.
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

const FECHA_ENVELOPE = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

function montar({ rodar, requests, chamadas }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      // I2 (revisão de qualidade da Fase 3): `piso: false` de propósito — o espaço do loop agora
      // vem do que o anel `provider` classificou `full` NESTE turno (`explain`), não mais de
      // `providers.load` + pisos. Um `piso: true` nunca aparece em `explain` (não é ranqueado —
      // já está sempre carregado), então precisa ser ranqueado de verdade: `semanticText` com o
      // marcador `DOC_SEMANTICO_CALENDAR` bate com o `PERGUNTA_DO_USUARIO_MARCADOR` da pergunta
      // via `embedderFalso` abaixo (mesmo par usado em `test/refino.test.js`).
      id: 'agenda', descricao: 'Agenda e compromissos.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda compromissos amanhã',
      tools: [
        { name: 'listar_eventos', description: 'Lista eventos.', effect: 'read', inputSchema: { type: 'object', properties: { periodo: { type: 'string', enum: ['hoje', 'amanha'] } } }, schema: z.object({}).passthrough(), handler: async (args) => ({ eventos: [`reunião ${args.periodo}`] }) },
        { name: 'criar_evento', description: 'Cria evento.', effect: 'write', schema: z.object({}).passthrough(), handler: async () => ({}) },
      ],
    }],
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerQueGuarda(requests),
    decorarTool: (nome, definicao) => definicao,
    aoChamada: (c) => chamadas.push(c),
    loop: { rodar, paramsDe: () => [{ nome: 'periodo', obrigatoria: false, opcoes: [{ valor: 'hoje' }, { valor: 'amanha' }] }], corteHistorico: 0.7 },
  });
}

test('o loop executa a leitura, semeia o histórico, avisa pelos chips e devolve o resumo', async () => {
  const requests = [];
  const chamadas = [];
  let espacoVisto = null;
  const rodar = async ({ espaco, executar }) => {
    espacoVisto = espaco;
    const fn = espaco.funcoes[0];
    const resultado = await executar(fn, { periodo: 'amanha' });
    return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: { periodo: 'amanha' }, confianca: 0.9, resultado, ms: 1 }], carregadas: [], passos: [{ passo: 1, acao: fn.nome, confianca: 0.9, ms: 2 }], ms: 5 };
  };
  const orq = montar({ rodar, requests, chamadas });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR o que tenho na agenda amanhã?' });
    assert.deepEqual(espacoVisto.funcoes.map((f) => f.nome), ['listar_eventos']);
    const msgs = requests[0].messages;
    const semeada = msgs.find((m) => m.role === 'tool_result' && m.toolName === 'listar_eventos');
    assert.ok(semeada, 'tool_result semeado no histórico');
    assert.ok(semeada.content.includes('reunião amanha'));
    // Correção A: o bloco `<pre_hidratacao>` continua dentro da mensagem `usr` (o pedido deste
    // turno) — só o par assistant/tool_result semeado passou a vir DEPOIS dela, então `usr` não é
    // mais necessariamente a ÚLTIMA mensagem (ver teste "A:" mais abaixo).
    const pedido = msgs.find((m) => m.role === 'user' && m.content.includes('<pre_hidratacao>'));
    assert.ok(pedido, 'a mensagem do usuário com o bloco pre_hidratacao tem que estar presente');
    const doJev = chamadas.filter((c) => c.origem === 'jev');
    assert.deepEqual(doJev.map((c) => c.fase), ['inicio', 'fim']);
    // D-1 (10/10): o `fim` leva o RETORNO da leitura — o host o grava no registro completo (o Jev não passa pela captura).
    assert.deepEqual(doJev[1].resultado, { eventos: ['reunião amanha'] });
    assert.equal(saida.loop.estado, 'pronto');
    assert.deepEqual(saida.loop.destinos, { historico: 1, bloco: 0, erro: 0 });
    assert.ok(saida.operacoes.some((o) => o.nome === 'listar_eventos' && o.origem === 'jev'));
  } finally {
    await orq.fechar();
  }
});

// C1 (revisão de qualidade da Fase 3): no Igris o `ctx` do turno é uma instância de
// `EventEmitter` (`executor.js`) — `emit` vive no PROTÓTIPO, não como propriedade própria.
// `{ ...ctx }` sozinho perde `emit`, e um handler de tool de power (`criarHandlerDePower`)
// chama `toolCtx.emit(...)` incondicionalmente: sem a correção, a chamada REJEITA com
// `toolCtx.emit is not a function`.
test('C1: ctx do turno é EventEmitter — o loop chama o handler com um toolCtx que tem emit/finish/loadSection', async () => {
  const requests = [];
  const chamadas = [];
  class CtxDoTurno extends EventEmitter {}
  const ctxDoTurno = new CtxDoTurno();
  assert.equal(({ ...ctxDoTurno }).emit, undefined, 'pré-condição: spread de um EventEmitter não carrega emit');
  let toolCtxVisto = null;
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes[0];
    const resultado = await executar(fn, {});
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      // I2: `piso: false` — ver comentário em `montar()` acima. `DOC_SEMANTICO_CALENDAR` no
      // `semanticText` bate com o `PERGUNTA_DO_USUARIO_MARCADOR` da pergunta abaixo.
      id: 'tarefas', descricao: 'Tarefas.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR tarefas',
      tools: [{
        name: 'task_listar', description: 'Lista tarefas.', effect: 'read',
        inputSchema: { type: 'object', properties: {} }, schema: z.object({}).passthrough(),
        handler: async (args, toolCtx) => {
          toolCtxVisto = toolCtx;
          // Dispara o TypeError sem a correção (`toolCtx.emit is not a function`), exatamente
          // como `criarHandlerDePower` faz de verdade (`emitToolResult`, powerBundles.js).
          toolCtx.emit('result', { content: 'ok' });
          return { tarefas: ['a'] };
        },
      }],
    }],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerQueGuarda(requests), decorarTool: (n, d) => d,
    aoChamada: (c) => chamadas.push(c),
    loop: { rodar, paramsDe: () => [], corteHistorico: 0.7 },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR quais são minhas tarefas?', ctx: ctxDoTurno });
    assert.equal(saida.loop.estado, 'pronto');
    assert.equal(saida.loop.rastro[0]?.erro, undefined, 'sem a correção o handler rejeita e o passo entra no rastro com erro');
    assert.equal(typeof toolCtxVisto?.emit, 'function');
    assert.equal(typeof toolCtxVisto?.finish, 'function');
    assert.equal(typeof toolCtxVisto?.loadSection, 'function');
    const msgs = requests[0].messages;
    const semeada = msgs.find((m) => m.role === 'tool_result' && m.toolName === 'task_listar');
    assert.ok(semeada, 'tool_result semeado no histórico');
  } finally {
    await orq.fechar();
  }
});

// N1 (correção fluxo de bug, spec 2026-09-22 §6): `usadas` (index.js, bloco do loop) comparava o
// NOME EXPOSTO da função (`r.fn`, ex. `listar_eventos`) contra `refsJaHidratadas`, que guarda REFS
// completas (`agenda/tool/listar_eventos`) — nunca batia, e toda função usada pelo loop, mesmo já
// hidratada (pinned), pagava uma promoção (e o `discover` extra que ela custa) à toa. Os dois
// testes abaixo isolam o efeito com um `refinadores.provider` que só CONTA chamadas ao
// `discover()` do kairos, devolvendo a proposta do motor sem mudar nada (mesmo padrão da prova do
// revisor em E:\tmp\revisao-fase3\prova-correcoes.mjs).
function montarComContadorDeDiscovers({ rodar, requests = [] }) {
  let discovers = 0;
  const refinadores = {
    provider: (input) => { discovers += 1; return { full: input.proposal.full, candidates: input.proposal.candidates }; },
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [{
      id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda',
      tools: [
        // fixa: true => pinned => hidratada assim que o provider carrega (no 1o discover), sem
        // depender do ranking individual da tool.
        {
          name: 'listar_eventos', description: 'Lista.', effect: 'read', fixa: true,
          schema: z.object({}).passthrough(), handler: async () => ({ ok: true, eventos: [1] }),
        },
        // sem `fixa` (herda `piso: false` da capacidade) => NÃO pinned => só hidrata se o ranking
        // do anel `tool` trouxer ela individualmente — não é o caso aqui (embedder não casa nada
        // com o texto desta tool).
        {
          name: 'ver_evento', description: 'Vê.', effect: 'read',
          schema: z.object({}).passthrough(), handler: async () => ({ ok: true, evento: 1 }),
        },
      ],
    }],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerQueGuarda(requests), decorarTool: (n, d) => d, refinadores,
    loop: { rodar, paramsDe: () => [] },
  });
  return { orq, contador: () => discovers };
}

test('N1: função já hidratada (pinned) usada pelo loop não paga um segundo discover', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'listar_eventos');
    const resultado = await executar(fn, {});
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const { orq, contador } = montarComContadorDeDiscovers({ rodar });
  try {
    await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal(contador(), 1, 'já hidratada: nenhuma promoção extra, só o discover inicial do turno');
  } finally {
    await orq.fechar();
  }
});

// A parte "sai hidratada" do critério original foi verificada à mão (E:\tmp\debug-n1.mjs) e NÃO
// se sustenta na versão instalada do kairos: `comCarregadasNoTurno`/`applySessionPolicy` marcam a
// ref pedida em `discoverAumentado.tools.hydrate` (entra em `state.hydratedTools`), mas o discover
// FRESCO que `bridge.prepareTurn` roda em cima desse estado recalcula `tools.hydrate` pela
// RANKING de verdade — uma tool sem `fixa`/`pinned` e sem casar o embedder (nosso `ver_evento` não
// tem `semanticText` próprio) não entra em `hydrate`, nem neste turno nem no seguinte (medido: 2
// turnos seguidos, sempre sem `ver_evento` em `hydrate`, sempre pagando novo discover). Isso é
// comportamento do MOTOR de promoção (`promoverNoTurno`/kairos), preexistente a N1 — N1 só
// corrige a COMPARAÇÃO de refs que decide SE a promoção é pedida, não o que o kairos faz com o
// pedido depois. O sinal correto e estável de que a correção funcionou é o PRÓPRIO disparo da
// promoção (discovers 1→2) sem falha — é o que este teste verifica.
test('N1: função ainda não hidratada usada pelo loop dispara a promoção (2o discover)', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'ver_evento');
    const resultado = await executar(fn, {});
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const { orq, contador } = montarComContadorDeDiscovers({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal(contador(), 2, 'não hidratada: a promoção roda um segundo discover');
    assert.equal(saida.loop.estado, 'pronto');
    assert.equal(saida.loop.rastro[0]?.erro, undefined, 'a chamada da função pelo loop não falhou');
    assert.deepEqual(saida.renderErrors, [], 'a promoção não deixou erro de render');
  } finally {
    await orq.fechar();
  }
});

// Correção (revisão do conjunto, 7fe31cb7, 24/09, `@igris/decisions/loop`): quando o motor
// devolve `paraOModelo` (a função que o Jev escolheu mas não pôde preencher — obrigatório sem
// opção, ou com opção mas sem resposta válida), o MODELO precisa poder chamá-la ele mesmo neste
// turno. A PRIMEIRA versão desta correção (9edeea6b) só disparava um 2o discover
// (`promoverNoTurno`) — que RECALCULA `tools.hydrate` pelo ranking de verdade e nunca hidrata uma
// função sem `fixa`/pinned (mesmo comportamento documentado no teste "N1: função ainda não
// hidratada..." acima) — então a tool nunca ganhava manual de verdade, só pagava o discover à toa
// (prova do revisor: `E:\tmp\rev-7fe31cb7\prova-manual.mjs`, a chamada direta do modelo voltava
// `manual_nao_carregado`). A correção usa o MESMO caminho de `contratosDoLoop` que já hidrata
// função usada com sucesso pelo loop (teste "B" acima) — as asserções abaixo são as mesmas de "B":
// `<function name="…">` nas seções do prompt, chamada direta sem `manual_nao_carregado`, e (a
// diferença específica de `paraOModelo`) SEM pagar o 2o discover, já que não há promoção via
// `bridge.prepareTurn` para uma função que não executou nada.
test('correção 7fe31cb7 (revisão do conjunto): paraOModelo hidrata o manual no prompt e a chamada direta do modelo executa — sem promoção extra', async () => {
  const requests = [];
  const chamadasReais = [];
  let discovers = 0;
  const refinadores = {
    provider: (input) => { discovers += 1; return { full: input.proposal.full, candidates: input.proposal.candidates }; },
  };
  const rodar = async ({ espaco }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'ver_evento');
    return {
      estado: 'pronto',
      motivo: 'função escolhida precisa de argumento que só o modelo preenche: ver_evento',
      paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }],
      rastro: [], carregadas: [], passos: [], ms: 1,
    };
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [{
      id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda',
      tools: [
        // fixa: true => pinned => hidrata sempre — não é o caso testado aqui.
        {
          name: 'listar_eventos', description: 'Lista.', effect: 'read', fixa: true,
          schema: z.object({}).passthrough(), handler: async () => ({ ok: true, eventos: [1] }),
        },
        // sem `fixa` => só hidrata se o ranking trouxer ela — não é o caso (embedder não casa
        // nada com o texto desta tool): é a pré-condição do bug, mesma forma do teste "B" acima.
        {
          name: 'ver_evento', description: 'Vê um evento específico.', effect: 'read',
          schema: z.object({}).passthrough(),
          handler: async (args) => { chamadasReais.push(args); return { ok: true, evento: 1 }; },
        },
      ],
    }],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTextoQueGuarda([
      turnoChamando({ tool: 'ver_evento', args: {}, chat: 'Vendo.' }),
      FECHA_ENVELOPE,
    ], requests),
    decorarTool: (n, d) => d, refinadores,
    loop: { rodar, paramsDe: () => [] },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal(saida.loop.estado, 'pronto');
    assert.deepEqual(saida.loop.rastro, [], 'nada foi executado pelo loop');
    assert.deepEqual(saida.loop.paraOModelo, [{ nome: 'ver_evento', capacidade: 'agenda' }], 'o artefato do turno registra a função para o Tracer');

    // Pré-condição do bug: sem a correção, o discover cru não hidrata ver_evento.
    const refsHidratadas = saida.discover.tools?.hydrate ?? [];
    assert.ok(!refsHidratadas.includes('agenda/tool/ver_evento'), 'pré-condição: o discover cru não hidrata ver_evento (não é pinned, não ranqueou)');

    // A correção: o manual de ver_evento (não só a linha de índice) tem que estar no PROMPT.
    assert.ok(saida.payload.secoes.some((s) => s.conteudo.includes('<function name="ver_evento">')), 'o MANUAL de ver_evento tem que estar nas seções do prompt deste turno');

    // E a chamada direta do modelo tem que EXECUTAR — não recusar com manual_nao_carregado.
    const snapshot = await saida.runStore.load(saida.runId);
    const resultadoDaChamada = snapshot.history.find((m) => m.role === 'tool_result' && m.toolName === 'ver_evento');
    assert.ok(resultadoDaChamada, 'não achei o tool_result da chamada direta a ver_evento');
    assert.doesNotMatch(resultadoDaChamada.content, /manual_nao_carregado/, 'a chamada direta não pode ter caído na recusa de manual');
    assert.equal(chamadasReais.length, 1, 'o handler real roda na chamada direta do modelo — o loop não executou nada');

    // A diferença de `paraOModelo`: hidrata via `contratosDoLoop`, sem pagar o 2o discover que a
    // primeira versão da correção pagava à toa (`promoverNoTurno`, que nem chegava a hidratar).
    assert.equal(discovers, 1, 'paraOModelo não paga o 2o discover — só o discover inicial do turno');
    assert.deepEqual(saida.renderErrors, [], 'sem erro de render');
  } finally {
    await orq.fechar();
  }
});

test('correção 7fe31cb7: paraOModelo de função já hidratada (pinned) não paga promoção extra', async () => {
  const rodar = async ({ espaco }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'listar_eventos');
    return {
      estado: 'pronto', paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }], rastro: [], carregadas: [], passos: [], ms: 1,
    };
  };
  const { orq, contador } = montarComContadorDeDiscovers({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal(contador(), 1, 'já hidratada: paraOModelo não paga promoção extra');
    assert.deepEqual(saida.loop.paraOModelo, [{ nome: 'listar_eventos', capacidade: 'agenda' }]);
  } finally {
    await orq.fechar();
  }
});

test('sem paraOModelo (ausente), o artefato do turno não ganha a chave — compatibilidade com o formato de antes', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'listar_eventos');
    const resultado = await executar(fn, {});
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const { orq } = montarComContadorDeDiscovers({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal('paraOModelo' in saida.loop, false);
  } finally {
    await orq.fechar();
  }
});

// I-A (correção da revisão do conjunto, spec 2026-09-22 §6): o kairos monta `discover.providers.
// candidates` sem filtrar contra `providers.load` (`context-manager/discover.ts` ~l.1029) — uma
// capacidade que o loop acabou de `carregar_<cap>` neste MESMO turno pode continuar aparecendo
// como candidata no card (`suggested_capabilities`, legenda "carregue antes de chamar"), logo
// abaixo do `tool_result` que o próprio carregamento semeou. `tarefas` ranqueia só como
// `candidate` (nunca `full`) para a pergunta — `limiares.zCandidate: -1.01` força isso, mesmo
// arranjo da prova do revisor (`E:\tmp\revisao-conjunto\e2e-loop-3.mjs`, caso C) — então sem a
// correção o card dela sempre aparece, carregada ou não.
test('I-A: capacidade carregada pelo loop não aparece mais como candidata no prompt', async () => {
  const requests = [];
  const chamadas = [];
  const rodar = async ({ espaco, executar, carregar }) => {
    const funcoesDeTarefas = await carregar('tarefas');
    const fn = funcoesDeTarefas.find((f) => f.nome === 'task_listar');
    const resultado = await executar(fn, { lista: 'Contas a pagar' });
    return {
      estado: 'pronto',
      rastro: [{ passo: 2, fn: fn.nome, capacidade: fn.capacidade, args: { lista: 'Contas a pagar' }, confianca: 0.9, resultado, ms: 1 }],
      carregadas: ['tarefas'],
      passos: [
        { passo: 1, acao: 'carregar_tarefas', confianca: 0.9, ms: 2 },
        { passo: 2, acao: 'task_listar', confianca: 0.9, ms: 2 },
      ],
      ms: 5,
    };
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [
      {
        id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false, semanticText: 'DOC_AGENDA agenda',
        tools: [{
          name: 'listar_eventos', description: 'Lista eventos.', effect: 'read', fixa: true,
          schema: z.object({}).passthrough(), handler: async () => ({ ok: true, eventos: ['reuniao amanha'] }),
        }],
      },
      {
        id: 'tarefas', descricao: 'Tarefas.', piso: false, prefixarTools: false, semanticText: 'DOC_TAREFAS tarefas',
        tools: [{
          name: 'task_listar', description: 'Lista tarefas.', effect: 'read',
          inputSchema: { type: 'object', properties: { lista: { type: 'string' } } },
          schema: z.object({}).passthrough(), handler: async (a) => ({ ok: true, tarefas: [a.lista] }),
        }],
      },
    ],
    // Mesmo par de vetores da prova do revisor: `tarefas` fica sempre abaixo do corte de `full`
    // (cosseno ~0.9x1 + 0.4359x0 ≈ 0.9 < zFull não importa — o que importa é `zCandidate: -1.01`
    // forçar tudo acima do `rawFloor` a virar candidato, nunca `full`).
    embedder: {
      modelSlug: 'fake',
      async embed(t) {
        if (t.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
        if (t.includes('DOC_AGENDA')) return [1, 0];
        if (t.includes('DOC_TAREFAS')) return [0.9, 0.4359];
        return [0, 0];
      },
    },
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 },
    provider: providerQueGuarda(requests),
    decorarTool: (n, d) => d,
    aoChamada: (c) => chamadas.push(c),
    loop: { rodar, paramsDe: () => [{ nome: 'lista', obrigatoria: false, opcoes: [{ valor: 'Contas a pagar' }] }], corteHistorico: 0.7 },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR o que tenho amanha e contas a pagar?' });
    assert.equal(saida.loop.estado, 'pronto');
    assert.deepEqual(saida.loop.carregadas, ['tarefas']);
    // Pré-condição do bug: o discover FINAL deste turno já classificou `tarefas` como candidata
    // (o defeito é do kairos, `discover.ts` — não filtra `candidates` contra `providers.load`) —
    // sem essa pré-condição o teste provaria a correção errada (não haveria card para filtrar).
    const idsCandidatos = (saida.discover.providers?.candidates ?? []).map((c) => c.id);
    assert.ok(idsCandidatos.includes('tarefas'), 'pré-condição: kairos ainda propõe tarefas como candidata');
    assert.ok((saida.discover.providers?.load ?? []).includes('tarefas'), 'pré-condição: tarefas também está carregada neste turno');
    // A correção: apesar do discover cru ainda listar `tarefas` como candidata, o PROMPT enviado
    // ao provider não pode trazer o card dela — a capacidade já está carregada e usada neste turno.
    // Checa pela SEÇÃO (`suggested_capabilities`, `payload.secoes`), não por `<capability
    // name="tarefas">` cru: essa mesma tag/atributo também rotula `tarefas` na seção
    // `capabilities` (a capacidade JÁ CARREGADA, com funções) — legítima e esperada — então um
    // grep pela tag sozinha acertaria por engano tanto o caso corrigido quanto o com bug.
    assert.ok(!saida.payload.secoes.includes('suggested_capabilities'), `payload não deve ter seção suggested_capabilities quando a única candidata já está carregada (seções: ${saida.payload.secoes.join(', ')})`);
    const msgs = requests[0].messages;
    const secaoCandidatas = msgs
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
      .match(/<suggested_capabilities>[\s\S]*?<\/suggested_capabilities>/);
    assert.ok(!secaoCandidatas?.[0]?.includes('name="tarefas"'), 'request.messages não deve trazer o card de candidata de uma capacidade já carregada');
  } finally {
    await orq.fechar();
  }
});

test('sem config.loop o turno segue como antes', async () => {
  const requests = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [{ id: 'agenda', descricao: 'Agenda.', piso: true, tools: [{ name: 'listar_eventos', description: 'Lista.', effect: 'read', schema: z.object({}).passthrough(), handler: async () => ({}) }] }],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true }, provider: providerQueGuarda(requests), decorarTool: (n, d) => d,
  });
  try {
    const saida = await orq.executarTurno({ texto: 'o que tenho na agenda amanhã?' });
    assert.equal(saida.loop, null);
    assert.ok(!requests[0].messages.some((m) => m.role === 'tool_result'));
  } finally {
    await orq.fechar();
  }
});

// M2 (revisão de qualidade da Fase 3, index.js ~2067-2076): `config.loop.rodar` é código do
// HOST — uma falha aqui não pode derrubar o turno inteiro. O `catch` em volta da chamada troca
// a exceção por `saidaDoLoop = { estado: 'estourado', motivo: 'erro do loop: <mensagem>', ... }`
// e o turno segue até o fim (resposta do modelo incluída).
test('M2: config.loop.rodar que lança não derruba o turno — loop.estado vira "estourado"', async () => {
  const requests = [];
  const chamadas = [];
  const rodar = async () => { throw new Error('falha proposital do motor'); };
  const orq = montar({ rodar, requests, chamadas });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR o que tenho na agenda amanhã?' });
    assert.equal(saida.loop.estado, 'estourado');
    assert.match(saida.loop.motivo, /falha proposital do motor/);
    assert.ok(saida.texto, 'turno segue e devolve resposta do modelo');
  } finally {
    await orq.fechar();
  }
});

// M2 (revisão de qualidade da Fase 3, index.js ~2080-2082): um retorno que não é o objeto que
// `rodarLoop` documenta (sem `rastro` array, ou `undefined`) recebe a mesma proteção — o guard
// depois do `try/catch` troca por `saidaDoLoop = { estado: 'estourado', motivo: 'retorno
// inválido do loop', ... }`, sem derrubar o turno.
test('M2: config.loop.rodar que devolve undefined não derruba o turno — motivo cita retorno inválido', async () => {
  const requests = [];
  const chamadas = [];
  const rodar = async () => undefined;
  const orq = montar({ rodar, requests, chamadas });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR o que tenho na agenda amanhã?' });
    assert.equal(saida.loop.estado, 'estourado');
    assert.match(saida.loop.motivo, /retorno inválido/);
    assert.ok(saida.texto, 'turno segue e devolve resposta do modelo');
  } finally {
    await orq.fechar();
  }
});

// Correção A (fluxo de bug, sessões 54862f78/08cd7835, 22-09): as mensagens semeadas do loop
// (`entrega.historico`) entravam ANTES do `usr` — junto do histórico de turnos ANTERIORES
// (`index.js`, `historico: [...(entrada.historico || []), ...(entrega?.historico ?? [])]`,
// forma de antes desta correção). O modelo lia a chamada do Jev como se tivesse acontecido num
// turno passado e refazia a MESMA consulta com os MESMOS argumentos (medido: `gcal_listar_eventos
// {periodo:"amanha"}` 0,97 e `task_listar {...}` 0,80, ambos repetidos). A ordem certa — a que o
// genos produz quando o PRÓPRIO modelo chama uma função — é `user` (o pedido) seguido do
// `assistant`/`tool_result` que o registram como filho DESTE turno.
test('A: mensagens semeadas do loop vêm DEPOIS da pergunta do usuário, na ordem que o genos produziria', async () => {
  const requests = [];
  const chamadas = [];
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes[0];
    const resultado = await executar(fn, { periodo: 'amanha' });
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: { periodo: 'amanha' }, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 5,
    };
  };
  const orq = montar({ rodar, requests, chamadas });
  try {
    const historicoAnterior = [
      { id: 'u0', role: 'user', content: 'turno anterior' },
      { id: 'a0', role: 'assistant', content: 'ok' },
    ];
    await orq.executarTurno({
      texto: 'PERGUNTA_DO_USUARIO_MARCADOR o que tenho na agenda amanhã?',
      historico: historicoAnterior,
    });
    const msgs = requests[0].messages;
    const iHistoricoAnterior = msgs.findIndex((m) => m.content === 'turno anterior');
    const iPedido = msgs.findIndex((m) => typeof m.content === 'string' && m.content.includes('o que tenho na agenda amanhã?'));
    const iAssistantJev = msgs.findIndex((m) => m.role === 'assistant' && m.content.includes('listar_eventos'));
    const iToolResult = msgs.findIndex((m) => m.role === 'tool_result' && m.toolName === 'listar_eventos');
    assert.ok(iHistoricoAnterior >= 0, 'histórico do turno anterior tem que estar na mensagem');
    assert.ok(iPedido >= 0, 'o pedido deste turno tem que estar na mensagem');
    assert.ok(iAssistantJev >= 0, 'a mensagem assistant semeada do Jev tem que estar presente');
    assert.ok(iToolResult >= 0, 'o tool_result semeado do Jev tem que estar presente');
    assert.ok(iHistoricoAnterior < iPedido, 'histórico de turno ANTERIOR continua antes do pedido deste turno');
    assert.ok(iPedido < iAssistantJev, 'o pedido do usuário tem que vir ANTES da chamada semeada do Jev — não depois');
    assert.ok(iAssistantJev < iToolResult, 'o tool_result semeado vem logo depois do assistant semeado');
  } finally {
    await orq.fechar();
  }
});

// Correção B (fluxo de bug, spec 2026-09-22 §6.4, pendência "orchestrator/kairos (loop,
// IMPORTANTE)"): a spec diz que o modelo SEMPRE tem o contrato do que o Jev usou — mas isso só se
// sustentava para função `fixa`/pinned (hidrata sempre, fora do ranking). Uma função SEM `fixa`
// que o loop executou (ex.: `ver_evento`, análogo a `task_listas`/`gcal_ver_evento` na pendência)
// não ganhava manual: `comCarregadasNoTurno`/`applySessionPolicy` marcam a ref em
// `discoverAumentado.tools.hydrate` (`promoverNoTurno`), mas o discover FRESCO que
// `bridge.prepareTurn` roda em cima da `estadoAumentadoKairos` recalcula `tools.hydrate` pela
// RANKING de verdade (`hydrateProvider`, kairos `resolve/hydrate.ts`) — uma tool sem `fixa`/
// `pinned` que não casa o embedder não entra em `hydrate`, ponto final (mesmo comportamento já
// documentado no teste "N1: função ainda não hidratada..." acima, que só prova o disparo do 2o
// discover, não o efeito no prompt). Sem manual, `registryDoTurno` recusa a chamada direta do
// modelo com `manual_nao_carregado`, e ele gasta uma iteração chamando `load_capability` à toa.
test('B: função sem fixa usada pelo loop ganha o manual no prompt deste turno — a chamada direta do modelo executa', async () => {
  const requests = [];
  const chamadasReais = [];
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'ver_evento');
    const resultado = await executar(fn, {});
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [{
      id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR agenda',
      tools: [
        // fixa: true => pinned => hidrata sempre, independente do ranking — é o que já
        // funcionava ANTES desta correção (task_listar/gcal_listar_eventos na pendência).
        {
          name: 'listar_eventos', description: 'Lista eventos.', effect: 'read', fixa: true,
          schema: z.object({}).passthrough(), handler: async () => ({ ok: true, eventos: [1] }),
        },
        // sem `fixa` => só hidrata se o ranking do anel `tool` trouxer ela — não é o caso aqui
        // (embedder não casa nada com o texto desta tool). É a forma de `task_listas`/
        // `gcal_ver_evento` na pendência.
        {
          name: 'ver_evento', description: 'Vê um evento específico.', effect: 'read',
          schema: z.object({}).passthrough(),
          handler: async (args) => { chamadasReais.push(args); return { ok: true, evento: 1 }; },
        },
      ],
    }],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTextoQueGuarda([
      turnoChamando({ tool: 'ver_evento', args: {}, chat: 'Vendo.' }),
      FECHA_ENVELOPE,
    ], requests),
    decorarTool: (n, d) => d,
    loop: { rodar, paramsDe: () => [] },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã' });
    assert.equal(saida.loop.estado, 'pronto');
    assert.equal(saida.loop.rastro[0]?.erro, undefined, 'a chamada do loop a ver_evento não pode ter falhado');

    // Pré-condição do bug: sem a correção, o discover deste turno não hidrata `ver_evento` (só
    // pinned/ranking) — provada aqui para não deixar o teste provar a correção errada.
    const refsHidratadas = saida.discover.tools?.hydrate ?? [];
    assert.ok(!refsHidratadas.includes('agenda/tool/ver_evento'), 'pré-condição: o discover cru não hidrata ver_evento (não é pinned, não ranqueou)');

    // A correção: mesmo sem entrar em `tools.hydrate`, o contrato de `ver_evento` tem que estar
    // no PROMPT deste turno (spec §6.4: "o modelo sempre tem o contrato do que foi usado").
    // `<function name="ver_evento">` (com o MANUAL completo dentro) só aparece quando
    // `funcao.manual` está preenchido (`renderizarCapacidade`, prompt-builder.js) — uma função
    // SEM manual sai como linha solta ("- ver_evento — <descrição>"), então checar só pelo nome/
    // descrição (que também aparecem na linha de ÍNDICE) provaria a correção errada.
    assert.ok(saida.payload.secoes.some((s) => s.conteudo.includes('<function name="ver_evento">')), 'o MANUAL de ver_evento (não só o índice) tem que estar nas seções do prompt deste turno');

    // E a chamada direta do modelo (script do provider acima) tem que EXECUTAR — não recusar.
    const snapshot = await saida.runStore.load(saida.runId);
    const resultadoDaChamada = snapshot.history.find((m) => m.role === 'tool_result' && m.toolName === 'ver_evento');
    assert.ok(resultadoDaChamada, 'não achei o tool_result da chamada direta a ver_evento');
    assert.doesNotMatch(resultadoDaChamada.content, /manual_nao_carregado/, 'a chamada direta não pode ter caído na recusa de manual — o Jev já executou a função neste turno');
    // Duas chamadas reais: uma do loop (pré-hidratação), outra do modelo (chamada direta).
    assert.equal(chamadasReais.length, 2, 'o handler real roda tanto na chamada do loop quanto na chamada direta do modelo');
  } finally {
    await orq.fechar();
  }
});

// Bug do teste do dono (2026-10-02, sessão f695a531): exibir um arquivo custou DOIS `load_capability`
// (um para `arquivo_buscar`, outro para `arquivo_apresentar`). (B) o Jev escolheu `arquivo_buscar`, a
// execução FALHOU e o manual dela não entrou no prompt (`usadas` só contava sucesso). (C) a função de
// apresentar (`view.exibir: 'auto'`) do mesmo poder nunca vinha junto.
function capacidadeDeDocumentos({ extraViews = 0 } = {}) {
  const view = { id: 'tela/arquivo', exibir: 'auto' };
  const tools = [
    { name: 'buscar_arq', description: 'Busca arquivos.', effect: 'read', schema: z.object({}).passthrough(), handler: async () => ({ ok: true, itens: [] }) },
    { name: 'apresentar_arq', description: 'Mostra o arquivo como card.', effect: 'write', view, schema: z.object({}).passthrough(), handler: async () => ({ ok: true }) },
    { name: 'renomear_arq', description: 'Renomeia o arquivo.', effect: 'write', schema: z.object({}).passthrough(), handler: async () => ({ ok: true }) },
  ];
  for (let i = 1; i <= extraViews; i += 1) {
    tools.push({ name: `view_extra_${i}`, description: `Outra tela ${i}.`, effect: 'write', view, schema: z.object({}).passthrough(), handler: async () => ({ ok: true }) });
  }
  return { id: 'docs', descricao: 'Documentos.', piso: false, prefixarTools: false, semanticText: 'DOC_SEMANTICO_CALENDAR documentos', tools };
}

function montarDocs({ rodar, extraViews = 0, outras = [] }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [capacidadeDeDocumentos({ extraViews }), ...outras],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTextoQueGuarda([FECHA_ENVELOPE], []),
    decorarTool: (n, d) => d,
    loop: { rodar, paramsDe: () => [] },
  });
}

const temManual = (saida, nome) => saida.payload.secoes.some((s) => s.conteudo.includes(`<function name="${nome}">`));

test('B: leitura que o Jev escolheu e FALHOU também ganha o manual no prompt', async () => {
  const rodar = async ({ espaco }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'buscar_arq');
    return {
      estado: 'pronto',
      rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.86, erro: 'forneça query, pasta, ou ambos.', ms: 1 }],
      carregadas: [], passos: [], ms: 1,
    };
  };
  const orq = montarDocs({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha o desenho de zumbi' });
    assert.ok(!(saida.discover.tools?.hydrate ?? []).includes('docs/tool/buscar_arq'), 'pré-condição: o discover cru não hidrata buscar_arq');
    assert.ok(temManual(saida, 'buscar_arq'), 'o manual de buscar_arq (falhou no loop) tem que estar no prompt');
  } finally {
    await orq.fechar();
  }
});

test('B: leitura que o Jev escolheu sem argumento suficiente (paraOModelo) ganha o manual — o modelo chama direto', async () => {
  const rodar = async ({ espaco }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'buscar_arq');
    return { estado: 'pronto', paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }], rastro: [], carregadas: [], passos: [], ms: 1 };
  };
  const orq = montarDocs({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha o desenho de zumbi' });
    assert.ok(temManual(saida, 'buscar_arq'));
  } finally {
    await orq.fechar();
  }
});

test('C: a função com view auto do mesmo poder acompanha a leitura executada pelo Jev', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'buscar_arq');
    const resultado = await executar(fn, {});
    return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }], carregadas: [], passos: [], ms: 1 };
  };
  const orq = montarDocs({ rodar });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha o desenho de zumbi' });
    assert.ok(temManual(saida, 'buscar_arq'), 'a leitura executada tem manual');
    assert.ok(temManual(saida, 'apresentar_arq'), 'apresentar_arq (view auto) acompanha buscar_arq');
    assert.ok(!temManual(saida, 'renomear_arq'), 'função sem view auto do mesmo poder NÃO é puxada');
  } finally {
    await orq.fechar();
  }
});

function capacidadeDeNotas() {
  const t = (name, extra = {}) => ({ name, description: `Nota ${name}.`, effect: 'read', schema: z.object({}).passthrough(), handler: async () => ({ ok: true }), ...extra });
  return {
    id: 'notas', descricao: 'Notas.', piso: false, prefixarTools: false, semanticText: 'DOC_SEMANTICO_CALENDAR notas',
    tools: [
      t('nota_buscar', { acompanha: ['nota_ler', 'nota_abrir'] }),
      t('nota_ler'), t('nota_abrir'), t('nota_marcar'),
    ],
  };
}

test('acompanha: com nota_buscar executada, nota_ler e nota_abrir ficam hidratadas junto (nota_marcar não)', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'nota_buscar');
    const resultado = await executar(fn, {});
    return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }], carregadas: [], passos: [], ms: 1 };
  };
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [capacidadeDeNotas()],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTextoQueGuarda([FECHA_ENVELOPE], []),
    decorarTool: (n, d) => d,
    loop: { rodar, paramsDe: () => [] },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha a nota do cliente' });
    assert.ok(temManual(saida, 'nota_buscar'));
    assert.ok(temManual(saida, 'nota_ler'), 'nota_ler acompanha nota_buscar');
    assert.ok(temManual(saida, 'nota_abrir'), 'nota_abrir acompanha nota_buscar');
    assert.ok(!temManual(saida, 'nota_marcar'), 'o que não está em acompanha não é puxado');
  } finally {
    await orq.fechar();
  }
});

test('acompanha: o teto total por poder (3) vale com acompanha explícito + view auto', async () => {
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'buscar_arq');
    const resultado = await executar(fn, {});
    return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }], carregadas: [], passos: [], ms: 1 };
  };
  const cap = capacidadeDeDocumentos({ extraViews: 2 });
  cap.tools.find((t) => t.name === 'buscar_arq').acompanha = ['renomear_arq', 'apresentar_arq'];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [cap],
    embedder: embedderFalso(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTextoQueGuarda([FECHA_ENVELOPE], []),
    decorarTool: (n, d) => d,
    loop: { rodar, paramsDe: () => [] },
  });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha o desenho de zumbi' });
    const comManual = ['renomear_arq', 'apresentar_arq', 'view_extra_1', 'view_extra_2'].filter((n) => temManual(saida, n));
    assert.deepEqual(comManual, ['renomear_arq', 'apresentar_arq', 'view_extra_1'], 'explícitas primeiro, view auto completa; total 3');
  } finally {
    await orq.fechar();
  }
});

test('C: no máximo 2 funções com view auto por poder, e só do poder tocado', async () => {
  const outra = {
    id: 'outro', descricao: 'Outro poder.', piso: false, prefixarTools: false, semanticText: 'DOC_SEMANTICO_TAREFAS outro',
    tools: [{ name: 'tela_outro', description: 'Tela do outro.', effect: 'write', view: { id: 'tela/x', exibir: 'auto' }, schema: z.object({}).passthrough(), handler: async () => ({ ok: true }) }],
  };
  const rodar = async ({ espaco, executar }) => {
    const fn = espaco.funcoes.find((f) => f.nome === 'buscar_arq');
    const resultado = await executar(fn, {});
    return { estado: 'pronto', rastro: [{ passo: 1, fn: fn.nome, capacidade: fn.capacidade, args: {}, confianca: 0.9, resultado, ms: 1 }], carregadas: [], passos: [], ms: 1 };
  };
  const orq = montarDocs({ rodar, extraViews: 2, outras: [outra] });
  try {
    const saida = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR acha o desenho de zumbi' });
    const comManual = ['apresentar_arq', 'view_extra_1', 'view_extra_2'].filter((n) => temManual(saida, n));
    assert.deepEqual(comManual, ['apresentar_arq', 'view_extra_1'], 'teto de 2 por poder, na ordem do manifesto');
    assert.ok(!temManual(saida, 'tela_outro'), 'poder que o turno não tocou não é puxado');
  } finally {
    await orq.fechar();
  }
});

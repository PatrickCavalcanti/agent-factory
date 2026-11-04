import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  espacoDoLoop, entregaDoLoop, capacidadesDoLoop, falhaDoResultado, SCORES_TOOL_DO_LOOP,
} from '../src/loop-do-turno.js';

const tool = (name, effect = 'read') => ({ name, description: `${name}.`, effect, inputSchema: { type: 'object', properties: {} }, handler: async () => ({}) });
const capacidades = [
  { id: 'tarefas', descricao: 'Tarefas.', piso: false, prefixarTools: false, tools: [tool('task_listar'), tool('task_criar', 'write')] },
  { id: 'google-calendar', descricao: 'Agenda.', piso: false, prefixarTools: false, tools: [tool('gcal_listar_eventos')] },
  { id: 'musica', descricao: 'Música.', piso: false, prefixarTools: false, tools: [tool('tocar', 'write')] },
];

test('espaço: só funções de leitura das carregadas; candidatas só com leitura', () => {
  const e = espacoDoLoop({ capacidades, carregadas: ['tarefas'], candidatas: ['google-calendar', 'musica'], paramsDe: () => [] });
  assert.deepEqual(e.funcoes.map((f) => [f.nome, f.capacidade]), [['task_listar', 'tarefas']]);
  assert.deepEqual(e.candidatas.map((c) => c.id), ['google-calendar']);
  assert.deepEqual(e.funcoesDe('google-calendar').map((f) => f.nome), ['gcal_listar_eventos']);
});

test('espaço: params delega ao host com a tool e a capacidade', async () => {
  const vistos = [];
  const e = espacoDoLoop({ capacidades, carregadas: ['tarefas'], candidatas: [], paramsDe: (a) => { vistos.push(a.capacidade); return [{ nome: 'x', obrigatoria: false, opcoes: [] }]; } });
  const p = await e.funcoes[0].params();
  assert.equal(p[0].nome, 'x');
  assert.deepEqual(vistos, ['tarefas']);
});

test('entrega: confiança alta vira histórico no formato do genos; baixa vai só para o bloco', () => {
  const saida = {
    estado: 'pronto',
    rastro: [
      { passo: 1, fn: 'gcal_listar_eventos', capacidade: 'google-calendar', args: { periodo: 'amanha' }, confianca: 0.92, resultado: { eventos: [1] } },
      { passo: 2, fn: 'task_listar', capacidade: 'tarefas', args: { lista: 'Casa' }, confianca: 0.55, resultado: { tarefas: ['a'] } },
      { passo: 3, fn: 'task_ver', capacidade: 'tarefas', args: {}, confianca: 0.9, erro: 'sem banco' },
    ],
  };
  const r = entregaDoLoop(saida, { corteHistorico: 0.7 });
  assert.equal(r.historico.length, 2);
  const [assistente, resultado] = r.historico;
  assert.equal(assistente.role, 'assistant');
  assert.deepEqual(JSON.parse(assistente.content), { blocos: [{ chat: null, comandos: [{ tool: 'gcal_listar_eventos', args: '{"periodo":"amanha"}' }] }] });
  assert.equal(resultado.role, 'tool_result');
  assert.equal(resultado.toolName, 'gcal_listar_eventos');
  // N1: o tool_result semeado usa o MESMO formato que o genos usa para o
  // resultado de uma chamada do próprio modelo (`stringifyToolResult`,
  // genos-orchestrator/src/orchestrator.ts — `JSON.stringify(resultado, null, 2)`
  // para não-string), não mais o compacto de `resumir()`.
  assert.equal(resultado.content, JSON.stringify({ eventos: [1] }, null, 2));
  assert.deepEqual(r.destinos, { historico: 1, bloco: 1, erro: 1 });
  assert.ok(r.bloco.startsWith('<pre_hidratacao>'));
  // N3 (correção fluxo de bug, sessão d82b949d/23-09): o cabeçalho precisa deixar claro que as
  // consultas foram EXECUTADAS de verdade (dados reais, não hipotéticos) e que "confiança baixa"
  // é sobre a escolha de parâmetros/consulta, não sobre a veracidade do dado — só refazer quando
  // os parâmetros usados não cobrirem o pedido.
  assert.ok(r.bloco.includes('executou estas consultas de leitura de verdade'));
  assert.ok(r.bloco.includes('dados reais e atuais'));
  assert.ok(r.bloco.includes('não é sobre a veracidade do dado'));
  assert.ok(r.bloco.includes('essa era a consulta certa para o pedido'));
  assert.ok(r.bloco.includes('não cobrirem o pedido'));
  // Correção A (fluxo de bug, 22-09): o par assistant/tool_result semeado passou a entrar DEPOIS
  // da mensagem do usuário (`aposOPedido`), não mais "acima" dela — a linha do bloco acompanha.
  assert.ok(r.bloco.includes('gcal_listar_eventos {"periodo":"amanha"} — confiança 0.92 — resultado logo após este pedido'));
  assert.ok(r.bloco.includes('task_listar {"lista":"Casa"} — confiança 0.55 — resultado:'));
  assert.ok(r.bloco.includes('{"tarefas":["a"]}'));
  assert.ok(r.bloco.includes('task_ver {} — falhou: sem banco'));
});

// N1 (correção fluxo de bug, sessão fbab5b12/22-09): o teto de 4000 chars
// (`resumir`) não pode mais cortar o `tool_result` semeado de um item de
// confiança ALTA — só o bloco `<pre_hidratacao>` (confiança baixa) continua
// cortado. Ver o JSDoc de `comoOGenos` em loop-do-turno.js.
test('entrega: resultado grande de confiança alta não é cortado; de confiança baixa continua cortado', () => {
  const resultadoGrande = { tarefas: Array.from({ length: 400 }, (_, i) => ({ id: i, titulo: `tarefa-${i}-`.repeat(6) })) };
  const textoEsperado = JSON.stringify(resultadoGrande, null, 2);
  assert.ok(textoEsperado.length > 10000, 'fixture precisa passar de 10 mil chars para provar a ausência de corte');

  const saida = {
    estado: 'pronto',
    rastro: [
      { passo: 1, fn: 'task_listar', capacidade: 'tarefas', args: {}, confianca: 0.98, resultado: resultadoGrande },
      { passo: 2, fn: 'task_listar', capacidade: 'tarefas', args: { lista: 'Casa' }, confianca: 0.4, resultado: resultadoGrande },
    ],
  };
  const r = entregaDoLoop(saida, { corteHistorico: 0.7 });

  // Confiança alta: tool_result semeado no histórico, tamanho INTEIRO, sem marca de corte.
  const [, resultadoAlto] = r.historico;
  assert.equal(resultadoAlto.role, 'tool_result');
  assert.equal(resultadoAlto.content, textoEsperado);
  assert.equal(resultadoAlto.content.length, textoEsperado.length);
  assert.doesNotMatch(resultadoAlto.content, /…\[cortado\]/);

  // Confiança baixa: continua só no bloco (nunca semeada no histórico), e o
  // bloco continua cortado em 4000 chars — comportamento preservado.
  assert.equal(r.destinos.historico, 1);
  assert.equal(r.destinos.bloco, 1);
  assert.match(r.bloco, /…\[cortado\]/);
});

test('entrega: rastro vazio não produz nada; estourado avisa', () => {
  assert.deepEqual(entregaDoLoop({ estado: 'pronto', rastro: [] }), { historico: [], bloco: null, destinos: { historico: 0, bloco: 0, erro: 0 } });
  const r = entregaDoLoop({ estado: 'estourado', rastro: [{ passo: 1, fn: 'f', args: {}, confianca: 0.9, resultado: 1 }] });
  assert.ok(r.bloco.includes('parou antes de terminar'));
});

// I2 (revisão de qualidade da Fase 3): o espaço do loop é o que o refino ATIVOU neste turno.
test('capacidadesDoLoop: só ring provider com tier full, mais as promoções do I3a; ignora candidate/discard e outros ring', () => {
  const explain = [
    { ref: 'tarefas', ring: 'provider', proposedTier: 'discard', tier: 'full', refiner: { reason: 'jev: noul 0.9', confidence: 0.9 } },
    { ref: 'google-calendar', ring: 'provider', tier: 'candidate' },
    { ref: 'musica', ring: 'provider', tier: 'discard' },
    { ref: 'a/tool/x', ring: 'tool', tier: 'full' },
  ];
  const r = capacidadesDoLoop({ explain, promocoes: ['habilidades'] });
  assert.deepEqual([...r].sort(), ['habilidades', 'tarefas']);
});

test('capacidadesDoLoop: sem explain/promocoes não lança e devolve vazio', () => {
  assert.deepEqual([...capacidadesDoLoop({ explain: undefined, promocoes: undefined })], []);
  assert.deepEqual([...capacidadesDoLoop({ explain: [], promocoes: [] })], []);
});

// Melhoria 2 (spec §4, sessão 2026-09-23): a mesma `explain` (todos os anéis) que já alimenta
// `capacidadesDoLoop` carrega também as entradas `ring: 'tool'` do kairos — o score da função
// PARA A PERGUNTA. `capacidadesDoLoop` transporta esse mapa pendurado no Set que já devolve
// (`SCORES_TOOL_DO_LOOP`), sem mudar a forma externa (ids de capacidade) que `index.js` espera.
test('capacidadesDoLoop: pendura o mapa de scores do anel tool no Set devolvido, sem mudar os ids', () => {
  const explain = [
    { ref: 'tarefas', ring: 'provider', tier: 'full' },
    { ref: 'tarefas/tool/listar', ring: 'tool', scores: { final: 0.8 } },
    { ref: 'google-calendar/tool/listar_eventos', ring: 'tool', scores: { final: 0.3 } },
    { ref: 'sem-score/tool/x', ring: 'tool' },
  ];
  const r = capacidadesDoLoop({ explain, promocoes: [] });
  assert.deepEqual([...r], ['tarefas']);
  const scores = r[SCORES_TOOL_DO_LOOP];
  assert.equal(scores.get('tarefas/tool/listar'), 0.8);
  assert.equal(scores.get('google-calendar/tool/listar_eventos'), 0.3);
  assert.equal(scores.has('sem-score/tool/x'), false);
});

// Melhoria 2: a ordem de `espaco.funcoes` segue o score do anel `tool` (descendente), não a
// ordem de ativação das capacidades — é o que põe a função certa entre as K do primeiro passo
// (spec §3.2) em vez de só entrar via `foraDasK` (um passo a mais só para perguntar argumentos).
test('espacoDoLoop: ordena funcoes pelo score do anel tool (descendente), quando o transporte de capacidadesDoLoop chega', () => {
  // `explain` lista google-calendar ANTES de tarefas no anel provider — sem a Melhoria 2, é essa
  // ordem de ativação que `espacoDoLoop` reproduziria em `funcoes` (gcal na frente). É o cenário
  // medido em 23/09 (K do passo 1 eram funções da agenda, não `task_listar`, para um pedido sobre
  // tarefas). O score do anel tool inverte: task_listar (0.9) na frente de gcal (0.2).
  const explain = [
    { ref: 'google-calendar', ring: 'provider', tier: 'full' },
    { ref: 'tarefas', ring: 'provider', tier: 'full' },
    { ref: 'tarefas/tool/task_listar', ring: 'tool', scores: { final: 0.9 } },
    { ref: 'google-calendar/tool/gcal_listar_eventos', ring: 'tool', scores: { final: 0.2 } },
  ];
  const carregadas = capacidadesDoLoop({ explain, promocoes: [] });
  assert.deepEqual([...carregadas], ['google-calendar', 'tarefas'], 'pré-condição: sem o score, gcal viria primeiro');
  const e = espacoDoLoop({
    capacidades: [
      { id: 'google-calendar', descricao: 'Agenda.', prefixarTools: false, tools: [tool('gcal_listar_eventos')] },
      { id: 'tarefas', descricao: 'Tarefas.', prefixarTools: false, tools: [tool('task_listar')] },
    ],
    carregadas, candidatas: [], paramsDe: () => [],
  });
  assert.deepEqual(e.funcoes.map((f) => f.nome), ['task_listar', 'gcal_listar_eventos']);
});

test('espacoDoLoop: sem scores (explain sem anel tool, ou carregadas sem o transporte) preserva a ordem de hoje', () => {
  const semTransporte = ['google-calendar', 'tarefas'];
  const e = espacoDoLoop({
    capacidades: [
      { id: 'google-calendar', descricao: 'Agenda.', prefixarTools: false, tools: [tool('gcal_listar_eventos')] },
      { id: 'tarefas', descricao: 'Tarefas.', prefixarTools: false, tools: [tool('task_listar')] },
    ],
    carregadas: semTransporte, candidatas: [], paramsDe: () => [],
  });
  assert.deepEqual(e.funcoes.map((f) => f.nome), ['gcal_listar_eventos', 'task_listar']);
});

test('espacoDoLoop: função sem entrada no anel tool fica depois das com score, na ordem relativa de antes', () => {
  const explain = [
    { ref: 'tarefas', ring: 'provider', tier: 'full' },
    { ref: 'tarefas/tool/task_ver', ring: 'tool', scores: { final: 0.5 } },
    // task_listar não tem entrada no anel tool (ex.: refinador não citou) — fica depois.
  ];
  const carregadas = capacidadesDoLoop({ explain, promocoes: [] });
  const e = espacoDoLoop({
    capacidades: [{ id: 'tarefas', descricao: 'Tarefas.', prefixarTools: false, tools: [tool('task_listar'), tool('task_ver')] }],
    carregadas, candidatas: [], paramsDe: () => [],
  });
  assert.deepEqual(e.funcoes.map((f) => f.nome), ['task_ver', 'task_listar']);
});

// I1 (revisão de qualidade da Fase 3): falha em texto (o formato real de `criarHandlerDePower`)
// tem que ser reconhecida como falha, não só `{ ok: false }` em objeto.
test('falhaDoResultado: objeto com ok:false é falha; ok:true (ou sem ok) não é', () => {
  assert.equal(falhaDoResultado({ ok: false, error: 'sem banco' }), 'sem banco');
  assert.equal(falhaDoResultado({ ok: true, tarefas: [] }), null);
  assert.equal(falhaDoResultado({ tarefas: [] }), null);
});

test('falhaDoResultado: string JSON com ok:false é falha; string JSON de sucesso não é', () => {
  assert.equal(falhaDoResultado(JSON.stringify({ ok: false, error: 'sem banco' })), 'sem banco');
  assert.equal(falhaDoResultado(JSON.stringify({ ok: true, tarefas: [] })), null);
});

test('falhaDoResultado: prosa "Erro: ..." (buildToolArgumentError/buildToolExecutionError) é falha; prosa comum não é', () => {
  const erroDeArgumento = 'Erro: Argumentos invalidos para task_ver. Campo obrigatorio ausente.';
  assert.equal(falhaDoResultado(erroDeArgumento), erroDeArgumento);
  assert.equal(falhaDoResultado('tudo certo, tarefa criada'), null);
  assert.equal(falhaDoResultado('texto que não é JSON nem começa com Erro:'), null);
});

// N2 (correção fluxo de bug, spec 2026-09-22 §6): os powers devolvem `error` como OBJETO
// `{ code, message }` (toolError, packages/powers/src/powers/tarefas/functions/_shared.js:19) —
// `String(r.error)` virava "[object Object]" e a mensagem real da falha se perdia do rastro.
test('falhaDoResultado: error em objeto {code,message} extrai a message, não "[object Object]"', () => {
  assert.equal(
    falhaDoResultado({ ok: false, error: { code: 'lista_nao_encontrada', message: 'lista não encontrada' } }),
    'lista não encontrada',
  );
  assert.equal(
    falhaDoResultado(JSON.stringify({ ok: false, error: { code: 'lista_nao_encontrada', message: 'lista não encontrada' } })),
    'lista não encontrada',
  );
});

test('falhaDoResultado: error em objeto só com code (sem message) cai para o code', () => {
  assert.equal(falhaDoResultado({ ok: false, error: { code: 'not_connected' } }), 'not_connected');
});

test('falhaDoResultado: error como string direta segue reconhecida (contrato antigo)', () => {
  assert.equal(falhaDoResultado({ ok: false, error: 'texto' }), 'texto');
});

test('preExecucao:false (servidor MCP genérico): fora do espaço do loop mesmo ativado pelo refino ou candidato', () => {
  const caps = [
    ...capacidades,
    { id: 'mcp-crm', descricao: 'CRM.', piso: false, prefixarTools: false, preExecucao: false, tools: [tool('mcp_crm_buscar')] },
    { id: 'okapp', descricao: 'Okapp.', piso: false, prefixarTools: false, preExecucao: true, tools: [tool('okapp_listar')] },
  ];
  const explain = [
    { ring: 'provider', ref: 'mcp-crm', tier: 'full' },
    { ring: 'provider', ref: 'okapp', tier: 'full' },
    { ring: 'provider', ref: 'tarefas', tier: 'full' },
  ];
  const carregadas = capacidadesDoLoop({ explain, promocoes: ['mcp-crm'], capacidades: caps });
  assert.deepEqual([...carregadas].sort(), ['okapp', 'tarefas']);
  const e = espacoDoLoop({ capacidades: caps, carregadas, candidatas: ['mcp-crm', 'google-calendar'], paramsDe: () => [] });
  assert.deepEqual(e.funcoes.map((f) => f.nome).sort(), ['okapp_listar', 'task_listar']);
  assert.deepEqual(e.candidatas.map((c) => c.id), ['google-calendar']);
  assert.deepEqual(e.funcoesDe('mcp-crm'), []);
  // mesmo entregue direto em `carregadas` (outra origem), o espaço não o inclui.
  const direto = espacoDoLoop({ capacidades: caps, carregadas: ['mcp-crm'], candidatas: [], paramsDe: () => [] });
  assert.deepEqual(direto.funcoes, []);
});

test('falhaDoResultado: o motivo vem de erro, mensagem, motivo (e message/code), em objeto ou aninhado', () => {
  assert.equal(falhaDoResultado({ ok: false, erro: 'sem autorização' }), 'sem autorização');
  assert.equal(falhaDoResultado({ ok: false, code: 'sem_autorizacao', mensagem: 'sem autorização para abrir' }), 'sem autorização para abrir');
  assert.equal(falhaDoResultado({ ok: false, motivo: 'cota esgotada' }), 'cota esgotada');
  assert.equal(falhaDoResultado({ ok: false, message: 'caiu' }), 'caiu');
  assert.equal(falhaDoResultado({ ok: false, erro: { code: 'x', mensagem: 'aninhada' } }), 'aninhada');
  assert.equal(falhaDoResultado({ ok: false, error: { message: 'm', code: 'c' } }), 'm');
  assert.equal(falhaDoResultado({ ok: false, error: { code: 'so_codigo' } }), 'so_codigo');
  assert.equal(falhaDoResultado({ ok: false, code: 'so_codigo' }), 'so_codigo');
  assert.equal(falhaDoResultado({ ok: false, error: 'e', erro: 'x', motivo: 'y', reason: 'z' }), 'e', 'error continua à frente');
  assert.equal(falhaDoResultado({ ok: false, reason: 'r' }), 'r');
  assert.equal(falhaDoResultado({ ok: false, faltas: ['a'] }), 'ok: false', 'sem texto nenhum, o rótulo de sempre');
  assert.equal(falhaDoResultado(JSON.stringify({ ok: false, mensagem: 'em json' })), 'em json');
  assert.equal(falhaDoResultado({ ok: true, erro: 'não é falha' }), null);
});

test('falhaDoResultado: retorno MCP com isError é falha, com o texto do content como motivo', () => {
  assert.equal(falhaDoResultado({ isError: true, content: [{ type: 'text', text: 'sem permissão' }] }), 'sem permissão');
  assert.equal(falhaDoResultado({ isError: true, content: 'texto direto' }), 'texto direto');
  assert.equal(falhaDoResultado({ isError: true, content: [] }), 'isError: true');
  assert.equal(falhaDoResultado(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'em json' }] })), 'em json');
  assert.equal(falhaDoResultado({ isError: false, content: [{ type: 'text', text: 'ok' }] }), null);
  assert.equal(falhaDoResultado({ content: [{ type: 'text', text: 'ok' }] }), null);
});

test('falhaDoResultado: isError com JSON no content usa o motivo do JSON; só o primeiro item de texto conta', () => {
  const texto = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });
  assert.equal(falhaDoResultado(texto(JSON.stringify({ ok: false, error: { code: 'validation', message: 'título é obrigatório' } }))), 'título é obrigatório');
  assert.equal(falhaDoResultado(texto(JSON.stringify({ ok: false, mensagem: 'sem autorização' }))), 'sem autorização');
  assert.equal(falhaDoResultado(texto('sem permissão')), 'sem permissão');
  assert.equal(falhaDoResultado(texto('{"quebrado":')), '{"quebrado":', 'JSON inválido vira o texto');
  assert.equal(falhaDoResultado(texto(JSON.stringify({ faltas: ['a'] }))), '{"faltas":["a"]}', 'JSON sem motivo: o texto');
  const doisItens = { isError: true, content: [
    { type: 'text', text: JSON.stringify({ ok: false, error: { message: 'primeiro' } }) },
    { type: 'text', text: JSON.stringify({ ok: false, error: { message: 'segundo' } }) },
  ] };
  assert.equal(falhaDoResultado(doisItens), 'primeiro');
  assert.equal(falhaDoResultado({ isError: true, content: [{ type: 'image', data: 'x' }, { type: 'text', text: 'depois da imagem' }] }), 'depois da imagem');
  assert.equal(falhaDoResultado({ isError: true, content: JSON.stringify({ error: { message: 'content em string' } }) }), 'content em string');
});

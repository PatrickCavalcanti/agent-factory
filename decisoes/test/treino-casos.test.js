import test from 'node:test';
import assert from 'node:assert/strict';
import { mapaDeFuncoes, resolverNomeDeOperacao, casoDaInteracao, tsDaPasta, ehFuturo, ehCaminhoDeBancada, META_TOOLS } from '../treino/lib/casos.js';

const manifests = [{ id: 'google_calendar', functions: [{ name: 'gcal_listar_eventos' }] }, { id: 'tarefas', functions: [{ name: 'task_listar' }] }];

test('mapaDeFuncoes converte o id da capacidade', () => {
  const m = mapaDeFuncoes(manifests, 'functions');
  assert.equal(m.get('gcal_listar_eventos'), 'google-calendar');
});

test('caso da V1: capacidades usadas, funções, descartes e meta-tools fora', () => {
  const m = mapaDeFuncoes(manifests, 'functions');
  const c = casoDaInteracao({
    id: 'i1', sessao: 's1', ts: '2026-09-01T10:00:00',
    execLog: { input: { userMessage: 'o que tenho amanhã?' } },
    timeline: { items: [{ kind: 'agent.tool.started', payload: { toolName: 'gcal_listar_eventos' } }, { kind: 'agent.tool.started', payload: { name: 'load_bundle' } }, { kind: 'agent.tool.started', payload: { toolName: 'sumiu_no_porte' } }] },
    fabrica: null, mapa: m,
  });
  assert.deepEqual([c.capacidades, c.funcoes, c.descartadas], [['google-calendar'], ['gcal_listar_eventos'], ['sumiu_no_porte']]);
  assert.ok(META_TOOLS.has('load_bundle'));
});

test('caso da fábrica e caso sem pedido', () => {
  const m = mapaDeFuncoes(manifests, 'functions');
  const c = casoDaInteracao({ id: 'i2', sessao: 's', ts: 't', execLog: { input: { userMessage: 'tarefas?' } }, timeline: null, fabrica: { operacoes: [{ nome: 'task_listar' }] }, mapa: m });
  assert.deepEqual(c.capacidades, ['tarefas']);
  assert.equal(casoDaInteracao({ id: 'i3', sessao: 's', ts: 't', execLog: { input: { userMessage: '  ' } }, timeline: null, fabrica: null, mapa: m }), null);
});

test('turno de background, notificação ou debug não é caso', () => {
  const m = mapaDeFuncoes(manifests, 'functions');
  const caso = (input) => casoDaInteracao({ id: 'x', sessao: 's', ts: 't', execLog: { input: { userMessage: 'algo', ...input } }, timeline: null, fabrica: null, mapa: m });
  assert.equal(caso({ channel: 'background', source: 'text' }), null);
  assert.equal(caso({ channel: 'web', source: 'background' }), null);
  assert.equal(caso({ channel: 'web', source: 'notification' }), null);
  assert.equal(caso({ channel: 'debug', source: 'text' }), null);
  assert.ok(caso({ channel: 'telegram', source: 'telegram_text' }));
  assert.ok(caso({ channel: 'web', source: 'audio' }));
});

test('tsDaPasta converte o nome da pasta em ISO ordenável', () => {
  assert.equal(tsDaPasta('20261006-224252_interaction-abd70f26-81a0'), '2026-10-06T22:42:52');
  assert.ok(tsDaPasta('20260901-100000_interaction-a') < tsDaPasta('20261006-224252_interaction-b'));
});

test('ehFuturo: ts maior que agora é descartado', () => {
  const agora = new Date(2026, 9, 6, 12, 0, 0);
  assert.equal(ehFuturo('2030-03-05T08:00:00', agora), true);
  assert.equal(ehFuturo('2026-10-06T12:00:01', agora), true);
  assert.equal(ehFuturo('2026-10-06T11:59:59', agora), false);
  assert.equal(ehFuturo('2026-10-06T12:00:00', '2026-10-06T12:00:00'), false);
});

test('marca de bancada só vale no caminho relativo, nunca no --data', () => {
  assert.equal(ehCaminhoDeBancada('2026-10/20261006-1_session-a/interactions/20261006-1_interaction-b'), false);
  assert.equal(ehCaminhoDeBancada('2026-10/bench-run-1/interactions/x'), true);
  assert.equal(ehCaminhoDeBancada('2026-10/20261006_bancada-s/interactions/x'), true);
  // o --data (E:/dados/bancada/igris) não entra: o caminho passado é relativo à raiz de sessões
  assert.equal(ehCaminhoDeBancada(['2026-10', 's', 'i'].join('/')), false);
});

test('M4: o caminho do log ignora leitura do loop que FALHOU e conta load_capability como capacidade usada (como o registro)', () => {
  const mapa = mapaDeFuncoes([{ id: 'agenda', functions: [{ name: 'ler' }] }, { id: 'tarefas', functions: [{ name: 'listar' }] }], 'functions');
  const execLog = { input: { userMessage: 'o que tenho?' } };
  const c = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog, timeline: null, mapa, fabrica: { operacoes: [
    { nome: 'ler', ok: false, origem: 'jev' }, // leitura que falhou não leu
    { nome: 'load_capability', args: { refs: ['tarefas/tool/listar'] } },
  ] } });
  assert.deepEqual(c.funcoes, []);
  assert.deepEqual(c.capacidades, ['tarefas']);
  const ok = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog, timeline: null, mapa, fabrica: { operacoes: [{ nome: 'ler', ok: true, origem: 'jev' }] } });
  assert.deepEqual(ok.capacidades, ['agenda']);
});

test('pergunta 3: nome de função em mais de uma capacidade é ambíguo — o caso vira incerto, nunca pega a última', () => {
  const mapa = mapaDeFuncoes([{ id: 'agenda', functions: [{ name: 'listar' }, { name: 'ler' }] }, { id: 'tarefas', functions: [{ name: 'listar' }] }], 'functions');
  assert.equal(mapa.get('listar'), undefined);
  assert.deepEqual([...mapa.ambiguos], ['listar']);
  assert.equal(mapa.get('ler'), 'agenda');
  const c = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog: { input: { userMessage: 'lista' } }, timeline: null, mapa, fabrica: { operacoes: [{ nome: 'listar', ok: true }, { nome: 'ler', ok: true }] } });
  assert.equal(c.incerto, true);
  assert.deepEqual(c.ambiguas, ['listar']);
  assert.deepEqual(c.capacidades, ['agenda'], 'o resolvido segue, mas o caso é incerto');
});

test('capacidadeDoPedido: capacidade, ref, nome exposto e nome cru resolvem para a capacidade', async () => {
  const { capacidadeDoPedido } = await import('../treino/lib/casos.js');
  const m = new Map([['task_listar', 'tarefas'], ['navegar', 'navegador']]);
  assert.equal(capacidadeDoPedido('tarefas', m), 'tarefas');
  assert.equal(capacidadeDoPedido('tarefas/tool/task_listar', m), 'tarefas');
  assert.equal(capacidadeDoPedido('navegador__navegar', m), 'navegador');
  assert.equal(capacidadeDoPedido('navegador__fechar_navegador', m), 'navegador', 'fora da tabela: corta no __');
  assert.equal(capacidadeDoPedido('task_listar', m), 'tarefas');
});

test('capacidadeDoServidorMcp: mcp_chamar_tool com servidor vira mcp-<servidor>', async () => {
  const { capacidadeDoServidorMcp } = await import('../treino/lib/casos.js');
  assert.equal(capacidadeDoServidorMcp({ nome: 'mcp_chamar_tool', args: { servidor: 'home_assistant', tool: 'intent__HassTurnOn' } }), 'mcp-home-assistant');
  assert.equal(capacidadeDoServidorMcp({ nome: 'mcp__mcp_listar_tools', args: { servidor: 'justwatch' } }), 'mcp-justwatch');
  assert.equal(capacidadeDoServidorMcp({ nome: 'mcp_chamar_tool', args: {} }), null);
  assert.equal(capacidadeDoServidorMcp({ nome: 'task_listar', args: { servidor: 'x' } }), null);
});

test('casoDaInteracao: chamada genérica a servidor MCP conta como a capacidade do servidor, não mcp', () => {
  const fabrica = { operacoes: [{ nome: 'mcp_chamar_tool', args: { servidor: 'home_assistant', tool: 'intent__HassTurnOn', argumentos: {} }, ok: true }] };
  const mapa = mapaDeFuncoes([{ id: 'mcp', functions: [{ name: 'mcp_chamar_tool' }] }], 'functions');
  const c = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog: { input: { userMessage: 'liga o ar' } }, timeline: null, fabrica, mapa });
  assert.deepEqual(c.capacidades, ['mcp-home-assistant']);
});

test('capacidadeDoServidorMcp: normalização do slug e entradas inválidas', async () => {
  const { capacidadeDoServidorMcp: f } = await import('../treino/lib/casos.js');
  const op = (servidor) => ({ nome: 'mcp_chamar_tool', args: { servidor } });
  assert.equal(f(op('Home Assistant')), 'mcp-home-assistant');
  assert.equal(f(op('mcp-local-4820')), 'mcp-mcp-local-4820');
  assert.equal(f(op('Açaí_Café')), 'mcp-acai-cafe');
  assert.equal(f(op('日本')), 'mcp-servidor');
  assert.equal(f(op('   ')), null);
  assert.equal(f(op('')), null);
  assert.equal(f(op(42)), null);
  assert.equal(f(op(['x'])), null);
});

test('casoDaInteracao: mesmo nome com e sem servidor dá mcp-x e mcp, sem duplicata', () => {
  const fabrica = { operacoes: [
    { nome: 'mcp_chamar_tool', args: { servidor: 'x', tool: 't' }, ok: true },
    { nome: 'mcp_chamar_tool', args: {}, ok: true },
  ] };
  const mapa = mapaDeFuncoes([{ id: 'mcp', functions: [{ name: 'mcp_chamar_tool' }] }], 'functions');
  const c = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog: { input: { userMessage: 'faz' } }, timeline: null, fabrica, mapa });
  assert.deepEqual(c.capacidades, ['mcp-x', 'mcp']);
  assert.deepEqual(c.funcoes, ['mcp_chamar_tool']);
});

test('casoDaInteracao: timeline com nome cru e operação com nome exposto são o mesmo nome', () => {
  const fabrica = { operacoes: [{ nome: 'mcp__mcp_chamar_tool', args: { servidor: 'x', tool: 't' }, ok: true }] };
  const timeline = { items: [{ kind: 'agent.tool.started', payload: { toolName: 'mcp_chamar_tool' } }] };
  const mapa = mapaDeFuncoes([{ id: 'mcp', functions: [{ name: 'mcp_chamar_tool' }] }], 'functions');
  const c = casoDaInteracao({ id: 'i', sessao: 's', ts: 't', execLog: { input: { userMessage: 'faz' } }, timeline, fabrica, mapa });
  assert.deepEqual(c.capacidades, ['mcp-x']);
  assert.deepEqual(c.funcoes, []);
  assert.deepEqual(c.descartadas, []);
});

test('mapaDeFuncoes e resolverNomeDeOperacao: funcao ambigua no cru resolve quando chamada pelo nome exposto', () => {
  const manifests = [
    { id: 'mcp-a', functions: [{ name: 'list_projects' }] },
    { id: 'mcp-b', functions: [{ name: 'list_projects' }] },
  ];
  const mapa = mapaDeFuncoes(manifests, 'functions');
  assert.equal(resolverNomeDeOperacao('list_projects', mapa)?.ambiguo, true);
  assert.deepEqual(resolverNomeDeOperacao('mcp-b__list_projects', mapa), { cap: 'mcp-b', fn: 'list_projects' });
  assert.deepEqual(resolverNomeDeOperacao('mcp-a__list_projects', mapa), { cap: 'mcp-a', fn: 'list_projects' });
});


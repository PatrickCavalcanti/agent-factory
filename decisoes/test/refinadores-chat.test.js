// packages/decisions/test/refinadores-chat.test.js
//
// Task 7 (spec 2026-09-20, §3.2/R9): os três refinadores concretos do kairos —
// `refinadorDeCapacidades` (anel `provider`), `refinadorDeFuncoes` (anel `tool`) e
// `refinadorDeHabilidades` (anel `skill`) — e `refinadoresDoChat`, que os monta juntos (ou
// devolve `{}` sem gateway, J0). O mecanismo comum (teto de 60 perguntas, item não enviado
// mantém o proposto, degradação) já está coberto em `refinadores.test.js` contra
// `criarRefinadorJev`; aqui o foco é o CONTEÚDO que cada anel declara: seletor, pergunta e
// classificar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refinadorDeCapacidades, refinadorDeFuncoes, refinadorDeHabilidades, refinadoresDoChat } from '../src/refinadores/index.js';

const item = (ref, position, proposedTier, final = 0.5, meta = {}) => ({ ref, position, scores: { final }, proposedTier, meta });
const entrada = (items, proposal, caps = { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 8 } }, ring = 'provider') => ({
  ring, query: { text: 'agenda de hoje', vectors: [] }, items, proposal, caps,
  state: { loadedProviders: [] }, ctx: {}, budgetMs: 600,
});
const clienteFake = (respostas) => ({ chamadas: [], async decidir({ state, questions }) { this.chamadas.push({ state, questions }); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: respostas[k] ?? 0 }; return { answers, ms: 5 }; } });

// ---------------------------------------------------------------------------------------
// refinadorDeCapacidades (anel `provider`)
// ---------------------------------------------------------------------------------------

test('refinadorDeCapacidades: só 30 de 31 itens vão ao Jev (enviar default = 30); o 31º mantém o proposto', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeCapacidades({ cliente });
  const items = [];
  for (let i = 0; i <= 30; i++) items.push(item(`p${i}`, i, 'candidate'));
  const out = await refinar(entrada(items, { full: [], candidates: items.map((it) => it.ref) }));
  assert.equal(Object.keys(cliente.chamadas[0].questions).length, 30);
  assert.ok(!('cap_p30' in cliente.chamadas[0].questions));
  assert.ok(out.candidates.includes('p30'));
});

test('refinadorDeCapacidades: classifica pelo noul (≥0,7 full; 0,3–0,7 candidate; <0,3 discard), ignorando o proposto', async () => {
  const cliente = clienteFake({ cap_p0: 0.75, cap_p1: 0.5, cap_p2: 0.1 });
  const refinar = refinadorDeCapacidades({ cliente });
  const items = [item('p0', 0, 'candidate'), item('p1', 1, 'candidate'), item('p2', 2, 'full')];
  const out = await refinar(entrada(items, { full: ['p2'], candidates: ['p0', 'p1'] }));
  assert.deepEqual(out.full, ['p0']);
  assert.ok(out.candidates.includes('p1'));
  assert.ok(!out.full.includes('p2') && !out.candidates.includes('p2'), 'p2 respondeu noul 0.1 e devia virar discard mesmo com proposedTier full');
});

test('refinadorDeCapacidades: teto de 2 full por turno rebaixa o de menor confiança para candidate', async () => {
  const cliente = clienteFake({ cap_p0: 0.9, cap_p3: 0.8, cap_p4: 0.75 });
  const refinar = refinadorDeCapacidades({ cliente });
  const items = [item('p0', 0, 'candidate'), item('p3', 1, 'candidate'), item('p4', 2, 'candidate')];
  const out = await refinar(entrada(items, { full: [], candidates: ['p0', 'p3', 'p4'] }));
  assert.deepEqual(out.full, ['p0', 'p3']);
  assert.ok(out.candidates.includes('p4'));
});

test('refinadorDeCapacidades: a pergunta cita "capacidade" e a descrição do item', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeCapacidades({ cliente });
  const items = [item('p0', 0, 'candidate', 0.5, { description: 'agenda do usuario' })];
  await refinar(entrada(items, { full: [], candidates: ['p0'] }));
  const texto = cliente.chamadas[0].questions['cap_p0'].instructions;
  assert.ok(texto.toLowerCase().includes('capacidade'));
  assert.ok(texto.includes('agenda do usuario'));
});

// ---------------------------------------------------------------------------------------
// 22/09: perguntasExtras também cobre capacidades já carregadas (piso) que não são item do
// anel — medição de 21/09 (sessões 97c4bc58/3fae43e0): o cache só cobria 6 de 18 funções
// porque as capacidades de PISO (memoria/redator/roteiros, sempre carregadas) nunca eram
// candidatas do anel `provider`.
// ---------------------------------------------------------------------------------------

test('refinadorDeCapacidades: perguntasExtras cobre também as funções de input.state.loadedProviders, depois das dos itens', async () => {
  const cliente = clienteFake({ cap_cal: 0.9 });
  const funcoesDe = (id) => ({
    cal: [{ ref: 'cal/tool/listar', descricao: 'lista eventos', pinned: false }],
    memoria: [{ ref: 'memoria/tool/buscar', descricao: 'busca memoria', pinned: false }, { ref: 'memoria/tool/salvar', descricao: 'salva memoria', pinned: false }],
  })[id] ?? [];
  const cache = { obter: () => undefined, gravar: () => {} };
  const refinar = refinadorDeCapacidades({ cliente, funcoesDe, cache });
  const entradaComCarregadas = {
    ...entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }),
    state: { loadedProviders: ['memoria'], hydratedTools: [] },
  };
  await refinar(entradaComCarregadas);
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.deepEqual(chaves, ['cap_cal', 'fn_cal/tool/listar', 'fn_memoria/tool/buscar', 'fn_memoria/tool/salvar'], 'funcoes do item primeiro, depois as da capacidade carregada (piso)');
});

// ---------------------------------------------------------------------------------------
// 23/09 (ajuste pontual): perguntasExtras também cobre capacidadesDePiso (ids de piso que o
// HOST já conhece), independente de input.state.loadedProviders — que no PRIMEIRO turno com
// refino da sessão ainda está vazio (medição de 21/09, sessões 40d6f594/27a76c4c: as ~15
// funções do piso nunca entravam na chamada combinada no primeiro turno).
// ---------------------------------------------------------------------------------------

test('refinadorDeCapacidades: perguntasExtras cobre também capacidadesDePiso, mesmo com loadedProviders vazio (primeiro turno)', async () => {
  const cliente = clienteFake({});
  const funcoesDe = (id) => ({
    memoria: [{ ref: 'memoria/tool/mem_ler', descricao: 'le memoria', pinned: false }, { ref: 'memoria/tool/mem_salvar', descricao: 'salva memoria', pinned: false }],
  })[id] ?? [];
  const cache = { obter: () => undefined, gravar: () => {} };
  const refinar = refinadorDeCapacidades({ cliente, funcoesDe, cache, capacidadesDePiso: () => ['memoria'] });
  const entradaSemLoadedProviders = {
    ...entrada([], { full: [], candidates: [] }),
    state: { loadedProviders: [], hydratedTools: [] },
  };
  await refinar(entradaSemLoadedProviders);
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.deepEqual(chaves, ['fn_memoria/tool/mem_ler', 'fn_memoria/tool/mem_salvar'], 'funcoes do piso entram mesmo com loadedProviders vazio');
});

test('refinadorDeCapacidades: capacidadesDePiso e loadedProviders com o mesmo id não duplicam a extra', async () => {
  const cliente = clienteFake({});
  const funcoesDe = (id) => ({
    memoria: [{ ref: 'memoria/tool/mem_ler', descricao: 'le memoria', pinned: false }],
  })[id] ?? [];
  const cache = { obter: () => undefined, gravar: () => {} };
  const refinar = refinadorDeCapacidades({ cliente, funcoesDe, cache, capacidadesDePiso: () => ['memoria'] });
  const entradaComAsDuas = {
    ...entrada([], { full: [], candidates: [] }),
    state: { loadedProviders: ['memoria'], hydratedTools: [] },
  };
  await refinar(entradaComAsDuas);
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.deepEqual(chaves, ['fn_memoria/tool/mem_ler'], 'memoria em capacidadesDePiso e loadedProviders ao mesmo tempo — a funcao entra so uma vez');
});

test('refinadorDeCapacidades: capacidade carregada que também é item do anel não duplica a extra', async () => {
  const cliente = clienteFake({ cap_cal: 0.9 });
  const funcoesDe = (id) => ({
    cal: [{ ref: 'cal/tool/listar', descricao: 'lista eventos', pinned: false }],
  })[id] ?? [];
  const cache = { obter: () => undefined, gravar: () => {} };
  const refinar = refinadorDeCapacidades({ cliente, funcoesDe, cache });
  const entradaComCarregadas = {
    ...entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }),
    state: { loadedProviders: ['cal'], hydratedTools: [] },
  };
  await refinar(entradaComCarregadas);
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.deepEqual(chaves, ['cap_cal', 'fn_cal/tool/listar'], 'cal já é item do anel — a extra das capacidades carregadas não repete a mesma função');
});

// ---------------------------------------------------------------------------------------
// refinadorDeFuncoes (anel `tool`)
// ---------------------------------------------------------------------------------------

test('refinadorDeFuncoes: item com manual não vai ao Jev e mantém o proposto', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [item('a', 0, 'candidate', 0.5, { hasManual: true }), item('b', 1, 'candidate')];
  const out = await refinar(entrada(items, { full: [], candidates: ['a', 'b'] }));
  assert.ok(!('fn_a' in cliente.chamadas[0].questions));
  assert.ok(out.candidates.includes('a'));
});

test('refinadorDeFuncoes: item pinned não vai ao Jev e fica full (proposto)', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [item('a', 0, 'full', 0.9, { pinned: true }), item('b', 1, 'candidate')];
  const out = await refinar(entrada(items, { full: ['a'], candidates: ['b'] }));
  assert.ok(!('fn_a' in cliente.chamadas[0].questions));
  assert.ok(out.full.includes('a'));
});

test('refinadorDeFuncoes: noul ≥ 0,7 sobe a full', async () => {
  const cliente = clienteFake({ fn_a: 0.7 });
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [item('a', 0, 'candidate')];
  const out = await refinar(entrada(items, { full: [], candidates: ['a'] }));
  assert.deepEqual(out.full, ['a']);
});

test('refinadorDeFuncoes: abaixo do corte mantém o proposto (não rebaixa a discard)', async () => {
  const cliente = clienteFake({ fn_a: 0.5, fn_b: 0.2 });
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [item('a', 0, 'candidate'), item('b', 1, 'discard')];
  const out = await refinar(entrada(items, { full: [], candidates: ['a'] }));
  assert.ok(out.candidates.includes('a'), 'candidate abaixo do corte continua candidate');
  assert.ok(!out.full.includes('b') && !out.candidates.includes('b'), 'discard abaixo do corte continua discard (fora de full/candidates)');
});

test('refinadorDeFuncoes: teto de 4 full por turno rebaixa o quinto', async () => {
  const cliente = clienteFake({ fn_a: 0.95, fn_b: 0.9, fn_c: 0.85, fn_d: 0.8, fn_e: 0.75 });
  const refinar = refinadorDeFuncoes({ cliente });
  const items = ['a', 'b', 'c', 'd', 'e'].map((r, i) => item(r, i, 'candidate'));
  const out = await refinar(entrada(items, { full: [], candidates: items.map((it) => it.ref) }));
  assert.deepEqual(out.full, ['a', 'b', 'c', 'd']);
  assert.ok(out.candidates.includes('e'));
});

test('refinadorDeFuncoes: discard proposto + noul alto, teto já cheio com confiança maior → vira candidate (não discard)', async () => {
  // F4 (review Fase 2): item chega com proposedTier 'discard' do motor, mas responde noul 0.9
  // (voto de alta confiança do Jev, acima do corteFull 0,7). O teto de 4 `full` por turno já
  // está preenchido por outros 4 itens de noul maior (0.95-0.8) — o construtor NUNCA descarta
  // um voto de alta confiança por causa do teto: `tetos.full` só limita quantos itens entram
  // HIDRATADOS (full) neste turno, rebaixando o excedente a candidate — nunca de volta ao
  // discard proposto originalmente. Por isso o item termina 'candidate', não 'discard'.
  const cliente = clienteFake({ fn_a: 0.98, fn_b: 0.97, fn_c: 0.96, fn_d: 0.95, fn_e: 0.9 });
  const refinar = refinadorDeFuncoes({ cliente });
  const items = ['a', 'b', 'c', 'd'].map((r, i) => item(r, i, 'candidate'));
  items.push(item('e', 4, 'discard'));
  const out = await refinar(entrada(items, { full: [], candidates: items.slice(0, 4).map((it) => it.ref) }));
  assert.deepEqual(out.full, ['a', 'b', 'c', 'd']);
  assert.ok(out.candidates.includes('e'), 'e votou noul 0.9 (acima do corte) mas o teto de 4 full já estava cheio com confiança maior — vira candidate');
  assert.ok(!out.full.includes('e'));
});

test('refinadorDeFuncoes: teto protege quem o motor já marcava full — item confirmado pelo Jev nunca perde o lugar para uma promoção', async () => {
  // F3 (correção da revisão final do conjunto): `a` já era `full` no MOTOR e o Jev confirma
  // (noul 0.75, acima do corte 0.7) — mesmo respondendo o MENOR noul entre os cinco, `a` não
  // pode perder o lugar para `b`/`c`/`d`/`e` (que o motor só propunha `candidate`, e o Jev
  // promoveu com noul maior). Teto 4: full deve conter `a` e três dos quatro `candidate`s de
  // maior noul (`b`, `c`, `d`); `e` (o de menor noul entre os promovidos) vira `candidate`.
  const cliente = clienteFake({ fn_a: 0.75, fn_b: 0.95, fn_c: 0.92, fn_d: 0.90, fn_e: 0.88 });
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [
    item('a', 0, 'full'),
    item('b', 1, 'candidate'),
    item('c', 2, 'candidate'),
    item('d', 3, 'candidate'),
    item('e', 4, 'candidate'),
  ];
  const out = await refinar(entrada(items, { full: ['a'], candidates: ['b', 'c', 'd', 'e'] }));
  assert.ok(out.full.includes('a'), `a era full no motor e o Jev confirmou — nao pode perder o lugar: ${JSON.stringify(out.full)}`);
  assert.equal(out.full.length, 4, `teto de 4 full: ${JSON.stringify(out.full)}`);
  assert.deepEqual(out.full.sort(), ['a', 'b', 'c', 'd'].sort(), `esperava a+tres maiores noul de b..e: ${JSON.stringify(out.full)}`);
  assert.ok(out.candidates.includes('e'), 'e tinha o menor noul entre os promovidos — vira candidate');
});

test('refinadorDeFuncoes: a pergunta cita "função"', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeFuncoes({ cliente });
  const items = [item('a', 0, 'candidate')];
  await refinar(entrada(items, { full: [], candidates: ['a'] }));
  const texto = cliente.chamadas[0].questions['fn_a'].instructions;
  assert.ok(texto.toLowerCase().includes('função'));
});

// ---------------------------------------------------------------------------------------
// 22/09: o anel `tool` grava as próprias respostas no cache (gancho `aoResponder` de
// `criarRefinadorJev`) — a segunda chamada ao MESMO refinador com o MESMO cache (ex.: o
// segundo `discover` do I3a) só pergunta pelos refs que ainda não têm resposta.
// ---------------------------------------------------------------------------------------

test('refinadorDeFuncoes: grava as próprias respostas no cache — segunda chamada com o mesmo cache só pergunta os refs novos', async () => {
  const cliente = clienteFake({ fn_a: 0.9, fn_b: 0.2, fn_c: 0.5 });
  const mapa = new Map();
  const cache = { obter: (ref) => mapa.get(ref), gravar: (ref, n) => mapa.set(ref, n) };
  const refinar = refinadorDeFuncoes({ cliente, cache });

  const items1 = [item('a', 0, 'candidate'), item('b', 1, 'candidate')];
  await refinar(entrada(items1, { full: [], candidates: ['a', 'b'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['fn_a', 'fn_b']);
  assert.equal(mapa.get('a'), 0.9);
  assert.equal(mapa.get('b'), 0.2);

  const items2 = [item('a', 0, 'candidate'), item('b', 1, 'candidate'), item('c', 2, 'candidate')];
  const out2 = await refinar(entrada(items2, { full: [], candidates: ['a', 'b', 'c'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[1].questions), ['fn_c'], 'a e b já vieram do cache (gravado pela própria chamada anterior), só c é novo');
  assert.equal(out2.explain['a'].reason, 'jev: noul 0.90 (cache)');
  assert.equal(out2.explain['b'].reason, 'jev: noul 0.20 (cache)');
});

// ---------------------------------------------------------------------------------------
// refinadorDeHabilidades (anel `skill`)
// ---------------------------------------------------------------------------------------

test('refinadorDeHabilidades: nenhum seletor de corte, todos os itens vão ao Jev', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeHabilidades({ cliente });
  const items = ['a', 'b', 'c'].map((r, i) => item(r, i, 'candidate'));
  await refinar(entrada(items, { full: [], candidates: items.map((it) => it.ref) }, undefined, 'skill'));
  assert.equal(Object.keys(cliente.chamadas[0].questions).length, 3);
});

test('refinadorDeHabilidades: noul ≥ 0,8 sobe a full, com teto de 1 (o segundo vira candidate)', async () => {
  const cliente = clienteFake({ sk_a: 0.9, sk_b: 0.8 });
  const refinar = refinadorDeHabilidades({ cliente });
  const items = [item('a', 0, 'candidate'), item('b', 1, 'candidate')];
  const out = await refinar(entrada(items, { full: [], candidates: ['a', 'b'] }));
  assert.deepEqual(out.full, ['a']);
  assert.ok(out.candidates.includes('b'));
});

test('refinadorDeHabilidades: noul entre 0,5 e 0,8 vira candidate (0,79 não ativa)', async () => {
  const cliente = clienteFake({ sk_a: 0.5, sk_b: 0.79 });
  const refinar = refinadorDeHabilidades({ cliente });
  const items = [item('a', 0, 'discard'), item('b', 1, 'candidate')];
  const out = await refinar(entrada(items, { full: [], candidates: ['b'] }));
  assert.ok(out.candidates.includes('a'));
  assert.ok(out.candidates.includes('b') && !out.full.includes('b'));
});

test('refinadorDeHabilidades: noul abaixo de 0,5 vira discard (0,49 não sugere)', async () => {
  const cliente = clienteFake({ sk_a: 0.49 });
  const refinar = refinadorDeHabilidades({ cliente });
  const items = [item('a', 0, 'full')];
  const out = await refinar(entrada(items, { full: ['a'], candidates: [] }));
  assert.ok(!out.full.includes('a') && !out.candidates.includes('a'));
});

test('refinadorDeHabilidades: a pergunta cita "habilidade"', async () => {
  const cliente = clienteFake({});
  const refinar = refinadorDeHabilidades({ cliente });
  const items = [item('a', 0, 'candidate')];
  await refinar(entrada(items, { full: [], candidates: ['a'] }));
  const texto = cliente.chamadas[0].questions['sk_a'].instructions;
  assert.ok(texto.toLowerCase().includes('habilidade'));
});

// ---------------------------------------------------------------------------------------
// refinadoresDoChat
// ---------------------------------------------------------------------------------------

test('refinadoresDoChat: sem cliente (sem gateway) devolve objeto vazio — nenhum refinador, J0 continua', () => {
  assert.deepEqual(refinadoresDoChat({ cliente: null }), {});
});

test('refinadoresDoChat: com cliente devolve os três refinadores como funções', () => {
  const cliente = clienteFake({});
  const refs = refinadoresDoChat({ cliente });
  assert.equal(typeof refs.provider, 'function');
  assert.equal(typeof refs.tool, 'function');
  assert.equal(typeof refs.skill, 'function');
});

test('refinadoresDoChat: config.provider.maxFull sobrescreve o padrão', async () => {
  const cliente = clienteFake({ cap_a: 0.9, cap_b: 0.85 });
  const refs = refinadoresDoChat({ cliente, config: { provider: { maxFull: 1 } } });
  const items = [item('a', 0, 'candidate'), item('b', 1, 'candidate')];
  const out = await refs.provider(entrada(items, { full: [], candidates: ['a', 'b'] }));
  assert.deepEqual(out.full, ['a']);
  assert.ok(out.candidates.includes('b'));
});

// ---------------------------------------------------------------------------------------
// Modo V1 (21/09, volta ao comportamento pré-combinado para o próximo teste): `aneis`
// restringe quais anéis são construídos; `funcoesNaChamadaDeCapacidades` (default false)
// desliga as extras de função mesmo com `funcoesDe` presente.
// ---------------------------------------------------------------------------------------

test('refinadoresDoChat: aneis: [provider, skill] não constrói a chave tool', () => {
  const cliente = clienteFake({});
  const refs = refinadoresDoChat({ cliente, aneis: ['provider', 'skill'] });
  assert.equal(typeof refs.provider, 'function');
  assert.equal(typeof refs.skill, 'function');
  assert.ok(!('tool' in refs), 'sem "tool" na lista de aneis, a chave nao deveria existir no objeto devolvido');
});

test('refinadoresDoChat: com funcoesDe mas sem a flag funcoesNaChamadaDeCapacidades, o provider só pergunta cap_*', async () => {
  const cliente = clienteFake({ cap_cal: 0.9 });
  const funcoesDe = (id) => ({
    cal: [{ ref: 'cal/tool/listar', descricao: 'lista eventos', pinned: false }],
  })[id] ?? [];
  const cache = { obter: () => undefined, gravar: () => {} };
  const refs = refinadoresDoChat({ cliente, funcoesDe, cache });
  await refs.provider(entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['cap_cal'], 'sem a flag, nenhuma extra de funcao entra na chamada, mesmo com funcoesDe presente');
});

// ---------------------------------------------------------------------------------------
// Agnosticismo (regra do adendo §14/A1, mesma técnica de perguntas-agnosticas.test.js):
// o TEMPLATE de pergunta de cada refinador não pode citar nome de power/tool real — só o
// que vem interpolado do próprio item (`ref`, `meta.description`).
// ---------------------------------------------------------------------------------------

test('agnosticismo: os três templates só citam o que vem do item, nunca nomes reais de powers', async () => {
  const listaProibida = ['memoria', 'tarefas', 'google-calendar', 'gestao_pessoal', 'async-shadows'];
  const refCaso = 'zz/tool/qq';
  const itemDeTeste = item(refCaso, 0, 'candidate', 0.5, { description: 'zz descricao qq' });

  const clienteProvider = clienteFake({});
  await refinadorDeCapacidades({ cliente: clienteProvider })(entrada([itemDeTeste], { full: [], candidates: [refCaso] }));
  const textoProvider = clienteProvider.chamadas[0].questions[`cap_${refCaso}`].instructions;

  const clienteTool = clienteFake({});
  await refinadorDeFuncoes({ cliente: clienteTool })(entrada([itemDeTeste], { full: [], candidates: [refCaso] }));
  const textoTool = clienteTool.chamadas[0].questions[`fn_${refCaso}`].instructions;

  const clienteSkill = clienteFake({});
  await refinadorDeHabilidades({ cliente: clienteSkill })(entrada([itemDeTeste], { full: [], candidates: [refCaso] }));
  const textoSkill = clienteSkill.chamadas[0].questions[`sk_${refCaso}`].instructions;

  for (const texto of [textoProvider, textoTool, textoSkill]) {
    assert.ok(texto.includes(refCaso), `esperava o ref interpolado no texto: ${texto}`);
    for (const proibido of listaProibida) {
      assert.ok(!texto.toLowerCase().includes(proibido), `template vazou "${proibido}": ${texto}`);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Task 2 (2026-09-21-ajustes-de-uso-da-fabrica): provider pergunta pelas funções das
// capacidades enviadas na mesma chamada (funcoesDe); tool consome o cache; prazo por anel.
// ---------------------------------------------------------------------------------------

test('refinadoresDoChat: o anel provider pergunta também pelas funções das capacidades enviadas (funcoesDe) e grava no cache; o anel tool só pergunta o que não está no cache', async () => {
  const cliente = clienteFake({ cap_cal: 0.9, cap_tar: 0.1, 'fn_cal/tool/listar': 0.8, 'fn_cal/tool/criar': 0.05, 'fn_tar/tool/ver': 0.2 });
  const mapa = new Map();
  const cache = { obter: (ref) => mapa.get(ref), gravar: (ref, n) => mapa.set(ref, n) };
  const funcoesDe = (id) => ({
    cal: [{ ref: 'cal/tool/listar', descricao: 'lista eventos', pinned: false }, { ref: 'cal/tool/criar', descricao: 'cria evento', pinned: false }, { ref: 'cal/tool/status', descricao: 'status', pinned: true }],
    tar: [{ ref: 'tar/tool/ver', descricao: 've tarefa', pinned: false }],
  })[id] ?? [];
  // Modo combinado (não é o default do modo V1): o anel provider só pergunta pelas funções das
  // capacidades na MESMA chamada quando a flag está ligada explicitamente.
  const refs = refinadoresDoChat({ cliente, funcoesDe, cache, config: { funcoesNaChamadaDeCapacidades: true } });

  const outCap = await refs.provider(entrada([item('cal', 0, 'candidate'), item('tar', 1, 'candidate')], { full: [], candidates: ['cal', 'tar'] }));
  assert.deepEqual(outCap.full, ['cal']);
  // pinned NÃO vai como extra (o motor já garante `full` para pinned; perguntar é desperdício)
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['cap_cal', 'cap_tar', 'fn_cal/tool/listar', 'fn_cal/tool/criar', 'fn_tar/tool/ver']);
  assert.equal(mapa.get('cal/tool/listar'), 0.8);
  assert.equal(mapa.get('tar/tool/ver'), 0.2);

  const itensTool = [item('cal/tool/listar', 0, 'candidate', 0.5, { providerId: 'cal' }), item('cal/tool/criar', 1, 'candidate', 0.4, { providerId: 'cal' }), item('cal/tool/novo', 2, 'candidate', 0.3, { providerId: 'cal' })];
  const outTool = await refs.tool(entrada(itensTool, { full: [], candidates: itensTool.map((i) => i.ref) }, undefined, 'tool'));
  assert.equal(cliente.chamadas.length, 2, 'uma segunda chamada, só com o que faltava');
  assert.deepEqual(Object.keys(cliente.chamadas[1].questions), ['fn_cal/tool/novo']);
  assert.deepEqual(outTool.full, ['cal/tool/listar']);
  assert.equal(outTool.explain['cal/tool/listar'].reason, 'jev: noul 0.80 (cache)');
  assert.equal(outTool.explain['cal/tool/criar'].reason, 'jev: noul 0.05 (cache)');
});

test('refinadoresDoChat: extras seguem a ordem do motor (capacidades full primeiro) e cabem no teto de 60 com os itens do anel', async () => {
  const cliente = clienteFake({});
  const funcoesDe = (id) => Array.from({ length: 40 }, (_, i) => ({ ref: `${id}/tool/f${i}`, descricao: '', pinned: false }));
  const refs = refinadoresDoChat({ cliente, funcoesDe, cache: { obter: () => undefined, gravar: () => {} }, config: { funcoesNaChamadaDeCapacidades: true } });
  await refs.provider(entrada([item('b', 0, 'candidate'), item('a', 1, 'full')], { full: ['a'], candidates: ['b'] }));
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.equal(chaves.length, 60);
  assert.equal(chaves[2], 'fn_a/tool/f0', 'funções da capacidade que o motor propôs full vêm antes');
});

// ---------------------------------------------------------------------------------------
// Correção do review da Fase 1 (#3, 2026-09-21-ajustes-de-uso-da-fabrica): extras pulam
// funções já hidratadas (input.state.hydratedTools) — o anel tool já as exclui do seletor
// (meta.hasManual); perguntar de novo aqui só gravaria uma resposta no cache que ninguém lê.
// ---------------------------------------------------------------------------------------

test('refinadoresDoChat: o anel provider não pergunta de novo por função já em state.hydratedTools', async () => {
  const cliente = clienteFake({ cap_cal: 0.9 });
  const funcoesDe = (id) => ({
    cal: [{ ref: 'cal/tool/listar', descricao: 'lista eventos', pinned: false }, { ref: 'cal/tool/criar', descricao: 'cria evento', pinned: false }],
  })[id] ?? [];
  const refs = refinadoresDoChat({ cliente, funcoesDe, cache: { obter: () => undefined, gravar: () => {} }, config: { funcoesNaChamadaDeCapacidades: true } });
  const entradaComHidratadas = {
    ...entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }),
    state: { loadedProviders: [], hydratedTools: ['cal/tool/listar'] },
  };
  await refs.provider(entradaComHidratadas);
  const chaves = Object.keys(cliente.chamadas[0].questions);
  assert.ok(!chaves.includes('fn_cal/tool/listar'), 'já hidratada — a resposta iria só para o cache e nunca seria lida');
  assert.ok(chaves.includes('fn_cal/tool/criar'), 'função não hidratada continua indo como extra');
});

test('refinadoresDoChat: sem funcoesDe/cache, os três anéis se comportam como antes (nenhuma extra, nenhum cache)', async () => {
  const cliente = clienteFake({ cap_a: 0.9 });
  const refs = refinadoresDoChat({ cliente });
  await refs.provider(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['cap_a']);
});

test('refinadoresDoChat: prazo por anel — config.skill.prazoMs vence o prazoMs global só para o anel skill', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 80)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 80 }; } };
  const refs = refinadoresDoChat({ cliente: clienteLento, prazoMs: 20, config: { skill: { prazoMs: 200 } } });
  const outCap = await refs.provider({ ...entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }), budgetMs: 600 });
  assert.equal(outCap.explain['a'].reason, 'jev:degradado (timeout)', 'provider usa o global (20ms) e estoura');
  const outSk = await refs.skill({ ...entrada([item('s', 0, 'candidate')], { full: [], candidates: ['s'] }, undefined, 'skill'), budgetMs: 600 });
  assert.equal(outSk.explain['s'].reason, 'jev: noul 0.90', 'skill usa 200ms e responde');
});

// Instrumentação completa (2026-09-23): `refinadoresDoChat` repassa `aoChamarJev` intacto aos
// TRÊS anéis — cada chamada de volta já identifica QUAL anel foi (`registro.anel`), sem o
// chamador precisar amarrar closures diferentes por anel.
test('refinadoresDoChat: aoChamarJev chega aos três anéis, cada um identificado por `anel`', async () => {
  const cliente = clienteFake({ 'cap_p0': 0.9, 'fn_p0': 0.9, 'sk_p0': 0.9 });
  const chamadas = [];
  const refinadores = refinadoresDoChat({ cliente, aoChamarJev: (r) => chamadas.push(r) });
  await refinadores.provider(entrada([item('p0', 0, 'candidate')], { full: [], candidates: ['p0'] }, undefined, 'provider'));
  await refinadores.tool(entrada([item('p0', 0, 'candidate')], { full: [], candidates: ['p0'] }, undefined, 'tool'));
  await refinadores.skill(entrada([item('p0', 0, 'candidate')], { full: [], candidates: ['p0'] }, undefined, 'skill'));
  assert.deepEqual(chamadas.map((c) => c.anel).sort(), ['provider', 'skill', 'tool']);
  for (const c of chamadas) assert.equal(c.chamouJev, true);
});

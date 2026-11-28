import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aplicarCorteDeCarregada, aplicarCorteDeFuncao, normalizarCorte, embrulharRefinadorDeTool,
  CORTE_CARREGADA_PADRAO, CORTE_SEMANTICAS_PADRAO, carregadasNoInicioDoTurno,
} from '../src/corte-de-funcao.js';

// Portado dos testes do Igris `fabrica-corte-carregada.test.js` e `fabrica-corte-memoria.test.js`:
// `cortesDoAmbiente(env)` virou `normalizarCorte(obj)` e a exclusão fixa da `memoria` virou o parâmetro `excluir`.

// --- normalizarCorte --------------------------------------------------------------------------------------

test('normalizarCorte: padrões, `true` liga com os padrões e ausente deixa a regra da carregada desligada', () => {
  assert.deepEqual(CORTE_CARREGADA_PADRAO, { cabeca: 0.4, z: 2.5, minFuncoes: 4, maxPromovidas: 3, excluir: [] });
  assert.deepEqual(CORTE_SEMANTICAS_PADRAO, { campo: 'notaBase', corte: 0.45, corteKairos: 0.6 });
  const vazio = normalizarCorte({});
  assert.equal(vazio.ativo, true);
  assert.deepEqual(vazio.porCapacidade, {});
  assert.equal(vazio.carregada, undefined, 'sem `carregada` declarada a regra não roda');
  assert.equal(normalizarCorte({ carregada: false }).carregada, undefined);
  assert.deepEqual(normalizarCorte({ carregada: true }).carregada, { ativo: true, ...CORTE_CARREGADA_PADRAO, excluir: [] });
  assert.deepEqual(normalizarCorte({ carregada: { cabeca: 0.5, z: 3, excluir: ['memoria'] } }).carregada, {
    ativo: true, cabeca: 0.5, z: 3, minFuncoes: 4, maxPromovidas: 3, excluir: ['memoria'],
  });
  assert.equal(normalizarCorte({ carregada: { ativo: false } }).carregada.ativo, false);
  assert.equal(normalizarCorte({ ativo: false }).ativo, false);
});

test('normalizarCorte: `semanticasDoPiso` aceita lista ou objeto e completa com os padrões', () => {
  const c = normalizarCorte({ semanticasDoPiso: { memoria: ['mem_listar'], outra: { funcoes: ['x'], corte: 0.3, campo: 'notaCabeca' } } });
  assert.deepEqual(c.porCapacidade.memoria, { campo: 'notaBase', corte: 0.45, corteKairos: 0.6, funcoes: ['mem_listar'] });
  assert.deepEqual(c.porCapacidade.outra, { campo: 'notaCabeca', corte: 0.3, corteKairos: 0.6, funcoes: ['x'] });
});

test('normalizarCorte: valor inválido lança (nunca vira 0, que deixaria tudo passar)', () => {
  assert.throws(() => normalizarCorte({ carregada: { cabeca: 2 } }), /carregada\.cabeca inválido/);
  assert.throws(() => normalizarCorte({ carregada: { z: -1 } }), /carregada\.z inválido/);
  assert.throws(() => normalizarCorte({ carregada: { z: '3' } }), /carregada\.z inválido/);
  assert.throws(() => normalizarCorte({ carregada: { minFuncoes: 0 } }), /carregada\.minFuncoes inválido/);
  assert.throws(() => normalizarCorte({ carregada: { excluir: 'memoria' } }), /carregada\.excluir inválido/);
  assert.throws(() => normalizarCorte({ semanticasDoPiso: { m: { funcoes: ['a'], corte: 5 } } }), /semanticasDoPiso\.m\.corte inválido/);
  assert.throws(() => normalizarCorte({ semanticasDoPiso: { m: { funcoes: ['a'], campo: 'qualquer' } } }), /semanticasDoPiso\.m\.campo inválido/);
  assert.throws(() => normalizarCorte({ semanticasDoPiso: { m: 7 } }), /semanticasDoPiso\.m inválido/);
  assert.throws(() => normalizarCorte('x'), /inválido/);
});

// --- corte da capacidade já carregada ---------------------------------------------------------------------

const ref = (cap, fn) => `${cap}/tool/${fn}`;
const ok = (fn) => ref('okapp', fn);
const item = (cap, fn, final, meta = {}) => ({ ref: ref(cap, fn), scores: { final }, meta: { providerId: cap, ...meta } });
// 10 funções do okapp: f0 se destaca (0,80) e as outras ficam em 0,50 → z(f0) = 3,0; z(demais) ≈ -0,33.
const catalogo = () => [item('okapp', 'f0', 0.8), ...Array.from({ length: 9 }, (_, i) => item('okapp', `f${i + 1}`, 0.5))];
const cfg = (extra = {}) => ({ ativo: true, cabeca: 0.4, z: 2.5, minFuncoes: 4, maxPromovidas: 3, excluir: ['memoria'], ...extra });
// O input.state do kairos traz TUDO (inclusive o que foi promovido neste turno) — o corte tem de ignorá-lo.
const entrada = (items) => ({ items, state: { loadedProviders: ['okapp', 'navegador', 'memoria', 'tarefas'] } });
const aplicar = (saida, items, carregadas, c = cfg(), registro = []) => aplicarCorteDeCarregada(saida, entrada(items), c, registro, undefined, carregadas);
const cabeca = (pares) => Object.fromEntries(pares.map(([fn, nota]) => [ok(fn), { notaCabeca: nota, reason: 'local:cabeca' }]));

test('1ª carga (capacidade fora de loadedProviders) passa intacta', () => {
  const saida = { full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) };
  assert.equal(aplicar(saida, catalogo(), [], cfg()), saida);
  assert.equal(aplicar(saida, catalogo(), ['navegador'], cfg()), saida);
});

test('capacidade carregada: full sem nota da cabeça nem destaque vira candidate, com motivo e registro', () => {
  const saida = { full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) };
  const registro = [];
  const r = aplicar(saida, catalogo(), ['okapp'], cfg(), registro);
  assert.deepEqual(r.full, []);
  assert.ok(r.candidates.includes(ok('f1')));
  assert.match(r.explain[ok('f1')].reason, /\(corte-carregada\)/);
  assert.equal(registro.length, 1);
  assert.equal(registro[0].regra, 'carregada');
  assert.equal(registro[0].capacidade, 'okapp');
  assert.equal(registro[0].passa, false);
  assert.equal(registro[0].eraFull, true);
  assert.equal(registro[0].notaCabeca, 0.1);
  assert.ok(registro[0].z < 0);
  assert.equal(registro[0].final, 0.5);
  assert.equal(registro[0].ativo, true);
  assert.equal(registro[0].chamada, 1);
});

test('fica full: cabeça ≥ 0,4 ou destaque z ≥ 2,5 (mesmo com cabeça baixa)', () => {
  const saida = { full: [ok('f0'), ok('f2')], candidates: [], explain: cabeca([['f0', 0.1], ['f2', 0.5]]) };
  const r = aplicar(saida, catalogo(), ['okapp'], cfg());
  assert.deepEqual(r.full, [ok('f0'), ok('f2')]);
});

test('promove candidate que passa, até 3 por capacidade, pela nota da cabeça', () => {
  const saida = {
    full: [], candidates: [ok('f1'), ok('f2'), ok('f3'), ok('f4'), ok('f5')],
    explain: cabeca([['f1', 0.45], ['f2', 0.9], ['f3', 0.6], ['f4', 0.7], ['f5', 0.2]]),
  };
  const registro = [];
  const r = aplicar(saida, catalogo(), ['okapp'], cfg(), registro);
  assert.deepEqual(r.full, [ok('f2'), ok('f4'), ok('f3')]);
  assert.deepEqual(r.candidates, [ok('f1'), ok('f5')]);
  assert.match(r.explain[ok('f2')].reason, /\(corte-carregada:promovida\)/);
  assert.equal(registro.filter((x) => x.promovida).length, 3);
});

test('`maxPromovidas` do host troca o teto de promoções', () => {
  const saida = {
    full: [], candidates: [ok('f1'), ok('f2'), ok('f3')],
    explain: cabeca([['f1', 0.9], ['f2', 0.8], ['f3', 0.7]]),
  };
  assert.deepEqual(aplicar(saida, catalogo(), ['okapp'], cfg({ maxPromovidas: 1 })).full, [ok('f1')]);
});

test('não mexe em pinned nem em função que já tem manual', () => {
  const items = catalogo().map((x) => (x.ref === ok('f1') ? { ...x, meta: { ...x.meta, pinned: true } }
    : x.ref === ok('f2') ? { ...x, meta: { ...x.meta, hasManual: true } } : x));
  const saida = { full: [ok('f1'), ok('f2')], candidates: [], explain: cabeca([['f1', 0.1], ['f2', 0.1]]) };
  const registro = [];
  assert.equal(aplicar(saida, items, ['okapp'], cfg(), registro), saida);
  assert.equal(registro.length, 0);
});

test('capacidade de `excluir` não passa por esta regra', () => {
  const items = ['mem_listar', 'mem_remover', 'mt_ler', 'mt_limpar', 'mem_categorias'].map((f) => item('memoria', f, 0.5));
  const saida = { full: [ref('memoria', 'mem_listar')], candidates: [], explain: { [ref('memoria', 'mem_listar')]: { notaCabeca: 0.1 } } };
  assert.equal(aplicar(saida, items, ['memoria'], cfg()), saida);
  // sem `excluir`, a mesma capacidade é cortada: a lista é do host, não da fábrica.
  assert.deepEqual(aplicar(saida, items, ['memoria'], cfg({ excluir: [] })).full, []);
});

test('sem nota da cabeça em ninguém (fallback): vale só o z e não promove', () => {
  const saida = { full: [ok('f1')], candidates: [ok('f0')], explain: {} };
  const r = aplicar(saida, catalogo(), ['okapp'], cfg());
  assert.deepEqual(r.full, []);
  assert.ok(r.candidates.includes(ok('f0')) && r.candidates.includes(ok('f1')));
});

test('desligado: saída idêntica, decisão registrada com ativo false', () => {
  const saida = { full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) };
  const registro = [];
  assert.equal(aplicar(saida, catalogo(), ['okapp'], cfg({ ativo: false }), registro), saida);
  assert.equal(registro[0].passa, false);
  assert.equal(registro[0].ativo, false);
});

test('capacidade com menos de 4 funções: o z não conta', () => {
  const items = [item('okapp', 'g0', 0.9), item('okapp', 'g1', 0.5), item('okapp', 'g2', 0.5)];
  const saida = { full: [ok('g0')], candidates: [], explain: cabeca([['g0', 0.1]]) };
  const registro = [];
  const r = aplicar(saida, items, ['okapp'], cfg(), registro);
  assert.deepEqual(r.full, []);
  assert.equal(registro[0].z, null);
});

test('sem configuração da regra: saída idêntica', () => {
  const saida = { full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) };
  assert.equal(aplicarCorteDeCarregada(saida, entrada(catalogo()), undefined, [], undefined, ['okapp']), saida);
});

// --- embrulho do refinador do anel tool -------------------------------------------------------------------

const cortesDoEmbrulho = () => normalizarCorte({ carregada: { excluir: ['memoria'] } });
const entradaDoAnel = (extra = {}) => ({
  ring: 'tool', budgetMs: 200,
  proposal: { full: [ok('f1')], candidates: [ok('f0')] },
  items: catalogo(),
  state: { loadedProviders: ['okapp'] },
  ...extra,
});

test('embrulho: refinador ok → o corte da capacidade carregada vale, numerado na mesma chamada', async () => {
  const saida = { full: [ok('f1')], candidates: [ok('f0'), ok('f2')], explain: cabeca([['f1', 0.1], ['f2', 0.8]]) };
  const registro = [];
  const r = await embrulharRefinadorDeTool({ refinar: () => saida, registro, cortes: cortesDoEmbrulho(), carregadasNoInicio: ['okapp'] })(entradaDoAnel());
  assert.deepEqual(r.full, [ok('f2'), ok('f0')], 'f1 rebaixada; f2 promovida pela cabeça; f0 promovida pelo destaque');
  assert.ok(registro.length > 0 && registro.every((x) => x.chamada === 1));
});

test('embrulho: refinador que lança → corte sobre a proposta (só z, sem promoção), marcador e decisões na mesma chamada', async () => {
  const registro = [];
  const r = await embrulharRefinadorDeTool({ refinar: () => { throw new Error('x'); }, registro, cortes: cortesDoEmbrulho(), carregadasNoInicio: ['okapp'] })(entradaDoAnel());
  assert.deepEqual(r.full, []);
  assert.ok(r.candidates.includes(ok('f0')) && r.candidates.includes(ok('f1')));
  assert.equal(registro[0].refinador, 'fallback:erro');
  assert.ok(registro.every((x) => x.chamada === 1));
});

test('embrulho: duas chamadas do anel no mesmo turno numeram 1 e 2', async () => {
  const registro = [];
  const embrulho = embrulharRefinadorDeTool({ refinar: () => ({ full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) }), registro, cortes: cortesDoEmbrulho(), carregadasNoInicio: ['okapp'] });
  await embrulho(entradaDoAnel());
  await embrulho(entradaDoAnel());
  assert.deepEqual([...new Set(registro.map((x) => x.chamada))], [1, 2]);
});

test('embrulho sem carregadasNoInicio: nenhuma capacidade conta como carregada (o input.state é ignorado)', async () => {
  const saida = { full: [ok('f1')], candidates: [], explain: cabeca([['f1', 0.1]]) };
  const r = await embrulharRefinadorDeTool({ refinar: () => saida, registro: [], cortes: cortesDoEmbrulho() })(entradaDoAnel());
  assert.deepEqual(r.full, [ok('f1')]);
});

test('embrulho sem refinador do host: corta a proposta do motor', async () => {
  const registro = [];
  const r = await embrulharRefinadorDeTool({ refinar: null, registro, cortes: cortesDoEmbrulho(), carregadasNoInicio: ['okapp'] })(entradaDoAnel());
  assert.deepEqual(r.full, []);
  assert.ok(r.candidates.includes(ok('f1')));
});

test('embrulho: refinador lento, que devolve lixo ou formato inválido → corte sobre a proposta, antes do prazo', async () => {
  const casos = {
    invalido: () => ({ nada: 1 }),
    semCandidates: () => ({ full: [ok('f1')] }),
    listaSuja: () => ({ full: [ok('f1'), 42], candidates: [] }),
    timeout: () => new Promise((resolver) => setTimeout(() => resolver({ full: [], candidates: [] }), 1000)),
  };
  for (const [motivo, refinar] of Object.entries(casos)) {
    const registro = [];
    const t0 = Date.now();
    const r = await embrulharRefinadorDeTool({ refinar, registro, cortes: cortesDoEmbrulho(), carregadasNoInicio: ['okapp'] })(entradaDoAnel());
    assert.ok(Date.now() - t0 < 200, `${motivo}: respondeu antes do budget do Kairos`);
    assert.deepEqual(r.full, [], motivo);
    assert.equal(registro[0].refinador, `fallback:${['semCandidates', 'listaSuja'].includes(motivo) ? 'invalido' : motivo}`);
    assert.ok(registro.every((x) => x.chamada === 1), `${motivo}: marcador e decisões na mesma chamada`);
  }
});

// Decisão do dono do Igris (2026-11-25): capacidade fixa (piso) conta como carregada. Sessão 5a5eda4e: depois de
// um turno trivial (discover não roda, `loadedProviders` vazio) as funções `preparo_*` do piso entravam no meio
// do system com cabeça 0,006–0,048, tratadas como 1ª carga.
test('regressão: depois de turno trivial, capacidade do piso conta como carregada e função com cabeça baixa vira candidate', () => {
  assert.deepEqual(carregadasNoInicioDoTurno(undefined, ['autorizacoes', 'memoria']), ['autorizacoes', 'memoria']);
  assert.deepEqual(carregadasNoInicioDoTurno(['okapp', 'memoria'], ['memoria', 'tela']), ['okapp', 'memoria', 'tela']);
  const aut = (fn) => ref('autorizacoes', fn);
  const items = [
    item('autorizacoes', 'preparo_autorizar', 0.445),
    item('autorizacoes', 'preparo_listar', 0.465),
    item('autorizacoes', 'preparo_revogar', 0.469),
    item('autorizacoes', 'confirmacao_responder', 0.459, { pinned: true }),
  ];
  const saida = {
    full: [aut('preparo_autorizar'), aut('preparo_listar'), aut('preparo_revogar')],
    candidates: [],
    explain: Object.fromEntries([['preparo_autorizar', 0.037], ['preparo_listar', 0.048], ['preparo_revogar', 0.006]]
      .map(([fn, nota]) => [aut(fn), { notaCabeca: nota, reason: 'local:cabeca' }])),
  };
  const r = aplicar(saida, items, carregadasNoInicioDoTurno([], ['autorizacoes']));
  assert.deepEqual(r.full, []);
  for (const fn of ['preparo_autorizar', 'preparo_listar', 'preparo_revogar']) assert.ok(r.candidates.includes(aut(fn)), fn);
  // Pedido de verdade (cabeça ≥ 0,4) continua carregando o manual.
  const pedido = { full: [aut('preparo_autorizar')], candidates: [], explain: { [aut('preparo_autorizar')]: { notaCabeca: 0.9, reason: 'local:cabeca' } } };
  assert.deepEqual(aplicar(pedido, items, carregadasNoInicioDoTurno([], ['autorizacoes'])).full, [aut('preparo_autorizar')]);
});

// --- funções semânticas do piso (a antiga regra da `memoria`) ---------------------------------------------

const refM = (f) => `memoria/tool/${f}`;
const itemM = (f, extra = {}) => ({ ref: refM(f), scores: { final: extra.final ?? 0.4 }, meta: { pinned: !!extra.pinned, hasManual: !!extra.hasManual } });
const SEMANTICAS = ['mem_listar', 'mem_remover', 'mt_ler', 'mt_limpar', 'aprendizado_listar', 'aprendizado_revisar', 'aprendizado_aplicar'];
const cortes = (ativo = true) => normalizarCorte({ ativo, semanticasDoPiso: { memoria: SEMANTICAS } });

test('semânticas do piso: abaixo da nota vira candidate; acima fica full', () => {
  const saida = {
    full: [refM('mem_listar'), refM('mem_remover')], candidates: [],
    explain: { [refM('mem_listar')]: { notaBase: 0.31, reason: 'local:base (texto)' }, [refM('mem_remover')]: { notaBase: 0.72 } },
  };
  const registro = [];
  const r = aplicarCorteDeFuncao(saida, { items: [itemM('mem_listar'), itemM('mem_remover')] }, cortes(), registro);
  assert.deepEqual(r.full, [refM('mem_remover')]);
  assert.ok(r.candidates.includes(refM('mem_listar')));
  assert.match(r.explain[refM('mem_listar')].reason, /corte-semanticas-do-piso/);
  assert.equal(registro.length, 2);
});

test('semânticas do piso: não mexe em função do piso, em função já carregada nem em outra capacidade', () => {
  const saida = { full: [refM('mt_ler'), refM('mem_listar'), 'tarefas/tool/task_listar'], candidates: [], explain: {} };
  const r = aplicarCorteDeFuncao(saida, {
    items: [itemM('mt_ler', { pinned: true }), itemM('mem_listar', { hasManual: true }), { ref: 'tarefas/tool/task_listar', scores: { final: 0.2 }, meta: {} }],
  }, cortes());
  assert.deepEqual(r.full, saida.full, 'nada rebaixado');
});

test('semânticas do piso: sem nota do refinador, vale a nota do Kairos contra o corte mais alto', () => {
  const saida = { full: [refM('aprendizado_listar'), refM('aprendizado_revisar')], candidates: [], explain: {} };
  const r = aplicarCorteDeFuncao(saida, { items: [itemM('aprendizado_listar', { final: 0.65 }), itemM('aprendizado_revisar', { final: 0.45 })] }, cortes());
  assert.deepEqual(r.full, [refM('aprendizado_listar')]);
});

test('semânticas do piso promove: candidate com nota acima do corte vira full, até 3 pela nota', () => {
  const nomes = ['mem_listar', 'mem_remover', 'mt_ler', 'mt_limpar', 'aprendizado_aplicar'];
  const notas = [0.46, 0.9, 0.7, 0.8, 0.3];
  const saida = {
    full: [], candidates: nomes.map(refM),
    explain: Object.fromEntries(nomes.map((f, i) => [refM(f), { notaBase: notas[i], reason: 'local:base' }])),
  };
  const registro = [];
  const r = aplicarCorteDeFuncao(saida, { items: nomes.map((f) => itemM(f)) }, cortes(), registro);
  assert.deepEqual(r.full, [refM('mem_remover'), refM('mt_limpar'), refM('mt_ler')]);
  assert.deepEqual(r.candidates, [refM('mem_listar'), refM('aprendizado_aplicar')]);
  assert.match(r.explain[refM('mem_remover')].reason, /corte-semanticas-do-piso:promovida/);
  assert.equal(registro.filter((x) => x.promovida).length, 3);
});

test('semânticas do piso não promove sem nota do refinador, nem desligado, nem o que já tem manual', () => {
  const saida = { full: [], candidates: [refM('aprendizado_listar'), refM('mem_listar')], explain: { [refM('mem_listar')]: { notaBase: 0.9 } } };
  const itens = { items: [itemM('aprendizado_listar', { final: 0.95 }), itemM('mem_listar', { hasManual: true })] };
  assert.deepEqual(aplicarCorteDeFuncao(saida, itens, cortes()).full, []);
  const s2 = { full: [], candidates: [refM('mem_listar')], explain: { [refM('mem_listar')]: { notaBase: 0.9 } } };
  assert.deepEqual(aplicarCorteDeFuncao(s2, { items: [itemM('mem_listar')] }, cortes(false)).full, []);
});

test('semânticas do piso desligado (`ativo: false`): registra a decisão, não rebaixa', () => {
  const saida = { full: [refM('mem_listar')], candidates: [], explain: { [refM('mem_listar')]: { notaBase: 0.1 } } };
  const registro = [];
  const r = aplicarCorteDeFuncao(saida, { items: [itemM('mem_listar')] }, cortes(false), registro);
  assert.deepEqual(r.full, [refM('mem_listar')]);
  assert.equal(registro[0].passa, false);
  assert.equal(registro[0].ativo, false);
});

test('registro numera a chamada; promovida só marca a chamada em que promoveu', () => {
  const registro = [];
  const s = () => ({ full: [], candidates: [refM('mem_remover')], explain: { [refM('mem_remover')]: { notaBase: 0.9 } } });
  aplicarCorteDeFuncao(s(), { items: [itemM('mem_remover')] }, cortes(), registro);
  aplicarCorteDeFuncao({ full: [refM('mem_remover')], candidates: [], explain: { [refM('mem_remover')]: { notaBase: 0.9 } } }, { items: [itemM('mem_remover')] }, cortes(), registro);
  assert.deepEqual(registro.map((r) => [r.chamada, !!r.promovida]), [[1, true], [2, false]]);
});

test('embrulho com semânticas do piso: refinador que lança → corte sobre a proposta (regra do final)', async () => {
  const registro = [];
  const entradaM = {
    ring: 'tool', budgetMs: 200,
    proposal: { full: [refM('mem_listar'), 'tarefas/tool/task_listar'], candidates: [refM('mem_remover')] },
    items: [itemM('mem_listar', { final: 0.5 }), itemM('mem_remover', { final: 0.7 }), { ref: 'tarefas/tool/task_listar', scores: { final: 0.3 }, meta: {} }],
  };
  const r = await embrulharRefinadorDeTool({ refinar: () => { throw new Error('x'); }, registro, cortes: cortes() })(entradaM);
  // mem_listar (final 0,5 < 0,6) rebaixada; task_listar (outra capacidade) intocada; mem_remover sem nota não promove
  assert.deepEqual(r.full, ['tarefas/tool/task_listar']);
  assert.ok(r.candidates.includes(refM('mem_listar')) && r.candidates.includes(refM('mem_remover')));
  assert.equal(registro[0].refinador, 'fallback:erro');
});

// --- integração: o corte entra no anel `tool` da fábrica ---------------------------------------------------

import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const estadoCom = (loadedProviders) => ({ system: systemVazio(), turno: 1, kairos: { ...ESTADO_KAIROS_VAZIO, loadedProviders } });

const ferramenta = (name, description) => ({ name, description, schema: z.object({}), handler: async () => ({}) });
const notas = () => ({
  id: 'notas', descricao: 'Notas.', piso: false, semanticText: 'notas anotações lembretes agenda',
  tools: [
    ferramenta('criar', 'criar nova nota anotação'),
    ferramenta('listar', 'listar notas anotações existentes'),
    ferramenta('apagar', 'apagar remover nota'),
    ferramenta('buscar', 'buscar procurar nota por texto'),
    ferramenta('exportar', 'exportar notas para arquivo'),
  ],
});

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [notas()],
    embedder: null,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: () => ({
      name: 'fake', model: 'fake-1',
      capabilities: {
        streaming: false, usage: false, cancellation: false, structuredOutput: true,
        nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
      },
      async generate() {
        return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
      },
    }),
    decorarTool: (nome, definicao) => definicao,
    ...extra,
  });
}

const TEXTO_NOTAS = 'listar notas anotações existentes';
const hidratadas = (turno) => turno.discover.tools.hydrate;
const explicacao = (turno, ref) => JSON.stringify(turno.discover.explain.find((e) => e.ref === ref) ?? null);

test('integração: sem o campo, a função de capacidade já carregada segue `full` (sem mudança para quem não liga)', async () => {
  const turno = await fabrica().executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom(['notas']) });
  assert.ok(hidratadas(turno).includes('notas/tool/listar'));
  assert.ok(!('corteDeFuncao' in turno));
});

test('integração: sem refinador do host, capacidade já carregada, z abaixo de 2,5 → vira candidate com `corte-carregada`', async () => {
  const infos = [];
  const turno = await fabrica({
    corteDeFuncao: { carregada: { cabeca: 0.4, z: 2.5 } },
    aoMontar: (i) => infos.push(i),
  }).executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom(['notas']) });
  assert.ok(!hidratadas(turno).includes('notas/tool/listar'), 'rebaixada: sem manual neste turno');
  assert.match(explicacao(turno, 'notas/tool/listar'), /corte-carregada/);
  // O registro das decisões sai no retorno e no aoMontar.
  const decisao = turno.corteDeFuncao.find((d) => d.ref === 'notas/tool/listar');
  assert.equal(decisao.regra, 'carregada');
  assert.equal(decisao.passa, false);
  assert.equal(decisao.eraFull, true);
  assert.deepEqual(infos[0].corteDeFuncao, turno.corteDeFuncao);
});

test('integração: 1ª carga da capacidade (fora do `loadedProviders` do fim do turno anterior) passa intacta', async () => {
  const turno = await fabrica({ corteDeFuncao: { carregada: { cabeca: 0.4, z: 2.5 } } })
    .executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom([]) });
  assert.ok(hidratadas(turno).includes('notas/tool/listar'));
});

test('integração: capacidade promovida NESTE turno pela carga por chave não conta como já carregada', async () => {
  const turno = await fabrica({
    catalogoDeChaves: ['anotando'],
    chaves: () => ['anotando'],
    cargaPorChave: { anotando: ['notas'] },
    corteDeFuncao: { carregada: { cabeca: 0.4, z: 2.5 } },
  }).executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom([]) });
  assert.ok(hidratadas(turno).includes('notas/tool/listar'), 'a base é o fim do turno anterior, não o estado com as promoções do turno');
});

test('integração: `excluir` e `ativo: false` deixam a função full; o refinador do host é embrulhado, não substituído', async () => {
  const excluida = await fabrica({ corteDeFuncao: { carregada: { excluir: ['notas'] } } })
    .executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom(['notas']) });
  assert.ok(hidratadas(excluida).includes('notas/tool/listar'));
  const soRegistra = await fabrica({ corteDeFuncao: { carregada: { ativo: false } } })
    .executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom(['notas']) });
  assert.ok(hidratadas(soRegistra).includes('notas/tool/listar'));
  assert.equal(soRegistra.corteDeFuncao.find((d) => d.ref === 'notas/tool/listar').ativo, false);

  let chamadas = 0;
  const doHost = await fabrica({
    refinadores: { tool: (input) => { chamadas += 1; return { full: input.proposal.full, candidates: input.proposal.candidates }; } },
    corteDeFuncao: { carregada: { cabeca: 0.4, z: 2.5 } },
  }).executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom(['notas']) });
  assert.equal(chamadas, 1, 'o refinador do host continua sendo chamado');
  assert.ok(!hidratadas(doHost).includes('notas/tool/listar'), 'e o corte vale sobre a saída dele');
});

test('integração: `corteDeFuncao` inválido recusa a montagem com a causa', async () => {
  await assert.rejects(
    () => fabrica({ corteDeFuncao: { carregada: { cabeca: 7 } } }).executarTurno({ texto: TEXTO_NOTAS, estado: estadoCom([]) }),
    /corteDeFuncao\.carregada\.cabeca inválido/,
  );
});

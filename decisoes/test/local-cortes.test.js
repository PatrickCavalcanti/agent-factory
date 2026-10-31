// packages/decisions/test/local-cortes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { montarIndice, centroideDe } from '../src/local/indice.js';
import { calibrarCortes, semRoubados, aplicarRoubadosMantidos, PARAMETROS_CORTES } from '../src/local/cortes.js';
import { capacidadeDoRef } from '../src/local/refs.js';
import { embedderFalso, embedderTabela, TABELA, caps } from './helpers/fixtures.js';

test('deixa-um-de-fora: o exemplo não se compara consigo mesmo e, sem nota própria, não rouba', async () => {
  // um único exemplo por nó e sem texto: deixar de fora não sobra nada → sem "certa", sem roubo
  const ind = await montarIndice({ anel: 'provider', capacidades: [{ id: 'x', tools: [{ name: 'a', exemplos: ['agenda'] }] }, { id: 'y', tools: [{ name: 'b', exemplos: ['tarefa'] }] }], embedder: embedderFalso() });
  const r = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  assert.equal(r.resumo.certas, 0);
  assert.deepEqual(r.roubados, []);
});

test('calcula cortes e marca o exemplo que rouba, com índice, texto e destino', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: caps(), embedder: embedderTabela(TABELA) });
  const r = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  assert.equal(r.origem, 'calculado');
  assert.ok(r.full !== null && r.candidate !== null && r.candidate <= r.full);
  // anel provider: o nó é a capacidade, então o destino nunca é "irmão" (irmao sempre false)
  assert.deepEqual(r.roubados, [{ ref: 'tarefas', i: 2, texto: 'b-rouba', para: 'agenda', irmao: false }]);
  assert.deepEqual(r.resumo, { certas: 7, erradas: 14, roubados: 1, roubadosIrmaos: 0, roubadosMascarados: 0 });
});

// Anel tool: a/tool/x e a/tool/y são irmãs (mesma capacidade 'a'); b/tool/z é de outra capacidade.
// 'x-irmao' está em x mas casa melhor com y (irmã); 'x-rouba' está em x mas casa melhor com z (outra capacidade).
// Os dois ladrões ficam a meio caminho do destino (não colados nos exemplos dele): senão, depois de centrar, o
// exemplo do destino (y1/z1) também "roubaria" de volta e o teste mediria outra coisa.
const TABELA_TOOL = {
  'x-texto': [1, 0, 0], x1: [0.99, 0.1, 0.05], 'x-irmao': [0.45, 0.8, 0.05], 'x-rouba': [0.45, 0.05, 0.8],
  'y-texto': [0, 1, 0], y1: [0.1, 0.98, 0.05], y2: [-0.1, 0.97, 0.1],
  'z-texto': [0, 0, 1], z1: [0.05, 0.1, 0.99], z2: [-0.05, -0.1, 0.98],
};
const capsTool = () => [
  { id: 'a', tools: [
    { name: 'x', semanticText: 'x-texto', exemplos: ['x1', 'x-irmao', 'x-rouba'] },
    { name: 'y', semanticText: 'y-texto', exemplos: ['y1', 'y2'] },
  ] },
  { id: 'b', tools: [{ name: 'z', semanticText: 'z-texto', exemplos: ['z1', 'z2'] }] },
];

test('D3: roubado por IRMÃO (mesma capacidade) é marcado irmao:true e semRoubados o mantém; roubado por outra capacidade sai', async () => {
  const ind = await montarIndice({ anel: 'tool', capacidades: capsTool(), embedder: embedderTabela(TABELA_TOOL) });
  const cal = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  const porDestino = Object.fromEntries(cal.roubados.map((r) => [r.para, r]));
  assert.equal(porDestino['a/tool/y'].irmao, true);
  assert.equal(porDestino['a/tool/y'].texto, 'x-irmao');
  assert.equal(porDestino['b/tool/z'].irmao, false);
  assert.equal(porDestino['b/tool/z'].texto, 'x-rouba');
  const limpo = semRoubados(ind, cal.roubados);
  const antes = ind.nos.get('a/tool/x');
  const depois = limpo.nos.get('a/tool/x');
  assert.equal(depois.vetores.length, antes.vetores.length - 1); // só o roubado pela outra capacidade saiu
  assert.ok(depois.origens.some((o) => o.tipo === 'exemplo' && o.i === 1), 'o exemplo roubado por irmã (i=1) continua no índice');
  assert.ok(!depois.origens.some((o) => o.tipo === 'exemplo' && o.i === 2), 'o exemplo roubado por outra capacidade (i=2) saiu');
  assert.deepEqual(depois.centroide, centroideDe(depois.vetores));
  assert.equal(cal.resumo.roubadosIrmaos, 1);
  assert.equal(cal.resumo.roubados, 2);
  assert.equal(cal.resumo.roubadosMascarados, 0); // x-irmao só é batido pela irmã: nenhuma outra capacidade o supera
});

test('roubadosMascarados: roubado por irmão que OUTRA capacidade também bate — fica no índice (regra intacta) mas entra na contagem', async () => {
  // x-sombra está em a/x e fica mais perto de a/y (irmã) E de b/z (outra capacidade) do que do próprio a/x
  const T = {
    'x-texto': [1, 0, 0], x1: [0.99, 0.1, 0.05], 'x-sombra': [0.0, 0.8, 0.7],
    'y-texto': [0, 1, 0], y1: [0.1, 0.98, 0.05], y2: [-0.1, 0.97, 0.1],
    'z-texto': [0, 0, 1], z1: [0.05, 0.1, 0.99], z2: [-0.05, -0.1, 0.98],
  };
  const capacidades = [
    { id: 'a', tools: [{ name: 'x', semanticText: 'x-texto', exemplos: ['x1', 'x-sombra'] }, { name: 'y', semanticText: 'y-texto', exemplos: ['y1', 'y2'] }] },
    { id: 'b', tools: [{ name: 'z', semanticText: 'z-texto', exemplos: ['z1', 'z2'] }] },
  ];
  const ind = await montarIndice({ anel: 'tool', capacidades, embedder: embedderTabela(T) });
  const cal = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  // o melhor destino é a irmã (a/y); a/z (outra capacidade) também passa da nota própria — o irmão MASCARA esse roubo
  assert.deepEqual(cal.roubados, [{ ref: 'a/tool/x', i: 1, texto: 'x-sombra', para: 'a/tool/y', irmao: true }]);
  assert.deepEqual(cal.resumo, { certas: cal.resumo.certas, erradas: cal.resumo.erradas, roubados: 1, roubadosIrmaos: 1, roubadosMascarados: 1 });
  // só contagem: a regra não muda — o exemplo continua no índice
  const limpo = semRoubados(ind, cal.roubados);
  assert.equal(limpo.nos.get('a/tool/x').vetores.length, ind.nos.get('a/tool/x').vetores.length);
});

test('semRoubados: entrada SEM o campo irmao (lista antiga) sai do índice; irmao:false sai; só irmao:true fica', async () => {
  const ind = await montarIndice({ anel: 'tool', capacidades: capsTool(), embedder: embedderTabela(TABELA_TOOL) });
  const n = ind.nos.get('a/tool/x').vetores.length;
  const sai = (r) => n - semRoubados(ind, [r]).nos.get('a/tool/x').vetores.length;
  assert.equal(sai({ ref: 'a/tool/x', i: 1, para: 'a/tool/y' }), 1); // sem `irmao`: regra antiga
  assert.equal(sai({ ref: 'a/tool/x', i: 1, para: 'a/tool/y', irmao: false }), 1);
  assert.equal(sai({ ref: 'a/tool/x', i: 1, para: 'a/tool/y', irmao: true }), 0);
});

test('capacidadeDoRef: provider é a própria ref; tool e skill, o prefixo da capacidade', () => {
  assert.equal(capacidadeDoRef('provider', 'agenda'), 'agenda');
  assert.equal(capacidadeDoRef('tool', 'google-calendar/tool/gcal_listar'), 'google-calendar');
  assert.equal(capacidadeDoRef('skill', 'tarefas/skill/rotina'), 'tarefas');
});

test('semRoubados tira só o roubado, recalcula o centroide e não altera o original', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: caps(), embedder: embedderTabela(TABELA) });
  const r = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  const limpo = semRoubados(ind, r.roubados);
  const antes = ind.nos.get('tarefas');
  const depois = limpo.nos.get('tarefas');
  assert.equal(depois.vetores.length, antes.vetores.length - 1);
  assert.equal(antes.vetores.length, 4); // texto + 3 exemplos; o original não é alterado
  assert.deepEqual(depois.centroide, centroideDe(depois.vetores));
  assert.notDeepEqual(depois.centroide, antes.centroide);
  assert.deepEqual(limpo.nos.get('agenda').centroide, centroideDe(limpo.nos.get('agenda').vetores));
});

test('semRoubados apaga o nó que fica sem vetores', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: [{ id: 'x', tools: [{ name: 'a', exemplos: ['agenda'] }] }, { id: 'y', tools: [{ name: 'b', exemplos: ['tarefa'] }] }], embedder: embedderFalso() });
  const limpo = semRoubados(ind, [{ ref: 'x', i: 0, para: 'y' }]);
  assert.deepEqual([...limpo.nos.keys()], ['y']);
  assert.equal(ind.nos.size, 2);
});

test('poucos exemplos → origem sem-cortes; override vence', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: caps(), embedder: embedderTabela(TABELA) });
  assert.equal((await calibrarCortes(ind, {})).origem, 'sem-cortes');
  const o = await calibrarCortes(ind, { override: { full: 0.9, candidate: 0.4 } });
  assert.deepEqual([o.origem, o.full, o.candidate], ['override', 0.9, 0.4]);
  assert.equal(PARAMETROS_CORTES.minExemplos, 20);
});

test('cessão do laço por volume de produtos: resultado idêntico, mesmo cedendo a cada produto', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: caps(), embedder: embedderTabela(TABELA) });
  const padrao = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  let cedeu = 0;
  const original = globalThis.setImmediate;
  globalThis.setImmediate = (f, ...a) => { cedeu++; return original(f, ...a); };
  let apertado;
  try { apertado = await calibrarCortes(ind, { parametros: { minExemplos: 1 }, cederAPorProdutos: 1 }); } finally { globalThis.setImmediate = original; }
  assert.ok(cedeu > 1, 'cede várias vezes quando o limite é pequeno');
  assert.deepEqual(apertado, padrao);
});

test('aplicarRoubadosMantidos: com o mesmo catálogo equivale a semRoubados (irmão fica, outra capacidade sai, centroide recalculado)', async () => {
  const ind = await montarIndice({ anel: 'tool', capacidades: capsTool(), embedder: embedderTabela(TABELA_TOOL) });
  const cal = await calibrarCortes(ind, { parametros: { minExemplos: 1 } });
  const ref = semRoubados(ind, cal.roubados);
  const { indice, removidos } = aplicarRoubadosMantidos(ind, cal.roubados);
  assert.equal(removidos, 1);
  assert.deepEqual([...indice.nos.keys()], [...ref.nos.keys()]);
  for (const [k, no] of ref.nos) {
    assert.deepEqual(indice.nos.get(k).origens, no.origens, k);
    assert.deepEqual(indice.nos.get(k).vetores, no.vetores, k);
    assert.deepEqual(indice.nos.get(k).centroide, no.centroide, k);
  }
});

test('aplicarRoubadosMantidos: casa por ref + texto (o `i` da lista velha não importa); texto novo, nó novo e entrada sem texto ficam inteiros', async () => {
  const ind = await montarIndice({ anel: 'tool', capacidades: capsTool(), embedder: embedderTabela(TABELA_TOOL) });
  const total = (i) => [...i.nos.values()].reduce((n, no) => n + no.vetores.length, 0);
  // `i` errado (catálogo mudou desde o treino), mas ref+texto casam: sai o 'x-rouba'
  let r = aplicarRoubadosMantidos(ind, [{ ref: 'a/tool/x', i: 0, texto: 'x-rouba', para: 'b/tool/z', irmao: false }]);
  assert.equal(r.removidos, 1);
  assert.ok(!r.indice.nos.get('a/tool/x').origens.some((o) => o.tipo === 'exemplo' && o.i === 2));
  assert.deepEqual(r.indice.nos.get('a/tool/x').centroide, centroideDe(r.indice.nos.get('a/tool/x').vetores));
  // mesmo texto em OUTRO nó não sai; texto que não existe mais, ref que não existe mais e entrada sem texto: nada sai
  r = aplicarRoubadosMantidos(ind, [
    { ref: 'a/tool/y', i: 2, texto: 'x-rouba', para: 'b/tool/z', irmao: false },
    { ref: 'a/tool/x', i: 2, texto: 'texto-que-saiu-do-catalogo', para: 'b/tool/z', irmao: false },
    { ref: 'c/tool/novo', i: 0, texto: 'x-rouba', para: 'b/tool/z', irmao: false },
    { ref: 'a/tool/x', i: 2, para: 'b/tool/z', irmao: false },
  ]);
  assert.equal(r.removidos, 0);
  assert.equal(total(r.indice), total(ind));
  // irmao:true nunca sai; o `texto` do nó (tipo 'texto') não é exemplo e nunca sai por esta lista
  r = aplicarRoubadosMantidos(ind, [{ ref: 'a/tool/x', i: 1, texto: 'x-irmao', para: 'a/tool/y', irmao: true }, { ref: 'a/tool/x', i: 0, texto: 'x-texto', para: 'b/tool/z', irmao: false }]);
  assert.equal(r.removidos, 0);
  // lista ausente / inválida: índice intacto
  assert.equal(aplicarRoubadosMantidos(ind, null).removidos, 0);
});

test('aplicarRoubadosMantidos: nó que perderia todos os vetores some; nó intocado mantém o mesmo objeto', async () => {
  const ind = await montarIndice({ anel: 'provider', capacidades: [{ id: 'x', tools: [{ name: 'a', exemplos: ['agenda um', 'agenda dois'] }] }, { id: 'y', tools: [{ name: 'b', exemplos: ['tarefa um'] }] }], embedder: embedderFalso() });
  const { indice, removidos } = aplicarRoubadosMantidos(ind, [
    { ref: 'x', i: 0, texto: 'agenda um', para: 'y', irmao: false }, { ref: 'x', i: 1, texto: 'agenda dois', para: 'y', irmao: false },
  ]);
  assert.equal(removidos, 2);
  assert.equal(indice.nos.has('x'), false);
  assert.strictEqual(indice.nos.get('y'), ind.nos.get('y'));
});

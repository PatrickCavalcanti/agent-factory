import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarContextoDeMemorias, MEMORIA_MAX_CHARS_PADRAO, MEMORIA_ITEM_MAX_CHARS_PADRAO } from '../src/memoria-do-loop.js';

const m = (ref, valor, carrega = []) => ({ ref, valor, carrega });

test('memórias de ação vêm primeiro; ordem do turno se mantém dentro de cada grupo', () => {
  const r = montarContextoDeMemorias([m('r/comum1', 'um'), m('r/acao1', 'dois', ['power/mcp-home-assistant']), m('r/comum2', 'três'), m('r/acao2', 'quatro', ['power/tarefas'])]);
  assert.deepEqual(r.map((x) => x.ref), ['r/acao1', 'r/acao2', 'r/comum1', 'r/comum2']);
  assert.deepEqual(r.map((x) => x.acao), [true, true, false, false]);
});

test('o teto por item corta e deixa a marca', () => {
  const r = montarContextoDeMemorias([m('r/a', 'x'.repeat(100))], { itemMaxChars: 40, maxChars: 1000 });
  assert.equal(r.length, 1);
  assert.equal(r[0].valor.length, 40);
  assert.ok(r[0].valor.endsWith('…[cortado]'));
});

test('o teto do conjunto para de incluir quando acaba o orçamento', () => {
  const itens = [m('r/a', 'a'.repeat(30)), m('r/b', 'b'.repeat(30)), m('r/c', 'c'.repeat(30))];
  const r = montarContextoDeMemorias(itens, { itemMaxChars: 30, maxChars: 70 });
  assert.deepEqual(r.map((x) => x.ref), ['r/a', 'r/b']);
  assert.deepEqual(montarContextoDeMemorias(itens, { itemMaxChars: 30, maxChars: 60 }).map((x) => x.ref), ['r/a', 'r/b']);
});

test('entradas inválidas caem fora; não-array devolve lista vazia', () => {
  assert.deepEqual(montarContextoDeMemorias(null), []);
  assert.deepEqual(montarContextoDeMemorias('x'), []);
  const r = montarContextoDeMemorias([null, { ref: 1, valor: 'x' }, { ref: 'r/a', valor: '   ' }, { ref: 'r/b' }, m('r/ok', 'ok')]);
  assert.deepEqual(r.map((x) => x.ref), ['r/ok']);
});

test('padrões: 2500 no conjunto e 800 por item', () => {
  assert.equal(MEMORIA_MAX_CHARS_PADRAO, 2500);
  assert.equal(MEMORIA_ITEM_MAX_CHARS_PADRAO, 800);
});

test('tetos menores que a marca de corte nunca são ultrapassados (0, 1, 5, 9)', () => {
  for (const teto of [0, 1, 5, 9]) {
    const r = montarContextoDeMemorias([m('r/a', 'x'.repeat(100))], { itemMaxChars: teto, maxChars: 1000 });
    const tamanho = r[0]?.valor.length ?? 0;
    assert.ok(tamanho <= teto, `teto ${teto}: valor com ${tamanho} caracteres`);
  }
  assert.deepEqual(montarContextoDeMemorias([m('r/a', 'x'.repeat(100))], { itemMaxChars: 0 }), []);
  assert.deepEqual(montarContextoDeMemorias([m('r/a', 'x'.repeat(100))], { maxChars: 0 }), []);
});

test('valor truncado sempre leva a marca; se só coubesse um corte sem marca, o item é omitido', () => {
  const itens = [m('r/a', 'a'.repeat(30)), m('r/b', 'b'.repeat(30)), m('r/c', 'c'.repeat(30))];
  const r = montarContextoDeMemorias(itens, { itemMaxChars: 30, maxChars: 65 });
  assert.deepEqual(r.map((x) => x.ref), ['r/a', 'r/b'], 'sobram 5 caracteres: não cabe a marca, então o 3º não entra');
  const r2 = montarContextoDeMemorias(itens, { itemMaxChars: 30, maxChars: 75 });
  assert.equal(r2.length, 3);
  assert.ok(r2[2].valor.endsWith('…[cortado]'));
  assert.ok(r2[2].valor.length <= 15);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORMATOS_DO_CARTAO, formatoDoCartao, funcoesSugeridasDaCapacidade,
  conteudoComFuncoesSugeridas, SEM_FUNCOES_SUGERIDAS, legendaDoCartao,
} from '../src/cartao-sugerido.js';

const tool = (ref, tier, final) => ({ ref, ring: 'tool', tier, ...(final === undefined ? {} : { scores: { final } }) });

test('formatoDoCartao: ausente = completo; válido passa; inválido lança', () => {
  assert.deepEqual(FORMATOS_DO_CARTAO, ['completo', 'funcoesSugeridas', 'nenhum']);
  assert.equal(formatoDoCartao(undefined), 'completo');
  assert.equal(formatoDoCartao(null), 'completo');
  assert.equal(formatoDoCartao('funcoesSugeridas'), 'funcoesSugeridas');
  assert.throws(() => formatoDoCartao('resumido'), /cartaoSugerido inválido/);
});

test('funcoesSugeridasDaCapacidade: só anel tool da capacidade, full|candidate, pela nota, até 5, sem repetir', () => {
  const explain = [
    tool('gcal/tool/a', 'candidate', 0.2),
    tool('gcal/tool/b', 'full', 0.9),
    tool('gcal/tool/c', 'discard', 0.99),
    tool('gcal/tool/d', 'candidate', 0.5),
    tool('gcal/tool/b', 'full', 0.9),
    tool('outra/tool/x', 'full', 1),
    { ref: 'gcal', ring: 'provider', tier: 'candidate', scores: { final: 1 } },
    tool('gcal/tool/e', 'candidate', 0.3), tool('gcal/tool/f', 'candidate', 0.31), tool('gcal/tool/g', 'candidate', 0.32),
  ];
  assert.deepEqual(funcoesSugeridasDaCapacidade(explain, 'gcal'), ['gcal/tool/b', 'gcal/tool/d', 'gcal/tool/g', 'gcal/tool/f', 'gcal/tool/e']);
  assert.deepEqual(funcoesSugeridasDaCapacidade(explain, 'gcal', 2), ['gcal/tool/b', 'gcal/tool/d']);
});

test('funcoesSugeridasDaCapacidade: sem nota vai para o fim; explain ausente ou sem a capacidade = []', () => {
  assert.deepEqual(funcoesSugeridasDaCapacidade([tool('c/tool/sem', 'candidate'), tool('c/tool/com', 'candidate', 0.1)], 'c'), ['c/tool/com', 'c/tool/sem']);
  assert.deepEqual(funcoesSugeridasDaCapacidade(undefined, 'c'), []);
  assert.deepEqual(funcoesSugeridasDaCapacidade([tool('x/tool/a', 'full', 1)], 'c'), []);
});

test('conteudoComFuncoesSugeridas: lista por vírgula; vazia = linha sem função', () => {
  assert.equal(conteudoComFuncoesSugeridas(['gcal__editar', 'gcal__ver']), 'Funções sugeridas: gcal__editar, gcal__ver');
  assert.equal(conteudoComFuncoesSugeridas([]), SEM_FUNCOES_SUGERIDAS);
  assert.equal(SEM_FUNCOES_SUGERIDAS, 'Capacidade sugerida; funções no índice de capacidades.');
});

test('legendaDoCartao: só funcoesSugeridas tem legenda própria; completo e nenhum = undefined (fica a do builder)', () => {
  assert.equal(legendaDoCartao('completo'), undefined);
  assert.equal(legendaDoCartao('nenhum'), undefined);
  const l = legendaDoCartao('funcoesSugeridas');
  assert.match(l, /mais prováveis/);
  assert.match(l, /índice/);
  assert.match(l, /NOME DA FUNÇÃO/);
  assert.match(l, /nunca invente um nome de função/);
});

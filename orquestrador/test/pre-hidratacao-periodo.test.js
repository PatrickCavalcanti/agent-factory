// Bug (sessões 70f74dbb / d163cb50, 02/10): a linha da consulta no bloco <pre_hidratacao> mostrava só
// `gcal_listar_eventos {}` — o modelo não sabia que faixa foi coberta e consultava de novo. Genérico:
// qualquer resultado com `periodo_consultado.descricao` mostra a faixa ao lado dos parâmetros.
import test from 'node:test';
import assert from 'node:assert/strict';
import { entregaDoLoop } from '../src/loop-do-turno.js';

const DESC = 'de qua 25/09 01:39 até qui 02/10 01:39 (padrão: últimos 7 dias)';

test('pre-hidratação: linha de alta confiança mostra o período consultado (resultado objeto)', () => {
  const r = entregaDoLoop({ estado: 'pronto', rastro: [
    { passo: 1, fn: 'gcal_listar_eventos', args: {}, confianca: 0.9, resultado: { ok: true, periodo_consultado: { descricao: DESC } } },
  ] }, { corteHistorico: 0.7 });
  assert.ok(r.bloco.includes(`gcal_listar_eventos {} — confiança 0.90 — período consultado: ${DESC} — resultado logo após este pedido`), r.bloco);
});

test('pre-hidratação: linha de baixa confiança também mostra, e aceita resultado em JSON string', () => {
  const r = entregaDoLoop({ estado: 'pronto', rastro: [
    { passo: 1, fn: 'gcal_listar_eventos', args: {}, confianca: 0.4, resultado: JSON.stringify({ ok: true, periodo_consultado: { descricao: DESC } }) },
  ] }, { corteHistorico: 0.7 });
  assert.ok(r.bloco.includes(`gcal_listar_eventos {} — confiança 0.40 — período consultado: ${DESC} — resultado:`), r.bloco);
});

test('pre-hidratação: resultado sem periodo_consultado não ganha o trecho', () => {
  const r = entregaDoLoop({ estado: 'pronto', rastro: [
    { passo: 1, fn: 'task_listar', args: {}, confianca: 0.9, resultado: { tarefas: [] } },
  ] }, { corteHistorico: 0.7 });
  assert.ok(!r.bloco.includes('período consultado'));
});

// Piso de SUGESTÃO por item: o top-k de next_tool não pode arrastar tool de probabilidade
// ínfima só porque as mais prováveis são de powers já carregados. Casos reais: 633e40d8
// (async-shadows a 0,01), 0ce718d7 (navegador a 0,07), ebb5337c (lembretes a 0,07).
//
// Fase 1 (H5, adendo §15, 2026-09-18): este arquivo testava o campo `hidratar` — a hidratação
// de power passou a vir do `noul` por power candidato (ver hidratar-power.test.js), e o que
// este arquivo mede (o top-k de next_tool com piso por item) virou o campo `sugestao`, que só
// alimenta a dica "Sugestão do roteador" no executor. Mesmos casos, mesmo comportamento —
// só o nome do campo lido mudou (`d.hidratar` → `d.sugestao`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aplicarGates } from '../src/index.js';

const catalogo = [
  { name: 'task_listar', power: 'tarefas' },
  { name: 'load_bundle', power: '_executor' },
  { name: 'executar_tool_em_background', power: 'async-shadows' },
  { name: 'abrir_navegador', power: 'navegador' },
  { name: 'reminder_listar', power: 'lembretes' },
  { name: 'gcal_listar_eventos', power: 'google-calendar' },
];

test('633e40d8: top muito confiante, resto ínfimo — só a tool top entra em sugestao', () => {
  const d = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.92, probabilities: { task_listar: 0.93, load_bundle: 0.03, executar_tool_em_background: 0.01 } } }, { catalogo });
  assert.deepEqual(d.sugestao.map((h) => h.power), ['tarefas']);
});

test('0ce718d7 / ebb5337c: 0,07 não entra', () => {
  const a = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.57, probabilities: { task_listar: 0.58, load_bundle: 0.15, abrir_navegador: 0.07 } } }, { catalogo });
  assert.deepEqual(a.sugestao.map((h) => h.power), ['tarefas']);
  const b = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.58, probabilities: { task_listar: 0.59, load_bundle: 0.1, reminder_listar: 0.07 } } }, { catalogo });
  assert.deepEqual(b.sugestao.map((h) => h.power), ['tarefas']);
});

test('dúvida real entre dois powers: os dois acima do piso entram', () => {
  const d = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.5, probabilities: { task_listar: 0.5, gcal_listar_eventos: 0.35, reminder_listar: 0.1 } } }, { catalogo });
  assert.deepEqual(d.sugestao.map((h) => h.power), ['tarefas', 'google-calendar']);
});

test('piso configurável por cortes.hidratarItem', () => {
  const d = aplicarGates({ next_tool: { choice: 'task_listar', confidence: 0.6, probabilities: { task_listar: 0.6, reminder_listar: 0.07 } } }, { catalogo, cortes: { hidratarItem: 0.05 } });
  assert.deepEqual(d.sugestao.map((h) => h.power), ['tarefas', 'lembretes']);
});

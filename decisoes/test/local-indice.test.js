// packages/decisions/test/local-indice.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nosDoAnel, montarIndice, exportarRetrato, hashDosNos } from '../src/local/indice.js';

import { embedderFalso, capsFalsas } from './helpers/fixtures.js';

test('nosDoAnel monta refs e textos por anel', () => {
  const caps = capsFalsas();
  const p = nosDoAnel('provider', caps);
  assert.deepEqual(p.map((n) => n.ref), ['google-calendar', 'tarefas']);
  // provider = texto da capacidade + exemplos de TODAS as suas tools
  assert.deepEqual(p[1].textos, [{ tipo: 'texto', texto: 'tarefa pendente' }, { tipo: 'exemplo', texto: 'quais tarefa abertas' }, { tipo: 'exemplo', texto: 'minhas tarefa' }]);
  const t = nosDoAnel('tool', caps);
  assert.deepEqual(t.map((n) => n.ref), ['google-calendar/tool/gcal_listar_eventos', 'tarefas/tool/task_listar']);
  const s = nosDoAnel('skill', caps);
  assert.deepEqual(s.map((n) => n.ref), ['tarefas/skill/rotina']);
});

test('montarIndice: um vetor por texto, centrado, com origem; hash muda com o texto', async () => {
  const emb = embedderFalso();
  const r = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  assert.equal(r.ok, true);
  assert.equal(r.slug, 'falso-1');
  const no = r.nos.get('tarefas');
  assert.equal(no.vetores.length, 3);
  assert.deepEqual(no.origens, [{ tipo: 'texto', i: 0 }, { tipo: 'exemplo', i: 0 }, { tipo: 'exemplo', i: 1 }]);
  const caps2 = capsFalsas(); caps2[0].semanticText = 'agenda reuniões';
  assert.notEqual(hashDosNos(nosDoAnel('provider', caps2)), r.hash);
});

test('montarIndice: cada nó tem centroide de dimensão dim e norma ~1', async () => {
  const r = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: embedderFalso() });
  for (const no of r.nos.values()) {
    assert.equal(no.centroide.length, r.dim);
    const norma = Math.sqrt(no.centroide.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norma - 1) < 1e-9);
  }
});

test('montarIndice degrada sem embedder ou sem nós', async () => {
  assert.deepEqual(await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: null }), { ok: false, motivo: 'sem-embedder' });
  assert.deepEqual(await montarIndice({ anel: 'provider', capacidades: [], embedder: embedderFalso() }), { ok: false, motivo: 'sem-nos' });
});

test('exportarRetrato leva slug, hash e textos (sem vetores)', async () => {
  const r = await montarIndice({ anel: 'tool', capacidades: capsFalsas(), embedder: embedderFalso() });
  const ret = exportarRetrato(r);
  assert.equal(ret.anel, 'tool');
  assert.equal(ret.hash, r.hash);
  assert.ok(Array.isArray(ret.nos) && ret.nos[0].textos.length >= 1);
  assert.equal(JSON.stringify(ret).includes('vetores'), false);
});

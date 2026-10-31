// packages/decisions/test/local-pontuador.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { montarIndice } from '../src/local/indice.js';
import { consultaCentrada, pontuarNo } from '../src/local/pontuador.js';
import { embedderFalso, capsFalsas } from './helpers/fixtures.js';

test('nota = máximo sobre os vetores do nó e diz qual casou', async () => {
  const emb = embedderFalso();
  const ind = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const q = consultaCentrada(ind, [await emb.embed('minhas tarefa')]);
  const t = pontuarNo(ind, q, 'tarefas');
  const g = pontuarNo(ind, q, 'google-calendar');
  assert.ok(t.nota > g.nota);
  assert.ok(['texto', 'exemplo:0', 'exemplo:1'].includes(t.casou));
});

test('vários vetores de consulta: vale o maior; nó desconhecido = null', async () => {
  const emb = embedderFalso();
  const ind = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  const um = consultaCentrada(ind, [await emb.embed('agenda')]);
  const dois = consultaCentrada(ind, [await emb.embed('xyz'), await emb.embed('agenda')]);
  assert.ok(Math.abs(pontuarNo(ind, um, 'google-calendar').nota - pontuarNo(ind, dois, 'google-calendar').nota) < 1e-9);
  assert.equal(pontuarNo(ind, um, 'nao-existe'), null);
});

test('vetor de consulta de dimensão errada é descartado', async () => {
  const emb = embedderFalso();
  const ind = await montarIndice({ anel: 'provider', capacidades: capsFalsas(), embedder: emb });
  assert.equal(consultaCentrada(ind, [[1, 2]]).length, 0);
});

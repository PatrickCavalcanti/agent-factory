import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizonte, prefixoComum, decidirDespejo } from '../src/despejo/conta.js';

test('horizonte: média das últimas K × N; estimativa do Jev substitui N', () => {
  assert.deepEqual(horizonte({ chamadas: [1, 1, 12, 2, 2, 3], k: 5, n: 5 }), { media: 4, N: 5, H: 20 });
  assert.equal(horizonte({ chamadas: [2], k: 5, n: 5, nEstimado: 2 }).H, 4);
  assert.equal(horizonte({ chamadas: [], k: 5, n: 5 }).H, 5, 'sem medida: 1 chamada por mensagem');
});

test('prefixoComum', () => {
  assert.equal(prefixoComum('abcX', 'abcY'), 3);
  assert.equal(prefixoComum('', 'a'), 0);
});

const base = { historicoChars: 400, razao: 1, r: 0.1, w: 1, H: 10, minutosDesdeUltima: 1, pausaMin: 20 };

test('sistema estável: quebra cara só compensa com peso morto grande', () => {
  const ant = 'P' + 'D'.repeat(100) + 'Q'.repeat(300);
  const sem = ant;
  const com = 'P' + 'Q'.repeat(300);
  const c = decidirDespejo({ ...base, systemAnterior: ant, systemSem: sem, systemCom: com });
  // D = 100; economia = 0.1×100×10 = 100. S = reescrito(com) − reescrito(sem) = (301−1+400) − 0 = 700; custo = 0.9×700 = 630
  assert.equal(c.D, 100);
  assert.equal(c.S, 700);
  assert.equal(c.disparou, false);
  assert.equal(c.motivo, 'nao-compensa');
});

test('quebra prevista no mesmo ponto: custo ≈ 0, dispara', () => {
  const ant = 'P' + 'D'.repeat(100) + 'Q'.repeat(300);
  const sem = 'P' + 'N' + 'D'.repeat(100) + 'Q'.repeat(300); // algo entrou logo depois de P
  const com = 'P' + 'N' + 'Q'.repeat(300);
  const c = decidirDespejo({ ...base, systemAnterior: ant, systemSem: sem, systemCom: com });
  assert.equal(c.disparou, true);
  assert.ok(c.S <= 0 || c.custo === 0);
});

test('pausa longa: S = 0, sempre dispara', () => {
  const ant = 'P' + 'D'.repeat(100) + 'Q'.repeat(300);
  const c = decidirDespejo({ ...base, minutosDesdeUltima: 30, systemAnterior: ant, systemSem: ant, systemCom: 'P' + 'Q'.repeat(300) });
  assert.equal(c.motivo, 'pausa');
  assert.equal(c.disparou, true);
});

test('nada a descartar', () => {
  const c = decidirDespejo({ ...base, systemAnterior: 'a', systemSem: 'a', systemCom: 'a' });
  assert.equal(c.disparou, false);
  assert.equal(c.motivo, 'nada-a-descartar');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DESPEJO_PADRAO, normalizarDespejo, parametrosDoModelo } from '../src/despejo/config.js';

test('padrão: tudo desligado e valores da spec', () => {
  const { config, motivos } = normalizarDespejo(undefined);
  assert.equal(config.cauda, false);
  assert.equal(config.despejo, false);
  assert.equal(config.comportamento, false);
  assert.deepEqual(
    { x: config.x, m: config.m, n: config.n, k: config.k, pausaMin: config.pausaMin, r: config.r, w: config.w },
    { x: 8, m: 2, n: 5, k: 5, pausaMin: 20, r: 0.1, w: 1.0 },
  );
  assert.deepEqual(motivos, []);
  assert.equal(DESPEJO_PADRAO.sinalForte.cabeca, 0.4);
  assert.equal(DESPEJO_PADRAO.sinalForte.z, 2.5);
});

test('override válido entra; inválido cai no padrão com motivo', () => {
  const { config, motivos } = normalizarDespejo({ cauda: true, comportamento: true, x: 8, r: 2, w: 'x', desconhecida: 1 });
  assert.equal(config.cauda, true);
  assert.equal(config.comportamento, true);
  assert.equal(config.x, 8);
  assert.equal(config.r, 0.1);
  assert.equal(config.w, 1.0);
  assert.equal(motivos.length, 3);
});

test('comportamento não booleano usa o padrão e informa motivo', () => {
  const { config, motivos } = normalizarDespejo({ comportamento: 'sim' });
  assert.equal(config.comportamento, false);
  assert.deepEqual(motivos, ['comportamento não é boolean']);
});

test('porModelo sobrepõe r/w só do modelo pedido', () => {
  const { config } = normalizarDespejo({ porModelo: { 'anthropic/claude': { w: 1.25 }, ruim: { r: -1 } } });
  assert.deepEqual(parametrosDoModelo(config, 'anthropic/claude'), { r: 0.1, w: 1.25 });
  assert.deepEqual(parametrosDoModelo(config, 'ruim'), { r: 0.1, w: 1.0 });
  assert.deepEqual(parametrosDoModelo(config, null), { r: 0.1, w: 1.0 });
});

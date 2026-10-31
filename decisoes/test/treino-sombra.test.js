// packages/decisions/test/treino-sombra.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resumirSombras, contarDesligados } from '../treino/lib/sombra.js';

const fab = (full, sombraFull, usadas, estado = 'respondida') => ({
  operacoes: usadas.map((nome) => ({ nome })),
  selecaoLocal: { sombras: [{ anel: 'provider', principalDe: 'local', sombraDe: 'jev', principal: { full, candidates: [] }, sombra: estado === 'respondida' ? { full: sombraFull, candidates: [] } : null, estado, msPrincipal: 2, msSombra: 400 }] },
});
const mapa = new Map([['gcal', 'agenda'], ['task', 'tarefas']]);

test('concordância, quem trouxe o usado e latência', () => {
  const r = resumirSombras([fab(['agenda'], ['agenda'], ['gcal']), fab(['tarefas'], ['agenda'], ['task']), fab(['agenda'], [], ['gcal'], 'sem-resposta')], mapa);
  const p = r.provider;
  assert.equal(p.turnos, 3);
  assert.equal(p.semResposta, 1);
  assert.equal(p.concordaFull, 0.5);
  assert.equal(p.trouxeUsado.local, 1);
  assert.equal(p.trouxeUsado.jev, 0.5);
  assert.equal(p.ms.local.p50, 2);
});

test('estado erro conta em erros; anel tool: candidates NÃO contam como trouxe (só full)', () => {
  const f = { operacoes: [{ nome: 'gcal' }], selecaoLocal: { sombras: [{ anel: 'tool', principalDe: 'jev', sombraDe: 'local', principal: { full: ['agenda/tool/gcal'], candidates: [] }, sombra: { full: [], candidates: ['agenda/tool/gcal'] }, estado: 'respondida', msPrincipal: 1, msSombra: 3 }, { anel: 'tool', principalDe: 'jev', sombraDe: 'local', principal: { full: [], candidates: [] }, sombra: null, estado: 'erro', msPrincipal: 1, msSombra: 2 }] } };
  const t = resumirSombras([f], mapa).tool;
  assert.equal(t.erros, 1);
  assert.equal(t.semResposta, 0);
  assert.equal(t.trouxeUsado.jev, 1);
  assert.equal(t.trouxeUsado.local, 0);
});

test('anel provider: candidates continuam contando como trouxe', () => {
  const f = { operacoes: [{ nome: 'gcal' }], selecaoLocal: { sombras: [{ anel: 'provider', principalDe: 'local', sombraDe: 'jev', principal: { full: [], candidates: ['agenda'] }, sombra: { full: ['agenda'], candidates: [] }, estado: 'respondida', msPrincipal: 1, msSombra: 3 }] } };
  const t = resumirSombras([f], mapa).provider;
  assert.equal(t.trouxeUsado.local, 1);
  assert.equal(t.trouxeUsado.jev, 1);
});

test('turno com sombra ou principal degradado conta em degradados e sai de concordância e trouxe, mas conta na latência', () => {
  const ok = fab(['agenda'], ['agenda'], ['gcal']);
  const deg = fab(['agenda'], ['agenda'], ['gcal']); deg.selecaoLocal.sombras[0].degradado = true;
  const deg2 = fab(['tarefas'], ['agenda'], ['gcal']); deg2.selecaoLocal.sombras[0].degradado = true;
  const p = resumirSombras([ok, deg, deg2], mapa).provider;
  assert.equal(p.turnos, 3);
  assert.equal(p.degradados, 2);
  assert.equal(p.concordaFull, 1);
  assert.equal(p.trouxeUsado.local, 1);
  // registro legado (só `degradado`): vale para os dois decisores; o local degradado sai da latência, o jev entra
  assert.deepEqual(p.ms.local, { p50: 2, p95: 2 });
  assert.equal(p.ms.jev.p50, 400);
});

test('anel tool compara a ref completa, não só a capacidade', () => {
  const f = { operacoes: [{ nome: 'gcal' }], selecaoLocal: { sombras: [{ anel: 'tool', principalDe: 'jev', sombraDe: 'local', principal: { full: ['agenda/tool/gcal'], candidates: [] }, sombra: { full: ['agenda/tool/outra'], candidates: [] }, estado: 'respondida', msPrincipal: 1, msSombra: 3 }] } };
  const t = resumirSombras([f], mapa).tool;
  assert.equal(t.trouxeUsado.jev, 1);
  assert.equal(t.trouxeUsado.local, 0); // mesma capacidade, outra função
});

test('principal nulo (falhou/não voltou) conta em errosPrincipal e fica fora de concordância e de trouxe', () => {
  const f = { operacoes: [{ nome: 'gcal' }], selecaoLocal: { sombras: [{ anel: 'provider', principalDe: 'jev', sombraDe: 'local', principal: null, erroPrincipal: 'timeout', sombra: { full: ['agenda'], candidates: [] }, estado: 'respondida', msPrincipal: null, msSombra: 3 }] } };
  const p = resumirSombras([f, fab(['agenda'], ['agenda'], ['gcal'])], mapa).provider;
  assert.equal(p.turnos, 2);
  assert.equal(p.errosPrincipal, 1);
  assert.equal(p.concordaFull, 1);
  assert.equal(p.trouxeUsado.jev, 1);
});

test('contarDesligados: turnos com o decisor desligado à parte', () => {
  assert.equal(contarDesligados([{ selecaoLocal: { desligado: 'decisor-0', sombras: [] } }, { selecaoLocal: { sombras: [] } }, null]), 1);
});

test('degradado por decisor: trouxe só exige o PRÓPRIO decisor limpo; concordância exige os dois; latência do local degradado fica fora, a do Jev degradado entra', () => {
  const f = (full, sombraFull, flags) => { const x = fab(full, sombraFull, ['gcal']); Object.assign(x.selecaoLocal.sombras[0], flags, { degradado: true }); return x; };
  // principal=local degradado (indice-montando, 2ms): o Jev (sombra, 400ms) trouxe; o local não conta
  const a = resumirSombras([f([], ['agenda'], { degradadoPrincipal: true })], mapa).provider;
  assert.equal(a.degradados, 1);
  assert.equal(a.concordaFull, null);
  assert.equal(a.trouxeUsado.jev, 1);
  assert.equal(a.trouxeUsado.local, undefined);
  assert.equal(a.ms.local, undefined);
  assert.equal(a.ms.jev.p50, 400);
  // sombra=jev degradado por prazo: o local trouxe; a latência do Jev (prazo) ENTRA
  const b = resumirSombras([f(['agenda'], [], { degradadoSombra: true })], mapa).provider;
  assert.equal(b.trouxeUsado.local, 1);
  assert.equal(b.trouxeUsado.jev, undefined);
  assert.equal(b.ms.jev.p50, 400);
  assert.equal(b.ms.local.p50, 2);
  assert.equal(b.concordaFull, null);
});

test('sombra=local degradada (jev principal): latência do local fora, a do jev entra', () => {
  const x = { operacoes: [{ nome: 'gcal' }], selecaoLocal: { sombras: [{ anel: 'provider', principalDe: 'jev', sombraDe: 'local', principal: { full: ['agenda'], candidates: [] }, sombra: { full: [], candidates: [] }, estado: 'respondida', msPrincipal: 900, msSombra: 0, degradadoSombra: true, degradado: true }] } };
  const p = resumirSombras([x], mapa).provider;
  assert.equal(p.ms.local, undefined);
  assert.equal(p.ms.jev.p50, 900);
  assert.equal(p.trouxeUsado.jev, 1);
});

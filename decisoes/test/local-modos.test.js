// packages/decisions/test/local-modos.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { refinadorPorModo, MODOS } from '../src/local/modos.js';

const res = (nome) => ({ full: [nome], candidates: [], explain: {} });
const inp = { ring: 'provider', items: [] };

test('modos simples', async () => {
  const local = async () => res('L'); const jev = async () => res('J');
  assert.deepEqual((await refinadorPorModo({ modo: 'local', local, jev })(inp)).full, ['L']);
  assert.deepEqual((await refinadorPorModo({ modo: 'jev', local, jev })(inp)).full, ['J']);
  assert.equal(refinadorPorModo({ modo: 'jev', local, jev: null }), null);
  assert.deepEqual([...MODOS], ['jev', 'local', 'local+sombra-jev', 'jev+sombra-local']);
});

test('sombra não espera nem muda o resultado e é registrada', async () => {
  const registros = [];
  let soltar;
  const jev = () => new Promise((r) => { soltar = () => r(res('J')); });
  const ref = refinadorPorModo({ modo: 'local+sombra-jev', local: async () => res('L'), jev, aoSombra: (r) => registros.push(r) });
  const r = await ref(inp);
  assert.deepEqual(r.full, ['L']);
  assert.equal(registros.length, 1);
  assert.equal(registros[0].estado, 'pendente');
  soltar();
  await new Promise((r2) => setTimeout(r2, 0));
  assert.equal(registros[0].estado, 'respondida');
  assert.deepEqual(registros[0].sombra.full, ['J']);
  assert.deepEqual(registros[0].principal.full, ['L']);
});

test('erro na sombra só é registrado', async () => {
  const registros = [];
  const ref = refinadorPorModo({ modo: 'jev+sombra-local', jev: async () => res('J'), local: async () => { throw new Error('x'); }, aoSombra: (r) => registros.push(r) });
  assert.deepEqual((await ref(inp)).full, ['J']);
  await new Promise((r2) => setTimeout(r2, 0));
  assert.equal(registros[0].estado, 'erro');
  assert.equal(registros[0].erro, 'x');
});

test('a sombra sai antes do principal terminar; registro nasce sem principal e é preenchido depois', async () => {
  const eventos = [];
  let soltarPrincipal;
  const principal = () => new Promise((r) => { soltarPrincipal = () => r(res('L')); });
  const sombra = async () => { eventos.push('sombra-iniciou'); return res('J'); };
  let nasceu = null;
  const ref = refinadorPorModo({ modo: 'local+sombra-jev', local: principal, jev: sombra, aoSombra: (r) => { nasceu = { principal: r.principal, estado: r.estado }; } });
  const p = ref(inp);
  assert.deepEqual(nasceu, { principal: null, estado: 'pendente' });
  await new Promise((r2) => setTimeout(r2, 0));
  assert.deepEqual(eventos, ['sombra-iniciou']); // sombra rodou com o principal ainda pendente
  soltarPrincipal();
  assert.deepEqual((await p).full, ['L']);
});

test('atrasoSombraJevMs: a sombra Jev só sai depois do atraso; sombra local não espera', async () => {
  const eventos = [];
  const jev = async () => { eventos.push('jev'); return res('J'); };
  const local = async () => { eventos.push('local'); return res('L'); };
  const registros = [];
  const comSombraJev = refinadorPorModo({ modo: 'local+sombra-jev', local, jev, aoSombra: (r) => registros.push(r), atrasoSombraJevMs: 40 });
  assert.deepEqual((await comSombraJev(inp)).full, ['L']);
  await new Promise((r2) => setTimeout(r2, 10));
  assert.deepEqual(eventos, ['local'], 'aos 10 ms a sombra Jev ainda não saiu');
  assert.equal(registros[0].atrasoMs, 40);
  await new Promise((r2) => setTimeout(r2, 60));
  assert.deepEqual(eventos, ['local', 'jev']);
  assert.equal(registros[0].estado, 'respondida');

  eventos.length = 0;
  const comSombraLocal = refinadorPorModo({ modo: 'jev+sombra-local', local, jev, aoSombra: () => {}, atrasoSombraJevMs: 40 });
  await comSombraLocal(inp);
  await new Promise((r2) => setTimeout(r2, 0));
  assert.deepEqual(eventos.sort(), ['jev', 'local'], 'sombra local sai junto com o principal');
});

test('principal que lança: erro propaga e a sombra continua registrada', async () => {
  const registros = [];
  const ref = refinadorPorModo({ modo: 'jev+sombra-local', jev: async () => { throw new Error('boom'); }, local: async () => res('L'), aoSombra: (r) => registros.push(r) });
  await assert.rejects(ref(inp), /boom/);
  await new Promise((r2) => setTimeout(r2, 0));
  assert.equal(registros.length, 1);
  assert.equal(registros[0].erroPrincipal, 'boom');
  assert.equal(registros[0].estado, 'respondida');
  assert.deepEqual(registros[0].sombra.full, ['L']);
});

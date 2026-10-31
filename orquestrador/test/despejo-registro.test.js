import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estadoDespejoVazio, usosDoTurno, registrarTurno, descartaveis, registrarDescarte, exigeSinalForte } from '../src/despejo/registro-de-uso.js';

const sys = (...caps) => ({ capacidades: caps.map(([id, refs]) => ({ id, funcoes: refs.map((r) => ({ ref: `${id}/tool/${r}`, nome: `${id}_${r}`, indice: r, manual: 'm' })) })) });

test('usosDoTurno: só chamada do modelo, executada, e com nome conhecido', () => {
  const nomeParaRef = new Map([['whatsapp_enviar', 'whatsapp/tool/enviar'], ['memoria_ver', 'memoria/tool/ver']]);
  const usadas = usosDoTurno({
    operacoes: [
      { nome: 'whatsapp_enviar', ok: true },
      { nome: 'memoria_ver', ok: true, origem: 'jev' },
      { nome: 'nao_existe', ok: true },
      { nome: 'memoria_ver', ok: false },
    ],
    recusadas: new Set(),
    nomeParaRef,
  });
  assert.deepEqual(usadas, [{ ref: 'whatsapp/tool/enviar', capId: 'whatsapp' }]);
  const recusada = usosDoTurno({ operacoes: [{ nome: 'whatsapp_enviar', ok: true }], recusadas: new Set(['whatsapp_enviar']), nomeParaRef });
  assert.deepEqual(recusada, []);
});

test('registrarTurno: registra entrada, uso e cauda sem uso', () => {
  let e = estadoDespejoVazio();
  e = registrarTurno(e, { mensagem: 3, system: sys(['whatsapp', ['enviar']]), usadas: [{ ref: 'whatsapp/tool/enviar', capId: 'whatsapp' }], caudaIds: ['midia'] });
  assert.equal(e.itens.whatsapp.entrouEm, 3);
  assert.equal(e.itens.whatsapp.ultimoUso, 3);
  assert.equal(e.itens['whatsapp/tool/enviar'].ultimoUso, 3);
  assert.equal(e.caudaSemUso.midia, 1);
  e = registrarTurno(e, { mensagem: 4, system: sys(['whatsapp', ['enviar']]), usadas: [], caudaIds: ['midia'] });
  assert.equal(e.caudaSemUso.midia, 2);
  assert.equal(e.itens.whatsapp.ultimoUso, 3, 'sem uso não mexe no último uso');
  e = registrarTurno(e, { mensagem: 5, system: sys(['whatsapp', ['enviar']]), usadas: [], caudaIds: [] });
  assert.equal(e.caudaSemUso.midia, undefined, 'saiu da cauda, zera');
});

test('descartaveis: capacidade sem uso há mais de X mensagens; piso e sticky nunca', () => {
  let e = estadoDespejoVazio();
  const s = sys(['whatsapp', ['enviar']], ['memoria', ['ver']], ['gestao', ['ler']]);
  e = registrarTurno(e, { mensagem: 1, system: s, usadas: [{ ref: 'whatsapp/tool/enviar', capId: 'whatsapp' }], caudaIds: [] });
  const porCapacidade = new Map([['gestao', { sticky: true }]]);
  assert.deepEqual(descartaveis(e, { mensagem: 6, system: s, x: 5, piso: new Set(['memoria']), porCapacidade }), { capacidades: [], funcoes: [] });
  assert.deepEqual(descartaveis(e, { mensagem: 7, system: s, x: 5, piso: new Set(['memoria']), porCapacidade }), { capacidades: ['whatsapp'], funcoes: [] });
});

test('descartaveis: R4 — manual parado dentro de capacidade que fica NÃO sai sozinho', () => {
  let e = estadoDespejoVazio();
  const s = sys(['okapp', ['listar', 'salvar']]);
  e = registrarTurno(e, { mensagem: 1, system: s, usadas: [{ ref: 'okapp/tool/salvar', capId: 'okapp' }], caudaIds: [] });
  e = registrarTurno(e, { mensagem: 6, system: s, usadas: [{ ref: 'okapp/tool/listar', capId: 'okapp' }], caudaIds: [] });
  assert.deepEqual(descartaveis(e, { mensagem: 7, system: s, x: 5, piso: new Set(), porCapacidade: new Map() }), { capacidades: [], funcoes: [] });
  // Mutação: marcar a função parada sozinha (regra antiga) devolveria ['okapp/tool/salvar'] acima.
  // Com a capacidade inteira ociosa, ela sai — e só ela.
  assert.deepEqual(descartaveis(e, { mensagem: 12, system: s, x: 5, piso: new Set(), porCapacidade: new Map() }), { capacidades: ['okapp'], funcoes: [] });
});

test('descartaveis: override x por capacidade (evictAfterIdleTurns)', () => {
  let e = estadoDespejoVazio();
  const s = sys(['whatsapp', ['enviar']]);
  e = registrarTurno(e, { mensagem: 1, system: s, usadas: [], caudaIds: [] });
  assert.deepEqual(descartaveis(e, { mensagem: 4, system: s, x: 5, piso: new Set(), porCapacidade: new Map([['whatsapp', { x: 2 }]]) }).capacidades, ['whatsapp']);
});

test('registrarDescarte + exigeSinalForte', () => {
  let e = estadoDespejoVazio();
  const s = sys(['whatsapp', ['enviar']]);
  e = registrarTurno(e, { mensagem: 1, system: s, usadas: [{ ref: 'whatsapp/tool/enviar', capId: 'whatsapp' }], caudaIds: ['midia'] });
  e = registrarTurno(e, { mensagem: 2, system: s, usadas: [], caudaIds: ['midia'] });
  e = registrarTurno(e, { mensagem: 3, system: s, usadas: [], caudaIds: ['midia'] });
  e = registrarDescarte(e, { mensagem: 8, capacidades: ['whatsapp'], funcoes: [], system: s });
  assert.equal(e.descartadas.whatsapp.usada, true);
  assert.deepEqual(e.descartadas.whatsapp.nomes, ['whatsapp_enviar']);
  assert.equal(e.itens.whatsapp, undefined);
  assert.deepEqual([...exigeSinalForte(e, { m: 3 })].sort(), ['midia', 'whatsapp']);
  e = registrarTurno(e, { mensagem: 9, system: sys(['whatsapp', ['enviar']]), usadas: [{ ref: 'whatsapp/tool/enviar', capId: 'whatsapp' }], caudaIds: [] });
  assert.equal(e.descartadas.whatsapp, undefined, 'voltou a ser usada: sai do registro de descartadas');
});

test('exigência de sinal forte persiste fora da cauda e cai com uso (I2)', () => {
  let e = estadoDespejoVazio();
  const sys = { capacidades: [] };
  e = registrarTurno(e, { mensagem: 0, system: sys, caudaIds: ['midia'], m: 2 });
  assert.equal(exigeSinalForte(e, { m: 2 }).has('midia'), false, '1 turno na cauda: ainda não exige');
  e = registrarTurno(e, { mensagem: 1, system: sys, caudaIds: ['midia'], m: 2 });
  assert.equal(exigeSinalForte(e, { m: 2 }).has('midia'), true, 'M turnos: passa a exigir');
  // Turnos em que ela NÃO está na cauda (cortada, ou nem selecionada): a contagem zera, a exigência fica.
  e = registrarTurno(e, { mensagem: 2, system: sys, caudaIds: [], m: 2 });
  assert.equal(e.caudaSemUso.midia, undefined);
  assert.equal(exigeSinalForte(e, { m: 2 }).has('midia'), true);
  e = registrarTurno(e, { mensagem: 3, system: sys, caudaIds: [], m: 2 });
  assert.equal(exigeSinalForte(e, { m: 2 }).has('midia'), true);
  // Usada pelo modelo (ou carregada por load_capability, que também entra em `usadas`): cai.
  e = registrarTurno(e, { mensagem: 4, system: sys, caudaIds: [], usadas: [{ ref: 'midia/tool/x', capId: 'midia' }], m: 2 });
  assert.equal(exigeSinalForte(e, { m: 2 }).has('midia'), false);
  // Sem `m` (chamadores antigos) nada passa a ser exigido por contagem.
  const velho = registrarTurno(registrarTurno(estadoDespejoVazio(), { mensagem: 0, system: sys, caudaIds: ['a'] }), { mensagem: 1, system: sys, caudaIds: ['a'] });
  assert.deepEqual(velho.exigeSinal, {});
  // Estado antigo, sem o campo, continua funcionando.
  assert.equal(exigeSinalForte({ caudaSemUso: {}, descartadas: {} }, { m: 2 }).size, 0);
});

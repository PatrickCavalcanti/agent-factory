import { test } from 'node:test';
import assert from 'node:assert/strict';
import { despejar } from '../src/despejo/despejar.js';

const sistema = () => ({
  capacidades: [
    { id: 'whatsapp', prioridade: 500, funcoes: [{ ref: 'whatsapp/tool/enviar', nome: 'whatsapp_enviar', indice: 'i', manual: 'M1' }] },
    { id: 'okapp', prioridade: 501, funcoes: [
      { ref: 'okapp/tool/listar', nome: 'okapp_listar', indice: 'i', manual: 'M2' },
      { ref: 'okapp/tool/salvar', nome: 'okapp_salvar', indice: 'i', manual: 'M3' },
    ] },
  ],
  fixas: [], estaveis: [], dinamicas: [],
  diario: [
    { tipo: 'capacidade', capId: 'whatsapp', descricao: null, funcoes: [] },
    { tipo: 'capacidade', capId: 'okapp', descricao: null, funcoes: [] },
    { tipo: 'manual', capId: 'whatsapp', ref: 'whatsapp/tool/enviar', nome: 'whatsapp_enviar', texto: 'M1' },
    { tipo: 'manual', capId: 'okapp', ref: 'okapp/tool/salvar', nome: 'okapp_salvar', texto: 'M3' },
    { tipo: 'manual', capId: 'okapp', ref: 'okapp/tool/listar', nome: 'okapp_listar', texto: 'M2' },
  ],
});

test('tira capacidade inteira e manual avulso, podando o diário', () => {
  const antes = sistema();
  const depois = despejar(antes, { capacidades: ['whatsapp'], funcoes: ['okapp/tool/salvar'] });
  assert.deepEqual(depois.capacidades.map((c) => c.id), ['okapp']);
  const okapp = depois.capacidades[0];
  assert.equal(okapp.funcoes.find((f) => f.ref === 'okapp/tool/salvar').manual, undefined);
  assert.equal(okapp.funcoes.find((f) => f.ref === 'okapp/tool/salvar').indice, 'i', 'a linha da lista fixa fica');
  assert.equal(okapp.funcoes.find((f) => f.ref === 'okapp/tool/listar').manual, 'M2');
  assert.deepEqual(depois.diario.map((e) => `${e.tipo}:${e.ref ?? e.capId}`), ['capacidade:okapp', 'manual:okapp/tool/listar']);
});

test('não muta o estado de entrada (turno que falha depois não pode herdar o despejo)', () => {
  const antes = sistema();
  const copia = JSON.parse(JSON.stringify(antes));
  despejar(antes, { capacidades: ['whatsapp'], funcoes: ['okapp/tool/salvar'] });
  assert.deepEqual(antes, copia);
});

test('nada a tirar devolve o mesmo objeto', () => {
  const antes = sistema();
  assert.equal(despejar(antes, { capacidades: [], funcoes: [] }), antes);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { validarCargaPorChave, capacidadesDaCarga } from '../src/carga-por-chave.js';

const ids = new Set(['olho', 'migracao', 'projeto']);
const catalogo = ['tela-mudada', 'migracao', 'cadastro'];

test('recusa chave fora do catálogo e id desconhecido', () => {
  const erros = validarCargaPorChave({ 'tela-mudada': ['olho'], grafico: ['olho'], migracao: ['nao-existe'] }, catalogo, ids, true);
  assert.deepEqual(erros.sort(), [
    'cargaPorChave: chave "grafico" fora de catalogoDeChaves',
    'cargaPorChave: chave "migracao" aponta capacidade desconhecida "nao-existe"',
  ].sort());
});

test('recusa mapa sem catalogoDeChaves', () => {
  assert.match(validarCargaPorChave({ x: ['olho'] }, undefined, ids, true)[0], /exige catalogoDeChaves/);
});

test('recusa mapa sem `config.chaves`: sem ela o turno recebe todo o catálogo e a carga vira piso disfarçado', () => {
  const erros = validarCargaPorChave({ 'tela-mudada': ['olho'] }, catalogo, ids, false);
  assert.equal(erros.length, 1);
  assert.match(erros[0], /exige `chaves`/);
  assert.match(erros[0], /piso/);
  assert.deepEqual(validarCargaPorChave({ 'tela-mudada': ['olho'] }, catalogo, ids, true), []);
});

test('mapa sem catálogo e sem `chaves`: as duas mensagens', () => {
  const erros = validarCargaPorChave({ x: ['olho'] }, undefined, ids, false);
  assert.equal(erros.length, 2);
});

test('recusa lista vazia ou que não é lista', () => {
  const erros = validarCargaPorChave({ 'tela-mudada': [], migracao: 'migracao' }, catalogo, ids, true);
  assert.equal(erros.length, 2);
  assert.ok(erros.every((e) => /lista de ids de capacidade/.test(e)), erros.join('|'));
});

test('mapa ausente ou vazio não recusa nada', () => {
  assert.deepEqual(validarCargaPorChave(undefined, undefined, ids), []);
  assert.deepEqual(validarCargaPorChave({}, undefined, ids), []);
});

test('capacidades do turno: união, sem repetição, na ordem do mapa', () => {
  const mapa = { 'tela-mudada': ['olho'], migracao: ['migracao', 'olho'] };
  assert.deepEqual(capacidadesDaCarga(mapa, ['migracao', 'tela-mudada', 'cadastro']), {
    ids: ['olho', 'migracao'],
    porChave: { 'tela-mudada': ['olho'], migracao: ['migracao', 'olho'] },
  });
});

test('capacidades do turno: sem chave do mapa no turno, nada', () => {
  assert.deepEqual(capacidadesDaCarga({ 'tela-mudada': ['olho'] }, ['cadastro']), { ids: [], porChave: {} });
  assert.deepEqual(capacidadesDaCarga(undefined, ['cadastro']), { ids: [], porChave: {} });
});

// --- integração ------------------------------------------------------------------------------------------

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };

function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

const tool = (name) => ({ name, description: `Faz ${name}.`, schema: z.object({}), handler: async () => ({}) });
const capacidades = () => [
  { id: 'olho', descricao: 'Vê a tela pronta.', piso: false, semanticText: 'ver a tela pronta, captura, imagem', tools: [tool('ver')] },
  { id: 'migracao', descricao: 'Propõe migração.', piso: false, semanticText: 'migrar cadastro, mudar campo', tools: [tool('propor')] },
];

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(),
    embedder: null,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (nome, definicao) => definicao,
    catalogoDeChaves: ['tela-mudada', 'migracao'],
    ...extra,
  });
}

test('a chave do turno carrega a capacidade do mapa, sem depender do ranking; as outras ficam fora', async () => {
  const infos = [];
  const orq = fabrica({
    chaves: () => ['tela-mudada'],
    cargaPorChave: { 'tela-mudada': ['olho'], migracao: ['migracao'] },
    aoMontar: (info) => infos.push(info),
  });
  const turno = await orq.executarTurno({ texto: 'qualquer coisa que não fala de nada disso', estado: ESTADO_INICIAL });
  const info = infos[0];
  const acumuladas = info.capacidadesAcumuladas.map((c) => c.id);
  assert.ok(acumuladas.includes('olho'), `capacidades acumuladas: ${acumuladas}`);
  assert.ok(!acumuladas.includes('migracao'));
  assert.deepEqual(info.cargaPorChave, { 'tela-mudada': ['olho'] });
  assert.deepEqual(turno.cargaPorChave, { 'tela-mudada': ['olho'] });
});

test('o que a chave carregou fica em `cargaPorChave` e NÃO em `promocoes.fontes` (rastro de fonte é de fonte)', async () => {
  const infos = [];
  const orq = fabrica({
    chaves: () => ['tela-mudada'],
    cargaPorChave: { 'tela-mudada': ['olho'] },
    aoMontar: (info) => infos.push(info),
  });
  const turno = await orq.executarTurno({ texto: 'qualquer coisa que não fala de nada disso', estado: ESTADO_INICIAL });
  assert.deepEqual(turno.cargaPorChave, { 'tela-mudada': ['olho'] });
  assert.deepEqual(turno.promocoes.fontes, []);
  assert.deepEqual(infos[0].promocoes.fontes, []);
  assert.ok(infos[0].capacidadesAcumuladas.some((c) => c.id === 'olho'), 'a carga em si continua valendo');
});

test('turno trivial: a chave é calculada e publicada igual; a capacidade carrega no primeiro turno com discover (como o `carregar` das fontes)', async () => {
  const infos = [];
  const orq = fabrica({
    chaves: (ctx) => ctx.chaves,
    cargaPorChave: { 'tela-mudada': ['olho'], migracao: ['migracao'] },
    aoMontar: (info) => infos.push(info),
  });
  const t1 = await orq.executarTurno({ texto: 'qualquer coisa que não fala de nada disso', ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.deepEqual(t1.cargaPorChave, {});
  const t2 = await orq.executarTurno({ texto: 'x', ctx: { chaves: ['migracao'] }, estado: t1.estado });
  assert.ok(t2.discover.unchanged, 'o turno 2 tem de ser trivial (discover pulado)');
  assert.deepEqual(t2.cargaPorChave, { migracao: ['migracao'] }, 'as chaves não dependem do texto');
  assert.deepEqual(infos[1].cargaPorChave, { migracao: ['migracao'] });
  // Sem discover não há hidratação: o manual chega no próximo turno com texto de verdade.
  const t3 = await orq.executarTurno({ texto: 'qualquer coisa que não fala de nada disso', ctx: { chaves: ['migracao'] }, estado: t2.estado });
  assert.ok(!t3.discover.unchanged);
  assert.ok(infos[2].capacidadesAcumuladas.some((c) => c.id === 'migracao'));
  assert.ok(!infos[2].capacidadesAcumuladas.some((c) => c.id === 'olho'));
});

test('sem `cargaPorChave`, o retorno e o `aoMontar` não ganham campo novo', async () => {
  const infos = [];
  const turno = await fabrica({ aoMontar: (i) => infos.push(i) })
    .executarTurno({ texto: 'qualquer coisa', estado: ESTADO_INICIAL });
  assert.ok(!('cargaPorChave' in turno));
  assert.ok(!('cargaPorChave' in infos[0]));
});

test('recusa R10: chave fora do catálogo e capacidade desconhecida recusam a montagem, com as duas mensagens juntas', async () => {
  await assert.rejects(
    () => fabrica({ chaves: () => [], cargaPorChave: { grafico: ['olho'], migracao: ['nao-existe'] } })
      .executarTurno({ texto: 'x', estado: ESTADO_INICIAL }),
    (erro) => /chave "grafico" fora de catalogoDeChaves/.test(erro.message)
      && /capacidade desconhecida "nao-existe"/.test(erro.message),
  );
  await assert.rejects(
    () => fabrica({ chaves: () => [], catalogoDeChaves: undefined, cargaPorChave: { migracao: ['migracao'] } })
      .executarTurno({ texto: 'x', estado: ESTADO_INICIAL }),
    /exige catalogoDeChaves/,
  );
  await assert.rejects(
    () => fabrica({ cargaPorChave: { migracao: ['migracao'] } }).executarTurno({ texto: 'x', estado: ESTADO_INICIAL }),
    /cargaPorChave inválida: .*exige `chaves`/,
  );
});

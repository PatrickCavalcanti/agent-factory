import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@okds/kairos/core/hash';
import { envolverEmbedderComDisco } from '../src/cache-exemplos.js';

function falso() {
  let chamadas = 0;
  return { modelSlug: 'fake-1', get chamadas() { return chamadas; }, async embed(t, role) { chamadas += 1; return [t.length, role === 'query' ? 1 : 0]; } };
}

test('persiste por texto+papel+modelo e não embeda de novo entre instâncias', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const e1 = falso();
  const c1 = envolverEmbedderComDisco(e1, { arquivo });
  await c1.embed('oi', 'query');
  await c1.salvar();
  const e2 = falso();
  const c2 = envolverEmbedderComDisco(e2, { arquivo });
  assert.deepEqual(await c2.embed('oi', 'query'), [2, 1]);
  assert.equal(e2.chamadas, 0);
  assert.ok(JSON.parse(readFileSync(arquivo, 'utf8')).versao === 1);
});

test('modelo diferente não reaproveita', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const c1 = envolverEmbedderComDisco(falso(), { arquivo });
  await c1.embed('oi', 'query'); await c1.salvar();
  const e2 = { ...falso(), modelSlug: 'outro' };
  let n = 0; e2.embed = async () => { n += 1; return [9]; };
  await envolverEmbedderComDisco(e2, { arquivo }).embed('oi', 'query');
  assert.equal(n, 1);
});

test('sem arquivo: funciona só em memória', async () => {
  const e = falso();
  const c = envolverEmbedderComDisco(e, {});
  await c.embed('a', 'query'); await c.embed('a', 'query');
  assert.equal(e.chamadas, 1);
  await c.salvar();
});

// --- conferência geral 06/10 (B-I2/B-I4/B-M1): o cache nunca pode derrubar o turno ---

function capturarAvisos() {
  const avisos = [];
  const original = console.warn;
  console.warn = (...a) => { avisos.push(a.join(' ')); };
  return { avisos, restaurar: () => { console.warn = original; } };
}

test('arquivo vazio (o 0 byte de 02/10) vira cache vazio com aviso, sem lançar', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  writeFileSync(arquivo, '');
  const { avisos, restaurar } = capturarAvisos();
  try {
    const e = falso();
    const c = envolverEmbedderComDisco(e, { arquivo });
    assert.deepEqual(await c.embed('oi', 'query'), [2, 1]);
    assert.equal(e.chamadas, 1);
    assert.ok(avisos.some((a) => a.includes('json-invalido')), avisos.join('\n'));
  } finally { restaurar(); }
});

test('{"versao":1} sem itens não derruba o embed (pendência #11)', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  writeFileSync(arquivo, '{"versao":1}');
  const { avisos, restaurar } = capturarAvisos();
  try {
    const e = falso();
    const c = envolverEmbedderComDisco(e, { arquivo });
    assert.deepEqual(await c.embed('oi', 'query'), [2, 1]);
    assert.equal(e.chamadas, 1);
    assert.ok(avisos.some((a) => a.includes('estrutura-invalida')), avisos.join('\n'));
    await c.salvar();
    const gravado = JSON.parse(readFileSync(arquivo, 'utf8'));
    assert.equal(gravado.versao, 1);
    assert.equal(Object.keys(gravado.itens).length, 1);
  } finally { restaurar(); }
});

test('vetor não-array, com não-número ou de dimensão minoritária é descartado e refeito', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const k = (t) => `fake-1#query#${contentHash(t)}`;
  writeFileSync(arquivo, JSON.stringify({ versao: 1, itens: {
    [k('aa')]: [9, 9],          // válido, dimensão 2 (maioria)
    [k('bb')]: [8, 8],          // válido, dimensão 2 (maioria)
    [k('cc')]: 'lixo',          // não-array
    [k('dd')]: [1, null],       // com não-número
    [k('ee')]: [1, 2, 3],       // dimensão 3 (minoria)
  } }));
  const { avisos, restaurar } = capturarAvisos();
  try {
    const e = falso();
    const c = envolverEmbedderComDisco(e, { arquivo });
    assert.deepEqual(await c.embed('aa', 'query'), [9, 9]);   // veio do arquivo
    assert.equal(e.chamadas, 0);
    for (const t of ['cc', 'dd', 'ee']) await c.embed(t, 'query');
    assert.equal(e.chamadas, 3, 'as três entradas ruins são refeitas pelo embedder');
    // 2 não são vetor (cc, dd) e 1 é vetor válido de dimensão diferente da maioria (ee): o aviso diz cada coisa.
    assert.ok(avisos.some((a) => a.includes('2 vetor(es) inválido(s) e 1 com dimensão divergente da maioria do modelo descartado(s)')), avisos.join('\n'));
  } finally { restaurar(); }
});

test('só dimensão divergente: o aviso não fala de vetor inválido', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const k = (t) => `fake-1#query#${contentHash(t)}`;
  writeFileSync(arquivo, JSON.stringify({ versao: 1, itens: {
    [k('aa')]: [9, 9], [k('bb')]: [8, 8], [k('ee')]: [1, 2, 3],
  } }));
  const { avisos, restaurar } = capturarAvisos();
  try {
    envolverEmbedderComDisco(falso(), { arquivo });
    const aviso = avisos.find((a) => a.includes(arquivo));
    assert.ok(aviso, avisos.join('\n'));
    assert.ok(aviso.includes('1 com dimensão divergente da maioria do modelo descartado(s); serão refeitos.'), aviso);
    assert.ok(!aviso.includes('inválido'), aviso);
  } finally { restaurar(); }
});

test('arquivo do cache que é um diretório: aviso com o código da leitura (leitura:EISDIR) e o embed funciona', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  mkdirSync(arquivo, { recursive: true });   // existe, mas não é arquivo: readFileSync lança EISDIR
  const { avisos, restaurar } = capturarAvisos();
  try {
    const e = falso();
    const c = envolverEmbedderComDisco(e, { arquivo });
    assert.deepEqual(await c.embed('oi', 'query'), [2, 1]);
    assert.equal(e.chamadas, 1);
    assert.ok(avisos.some((a) => a.includes('leitura:EISDIR')), avisos.join('\n'));
    assert.ok(!avisos.some((a) => a.includes('json-invalido')), 'não é JSON inválido — é erro de leitura');
  } finally { restaurar(); }
});

test('vetor inválido devolvido pelo embedder não é gravado no cache; o chamador recebe o valor e há um aviso só', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const respostas = { bom: [1, 2], vazio: [], nan: [1, Number.NaN] };
  const embedder = { modelSlug: 'fake-invalido', async embed(t) { return respostas[t]; } };
  const { avisos, restaurar } = capturarAvisos();
  try {
    const c = envolverEmbedderComDisco(embedder, { arquivo });
    assert.deepEqual(await c.embed('bom', 'query'), [1, 2]);
    assert.deepEqual(await c.embed('vazio', 'query'), [], 'devolve o valor ao chamador como antes');
    assert.equal((await c.embed('nan', 'query')).length, 2);
    await c.salvar();
    const gravado = JSON.parse(readFileSync(arquivo, 'utf8'));
    assert.deepEqual(Object.keys(gravado.itens), [`fake-invalido#query#${contentHash('bom')}`], 'só o vetor válido foi gravado');
    const ruins = avisos.filter((a) => a.includes('devolveu vetor inválido para o cache'));
    assert.equal(ruins.length, 1, `um aviso só: ${avisos.join('\n')}`);
    assert.ok(ruins[0].includes('fake-invalido') && ruins[0].includes('não persisto'), ruins[0]);
  } finally { restaurar(); }
});

test('só vetor inválido do embedder: nada fica sujo e salvar() não cria arquivo', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const embedder = { modelSlug: 'fake-invalido-2', async embed() { return []; } };
  const { restaurar } = capturarAvisos();
  try {
    const c = envolverEmbedderComDisco(embedder, { arquivo });
    await c.embed('x', 'query');
    await c.salvar();
    assert.equal(existsSync(arquivo), false);
  } finally { restaurar(); }
});

test('salvar() com o caminho impossível de gravar (EISDIR) não lança e avisa', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  mkdirSync(arquivo, { recursive: true });   // o "arquivo" é um diretório: análogo a ENOSPC/EACCES
  const { avisos, restaurar } = capturarAvisos();
  try {
    const c = envolverEmbedderComDisco(falso(), { arquivo });
    await c.embed('oi', 'query');
    await c.salvar();          // antes da correção: lançava EISDIR e derrubava o turno
    await c.salvar();          // segue tentando e segue sem lançar
    assert.ok(avisos.some((a) => a.includes('não consegui gravar o cache')), avisos.join('\n'));
  } finally { restaurar(); }
});

test('falha de gravação não trunca o arquivo que já existia e grava na próxima tentativa', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'ex-')), 'exemplos.json');
  const c1 = envolverEmbedderComDisco(falso(), { arquivo });
  await c1.embed('antigo', 'query');
  await c1.salvar();
  const antes = readFileSync(arquivo, 'utf8');

  const tmp = `${arquivo}.${process.pid}.tmp`;
  mkdirSync(tmp, { recursive: true });        // bloqueia a gravação no temporário
  const { restaurar } = capturarAvisos();
  try {
    const c2 = envolverEmbedderComDisco(falso(), { arquivo });
    await c2.embed('novo', 'query');
    await c2.salvar();
    assert.equal(readFileSync(arquivo, 'utf8'), antes, 'o arquivo antigo continua inteiro');

    rmSync(tmp, { recursive: true, force: true });
    await c2.salvar();                          // ainda sujo: grava agora
    const depois = JSON.parse(readFileSync(arquivo, 'utf8'));
    assert.equal(Object.keys(depois.itens).length, 2);
    assert.equal(existsSync(tmp), false, 'não sobra temporário');
  } finally { restaurar(); }
});

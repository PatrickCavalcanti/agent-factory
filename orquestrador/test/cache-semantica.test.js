import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarCacheSemantica, limparCachesSemanticaDoProcesso } from '../src/cache-semantica.js';
import { envolverEmbedderComDisco } from '../src/cache-exemplos.js';

beforeEach(() => limparCachesSemanticaDoProcesso());
const dirTmp = () => mkdtempSync(join(tmpdir(), 'cache-semantica-'));
const lerArquivo = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('get usa a chave composta `<slug>#query#<hash>` — a mesma que o decisor grava', () => {
  const f = join(dirTmp(), 'sel.json');
  writeFileSync(f, JSON.stringify({ versao: 1, itens: { 'e5#query#abc': [1, 2, 3] } }));
  const c = criarCacheSemantica(f);
  assert.deepEqual(c.get('e5#query', 'abc'), [1, 2, 3]);
  assert.equal(c.get('e5#query', 'zzz'), undefined);
  assert.equal(c.get('e5#passage', 'abc'), undefined);
});

test('set + flush grava atômico no formato do decisor e não deixa temporário', () => {
  const f = join(dirTmp(), 'sub', 'sel.json');
  const c = criarCacheSemantica(f);
  c.set('e5#query', 'h1', new Float32Array([0.5, 0.25]));
  assert.ok(!existsSync(f), 'nada em disco antes do flush');
  c.flush();
  assert.deepEqual(lerArquivo(f), { versao: 1, itens: { 'e5#query#h1': [0.5, 0.25] } });
  assert.deepEqual(readdirSync(join(f, '..')), ['sel.json']);
});

test('flush sem set não toca o arquivo', () => {
  const f = join(dirTmp(), 'sel.json');
  criarCacheSemantica(f).flush();
  assert.ok(!existsSync(f));
});

test('arquivo ilegível ou de estrutura errada não lança: recomeça vazio', () => {
  const d = dirTmp();
  const f1 = join(d, 'lixo.json'); writeFileSync(f1, '{ nao e json');
  const f2 = join(d, 'forma.json'); writeFileSync(f2, JSON.stringify({ versao: 2, itens: [] }));
  for (const f of [f1, f2]) {
    const c = criarCacheSemantica(f);
    assert.equal(c.get('m#query', 'x'), undefined);
    c.set('m#query', 'x', [1]);
    c.flush();
    assert.deepEqual(lerArquivo(f).itens, { 'm#query#x': [1] });
  }
});

test('falha de gravação não lança', () => {
  const d = dirTmp();
  const f = join(d, 'arquivo-onde-deveria-ser-dir', 'sel.json');
  writeFileSync(join(d, 'arquivo-onde-deveria-ser-dir'), 'x'); // mkdir do pai falha
  const c = criarCacheSemantica(f);
  c.set('m#query', 'x', [1]);
  assert.doesNotThrow(() => c.flush());
});

test('uma instância por caminho no processo', () => {
  const d = dirTmp();
  const a = criarCacheSemantica(join(d, 'a.json'));
  assert.equal(criarCacheSemantica(join(d, 'a.json')), a);
  assert.notEqual(criarCacheSemantica(join(d, 'b.json')), a);
  a.set('m#query', 'k', [9]);
  assert.deepEqual(criarCacheSemantica(join(d, 'a.json')).get('m#query', 'k'), [9], 'a outra "sessão" vê o que a primeira embedou');
});

test('flush mescla o que outro escritor gravou desde a leitura; a memória vence no conflito', () => {
  const f = join(dirTmp(), 'sel.json');
  const c = criarCacheSemantica(f);
  c.set('m#query', 'meu', [1]);
  c.set('m#query', 'conflito', [1]);
  writeFileSync(f, JSON.stringify({ versao: 1, itens: { 'm#query#dele': [2], 'm#query#conflito': [2] } }));
  c.flush();
  assert.deepEqual(lerArquivo(f).itens, { 'm#query#meu': [1], 'm#query#conflito': [1], 'm#query#dele': [2] });
});

test('o decisor (envolverEmbedderComDisco) enxerga o que gravamos e nós o que ele gravou', async () => {
  const f = join(dirTmp(), 'sel.json');
  const { contentHash } = await import('@okds/kairos/core/hash');
  const c = criarCacheSemantica(f);
  c.set('slug#query', contentHash('frase nossa'), [1, 1]);
  c.flush();
  let chamadas = 0;
  const cru = { modelSlug: 'slug', async embed() { chamadas += 1; return [7, 7]; } };
  const d = envolverEmbedderComDisco(cru, { arquivo: f, roles: ['query'], mesclar: true });
  assert.deepEqual(await d.embed('frase nossa', 'query'), [1, 1]);
  assert.equal(chamadas, 0, 'cache-hit no que o Kairos gravou');
  await d.embed('frase dele', 'query');
  await d.salvar();
  limparCachesSemanticaDoProcesso();
  assert.deepEqual(criarCacheSemantica(f).get('slug#query', contentHash('frase dele')), [7, 7]);
});

test('decisor com `mesclar` não apaga o que o Kairos gravou depois da leitura dele', async () => {
  const f = join(dirTmp(), 'sel.json');
  const cru = { modelSlug: 'slug', async embed() { return [7, 7]; } };
  const d = envolverEmbedderComDisco(cru, { arquivo: f, roles: ['query'], mesclar: true }); // leu: arquivo ausente
  const c = criarCacheSemantica(f);
  c.set('slug#query', 'hk', [1, 1]);
  c.flush();
  await d.embed('texto do decisor', 'query');
  await d.salvar();
  const itens = lerArquivo(f).itens;
  assert.deepEqual(itens['slug#query#hk'], [1, 1]);
  assert.equal(Object.keys(itens).length, 2);
});

test('vetores inválidos do arquivo (não array / não finitos) são descartados e não são regravados', () => {
  const f = join(dirTmp(), 'sel.json');
  writeFileSync(f, JSON.stringify({ versao: 1, itens: {
    'e5#query#ok': [1, 2], 'e5#query#nulo': [1, null], 'e5#query#texto': 'x', 'e5#query#vazio': [], 'e5#query#obj': { a: 1 },
  } }));
  const c = criarCacheSemantica(f);
  c.set('e5#query', 'novo', [3]);
  c.flush();
  assert.deepEqual(lerArquivo(f).itens, { 'e5#query#ok': [1, 2], 'e5#query#novo': [3] });
});

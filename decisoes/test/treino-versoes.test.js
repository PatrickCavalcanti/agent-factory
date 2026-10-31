import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gravarVersao, caminhoAtual, voltar, registrarHistorico, lerHistorico, versaoAtual, listarVersoes, gravarReposicao, lerReposicao, estadoDoPonteiro } from '../treino/lib/versoes.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ver-'));

test('gravarVersao cria v1, v2 e move atual.json; sem sobras de tmp', () => {
  const dir = tmp();
  const r1 = gravarVersao(dir, 'provider', { slug: 's', marca: 1 });
  assert.deepEqual([r1.ok, r1.versao], [true, 1]);
  const r2 = gravarVersao(dir, 'provider', { slug: 's', marca: 2 });
  assert.equal(r2.versao, 2);
  const pasta = join(dir, 'cabecas', 'provider');
  assert.deepEqual(JSON.parse(readFileSync(join(pasta, 'atual.json'), 'utf8')), { versao: 2, arquivo: 'v2.json' });
  assert.equal(JSON.parse(readFileSync(join(pasta, 'v1.json'), 'utf8')).marca, 1);
  assert.equal(readdirSync(pasta).some((f) => f.endsWith('.tmp')), false);
  assert.equal(caminhoAtual(dir, 'provider'), join(pasta, 'v2.json'));
  assert.equal(versaoAtual(dir, 'provider'), 2);
});

test('caminhoAtual cai no legado cabecas/<anel>.json quando não há ponteiro; null sem nada', () => {
  const dir = tmp();
  assert.equal(caminhoAtual(dir, 'tool'), null);
  mkdirSync(join(dir, 'cabecas'), { recursive: true });
  writeFileSync(join(dir, 'cabecas', 'tool.json'), '{}');
  assert.equal(caminhoAtual(dir, 'tool'), join(dir, 'cabecas', 'tool.json'));
  assert.equal(versaoAtual(dir, 'tool'), null);
  gravarVersao(dir, 'tool', { x: 1 }); // com ponteiro, o legado deixa de valer
  assert.equal(caminhoAtual(dir, 'tool'), join(dir, 'cabecas', 'tool', 'v1.json'));
});

test('voltar move o ponteiro para a anterior; sem anterior devolve ok:false; nova gravação não reusa número', () => {
  const dir = tmp();
  assert.equal(voltar(dir, 'provider').ok, false);
  gravarVersao(dir, 'provider', { m: 1 }); gravarVersao(dir, 'provider', { m: 2 });
  assert.deepEqual(voltar(dir, 'provider'), { ok: true, versao: 1 });
  assert.equal(caminhoAtual(dir, 'provider'), join(dir, 'cabecas', 'provider', 'v1.json'));
  assert.equal(voltar(dir, 'provider').ok, false);
  assert.equal(gravarVersao(dir, 'provider', { m: 3 }).versao, 3);
});

test('histórico: append em historico.jsonl', () => {
  const dir = tmp();
  registrarHistorico(dir, 'provider', { quando: 't1', versao: 1 });
  registrarHistorico(dir, 'provider', { quando: 't2', falhou: 'x' });
  assert.ok(existsSync(join(dir, 'cabecas', 'provider', 'historico.jsonl')));
  assert.deepEqual(lerHistorico(dir, 'provider').map((h) => h.quando), ['t1', 't2']);
});

test('voltar da v1 cai no legado quando existe (e o ponteiro some); sem legado continua ok:false', () => {
  const dir = tmp();
  gravarVersao(dir, 'provider', { m: 1 });
  assert.equal(voltar(dir, 'provider').ok, false);
  mkdirSync(join(dir, 'cabecas'), { recursive: true });
  writeFileSync(join(dir, 'cabecas', 'provider.json'), '{}');
  assert.deepEqual(voltar(dir, 'provider'), { ok: true, versao: null, legado: true });
  assert.equal(caminhoAtual(dir, 'provider'), join(dir, 'cabecas', 'provider.json'));
  assert.equal(versaoAtual(dir, 'provider'), null);
});

test('poda: mantém as 10 versões mais recentes e nunca a atual; numeração segue', () => {
  const dir = tmp();
  for (let n = 1; n <= 13; n++) gravarVersao(dir, 'tool', { m: n });
  assert.deepEqual(listarVersoes(dir, 'tool'), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  assert.equal(versaoAtual(dir, 'tool'), 13);
  assert.equal(existsSync(caminhoAtual(dir, 'tool')), true);
  assert.equal(gravarVersao(dir, 'tool', { m: 14 }).versao, 14);
  assert.deepEqual(listarVersoes(dir, 'tool'), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  // voltar não quebra com versões podadas ao fundo
  assert.deepEqual(voltar(dir, 'tool'), { ok: true, versao: 13 });
});

test('reposição: grava e lê vetores crus sem texto', () => {
  const dir = tmp();
  assert.equal(lerReposicao(dir, 'provider').ok, false);
  gravarReposicao(dir, 'provider', { slug: 's', casos: [{ v: [0.1, 0.2], rotulos: ['a'] }] });
  const r = lerReposicao(dir, 'provider');
  assert.deepEqual([r.ok, r.slug, r.casos.length], [true, 's', 1]);
});

test('estadoDoPonteiro: ponteiro válido, sem ponteiro (legado ou nada), ponteiro ilegível e ponteiro para versão ausente — e caminhoAtual segue igual ao `arquivo`', () => {
  const dir = tmp();
  const legado = join(dir, 'cabecas', 'tool.json');
  const ponteiro = join(dir, 'cabecas', 'tool', 'atual.json');
  // nada
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: null, legado: false, motivo: null });
  // só legado, sem ponteiro: estado normal de antes das versões (sem motivo)
  mkdirSync(join(dir, 'cabecas'), { recursive: true }); writeFileSync(legado, '{}');
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: legado, legado: true, motivo: null });
  // ponteiro válido: a versão apontada vale e o legado não
  gravarVersao(dir, 'tool', { x: 1 }); gravarVersao(dir, 'tool', { x: 2 });
  const v2 = join(dir, 'cabecas', 'tool', 'v2.json');
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: v2, legado: false, motivo: null });
  // ponteiro ilegível (JSON quebrado): cai no legado, dizendo por quê
  writeFileSync(ponteiro, '{quebrado');
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: legado, legado: true, motivo: 'ponteiro-ilegivel' });
  // ponteiro com JSON válido mas sem os campos: também ilegível
  writeFileSync(ponteiro, JSON.stringify({ versao: 'dois' }));
  assert.equal(estadoDoPonteiro(dir, 'tool').motivo, 'ponteiro-ilegivel');
  // ponteiro bom apontando para versão que não existe: versao-ausente
  writeFileSync(ponteiro, JSON.stringify({ versao: 9, arquivo: 'v9.json' }));
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: legado, legado: true, motivo: 'versao-ausente' });
  // sem legado, o ponteiro quebrado não tem para onde cair: arquivo null, mas o motivo continua dito
  unlinkSync(legado);
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: null, legado: false, motivo: 'versao-ausente' });
  writeFileSync(ponteiro, '');
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: null, legado: false, motivo: 'ponteiro-ilegivel' });
  // o contrato de caminhoAtual não mudou: é sempre o `arquivo`
  assert.equal(caminhoAtual(dir, 'tool'), null);
  writeFileSync(legado, '{}');
  assert.equal(caminhoAtual(dir, 'tool'), legado);
  writeFileSync(ponteiro, JSON.stringify({ versao: 1, arquivo: 'v1.json' }));
  assert.equal(caminhoAtual(dir, 'tool'), join(dir, 'cabecas', 'tool', 'v1.json'));
  assert.deepEqual(estadoDoPonteiro(dir, 'tool'), { arquivo: join(dir, 'cabecas', 'tool', 'v1.json'), legado: false, motivo: null });
});

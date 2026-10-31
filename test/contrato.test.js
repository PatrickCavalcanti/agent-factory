// Contrato público do pacote: lista de subpaths do `exports` e, para cada um,
// a lista ordenada de nomes exportados, congelada em test/contrato.snapshot.json.
//
// ATENÇÃO: atualizar o snapshot é MUDANÇA DE CONTRATO e pede entrada no
// CHANGELOG (adição = minor/feature, remoção ou renomeação = breaking).
// Para atualizar de forma explícita:
//   ATUALIZAR_CONTRATO=1 node --test test/contrato.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const arquivoSnapshot = path.join(raiz, 'test', 'contrato.snapshot.json');
const atualizar = process.env.ATUALIZAR_CONTRATO === '1';

const subpaths = Object.keys(pkg.exports);

function especificador(subpath) {
  return subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
}

async function medir() {
  const atual = {};
  for (const sp of subpaths) {
    const mod = await import(especificador(sp));
    atual[sp] = Object.keys(mod).sort();
  }
  return atual;
}

function diff(esperado, atual) {
  const linhas = [];
  const sps = [...new Set([...Object.keys(esperado), ...Object.keys(atual)])].sort();
  for (const sp of sps) {
    if (!(sp in atual)) { linhas.push(`- subpath removido: ${sp}`); continue; }
    if (!(sp in esperado)) { linhas.push(`+ subpath novo: ${sp} (${atual[sp].length} nomes)`); continue; }
    const e = new Set(esperado[sp]);
    const a = new Set(atual[sp]);
    for (const n of e) if (!a.has(n)) linhas.push(`- ${sp}: export removido "${n}"`);
    for (const n of a) if (!e.has(n)) linhas.push(`+ ${sp}: export novo "${n}"`);
  }
  return linhas.join('\n');
}

test('o mapa exports aponta para arquivos existentes', () => {
  for (const [sp, alvo] of Object.entries(pkg.exports)) {
    assert.equal(typeof alvo, 'string', `${sp}: alvo deve ser string`);
    assert.ok(fs.existsSync(path.join(raiz, alvo)), `${sp} aponta para arquivo inexistente: ${alvo}`);
  }
});

test('contrato público (subpaths e nomes exportados) bate com o snapshot', async () => {
  const atual = await medir();
  if (atualizar) {
    fs.writeFileSync(arquivoSnapshot, JSON.stringify(atual, null, 2) + '\n');
    return;
  }
  assert.ok(fs.existsSync(arquivoSnapshot), 'snapshot ausente: rode com ATUALIZAR_CONTRATO=1');
  const esperado = JSON.parse(fs.readFileSync(arquivoSnapshot, 'utf8'));
  const d = diff(esperado, atual);
  assert.equal(
    d,
    '',
    `Contrato mudou (mudança de contrato pede CHANGELOG; para aceitar: ATUALIZAR_CONTRATO=1 node --test test/contrato.test.js):\n${d}`,
  );
});

test('diff do contrato é legível (autoteste)', () => {
  const d = diff({ '.': ['a', 'b'], './x': ['c'] }, { '.': ['a', 'z'], './y': [] });
  assert.match(d, /- \.: export removido "b"/);
  assert.match(d, /\+ \.: export novo "z"/);
  assert.match(d, /- subpath removido: \.\/x/);
  assert.match(d, /\+ subpath novo: \.\/y/);
});

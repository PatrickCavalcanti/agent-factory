// Pureza do pacote: o código (fora de comentários) não pode depender do Igris
// nem do ambiente do processo, nem sair da raiz do pacote, nem importar pacote
// que não esteja declarado em dependencies/peerDependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8'));
const PASTAS = ['orquestrador/src', 'decisoes/src', 'decisoes/treino/lib', 'apoio/src'];
const declarados = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);
const nativos = new Set(builtinModules);

/**
 * Troca comentários (de linha e de bloco) por espaços, preservando quebras de linha
 * (números de linha continuam válidos). Respeita aspas, template literals
 * (com ${} aninhado) e literais de regex.
 */
export function removerComentarios(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const pilha = []; // profundidade de chaves abertas dentro de ${ } de templates
  let ultimoSignificativo = ''; // último caractere de código não-espaço (para regex x divisão)
  let ultimaPalavra = '';
  const palavrasAntesDeRegex = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

  const lerTemplate = () => {
    // posição i está logo após a crase (ou após o } de uma interpolação)
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; ultimoSignificativo = '`'; return; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'; i += 2; pilha.push(0); ultimoSignificativo = '{'; return 'interp';
      }
      out += c; i++;
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; } else { out += src[i]; i++; }
      }
      if (i < n && src[i] === c) { out += c; i++; }
      ultimoSignificativo = c; ultimaPalavra = '';
      continue;
    }
    if (c === '`') {
      out += c; i++;
      lerTemplate();
      continue;
    }
    if (c === '{' && pilha.length) { pilha[pilha.length - 1]++; out += c; i++; ultimoSignificativo = c; continue; }
    if (c === '}' && pilha.length) {
      if (pilha[pilha.length - 1] === 0) {
        pilha.pop(); out += c; i++;
        lerTemplate();
        continue;
      }
      pilha[pilha.length - 1]--; out += c; i++; ultimoSignificativo = c; continue;
    }
    if (c === '/') {
      const regexAqui =
        ultimoSignificativo === '' ||
        '(,=:[!&|?{};+-*%<>~^'.includes(ultimoSignificativo) ||
        palavrasAntesDeRegex.has(ultimaPalavra);
      if (regexAqui) {
        out += c; i++;
        let classe = false;
        while (i < n && src[i] !== '\n') {
          const r = src[i];
          if (r === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
          if (r === '[') classe = true;
          else if (r === ']') classe = false;
          else if (r === '/' && !classe) break;
          out += r; i++;
        }
        if (i < n && src[i] === '/') { out += '/'; i++; }
        while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; }
        ultimoSignificativo = ')'; ultimaPalavra = '';
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      ultimaPalavra = src.slice(i, j);
      out += ultimaPalavra; i = j; ultimoSignificativo = 'a';
      continue;
    }
    out += c; i++;
    if (!/\s/.test(c)) { ultimoSignificativo = c; ultimaPalavra = ''; }
  }
  return out;
}

function linhaDe(texto, indice) {
  let l = 1;
  for (let k = 0; k < indice; k++) if (texto.charCodeAt(k) === 10) l++;
  return l;
}

function nomeDoPacote(espec) {
  const partes = espec.split('/');
  return espec.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0];
}

/** Retorna lista de { linha, motivo } para um fonte. */
export function analisar(src, arquivoAbs) {
  const codigo = removerComentarios(src);
  const v = [];
  const achar = (re, motivo) => {
    for (const m of codigo.matchAll(re)) v.push({ linha: linhaDe(codigo, m.index), motivo: `${motivo}: ${m[0].trim()}` });
  };
  achar(/@igris\//g, 'referência a @igris/');
  achar(/IGRIS_/g, 'texto IGRIS_');
  // Ambiente do processo, em todas as formas: `process.env`, `process?.env`, `process['env']`, e desestruturação
  // (`const { env } = process`, `{ env: e } = process`, também com valor padrão ou outras chaves ao lado).
  achar(/process\s*\??\s*\.\s*env\b/g, 'process.env');
  achar(/process\s*(?:\?\.\s*)?\[\s*(['"`])env\1\s*\]/g, "process['env']");
  achar(/\{(?:[^{}]|\{[^{}]*\})*\benv\b(?:[^{}]|\{[^{}]*\})*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b(?!\s*[.\[])/g, 'desestruturação de process.env');

  // `new URL('../..', import.meta.url)` que resolva para fora da raiz do pacote (relativo ao arquivo analisado).
  for (const m of codigo.matchAll(/new\s+URL\s*\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url/g)) {
    if (!m[2].startsWith('.') && !m[2].startsWith('/')) continue;
    const rel = path.relative(raiz, path.resolve(path.dirname(arquivoAbs), m[2]));
    if (rel.startsWith('..') || path.isAbsolute(rel)) v.push({ linha: linhaDe(codigo, m.index), motivo: `new URL sai da raiz do pacote: ${m[2]}` });
  }

  const verificarEspec = (espec, linha) => {
    if (espec.startsWith('.') || espec.startsWith('/')) {
      const alvo = path.resolve(path.dirname(arquivoAbs), espec);
      const rel = path.relative(raiz, alvo);
      if (rel.startsWith('..') || path.isAbsolute(rel)) v.push({ linha, motivo: `import relativo sai da raiz do pacote: ${espec}` });
    } else if (espec.startsWith('node:')) {
      // ok
    } else {
      const nome = nomeDoPacote(espec);
      if (nativos.has(nome) || nativos.has(espec)) return;
      if (!declarados.has(nome)) v.push({ linha, motivo: `pacote não declarado em dependencies/peerDependencies: ${espec}` });
    }
  };

  const reImport = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
  for (const m of codigo.matchAll(reImport)) verificarEspec(m[2], linhaDe(codigo, m.index));

  // `createRequire(...)('x')` direto, ou via a variável que recebeu o `createRequire(...)` (`req('x')`, `req.resolve('x')`).
  for (const m of codigo.matchAll(/createRequire\s*\([^()]*\)\s*(?:\.\s*resolve\s*)?\(\s*(['"`])([^'"`\n]+)\1/g)) verificarEspec(m[2], linhaDe(codigo, m.index));
  for (const d of codigo.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\w+\s*\.\s*)?createRequire\s*\(/g)) {
    const re = new RegExp(`\\b${d[1].replace(/\$/g, '\\$')}\\s*(?:\\.\\s*resolve\\s*)?\\(\\s*(['"\`])([^'"\`\\n]+)\\1`, 'g');
    for (const m of codigo.matchAll(re)) verificarEspec(m[2], linhaDe(codigo, m.index));
  }
  return v;
}

function listar(dir) {
  const res = [];
  if (!fs.existsSync(dir)) return res;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...listar(p));
    else if (/\.(m?js)$/.test(e.name)) res.push(p);
  }
  return res;
}

test('o código das pastas do pacote é puro (sem Igris, sem process.env, sem sair da raiz)', () => {
  const arquivos = PASTAS.flatMap((p) => listar(path.join(raiz, p)));
  assert.ok(arquivos.length > 0, 'nenhum arquivo varrido');
  const violacoes = [];
  for (const arq of arquivos) {
    const src = fs.readFileSync(arq, 'utf8');
    for (const x of analisar(src, arq)) violacoes.push(`${path.relative(raiz, arq)}:${x.linha}  ${x.motivo}`);
  }
  assert.equal(violacoes.length, 0, `Violações de pureza:\n${violacoes.join('\n')}`);
});

// --- testes do removedor de comentários -----------------------------------
const rc = removerComentarios;

test('removedor: comentário de linha e de bloco somem, linhas preservadas', () => {
  const s = rc('a // IGRIS_X\n/* @igris/y\n process.env */ b');
  assert.ok(!/IGRIS_|@igris|process/.test(s));
  assert.equal(s.split('\n').length, 3);
  assert.match(s, /a\s+\n/);
  assert.match(s, /\s+b$/);
});

test('removedor: // dentro de string ou URL não é comentário', () => {
  assert.match(rc(`const u = 'http://x.com/IGRIS_A'; // fim`), /IGRIS_A/);
  assert.match(rc(`const u = "a//IGRIS_B";`), /IGRIS_B/);
  assert.ok(!/fim/.test(rc(`const u = 'x'; // fim`)));
});

test('removedor: aspas escapadas e comentário-em-string com /*', () => {
  assert.match(rc(`const s = 'it\\'s // IGRIS_C'; x`), /IGRIS_C/);
  assert.match(rc(`const s = "/* IGRIS_D */"; y`), /IGRIS_D/);
});

test('removedor: template literal conta como código, inclusive interpolação', () => {
  assert.match(rc('const t = `a // IGRIS_E ${x}`;'), /IGRIS_E/);
  assert.match(rc('const t = `${ `// IGRIS_F` } ${ {a:1}.a } z`; // fora'), /IGRIS_F/);
  assert.ok(!/fora/.test(rc('const t = `${ {a:1}.a } z`; // fora')));
  assert.match(rc('const t = `${a /* IGRIS_G */}`;'), /^[^]*\$\{a\s+\}`/);
  assert.ok(!/IGRIS_G/.test(rc('const t = `${a /* IGRIS_G */}`;')));
});

test('removedor: regex com // ou aspas não confunde', () => {
  assert.ok(!/segredo/.test(rc(`const r = /\\/\\//; // segredo`)));
  assert.match(rc(`const r = /["']/g; const q = 'IGRIS_H';`), /IGRIS_H/);
  assert.match(rc(`const r = /[/]x/; z = 'IGRIS_I'`), /IGRIS_I/);
  // divisão não é regex
  assert.ok(!/cmt/.test(rc(`const d = a / b; // cmt`)));
});

test('removedor: JSDoc é comentário', () => {
  assert.ok(!/IGRIS_J/.test(rc('/**\n * @see IGRIS_J\n * @igris/x\n */\nexport const a = 1;')));
});

test('scanner: detecta cada forma de violação com a linha certa', () => {
  const f = path.join(raiz, 'orquestrador/src/x.js');
  const src = [
    "import a from '@igris/x';",
    "const b = await import('@igris/y');",
    "const c = process.env.FOO;",
    "const d = 'IGRIS_Z';",
    "import e from '../../../fora.js';",
    "import g from 'lodash';",
    "import ok1 from 'node:fs';",
    "import ok2 from 'zod';",
    "import ok3 from 'path';",
    "import ok4 from '@okds/kairos/sub';",
    "// import h from '@igris/comentado'; process.env",
  ].join('\n');
  const r = analisar(src, f);
  const linhas = r.map((x) => x.linha);
  assert.deepEqual([...new Set(linhas)].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.ok(r.some((x) => x.linha === 6 && /lodash/.test(x.motivo)));
  assert.ok(!r.some((x) => x.linha >= 7));
});

test('scanner: process.env em todas as formas (acesso por colchete, optional chaining, desestruturação)', () => {
  const f = path.join(raiz, 'orquestrador/src/x.js');
  const casos = [
    ["const a = process['env'].X;", true],
    ['const a = process["env"].X;', true],
    ['const a = process[`env`].X;', true],
    ['const a = process?.env?.X;', true],
    ['const { env } = process;', true],
    ['const { env: e } = process;', true],
    ['const { pid, env = {} } = process;', true],
    ['let env; ({ env } = process);', true],
    ['const { env } = globalThis.process;', true],
    // não são violação
    ['const { pid } = process;', false],
    ['const { env } = opcoes;', false],
    ['const { env } = process.versions;', false],
    ["const a = process['pid'];", false],
    ['const envio = 1; // process.env', false],
  ];
  for (const [src, viola] of casos) {
    const r = analisar(src, f);
    assert.equal(r.length > 0, viola, `${src} → ${JSON.stringify(r)}`);
  }
});

test('scanner: new URL(..., import.meta.url) que sai da raiz do pacote', () => {
  const f = path.join(raiz, 'orquestrador/src/x.js');
  const r = analisar("const u = new URL('../../..', import.meta.url);", f);
  assert.equal(r.length, 1);
  assert.match(r[0].motivo, /new URL sai da raiz/);
  assert.equal(analisar("const u = new URL('../../../fora.json', import.meta.url);", f).length, 1);
  // dentro da raiz, ou URL absoluta/outra base: ok
  assert.equal(analisar("const u = new URL('../dados.json', import.meta.url);", f).length, 0);
  assert.equal(analisar("const u = new URL('./dados.json', import.meta.url);", f).length, 0);
  assert.equal(analisar("const u = new URL('https://x.com/a', import.meta.url);", f).length, 0);
  assert.equal(analisar("const u = new URL('../../..', base);", f).length, 0);
});

test('scanner: createRequire(...)(espec) — direto ou via variável — segue as mesmas regras de import', () => {
  const f = path.join(raiz, 'orquestrador/src/x.js');
  const pre = "import { createRequire } from 'node:module';\n";
  const direto = analisar(`${pre}const x = createRequire(import.meta.url)('../../..');`, f);
  assert.equal(direto.length, 1);
  assert.match(direto[0].motivo, /sai da raiz/);
  const viaVar = analisar(`${pre}const req = createRequire(import.meta.url);\nconst x = req('../../../fora.js');\nconst y = req.resolve('lodash');`, f);
  assert.deepEqual(viaVar.map((x) => x.linha), [3, 4]);
  assert.match(viaVar[0].motivo, /sai da raiz/);
  assert.match(viaVar[1].motivo, /lodash/);
  // permitido: relativo dentro da raiz, pacote declarado, builtin
  assert.equal(analisar(`${pre}const req = createRequire(import.meta.url);\nreq('../src/y.js'); req('zod'); req('node:fs');`, f).length, 0);
});

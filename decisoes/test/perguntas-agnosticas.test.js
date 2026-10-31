// Adendo §14 (2026-09-18), regra A1: nenhum texto de packages/decisions/src/perguntas.js
// pode citar power, tool ou valor concreto — o sentido de cada valor vem do schema do
// power, não de um prompt que "sabe" o caso de teste. Trava mecânica: ler o arquivo como
// texto e procurar (a) o id de qualquer power hoje em packages/powers/src/powers/* e (b)
// as strings específicas do caso de teste que motivou o adendo (gcal_listar_eventos,
// task_listar, "amanha", "pending" — sessões e0833cf2/ba1a6023).
//
// Correção 3 (review Fase 1, 2026-09-18): três reforços na trava.
// 1. Normaliza acento (NFD + remove diacríticos) e caixa antes de comparar — a versão
//    anterior só fazia toLowerCase(), então "memória" (texto) nunca batia com o id
//    "memoria" (sem acento), furo mecânico na trava.
// 2. Lista fixa ganhou calendar/agenda/tarefa/evento — termos de domínio que um texto
//    genérico poderia vazar mesmo sem citar o id do power inteiro.
// 3. Além do id inteiro, cada SEGMENTO do id (separado por "-"/"_") com ≥5 chars — ex.
//    "calendar" de "google-calendar" — e cada valor de `enum` declarado em qualquer
//    packages/powers/src/powers/*/power.json com ≥5 chars entram na checagem: um id
//    composto pode vazar por metade, e um enum concreto (ex. "video" de whatsapp) é tão
//    específico quanto o nome do power.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PERGUNTAS_PATH = path.join(AQUI, '..', 'src', 'perguntas.js');

const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// A primeira linha de perguntas.js é o comentário de caminho (`// packages/decisions/src/perguntas.js`).
// Ele não é texto de pergunta e cita o nome do próprio pacote — que passou a coincidir com um valor
// de enum de power.json (categoria: "decisions", memoria), gerando falso positivo. Descarta-se o
// cabeçalho (só a linha que é EXATAMENTE um comentário de caminho de arquivo), em vez de excluir o
// termo: excluir "decisions" deixaria um vazamento real dessa palavra no corpo passar em silêncio.
const CABECALHO_DE_CAMINHO = /^\/\/ [\w./-]+\.js[^\S\r\n]*(?:\r?\n|$)/;
export function semCabecalhoDeCaminho(texto) {
  return texto.replace(CABECALHO_DE_CAMINHO, '');
}

// A trava protege o TEXTO DAS PERGUNTAS enviado ao modelo, não os comentários do código: um
// comentário como "review do conjunto" não vaza nada, mas casaria com o valor de enum "review"
// (md_notes, status) e quebraria a trava a cada enum novo que coincida com vocabulário de
// desenvolvimento. Remove `//` de linha e `/* */` de bloco — mas só FORA de string: um
// scanner mínimo que respeita '…', "…" e template literals (com `${ … }` aninhado), para que
// um "http://…" ou um termo de enum dentro de uma pergunta continue sendo lido e pego.
export function semComentarios(texto) {
  let saida = '';
  // pilha de contextos: 'codigo' (topo do arquivo ou dentro de `${ }`) e 'template'
  const pilha = ['codigo'];
  // contagem de chaves abertas dentro de cada `${ }` em curso, para achar o `}` que o fecha
  const chaves = [];
  let i = 0;
  while (i < texto.length) {
    const c = texto[i];
    const n = texto[i + 1];
    const contexto = pilha[pilha.length - 1];
    if (contexto === 'template') {
      if (c === '\\') { saida += c + (n ?? ''); i += 2; continue; }
      if (c === '`') { pilha.pop(); saida += c; i += 1; continue; }
      if (c === '$' && n === '{') { pilha.push('codigo'); chaves.push(0); saida += '${'; i += 2; continue; }
      saida += c; i += 1; continue;
    }
    // contexto 'codigo'
    if (c === '/' && n === '/') { while (i < texto.length && texto[i] !== '\n') i += 1; continue; }
    if (c === '/' && n === '*') {
      const fim = texto.indexOf('*/', i + 2);
      i = fim === -1 ? texto.length : fim + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < texto.length && texto[j] !== c && texto[j] !== '\n') j += texto[j] === '\\' ? 2 : 1;
      saida += texto.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') { pilha.push('template'); saida += c; i += 1; continue; }
    if (chaves.length > 0) {
      if (c === '{') chaves[chaves.length - 1] += 1;
      else if (c === '}') {
        if (chaves[chaves.length - 1] === 0) { chaves.pop(); pilha.pop(); saida += c; i += 1; continue; }
        chaves[chaves.length - 1] -= 1;
      }
    }
    saida += c; i += 1;
  }
  return saida;
}

test('cabeçalho de caminho é descartado, mas o mesmo termo no corpo continua sendo pego (controle)', () => {
  const cabecalho = '// packages/decisions/src/perguntas.js\n';
  assert.equal(semCabecalhoDeCaminho(`${cabecalho}export const X = 'a';`), "export const X = 'a';");
  assert.ok(!normalizar(semCabecalhoDeCaminho(`${cabecalho}export const X = 'a';`)).includes('decisions'));
  // vazamento real no corpo (inclusive em outro comentário) não é descartado
  assert.ok(normalizar(semCabecalhoDeCaminho(`${cabecalho}// categoria decisions\nexport const X = 'a';`)).includes('decisions'));
  assert.ok(normalizar(semCabecalhoDeCaminho(`export const X = 'decisions';`)).includes('decisions'));
});

test('comentários são descartados, mas termo de enum dentro de texto de pergunta continua sendo pego (controle)', () => {
  // comentário de linha e de bloco somem
  assert.ok(!semComentarios('// review do conjunto\nconst X = 1;').includes('review'));
  assert.ok(!semComentarios('/* review\n do conjunto */ const X = 1;').includes('review'));
  assert.ok(!semComentarios('const X = 1; // review no fim da linha').includes('review'));
  // o mesmo termo em string de pergunta (aspas simples, duplas, template e `${ }`) é mantido
  assert.ok(semComentarios("const P = 'faça o review agora'; // review").includes('review agora'));
  assert.ok(semComentarios('const P = "faça o review agora";').includes('review agora'));
  assert.ok(semComentarios('const P = `faça o review agora`;').includes('review agora'));
  assert.ok(semComentarios('const P = `a ${f("review")} b`;').includes('review'));
  // `//` dentro de string não é comentário (URL), e o que vem depois na linha é mantido
  assert.ok(semComentarios("const P = 'http://x/review'; const Q = 'review';").includes("const Q = 'review'"));
  // o teste de agnosticismo, alimentado por um texto que só cita o enum em comentário, passa;
  // citado na pergunta, é pego
  const enumsReview = ['review'];
  const acha = (fonte) => enumsReview.filter((t) => normalizar(semComentarios(fonte)).includes(t));
  assert.deepEqual(acha('// review do conjunto\nexport const P = `pergunta genérica`;'), []);
  assert.deepEqual(acha('// nada\nexport const P = `faça o review`;'), ['review']);
  // o arquivo real: nenhum comentário sobra (o scanner não se perde em regex/template do arquivo)
  const real = semComentarios(fs.readFileSync(PERGUNTAS_PATH, 'utf8'));
  assert.ok(!/^\s*\/\//m.test(real), 'sobrou linha de comentário em perguntas.js após semComentarios');
});

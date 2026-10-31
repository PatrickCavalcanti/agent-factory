import test from 'node:test';
import assert from 'node:assert/strict';
import { classificarResposta, terminouComPergunta, decidirContinuidade, comUltimaDoAssistentePeloFim, MAX_CHARS_ULTIMA_DO_ASSISTENTE, MAX_PALAVRAS_RESPOSTA_CURTA } from '../src/continuidade.js';

test('classificarResposta: confirmações puras', () => {
  for (const t of ['ok', 'Ok.', 'sim', 'Sim, pode.', 'pode ser', 'manda ver', 'isso mesmo!', 'tá bom', 'beleza 👍', 'aprovado', 'pode seguir']) {
    assert.equal(classificarResposta(t), 'confirmacao', t);
  }
});

test('classificarResposta: curta não pura e longa', () => {
  assert.equal(classificarResposta('não'), 'curta');
  assert.equal(classificarResposta('sim, mas sem a Fundect'), 'curta');
  assert.equal(classificarResposta('Não, coloca dentro do nó de conhecimento OkApp.'), 'curta');
  const longa = Array.from({ length: MAX_PALAVRAS_RESPOSTA_CURTA + 1 }, (_, i) => `palavra${i}`).join(' ');
  assert.equal(classificarResposta(longa), 'longa');
  assert.equal(classificarResposta('   '), 'vazia');
});

test('terminouComPergunta: purpose clarification ou ? no fim', () => {
  assert.equal(terminouComPergunta({ purposes: ['progress', 'clarification'], chatFinal: 'Feito.' }), true);
  assert.equal(terminouComPergunta({ purposes: [], chatFinal: 'Estrutura:\n- A\n\n**Aprova essa estrutura?**' }), true);
  assert.equal(terminouComPergunta({ purposes: ['final'], chatFinal: 'Pronto, criei a nota.' }), false);
  assert.equal(terminouComPergunta({}), false);
});

test('decidirContinuidade: intenção vence a forma da resposta', () => {
  const anterior = { terminouComPergunta: true, intencao: [{ funcao: 'conhecimento__kb_no_gravar' }] };
  assert.deepEqual(decidirContinuidade({ texto: 'faz isso e depois me manda o resumo completo do documento inteiro por favor', anterior }), { trivial: false, motivo: 'intencao', classe: 'longa' });
});

test('decidirContinuidade: pergunta + resposta curta', () => {
  assert.deepEqual(decidirContinuidade({ texto: 'ok', anterior: { terminouComPergunta: true, intencao: null } }), { trivial: false, motivo: 'pergunta+curta', classe: 'confirmacao' });
  assert.deepEqual(decidirContinuidade({ texto: 'não, em outro lugar', anterior: { terminouComPergunta: true } }), { trivial: false, motivo: 'pergunta+curta', classe: 'curta' });
});

test('decidirContinuidade: sem opinião', () => {
  assert.equal(decidirContinuidade({ texto: 'ok', anterior: null }), null);
  assert.equal(decidirContinuidade({ texto: 'ok', anterior: { terminouComPergunta: false } }), null);
  const longa = Array.from({ length: 13 }, (_, i) => `p${i}`).join(' ');
  assert.equal(decidirContinuidade({ texto: longa, anterior: { terminouComPergunta: true } }), null);
});

test('terminouComPergunta: URL com "?" no fim não é pergunta; fechos ] e crase são tolerados', () => {
  assert.equal(terminouComPergunta({ chatFinal: 'Veja [o site](https://exemplo.test/?)' }), false);
  assert.equal(terminouComPergunta({ chatFinal: 'Veja https://exemplo.test/?' }), false);
  assert.equal(terminouComPergunta({ chatFinal: '[Aprova?]' }), true);
  assert.equal(terminouComPergunta({ chatFinal: '**Aprova?**' }), true);
  assert.equal(terminouComPergunta({ chatFinal: 'Posso usar `kb_no_gravar`?' }), true);
  assert.equal(terminouComPergunta({ chatFinal: 'Abri https://exemplo.test/a?b=1 agora. Aprova?' }), true);
});

test('classificarResposta: o limite de palavras vale antes da lista de aceites', () => {
  const treze = Array.from({ length: MAX_PALAVRAS_RESPOSTA_CURTA + 1 }, () => 'ok').join(' ');
  assert.equal(classificarResposta(treze), 'longa');
  assert.equal(classificarResposta(Array.from({ length: MAX_PALAVRAS_RESPOSTA_CURTA }, () => 'ok').join(' ')), 'confirmacao');
});

test('decidirContinuidade: pergunta + 13x "ok" não opina; intenção continua valendo para qualquer classe', () => {
  const treze = Array.from({ length: 13 }, () => 'ok').join(' ');
  assert.equal(decidirContinuidade({ texto: treze, anterior: { terminouComPergunta: true, intencao: null } }), null);
  assert.deepEqual(
    decidirContinuidade({ texto: treze, anterior: { terminouComPergunta: true, intencao: [{ funcao: 'x' }] } }),
    { trivial: false, motivo: 'intencao', classe: 'longa' },
  );
});

// Revisão do conjunto, I4: a reserva do "?" só vale para o chat sem `_fala` (spec §4.2).
test('terminouComPergunta: com _fala "final" o "?" de cortesia não conta; sem _fala conta', () => {
  assert.equal(terminouComPergunta({ purposes: ['final'], chatFinal: 'Feito. Quer que eu crie um lembrete também?' }), false);
  assert.equal(terminouComPergunta({ purposes: ['progress', 'final'], chatFinal: 'Feito. Quer um lembrete?' }), false);
  assert.equal(terminouComPergunta({ purposes: [], chatFinal: 'Aprova?' }), true);
  // `clarification` continua o sinal principal, com ou sem "?".
  assert.equal(terminouComPergunta({ purposes: ['clarification'], chatFinal: 'Posso criar em duas pastas.' }), true);
});

// Revisão do conjunto, I1: a pergunta fica no FIM da proposta; a última do assistente entra pelo fim.
test('comUltimaDoAssistentePeloFim: proposta longa fica com os últimos 1500 caracteres (… no início), sem mutar', () => {
  const proposta = `${'item da estrutura. '.repeat(250)}Aprova?`;
  assert.ok(proposta.length > 3500);
  const msgs = [{ role: 'user', content: 'organiza a base' }, { role: 'assistant', content: proposta }];
  const r = comUltimaDoAssistentePeloFim(msgs);
  assert.equal(r[1].content.length, MAX_CHARS_ULTIMA_DO_ASSISTENTE + 1);
  assert.ok(r[1].content.startsWith('…'));
  assert.ok(r[1].content.endsWith('Aprova?'));
  assert.equal(msgs[1].content, proposta, 'a lista original não é mutada');
  assert.equal(r[0], msgs[0]);
});

test('comUltimaDoAssistentePeloFim: curta, sem assistente ou conteúdo não-string devolve a própria lista; só a ÚLTIMA do assistente', () => {
  const curta = [{ role: 'assistant', content: 'Aprova?' }];
  assert.equal(comUltimaDoAssistentePeloFim(curta), curta);
  const soUsuario = [{ role: 'user', content: 'x'.repeat(5000) }];
  assert.equal(comUltimaDoAssistentePeloFim(soUsuario), soUsuario);
  const naoString = [{ role: 'assistant', content: null, _fala: { text: 'y'.repeat(5000) } }];
  assert.equal(comUltimaDoAssistentePeloFim(naoString), naoString);
  const duas = [{ role: 'assistant', content: 'a'.repeat(4000) }, { role: 'user', content: 'ok' }, { role: 'assistant', content: 'b'.repeat(4000) }];
  const r = comUltimaDoAssistentePeloFim(duas);
  assert.equal(r[0], duas[0], 'a anterior fica como está');
  assert.equal(r[2].content.length, MAX_CHARS_ULTIMA_DO_ASSISTENTE + 1);
});

// Revisão do conjunto, rodada 2 (N1 — mesma classe do I4): decide a ÚLTIMA fala do turno, não a lista achatada.
test('terminouComPergunta: última fala decide — progress + "?" real conta; clarification resolvida e seguida de final não conta', () => {
  assert.equal(terminouComPergunta({ purposes: ['progress'], chatFinal: 'Achei três notas.\nQual delas você quer abrir?' }), true);
  assert.equal(terminouComPergunta({ purposes: ['progress'], chatFinal: 'Abrindo a nota agora.' }), false);
  assert.equal(terminouComPergunta({ purposes: ['clarification', 'final'], chatFinal: 'Pronto, criei.' }), false);
  assert.equal(terminouComPergunta({ purposes: ['final', 'clarification'], chatFinal: 'Qual?' }), true);
  assert.equal(terminouComPergunta({ purposes: ['final'], chatFinal: 'Feito. Quer que eu crie um lembrete também?' }), false);
});

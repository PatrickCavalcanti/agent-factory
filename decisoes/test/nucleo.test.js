// Núcleo genérico (Fase 0, Task 0.1): perguntar() — prazo macio, resposta tardia, nunca
// lança; formas (choice/noul/score) — validação de limites, erro de forma é exceção
// nomeada; cortarEstado — corte genérico por tamanho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perguntar, TETO_TARDIO_MS, choice, noul, score, TETO_PERGUNTAS, ErroDeForma, cortarEstado } from '../src/nucleo/index.js';

// --- perguntar() -------------------------------------------------------------------------

const clienteQueDemora = (ms, resultado) => ({ modelo: 'fake', decidir: () => new Promise((res, rej) => setTimeout(() => (resultado instanceof Error ? rej(resultado) : res(resultado)), ms)) });
const respostasOk = { answers: { pronto: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, cost: 0.0000004 }, modelo: 'fake', ms: 5 };

test('perguntar: dentro do prazo — devolve answers e meta.degradado false, sem chamar aoChegarTarde', async () => {
  let chamouTarde = false;
  const r = await perguntar({ state: { pedido: 'x' }, questions: { pronto: { type: 'noul', instructions: 'i' } }, cliente: clienteQueDemora(5, respostasOk), prazoMs: 200, aoChegarTarde: () => { chamouTarde = true; } });
  assert.equal(r.meta.degradado, false);
  assert.deepEqual(r.answers, respostasOk.answers);
  assert.equal(r.meta.tokens, 10);
  assert.equal(r.meta.custo, respostasOk.usage.cost);
  assert.equal(r.meta.modelo, 'fake');
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(chamouTarde, false);
});

test('perguntar: estoura o prazo — devolve degradado timeout na hora, e a resposta tardia chega a aoChegarTarde com msReal', async () => {
  let tardia;
  const chegou = new Promise((res) => { tardia = res; });
  const t0 = Date.now();
  const r = await perguntar({ state: { pedido: 'x' }, questions: {}, cliente: clienteQueDemora(120, respostasOk), prazoMs: 30, aoChegarTarde: (t) => tardia(t) });
  assert.equal(r.meta.degradado, 'timeout');
  assert.match(r.meta.erro, /prazo de 30ms/);
  assert.ok(Date.now() - t0 < 110, 'não esperou a resposta real');
  const t = await chegou;
  assert.equal(t.meta.degradado, false);
  assert.deepEqual(t.answers, respostasOk.answers);
  assert.ok(t.meta.msReal >= 100);
});

test('perguntar: erro antes do prazo continua degradando pelo erro, sem esperar aoChegarTarde', async () => {
  const r = await perguntar({ state: { pedido: 'x' }, questions: {}, cliente: clienteQueDemora(5, new Error('decisions: HTTP 500 após 1 tentativas')), prazoMs: 200 });
  assert.equal(r.meta.degradado, 'erro');
  assert.match(r.meta.erro, /HTTP 500/);
});

test('perguntar: erro depois do prazo chega como tardia degradada, sem rejeição solta', async () => {
  let tardia;
  const chegou = new Promise((res) => { tardia = res; });
  const r = await perguntar({ state: { pedido: 'x' }, questions: {}, cliente: clienteQueDemora(60, new Error('decisions: timeout após 15000ms')), prazoMs: 10, aoChegarTarde: (t) => tardia(t) });
  assert.equal(r.meta.degradado, 'timeout');
  const t = await chegou;
  assert.equal(t.meta.degradado, 'timeout');
  assert.match(t.meta.erro, /timeout após 15000ms/);
});

test('perguntar: nunca lança — sem cliente devolve degradado sem-chave', async () => {
  const r = await perguntar({ state: { pedido: 'x' }, questions: {}, cliente: null });
  assert.equal(r.meta.degradado, 'sem-chave');
  assert.deepEqual(r.answers, {});
});

test('perguntar: nunca lança — cliente síncrono que lança na hora ainda degrada, sem prazoMs', async () => {
  const cliente = { decidir: async () => { throw new Error('decisions: chave da OpenRouter ausente'); } };
  const r = await perguntar({ state: { pedido: 'x' }, questions: {}, cliente });
  assert.equal(r.meta.degradado, 'sem-chave');
});

test('TETO_TARDIO_MS: soma o prazo macio ao teto duro, 15000ms', () => {
  assert.equal(TETO_TARDIO_MS, 15000);
});

// --- formas: choice/noul/score ------------------------------------------------------------

test('choice: monta {type, instructions, criteria} normalmente', () => {
  const q = choice('Escolha uma.', { a: 'A', b: 'B' });
  assert.deepEqual(q, { type: 'choice', instructions: 'Escolha uma.', criteria: { a: 'A', b: 'B' } });
});

test('choice: sem criteria, ou criteria vazio, lança ErroDeForma', () => {
  assert.throws(() => choice('x', undefined), ErroDeForma);
  assert.throws(() => choice('x', {}), ErroDeForma);
});

test('choice: mais de 255 opções lança ErroDeForma nomeada', () => {
  const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, 'd']));
  assert.throws(() => choice('x', criteria), (err) => err instanceof ErroDeForma && err.name === 'ErroDeForma' && /255/.test(err.message));
});

test('choice: exatamente 255 opções não lança', () => {
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`o${i}`, 'd']));
  assert.doesNotThrow(() => choice('x', criteria));
});

test('choice: instructions vazio ou não-string lança ErroDeForma', () => {
  assert.throws(() => choice('', { a: 'A' }), ErroDeForma);
  assert.throws(() => choice(null, { a: 'A' }), ErroDeForma);
});

test('noul: sem criteria monta só {type, instructions}', () => {
  const q = noul('É verdade?');
  assert.deepEqual(q, { type: 'noul', instructions: 'É verdade?' });
});

test('noul: com criteria monta os três campos', () => {
  const q = noul('É verdade?', { true: 'sim', false: 'não' });
  assert.deepEqual(q, { type: 'noul', instructions: 'É verdade?', criteria: { true: 'sim', false: 'não' } });
});

test('noul: criteria que não é objeto lança ErroDeForma', () => {
  assert.throws(() => noul('x', ['a', 'b']), ErroDeForma);
  assert.throws(() => noul('x', 'texto'), ErroDeForma);
});

test('score: 2 a 10 níveis (array ordenado) monta {type, instructions, criteria}', () => {
  const q = score('Qual o grau?', ['baixo', 'alto']);
  assert.deepEqual(q, { type: 'score', instructions: 'Qual o grau?', criteria: ['baixo', 'alto'] });
});

test('score: niveis como objeto (forma antiga) lança ErroDeForma — precisa ser array ordenado', () => {
  assert.throws(() => score('x', { baixo: 'Baixo', alto: 'Alto' }), (err) => err instanceof ErroDeForma && /array ordenado/.test(err.message));
});

test('score: 1 nível (abaixo do mínimo) lança ErroDeForma nomeada', () => {
  assert.throws(() => score('x', ['unico']), (err) => err instanceof ErroDeForma && err.name === 'ErroDeForma' && /2-10/.test(err.message));
});

test('score: 11 níveis (acima do máximo) lança ErroDeForma', () => {
  const niveis = Array.from({ length: 11 }, (_, i) => `n${i}`);
  assert.throws(() => score('x', niveis), ErroDeForma);
});

test('score: 2 e 10 níveis (limites) não lançam', () => {
  assert.doesNotThrow(() => score('x', ['1', '2']));
  const dez = Array.from({ length: 10 }, (_, i) => `n${i}`);
  assert.doesNotThrow(() => score('x', dez));
});

test('score: nível vazio ou não-string lança ErroDeForma', () => {
  assert.throws(() => score('x', ['a', '']), ErroDeForma);
  assert.throws(() => score('x', ['a', 42]), ErroDeForma);
});

test('TETO_PERGUNTAS: 60', () => {
  assert.equal(TETO_PERGUNTAS, 60);
});

// --- cortarEstado --------------------------------------------------------------------------

test('cortarEstado: sem tetoChars (ou <= 0), não mexe no objeto', () => {
  const obj = { a: 'x'.repeat(100) };
  cortarEstado(obj, { ordemDeCorte: [{ rotulo: 'a', cortar: () => { obj.a = ''; return true; } }] });
  assert.equal(obj.a.length, 100);
});

test('cortarEstado: corta pela primeira classe até caber, sem tocar a segunda', () => {
  const obj = { lista: ['a', 'b', 'c', 'd', 'e'], outro: 'fixo' };
  const cortes = [];
  cortarEstado(obj, {
    tetoChars: 30,
    registrarCorte: (r) => cortes.push(r),
    ordemDeCorte: [
      { rotulo: 'lista', cortar: () => (obj.lista.length ? (obj.lista.shift(), true) : false) },
      { rotulo: 'outro', cortar: () => { if (!obj.outro) return false; obj.outro = ''; return true; } },
    ],
  });
  assert.ok(JSON.stringify(obj).length <= 30);
  assert.ok(cortes.every((c) => c === 'lista'), 'só a primeira classe deveria ter cedido');
  assert.equal(obj.outro, 'fixo');
});

test('cortarEstado: primeira classe esgota e a segunda assume', () => {
  const obj = { a: [], b: ['x', 'y', 'z'] };
  const cortes = [];
  const tamanhoInicial = JSON.stringify(obj).length;
  cortarEstado(obj, {
    tetoChars: tamanhoInicial - 1, // força pelo menos um corte, mas "a" nunca cede
    registrarCorte: (r) => cortes.push(r),
    ordemDeCorte: [
      { rotulo: 'a', cortar: () => false }, // já vazio, nunca cede
      { rotulo: 'b', cortar: () => (obj.b.length ? (obj.b.shift(), true) : false) },
    ],
  });
  assert.ok(cortes.length > 0 && cortes.every((c) => c === 'b'));
  assert.ok(obj.b.length < 3, 'a segunda classe cedeu de verdade');
});

test('cortarEstado: todas as classes esgotadas e ainda acima do teto — devolve o que sobrou, sem lançar', () => {
  const obj = { a: 'zz' };
  assert.doesNotThrow(() => cortarEstado(obj, { tetoChars: 1, ordemDeCorte: [{ rotulo: 'a', cortar: () => false }] }));
});

test('cortarEstado: devolve o próprio objeto (mutado in-place)', () => {
  const obj = { a: 1 };
  const out = cortarEstado(obj, { tetoChars: 100, ordemDeCorte: [] });
  assert.equal(out, obj);
});

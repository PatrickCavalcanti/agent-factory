// packages/decisions/test/refinadores.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { criarRefinadorJev } from '../src/refinadores/criar-refinador-jev.js';

const item = (ref, position, proposedTier, final = 0.5, meta = {}) => ({ ref, position, scores: { final }, proposedTier, meta });
const entrada = (items, proposal, caps = { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 8 } }) => ({
  ring: 'provider', query: { text: 'agenda de hoje', vectors: [] }, items, proposal, caps,
  state: { loadedProviders: [] }, ctx: {}, budgetMs: 600,
});
const clienteFake = (respostas) => ({ chamadas: [], async decidir({ state, questions }) { this.chamadas.push({ state, questions }); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: respostas[k] ?? 0 }; return { answers, ms: 5 }; } });

test('seletor decide o que vai ao Jev; classificar sobe, rebaixa e mantém o proposto dos não enviados', async () => {
  const cliente = clienteFake({ 'x:cal': 0.2, 'x:tar': 0.85 });
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (items) => items.slice(0, 2),
    pergunta: (item) => ({ chave: `x:${item.ref}`, texto: `precisa de ${item.ref}?` }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : noul >= 0.3 ? 'candidate' : 'discard'),
    tetos: { full: 2 },
  });
  const out = await refinar(entrada([item('cal', 0, 'full', 0.9), item('tar', 1, 'candidate', 0.6), item('mus', 2, 'discard', 0.1)], { full: ['cal'], candidates: ['tar'] }));
  assert.deepEqual(out.full, ['tar']);
  assert.deepEqual(out.candidates, []);
  assert.equal(out.explain['tar'].confidence, 0.85);
  assert.equal(out.explain['cal'].reason, 'jev: noul 0.20');
  assert.equal(cliente.chamadas.length, 1);
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['x:cal', 'x:tar']);
});

test('não enviado mantém o proposto (full/candidate) e vai citado na saída; nada a perguntar não chama o Jev', async () => {
  const cliente = clienteFake({});
  const refinar = criarRefinadorJev({ anel: 'provider', cliente, seletor: () => [], pergunta: () => ({ chave: 'k', texto: 't' }), classificar: () => 'discard' });
  const out = await refinar(entrada([item('cal', 0, 'full'), item('tar', 1, 'candidate')], { full: ['cal'], candidates: ['tar'] }));
  assert.deepEqual(out, { full: ['cal'], candidates: ['tar'], explain: {} });
  assert.equal(cliente.chamadas.length, 0);
});

test('teto de full por turno respeita a ordem de confiança; teto de 60 perguntas', async () => {
  const respostas = {}; const items = [];
  for (let i = 0; i < 70; i++) { items.push(item(`p${i}`, i, 'candidate')); respostas[`q:p${i}`] = 0.9 - i * 0.001; }
  const cliente = clienteFake(respostas);
  const refinar = criarRefinadorJev({ anel: 'provider', cliente, seletor: (it) => it, pergunta: (it) => ({ chave: `q:${it.ref}`, texto: it.ref }), classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'), tetos: { full: 2 } });
  const out = await refinar(entrada(items, { full: [], candidates: items.map((i) => i.ref) }, { maxFull: 2, maxCandidates: 8, hard: { maxFull: 2, maxCandidates: 70 } }));
  assert.deepEqual(out.full, ['p0', 'p1']);
  assert.equal(Object.keys(cliente.chamadas[0].questions).length, 60);
  // p2..p59 responderam full e caíram no teto → candidate; p60..p69 não enviados mantêm candidate
  assert.equal(out.candidates.length, 68);
});

test('Jev degradado (sem cliente / erro / prazo) devolve a proposta do motor com explain de degradação', async () => {
  const refinar = criarRefinadorJev({ anel: 'provider', cliente: null, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full' });
  const out = await refinar(entrada([item('cal', 0, 'full')], { full: ['cal'], candidates: [] }));
  assert.deepEqual(out.full, ['cal']);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (sem-chave)');
});

test('estado enviado ao Jev tem pedido, anel e os itens enviados com posicao/proposto/descricao, sob teto de chars', async () => {
  const cliente = clienteFake({});
  const refinar = criarRefinadorJev({ anel: 'skill', cliente, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'discard' });
  await refinar(entrada([item('a', 0, 'candidate', 0.5, { description: 'desc a' })], { full: [], candidates: ['a'] }));
  const { state } = cliente.chamadas[0];
  assert.equal(state.pedido, 'agenda de hoje');
  assert.equal(state.anel, 'skill');
  assert.deepEqual(state.itens, [{ ref: 'a', posicao: 0, proposto: 'candidate', descricao: 'desc a' }]);
});

// ---------------------------------------------------------------------------------------
// Correções do review da Fase 2 (F1-F3)
// ---------------------------------------------------------------------------------------

test('F1: prazo interno tem margem sobre o budgetMs — cliente mais lento que o prazo interno degrada por timeout bem antes do budgetMs inteiro', async () => {
  const clienteLento = {
    chamadas: [],
    async decidir({ questions }) {
      await new Promise((res) => setTimeout(res, 80));
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 };
      return { answers, ms: 80 };
    },
  };
  const refinar = criarRefinadorJev({ anel: 'provider', cliente: clienteLento, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full' });
  const input = { ...entrada([item('cal', 0, 'full')], { full: ['cal'], candidates: [] }), budgetMs: 100 };
  const t0 = performance.now();
  const out = await refinar(input);
  const decorrido = performance.now() - t0;
  // prazoInterno = max(50, 100-50) = 50ms; o cliente demora 80ms > 50ms → perguntar() degrada
  // por timeout perto de 50ms, bem antes dos 100ms de budgetMs (folga de 30ms de tolerância
  // pedida na spec da correção, contra variação de agendamento do event loop).
  assert.ok(decorrido < 100, `esperava resolver bem antes de budgetMs (100ms) por causa da margem, levou ${decorrido.toFixed(1)}ms`);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
});

test('F1 (re-review): prazoMs explícito NÃO reintroduz o empate — o clamp contra budgetMs vence mesmo com prazoMs:600 passado', async () => {
  // A fiação real (Task 12) sempre passa `prazoMs` explícito (ex.: 600) para criarRefinadorJev.
  // Com `prazoMs ?? clamp` puro (versão anterior), um `prazoMs` explícito pulava o clamp
  // inteiro e o prazo interno voltava a ser igual a `prazoMs` — empatando de novo com o timer
  // do kairos. Aqui `prazoMs:600` > `budgetMs:100`, então o `Math.min` tem que escolher o
  // clamp (50ms), não o `prazoMs`.
  const clienteLento = {
    async decidir({ questions }) {
      await new Promise((res) => setTimeout(res, 80));
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 };
      return { answers, ms: 80 };
    },
  };
  const refinar = criarRefinadorJev({ anel: 'provider', cliente: clienteLento, prazoMs: 600, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full' });
  const input = { ...entrada([item('cal', 0, 'full')], { full: ['cal'], candidates: [] }), budgetMs: 100 };
  const t0 = performance.now();
  const out = await refinar(input);
  const decorrido = performance.now() - t0;
  assert.ok(decorrido < 100, `prazoMs:600 não pode vencer o clamp de budgetMs:100 — esperava <100ms, levou ${decorrido.toFixed(1)}ms`);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
});

test('F1 (re-review): prazoMs explícito mais curto que o clamp continua valendo', async () => {
  // budgetMs:600 → clamp = max(50, 600-50) = 550ms; prazoMs:30 explícito é MENOR que o clamp,
  // então o prazo interno tem que ser 30ms (o chamador pediu menos tempo de propósito), não
  // 550ms — o cliente de 60ms tem que degradar por timeout perto de 30ms, não de 550ms.
  const clienteLento = {
    async decidir({ questions }) {
      await new Promise((res) => setTimeout(res, 60));
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 };
      return { answers, ms: 60 };
    },
  };
  const refinar = criarRefinadorJev({ anel: 'provider', cliente: clienteLento, prazoMs: 30, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full' });
  const input = { ...entrada([item('cal', 0, 'full')], { full: ['cal'], candidates: [] }), budgetMs: 600 };
  const t0 = performance.now();
  const out = await refinar(input);
  const decorrido = performance.now() - t0;
  assert.ok(decorrido < 60, `prazoMs:30 explícito devia valer (mais curto que o clamp de 550ms) — esperava <60ms, levou ${decorrido.toFixed(1)}ms`);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
});

test('F1 (residual): budgetMs curto (<= 2x margem) usa piso proporcional — o prazo interno nunca iguala o budget', async () => {
  // budgetMs:30 → antes: clamp = max(50, 30-50) = 50 ≥ 30, o timer do motor vencia de novo.
  // Agora: floor(30/2) = 15ms. O cliente de 40ms degrada perto de 15ms, antes dos 30ms do motor.
  const clienteLento = {
    async decidir({ questions }) {
      await new Promise((res) => setTimeout(res, 40));
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 };
      return { answers, ms: 40 };
    },
  };
  const refinar = criarRefinadorJev({ anel: 'tool', cliente: clienteLento, prazoMs: 600, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full' });
  const input = { ...entrada([item('cal', 0, 'full')], { full: ['cal'], candidates: [] }), budgetMs: 30 };
  const t0 = performance.now();
  const out = await refinar(input);
  const decorrido = performance.now() - t0;
  // Tolerância: o que se prova é que o refinador degradou ANTES de o cliente responder (40ms),
  // não o valor exato do timer — sob carga (suíte em paralelo) 15ms de timer viram 30+ de parede.
  assert.ok(decorrido < 40, `budgetMs:30 devia dar prazo interno de 15ms — esperava degradar antes dos 40ms do cliente, levou ${decorrido.toFixed(1)}ms`);
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
});

test('F3 (re-review): { noul: null } não é voto — Number(null) é 0 finito, mas typeof null !== "number" — mantém o proposto', async () => {
  const clienteNoulNulo = {
    chamadas: [],
    async decidir({ questions }) {
      this.chamadas.push({ questions });
      const answers = {};
      for (const k of Object.keys(questions)) answers[k] = { noul: null };
      return { answers, ms: 5 };
    },
  };
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente: clienteNoulNulo,
    seletor: (it) => it,
    pergunta: (it) => ({ chave: `q:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
  });
  const out = await refinar(entrada([item('a', 0, 'full')], { full: ['a'], candidates: [] }));
  assert.ok(out.full.includes('a'), '{ noul: null } não é voto — devia manter o proposedTier "full"');
  assert.equal(out.explain['a'].reason, 'jev:sem-resposta');
  assert.ok(!('confidence' in out.explain['a']));
});

test('F2: sob pressão de tamanho, questions é montado a partir do state já cortado — itens cortados mantêm o proposto e não são perguntados', async () => {
  const descricao600 = 'x'.repeat(600);
  const items = [];
  for (let i = 0; i < 40; i++) items.push(item(`p${i}`, i, 'candidate', 0.5, { description: descricao600 }));
  const cliente = clienteFake({}); // sem respostas configuradas → todo enviado responde noul 0 (voto explícito)
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (it) => it,
    pergunta: (it) => ({ chave: `q:${it.ref}`, texto: `pergunta ${it.ref}` }),
    classificar: () => 'discard',
  });
  const out = await refinar(entrada(items, { full: [], candidates: items.map((i) => i.ref) }, { maxFull: 40, maxCandidates: 40, hard: { maxFull: 40, maxCandidates: 40 } }));
  const { state, questions } = cliente.chamadas[0];
  assert.equal(Object.keys(questions).length, state.itens.length, 'questions ⊆ state — uma pergunta por item que sobreviveu ao corte, nem mais nem menos');
  assert.ok(state.itens.length < 40, `esperava corte pelo teto de 16000 chars (40 descrições de 600 chars estouram), mandou ${state.itens.length} de 40`);
  const refsEnviados = new Set(state.itens.map((it) => it.ref));
  const refsCortados = items.map((it) => it.ref).filter((ref) => !refsEnviados.has(ref));
  assert.ok(refsCortados.length > 0, 'esperava pelo menos um item cortado do state');
  for (const ref of refsCortados) assert.ok(out.candidates.includes(ref), `${ref} foi cortado do state (nunca perguntado) e devia manter o proposedTier 'candidate'`);
  for (const ref of refsEnviados) assert.ok(!out.full.includes(ref) && !out.candidates.includes(ref), `${ref} foi enviado, respondeu noul 0 e classificou 'discard'`);
});

test('F3: resposta ausente não é voto — mantém o proposto com "jev:sem-resposta" sem confidence; noul:0 explícito continua rebaixando', async () => {
  const clienteParcial = {
    chamadas: [],
    async decidir({ questions }) {
      this.chamadas.push({ questions });
      const chaves = Object.keys(questions);
      const answers = {};
      // só responde à primeira metade das chaves; a segunda metade fica sem resposta
      for (let i = 0; i < Math.floor(chaves.length / 2); i++) answers[chaves[i]] = { noul: 0 };
      return { answers, ms: 5 };
    },
  };
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente: clienteParcial,
    seletor: (it) => it,
    pergunta: (it) => ({ chave: `q:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
  });
  const items = [item('a', 0, 'full'), item('b', 1, 'full'), item('c', 2, 'full'), item('d', 3, 'full')];
  const out = await refinar(entrada(items, { full: items.map((i) => i.ref), candidates: [] }));

  // a, b respondem noul:0 explícito → voto real, rebaixa de 'full' proposto para 'discard'
  for (const ref of ['a', 'b']) {
    assert.ok(!out.full.includes(ref) && !out.candidates.includes(ref), `${ref} recebeu noul:0 explícito e devia ser rebaixado a discard`);
    assert.equal(out.explain[ref].reason, 'jev: noul 0.00');
    assert.equal(out.explain[ref].confidence, 0);
  }
  // c, d não têm chave em answers → mantêm o proposto 'full', sem confidence
  for (const ref of ['c', 'd']) {
    assert.ok(out.full.includes(ref), `${ref} não recebeu resposta e devia manter o proposedTier 'full'`);
    assert.equal(out.explain[ref].reason, 'jev:sem-resposta');
    assert.ok(!('confidence' in out.explain[ref]), `${ref} sem resposta não deve ter 'confidence' — não é um voto`);
  }
});

test('aoChegarTarde (21/09): resposta depois do prazo interno chega ao host com msReal, sem mudar o resultado do refino', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 80)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 80 }; } };
  const tardias = [];
  const refinar = criarRefinadorJev({ anel: 'skill', cliente: clienteLento, prazoMs: 30, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full', aoChegarTarde: (t) => tardias.push(t) });
  const out = await refinar({ ...entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }), ring: 'skill', budgetMs: 600 });
  assert.deepEqual(out.candidates, ['cal'], 'o turno segue com a proposta do motor');
  assert.equal(out.explain['cal'].reason, 'jev:degradado (timeout)');
  assert.equal(tardias.length, 0, 'ainda nao chegou');
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(tardias.length, 1);
  assert.equal(tardias[0].anel, 'skill');
  assert.ok(tardias[0].msReal >= 70, `msReal ~80ms, veio ${tardias[0].msReal}`);
  assert.equal(tardias[0].degradado, false);
  assert.equal(tardias[0].ms, 30, '`ms` e o prazo interno em que desistiu (prazoMs:30 < clamp 550), nao a latencia real');
});

test('aoChegarTarde que lanca nao derruba nada', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 40)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 40 }; } };
  const refinar = criarRefinadorJev({ anel: 'tool', cliente: clienteLento, prazoMs: 10, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full', aoChegarTarde: () => { throw new Error('boom'); } });
  const out = await refinar({ ...entrada([item('x', 0, 'full')], { full: ['x'], candidates: [] }), budgetMs: 600 });
  assert.equal(out.explain['x'].reason, 'jev:degradado (timeout)');
  await new Promise((res) => setTimeout(res, 80));
});

// ---------------------------------------------------------------------------------------
// Task 1 (2026-09-21-ajustes-de-uso-da-fabrica): cache por turno e perguntas extras
// ---------------------------------------------------------------------------------------

test('cache: item com resposta no cache não vai ao Jev e é classificado com ela (explain "(cache)")', async () => {
  const cliente = clienteFake({ 'x:b': 0.2 });
  const cache = { obter: (ref) => (ref === 'a' ? 0.9 : undefined) };
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente, cache,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'candidate'),
  });
  const out = await refinar(entrada([item('a', 0, 'candidate'), item('b', 1, 'candidate')], { full: [], candidates: ['a', 'b'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['x:b'], 'só b vai ao Jev');
  assert.deepEqual(out.full, ['a']);
  assert.equal(out.explain['a'].reason, 'jev: noul 0.90 (cache)');
  assert.equal(out.explain['a'].confidence, 0.9);
  assert.equal(out.explain['b'].reason, 'jev: noul 0.20');
});

test('cache: com TODOS os itens no cache o Jev não é chamado', async () => {
  const cliente = clienteFake({});
  const cache = { obter: () => 0.1 };
  const refinar = criarRefinadorJev({ anel: 'tool', cliente, cache, seletor: (items) => items, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'discard' });
  const out = await refinar(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.equal(cliente.chamadas.length, 0);
  assert.deepEqual(out.candidates, []);
  assert.equal(out.explain['a'].reason, 'jev: noul 0.10 (cache)');
});

test('perguntasExtras: vão na MESMA chamada, em state.extras e questions; aoResponderExtras recebe { ref: noul }', async () => {
  const cliente = clienteFake({ 'cap_a': 0.9, 'fn_a/tool/f1': 0.8, 'fn_a/tool/f2': 0.1 });
  const recebidas = [];
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `cap_${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
    perguntasExtras: () => [
      { ref: 'a/tool/f1', chave: 'fn_a/tool/f1', texto: 'f1?', descricao: 'faz f1', capacidade: 'a' },
      { ref: 'a/tool/f2', chave: 'fn_a/tool/f2', texto: 'f2?', descricao: 'faz f2', capacidade: 'a' },
    ],
    aoResponderExtras: (r) => recebidas.push(r),
  });
  const out = await refinar(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions), ['cap_a', 'fn_a/tool/f1', 'fn_a/tool/f2']);
  assert.deepEqual(cliente.chamadas[0].state.extras, [{ ref: 'a/tool/f1', capacidade: 'a', descricao: 'faz f1' }, { ref: 'a/tool/f2', capacidade: 'a', descricao: 'faz f2' }]);
  assert.deepEqual(recebidas, [{ 'a/tool/f1': 0.8, 'a/tool/f2': 0.1 }]);
  assert.deepEqual(out.full, ['a'], 'as extras não entram no resultado do anel');
  assert.equal(out.explain['a/tool/f1'], undefined, 'extras não aparecem no explain do anel');
});

test('perguntasExtras: respeita TETO_PERGUNTAS (60) — corta as extras do fim; extras sem resposta numérica não chegam a aoResponderExtras', async () => {
  const cliente = clienteFake({});
  const recebidas = [];
  const items = []; for (let i = 0; i < 10; i++) items.push(item(`p${i}`, i, 'candidate'));
  const extras = []; for (let i = 0; i < 70; i++) extras.push({ ref: `e${i}`, chave: `fn_e${i}`, texto: `e${i}?` });
  const refinar = criarRefinadorJev({ anel: 'provider', cliente, seletor: (it) => it, pergunta: (it) => ({ chave: `cap_${it.ref}`, texto: it.ref }), classificar: () => 'candidate', perguntasExtras: () => extras, aoResponderExtras: (r) => recebidas.push(r) });
  await refinar(entrada(items, { full: [], candidates: items.map((i) => i.ref) }));
  assert.equal(Object.keys(cliente.chamadas[0].questions).length, 60);
  assert.ok('fn_e49' in cliente.chamadas[0].questions && !('fn_e50' in cliente.chamadas[0].questions));
  // clienteFake responde noul 0 para toda chave → 50 respostas numéricas
  assert.equal(Object.keys(recebidas[0]).length, 50);
});

test('perguntasExtras: quando o Jev degrada (timeout), aoResponderExtras NÃO é chamado e o anel segue como antes', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 60)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 60 }; } };
  const recebidas = [];
  const refinar = criarRefinadorJev({ anel: 'provider', cliente: clienteLento, prazoMs: 20, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full', perguntasExtras: () => [{ ref: 'e', chave: 'fn_e', texto: 'e?' }], aoResponderExtras: (r) => recebidas.push(r) });
  const out = await refinar({ ...entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }), budgetMs: 600 });
  assert.equal(out.explain['a'].reason, 'jev:degradado (timeout)');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(recebidas.length, 0, 'resposta tardia não alimenta o cache (o turno já seguiu)');
});

// ---------------------------------------------------------------------------------------
// Correção do review da Fase 1 (#1, 2026-09-21-ajustes-de-uso-da-fabrica): ordem de corte —
// extras cortam ANTES dos itens do anel, não depois.
// ---------------------------------------------------------------------------------------

test('#1: sob pressão de tamanho, extras cortam ANTES dos itens — todos os itens do anel sobrevivem, sobra menos extras do que itens', async () => {
  const descricao600 = 'x'.repeat(600);
  const items = [];
  for (let i = 0; i < 20; i++) items.push(item(`p${i}`, i, 'candidate', 0.5, { description: descricao600 }));
  const extras = [];
  for (let i = 0; i < 20; i++) extras.push({ ref: `e${i}`, chave: `fn_e${i}`, texto: `e${i}?`, descricao: descricao600 });
  const cliente = clienteFake({});
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (it) => it,
    pergunta: (it) => ({ chave: `cap_${it.ref}`, texto: `pergunta ${it.ref}` }),
    classificar: () => 'discard',
    perguntasExtras: () => extras,
  });
  await refinar(entrada(items, { full: [], candidates: items.map((i) => i.ref) }, { maxFull: 20, maxCandidates: 20, hard: { maxFull: 20, maxCandidates: 20 } }));
  const chaves = Object.keys(cliente.chamadas[0].questions);
  const capChaves = chaves.filter((c) => c.startsWith('cap_'));
  const fnChaves = chaves.filter((c) => c.startsWith('fn_'));
  assert.equal(capChaves.length, 20, 'os 20 itens do anel (16.000 chars de teto, ~13.000 chars só de itens) sobrevivem inteiros ao corte');
  assert.ok(fnChaves.length < capChaves.length, `esperava menos extras sobreviventes do que itens depois do corte, vieram ${fnChaves.length} extras contra ${capChaves.length} itens`);
});

test('#1: sem pressão de tamanho (descrições curtas, cabe nos 16.000 chars), nada é cortado', async () => {
  const cliente = clienteFake({});
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (it) => it,
    pergunta: (it) => ({ chave: `cap_${it.ref}`, texto: `pergunta ${it.ref}` }),
    classificar: () => 'discard',
    perguntasExtras: () => [{ ref: 'e1', chave: 'fn_e1', texto: 'e1?', descricao: 'curta' }],
  });
  await refinar(entrada([item('p0', 0, 'candidate', 0.5, { description: 'curta' })], { full: [], candidates: ['p0'] }));
  const chaves = Object.keys(cliente.chamadas[0].questions).sort();
  assert.deepEqual(chaves, ['cap_p0', 'fn_e1'], 'sem pressão de tamanho, item do anel e extra sobrevivem juntos');
});

// ---------------------------------------------------------------------------------------
// 22/09: gancho `aoResponder` — recebe { ref: noul } dos ITENS DO ANEL respondidos pelo Jev
// nesta chamada (não os que já vieram do cache); nunca no caminho degradado; nunca lança.
// ---------------------------------------------------------------------------------------

test('aoResponder: recebe { ref: noul } dos itens do anel respondidos pelo Jev nesta chamada, não os do cache', async () => {
  const cliente = clienteFake({ 'x:a': 0.9, 'x:b': 0.2 });
  const cache = { obter: (ref) => (ref === 'c' ? 0.5 : undefined) };
  const recebidas = [];
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente, cache,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
    aoResponder: (r) => recebidas.push(r),
  });
  await refinar(entrada([item('a', 0, 'candidate'), item('b', 1, 'candidate'), item('c', 2, 'candidate')], { full: [], candidates: ['a', 'b', 'c'] }));
  assert.deepEqual(recebidas, [{ a: 0.9, b: 0.2 }], 'c veio do cache — nem chega ao Jev, não aparece em aoResponder');
});

test('aoResponder: sem nenhum item respondido pelo Jev nesta chamada (tudo veio do cache), não é chamado', async () => {
  const cliente = clienteFake({});
  const cache = { obter: () => 0.1 };
  const recebidas = [];
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente, cache,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: it.ref, texto: it.ref }),
    classificar: () => 'discard',
    aoResponder: (r) => recebidas.push(r),
  });
  await refinar(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.equal(cliente.chamadas.length, 0);
  assert.equal(recebidas.length, 0);
});

test('aoResponder que lança não derruba o refino', async () => {
  const cliente = clienteFake({ 'x:a': 0.9 });
  const refinar = criarRefinadorJev({
    anel: 'tool', cliente,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
    aoResponder: () => { throw new Error('boom'); },
  });
  const out = await refinar(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.deepEqual(out.full, ['a']);
});

test('aoResponder: no caminho degradado não é chamado', async () => {
  const clienteLento = { async decidir({ questions }) { await new Promise((res) => setTimeout(res, 60)); const answers = {}; for (const k of Object.keys(questions)) answers[k] = { noul: 0.9 }; return { answers, ms: 60 }; } };
  const recebidas = [];
  const refinar = criarRefinadorJev({ anel: 'tool', cliente: clienteLento, prazoMs: 20, seletor: (it) => it, pergunta: (it) => ({ chave: it.ref, texto: it.ref }), classificar: () => 'full', aoResponder: (r) => recebidas.push(r) });
  const out = await refinar({ ...entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }), budgetMs: 600 });
  assert.equal(out.explain['a'].reason, 'jev:degradado (timeout)');
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(recebidas.length, 0, 'resposta tardia não alimenta aoResponder (o turno já seguiu)');
});

// ---------------------------------------------------------------------------------------
// 23/09: `ctx.__promocao` — discover de promoção (`promoverNoTurno`, orchestrator) não refaz a
// pergunta ao Jev para itens sem entrada no cache do turno; mantém o proposedTier do motor.
// Fiação real: o anel `tool` grava as próprias respostas no cache via `aoResponder` (tool.js) —
// reproduzido aqui com um `cache` mutável de verdade, não um cache fixo, para o segundo discover
// (marcado) reaproveitar o que o primeiro (sem marca) respondeu de A/B/C.
// ---------------------------------------------------------------------------------------

test('ctx.__promocao: itens já no cache replay idêntico; itens novos (sem cache) não são perguntados — mantêm o proposedTier do motor com explain dedicado', async () => {
  const cliente = clienteFake({ 'x:a': 0.9, 'x:b': 0.2, 'x:c': 0.5 });
  const cacheDeRespostas = new Map();
  const cache = { obter: (ref) => cacheDeRespostas.get(ref) };
  const aoResponder = (respostas) => { for (const [ref, n] of Object.entries(respostas)) cacheDeRespostas.set(ref, n); };
  const criarRefinar = () => criarRefinadorJev({
    anel: 'tool', cliente, cache, aoResponder,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : noul >= 0.3 ? 'candidate' : 'discard'),
  });

  // Discover inicial (sem marca): A, B, C perguntados de verdade; o anel grava as respostas no cache.
  const out1 = await criarRefinar()(entrada([item('a', 0, 'candidate'), item('b', 1, 'candidate'), item('c', 2, 'candidate')], { full: [], candidates: ['a', 'b', 'c'] }));
  assert.equal(cliente.chamadas.length, 1);
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions).sort(), ['x:a', 'x:b', 'x:c']);
  assert.deepEqual(out1.full, ['a']);

  // Discover de promoção (ctx.__promocao): A,B,C (agora no cache) + D,E novos (sem cache, sem manual).
  const items2 = [item('a', 0, 'candidate'), item('b', 1, 'candidate'), item('c', 2, 'candidate'), item('d', 3, 'full'), item('e', 4, 'candidate')];
  const input2 = { ...entrada(items2, { full: ['d'], candidates: ['a', 'b', 'c', 'e'] }), ctx: { __promocao: true } };
  const out2 = await criarRefinar()(input2);

  assert.equal(cliente.chamadas.length, 1, 'discover de promoção não gerou nenhuma chamada nova ao Jev');
  assert.equal(out2.explain['a'].reason, 'jev: noul 0.90 (cache)');
  assert.equal(out2.explain['b'].reason, 'jev: noul 0.20 (cache)');
  assert.equal(out2.explain['c'].reason, 'jev: noul 0.50 (cache)');
  assert.equal(out2.explain['d'].reason, 'proposta do motor (promoção)');
  assert.ok(!('confidence' in out2.explain['d']), 'não houve voto — sem confidence');
  assert.equal(out2.explain['e'].reason, 'proposta do motor (promoção)');
  assert.ok(!('confidence' in out2.explain['e']));
  assert.ok(out2.full.includes('a') && out2.full.includes('d'), 'A (cache 0.9) e D (proposedTier full do motor) ficam full');
  assert.ok(out2.candidates.includes('c') && out2.candidates.includes('e'), 'C (cache 0.5) e E (proposedTier candidate do motor) ficam candidate');
  assert.ok(!out2.full.includes('b') && !out2.candidates.includes('b'), 'B (cache 0.2) vira discard');
});

test('sem ctx.__promocao: itens novos (sem cache) são perguntados normalmente ao Jev, mesmo num segundo discover do turno', async () => {
  const cliente = clienteFake({ 'x:a': 0.9, 'x:d': 0.8, 'x:e': 0.1 });
  const cacheDeRespostas = new Map();
  const cache = { obter: (ref) => cacheDeRespostas.get(ref) };
  const aoResponder = (respostas) => { for (const [ref, n] of Object.entries(respostas)) cacheDeRespostas.set(ref, n); };
  const criarRefinar = () => criarRefinadorJev({
    anel: 'tool', cliente, cache, aoResponder,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : noul >= 0.3 ? 'candidate' : 'discard'),
  });

  await criarRefinar()(entrada([item('a', 0, 'candidate')], { full: [], candidates: ['a'] }));
  assert.equal(cliente.chamadas.length, 1);

  // Segundo discover do turno, SEM ctx.__promocao: D,E (sem cache) vão ao Jev como hoje.
  const out2 = await criarRefinar()(entrada([item('a', 0, 'candidate'), item('d', 1, 'full'), item('e', 2, 'candidate')], { full: ['d'], candidates: ['a', 'e'] }));
  assert.equal(cliente.chamadas.length, 2, 'uma chamada nova ao Jev, só por D e E');
  assert.deepEqual(Object.keys(cliente.chamadas[1].questions).sort(), ['x:d', 'x:e'], 'A veio do cache — só D e E são perguntados');
  assert.equal(out2.explain['d'].reason, 'jev: noul 0.80');
  assert.equal(out2.explain['e'].reason, 'jev: noul 0.10');
});


// Instrumentação completa do turno pela fábrica (2026-09-23, decisão do dono: "tudo que a
// fábrica faz tem que ir para o Tracer"): `aoChamarJev` recebe o registro BRUTO de cada chamada
// (state/questions/answers/meta), mais os itens enviados (posição/tier proposto), os que vieram
// do cache, e o tier FINAL (full/candidates/explain) — sem isto o host só tinha estatística
// resumida (`refino.porAnel`), nunca o corpo da pergunta/resposta.
test('aoChamarJev: recebe state/questions/answers/meta brutos, itens enviados e tier final', async () => {
  const cliente = clienteFake({ 'x:cal': 0.9, 'x:tar': 0.2 });
  const chamadas = [];
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: `precisa de ${it.ref}?` }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : noul >= 0.3 ? 'candidate' : 'discard'),
    aoChamarJev: (r) => chamadas.push(r),
  });
  await refinar(entrada([item('cal', 0, 'candidate'), item('tar', 1, 'candidate')], { full: [], candidates: ['cal', 'tar'] }));
  assert.equal(chamadas.length, 1);
  const [r] = chamadas;
  assert.equal(r.anel, 'provider');
  assert.equal(r.tardia, false);
  assert.equal(r.chamouJev, true);
  assert.deepEqual(r.itensEnviados.map((i) => i.ref).sort(), ['cal', 'tar']);
  assert.deepEqual(r.itensDoCache, []);
  assert.deepEqual(r.full, ['cal']);
  assert.deepEqual(r.candidates, []);
  assert.ok(r.state.itens.length, 'state bruto presente');
  assert.ok(r.questions['x:cal'], 'questions bruto presente');
  assert.ok(r.answers['x:cal'], 'answers bruto presente');
  assert.equal(typeof r.meta.ms, 'number');
});

test('aoChamarJev: tudo veio do cache — chamouJev false, sem state/questions/answers, mas com o tier final', async () => {
  const cliente = clienteFake({});
  const cache = { obter: (ref) => ({ cal: 0.9 }[ref]) };
  const chamadas = [];
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente, cache,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
    aoChamarJev: (r) => chamadas.push(r),
  });
  await refinar(entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }));
  assert.equal(cliente.chamadas.length, 0, 'nada foi ao Jev — tudo veio do cache');
  assert.equal(chamadas.length, 1);
  const [r] = chamadas;
  assert.equal(r.chamouJev, false);
  assert.equal(r.state, undefined);
  assert.deepEqual(r.itensDoCache, [{ ref: 'cal', noul: 0.9 }]);
  assert.deepEqual(r.full, ['cal']);
});

test('aoChamarJev que lança não derruba o refino', async () => {
  const cliente = clienteFake({ 'x:cal': 0.9 });
  const refinar = criarRefinadorJev({
    anel: 'provider', cliente,
    seletor: (items) => items,
    pergunta: (it) => ({ chave: `x:${it.ref}`, texto: it.ref }),
    classificar: ({ noul }) => (noul >= 0.7 ? 'full' : 'discard'),
    aoChamarJev: () => { throw new Error('boom'); },
  });
  const out = await refinar(entrada([item('cal', 0, 'candidate')], { full: [], candidates: ['cal'] }));
  assert.deepEqual(out.full, ['cal']);
});

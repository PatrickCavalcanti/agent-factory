// packages/decisions/test/local-indice-do-refino.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { montarIndice, centroideDe } from '../src/local/indice.js';
import { media, centrar } from '../src/local/vetores.js';
import { aplicarRoubadosMantidos } from '../src/local/cortes.js';
import { indiceDoRefino, indiceDeFuncoesDoProvider, indiceDoCatalogo } from '../src/local/indice-do-refino.js';
import * as pub from '../src/local/index.js';

const EPS = 1e-12;
const DIM = 8;
const SLUG = 'fake-hash-1';
const vetorDe = (texto) => [...createHash('sha256').update(texto).digest().subarray(0, DIM)].map((b) => (b - 128) / 128);
const embedder = { modelSlug: SLUG, embed: async (texto) => vetorDe(texto) };
const congelar = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(congelar); } return o; };
const perto = (a, b, msg) => { assert.equal(a.length, b.length, msg); a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= EPS, `${msg}[${i}] ${x} vs ${b[i]}`)); };

function iguais(a, b) {
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(a.anel, b.anel); assert.equal(a.slug, b.slug); assert.equal(a.dim, b.dim);
  perto(a.media, b.media, 'media');
  assert.deepEqual([...a.nos.keys()], [...b.nos.keys()], 'refs e ordem dos nós');
  for (const [ref, na] of a.nos) {
    const nb = b.nos.get(ref);
    assert.deepEqual(na.textos, nb.textos, `textos ${ref}`);
    assert.deepEqual(na.origens, nb.origens, `origens ${ref}`);
    assert.equal(na.vetores.length, nb.vetores.length, `n vetores ${ref}`);
    na.vetores.forEach((v, k) => perto(v, nb.vetores[k], `vetor ${ref}#${k}`));
    perto(na.centroide, nb.centroide, `centroide ${ref}`);
  }
}

// Catálogo: texto de 'agenda' vem de semanticText, o de 'notas' de descricao; uma tool usa description.
const capacidades = () => [
  { id: 'agenda', semanticText: 'agenda geral', tools: [
    { name: 'listar', semanticText: 'lista eventos', exemplos: ['o que tenho hoje', 'minha agenda'] },
    { name: 'criar', description: 'cria evento', exemplos: ['marca reuniao'] },
  ] },
  { id: 'notas', descricao: 'notas pessoais', tools: [{ name: 'ler', semanticText: 'le nota', exemplos: ['abre nota'] }] },
  { id: 'busca', semanticText: 'busca web', tools: [{ name: 'web', semanticText: 'pesquisa na web', exemplos: [] }] },
];

// Monta, À MÃO (sem nosDoAnel), a semântica do Kairos: mesmos textos, vetores brutos do fake.
const sem = (texto, exemplos) => ({
  ...(texto ? { texto: { texto, vetor: vetorDe(texto) } } : {}),
  exemplos: exemplos.map((e) => ({ texto: e, vetor: vetorDe(e) })),
});
const brutosDe = (semantica) => !semantica ? [] : [...(semantica.texto ? [semantica.texto.vetor] : []), ...semantica.exemplos.map((e) => e.vetor)];

const itensProvider = () => [
  { ref: 'agenda', semantica: sem('agenda geral', ['o que tenho hoje', 'minha agenda', 'marca reuniao']) },
  { ref: 'notas', semantica: sem('notas pessoais', ['abre nota']) },
  { ref: 'busca', semantica: sem('busca web', []) },
];
const itensTool = () => [
  { ref: 'agenda/tool/listar', semantica: sem('lista eventos', ['o que tenho hoje', 'minha agenda']) },
  { ref: 'agenda/tool/criar', semantica: sem('cria evento', ['marca reuniao']) },
  { ref: 'notas/tool/ler', semantica: sem('le nota', ['abre nota']) },
  { ref: 'busca/tool/web', semantica: sem('pesquisa na web', []) },
];
const inputDe = (ring, items, extra = {}) => {
  const todos = items.flatMap((it) => brutosDe(it.semantica));
  return { ring, items, semantica: { media: media(todos), slug: SLUG, versao: 'v1', ...extra } };
};

test('1. input sintético: 3 vetores centrados por nó e centroide = centroideDe', () => {
  const items = [
    { ref: 'a', semantica: { texto: { texto: 't', vetor: [1, 0] }, exemplos: [{ texto: 'e1', vetor: [0, 1] }, { texto: 'e2', vetor: [1, 1] }] } },
    { ref: 'b', semantica: { texto: { texto: 'u', vetor: [-1, 0] }, exemplos: [{ texto: 'f1', vetor: [0, -1] }, { texto: 'f2', vetor: [-1, -1] }] } },
  ];
  const mu = [0, 0.1];
  const r = indiceDoRefino({ ring: 'provider', items, semantica: { media: mu, slug: 's', versao: 'h' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.semSemantica, []); assert.equal(r.removidos, 0);
  const ind = r.indice;
  assert.equal(ind.dim, 2); assert.equal(ind.slug, 's'); assert.equal(ind.hash, 'h'); assert.equal(ind.anel, 'provider');
  const a = ind.nos.get('a');
  assert.equal(a.vetores.length, 3);
  perto(a.vetores[0], centrar([1, 0], mu), 'a0'); perto(a.vetores[2], centrar([1, 1], mu), 'a2');
  assert.deepEqual(a.origens, [{ tipo: 'texto', i: 0 }, { tipo: 'exemplo', i: 0 }, { tipo: 'exemplo', i: 1 }]);
  assert.deepEqual(a.textos.map((t) => t.tipo), ['texto', 'exemplo', 'exemplo']);
  perto(a.centroide, centroideDe(a.vetores), 'centroide');
});

test('2. igualdade com montarIndice: anel provider e anel tool', async () => {
  const caps = capacidades();
  for (const [anel, items] of [['provider', itensProvider()], ['tool', itensTool()]]) {
    const esperado = await montarIndice({ anel, capacidades: caps, embedder });
    const r = indiceDoRefino(inputDe(anel, items));
    iguais(r.indice, esperado);
  }
});

test('2b. igualdade também com vetor de exemplo inválido: o texto fica em `textos` e o `i` segue a lista de exemplos', async () => {
  const quebrado = { modelSlug: SLUG, embed: async (t) => (t === 'minha agenda' ? null : vetorDe(t)) };
  const esperado = await montarIndice({ anel: 'provider', capacidades: capacidades(), embedder: quebrado });
  const items = itensProvider();
  items[0].semantica.exemplos[1].vetor = null;
  const brutos = items.flatMap((it) => brutosDe(it.semantica).filter(Boolean));
  const r = indiceDoRefino({ ring: 'provider', items, semantica: { media: media(brutos), slug: SLUG, versao: 'v' } });
  iguais(r.indice, esperado);
  assert.deepEqual(r.indice.nos.get('agenda').origens, [{ tipo: 'texto', i: 0 }, { tipo: 'exemplo', i: 0 }, { tipo: 'exemplo', i: 2 }]);
});

test('3. calibração com 1 roubado: igual a aplicar aplicarRoubadosMantidos ao índice de montarIndice', async () => {
  const roubados = [{ ref: 'agenda', i: 0, texto: 'o que tenho hoje', para: 'notas', irmao: false }];
  const base = await montarIndice({ anel: 'provider', capacidades: capacidades(), embedder });
  const esperado = aplicarRoubadosMantidos(base, roubados);
  assert.equal(esperado.removidos, 1);
  const r = indiceDoRefino(inputDe('provider', itensProvider()), { roubados });
  assert.equal(r.removidos, 1);
  iguais(r.indice, esperado.indice);
  assert.equal(r.indice.nos.get('agenda').vetores.length, 3);
  // irmão não sai
  const ir = indiceDoRefino(inputDe('provider', itensProvider()), { roubados: [{ ...roubados[0], irmao: true }] });
  assert.equal(ir.removidos, 0);
});

test('4. item sem semântica entra em semSemantica; input sem semantica = sem-semantica', () => {
  const items = [...itensProvider(), { ref: 'novo' }];
  const r = indiceDoRefino(inputDe('provider', items));
  assert.equal(r.ok, true);
  assert.deepEqual(r.semSemantica, ['novo']);
  assert.equal(r.indice.nos.has('novo'), false);
  const s = indiceDoRefino({ ring: 'provider', items: itensProvider() });
  assert.equal(s.ok, false); assert.equal(s.motivo, 'sem-semantica');
  assert.deepEqual(indiceDoRefino(null).motivo, 'sem-semantica');
});

test('5. indiceDeFuncoesDoProvider: funções do item = índice do anel tool restrito a essas capacidades', async () => {
  const caps = capacidades().slice(0, 2);
  const esperado = await montarIndice({ anel: 'tool', capacidades: caps, embedder });
  const funcoesAgenda = itensTool().slice(0, 2).map((f) => ({ ref: f.ref, ...f.semantica }));
  const funcoesNotas = itensTool().slice(2, 3).map((f) => ({ ref: f.ref, ...f.semantica }));
  const todas = [...funcoesAgenda, ...funcoesNotas];
  const mediaFuncoes = media(todas.flatMap((f) => brutosDe(f)));
  const input = {
    ring: 'provider',
    items: [{ ref: 'agenda', semantica: { ...sem('agenda geral', []), funcoes: funcoesAgenda } }, { ref: 'notas', semantica: { ...sem('notas pessoais', []), funcoes: funcoesNotas } }],
    semantica: { media: media([vetorDe('x')]), mediaFuncoes, slug: SLUG, versao: 'v1' },
  };
  iguais(indiceDeFuncoesDoProvider(input), esperado);
  // calibração do tool aplicada por ref+texto
  const roubados = [{ ref: 'agenda/tool/listar', i: 0, texto: 'minha agenda', para: 'notas/tool/ler', irmao: false }];
  const cal = indiceDeFuncoesDoProvider(input, { roubados });
  iguais(cal, aplicarRoubadosMantidos(esperado, roubados).indice);
  // sem mediaFuncoes
  const sm = indiceDeFuncoesDoProvider({ ...input, semantica: { media: [1], slug: SLUG } });
  assert.equal(sm.ok, false); assert.equal(sm.motivo, 'sem-semantica');
});

test('6. vetores congelados: nada lança e nada é mutado', () => {
  const input = congelar(inputDe('provider', itensProvider()));
  const antes = JSON.stringify(input);
  const r = indiceDoRefino(input, congelar({ roubados: [{ ref: 'agenda', i: 0, texto: 'minha agenda', irmao: false }] }));
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(input), antes);
  const itens = congelar(itensTool());
  const f = congelar({ ring: 'provider', items: [{ ref: 'agenda', semantica: { exemplos: [], funcoes: itens.map((i) => ({ ref: i.ref, ...i.semantica })) } }], semantica: { mediaFuncoes: media(itens.flatMap((i) => brutosDe(i.semantica))), slug: SLUG } });
  assert.equal(indiceDeFuncoesDoProvider(f).ok, true);
});

test('exporta pela API pública do decisor local', () => {
  assert.equal(pub.indiceDoRefino, indiceDoRefino);
  assert.equal(pub.indiceDeFuncoesDoProvider, indiceDeFuncoesDoProvider);
});

test('7. indiceDoCatalogo restrito aos refs de um refino == indiceDoRefino com os mesmos itens (media e calibração iguais)', () => {
  const items = itensTool();
  const mu = media(items.flatMap((it) => brutosDe(it.semantica)));
  const roubados = [{ ref: 'agenda/tool/listar', i: 0, texto: 'minha agenda', para: 'notas/tool/ler', irmao: false }];
  const doRefino = indiceDoRefino({ ring: 'tool', items, semantica: { media: mu, slug: SLUG, versao: 'v1' } }, { roubados });
  const anel = { itens: new Map(items.map((it) => [it.ref, it.semantica])), media: mu, versao: 'v1' };
  const doCat = indiceDoCatalogo('tool', anel, SLUG, { roubados });
  assert.equal(doCat.ok, true);
  assert.equal(doCat.removidos, doRefino.removidos);
  iguais(doCat.indice, doRefino.indice);
  assert.equal(doCat.indice.hash, doRefino.indice.hash);
  // sem media / sem itens: sem-semantica
  assert.equal(indiceDoCatalogo('tool', { itens: new Map(), versao: 'v' }, SLUG).motivo, 'sem-semantica');
  assert.equal(indiceDoCatalogo('tool', null, SLUG).ok, false);
  assert.equal(pub.indiceDoCatalogo, indiceDoCatalogo);
});

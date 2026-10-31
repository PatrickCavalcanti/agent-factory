import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_COMPLETA,
  SCHEMA_HEADLESS,
  resolveEnvelopeSchema,
} from '../src/protocolo/envelope-schema.js';

const VARIANTES = [
  ['SCHEMA_COMPLETA', SCHEMA_COMPLETA],
  ['SCHEMA_HEADLESS', SCHEMA_HEADLESS],
];

/**
 * Nós de forma livre CONHECIDOS E ACEITOS — hoje NENHUM. Todo nó de forma livre
 * (`object`/`array` do schema sem `properties`/`items`) é buraco de cobertura,
 * não decisão: o structured output estrito da família OpenAI rejeita objeto sem
 * `properties` e array sem `items`.
 *
 * Até esta correção havia duas exceções aqui — `root.blocos[].comandos[].args` e
 * `root.blocos[].layout` — fechadas por teste real, não teórico (sessão c936d250):
 * a OpenAI recusava o schema inteiro no boot (400 em `response_format`), e o
 * Gemini ACEITAVA e gerava `args: {}` sempre, silenciosamente — a gramática não
 * tinha nada declarado dentro para emitir (seis chamadas de `gcal_listar_eventos`
 * seguidas com `args: {}`, nenhuma tool com argumento funcionava). A correção
 * (ver `COMANDO.args` e `layout` em envelope.js) trocou os dois por `type:
 * 'string'` — o runtime faz `JSON.parse` depois; a validação real de `args` já
 * era via Zod no `executeTool` do genos, não aqui. O conjunto segue vazio aqui,
 * não removido: é o lugar único para uma exceção NOVA e justificada, se aparecer.
 */
const EXCECOES_FORMA_LIVRE = new Set();

function tiposDoNode(node) {
  return Array.isArray(node.type) ? node.type : [node.type];
}

/**
 * Percorre TODO nó de schema alcançável (via `properties.*` e `items`) — não só
 * os que já têm `properties`. É a base de todas as asserções abaixo: uma
 * asserção que só enxerga nós com `properties` fica cega para um nó de forma
 * livre novo (tipo `object`/`array` sem `properties`/`items`), que é exatamente
 * a classe de buraco que este arquivo existe para pegar.
 */
function collectAllNodes(node, path, out) {
  if (!node || typeof node !== 'object') return out;
  out.push({ node, path });
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, sub] of Object.entries(node.properties)) {
      collectAllNodes(sub, `${path}.${key}`, out);
    }
  }
  if (node.items) {
    collectAllNodes(node.items, `${path}[]`, out);
  }
  return out;
}

/** Só os nós que declaram `properties` — universo das duas checagens de "objeto fechado". */
function collectClosedObjectNodes(schema) {
  return collectAllNodes(schema, 'root', []).filter(
    ({ node }) => node.properties && typeof node.properties === 'object',
  );
}

/** Nós `object`/`array` que não têm como se declarar fechados: sem `properties` (object) ou sem `items` (array). */
function collectFreeformNodes(schema) {
  const out = [];
  for (const { node, path } of collectAllNodes(schema, 'root', [])) {
    const tipos = tiposDoNode(node);
    const ehObjeto = tipos.includes('object');
    const ehArray = tipos.includes('array');
    if (!ehObjeto && !ehArray) continue;
    const objetoFechado = !ehObjeto || (node.properties && node.additionalProperties === false);
    const arrayFechado = !ehArray || Boolean(node.items);
    if (!objetoFechado || !arrayFechado) out.push(path);
  }
  return out;
}

/** Coleta todo nome de propriedade declarado em qualquer nível do schema. */
function collectPropertyNames(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, sub] of Object.entries(node.properties)) {
      out.add(key);
      collectPropertyNames(sub, out);
    }
  }
  if (node.items) {
    collectPropertyNames(node.items, out);
  }
  return out;
}

for (const [nomeVariante, variante] of VARIANTES) {
  test(`${nomeVariante}: todo nó com "properties" tem additionalProperties: false (recursivo)`, () => {
    const nodes = collectClosedObjectNodes(variante.schema);
    assert.ok(nodes.length > 0, 'deveria ter encontrado ao menos um nó-objeto');
    for (const { node, path } of nodes) {
      assert.equal(
        node.additionalProperties,
        false,
        `nó em ${path} deveria ter additionalProperties: false`,
      );
    }
  });

  test(`${nomeVariante}: properties e required têm exatamente o mesmo conjunto de chaves (recursivo)`, () => {
    const nodes = collectClosedObjectNodes(variante.schema);
    assert.ok(nodes.length > 0, 'deveria ter encontrado ao menos um nó-objeto');
    for (const { node, path } of nodes) {
      const propKeys = [...new Set(Object.keys(node.properties))].sort();
      const requiredKeys = [...new Set(node.required ?? [])].sort();
      assert.deepEqual(
        requiredKeys,
        propKeys,
        `em ${path}, required deveria listar exatamente as chaves de properties (nem a mais, nem a menos) — strict: true exige igualdade`,
      );
    }
  });

  test(`${nomeVariante}: NENHUM nó de forma livre no schema (comandos[].args e layout viraram string)`, () => {
    const encontrados = collectFreeformNodes(variante.schema);
    const inesperados = encontrados.filter((path) => !EXCECOES_FORMA_LIVRE.has(path));
    assert.deepEqual(
      inesperados,
      [],
      'nó(s) de forma livre NOVO(S), fora da lista EXCECOES_FORMA_LIVRE deste arquivo (hoje vazia): ' +
        `${inesperados.join(', ') || '(nenhum)'} — um objeto sem "properties" ou array sem ` +
        '"items" quebra structured output estrito (família OpenAI) e vira {} silencioso no Gemini; ' +
        'se é intencional, adicione o caminho a EXCECOES_FORMA_LIVRE com o porquê',
    );
  });

  test(`${nomeVariante}: comandos[].args e layout NÃO são mais nós de forma livre — fechados como string`, () => {
    const argsNode = variante.schema.properties.blocos.items.properties.comandos.items.properties.args;
    assert.deepEqual(
      tiposDoNode(argsNode),
      ['string'],
      'comandos[].args deveria ser type: "string" — se voltou a "object", reabre a falha real ' +
        '(400 na OpenAI / args:{} silencioso no Gemini, sessão c936d250)',
    );
    if (nomeVariante === 'SCHEMA_COMPLETA') {
      const layoutNode = variante.schema.properties.blocos.items.properties.layout;
      assert.deepEqual(
        tiposDoNode(layoutNode),
        ['string', 'null'],
        'layout deveria ser type: ["string", "null"] — se voltou a object/array, reabre a mesma falha',
      );
    }
    const encontrados = new Set(collectFreeformNodes(variante.schema));
    assert.ok(
      !encontrados.has('root.blocos[].comandos[].args'),
      'comandos[].args não deveria mais aparecer como nó de forma livre',
    );
    assert.ok(
      !encontrados.has('root.blocos[].layout'),
      'layout não deveria mais aparecer como nó de forma livre',
    );
  });
}

test('SCHEMA_HEADLESS não tem "_fala" nem "layout" em nenhum lugar', () => {
  const nomes = collectPropertyNames(SCHEMA_HEADLESS.schema, new Set());
  assert.ok(!nomes.has('_fala'), 'headless não deveria declarar "_fala"');
  assert.ok(!nomes.has('layout'), 'headless não deveria declarar "layout"');
});

test('SCHEMA_COMPLETA tem "_fala" e "layout"', () => {
  const nomes = collectPropertyNames(SCHEMA_COMPLETA.schema, new Set());
  assert.ok(nomes.has('_fala'), 'completa deveria declarar "_fala"');
  assert.ok(nomes.has('layout'), 'completa deveria declarar "layout"');
});

test('SCHEMA_COMPLETA: "_fala" vem antes de "chat" na ordem de inserção de properties do bloco', () => {
  const blocoSchema = SCHEMA_COMPLETA.schema.properties.blocos.items;
  const chaves = Object.keys(blocoSchema.properties);
  const idxFala = chaves.indexOf('_fala');
  const idxChat = chaves.indexOf('chat');
  assert.ok(idxFala !== -1, '"_fala" deveria estar presente no bloco da variante completa');
  assert.ok(idxChat !== -1, '"chat" deveria estar presente no bloco da variante completa');
  assert.ok(idxFala < idxChat, `"_fala" (índice ${idxFala}) deveria vir antes de "chat" (índice ${idxChat})`);
});

test('SCHEMA_COMPLETA: ordenadas ALFABETICAMENTE, as chaves do bloco colocam "_fala" antes de "chat" — a defesa que sobrevive a um serializador que ignora properties', () => {
  // Bancada 2026-09-03 (meta/muse-spark-1.3-contributor, 6 rodadas): 36/36
  // blocos com fala e chat emitiram chat ANTES, porque o upstream serializa
  // chaves em ordem alfabética, não na ordem de `properties`. Este teste é o
  // que impede alguém de renomear `_fala` de volta para `fala` "por limpeza":
  // sem o `_` (ASCII 95, antes de qualquer minúscula), a ordenação alfabética
  // colocaria "chat" primeiro de novo.
  const blocoSchema = SCHEMA_COMPLETA.schema.properties.blocos.items;
  const chavesOrdenadasAlfabeticamente = Object.keys(blocoSchema.properties).slice().sort();
  const idxFala = chavesOrdenadasAlfabeticamente.indexOf('_fala');
  const idxChat = chavesOrdenadasAlfabeticamente.indexOf('chat');
  assert.ok(idxFala !== -1 && idxChat !== -1, 'ambas as chaves deveriam existir no bloco');
  assert.ok(
    idxFala < idxChat,
    `mesmo ordenado alfabeticamente, "_fala" (índice ${idxFala}) deveria vir antes de "chat" ` +
      `(índice ${idxChat}) — se isto falhar, o campo voltou a se chamar "fala" e a defesa estrutural morreu`,
  );
});

test('resolveEnvelopeSchema({headless: true}) devolve SCHEMA_HEADLESS', () => {
  assert.equal(resolveEnvelopeSchema({ headless: true }), SCHEMA_HEADLESS);
});

test('resolveEnvelopeSchema() sem argumentos devolve SCHEMA_COMPLETA', () => {
  assert.equal(resolveEnvelopeSchema(), SCHEMA_COMPLETA);
});

test('resolveEnvelopeSchema({headless: false}) devolve SCHEMA_COMPLETA', () => {
  assert.equal(resolveEnvelopeSchema({ headless: false }), SCHEMA_COMPLETA);
});

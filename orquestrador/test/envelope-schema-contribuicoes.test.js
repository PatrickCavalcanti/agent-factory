import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_COMPLETA,
  SCHEMA_HEADLESS,
  SCHEMA_COMPLETA_CONTRIBUICOES,
  resolveEnvelopeSchema,
  schemasDoEnvelope,
} from '../src/protocolo/envelope-schema.js';

const IGRIS = { prefixoDoEnvelope: 'igris' };
const blocoDe = (s) => s.schema.properties.blocos.items;

/**
 * `JSON.stringify` das variantes ANTES do campo `_contribuicoes_usadas` existir
 * (copiado da árvore antes da mudança da Task 1.2 do plano de aceite de
 * contribuição de comportamento). Sem a opção, `resolveEnvelopeSchema` devolve
 * exatamente isto, byte a byte: o interruptor desligado não pode mudar a
 * gramática que os vendors já compilaram.
 */
const COMPLETA_ANTES = '{"name":"igris_envelope","schema":{"type":"object","additionalProperties":false,"required":["blocos"],"properties":{"blocos":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["_fala","chat","layout","comandos","_intencao"],"properties":{"_fala":{"type":["object","null"],"additionalProperties":false,"required":["text","purpose","await","interruptible"],"properties":{"text":{"type":"string"},"purpose":{"type":"string"},"await":{"type":"boolean"},"interruptible":{"type":"boolean"}}},"chat":{"type":["string","null"]},"layout":{"type":["string","null"]},"comandos":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["tool","args"],"properties":{"tool":{"type":"string"},"args":{"type":"string"}}}},"_intencao":{"type":["string","null"]}}}}}}}';

const HEADLESS_ANTES = '{"name":"igris_envelope_headless","schema":{"type":"object","additionalProperties":false,"required":["blocos"],"properties":{"blocos":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["chat","comandos"],"properties":{"chat":{"type":["string","null"]},"comandos":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["tool","args"],"properties":{"tool":{"type":"string"},"args":{"type":"string"}}}}}}}}}}';

test('sem a opção, a variante completa continua byte a byte a de antes', () => {
  assert.equal(JSON.stringify(resolveEnvelopeSchema(IGRIS)), COMPLETA_ANTES);
  assert.equal(JSON.stringify(resolveEnvelopeSchema({ ...IGRIS })), COMPLETA_ANTES);
  assert.equal(JSON.stringify(resolveEnvelopeSchema({ ...IGRIS, headless: false })), COMPLETA_ANTES);
  assert.equal(JSON.stringify(resolveEnvelopeSchema({ ...IGRIS, comContribuicoes: false })), COMPLETA_ANTES);
  assert.equal(JSON.stringify(schemasDoEnvelope('igris').completa), COMPLETA_ANTES);
});

test('sem a opção, a variante headless continua byte a byte a de antes', () => {
  assert.equal(JSON.stringify(resolveEnvelopeSchema({ ...IGRIS, headless: true })), HEADLESS_ANTES);
  assert.equal(
    JSON.stringify(resolveEnvelopeSchema({ ...IGRIS, headless: true, comContribuicoes: false })),
    HEADLESS_ANTES,
  );
  assert.equal(JSON.stringify(schemasDoEnvelope('igris').headless), HEADLESS_ANTES);
});

test('comContribuicoes: true dá _contribuicoes_usadas string|null, REQUERIDO e por ÚLTIMO (depois de _intencao)', () => {
  const b = blocoDe(resolveEnvelopeSchema({ ...IGRIS, comContribuicoes: true }));
  assert.deepEqual(b.properties._contribuicoes_usadas, { type: ['string', 'null'] });
  assert.ok(b.required.includes('_contribuicoes_usadas'));
  assert.equal(b.required[b.required.length - 1], '_contribuicoes_usadas');
  assert.ok(
    b.required.indexOf('_intencao') < b.required.indexOf('_contribuicoes_usadas'),
    'required deveria manter _intencao e só então _contribuicoes_usadas',
  );
  const chaves = Object.keys(b.properties);
  assert.equal(chaves[chaves.length - 1], '_contribuicoes_usadas');
});

test('a variante com contribuições é OUTRA: a completa de hoje não ganha o campo', () => {
  const comCampo = resolveEnvelopeSchema({ ...IGRIS, comContribuicoes: true });
  assert.notEqual(comCampo, schemasDoEnvelope('igris').completa);
  assert.equal(blocoDe(SCHEMA_COMPLETA).properties._contribuicoes_usadas, undefined);
  // properties/required continuam com o mesmo conjunto no bloco novo (strict: true).
  const b = blocoDe(comCampo);
  assert.deepEqual([...b.required].sort(), Object.keys(b.properties).sort());
});

test('headless vence comContribuicoes: agente de fundo não declara contribuição de comportamento', () => {
  const s = resolveEnvelopeSchema({ ...IGRIS, headless: true, comContribuicoes: true });
  assert.equal(s, schemasDoEnvelope('igris').headless);
  assert.equal(blocoDe(s).properties._contribuicoes_usadas, undefined);
});

test('sem prefixo, os nomes são neutros e as constantes exportadas os carregam', () => {
  assert.equal(SCHEMA_COMPLETA.name, 'envelope');
  assert.equal(SCHEMA_HEADLESS.name, 'envelope_headless');
  assert.equal(SCHEMA_COMPLETA_CONTRIBUICOES.name, 'envelope_contribuicoes');
  assert.equal(resolveEnvelopeSchema().name, 'envelope');
  assert.equal(resolveEnvelopeSchema({ headless: true }).name, 'envelope_headless');
  assert.equal(resolveEnvelopeSchema({ comContribuicoes: true }).name, 'envelope_contribuicoes');
});

test('o prefixo só muda o nome: o corpo do schema é idêntico ao neutro', () => {
  const g = schemasDoEnvelope('igris');
  assert.equal(g.completa.name, 'igris_envelope');
  assert.equal(g.headless.name, 'igris_envelope_headless');
  assert.equal(g.completaContribuicoes.name, 'igris_envelope_contribuicoes');
  assert.deepEqual(g.completa.schema, SCHEMA_COMPLETA.schema);
  assert.deepEqual(g.headless.schema, SCHEMA_HEADLESS.schema);
  assert.deepEqual(g.completaContribuicoes.schema, SCHEMA_COMPLETA_CONTRIBUICOES.schema);
  assert.equal(schemasDoEnvelope('igris'), g, 'mesmo prefixo, mesmos objetos');
  assert.equal(schemasDoEnvelope(''), schemasDoEnvelope(), 'prefixo vazio = neutro');
});

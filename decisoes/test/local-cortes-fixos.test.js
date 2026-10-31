// packages/decisions/test/local-cortes-fixos.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { CORTES_FIXOS, FUNCAO_TRAZ_PADRAO, normalizarCortesFixos, normalizarFuncaoTraz } from '../src/local/cortes-fixos.js';

test('padrões D2/D4 da spec 2026-10-07', () => {
  assert.deepEqual(CORTES_FIXOS, { cabeca: { full: 0.30, candidate: 0.15 }, base: { full: 0.35, candidate: 0.25 }, promocao: 0.70, comKairos: { full: 0.70, minimo: 0.25 } }); // D6 0,60 → 0,70 (régua do corte, 13/10)
  assert.deepEqual(FUNCAO_TRAZ_PADRAO, { ativo: true, n: 5, candidata: 0.40, promoverFull: 'so-provider-na-base' });
});
test('normalizarCortesFixos: override válido vence; inválido (candidate > full, promocao fora de [0,1]) cai no padrão e lista o motivo', () => {
  const ok = normalizarCortesFixos({ cabeca: { full: 0.4, candidate: 0.2 } });
  assert.deepEqual(ok.cortes.cabeca, { full: 0.4, candidate: 0.2 }); assert.deepEqual(ok.cortes.base, CORTES_FIXOS.base); assert.deepEqual(ok.motivos, []);
  assert.equal(ok.origem.cabeca, 'override'); assert.equal(ok.origem.base, 'fixo');
  const ruim = normalizarCortesFixos({ base: { full: 0.2, candidate: 0.3 }, promocao: 7 });
  assert.deepEqual(ruim.cortes, CORTES_FIXOS); assert.equal(ruim.motivos.length, 2);
});
test('escala por chave: cabeça é probabilidade ([0,1]) — negativa vira motivo e cai no padrão; base é cosseno centrado ([-1,1]) — negativa vale', () => {
  const cab = normalizarCortesFixos({ cabeca: { full: -0.1, candidate: -0.5 } });
  assert.deepEqual(cab.cortes.cabeca, CORTES_FIXOS.cabeca); assert.equal(cab.origem.cabeca, 'fixo');
  assert.deepEqual(cab.motivos, ['cortes.cabeca inválido (full/candidate em [0,1], candidate ≤ full)']);
  assert.equal(normalizarCortesFixos({ cabeca: { full: 0.5, candidate: -0.01 } }).motivos.length, 1); // um lado fora basta
  assert.equal(normalizarCortesFixos({ cabeca: { full: 1.01, candidate: 0.2 } }).motivos.length, 1);
  assert.deepEqual(normalizarCortesFixos({ cabeca: { full: 1, candidate: 0 } }).cortes.cabeca, { full: 1, candidate: 0 }); // bordas valem
  const base = normalizarCortesFixos({ base: { full: 0.1, candidate: -0.2 } });
  assert.deepEqual(base.cortes.base, { full: 0.1, candidate: -0.2 }); assert.equal(base.origem.base, 'override'); assert.deepEqual(base.motivos, []);
  assert.equal(normalizarCortesFixos({ base: { full: 0.5, candidate: -1.01 } }).motivos.length, 1);
});
test('normalizarCortesFixos: não-número (string, NaN, Infinity, null, ausente) cai no padrão com motivo', () => {
  const r = normalizarCortesFixos({ cabeca: { full: 'x', candidate: 0.1 }, base: { full: NaN, candidate: 0 }, promocao: '0.5' });
  assert.deepEqual(r.cortes, CORTES_FIXOS); assert.equal(r.motivos.length, 3);
  assert.deepEqual(r.origem, { cabeca: 'fixo', base: 'fixo', promocao: 'fixo', comKairos: 'fixo' });
  assert.equal(normalizarCortesFixos({ base: { full: Infinity, candidate: 0 } }).motivos.length, 1);
  assert.equal(normalizarCortesFixos({ cabeca: null }).motivos.length, 1);
  assert.equal(normalizarCortesFixos({ base: { full: 0.3 } }).motivos.length, 1); // candidate ausente
  assert.deepEqual(normalizarCortesFixos(null).cortes, CORTES_FIXOS); assert.deepEqual(normalizarCortesFixos(undefined).motivos, []);
});
test('normalizarFuncaoTraz: aceita ativo/n/candidata/promoverFull válidos; promoverFull só "sempre" | "so-provider-na-base" | "nunca"', () => {
  assert.equal(normalizarFuncaoTraz({ promoverFull: 'sempre', n: 3 }).valor.promoverFull, 'sempre');
  assert.equal(normalizarFuncaoTraz({ promoverFull: 'x' }).valor.promoverFull, 'so-provider-na-base');
  assert.equal(normalizarFuncaoTraz({ ativo: false }).valor.ativo, false);
});

test('normalizarCortesFixos: chave do formato antigo por anel (provider/tool/skill com {full, candidate}) é ignorada com motivo', () => {
  const r = normalizarCortesFixos({ provider: { full: 0.3, candidate: 0.1 }, tool: { full: 0.2, candidate: 0.1 }, skill: { candidate: 0.2 } });
  assert.deepEqual(r.cortes, CORTES_FIXOS);
  assert.deepEqual(r.origem, { cabeca: 'fixo', base: 'fixo', promocao: 'fixo', comKairos: 'fixo' });
  assert.equal(r.motivos.length, 3);
  for (const anel of ['provider', 'tool', 'skill']) assert.ok(r.motivos.some((m) => m.startsWith(`cortes.${anel}:`) && m.includes('formato antigo por anel ignorado')), anel);
  // convive com um override novo válido: o novo vale, o antigo só gera motivo
  const misto = normalizarCortesFixos({ base: { full: 0.4, candidate: 0.2 }, provider: { full: 0.3, candidate: 0.1 } });
  assert.deepEqual(misto.cortes.base, { full: 0.4, candidate: 0.2 }); assert.equal(misto.origem.base, 'override'); assert.equal(misto.motivos.length, 1);
  // chave de anel sem cara de corte (ou ausente) não gera motivo
  assert.deepEqual(normalizarCortesFixos({ tool: 'x', skill: null, provider: {} }).motivos, []);
});

test('normalizarFuncaoTraz: ativo não booleano vira motivo e cai no padrão; booleano vale', () => {
  for (const ativo of ['sim', 1, 0, null, 'false']) {
    const r = normalizarFuncaoTraz({ ativo });
    assert.equal(r.valor.ativo, FUNCAO_TRAZ_PADRAO.ativo, String(ativo));
    assert.deepEqual(r.motivos, ['funcaoTrazCapacidade.ativo inválido (booleano)'], String(ativo));
  }
  assert.deepEqual(normalizarFuncaoTraz({ ativo: true }).motivos, []);
  assert.equal(normalizarFuncaoTraz({ ativo: false }).valor.ativo, false);
  assert.deepEqual(normalizarFuncaoTraz({}).motivos, []); // ausente não é inválido
});

test('normalizarFuncaoTraz: n (inteiro em 1..20) e candidata (número em [0,1]) inválidos caem no padrão com um motivo cada', () => {
  for (const n of [0, 21, 2.5, '3', NaN, null, -1]) {
    const r = normalizarFuncaoTraz({ n });
    assert.equal(r.valor.n, FUNCAO_TRAZ_PADRAO.n, String(n));
    assert.deepEqual(r.motivos, ['funcaoTrazCapacidade.n inválido (1..20)'], String(n));
  }
  for (const candidata of [-0.1, 1.1, '0.4', NaN, null, Infinity]) {
    const r = normalizarFuncaoTraz({ candidata });
    assert.equal(r.valor.candidata, FUNCAO_TRAZ_PADRAO.candidata, String(candidata));
    assert.deepEqual(r.motivos, ['funcaoTrazCapacidade.candidata inválido'], String(candidata));
  }
  // bordas valem
  assert.equal(normalizarFuncaoTraz({ n: 1 }).valor.n, 1); assert.equal(normalizarFuncaoTraz({ n: 20 }).valor.n, 20);
  assert.equal(normalizarFuncaoTraz({ candidata: 0 }).valor.candidata, 0); assert.equal(normalizarFuncaoTraz({ candidata: 1 }).valor.candidata, 1);
  // vários inválidos de uma vez: um motivo por campo, os válidos passam
  const varios = normalizarFuncaoTraz({ ativo: 'x', n: 99, candidata: 7, promoverFull: 'sempre' });
  assert.equal(varios.motivos.length, 3); assert.equal(varios.valor.promoverFull, 'sempre');
  assert.deepEqual(normalizarFuncaoTraz(null).valor, FUNCAO_TRAZ_PADRAO);
});

test('normalizarCortesFixos: chave desconhecida dentro de cortes (typo `cabeça`, `promocoes`) vira motivo e é ignorada; as conhecidas e as de anel (formato antigo, tratadas à parte) não geram esse motivo', () => {
  const r = normalizarCortesFixos({ 'cabeça': { full: 0.4, candidate: 0.2 }, promocoes: 0.5, base: { full: 0.4, candidate: 0.2 } });
  assert.deepEqual(r.cortes.cabeca, CORTES_FIXOS.cabeca, 'a chave desconhecida não vale como override');
  assert.equal(r.cortes.promocao, CORTES_FIXOS.promocao);
  assert.deepEqual(r.cortes.base, { full: 0.4, candidate: 0.2 }); assert.equal(r.origem.base, 'override');
  assert.deepEqual(r.motivos, ['cortes.cabeça: chave desconhecida — ignorada', 'cortes.promocoes: chave desconhecida — ignorada']);
  // chaves conhecidas, válidas ou não, não geram o motivo de chave desconhecida
  assert.deepEqual(normalizarCortesFixos({ cabeca: { full: 0.4, candidate: 0.2 }, base: { full: 0.4, candidate: 0.2 }, promocao: 0.8 }).motivos, []);
  assert.equal(normalizarCortesFixos({ promocao: 7 }).motivos.every((m) => !/desconhecida/.test(m)), true);
  // as chaves de anel têm o motivo próprio do formato antigo (e só ele)
  const antigo = normalizarCortesFixos({ provider: { full: 0.3, candidate: 0.1 } });
  assert.equal(antigo.motivos.length, 1); assert.doesNotMatch(antigo.motivos[0], /desconhecida/);
  // vazio e array: nada a avisar aqui (o "não é objeto" é do chamador)
  assert.deepEqual(normalizarCortesFixos({}).motivos, []);
  assert.deepEqual(normalizarCortesFixos([1, 2]).motivos, []);
});

test('normalizarCortesFixos: comKairos (D6) — override válido, null desliga, inválido cai no padrão com motivo', () => {
  const ok = normalizarCortesFixos({ comKairos: { full: 0.5, minimo: 0.2 } });
  assert.deepEqual(ok.cortes.comKairos, { full: 0.5, minimo: 0.2 }); assert.equal(ok.origem.comKairos, 'override'); assert.deepEqual(ok.motivos, []);
  const desl = normalizarCortesFixos({ comKairos: null });
  assert.equal(desl.cortes.comKairos, null); assert.equal(desl.origem.comKairos, 'override');
  for (const ruim of [{ full: 0.2, minimo: 0.5 }, { full: 1.2, minimo: 0.1 }, { full: 0.6 }, 'x']) {
    const r = normalizarCortesFixos({ comKairos: ruim });
    assert.deepEqual(r.cortes.comKairos, CORTES_FIXOS.comKairos); assert.equal(r.origem.comKairos, 'fixo'); assert.equal(r.motivos.length, 1);
  }
});

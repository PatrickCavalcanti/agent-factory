// packages/decisions/test/local-cabeca.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { novaCabeca, pontuarCabeca, treinarCabeca, serializarCabeca, carregarCabeca, cabecaFinita } from '../src/local/cabeca.js';
import { normalizar } from '../src/local/vetores.js';

const d = 8;
const base = (k) => normalizar(Array.from({ length: d }, (_, i) => (i === k ? 1 : 0.05)));
// candidato j tem vetor base(j); o pedido de j "parece" o candidato (j+1)%4 — a cabeça precisa aprender o deslocamento
const P = [0, 1, 2, 3].map(base);
const casos = Array.from({ length: 80 }, (_, n) => ({ s: base((n % 4 + 1) % 4), pos: new Set([n % 4]) }));

test('treino baixa a perda e põe o positivo em 1º', () => {
  const { cabeca, perdas } = treinarCabeca({ casos, P, epocas: 60, lr: 0.5, seed: 1, posto: 4 });
  assert.ok(perdas.at(-1) < perdas[0]);
  for (let j = 0; j < 4; j++) {
    const s = base((j + 1) % 4);
    const notas = P.map((p) => pontuarCabeca(cabeca, s, p));
    assert.equal(notas.indexOf(Math.max(...notas)), j);
  }
});

test('candidatosPorCaso: padrão idêntico ao domínio completo; domínio restrito muda o treino', () => {
  const todos = [0, 1, 2, 3];
  const a = treinarCabeca({ casos, P, epocas: 5, seed: 1, posto: 4 });
  const b = treinarCabeca({ casos, P, epocas: 5, seed: 1, posto: 4, candidatosPorCaso: casos.map(() => todos) });
  assert.deepEqual(b.cabeca, a.cabeca);
  const c = treinarCabeca({ casos, P, epocas: 5, seed: 1, posto: 4, candidatosPorCaso: casos.map((cs) => [...cs.pos, (([...cs.pos][0]) + 1) % 4]) });
  assert.notDeepEqual(c.cabeca.U, a.cabeca.U);
  assert.throws(() => treinarCabeca({ casos, P, candidatosPorCaso: [[0]] }), /candidatosPorCaso/);
});

const gravar = (obj) => { const arq = join(mkdtempSync(join(tmpdir(), 'cab-')), 'provider.json'); writeFileSync(arq, JSON.stringify(obj)); return arq; };
const valida = (extra = {}) => ({ ...serializarCabeca(novaCabeca({ d, posto: 2, seed: 0 }), { anel: 'provider', slug: 's1', hash: 'h1', anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.5, n: 40 }, metricas: {}, nTreinoPorCapacidade: { agenda: 60 }, cortesSugeridos: { full: 0.5, candidate: 0.2 } }), ...extra });
// Arquivo v1 (legado) como o treino gravava até a spec 2026-10-07: aprovadas por capacidade + cortes calculados.
const valida1 = (extra = {}) => {
  const { versao, anelAprovado, metricasAnel, nTreinoPorCapacidade, cortesSugeridos, ...resto } = valida();
  return { ...resto, versao: 1, aprovadas: ['agenda'], cortes: { full: 0.5, candidate: 0.2 }, ...extra };
};

test('carregarCabeca confere slug e dimensão', () => {
  const arq = gravar(valida());
  const ok = carregarCabeca({ arquivo: arq, slug: 's1', hash: 'h1', dim: d });
  assert.equal(ok.ok, true);
  assert.equal(ok.anelAprovado, true);
  assert.deepEqual(ok.cortesSugeridos, { full: 0.5, candidate: 0.2 });
  assert.equal(carregarCabeca({ arquivo: arq, slug: 's2', hash: 'h1', dim: d }).motivo, 'outro-provider');
  assert.equal(carregarCabeca({ arquivo: arq, slug: 's1', hash: 'h2', dim: d }).ok, true) // hash só informativo;
  assert.equal(carregarCabeca({ arquivo: arq, slug: 's1', hash: 'h1', dim: d + 1 }).motivo, 'outra-dimensao');
  assert.equal(carregarCabeca({ arquivo: join(dirname(arq), 'nada.json'), slug: 's1', hash: 'h1', dim: d }).motivo, 'sem-arquivo');
});

test('carregarCabeca rejeita pesos inválidos (forma, NaN); arquivo sem cortes passa (v2 não tem cortes)', () => {
  const car = (obj) => carregarCabeca({ arquivo: gravar(obj), slug: 's1', hash: 'h1', dim: d });
  const base = valida();
  assert.equal(car({ ...base, alfa: null }).motivo, 'pesos-invalidos'); // NaN serializa como null
  assert.equal(car({ ...base, beta: 'x' }).motivo, 'pesos-invalidos');
  assert.equal(car({ ...base, U: base.U.slice(1) }).motivo, 'pesos-invalidos');
  assert.equal(car({ ...base, V: base.V.map((l) => l.slice(1)) }).motivo, 'pesos-invalidos');
  assert.equal(car({ ...base, U: base.U.map((l, i) => (i === 0 ? [null, 0] : l)) }).motivo, 'pesos-invalidos');
  assert.equal(base.cortes, undefined); // v2 não grava `cortes`
  assert.equal(car(base).ok, true);
  assert.equal(car(valida1({ cortes: undefined })).ok, true); // v1 sem cortes também carrega (os cortes são fixos de produto)
  assert.equal(car({ ...base, versao: 3 }).motivo, 'versao');
  assert.equal(car({ ...base, versao: undefined }).motivo, 'versao');
});

test('v2: serializarCabeca grava anelAprovado, metricasAnel, nTreinoPorCapacidade e cortesSugeridos; carregarCabeca devolve os mesmos campos e não exige cortes', () => {
  const c = novaCabeca({ d, posto: 2, seed: 0 });
  const arq = serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h', anelAprovado: true, metricasAnel: { base: 0.42, cabeca: 0.56, n: 106 }, metricas: { agenda: { nTreino: 5, base: 0.5, cabeca: 0.7, nRecentes: 3 } }, nTreinoPorCapacidade: { agenda: 5 }, cortesSugeridos: { full: 0.31, candidate: 0.12 } });
  assert.equal(arq.versao, 2); assert.equal(arq.cortes, undefined); assert.equal(arq.aprovadas, undefined);
  const r = carregarCabeca({ arquivo: gravar(arq), slug: 's', dim: c.d });
  assert.equal(r.ok, true); assert.equal(r.anelAprovado, true); assert.deepEqual(r.metricasAnel, { base: 0.42, cabeca: 0.56, n: 106 });
  assert.deepEqual(r.nTreinoPorCapacidade, { agenda: 5 }); assert.deepEqual(r.cortesSugeridos, { full: 0.31, candidate: 0.12 }); assert.equal(r.versaoDoArquivo, 2);
  assert.deepEqual(r.metricas.agenda, { nTreino: 5, base: 0.5, cabeca: 0.7, nRecentes: 3 });
});

test('v2: padrões do serializarCabeca — anel reprovado, sem métricas, sem sugestão', () => {
  const c = novaCabeca({ d, posto: 2, seed: 0 });
  const arq = serializarCabeca(c, { anel: 'tool', slug: 's', hash: 'h' });
  assert.equal(arq.anelAprovado, false); assert.equal(arq.metricasAnel, null); assert.deepEqual(arq.nTreinoPorCapacidade, {}); assert.equal(arq.cortesSugeridos, null);
  const r = carregarCabeca({ arquivo: gravar(arq), slug: 's', dim: c.d });
  assert.equal(r.ok, true); assert.equal(r.anelAprovado, false); assert.equal(r.metricasAnel, null); assert.equal(r.cortesSugeridos, null); assert.deepEqual(r.nTreinoPorCapacidade, {});
  // anelAprovado só é true se for exatamente true no arquivo (string "true" não vale)
  assert.equal(carregarCabeca({ arquivo: gravar({ ...arq, anelAprovado: 'true' }), slug: 's', dim: c.d }).anelAprovado, false);
});

test('v1 (legado): aprovadas não vazio → anelAprovado true; nTreinoPorCapacidade vem de metricas[*].nTreino; cortes antigos viram cortesSugeridos', () => {
  const c = novaCabeca({ d, posto: 2, seed: 0 });
  const v1 = { versao: 1, anel: 'provider', slug: 's', hash: 'h', d: c.d, posto: c.posto, U: c.U, V: c.V, alfa: c.alfa, beta: c.beta, aprovadas: ['agenda'], cortes: { full: 0.05, candidate: 0.05 }, metricas: { agenda: { nTreino: 9, base: 0.4, cabeca: 0.6, nRecentes: 4 }, notas: { nTreino: 2, base: 0.1, cabeca: 0.1, nRecentes: 1 } } };
  const r = carregarCabeca({ arquivo: gravar(v1), slug: 's', dim: c.d });
  assert.equal(r.ok, true); assert.equal(r.anelAprovado, true); assert.equal(r.metricasAnel, null);
  assert.deepEqual(r.nTreinoPorCapacidade, { agenda: 9, notas: 2 }); assert.deepEqual(r.cortesSugeridos, { full: 0.05, candidate: 0.05 }); assert.equal(r.versaoDoArquivo, 1);
});

test('v1 sem nenhuma aprovada → anelAprovado false; nTreino ausente ou não numérico vira 0', () => {
  const r = carregarCabeca({ arquivo: gravar(valida1({ aprovadas: [], metricas: { a: { nTreino: 7 }, b: {}, c: { nTreino: 'x' }, d: null } })), slug: 's1', dim: d });
  assert.equal(r.ok, true); assert.equal(r.anelAprovado, false);
  assert.deepEqual(r.nTreinoPorCapacidade, { a: 7, b: 0, c: 0, d: 0 });
  assert.equal(carregarCabeca({ arquivo: gravar(valida1({ aprovadas: undefined, metricas: undefined })), slug: 's1', dim: d }).anelAprovado, false);
});

test('carregarCabeca não devolve mais aprovadas nem cortes (v1 e v2): o portão é do anel e os cortes são fixos', () => {
  for (const arq of [valida1(), valida()]) {
    const r = carregarCabeca({ arquivo: gravar(arq), slug: 's1', dim: d });
    assert.equal(r.ok, true);
    assert.equal('aprovadas' in r, false); assert.equal('cortes' in r, false);
  }
});

test('treinarCabeca lança com casos ou P vazios', () => {
  assert.throws(() => treinarCabeca({ casos: [], P }), /sem casos/);
  assert.throws(() => treinarCabeca({ casos, P: [] }), /P vazio/);
});

// Regressão (treino base 2026-10-07): anel tool com alvo concentrado em poucos nós + domínios por caso divergia
// com lr 0.5 (perda subia, pesos viravam NaN → null no arquivo). Cenário reduzido: determinístico, ~50 ms.
function cenarioConcentrado({ d = 48, nCap = 10, nTool = 60, nCasos = 400, concentrado = 2 } = {}) {
  let sd = 7; const r = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const unit = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const capVec = Array.from({ length: nCap }, () => unit(Array.from({ length: d }, g)));
  const toolCap = Array.from({ length: nTool }, (_, j) => j % nCap);
  const P0 = toolCap.map((c) => unit(capVec[c].map((x) => x + 0.05 * g())));
  const mu = Array.from({ length: d }, (_, i) => P0.reduce((s, p) => s + p[i], 0) / nTool);
  const Pc = P0.map((p) => p.map((x, i) => x - mu[i]));
  const cs = []; const candidatosPorCaso = [];
  for (let n = 0; n < nCasos; n++) {
    const j = r() < 0.8 ? Math.floor(r() * concentrado) : Math.floor(r() * nTool);
    const s = unit(P0[j].map((x, i, a) => a[(i * 7 + 3) % d] + 0.05 * g())).map((x, i) => x - mu[i]);
    cs.push({ s, pos: new Set([j]) });
    const caps = new Set([toolCap[j], Math.floor(r() * nCap), Math.floor(r() * nCap)]);
    candidatosPorCaso.push(toolCap.map((c, i) => (caps.has(c) ? i : -1)).filter((i) => i >= 0));
  }
  return { casos: cs, P: Pc, candidatosPorCaso };
}

test('regressão: alvo concentrado com candidatosPorCaso e lr 0.5 não diverge (pesos finitos, perda cai)', () => {
  const { cabeca, perdas } = treinarCabeca({ ...cenarioConcentrado(), epocas: 30, posto: 8 });
  assert.equal(cabecaFinita(cabeca), true);
  assert.equal(perdas.length, 30);
  assert.ok(perdas.every(Number.isFinite));
  assert.ok(perdas.at(-1) < perdas[0]);
});

test('fail-closed: divergência irrecuperável lança treino-divergiu em vez de devolver NaN', () => {
  assert.throws(() => treinarCabeca({ ...cenarioConcentrado(), epocas: 30, posto: 8, lr: 1e15 }), /treino-divergiu/);
});

test('treinarCabeca parte dos pesos iniciais quando informados', () => {
  const { cabeca: c0 } = treinarCabeca({ casos, P, epocas: 20, lr: 0.5, seed: 1, posto: 4 });
  const { cabeca: c1, perdas } = treinarCabeca({ casos, P, epocas: 1, lr: 0.01, seed: 9, posto: 4, inicial: c0 });
  const dif = c1.U.flat().reduce((s, x, i) => s + Math.abs(x - c0.U.flat()[i]), 0) / c1.U.flat().length;
  assert.ok(dif < 0.05, `afastou demais: ${dif}`);
  assert.equal(perdas.length, 1);
  assert.notStrictEqual(c1.U, c0.U); // cópia, não mutação
});

test('inicial com forma diferente lança', () => {
  const c0 = novaCabeca({ d: 8, posto: 4, seed: 0 });
  assert.throws(() => treinarCabeca({ casos, P, epocas: 1, posto: 2, inicial: c0 }), /inicial/);
});

test('carregarCabeca não trava mais pelo hash do catálogo', () => {
  const arq = gravar(valida());
  assert.equal(carregarCabeca({ arquivo: arq, slug: 's1', hash: 'OUTRO', dim: d }).ok, true);
  assert.equal(carregarCabeca({ arquivo: arq, slug: 's2', dim: d }).motivo, 'outro-provider');
});

test('inicial com pesos não finitos ou matriz malformada lança antes de treinar', () => {
  const c0 = novaCabeca({ d, posto: 4, seed: 0 });
  assert.throws(() => treinarCabeca({ casos, P, epocas: 1, posto: 4, inicial: { ...c0, alfa: NaN } }), /inicial inválida/);
  const malformada = { ...c0, U: c0.U.map((l, i) => (i === 0 ? l.slice(1) : l)) };
  assert.throws(() => treinarCabeca({ casos, P, epocas: 1, posto: 4, inicial: malformada }), /inicial inválida/);
  const comNaN = { ...c0, V: c0.V.map((l, i) => (i === 1 ? l.map(() => NaN) : l)) };
  assert.throws(() => treinarCabeca({ casos, P, epocas: 1, posto: 4, inicial: comNaN }), /inicial inválida/);
});

test('serializarCabeca v2 é ESTRITO: aprovadas ou cortes (assinatura v1) lançam TypeError, mesmo vazios/null — não grava arquivo com cara de v2 sem portão', () => {
  const c = novaCabeca({ d, posto: 2, seed: 0 });
  const msg = /serializarCabeca v2: aprovadas\/cortes não existem mais — use anelAprovado\/cortesSugeridos/;
  assert.throws(() => serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h', aprovadas: ['agenda'], cortes: { full: 0.5, candidate: 0.2 } }), (e) => e instanceof TypeError && msg.test(e.message));
  assert.throws(() => serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h', aprovadas: [] }), TypeError);
  assert.throws(() => serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h', cortes: null }), TypeError);
  assert.throws(() => serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h', cortes: undefined }), TypeError);
  // a assinatura v2 segue valendo, inclusive só com o mínimo
  assert.equal(serializarCabeca(c, { anel: 'provider', slug: 's', hash: 'h' }).versao, 2);
});

test('v2: nTreinoPorCapacidade vindo de disco é saneado como no v1 — valor não finito vira 0; formato que não é objeto vira {}', () => {
  const car = (extra) => carregarCabeca({ arquivo: gravar(valida(extra)), slug: 's1', dim: d });
  const r = car({ nTreinoPorCapacidade: { agenda: 60, a: 'abc', b: null, c: undefined, e: {}, f: -3, g: 0 } });
  assert.equal(r.ok, true);
  // JSON descarta `undefined`; o resto não finito/não numérico vira 0 (negativo é finito: fica como está)
  assert.deepEqual(r.nTreinoPorCapacidade, { agenda: 60, a: 0, b: 0, e: 0, f: -3, g: 0 });
  for (const lixo of ['texto', 7, [1, 2], null, true]) assert.deepEqual(car({ nTreinoPorCapacidade: lixo }).nTreinoPorCapacidade, {}, String(lixo));
  assert.deepEqual(car({ nTreinoPorCapacidade: undefined }).nTreinoPorCapacidade, {});
});

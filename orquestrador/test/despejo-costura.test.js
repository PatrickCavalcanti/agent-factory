import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refEhFixa, criarSinalForte, sobeJuntoNaEntrada, protecaoDoDespejo, ehContinuacaoCurta, caudaDoTurnoComHerdada, usadasDoTurno, fecharTurnoDoDespejo } from '../src/despejo/costura.js';
import { estadoDespejoVazio } from '../src/despejo/registro-de-uso.js';

// Costura do despejo (spec 2026-10-29): as funções que o orquestrador e o avaliador de sessões compartilham.
const tool = (name, extra = {}) => ({ name, ...extra });
const CAPS = [
  { id: 'agenda', tools: [tool('agir')] }, // piso (default): tudo é fixa
  { id: 'okapp', piso: false, tools: [tool('ler', { fixa: true }), tool('salvar', { fixa: false, acompanha: ['validar'] }), tool('validar', { fixa: false }), tool('mostrar', { fixa: false, view: { exibir: 'auto' } })] },
  { id: 'gcal', piso: false, tools: [tool('ver', { fixa: false })] },
];
const NENHUM_SINAL = () => false;

test('refEhFixa: a mesma noção do orquestrador (declarada, ou herdada do piso); desconhecida não é fixa', () => {
  assert.equal(refEhFixa('okapp/tool/ler', CAPS), true);
  assert.equal(refEhFixa('okapp/tool/salvar', CAPS), false);
  assert.equal(refEhFixa('agenda/tool/agir', CAPS), true, 'piso herda');
  assert.equal(refEhFixa('okapp/tool/nao_existe', CAPS), false);
  assert.equal(refEhFixa('outra/tool/x', CAPS), false);
});

test('criarSinalForte: confiança do refinador OU z-score acima do limiar', () => {
  const explain = new Map([['a', { refiner: { confidence: 0.9 }, scores: { z: 0 } }], ['b', { scores: { z: 2 } }], ['c', { refiner: { confidence: 0.1 }, scores: { z: 0.1 } }]]);
  const forte = criarSinalForte(explain, { cabeca: 0.8, z: 1.5 });
  assert.deepEqual(['a', 'b', 'c', 'd'].map(forte), [true, true, false, false]);
});

test('sobeJuntoNaEntrada: só com a cauda ligada e só de capacidade que já está no system', () => {
  assert.deepEqual(sobeJuntoNaEntrada({ cauda: true, capacidades: CAPS, carregados: ['okapp'] }), ['okapp/tool/ler']);
  assert.deepEqual(sobeJuntoNaEntrada({ cauda: false, capacidades: CAPS, carregados: ['okapp'] }), []);
  assert.deepEqual(sobeJuntoNaEntrada({ cauda: true, capacidades: CAPS, carregados: undefined }), []);
});

test('protecaoDoDespejo: o loop do Jev e as acompanhantes DESSAS refs protegem; o pino da fixa em `hydrate` não', () => {
  const marcadosBrutos = { capacidades: ['okapp', 'gcal'], funcoes: [] };
  // O Jev usou `salvar`: o `validar` (acompanha) e o `mostrar` (view auto) vão junto, então `okapp` fica.
  const doLoop = protecaoDoDespejo({ marcadosBrutos, refsDoLoop: ['okapp/tool/salvar'], capacidades: CAPS, hidratadas: [], sinalForte: NENHUM_SINAL });
  assert.deepEqual(doLoop.marcados.capacidades, ['gcal']);
  assert.deepEqual(doLoop.protegidasPeloLoop, ['okapp']);
  assert.deepEqual([...doLoop.doLoop].sort(), ['okapp/tool/mostrar', 'okapp/tool/salvar', 'okapp/tool/validar']);
  assert.deepEqual([...doLoop.capsDoLoop], ['okapp']);
  // O pino da fixa (`tools.hydrate` traz `okapp/tool/ler` todo turno) NÃO conta como "do loop" (R4).
  const soPino = protecaoDoDespejo({ marcadosBrutos, refsDoLoop: [], capacidades: CAPS, hidratadas: ['okapp/tool/ler'], sinalForte: NENHUM_SINAL });
  assert.deepEqual(soPino.marcados.capacidades, ['okapp', 'gcal']);
  assert.deepEqual(soPino.protegidasPeloLoop, []);
});

test('protecaoDoDespejo: sinal forte agora protege a capacidade; capacidade protegida por sinal não é "protegida pelo loop"', () => {
  const marcadosBrutos = { capacidades: ['okapp', 'gcal'], funcoes: [] };
  const r = protecaoDoDespejo({ marcadosBrutos, refsDoLoop: ['okapp/tool/salvar'], capacidades: CAPS, sinalForte: (id) => id === 'okapp' });
  assert.deepEqual(r.marcados.capacidades, ['gcal']);
  assert.deepEqual(r.protegidasPeloLoop, [], 'okapp teria sido salva pelo sinal de qualquer forma');
});

test('protecaoDoDespejo: função marcada sai, salvo se é do loop ou foi hidratada agora com sinal forte (e não é fixa)', () => {
  const marcadosBrutos = { capacidades: [], funcoes: ['okapp/tool/salvar', 'okapp/tool/validar', 'okapp/tool/ler', 'gcal/tool/ver'] };
  const r = protecaoDoDespejo({
    marcadosBrutos, refsDoLoop: ['gcal/tool/ver'], capacidades: CAPS,
    hidratadas: ['okapp/tool/salvar', 'okapp/tool/ler'], sinalForte: (id) => id === 'okapp',
  });
  // `salvar`: hidratada agora e okapp com sinal forte -> fica. `ler`: fixa, o pino não conta -> sai. `ver`: do loop -> fica.
  assert.deepEqual(r.marcados.funcoes, ['okapp/tool/validar', 'okapp/tool/ler']);
});

test('ehContinuacaoCurta: só com a cauda ligada e com algum dos três sinais', () => {
  const base = { cauda: true, trivial: false, continuidade: false, pista: false };
  assert.equal(ehContinuacaoCurta(base), false);
  assert.equal(ehContinuacaoCurta({ ...base, trivial: true }), true);
  assert.equal(ehContinuacaoCurta({ ...base, continuidade: true }), true);
  assert.equal(ehContinuacaoCurta({ ...base, pista: true }), true);
  assert.equal(ehContinuacaoCurta({ ...base, cauda: false, trivial: true }), false);
});

test('caudaDoTurnoComHerdada: herda a cauda anterior só em continuação curta', () => {
  const estadoDoDespejo = { ...estadoDespejoVazio(), caudaAnterior: [{ id: 'gcal', descricao: 'd', funcoes: [{ ref: 'gcal/tool/ver', nome: 'gcal__ver', indice: 'i', manual: 'M' }] }] };
  const system = { capacidades: [] };
  const sem = caudaDoTurnoComHerdada({ continuacaoCurta: false, estadoDoDespejo, propria: [], system });
  assert.deepEqual(sem, { cauda: [], herdadas: [] });
  const com = caudaDoTurnoComHerdada({ continuacaoCurta: true, estadoDoDespejo, propria: [], system });
  assert.deepEqual(com.herdadas, ['gcal/tool/ver']);
});

test('usadasDoTurno: executado pelo modelo + carregado por load_capability, sem repetir', () => {
  const nomeParaRef = new Map([['okapp__ler', 'okapp/tool/ler'], ['okapp__salvar', 'okapp/tool/salvar']]);
  const r = usadasDoTurno({
    operacoes: [{ nome: 'okapp__ler', ok: true }, { nome: 'okapp__salvar', ok: true, origem: 'jev' }, { nome: 'okapp__salvar', ok: false }],
    recusadas: new Set(), nomeParaRef,
    carregadasPeloModelo: [{ ref: 'okapp/tool/ler', capId: 'okapp' }, { ref: 'gcal/tool/ver', capId: 'gcal' }],
  });
  assert.deepEqual(r.usadas, [{ ref: 'okapp/tool/ler', capId: 'okapp' }, { ref: 'gcal/tool/ver', capId: 'gcal' }]);
  assert.deepEqual([...r.usadasRefs], ['okapp/tool/ler', 'gcal/tool/ver']);
  assert.deepEqual([...r.usadasCaps], ['okapp', 'gcal']);
});

// ---- fecharTurnoDoDespejo -----------------------------------------------------------------------------------------
const fn = (ref, manual) => ({ ref, nome: ref.replace('/tool/', '__'), ...(manual ? { manual: 'M' } : {}) });
const KAIROS = { loadedProviders: ['agenda'], hydratedTools: [], recentUse: [], lastUsedTurn: {} };
const FECHO_BASE = {
  kairos: KAIROS, estadoDoDespejo: estadoDespejoVazio(), system: { capacidades: [{ id: 'agenda', funcoes: [fn('agenda/tool/agir', true)] }] },
  systemEnviado: 'SYS', cauda: [], caudaDoTurno: [], cortadasPorSinal: [], despejadas: { capacidades: [], funcoes: [] },
  usadas: [], providersDoModelo: new Set(), capacidades: CAPS, caudaLigada: true, m: 2, turno: 4,
};

test('fecharTurnoDoDespejo: o usado fora do system é promovido (com o sobe junto) e ganha item com o turno atual', () => {
  const cauda = [{ id: 'okapp', funcoes: [fn('okapp/tool/salvar', true), fn('okapp/tool/ler', true)] }];
  const r = fecharTurnoDoDespejo({ ...FECHO_BASE, cauda, caudaDoTurno: cauda, usadas: [{ ref: 'okapp/tool/salvar', capId: 'okapp' }] });
  assert.deepEqual(r.kairos.loadedProviders, ['agenda', 'okapp']);
  // usada (salvar) + fixa (ler) + acompanhante da usada (validar); a `ler` da cauda não usada sai do alinhamento mas volta como fixa que sobe junto.
  assert.deepEqual([...r.kairos.hydratedTools].sort(), ['okapp/tool/ler', 'okapp/tool/salvar', 'okapp/tool/validar']);
  assert.deepEqual(r.sobeJunto.sort(), ['okapp/tool/ler', 'okapp/tool/validar']);
  assert.deepEqual(r.estadoDoDespejo.itens['okapp/tool/salvar'], { tipo: 'funcao', capId: 'okapp', entrouEm: 4, ultimoUso: 4 });
  assert.deepEqual(r.estadoDoDespejo.itens.okapp, { tipo: 'capacidade', capId: 'okapp', entrouEm: 4, ultimoUso: 4 });
  assert.equal(r.estadoDoDespejo.systemEnviado, 'SYS');
  assert.deepEqual(r.estadoDoDespejo.caudaAnterior.map((c) => [c.id, c.funcoes.map((f) => f.ref)]), [['okapp', ['okapp/tool/ler']]], 'a cauda não usada vale por mais um turno');
});

test('fecharTurnoDoDespejo: cauda ligada = false não sobe junto', () => {
  const r = fecharTurnoDoDespejo({ ...FECHO_BASE, caudaLigada: false, usadas: [{ ref: 'okapp/tool/salvar', capId: 'okapp' }] });
  assert.deepEqual(r.sobeJunto, []);
  assert.deepEqual(r.kairos.hydratedTools, ['okapp/tool/salvar']);
});

test('fecharTurnoDoDespejo: cauda sem uso sai do Kairos; a herdada sem uso não soma, mas mantém a contagem que tinha', () => {
  const propria = [{ id: 'gcal', funcoes: [fn('gcal/tool/ver', true)] }];
  const herdada = { id: 'okapp', funcoes: [fn('okapp/tool/salvar', true)] };
  const estado = { ...estadoDespejoVazio(), caudaSemUso: { okapp: 1, gcal: 0 } };
  const kairos = { ...KAIROS, loadedProviders: ['agenda', 'gcal'], hydratedTools: ['gcal/tool/ver'] };
  const r = fecharTurnoDoDespejo({ ...FECHO_BASE, kairos, estadoDoDespejo: estado, cauda: propria, caudaDoTurno: [...propria, herdada] });
  assert.deepEqual(r.kairos.loadedProviders, ['agenda'], 'gcal só estava na cauda e ninguém usou');
  assert.deepEqual(r.kairos.hydratedTools, []);
  assert.equal(r.estadoDoDespejo.caudaSemUso.gcal, 1, 'a própria soma');
  assert.equal(r.estadoDoDespejo.caudaSemUso.okapp, 1, 'a herdada mantém (não soma, não zera)');
});

test('fecharTurnoDoDespejo: o que o despejo tirou sai do Kairos, salvo o que o modelo carregou de volta no turno', () => {
  const kairos = { ...KAIROS, loadedProviders: ['agenda', 'okapp', 'gcal'], hydratedTools: ['okapp/tool/salvar', 'gcal/tool/ver'] };
  const r = fecharTurnoDoDespejo({
    ...FECHO_BASE, kairos, despejadas: { capacidades: ['okapp', 'gcal'], funcoes: [] }, providersDoModelo: new Set(['gcal']),
  });
  assert.deepEqual(r.kairos.loadedProviders, ['agenda', 'gcal']);
  assert.deepEqual(r.kairos.hydratedTools, ['gcal/tool/ver']);
});

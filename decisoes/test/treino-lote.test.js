import test from 'node:test';
import assert from 'node:assert/strict';
import { atualizarPorLote as atualizarPorLoteReal } from '../treino/lib/lote.js';
// Os cenários têm 12–24 casos de avaliação: o padrão de produção (minAvaliacao 30) os rejeitaria como `poucos-recentes`. Aqui o padrão do
// TESTE é 1; os testes do portão passam `minAvaliacao` explícito (e o que testa o padrão de produção usa `atualizarPorLoteReal`).
const atualizarPorLote = (args) => atualizarPorLoteReal({ minAvaliacao: 1, ...args });
import { montarIndice, consultaCentrada, treinarCabeca, novaCabeca, pontuarCabeca } from '../src/local/index.js';
import { embedderTabela } from './helpers/fixtures.js';

// Cinco capacidades, uma por eixo. Pedidos do grupo A parecem "agenda" (n0) mas a capacidade usada é n4; os do
// grupo B parecem n4 mas a usada é n2 — a ordem da base erra os dois, a cabeça aprende o mapeamento do dono.
const eixo = (k) => Array.from({ length: 5 }, (_, i) => (i === k ? 1 : 0));
const TABELA = {};
const capacidades = [0, 1, 2, 3, 4].map((k) => {
  TABELA[`n${k}-texto`] = eixo(k); TABELA[`n${k}-ex`] = eixo(k).map((x, i) => (i === (k + 1) % 5 ? 0.05 : x));
  return { id: `n${k}`, semanticText: `n${k}-texto`, tools: [{ name: 'f', exemplos: [`n${k}-ex`] }] };
});
// Variante para o anel tool: duas tools por capacidade (o domínio de treino/avaliação precisa de >= 4 candidatos).
const TABELA_TOOL = {};
const capacidadesTool = [0, 1, 2, 3, 4].map((k) => {
  for (const f of ['f', 'g']) { TABELA_TOOL[`n${k}-${f}-texto`] = eixo(k).map((x, i) => (i === (k + (f === 'g' ? 2 : 0)) % 5 ? 1 : x * 0.5)); }
  return { id: `n${k}`, tools: ['f', 'g'].map((f) => ({ name: f, semanticText: `n${k}-${f}-texto`, exemplos: [] })) };
});
const ruido = (n) => [0.03 * ((n * 7) % 5), 0.03 * ((n * 3) % 5), 0.03 * ((n * 11) % 5), 0.03 * ((n * 5) % 5), 0.03 * ((n * 13) % 5)];
const consulta = (base, n) => base.map((x, i) => x + ruido(n)[i]);
const QA = [1, 0.3, 0.2, 0.1, 0]; const QB = [0, 0.1, 0.2, 0.3, 1];
// treino: avaliacao false; avaliação: true e com outros índices de ruído (disjuntos do treino)
const caso = (v, cap, extra = {}) => ({ vetores: [v], usadas: { capacidades: [cap], funcoes: [] }, pedidasPelaLlm: [], avaliacao: false, ...extra });
const grupo = (q, cap, n, { avaliacao = false, de = 0 } = {}) => Array.from({ length: n }, (_, i) => caso(consulta(q, de + i), cap, { avaliacao }));

async function indiceDe(caps = capacidades, tabela = TABELA, anel = 'provider') {
  const ind = await montarIndice({ anel, capacidades: caps, embedder: embedderTabela(tabela) });
  assert.equal(ind.ok, true);
  return ind;
}
const refsDe = (indice) => [...indice.nos.keys()];
const paraTreino = (indice, casos) => casos.map((c) => ({ s: consultaCentrada(indice, c.vetores)[0], pos: new Set(c.usadas.capacidades.map((x) => refsDe(indice).indexOf(x))) }));
const brutaDe = (c) => ({ v: c.vetores[0].map((x) => Math.round(x * 1e5) / 1e5), rotulos: c.usadas.capacidades });

/** acerto@1 do rótulo de cada caso com a cabeça dada (média). */
function acerto(indice, cabeca, casos) {
  const refs = refsDe(indice);
  let t = 0;
  for (const c of casos) {
    const s = consultaCentrada(indice, c.vetores)[0];
    const top = refs.map((r) => [r, pontuarCabeca(cabeca, s, indice.nos.get(r).centroide)]).sort((a, b) => b[1] - a[1]).slice(0, 1).map((x) => x[0]);
    t += c.usadas.capacidades.filter((x) => top.includes(x)).length / c.usadas.capacidades.length;
  }
  return t / casos.length;
}
const comoCabeca = (a) => ({ d: a.d, posto: a.posto, U: a.U, V: a.V, alfa: a.alfa, beta: a.beta });

async function cenario() {
  const indice = await indiceDe();
  const A = grupo(QA, 'n4', 24); const B = grupo(QB, 'n2', 24);
  const Aav = grupo(QA, 'n4', 12, { avaliacao: true, de: 100 }); const Bav = grupo(QB, 'n2', 12, { avaliacao: true, de: 100 });
  const { cabeca } = treinarCabeca({ casos: paraTreino(indice, A), P: [...indice.nos.values()].map((n) => n.centroide), epocas: 150, lr: 0.5, seed: 3, posto: 4 });
  const reposicao = A.map(brutaDe);
  const atual = { cabeca, anelAprovado: false, metricasAnel: null };
  return { indice, A, B, Aav, Bav, atual, reposicao };
}

test('(a) lote com casos B melhora o acerto nos B de AVALIAÇÃO sem zerar o A, porque a reposição tem A', async () => {
  const { indice, A, B, Aav, Bav, atual, reposicao } = await cenario();
  const antesB = acerto(indice, atual.cabeca, Bav);
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 150, lr: 0.5, seed: 1, minAvaliacao: 5 });
  assert.equal(r.ok, true, r.motivo);
  const nova = comoCabeca(r.arquivo);
  assert.ok(acerto(indice, nova, Bav) > antesB, `B (avaliação) não melhorou (${antesB} -> ${acerto(indice, nova, Bav)})`);
  assert.ok(acerto(indice, nova, Aav) >= 0.9, `esqueceu o A: ${acerto(indice, nova, Aav)}`);
  assert.equal(r.arquivo.anel, 'provider');
  assert.ok('base' in r.arquivo.metricas.n2 && 'nova' in r.arquivo.metricas.n2 && 'atual' in r.arquivo.metricas.n2 && !('portao' in r.arquivo.metricas.n2), 'métricas por capacidade informativas; o portão é do anel');
  // v2: portão POR ANEL. A base erra o n4 (A parece n0) e acerta o n2 (B parece n4, mas n2 está no top-3): no anel inteiro a cabeça nova ganha.
  assert.equal(r.arquivo.versao, 2);
  assert.equal('aprovadas' in r.arquivo, false); assert.equal('cortes' in r.arquivo, false); assert.equal('cortesOrigem' in r.arquivo, false);
  assert.equal(r.arquivo.anelAprovado, true);
  assert.equal(r.arquivo.portao, 'aprovada');
  assert.equal(r.arquivo.metricasAnel.n, 24);
  assert.ok(r.arquivo.metricasAnel.cabeca > r.arquivo.metricasAnel.base, JSON.stringify(r.arquivo.metricasAnel));
  assert.deepEqual(r.resumo.metricasAnel, r.arquivo.metricasAnel);
  assert.equal(r.resumo.anelAprovado, true); assert.equal(r.resumo.portao, 'aprovada');
});

test('treino só com casos SEM avaliação; recentes só os COM avaliação (disjuntos)', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  let recebido;
  const espiao = async (a) => { recebido = a; return treinarCabeca(a); };
  const misturados = [...B, ...Bav.slice(0, 4)]; // 4 de avaliação entre os "novos": não podem treinar
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: misturados, reposicao, amostraReposicao: 10, recentes: [...Aav, ...Bav, ...B.slice(0, 5)], epocas: 3, minAvaliacao: 5, treinarCabecaFn: espiao });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(recebido.casos.length, B.length + 10);
  assert.equal(r.resumo.casosNovos, B.length);
  assert.equal(r.resumo.avaliacao, Aav.length + Bav.length); // os 5 sem flag nos "recentes" não contam
});

test('(b) lote que piora nos casos de avaliação é recusado: piorou-frente-a-atual (rejeição, mantida, consome os casos)', async () => {
  const { indice, A, Aav, atual, reposicao } = await cenario();
  const ruim = async () => ({ cabeca: novaCabeca({ d: indice.dim, posto: atual.cabeca.posto, seed: 99 }) });
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: A.slice(0, 3), reposicao, recentes: Aav, treinarCabecaFn: ruim });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'piorou-frente-a-atual');
  assert.equal(r.rejeicao, true); assert.equal(r.mantida, true);
  assert.ok(r.resumo.diagnostico.emUso.r3Nova < r.resumo.diagnostico.emUso.r3Recalculado, 'o diagnóstico mostra nova × atual nos mesmos casos');
  assert.equal(r.resumo.diagnostico.emUso.comparou, 12);
});

test('(c) ref fora do índice é descartada e contada', async () => {
  const { indice, Aav, B, atual, reposicao } = await cenario();
  const fantasma = [caso(consulta(QB, 50), 'fantasma'), { ...caso(consulta(QB, 51), 'n2'), usadas: { capacidades: ['n2', 'sumiu'], funcoes: [] } }];
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: [...B.slice(0, 6), ...fantasma], reposicao: [...reposicao, { v: reposicao[0].v, rotulos: ['n4', 'outra-sumida'] }], recentes: Aav, epocas: 20 });
  assert.equal(r.resumo.refsDescartadas, 3);
});

test('(d) cortesSugeridos: null com poucos positivos nos casos de avaliação; recalculado (p10/p98 da cabeça nova) com suficientes; o arquivo não tem `cortes`', async () => {
  const { indice, Aav, Bav, B, atual, reposicao } = await cenario();
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Aav.slice(0, 5), epocas: 100, minPositivosCortes: 20 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.arquivo.cortesSugeridos, null);
  assert.equal('cortes' in r.arquivo, false);
  const r2 = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 100, minPositivosCortes: 20 });
  assert.equal(r2.ok, true, r2.motivo);
  assert.ok(Number.isFinite(r2.arquivo.cortesSugeridos.full) && r2.arquivo.cortesSugeridos.candidate <= r2.arquivo.cortesSugeridos.full);
});

test('(e) divergência do treino devolve ok:false com o motivo', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  const diverge = async () => { throw new Error('treino no worker: treino-divergiu: perda NaN'); };
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, treinarCabecaFn: diverge });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /^treino-divergiu/);
  const naoFinita = async () => ({ cabeca: { ...atual.cabeca, alfa: NaN } });
  assert.equal((await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, treinarCabecaFn: naoFinita })).ok, false);
});

test('a atual recebida não é mutada; o treino parte dela (inicial + posto) com lr padrão 0.1, configurável', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  const copia = JSON.stringify(atual.cabeca);
  const recebidos = [];
  const espiao = async (a) => { recebidos.push(a); return treinarCabeca(a); };
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, epocas: 5, treinarCabecaFn: espiao });
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, epocas: 5, lr: 0.3, treinarCabecaFn: espiao });
  assert.equal(JSON.stringify(atual.cabeca), copia);
  assert.equal(recebidos[0].inicial, atual.cabeca);
  assert.equal(recebidos[0].posto, atual.cabeca.posto);
  assert.equal(recebidos[0].lr, 0.1);
  assert.equal(recebidos[1].lr, 0.3);
});

test('sem nenhum caso de avaliação avaliável: sem-recentes e nada treina', async () => {
  const { indice, A, B, atual, reposicao } = await cenario();
  let treinou = false;
  const espiao = async (a) => { treinou = true; return treinarCabeca(a); };
  for (const recentes of [[], A.slice(0, 5), [caso([1, 0, 0, 0, 0], 'fantasma', { avaliacao: true })]]) {
    const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes, treinarCabecaFn: espiao });
    assert.deepEqual([r.ok, r.motivo], [false, 'sem-recentes']);
  }
  assert.equal(treinou, false);
});

test('portão por anel (sem herança): poucos casos de avaliação = sem veredito → a em uso continua (adiada, nada treina, nada consumido); ganhar da base grava aprovada; não ganhar grava com o anel na base', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const rec = [...Aav, ...Bav];
  let treinou = 0;
  const espiao = async (a) => { treinou++; return treinarCabeca(a); };
  const roda = (extra, atualX = atual) => atualizarPorLote({ anel: 'provider', indice, atual: atualX, casosNovos: B, reposicao, recentes: rec, epocas: 100, lr: 0.5, treinarCabecaFn: espiao, ...extra });
  const avaliada = { ...atual, anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.9, n: 80 } };
  // 24 casos < 100: não há veredito. A versão em uso (aprovada e avaliada) CONTINUA — a nova nem é treinada, nada é gravado, os casos são consumidos
  const semVeredito = await roda({ minAvaliacao: 100 }, avaliada);
  assert.deepEqual([semVeredito.ok, semVeredito.motivo, semVeredito.adiada, semVeredito.rejeicao, semVeredito.mantida], [false, 'poucos-recentes', true, undefined, undefined], 'adiamento: o chamador NÃO consome os casos');
  assert.equal(treinou, 0, 'decidido ANTES de gastar o treino');
  assert.equal(semVeredito.arquivo, undefined);
  assert.equal(semVeredito.resumo.diagnostico.n, 24); assert.equal(semVeredito.resumo.diagnostico.minAvaliacao, 100);
  assert.equal((await roda({ minAvaliacao: 100 })).motivo, 'poucos-recentes', 'não herda nem a aprovação de v1 (sem metricasAnel): o lote só roda com versão em uso e ela continua');
  // casos suficientes: ganhar da base decide
  const ganhou = await roda({ minAvaliacao: 24 });
  assert.equal(ganhou.ok, true, ganhou.motivo);
  assert.equal(ganhou.arquivo.anelAprovado, true); assert.equal(ganhou.arquivo.portao, 'aprovada');
  assert.equal(treinou, 1);
  // não ganhar da base NÃO é rejeição: grava a versão com o anel na base
  const exigente = await roda({ minAvaliacao: 5, margem: 2 }, avaliada);
  assert.equal(exigente.ok, true, 'a versão nova vale como ponto de partida do próximo lote');
  assert.equal(exigente.arquivo.anelAprovado, false); assert.equal(exigente.arquivo.portao, 'nao-ganhou');
});

test('portão por anel: piorar frente à versão em uso (nos MESMOS casos, além da tolerância) é rejeição; empate e ruído de outra amostra não', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const rec = [...Aav, ...Bav];
  const roda = (extra, atualX = atual) => atualizarPorLote({ anel: 'provider', indice, atual: atualX, casosNovos: B, reposicao, recentes: rec, epocas: 100, lr: 0.5, minAvaliacao: 5, ...extra });
  const avaliada = { ...atual, anelAprovado: true, metricasAnel: { base: 0.4, cabeca: 0.9, n: 80 } };
  // tolerância impossível de cumprir (nova >= atual + 1): é piorou → rejeição, não grava
  const piorou = await roda({ tolerancia: -1 }, avaliada);
  assert.deepEqual([piorou.ok, piorou.motivo, piorou.rejeicao, piorou.mantida], [false, 'piorou-frente-a-atual', true, true]);
  assert.equal(piorou.arquivo, undefined);
  // a MESMA cabeça (pesos idênticos) com um número gravado absurdo (outra amostra): a régua é recalculada nos mesmos casos → empate, não rejeita
  const identica = async (a) => ({ cabeca: JSON.parse(JSON.stringify(a.inicial)) });
  const ruido = await roda({ treinarCabecaFn: identica }, { ...atual, anelAprovado: true, metricasAnel: { base: 0.1, cabeca: 5, n: 99 } });
  assert.equal(ruido.ok, true, ruido.motivo);
  assert.equal(ruido.arquivo.portao === 'piorou-frente-a-atual', false);
  assert.equal(ruido.resumo.diagnostico.emUso.r3Gravado, 5, 'o gravado é só diagnóstico');
  assert.equal(ruido.resumo.diagnostico.emUso.r3Nova, ruido.resumo.diagnostico.emUso.r3Recalculado);
  // um número gravado ALTO demais (de outra amostra) não derruba uma versão nova melhor
  const gravadoAlto = await roda({}, { ...atual, anelAprovado: true, metricasAnel: { base: 0.1, cabeca: 5, n: 99 } });
  assert.equal(gravadoAlto.ok, true, gravadoAlto.motivo);
  assert.equal(gravadoAlto.arquivo.anelAprovado, true); assert.equal(gravadoAlto.arquivo.portao, 'aprovada');
  // piora de até a tolerância (0,02) é empate: nova com R@3 a 0,01 da atual passa (fronteira)
  const { avaliarPortaoAnel } = await import('../treino/lib/dominio.js');
  assert.equal(avaliarPortaoAnel({ r3Cabeca: 0.6, r3Base: 0.4, nAvaliacao: 50, emUso: { r3Atual: 0.62, r3Nova: 0.6 } }).acao, 'gravar');
  assert.equal(avaliarPortaoAnel({ r3Cabeca: 0.6, r3Base: 0.4, nAvaliacao: 50, emUso: { r3Atual: 0.63, r3Nova: 0.6 } }).acao, 'mantida');
  // sem casos a julgar (todos já ativos) continua rejeitando antes de treinar
  const ruim = async () => ({ cabeca: novaCabeca({ d: indice.dim, posto: atual.cabeca.posto, seed: 99 }) });
  const rej = await roda({ treinarCabecaFn: ruim, casosNovos: B.slice(0, 3) }, avaliada);
  assert.deepEqual([rej.ok, rej.motivo, rej.rejeicao, rej.mantida], [false, 'piorou-frente-a-atual', true, true]);
});

test('diagnóstico do lote: n/minAvaliacao, funil da avaliação e pareado cabeça × base por caso', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const r = await atualizarPorLote({ anel: 'provider', indice, atual: { ...atual, versao: 3, metricasAnel: { base: 0.4, cabeca: 0.7, n: 50 } }, casosNovos: B, reposicao, recentes: [...Aav, ...Bav, ...B.slice(0, 5)], epocas: 100, lr: 0.5, minAvaliacao: 5 });
  assert.equal(r.ok, true, r.motivo);
  const d = r.resumo.diagnostico;
  assert.deepEqual([d.n, d.minAvaliacao], [24, 5]);
  assert.deepEqual(d.funil['registro-avaliacao'], { brutos: 24, semDominio: 0, semAlvo: 0, jaAtivos: 0, poucosCandidatos: 0, julgados: 24 });
  assert.equal(d.funil.log.brutos, 0); assert.equal(d.funil['registro-treino'].brutos, 0);
  assert.equal(d.pareado.cabecaVenceu + d.pareado.baseVenceu + d.pareado.empate, 24);
  assert.ok(d.pareado.cabecaVenceu > d.pareado.baseVenceu, JSON.stringify(d.pareado));
  assert.deepEqual([d.emUso.versao, d.emUso.r3Gravado, d.emUso.comparou], [3, 0.7, 24]);
  // funil com casos que não são julgados: já ativos, sem domínio/alvo
  const ativas = Aav.map((c) => ({ ...c, ativasNoInicio: ['n4'] }));
  const r2 = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...ativas, ...Bav, caso(consulta(QB, 700), 'fantasma', { avaliacao: true })], epocas: 2, minAvaliacao: 5 });
  const f = r2.resumo.diagnostico.funil['registro-avaliacao'];
  assert.deepEqual([f.brutos, f.jaAtivos, f.julgados, f.semAlvo], [25, 12, 12, 1]);
  assert.equal(f.brutos, f.semDominio + f.semAlvo + f.jaAtivos + f.poucosCandidatos + f.julgados);
});

test('N2: versão em uso SEM avaliação gravada (v1, metricasAnel nulo) que perde da base nos mesmos casos não serve de régua no lote: a nova é julgada só contra a base; a avaliada (v2) e a v1 que vence a base seguem sendo régua', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  const P = [...indice.nos.values()].map((n) => n.centroide);
  const { cabeca: boa } = treinarCabeca({ casos: paraTreino(indice, B), P, epocas: 150, lr: 0.5, seed: 3, posto: 4 }); // acerta o n2 dos B
  const ruim = { ...comoCabeca(boa), alfa: -Math.abs(boa.alfa) - 5 }; // ranking invertido: o alvo fica por último → perde da base (que acerta os B)
  const idem = (c) => async () => ({ cabeca: JSON.parse(JSON.stringify(c)) });
  const roda = (atualX, extra = {}) => atualizarPorLote({ anel: 'provider', indice, atual: atualX, casosNovos: [], reposicao, recentes: Bav, epocas: 1, minAvaliacao: 5, tolerancia: -1, ...extra }); // tolerância impossível: toda régua válida rejeita
  // v1 que PERDE da base: descartada → a nova (idêntica à ruim) é julgada só contra a base → nao-ganhou → GRAVA com o anel na base (não é mantida)
  const v1Ruim = await roda({ ...atual, cabeca: ruim, anelAprovado: true, metricasAnel: null }, { treinarCabecaFn: idem(ruim), casosNovos: B.slice(0, 3), margem: 0 });
  assert.equal(v1Ruim.ok, true, v1Ruim.motivo);
  const d = v1Ruim.resumo.diagnostico.emUso;
  assert.equal(d.descartada, 'perde-da-base');
  assert.ok(d.r3Recalculado < d.r3BaseNosMesmos, `${d.r3Recalculado} < ${d.r3BaseNosMesmos}`);
  assert.deepEqual([v1Ruim.arquivo.anelAprovado, v1Ruim.arquivo.portao], [false, 'nao-ganhou']);
  // a MESMA cabeça ruim com versão AVALIADA (metricasAnel presente): foi julgada pelo portão dela e segue como régua → piorou (tolerância impossível) → rejeição
  const v2Ruim = await roda({ ...atual, cabeca: ruim, anelAprovado: false, metricasAnel: { base: 0.9, cabeca: 0.1, n: 80 } }, { treinarCabecaFn: idem(ruim), casosNovos: B.slice(0, 3), margem: 0 });
  assert.deepEqual([v2Ruim.ok, v2Ruim.motivo, v2Ruim.rejeicao, v2Ruim.mantida], [false, 'piorou-frente-a-atual', true, true]);
  assert.equal(v2Ruim.resumo.diagnostico.emUso.descartada, undefined);
  // v1 que VENCE (empata com) a base: segue como régua → rejeição
  const v1Boa = await roda({ ...atual, cabeca: comoCabeca(boa), anelAprovado: true, metricasAnel: null }, { treinarCabecaFn: idem(comoCabeca(boa)), casosNovos: B.slice(0, 3) });
  assert.deepEqual([v1Boa.ok, v1Boa.motivo, v1Boa.mantida], [false, 'piorou-frente-a-atual', true]);
  assert.equal(v1Boa.resumo.diagnostico.emUso.descartada, undefined);
});

test('nTreinoPorCapacidade é ACUMULADO: o da versão em uso + os positivos NOVOS do lote (a reposição não conta); sem o campo parte de zero', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  const r = await atualizarPorLote({ anel: 'provider', indice, atual: { ...atual, nTreinoPorCapacidade: { n2: 100, n4: 7, antiga: 3 } }, casosNovos: B, reposicao, recentes: Bav, epocas: 2 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.arquivo.nTreinoPorCapacidade.n2, 100 + B.length, 'n2: 100 anteriores + 24 novos');
  assert.equal(r.arquivo.nTreinoPorCapacidade.n4, 7, 'n4: a reposição (que tem n4) não soma');
  assert.equal(r.arquivo.nTreinoPorCapacidade.n0, 0);
  assert.ok(!('antiga' in r.arquivo.nTreinoPorCapacidade), 'capacidade que saiu do índice sai');
  const sem = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, epocas: 2 });
  assert.equal(sem.arquivo.nTreinoPorCapacidade.n2, B.length);
});

test('ativasNoInicio (provider): a avaliação do lote conta só o que PRECISOU ENTRAR; caso com tudo já ativo não é julgado; todos assim → sem-recentes e nada treina; o treino não muda', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const comAtivas = (lista, ativas) => lista.map((c) => ({ ...c, ativasNoInicio: ativas }));
  const base = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5 });
  assert.equal(base.resumo.avaliacao, 24);
  // os 12 do A (usam n4) já tinham n4 ativa → fora; os 12 do B (usam n2) com n4 ativa → contam
  const filtrado = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...comAtivas(Aav, ['n4']), ...comAtivas(Bav, ['n4'])], epocas: 2, minAvaliacao: 5 });
  assert.equal(filtrado.ok, true, filtrado.motivo);
  assert.equal(filtrado.resumo.avaliacao, 12);
  assert.equal(filtrado.resumo.metricasAnel.n, 12);
  assert.equal(filtrado.arquivo.metricas.n4.nRecentes, 0, 'n4 nunca precisou entrar');
  assert.equal(filtrado.arquivo.metricas.n2.nRecentes, 12);
  // [] = capturado e nada ativo: conta como sempre
  const vazio = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...comAtivas(Aav, []), ...comAtivas(Bav, [])], epocas: 2, minAvaliacao: 5 });
  assert.equal(vazio.resumo.avaliacao, 24);
  // todos os casos com tudo já ativo: nada a julgar
  let treinou = false;
  const espiao = async (a) => { treinou = true; return treinarCabeca(a); };
  const nada = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...comAtivas(Aav, ['n4']), ...comAtivas(Bav, ['n2'])], epocas: 2, treinarCabecaFn: espiao });
  assert.deepEqual([nada.ok, nada.motivo, nada.adiada, nada.rejeicao], [false, 'sem-recentes', true, undefined], 'adiamento, não rejeição: o chamador não consome os casos');
  assert.equal(treinou, false);
  // o treino não muda com ativasNoInicio nos casos NOVOS
  const capA = []; const capB = [];
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: Bav, epocas: 1, seed: 3, treinarCabecaFn: async (a) => { capA.push(a); return treinarCabeca(a); } });
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: comAtivas(B, ['n2']), reposicao, recentes: Bav, epocas: 1, seed: 3, treinarCabecaFn: async (a) => { capB.push(a); return treinarCabeca(a); } });
  assert.deepEqual(capA[0].casos.map((c) => [...c.pos]), capB[0].casos.map((c) => [...c.pos]));
  assert.deepEqual(capA[0].casos.map((c) => c.s), capB[0].casos.map((c) => c.s));
});

test('embedder: casos e reposição com slug ou dim diferentes são descartados e contados', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  assert.ok(indice.slug);
  const outro = [{ ...B[0], slug: 'outro-modelo' }, { ...B[1], dim: 7 }, { ...B[2], slug: indice.slug, dim: 5 }];
  let recebido;
  const espiao = async (a) => { recebido = a; return treinarCabeca(a); };
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: outro, reposicao, recentes: [...Bav, { ...Bav[0], slug: 'outro-modelo' }], amostraReposicao: 1000, epocas: 2, treinarCabecaFn: espiao });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.embedderDiferente, 3); // 2 casos novos + 1 de avaliação
  assert.equal(r.resumo.casosNovos, 1);
  assert.equal(recebido.casos.length, 1 + reposicao.length);
  // reposição gerada por outro embedder: toda descartada
  const r2 = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, slugReposicao: 'outro-modelo', recentes: Bav, epocas: 2 });
  assert.equal(r2.resumo.embedderDiferente, reposicao.length);
  assert.equal(r2.resumo.reposicao, 0);
  // vetor da reposição com outra dimensão
  const r3 = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao: [...reposicao, { v: [1, 2], rotulos: ['n4'] }], recentes: Bav, epocas: 2 });
  assert.equal(r3.resumo.embedderDiferente, 1);
});

test('reposição crua é centrada com a média do índice ATUAL (índice com média diferente continua coerente)', async () => {
  const { indice: indice1, A, B, Bav, atual, reposicao } = await cenario();
  // outro catálogo (outros textos): a média do índice muda
  const caps2 = capacidades.map((c, k) => ({ ...c, semanticText: `m${k}-texto`, tools: [{ name: 'f', exemplos: [`m${k}-ex`] }] }));
  const tabela2 = {};
  for (let k = 0; k < 5; k++) { tabela2[`m${k}-texto`] = eixo(k).map((x) => x * 0.6 + 0.2); tabela2[`m${k}-ex`] = eixo(k).map((x) => x * 0.5 + 0.3); }
  const indice2 = await indiceDe(caps2, tabela2);
  assert.notDeepEqual(indice2.media, indice1.media);
  let recebido;
  const espiao = async (a) => { recebido = a; return treinarCabeca(a); };
  await atualizarPorLote({ anel: 'provider', indice: indice2, atual, casosNovos: [], reposicao: reposicao.slice(0, 6), amostraReposicao: 6, recentes: Bav, epocas: 1, treinarCabecaFn: espiao }).catch(() => {});
  // sem casos novos o treino usa só a reposição; as consultas vêm centradas pela média do índice 2
  const esperado = reposicao.slice(0, 6).map((r) => consultaCentrada(indice2, [r.v])[0]);
  const trocadas = recebido.casos.map((c) => c.s);
  for (const s of esperado) assert.ok(trocadas.some((t) => t.every((x, i) => Math.abs(x - s[i]) < 1e-12)), 'consulta não centrada com a média do índice atual');
  const centradaNoOutro = consultaCentrada(indice1, [reposicao[0].v])[0];
  assert.ok(!trocadas.some((t) => t.every((x, i) => Math.abs(x - centradaNoOutro[i]) < 1e-12)));
});

test('reservatório: a reposição atualizada recebe os casos novos sem passar do máximo, só vetor cru arredondado + rótulos', async () => {
  const { indice, B, Bav, atual, reposicao } = await cenario();
  const cheio = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, tamanhoReposicao: 30, recentes: Bav, epocas: 2, seed: 4 });
  assert.equal(cheio.ok, true, cheio.motivo);
  assert.equal(cheio.reposicao.length, 30);
  assert.equal(cheio.slugReposicao, indice.slug);
  assert.ok(cheio.reposicao.some((k) => k.rotulos.includes('n2')), 'nenhum caso novo entrou no reservatório');
  assert.ok(cheio.reposicao.some((k) => k.rotulos.includes('n4')), 'a reposição antiga sumiu inteira');
  const folgado = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, tamanhoReposicao: 1000, recentes: Bav, epocas: 2 });
  assert.equal(folgado.reposicao.length, reposicao.length + B.length);
  for (const k of folgado.reposicao) {
    assert.deepEqual(Object.keys(k).sort(), ['rotulos', 'v']);
    assert.ok(k.v.every((x) => Math.abs(x * 1e5 - Math.round(x * 1e5)) < 1e-6), 'não está arredondado a 5 casas');
  }
  // os de avaliação nunca entram na reposição
  const comAv = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: [...B.slice(0, 3), ...Bav], tamanhoReposicao: 1000, reposicao: [], recentes: Bav, epocas: 2 });
  assert.equal(comAv.reposicao.length, 3);
});

test('anel tool: domínio por capacidade (tools das usadas + 5 distratoras; com 5 capacidades no catálogo cobre tudo) e candidatos suficientes para o recall', async () => {
  const indice = await indiceDe(capacidadesTool, TABELA_TOOL, 'tool');
  const refs = refsDe(indice);
  assert.equal(refs.length, 10);
  const casoTool = (cap, n, avaliacao) => ({ vetores: [consulta(eixo(Number(cap[1])).map((x, i) => x * 0.9 + (i === (Number(cap[1]) + 1) % 5 ? 0.2 : 0)), n)], usadas: { capacidades: [cap], funcoes: [`${cap}/tool/f`] }, pedidasPelaLlm: [], avaliacao });
  const novos = ['n0', 'n1', 'n2', 'n3', 'n4'].flatMap((c, i) => Array.from({ length: 6 }, (_, n) => casoTool(c, i * 10 + n, false)));
  const aval = ['n0', 'n1', 'n2', 'n3', 'n4'].flatMap((c, i) => Array.from({ length: 4 }, (_, n) => casoTool(c, 200 + i * 10 + n, true)));
  const cabeca0 = novaCabeca({ d: indice.dim, posto: 4, seed: 2 });
  const atual = { cabeca: cabeca0, anelAprovado: false, metricasAnel: null };
  let recebido;
  const espiao = async (a) => { recebido = a; return treinarCabeca(a); };
  const r = await atualizarPorLote({ anel: 'tool', indice, atual, casosNovos: novos, reposicao: [], recentes: aval, epocas: 5, minAvaliacao: 2, treinarCabecaFn: espiao });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.arquivo.anel, 'tool');
  // domínio: sempre com o positivo; a usada + até 5 distratoras (spec 2026-10-07 §5.7) — com só 5 capacidades no catálogo são as 5 (10 tools).
  // A exclusão de capacidades além das 5 distratoras está no teste de `dominioDoCaso` (treino-treino.test.js).
  assert.equal(recebido.candidatosPorCaso.length, recebido.casos.length);
  recebido.casos.forEach((c, n) => {
    for (const j of c.pos) assert.ok(recebido.candidatosPorCaso[n].includes(j));
    assert.equal(recebido.candidatosPorCaso[n].length, 10);
    assert.equal(new Set(recebido.candidatosPorCaso[n].map((j) => refs[j].split('/tool/')[0])).size, 5);
  });
  // métricas (informativas) e nTreinoPorCapacidade são por CAPACIDADE (não por tool); o portão é do anel
  assert.deepEqual(Object.keys(r.arquivo.metricas).sort(), ['n0', 'n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(Object.keys(r.arquivo.nTreinoPorCapacidade).sort(), ['n0', 'n1', 'n2', 'n3', 'n4']);
  assert.equal(typeof r.arquivo.anelAprovado, 'boolean');
  assert.equal(r.resumo.avaliacao, 20);
  // MIN_CANDIDATOS_RECALL: com 3 capacidades de 1 tool o domínio tem 3 candidatos (< 4): nada é avaliável
  const indice1 = await indiceDe(capacidades.slice(0, 3).map((c) => ({ ...c, tools: [{ name: 'f', semanticText: `${c.id}-texto`, exemplos: [] }] })), TABELA, 'tool');
  const aval1 = ['n0', 'n1', 'n2'].flatMap((c, i) => Array.from({ length: 4 }, (_, n) => ({ vetores: [consulta(eixo(i), n)], usadas: { capacidades: [c], funcoes: [`${c}/tool/f`] }, avaliacao: true })));
  const atual1 = { cabeca: novaCabeca({ d: indice1.dim, posto: 4, seed: 2 }), anelAprovado: false, metricasAnel: null };
  const r1 = await atualizarPorLote({ anel: 'tool', indice: indice1, atual: atual1, casosNovos: [], reposicao: [], recentes: aval1, epocas: 2 });
  assert.deepEqual([r1.ok, r1.motivo], [false, 'sem-recentes']);
});

test('negativos fracos (carregou e não usou): meio peso e no máximo metade do lote, amostra determinística; vetores[0] é o do pedido', async () => {
  const { indice, A, B, Aav, Bav, atual, reposicao } = await cenario();
  const fracos = Array.from({ length: 100 }, (_, i) => caso(consulta(QA, 200 + i), 'x', { usadas: { capacidades: [], funcoes: [] }, carregadas: { provider: ['n0', 'n1'] } }));
  const captura = [];
  const espiao = async (a) => { captura.push(a); return treinarCabeca(a); };
  const rodar = () => atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: [...B, ...fracos], reposicao, recentes: [...Aav, ...Bav], epocas: 3, lr: 0.1, seed: 5, minAvaliacao: 5, treinarCabecaFn: espiao });
  const r = await rodar();
  assert.equal(r.ok, true, r.motivo);
  const { casos } = captura[0];
  const neg = casos.filter((c) => c.pos.size === 0); const pos = casos.filter((c) => c.pos.size > 0);
  assert.ok(neg.length > 0 && neg.length * 2 <= casos.length, `negativos ${neg.length} de ${casos.length}`);
  assert.ok(neg.every((c) => c.peso === 0.5));
  // M2: o negativo fraco pune só o que foi carregado e não usado (n0, n1 = índices 0 e 1), não o domínio inteiro
  const idx = captura[0].casos.map((c, i) => [c, i]).filter(([c]) => c.pos.size === 0).map(([, i]) => captura[0].candidatosPorCaso[i]);
  assert.ok(idx.length > 0 && idx.every((d) => d.length === 2 && d.includes(0) && d.includes(1)), JSON.stringify(idx[0]));
  assert.ok(pos.every((c) => (c.peso ?? 1) === 1));
  assert.equal(r.resumo.negativosFracos, 100);
  assert.equal(r.resumo.negativosFracosUsados, neg.length);
  // determinístico: mesma entrada, mesma amostra
  await rodar();
  assert.deepEqual(captura[1].casos.filter((c) => c.pos.size === 0).map((c) => c.s), neg.map((c) => c.s));
  // só fracos: sem positivo não há lote (nunca treina "não carregue nada")
  const soFracos = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: fracos, reposicao: [], recentes: [...Aav, ...Bav], epocas: 3, minAvaliacao: 5 });
  assert.equal(soFracos.ok, false);
  assert.equal(soFracos.motivo, 'sem-casos-de-treino');
  // vetores[0] é o do pedido: um segundo vetor (pista de contexto) não muda o treino
  const comPista = B.map((c) => ({ ...c, vetores: [c.vetores[0], [9, 9, 9, 9, 9]] }));
  const cap2 = [];
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: comPista, reposicao, recentes: [...Aav, ...Bav], epocas: 1, seed: 5, minAvaliacao: 5, treinarCabecaFn: async (a) => { cap2.push(a); return treinarCabeca(a); } });
  const cap3 = [];
  await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 1, seed: 5, minAvaliacao: 5, treinarCabecaFn: async (a) => { cap3.push(a); return treinarCabeca(a); } });
  assert.deepEqual(cap2[0].casos.map((c) => c.s), cap3[0].casos.map((c) => c.s));
});

test('timeout do worker de treino: encerra e rejeita com tempo-esgotado; o lote devolve o motivo', async () => {
  const { treinarCabecaNoWorker } = await import('../treino/lib/worker-treino.js');
  await assert.rejects(() => treinarCabecaNoWorker({ casos: [], P: [] }, { timeoutMs: 1 }), /tempo-esgotado/);
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 1, minAvaliacao: 5, treinarCabecaFn: async () => { throw new Error('tempo-esgotado: treino excedeu 1 ms'); } });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'tempo-esgotado');
});

test('piso (excluir): a capacidade nunca é rótulo nem candidato do lote; sem carregadas o fraco é descartado', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const comPiso = B.map((c) => ({ ...c, usadas: { capacidades: ['n3', 'n2'], funcoes: [] } })); // n3 = piso
  const capt = [];
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: comPiso, reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5, excluir: ['n3'], treinarCabecaFn: async (a) => { capt.push(a); return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(capt[0].P.length, 4, 'o piso sai do conjunto de candidatos');
  assert.ok(!('n3' in r.arquivo.metricas), 'e das métricas por capacidade');
  const refs = [...indice.nos.keys()].filter((x) => x !== 'n3');
  const posN2 = capt[0].casos.filter((c) => c.pos.has(refs.indexOf('n2'))).length;
  assert.ok(posN2 >= B.length, 'o rótulo n2 permanece');
  assert.ok(capt[0].casos.every((c) => c.pos.size <= 1), 'n3 não vira rótulo');
});

test('adiamento (sem veredito) e rejeição legítima são coisas diferentes: adiada não consome; rejeicao (piorou) consome; erro de verdade não é nenhuma das duas', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const sem = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [], epocas: 1 });
  assert.deepEqual([sem.ok, sem.motivo, sem.adiada, sem.rejeicao, sem.mantida], [false, 'sem-recentes', true, undefined, undefined]);
  const ruim = async () => ({ cabeca: novaCabeca({ d: indice.dim, posto: atual.cabeca.posto, seed: 99 }) });
  const piorou = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B.slice(0, 3), reposicao, recentes: Aav, treinarCabecaFn: ruim });
  assert.deepEqual([piorou.ok, piorou.motivo, piorou.rejeicao, piorou.mantida, piorou.adiada], [false, 'piorou-frente-a-atual', true, true, undefined]);
  const diverg = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 1, minAvaliacao: 5, treinarCabecaFn: async () => { throw new Error('treino-divergiu: x'); } });
  assert.equal(diverg.rejeicao, undefined);
});

test('C1: cargaJunto sai do domínio negativo do caso no anel tool (treino e avaliação); função de outra capacidade segue no domínio', async () => {
  const { montarIndice } = await import('../src/local/index.js');
  const indice = await indiceDe(capacidadesTool, TABELA_TOOL, 'tool');
  const refs = [...indice.nos.keys()];
  const P = refs.map((r) => indice.nos.get(r).centroide);
  const { cabeca } = treinarCabeca({ casos: [{ s: P[0], pos: new Set([0]) }], P, epocas: 3, lr: 0.5, seed: 1, posto: 4 });
  const atual = { cabeca, anelAprovado: false, metricasAnel: null };
  const mk = (n, avaliacao) => ({ vetores: [consulta(QA, n)], usadas: { capacidades: ['n0'], funcoes: ['n0/tool/f'] }, pedidasPelaLlm: [], avaliacao, carregadas: { tool: ['n0/tool/f', 'n0/tool/g', 'n1/tool/f'] } });
  const novos = Array.from({ length: 6 }, (_, i) => mk(i, false)); const aval = Array.from({ length: 6 }, (_, i) => mk(100 + i, true));
  const capt = [];
  const r = await atualizarPorLote({ anel: 'tool', indice, atual, casosNovos: novos, reposicao: [], recentes: aval, epocas: 1, minAvaliacao: 1, treinarCabecaFn: async (a) => { capt.push(a); return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  const iG = refs.indexOf('n0/tool/g'); const iF1 = refs.indexOf('n1/tool/f');
  assert.ok(capt[0].candidatosPorCaso.every((d) => !d.includes(iG)), 'n0/tool/g (carregada junto de n0 usada) fora do domínio negativo');
  assert.ok(capt[0].candidatosPorCaso.every((d) => d.includes(iF1)), 'n1/tool/f (capacidade não usada) continua candidata negativa');
});

test('I-A: o piso CONDICIONAL de um caso (caso.piso) exclui só aquele caso — a capacidade não some de porCapacidade nem de nTreinoPorCapacidade', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  // n4 é aprovada na atual; nos casos novos ela foi piso condicional do turno (carrega do agente): sai só desses casos
  const comPiso = B.map((c) => ({ ...c, piso: { ids: ['n4'], fixas: [] } }));
  const capt = [];
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: comPiso, reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5, treinarCabecaFn: async (a) => { capt.push(a); return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(capt[0].P.length, 5, 'n4 segue entre os candidatos do índice');
  assert.ok('n4' in r.arquivo.metricas && 'n4' in r.arquivo.nTreinoPorCapacidade, 'e segue nas métricas e no acumulado');
  const iN4 = [...indice.nos.keys()].indexOf('n4');
  assert.ok(capt[0].candidatosPorCaso.slice(0, B.length).every((d) => !d.includes(iN4)), 'mas fora do domínio daqueles casos (estava sempre carregada ali)');
  // piso INCONDICIONAL (excluir) sim sai do índice inteiro
  const r2 = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: B, reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5, excluir: ['n4'] });
  assert.ok(!('n4' in r2.arquivo.metricas));
});

test('I-C(a): caso com todos os rótulos descartados (ref que não existe mais) é incerto — pulado e contado, não vira negativo', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const sumido = Array.from({ length: 5 }, (_, i) => caso(consulta(QB, 300 + i), 'cap-que-sumiu', { carregadas: { provider: ['n0'] } }));
  const capt = [];
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: [...B, ...sumido], reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5, treinarCabecaFn: async (a) => { capt.push(a); return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.resumo.incertos, 5);
  assert.equal(r.resumo.negativosFracos, 0, 'nenhum virou negativo fraco');
  assert.ok(capt[0].casos.every((c) => c.pos.size > 0));
});

test('I-C(b): negativo fraco não pune a capacidade usada no turno (load_capability sem chamada de função): domínio = carregadas não usadas', async () => {
  const { indice, B, Aav, Bav, atual, reposicao } = await cenario();
  const fracos = Array.from({ length: 6 }, (_, i) => ({ vetores: [consulta(QA, 400 + i)], usadas: { capacidades: ['n0'], funcoes: [] }, pedidasPelaLlm: ['n0'], avaliacao: false, carregadas: { provider: ['n0', 'n1'] } }));
  const capt = [];
  const r = await atualizarPorLote({ anel: 'provider', indice, atual, casosNovos: [...B, ...fracos], reposicao, recentes: [...Aav, ...Bav], epocas: 2, minAvaliacao: 5, treinarCabecaFn: async (a) => { capt.push(a); return treinarCabeca(a); } });
  assert.equal(r.ok, true, r.motivo);
  // o rótulo n0 vem de usadas.capacidades (load_capability): para o provider isso É rótulo, não negativo
  const iN0 = [...indice.nos.keys()].indexOf('n0');
  const comN0 = capt[0].casos.filter((c) => c.pos.has(iN0));
  assert.ok(comN0.length >= 6, 'quem pediu n0 tem n0 como alvo');
  // tool: carregou n0/tool/f (capacidade usada, sem função) e n1/tool/f: só n1 é negativo fraco
  const ind = await indiceDe(capacidadesTool, TABELA_TOOL, 'tool');
  const refs = [...ind.nos.keys()];
  const P = refs.map((x) => ind.nos.get(x).centroide);
  const { cabeca } = treinarCabeca({ casos: [{ s: P[0], pos: new Set([0]) }], P, epocas: 3, lr: 0.5, seed: 1, posto: 4 });
  const mk = (n, extra) => ({ vetores: [consulta(QA, n)], usadas: { capacidades: ['n0'], funcoes: [] }, pedidasPelaLlm: ['n0'], avaliacao: false, carregadas: { tool: ['n0/tool/f', 'n1/tool/f'] }, ...extra });
  const mkPos = (n, av) => ({ vetores: [consulta(QA, n)], usadas: { capacidades: ['n0'], funcoes: ['n0/tool/f'] }, pedidasPelaLlm: [], avaliacao: av, carregadas: { tool: ['n0/tool/f'] } });
  const capT = [];
  const rt = await atualizarPorLote({ anel: 'tool', indice: ind, atual: { cabeca, anelAprovado: false, metricasAnel: null }, casosNovos: [...Array.from({ length: 4 }, (_, i) => mkPos(i, false)), ...Array.from({ length: 4 }, (_, i) => mk(50 + i))], reposicao: [], recentes: Array.from({ length: 5 }, (_, i) => mkPos(100 + i, true)), epocas: 1, minAvaliacao: 1, treinarCabecaFn: async (a) => { capT.push(a); return treinarCabeca(a); } });
  assert.equal(rt.ok, true, rt.motivo);
  const fracosT = capT[0].casos.map((c, i) => [c, i]).filter(([c]) => c.pos.size === 0).map(([, i]) => capT[0].candidatosPorCaso[i]);
  assert.ok(fracosT.length > 0 && fracosT.every((d) => d.length === 1 && d[0] === refs.indexOf('n1/tool/f')), JSON.stringify(fracosT));
});

test('I2: a carga junto (e o piso do caso) VOLTA neutra quando o caso retorna da reposição num lote seguinte', async () => {
  const ind = await indiceDe(capacidadesTool, TABELA_TOOL, 'tool');
  const refs = [...ind.nos.keys()];
  const P = refs.map((x) => ind.nos.get(x).centroide);
  const { cabeca } = treinarCabeca({ casos: [{ s: P[0], pos: new Set([0]) }], P, epocas: 3, lr: 0.5, seed: 1, posto: 4 });
  const atual = { cabeca, anelAprovado: false, metricasAnel: null };
  const mkPos = (n, av) => ({ vetores: [consulta(QA, n)], usadas: { capacidades: ['n0'], funcoes: ['n0/tool/f'] }, pedidasPelaLlm: [], avaliacao: av, carregadas: { tool: ['n0/tool/f', 'n0/tool/g'] }, piso: { ids: [], fixas: ['n1/tool/f'] } });
  const aval = Array.from({ length: 5 }, (_, i) => mkPos(100 + i, true));
  // lote 1: o caso entra com a junta (n0/tool/g) e a fixa do piso do caso (n1/tool/f) fora do domínio e SAI na reposição com `neutras`
  const capt1 = [];
  const r1 = await atualizarPorLote({ anel: 'tool', indice: ind, atual, casosNovos: [mkPos(1, false)], reposicao: [], recentes: aval, epocas: 1, minAvaliacao: 1, treinarCabecaFn: async (a) => { capt1.push(a); return treinarCabeca(a); } });
  assert.equal(r1.ok, true, r1.motivo);
  const iG = refs.indexOf('n0/tool/g'); const iFixa = refs.indexOf('n1/tool/f');
  assert.ok(!capt1[0].candidatosPorCaso[0].includes(iG) && !capt1[0].candidatosPorCaso[0].includes(iFixa));
  const naBase = r1.reposicao[0];
  assert.deepEqual([...naBase.neutras].sort(), ['n0/tool/g', 'n1/tool/f']);
  // lote 2: só a reposição (sem o caso novo) — o domínio refeito AINDA exclui as neutras
  const capt2 = [];
  const r2 = await atualizarPorLote({ anel: 'tool', indice: ind, atual, casosNovos: [], reposicao: r1.reposicao, slugReposicao: r1.slugReposicao, recentes: aval, epocas: 1, minAvaliacao: 1, amostraReposicao: 10, treinarCabecaFn: async (a) => { capt2.push(a); return treinarCabeca(a); } });
  assert.equal(r2.ok, true, r2.motivo);
  assert.ok(!capt2[0].candidatosPorCaso[0].includes(iG) && !capt2[0].candidatosPorCaso[0].includes(iFixa), 'a junta continua neutra depois de ir para a base e voltar');
  assert.deepEqual([...r2.reposicao[0].neutras].sort(), ['n0/tool/g', 'n1/tool/f'], 'e segue gravada na base');
  // reposição ANTIGA (sem `neutras`) continua funcionando: o domínio é o da produção
  const antiga = r1.reposicao.map(({ v, rotulos }) => ({ v, rotulos }));
  const capt3 = [];
  const r3 = await atualizarPorLote({ anel: 'tool', indice: ind, atual, casosNovos: [], reposicao: antiga, slugReposicao: r1.slugReposicao, recentes: aval, epocas: 1, minAvaliacao: 1, amostraReposicao: 10, treinarCabecaFn: async (a) => { capt3.push(a); return treinarCabeca(a); } });
  assert.equal(r3.ok, true, r3.motivo);
  assert.ok(capt3[0].candidatosPorCaso[0].includes(iG), 'sem o campo, volta ao comportamento de antes');
});

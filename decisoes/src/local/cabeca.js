// packages/decisions/src/local/cabeca.js
// Cabeça bilinear centrada (Fase 1: posto 32, ~25 mil números): nota = σ(α·(s·p + (Uᵀs)·(Vᵀp)) + β), com
// s = pedido e p = centroide do nó, ambos centrados pelo índice. Treino por descida de gradiente com conta
// fatorada (precalcula Vᵀp por candidato e Uᵀs por caso) — segundos em CPU. Os pesos vêm do uso do dono:
// arquivo em data/, preso ao embedder (slug do provider) e à dimensão — NÃO ao hash do catálogo: o `hash` gravado é só informativo
// (`carregarCabeca` não o confere; spec 2026-10-07 de cortes e composição, D4).
import { existsSync, readFileSync } from 'node:fs';
import { produto } from './vetores.js';

function aleatorio(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export function novaCabeca({ d, posto = 32, seed = 0 }) {
  const r = aleatorio(seed + 1);
  const m = () => Array.from({ length: d }, () => Array.from({ length: posto }, () => (r() - 0.5) * 0.02));
  return { d, posto, U: m(), V: m(), alfa: 5, beta: -2 };
}

function projetar(v, M, posto) {
  const out = new Array(posto).fill(0);
  for (let i = 0; i < v.length; i++) { const vi = v[i]; if (vi === 0) continue; const linha = M[i]; for (let k = 0; k < posto; k++) out[k] += vi * linha[k]; }
  return out;
}

export const finito = (x) => typeof x === 'number' && Number.isFinite(x);
/** Todos os pesos da cabeça são números finitos (NaN/Infinity serializam como null e o arquivo ficaria inútil). */
export const cabecaFinita = (c) => finito(c.alfa) && finito(c.beta) && c.U.every((l) => l.every(finito)) && c.V.every((l) => l.every(finito));
const sigmoide = (z) => 1 / (1 + Math.exp(-z));

export function pontuarCabeca(c, s, p) {
  const a = projetar(s, c.U, c.posto);
  const b = projetar(p, c.V, c.posto);
  return sigmoide(c.alfa * (produto(s, p) + produto(a, b)) + c.beta);
}

/**
 * @param {{casos: {s:number[], pos:Set<number>}[], P:number[][], epocas?:number, lr?:number, seed?:number, posto?:number, pesoPositivo?:number, candidatosPorCaso?:number[][], inicial?:object}} o
 * `candidatosPorCaso[n]` = índices de P que formam o domínio do caso n (padrão: todos). Fora do domínio o par não entra na perda.
 * @returns {{cabeca, perdas:number[]}}
 */
export function treinarCabeca({ casos, P, epocas = 30, lr = 0.5, seed = 0, posto = 32, pesoPositivo = 5, candidatosPorCaso = null, inicial = null }) {
  if (!Array.isArray(casos) || !casos.length) throw new Error('treinarCabeca: sem casos');
  if (!Array.isArray(P) || !P.length) throw new Error('treinarCabeca: sem candidatos (P vazio)');
  const d = P[0].length;
  const m = P.length;
  let c;
  if (inicial) {
    // Atualização por lote: parte dos pesos atuais (cópia profunda — a cabeça em uso nunca é mutada).
    if (inicial.d !== d || inicial.posto !== posto) throw new Error('treinarCabeca: inicial com forma diferente (d/posto)');
    // Arquivo lido do disco pode estar truncado/NaN: valida forma e finitude ANTES de treinar (senão o erro vira "treino-divergiu" confuso).
    if (!matrizValida(inicial.U, d, posto) || !matrizValida(inicial.V, d, posto) || !cabecaFinita(inicial)) throw new Error('treinarCabeca: inicial inválida (forma de U/V ou pesos não finitos)');
    c = { d, posto, U: inicial.U.map((l) => l.slice()), V: inicial.V.map((l) => l.slice()), alfa: inicial.alfa, beta: inicial.beta };
  } else c = novaCabeca({ d, posto, seed });
  const perdas = [];
  if (candidatosPorCaso && candidatosPorCaso.length !== casos.length) throw new Error('treinarCabeca: candidatosPorCaso deve ter um item por caso');
  const todos = Array.from({ length: m }, (_, j) => j);
  const dominios = casos.map((_, n) => candidatosPorCaso?.[n] ?? todos);
  const nPares = dominios.reduce((t, dm) => t + dm.length, 0) || 1;
  const base = casos.map((cs) => P.map((p) => produto(cs.s, p)));
  const copiar = (M) => M.map((l) => l.slice());
  // Passo adaptativo (backtracking): lr fixo diverge quando o alvo se concentra em poucos nós (gradiente coerente
  // entre casos + termo bilinear crescendo = curvatura > 2/lr). A perda é medida ANTES de cada atualização, com
  // os pesos vigentes; se subiu mais que a tolerância (ou não é finita), volta ao ponto anterior e metade do lr.
  const TOLERANCIA = 1.01; const MAX_REDUCOES = 12;
  let passo = lr; let reducoes = 0; let anterior = null; let perdaAnterior = Infinity;
  for (let ep = 0; ep <= epocas; ep++) { // a passada extra (ep === epocas) só confere os pesos finais, sem atualizar
    const B = P.map((p) => projetar(p, c.V, posto));
    const gU = Array.from({ length: d }, () => new Array(posto).fill(0));
    const coefV = Array.from({ length: m }, () => new Array(posto).fill(0));
    let gAlfa = 0; let gBeta = 0; let perda = 0;
    casos.forEach((cs, n) => {
      const A = projetar(cs.s, c.U, posto);
      const coefU = new Array(posto).fill(0);
      for (const j of dominios[n]) {
        const x = base[n][j] + produto(A, B[j]);
        const y = cs.pos.has(j) ? 1 : 0;
        const w = (y ? pesoPositivo : 1) * (cs.peso ?? 1); // `peso` do caso (negativo fraco do treino contínuo = 0,5)
        const q = sigmoide(c.alfa * x + c.beta);
        perda += -w * (y ? Math.log(q + 1e-9) : Math.log(1 - q + 1e-9));
        const g = w * (q - y);
        gAlfa += g * x; gBeta += g;
        const ga = g * c.alfa;
        for (let k = 0; k < posto; k++) { coefU[k] += ga * B[j][k]; coefV[j][k] += ga * A[k]; }
      }
      for (let i = 0; i < d; i++) { const si = cs.s[i]; if (si === 0) continue; const linha = gU[i]; for (let k = 0; k < posto; k++) linha[k] += si * coefU[k]; }
    });
    const perdaMedia = perda / nPares;
    // Tolerância aditiva em torno de |perda|: com o alvo saturado a perda fica ~0 e pode ficar levemente NEGATIVA (o 1e-9 do log), onde `perda * 1.01` seria MENOR que a perda.
    if (anterior && !(perdaMedia <= perdaAnterior + Math.abs(perdaAnterior) * (TOLERANCIA - 1) + 1e-12)) {
      // Piorou (ou NaN/Infinity): desfaz a última atualização, reduz o passo e refaz esta época do ponto anterior.
      if (++reducoes > MAX_REDUCOES) throw new Error(`treino-divergiu: perda ${perdaMedia} após ${MAX_REDUCOES} reduções do passo (lr ${passo})`);
      c.U = copiar(anterior.U); c.V = copiar(anterior.V); c.alfa = anterior.alfa; c.beta = anterior.beta;
      passo /= 2; anterior = null; perdas.pop(); ep -= 2;
      continue;
    }
    if (ep === epocas) break;
    perdas.push(perdaMedia); perdaAnterior = perdaMedia;
    anterior = { U: copiar(c.U), V: copiar(c.V), alfa: c.alfa, beta: c.beta };
    const nCasos = casos.length;
    for (let i = 0; i < d; i++) for (let k = 0; k < posto; k++) {
      let gv = 0; for (let j = 0; j < m; j++) gv += P[j][i] * coefV[j][k];
      c.U[i][k] -= passo * gU[i][k] / nCasos;
      c.V[i][k] -= passo * gv / nCasos;
    }
    c.alfa -= passo * gAlfa / nPares; c.beta -= passo * gBeta / nPares;
  }
  if (!cabecaFinita(c) || !perdas.every(finito)) throw new Error('treino-divergiu: pesos ou perda não finitos ao fim do treino');
  return { cabeca: c, perdas };
}

/**
 * Formato v2 (spec 2026-10-07 D1/§5): o portão é do ANEL (`anelAprovado` + `metricasAnel {base, cabeca, n}`), não da capacidade.
 * Não há mais `aprovadas` nem `cortes` — os cortes são fixos de produto; o que o histórico sugeriria vai só como relatório
 * (`cortesSugeridos`). `nTreinoPorCapacidade` alimenta a proteção D5 (capacidade com poucos casos).
 *
 * ESTRITO: quem ainda passa `aprovadas` ou `cortes` (assinatura v1) leva um TypeError em vez de gravar um arquivo que parece
 * v2 mas perdeu o portão — protege a janela entre as fases, enquanto `treino.js`/`lote.js` não migraram.
 */
export function serializarCabeca(c, opcoes) {
  if (opcoes && typeof opcoes === 'object' && ('aprovadas' in opcoes || 'cortes' in opcoes)) {
    throw new TypeError('serializarCabeca v2: aprovadas/cortes não existem mais — use anelAprovado/cortesSugeridos');
  }
  const { anel, slug, hash, anelAprovado = false, metricasAnel = null, metricas = {}, nTreinoPorCapacidade = {}, cortesSugeridos = null } = opcoes;
  return { versao: 2, anel, slug, hash, d: c.d, posto: c.posto, U: c.U, V: c.V, alfa: c.alfa, beta: c.beta, anelAprovado: Boolean(anelAprovado), metricasAnel, metricas, nTreinoPorCapacidade, cortesSugeridos, criadaEm: new Date().toISOString() };
}

/** `nTreinoPorCapacidade` do v2 vem de disco: só objeto simples; valor não finito vira 0 (igual ao v1) — `'abc' < 50` seria false e tiraria a D5. */
const nTreinoSaneado = (obj) => (obj && typeof obj === 'object' && !Array.isArray(obj)
  ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, finito(v) ? v : 0]))
  : {});

const matrizValida = (M, linhas, colunas) => Array.isArray(M) && M.length === linhas && M.every((l) => Array.isArray(l) && l.length === colunas && l.every(finito));

/**
 * `dim` = dimensão do índice atual: pesos treinados em outra dimensão não valem. Lê v1 (legado) e v2; não exige `cortes`.
 *
 * Nota de transição: com um arquivo v1 em uso, `anelAprovado` fica `true` se havia alguma aprovada — a cabeça passa a valer
 * para TODAS as capacidades até o retreino v2 regravar o anel. É o comportamento desejado pela spec; o retreino (Fase 4)
 * acontece logo em seguida. `metricasAnel` fica `null` no v1 (o portão por anel nunca o avaliou).
 *
 * O retorno NÃO tem `aprovadas` nem `cortes` (campos do v1): o portão é do anel (`anelAprovado`) e os cortes são fixos de produto;
 * o `cortes` do v1 só sobrevive como `cortesSugeridos`.
 * @returns {{ok:true, cabeca, anelAprovado:boolean, metricasAnel:object|null, metricas:object, nTreinoPorCapacidade:Record<string,number>, cortesSugeridos:object|null, versaoDoArquivo:1|2}|{ok:false, motivo:string}}
 */
export function carregarCabeca({ arquivo, slug, dim }) {
  if (!arquivo || !existsSync(arquivo)) return { ok: false, motivo: 'sem-arquivo' };
  let j;
  try { j = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { return { ok: false, motivo: 'ilegivel' }; }
  if (j?.versao !== 1 && j?.versao !== 2) return { ok: false, motivo: 'versao' };
  if (j.slug !== slug) return { ok: false, motivo: 'outro-provider' };
  // spec 3 D4 — presa só ao embedder (slug) e à dimensão; o hash do catálogo é informativo. Bancada de 07/10:
  // texto de 1/3 das capacidades trocado derrubou ≤ 4 pontos.
  if (j.d !== dim) return { ok: false, motivo: 'outra-dimensao' };
  if (!Number.isInteger(j.posto) || j.posto < 1 || !finito(j.alfa) || !finito(j.beta) || !matrizValida(j.U, j.d, j.posto) || !matrizValida(j.V, j.d, j.posto)) {
    return { ok: false, motivo: 'pesos-invalidos' };
  }
  const cabeca = { d: j.d, posto: j.posto, U: j.U, V: j.V, alfa: j.alfa, beta: j.beta };
  if (j.versao === 1) {
    const aprovadas = Array.isArray(j.aprovadas) ? j.aprovadas : [];
    const nTreino = Object.fromEntries(Object.entries(j.metricas || {}).map(([k, m]) => [k, finito(m?.nTreino) ? m.nTreino : 0]));
    return { ok: true, cabeca, anelAprovado: aprovadas.length > 0, metricasAnel: null, metricas: j.metricas || {}, nTreinoPorCapacidade: nTreino, cortesSugeridos: j.cortes ?? null, versaoDoArquivo: 1 };
  }
  return { ok: true, cabeca, anelAprovado: j.anelAprovado === true, metricasAnel: j.metricasAnel ?? null, metricas: j.metricas || {}, nTreinoPorCapacidade: nTreinoSaneado(j.nTreinoPorCapacidade), cortesSugeridos: j.cortesSugeridos ?? null, versaoDoArquivo: 2 };
}

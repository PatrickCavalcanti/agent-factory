// packages/decisions/src/local/cortes-fixos.js
// Cortes FIXOS de produto (spec 2026-10-07 D2/D4): não vêm do histórico. A calibração por percentil continua existindo só
// como relatório (`cortesSugeridos`). Valores medidos em 07/10 nos recentes do dono — ordem de grandeza, padrão + override.
export const CORTES_FIXOS = Object.freeze({
  cabeca: Object.freeze({ full: 0.30, candidate: 0.15 }),
  base: Object.freeze({ full: 0.35, candidate: 0.25 }),
  promocao: 0.70, // D4a: função de capacidade NÃO carregada só vira full (e dispara P1 do kairos) acima disto
  // D6 (dono, 10/10; simulação B2 do roteiro de testes): no anel PROVIDER, pelo caminho da cabeça, a cabeça carrega SOZINHA só com
  // nota ≥ `full`; de `minimo` até `full`, carrega só quando o Kairos também propôs `full`; senão vale o par `cabeca` (candidate/discard).
  // `null` no override desliga (volta ao par `cabeca` puro).
  // full 0,60 → 0,70 (dono, 13/10; régua do corte sobre 37 turnos de chat pós-Gemma, E:\tmp\regua-corte): a cabeça sozinha
  // entre 0,60 e 0,70 só carregava à toa (3 de 3); o aval do Kairos segue valendo até o mínimo.
  comKairos: Object.freeze({ full: 0.70, minimo: 0.25 }), // mínimo 0,15 → 0,25 (dono, 10/10, bancada B2b): o aval do Kairos carregava cabeça de 0,18–0,24 à toa
});
export const FUNCAO_TRAZ_PADRAO = Object.freeze({ ativo: true, n: 5, candidata: 0.40, promoverFull: 'so-provider-na-base' });
const PROMOVER = new Set(['sempre', 'so-provider-na-base', 'nunca']);
// Escala por chave: a cabeça é probabilidade (sigmoide, [0,1]); a base é cosseno centrado ([-1,1]).
const MIN_DA_ESCALA = Object.freeze({ cabeca: 0, base: -1 });
const par = (c, min) => c && typeof c === 'object' && [c.full, c.candidate].every((x) => typeof x === 'number' && x >= min && x <= 1) && c.candidate <= c.full;

const CHAVES_DE_CORTE = new Set(['cabeca', 'base', 'promocao', 'comKairos']);
const comKairosValido = (c) => c && typeof c === 'object' && [c.full, c.minimo].every((x) => typeof x === 'number' && x >= 0 && x <= 1) && c.minimo <= c.full;
// Chaves do formato antigo (um par por anel): têm o motivo próprio abaixo, então não contam como "desconhecidas".
const ANEIS_DO_FORMATO_ANTIGO = ['provider', 'tool', 'skill'];

/** @returns {{cortes:{cabeca,base,promocao,comKairos}, origem:{cabeca:'fixo'|'override', base:'fixo'|'override', promocao:'fixo'|'override', comKairos:'fixo'|'override'}, motivos:string[]}} */
export function normalizarCortesFixos(bruto) {
  const cortes = { cabeca: { ...CORTES_FIXOS.cabeca }, base: { ...CORTES_FIXOS.base }, promocao: CORTES_FIXOS.promocao, comKairos: { ...CORTES_FIXOS.comKairos } };
  const origem = { cabeca: 'fixo', base: 'fixo', promocao: 'fixo', comKairos: 'fixo' }; const motivos = [];
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { cortes, origem, motivos };
  for (const k of ['cabeca', 'base']) {
    if (bruto[k] === undefined) continue;
    const min = MIN_DA_ESCALA[k];
    if (par(bruto[k], min)) { cortes[k] = { full: bruto[k].full, candidate: bruto[k].candidate }; origem[k] = 'override'; } else motivos.push(`cortes.${k} inválido (full/candidate em [${min},1], candidate ≤ full)`);
  }
  if (bruto.promocao !== undefined) {
    if (typeof bruto.promocao === 'number' && bruto.promocao >= 0 && bruto.promocao <= 1) { cortes.promocao = bruto.promocao; origem.promocao = 'override'; } else motivos.push('cortes.promocao inválido (número em [0,1])');
  }
  if (bruto.comKairos === null) { cortes.comKairos = null; origem.comKairos = 'override'; }
  else if (bruto.comKairos !== undefined) {
    if (comKairosValido(bruto.comKairos)) { cortes.comKairos = { full: bruto.comKairos.full, minimo: bruto.comKairos.minimo }; origem.comKairos = 'override'; } else motivos.push('cortes.comKairos inválido (full/minimo em [0,1], minimo ≤ full; null desliga)');
  }
  // Formato antigo (spec 1/3): um par {full, candidate} por anel. Não vale mais — os cortes são por caminho (cabeca/base).
  for (const anel of ANEIS_DO_FORMATO_ANTIGO) {
    const v = bruto[anel];
    if (v && typeof v === 'object' && ('full' in v || 'candidate' in v)) motivos.push(`cortes.${anel}: formato antigo por anel ignorado (use cortes.cabeca / cortes.base)`);
  }
  // Typo (`cabeça`, `promocoes`...): sem isto o override some em silêncio e o dono acha que o corte mudou.
  for (const k of Object.keys(bruto)) {
    if (!CHAVES_DE_CORTE.has(k) && !ANEIS_DO_FORMATO_ANTIGO.includes(k)) motivos.push(`cortes.${k}: chave desconhecida — ignorada`);
  }
  return { cortes, origem, motivos };
}

export function normalizarFuncaoTraz(bruto) {
  const valor = { ...FUNCAO_TRAZ_PADRAO }; const motivos = [];
  if (!bruto || typeof bruto !== 'object') return { valor, motivos };
  if (typeof bruto.ativo === 'boolean') valor.ativo = bruto.ativo; else if (bruto.ativo !== undefined) motivos.push('funcaoTrazCapacidade.ativo inválido (booleano)');
  if (Number.isInteger(bruto.n) && bruto.n >= 1 && bruto.n <= 20) valor.n = bruto.n; else if (bruto.n !== undefined) motivos.push('funcaoTrazCapacidade.n inválido (1..20)');
  if (typeof bruto.candidata === 'number' && bruto.candidata >= 0 && bruto.candidata <= 1) valor.candidata = bruto.candidata; else if (bruto.candidata !== undefined) motivos.push('funcaoTrazCapacidade.candidata inválido');
  if (PROMOVER.has(bruto.promoverFull)) valor.promoverFull = bruto.promoverFull; else if (bruto.promoverFull !== undefined) motivos.push('funcaoTrazCapacidade.promoverFull inválido');
  return { valor, motivos };
}

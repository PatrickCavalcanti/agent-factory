// A conta do despejo (spec 2026-10-29 §5.2): descarta quando r × D × H ≥ (w − r) × S.
export function horizonte({ chamadas = [], k, n, nEstimado = null }) {
  const ult = chamadas.slice(-k);
  const media = ult.length ? ult.reduce((s, x) => s + x, 0) / ult.length : 1;
  const N = typeof nEstimado === 'number' && nEstimado > 0 ? nEstimado : n;
  return { media, N, H: media * N };
}

export function prefixoComum(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

// Caracteres que deixam de vir do cache: do primeiro byte diferente até o fim do system, mais o
// histórico inteiro (vem depois do system; qualquer mudança no system o reescreve).
const reescrito = (anterior, atual, historicoChars) =>
  anterior === atual ? 0 : (atual.length - prefixoComum(anterior, atual)) + historicoChars;

/**
 * @param {{ systemAnterior: string|null, systemSem: string, systemCom: string, historicoChars: number,
 *   razao: number, r: number, w: number, H: number, minutosDesdeUltima: number|null, pausaMin: number }} p
 */
export function decidirDespejo(p) {
  const D = (p.systemSem.length - p.systemCom.length) * p.razao;
  const comum = { r: p.r, w: p.w, H: p.H, D, S: 0, economia: 0, custo: 0 };
  if (D <= 0) return { ...comum, disparou: false, motivo: 'nada-a-descartar' };
  const economia = p.r * D * p.H;
  const pausa = typeof p.minutosDesdeUltima === 'number' && p.minutosDesdeUltima >= p.pausaMin;
  if (pausa || p.systemAnterior == null) {
    return { ...comum, economia, disparou: true, motivo: pausa ? 'pausa' : 'sem-cache' };
  }
  const S = Math.max(0, reescrito(p.systemAnterior, p.systemCom, p.historicoChars) - reescrito(p.systemAnterior, p.systemSem, p.historicoChars)) * p.razao;
  const custo = (p.w - p.r) * S;
  const disparou = economia >= custo;
  return { ...comum, S, economia, custo, disparou, motivo: S === 0 ? 'sem-custo' : disparou ? 'compensa' : 'nao-compensa' };
}

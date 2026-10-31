// packages/decisions/src/local/vetores.js
// Conta de vetor do decisor local (spec 2026-10-06 §3). Tudo em number[] — é o tipo que o embedder do Igris
// devolve (`adaptarEmbedder`, @igris/semantic-context).

export function produto(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function normalizar(v) {
  const n = Math.sqrt(produto(v, v));
  return n > 0 ? v.map((x) => x / n) : v.slice();
}

export function media(vetores) {
  const d = vetores[0].length;
  const m = new Array(d).fill(0);
  for (const v of vetores) for (let i = 0; i < d; i++) m[i] += v[i];
  return m.map((x) => x / vetores.length);
}

/** Centra pela média do índice e renormaliza — o e5 é anisotrópico (Fase 1: sem centrar, tudo colapsa). */
export function centrar(v, mu) {
  return normalizar(v.map((x, i) => x - mu[i]));
}

export function percentil(valores, p) {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.floor(p * (o.length - 1))];
}

export function vetorValido(v, d) {
  return Array.isArray(v) && v.length === d && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

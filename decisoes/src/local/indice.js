// packages/decisions/src/local/indice.js
// Índice do decisor local (spec 2026-10-06 §3): por anel, cada nó tem VÁRIOS vetores — o texto semântico e
// cada exemplo minerado — comparados um a um (máximo). Insight 2026-09-30: colar tudo num vetor só perde
// 4–11 pontos. Tudo é embedado no papel 'query' (são pedidos ou textos em linguagem de pedido) e centrado
// pela média do próprio índice.
import { createHash } from 'node:crypto';
import { media, centrar, normalizar, vetorValido } from './vetores.js';

const textoDe = (...xs) => xs.find((x) => typeof x === 'string' && x.trim())?.trim() ?? null;
const exemplosDe = (xs) => (Array.isArray(xs) ? xs : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());

export function nosDoAnel(anel, capacidades) {
  const nos = [];
  for (const cap of capacidades || []) {
    if (!cap?.id) continue;
    if (anel === 'provider') {
      const t = textoDe(cap.semanticText, cap.descricao);
      const ex = (cap.tools || []).flatMap((tool) => exemplosDe(tool.exemplos));
      const textos = [...(t ? [{ tipo: 'texto', texto: t }] : []), ...ex.map((texto) => ({ tipo: 'exemplo', texto }))];
      if (textos.length) nos.push({ ref: cap.id, textos });
    } else if (anel === 'tool') {
      for (const tool of cap.tools || []) {
        const t = textoDe(tool.semanticText, tool.description);
        const textos = [...(t ? [{ tipo: 'texto', texto: t }] : []), ...exemplosDe(tool.exemplos).map((texto) => ({ tipo: 'exemplo', texto }))];
        if (textos.length) nos.push({ ref: `${cap.id}/tool/${tool.name}`, textos });
      }
    } else if (anel === 'skill') {
      for (const s of cap.skillsDeclaradas || []) {
        const t = textoDe(s.semanticText, s.descricao);
        const textos = [...(t ? [{ tipo: 'texto', texto: t }] : []), ...exemplosDe(s.exemplos).map((texto) => ({ tipo: 'exemplo', texto }))];
        if (textos.length) nos.push({ ref: `${cap.id}/skill/${s.key}`, textos });
      }
    }
  }
  return nos;
}

/** Centroide do nó = média dos vetores já centrados, renormalizada (é o `p` da cabeça bilinear). */
export function centroideDe(vetores) {
  return normalizar(media(vetores));
}

export function hashDosNos(nos) {
  return createHash('sha256').update(JSON.stringify(nos), 'utf8').digest('hex').slice(0, 16);
}

/**
 * @returns {Promise<{ok:true, anel, slug, hash, media:number[], dim:number, nos:Map<string,{textos, vetores:number[][], origens:{tipo,i}[]}>}
 *   | {ok:false, motivo:string}>}
 */
export async function montarIndice({ anel, capacidades, embedder }) {
  if (!embedder?.embed) return { ok: false, motivo: 'sem-embedder' };
  const nos = nosDoAnel(anel, capacidades);
  if (!nos.length) return { ok: false, motivo: 'sem-nos' };
  const brutos = [];
  let dim = null;
  for (const no of nos) {
    let iEx = 0;
    for (const { tipo, texto } of no.textos) {
      let v = null;
      try { v = await embedder.embed(texto, 'query'); } catch { v = null; }
      if (dim === null && Array.isArray(v)) dim = v.length;
      const origem = { tipo, i: tipo === 'exemplo' ? iEx++ : 0 };
      if (vetorValido(v, dim)) brutos.push({ ref: no.ref, v, origem });
    }
  }
  if (!brutos.length) return { ok: false, motivo: 'sem-vetores' };
  const mu = media(brutos.map((b) => b.v));
  const mapa = new Map(nos.map((n) => [n.ref, { textos: n.textos, vetores: [], origens: [] }]));
  for (const b of brutos) {
    const no = mapa.get(b.ref);
    no.vetores.push(centrar(b.v, mu));
    no.origens.push(b.origem);
  }
  for (const [ref, no] of mapa) if (!no.vetores.length) mapa.delete(ref);
  for (const no of mapa.values()) no.centroide = centroideDe(no.vetores);
  return { ok: true, anel, slug: embedder.modelSlug ?? null, hash: hashDosNos(nos), media: mu, dim, nos: mapa };
}

/** Retrato sem vetores: o que o treino precisa para re-embedar os MESMOS textos (spec §7). */
export function exportarRetrato(indice) {
  return {
    versao: 1, anel: indice.anel, slug: indice.slug, hash: indice.hash, geradoEm: new Date().toISOString(),
    nos: [...indice.nos.entries()].map(([ref, no]) => ({ ref, textos: no.textos })),
  };
}

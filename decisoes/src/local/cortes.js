// packages/decisions/src/local/cortes.js
// Calibração do índice do decisor local (spec §5; ajustada pela spec 2026-10-07 D2/D3). Cada exemplo vira consulta contra o
// índice SEM ele mesmo: a nota no nó dele é "certa", nos outros nós é "errada". Os percentis (full = piso das certas, candidate =
// acima da maioria das erradas, nunca acima de full) NÃO decidem mais nada em produção: os cortes de produto são fixos
// (cortes-fixos.js) e este cálculo vira só relatório (`cortesSugeridos`). Exemplo cujo melhor nó errado bate o próprio nó
// "rouba" pedido e vai para o relatório; só SAI do índice (semRoubados) se o ladrão for de OUTRA capacidade — roubado por
// irmão (função/skill da mesma capacidade) fica ("irmão não rouba", D3). Sem nota "certa" (o exemplo era o único vetor do nó)
// não há com o que comparar: não se marca roubo.
import { percentil } from './vetores.js';
import { centroideDe } from './indice.js';
import { capacidadeDoRef } from './refs.js';

export const PARAMETROS_CORTES = Object.freeze({ minExemplos: 20, percentilFull: 0.10, percentilCandidate: 0.98 });

/** Produtos escalares calculados entre cada cessão do laço (o custo real do cálculo, não o nº de nós). */
export const CEDER_A_CADA_PRODUTOS = 200_000;

/**
 * Async só para ceder o laço (o cálculo é O(exemplos × vetores × dim) e roda no processo principal).
 * Máximo por nó numa passada, sobre vetores achatados; o próprio vetor é ignorado por índice.
 */
export async function calibrarCortes(indice, { parametros = {}, override = null, cederAPorProdutos = CEDER_A_CADA_PRODUTOS } = {}) {
  const p = { ...PARAMETROS_CORTES, ...parametros };
  const refs = [...indice.nos.keys()];
  const nNos = refs.length;
  const dim = indice.dim;
  const inicio = new Array(nNos + 1);
  let total = 0;
  for (let n = 0; n < nNos; n++) { inicio[n] = total; total += indice.nos.get(refs[n]).vetores.length; }
  inicio[nNos] = total;
  const plano = new Float64Array(total * dim);
  for (let n = 0; n < nNos; n++) {
    const vs = indice.nos.get(refs[n]).vetores;
    for (let k = 0; k < vs.length; k++) plano.set(vs[k], (inicio[n] + k) * dim);
  }

  const noDe = new Int32Array(total);
  for (let n = 0; n < nNos; n++) for (let j = inicio[n]; j < inicio[n + 1]; j++) noDe[j] = n;

  // Fase 1: máximo de cada vetor contra cada nó, numa passada. O produto é simétrico — cada par é calculado
  // uma vez e alimenta as duas linhas. O próprio vetor nunca entra (j > g).
  const maxPorNo = new Float64Array(total * nNos).fill(-Infinity);
  let produtos = 0;
  for (let n = 0; n < nNos; n++) {
    for (let g = inicio[n]; g < inicio[n + 1]; g++) {
      if (produtos >= cederAPorProdutos) { produtos = 0; await new Promise((r) => setImmediate(r)); }
      produtos += total - g - 1;
      const base = g * dim;
      const linhaG = g * nNos;
      for (let j = g + 1; j < total; j++) {
        const off = j * dim;
        let s = 0;
        let i = 0;
        for (; i + 3 < dim; i += 4) s += plano[base + i] * plano[off + i] + plano[base + i + 1] * plano[off + i + 1] + plano[base + i + 2] * plano[off + i + 2] + plano[base + i + 3] * plano[off + i + 3];
        for (; i < dim; i++) s += plano[base + i] * plano[off + i];
        const cj = linhaG + noDe[j];
        if (s > maxPorNo[cj]) maxPorNo[cj] = s;
        const cg = j * nNos + n;
        if (s > maxPorNo[cg]) maxPorNo[cg] = s;
      }
    }
  }

  // Fase 2: certa/errada de cada exemplo.
  const capDe = refs.map((ref) => capacidadeDoRef(indice.anel, ref));
  const certas = [];
  const erradas = [];
  const roubados = [];
  let mascarados = 0;
  for (let n = 0; n < nNos; n++) {
    const no = indice.nos.get(refs[n]);
    for (let k = 0; k < no.vetores.length; k++) {
      if (no.origens[k].tipo !== 'exemplo') continue;
      const linha = (inicio[n] + k) * nNos;
      const propria = maxPorNo[linha + n];
      let melhorNota = -Infinity;
      let melhorM = -1;
      let melhorOutra = -Infinity; // melhor nota entre os nós de OUTRA capacidade (o que "irmão não rouba" deixa passar)
      for (let m = 0; m < nNos; m++) {
        if (m === n) continue;
        const max = maxPorNo[linha + m];
        if (max === -Infinity) continue;
        erradas.push(max);
        if (max > melhorNota) { melhorNota = max; melhorM = m; }
        if (capDe[m] !== capDe[n] && max > melhorOutra) melhorOutra = max;
      }
      const temPropria = propria > -Infinity;
      if (temPropria) certas.push(propria);
      if (temPropria && melhorM >= 0 && melhorNota > propria) {
        const i = no.origens[k].i;
        // irmao: o destino é função/skill da MESMA capacidade (no anel provider o nó é a capacidade: sempre false).
        const irmao = capDe[n] === capDe[melhorM];
        roubados.push({ ref: refs[n], i, texto: no.textos.filter((t) => t.tipo === 'exemplo')[i]?.texto ?? null, para: refs[melhorM], irmao });
        // Mascarado: o ladrão é irmão (por isso o exemplo fica), mas outra capacidade TAMBÉM o bate — o irmão esconde um roubo real.
        if (irmao && melhorOutra > propria) mascarados += 1;
      }
    }
  }
  // roubadosMascarados é só contagem (relatório): não muda a regra de quem sai do índice.
  const resumo = { certas: certas.length, erradas: erradas.length, roubados: roubados.length, roubadosIrmaos: roubados.filter((r) => r.irmao).length, roubadosMascarados: mascarados };
  if (override && typeof override.full === 'number' && typeof override.candidate === 'number') {
    return { origem: 'override', full: override.full, candidate: override.candidate, roubados, resumo };
  }
  if (certas.length < p.minExemplos) return { origem: 'sem-cortes', full: null, candidate: null, roubados, resumo };
  const full = percentil(certas, p.percentilFull);
  const candidate = Math.min(percentil(erradas, p.percentilCandidate) ?? full, full);
  return { origem: 'calculado', full, candidate, roubados, resumo };
}

/**
 * Aplica ao índice recém-montado a calibração MANTIDA (a lista `roubados` que o treino gravou), sem recalcular nada.
 * Casa por `ref` + `texto` do exemplo (o índice `i` muda quando o catálogo muda): sai o exemplo cujo nó e texto constam
 * numa entrada com `irmao !== true`. Nó novo ou texto novo (sem entrada) fica inteiro; nó que perde todos os vetores some.
 * Mesma regra de `semRoubados` para o irmão (fica) e para o centroide (recalculado).
 * @returns {{indice:object, removidos:number}} `removidos` = exemplos efetivamente tirados agora
 */
export function aplicarRoubadosMantidos(indice, roubados) {
  const fora = new Set((Array.isArray(roubados) ? roubados : [])
    .filter((r) => r && r.irmao !== true && typeof r.texto === 'string')
    .map((r) => JSON.stringify([r.ref, r.texto])));
  const nos = new Map();
  let removidos = 0;
  for (const [ref, no] of indice.nos) {
    const exemplos = no.textos.filter((t) => t.tipo === 'exemplo');
    const manter = no.origens.map((o) => {
      if (o.tipo !== 'exemplo') return true;
      const texto = exemplos[o.i]?.texto;
      return !(typeof texto === 'string' && fora.has(JSON.stringify([ref, texto])));
    });
    removidos += manter.filter((m) => !m).length;
    const vetores = no.vetores.filter((_, k) => manter[k]);
    if (!vetores.length) continue;
    if (vetores.length === no.vetores.length) { nos.set(ref, no); continue; }
    nos.set(ref, { textos: no.textos, vetores, origens: no.origens.filter((_, k) => manter[k]), centroide: centroideDe(vetores) });
  }
  return { indice: { ...indice, nos }, removidos };
}

/**
 * Cópia do índice sem os vetores dos exemplos que roubam; centroide recalculado, nó que fica vazio some.
 * Exemplo roubado por IRMÃO da mesma capacidade FICA (D3 da spec 2026-10-07): irmãos têm exemplos parecidos
 * por natureza e tirá-los apagava a função.
 * Entrada SEM o campo `irmao` (lista antiga, de antes da D3) SAI do índice: é a regra de antes, mantida por compatibilidade —
 * só `irmao: true` explícito salva o exemplo.
 */
export function semRoubados(indice, roubados) {
  const fora = new Set(roubados.filter((r) => r.irmao !== true).map((r) => `${r.ref}#${r.i}`));
  const nos = new Map();
  for (const [ref, no] of indice.nos) {
    const manter = no.origens.map((o) => !(o.tipo === 'exemplo' && fora.has(`${ref}#${o.i}`)));
    const vetores = no.vetores.filter((_, k) => manter[k]);
    if (!vetores.length) continue;
    nos.set(ref, { textos: no.textos, vetores, origens: no.origens.filter((_, k) => manter[k]), centroide: centroideDe(vetores) });
  }
  return { ...indice, nos };
}

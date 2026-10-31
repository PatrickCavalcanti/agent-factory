// packages/decisions/src/local/pontuador.js
// Nota base sem treino (spec §4 passo 2): máximo do cosseno entre QUALQUER vetor da consulta
// (`input.query.vectors`: pergunta + pista da B3.3) e QUALQUER vetor do nó. Mesma fusão por máximo do kairos.
import { centrar, produto, vetorValido } from './vetores.js';

export function consultaCentrada(indice, vetores) {
  return (vetores || []).filter((v) => vetorValido(v, indice.dim)).map((v) => centrar(v, indice.media));
}

/** @returns {{nota:number, casou:string}|null} */
export function pontuarNo(indice, consulta, ref, { ignorar = null } = {}) {
  const no = indice.nos.get(ref);
  if (!no || !consulta.length) return null;
  let melhor = -Infinity;
  let casou = null;
  for (let k = 0; k < no.vetores.length; k++) {
    if (ignorar && ignorar(k)) continue;
    for (const q of consulta) {
      const s = produto(q, no.vetores[k]);
      if (s > melhor) {
        melhor = s;
        const o = no.origens[k];
        casou = o.tipo === 'texto' ? 'texto' : `exemplo:${o.i}`;
      }
    }
  }
  return casou === null ? null : { nota: melhor, casou };
}

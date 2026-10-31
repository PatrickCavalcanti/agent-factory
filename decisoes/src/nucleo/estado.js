// packages/decisions/src/nucleo/estado.js
//
// N2 (adendo §15 da spec): corte genérico de um objeto por tamanho de JSON — não conhece
// campos, só COMO cortar cada classe que o chamador declarar. `../estado.js` (montarEstado,
// específico da hidratação) usa isto para o corte por teto, com os mesmos campos e a mesma
// ordem de hoje.

/**
 * Corta `obj` (mutando-o) até caber em `tetoChars`, tentando as classes de `ordemDeCorte`
 * em ordem — cada classe cede o quanto puder (`cortar()` devolve `false` quando não há mais
 * o que cortar nela) antes de passar para a próxima. Sem garantia de couber no teto: se
 * todas as classes se esgotarem antes, o objeto fica do jeito que sobrou.
 * @param {object} obj objeto a cortar (mutado in-place)
 * @param {{ tetoChars?: number, ordemDeCorte?: Array<{ rotulo: string, cortar: () => boolean }>, registrarCorte?: (rotulo: string) => void }} opts
 * @returns {object} o próprio `obj`
 */
export function cortarEstado(obj, { tetoChars, ordemDeCorte = [], registrarCorte } = {}) {
  if (!(Number(tetoChars) > 0)) return obj;
  const tamanho = () => JSON.stringify(obj).length;
  for (const { rotulo, cortar } of ordemDeCorte) {
    while (tamanho() > tetoChars && cortar()) {
      if (typeof registrarCorte === 'function') registrarCorte(rotulo);
    }
  }
  return obj;
}

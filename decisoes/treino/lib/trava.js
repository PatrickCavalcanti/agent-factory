// Trava única por processo (spec 2026-10-07): treino completo e atualização por lote nunca rodam juntos — os dois
// escrevem a cabeça do mesmo anel e disputam a CPU. Módulo singleton; quem trava recebe o `liberar`.
let atual = null;

/** @returns {(() => void)|null} `liberar` (idempotente) ou null se já está travado. */
export function tentarTravar(nome) {
  if (atual) return null;
  const marca = { nome };
  atual = marca;
  return () => { if (atual === marca) atual = null; };
}

export const travado = () => atual !== null;
/** Nome de quem está com a trava (ou null). */
export const quemTravou = () => atual?.nome ?? null;

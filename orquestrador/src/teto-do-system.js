// Teto por TAMANHO do system. `limiteDeTools` limita a CONTAGEM de tools hidratadas por turno; não diz nada
// sobre o tamanho do prompt. O system é append-only (o que entra não sai), e um catálogo com manuais grandes
// pode passar de centenas de milhares de caracteres sem que nenhum limite de contagem dispare.
//
// É AVISO, não recusa: o turno completa. Quem decide o que fazer com o aviso (cortar contribuição, subir o
// teto, trocar de modelo) é o host; a fábrica só garante que o excesso não passa em silêncio.

/**
 * @param {string} system o system do turno, inteiro
 * @param {{ chars?: number } | undefined} teto
 * @returns {{ ref: 'teto-do-system', error: string } | null} `null` abaixo do teto, sem teto ou com teto inválido
 */
export function conferirTetoDoSystem(system, teto) {
  const limite = teto?.chars;
  if (typeof limite !== 'number' || !Number.isFinite(limite) || limite <= 0) return null;
  const tamanho = String(system ?? '').length;
  if (tamanho <= limite) return null;
  return { ref: 'teto-do-system', error: `system com ${tamanho} caracteres acima do teto de ${limite}` };
}

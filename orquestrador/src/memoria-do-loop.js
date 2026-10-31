// Contexto de memórias do Jev (spec 2026-10-10 §4.1): memórias já selecionadas pelo turno,
// as de ação primeiro. Tetos configuráveis pelo host; padrões a calibrar na bancada.
export const MEMORIA_MAX_CHARS_PADRAO = 2500;
export const MEMORIA_ITEM_MAX_CHARS_PADRAO = 800;
const MARCA_CORTE = '…[cortado]';

// Devolve o texto inteiro, o texto cortado COM a marca, ou `null` quando só caberia um corte sem marca (o Jev nunca
// recebe um valor truncado sem aviso, e nunca um valor maior que o teto).
function cortar(texto, teto) {
  if (teto <= 0) return null;
  if (texto.length <= teto) return texto;
  if (teto <= MARCA_CORTE.length) return null;
  return `${texto.slice(0, teto - MARCA_CORTE.length)}${MARCA_CORTE}`;
}

/**
 * @param {Array<{ ref: string, valor: string, carrega?: string[] }>} incluidos memórias na ordem do turno
 * @param {{ maxChars?: number, itemMaxChars?: number }} [limites]
 * @returns {Array<{ ref: string, valor: string, acao: boolean }>}
 */
export function montarContextoDeMemorias(incluidos, { maxChars = MEMORIA_MAX_CHARS_PADRAO, itemMaxChars = MEMORIA_ITEM_MAX_CHARS_PADRAO } = {}) {
  if (!Array.isArray(incluidos)) return [];
  const itens = incluidos
    .filter((i) => i && typeof i.ref === 'string' && typeof i.valor === 'string' && i.valor.trim())
    .map((i, ordem) => ({ ref: i.ref, valor: i.valor, acao: Array.isArray(i.carrega) && i.carrega.length > 0, ordem }));
  itens.sort((a, b) => (a.acao === b.acao ? a.ordem - b.ordem : a.acao ? -1 : 1));
  const saida = [];
  let usado = 0;
  for (const it of itens) {
    const restante = maxChars - usado;
    if (restante <= 0) break;
    const valor = cortar(it.valor, Math.min(itemMaxChars, restante));
    if (valor === null) continue;
    saida.push({ ref: it.ref, valor, acao: it.acao });
    usado += valor.length;
  }
  return saida;
}

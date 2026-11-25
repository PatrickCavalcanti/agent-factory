// Formato do cartão de capacidade sugerida (spec Igris 2026-11-25-cartao-sugerido-e-uso-declarado-do-jev).
// O cartão completo lista todas as funções da capacidade com descrição — 55–90% da mensagem do turno no
// Igris, e os nomes já estão no índice de capacidades. `funcoesSugeridas` aponta só as funções que o anel
// `tool` marcou para o turno; `nenhum` deixa só o índice.

export const FORMATOS_DO_CARTAO = Object.freeze(['completo', 'funcoesSugeridas', 'nenhum']);
export const MAX_FUNCOES_SUGERIDAS = 5;
export const SEM_FUNCOES_SUGERIDAS = 'Capacidade sugerida; funções no índice de capacidades.';

/** @param {unknown} valor @returns {'completo'|'funcoesSugeridas'|'nenhum'} */
export function formatoDoCartao(valor) {
  if (valor === undefined || valor === null) return 'completo';
  if (!FORMATOS_DO_CARTAO.includes(valor)) {
    throw new Error(`cartaoSugerido inválido: "${valor}" (use ${FORMATOS_DO_CARTAO.map((f) => `'${f}'`).join(', ')})`);
  }
  return /** @type {any} */ (valor);
}

/**
 * Refs `<cap>/tool/<fn>` que o anel `tool` marcou como `full` ou `candidate` para a capacidade, da maior
 * nota (`scores.final`) para a menor, sem repetir, até `max`. Sem nota vai para o fim.
 * @param {Array<{ ref?: string, ring?: string, tier?: string, scores?: { final?: number } }>|undefined} explain
 * @param {string} providerId
 * @param {number} [max]
 * @returns {string[]}
 */
export function funcoesSugeridasDaCapacidade(explain, providerId, max = MAX_FUNCOES_SUGERIDAS) {
  const prefixo = `${providerId}/tool/`;
  const melhor = new Map();
  for (const e of Array.isArray(explain) ? explain : []) {
    if (e?.ring !== 'tool' || typeof e.ref !== 'string' || !e.ref.startsWith(prefixo)) continue;
    if (e.tier !== 'full' && e.tier !== 'candidate') continue;
    const nota = Number.isFinite(e.scores?.final) ? e.scores.final : -Infinity;
    if (!melhor.has(e.ref) || melhor.get(e.ref) < nota) melhor.set(e.ref, nota);
  }
  return [...melhor]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([ref]) => ref);
}

/** @param {string[]} nomes nomes EXPOSTOS das funções sugeridas @returns {string} */
export function conteudoComFuncoesSugeridas(nomes) {
  return nomes.length ? `Funções sugeridas: ${nomes.join(', ')}` : SEM_FUNCOES_SUGERIDAS;
}

const LEGENDA_FUNCOES_SUGERIDAS = [
  'Capacidades relacionadas ao seu pedido que ainda NÃO estão carregadas, com as funções mais prováveis '
    + 'para ele. As outras funções de cada uma estão no índice de capacidades.',
  '',
  'Para usar qualquer função: carregue o manual dela pelo NOME DA FUNÇÃO exatamente como aparece '
    + '(nunca o nome da capacidade — capacidade não é chamável). O manual chega, e aí você chama normal.',
  '',
  'Se nada aqui servir, diga o que você quer fazer — nunca invente um nome de função.',
].join('\n');

/**
 * Legenda padrão de `candidatos` para o formato. `undefined` = fica a do builder (`legendasPadrao`):
 * `completo` é o cartão de sempre; `nenhum` não renderiza a seção.
 * @param {'completo'|'funcoesSugeridas'|'nenhum'} formato
 * @returns {string|undefined}
 */
export function legendaDoCartao(formato) {
  return formato === 'funcoesSugeridas' ? LEGENDA_FUNCOES_SUGERIDAS : undefined;
}

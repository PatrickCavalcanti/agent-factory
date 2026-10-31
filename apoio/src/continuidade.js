// Continuidade entre turnos (spec 2026-10-14 §4.2): o que o turno anterior deixou para o seguinte —
// se terminou com pergunta e se o modelo declarou intenção — e o que isso decide sobre o trivial.
// Puro: sem I/O, sem estado.

export const MAX_PALAVRAS_RESPOSTA_CURTA = 12;

// Palavras de aceite, normalizadas (sem acento, minúsculas). Uma resposta é confirmação pura quando
// TODAS as palavras estão aqui ("sim, pode", "pode ser", "isso mesmo", "tá bom").
const ACEITES = new Set([
  'ok', 'okay', 'okey', 'sim', 'pode', 'ser', 'manda', 'ver', 'beleza', 'blz', 'isso', 'mesmo',
  'perfeito', 'fechado', 'fechou', 'aprovado', 'aprovo', 'certo', 'claro', 'bora', 'combinado',
  'show', 'faz', 'fazer', 'segue', 'siga', 'seguir', 'vai', 'exato', 'por', 'favor', 'entao',
  'ta', 'bom', 'otimo', 'top', 'valeu',
]);

function palavras(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** @returns {'vazia'|'confirmacao'|'curta'|'longa'} */
export function classificarResposta(texto) {
  const p = palavras(texto);
  if (!p.length) return 'vazia';
  // O tamanho vale antes da lista: acima do limite é 'longa' mesmo que toda palavra seja de aceite.
  if (p.length > MAX_PALAVRAS_RESPOSTA_CURTA) return 'longa';
  return p.every((x) => ACEITES.has(x)) ? 'confirmacao' : 'curta';
}

/**
 * O turno terminou pedindo algo ao dono? Decide a ÚLTIMA `_fala` do turno (revisão do conjunto, rodada 2 — a
 * lista inteira achatada misturava iterações e cada ajuste de precedência abria o caso oposto: I4 × N1):
 * - `clarification` → sim (o prompt de voz exige essa marca em toda pergunta);
 * - `final` → não ("Feito. Quer um lembrete também?" é cortesia; uma pergunta feita antes e já resolvida no
 *   próprio turno também não conta);
 * - sem `_fala`, ou a última é outra (`progress`, `error`…) → reserva: a última linha não vazia do chat final
 *   termina em `?` (fecho de markdown/aspas tolerado; URL com `?` não conta).
 */
export function terminouComPergunta({ purposes = [], chatFinal = '' } = {}) {
  const ultimaFala = Array.isArray(purposes) && purposes.length ? purposes[purposes.length - 1] : null;
  if (ultimaFala === 'clarification') return true;
  if (ultimaFala === 'final') return false;
  const linhas = String(chatFinal ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // URL com `?` no fim (query vazia) não é pergunta: sai da linha antes de testar o fecho.
  const ultima = (linhas[linhas.length - 1] ?? '').replace(/\bhttps?:\/\/\S+/gi, '');
  return /\?[\s*_)\]"'”’`]*$/.test(ultima);
}

/**
 * @param {{ texto: string, anterior: { terminouComPergunta?: boolean, intencao?: Array<object>|null }|null }} p
 * @returns {{ trivial: false, motivo: 'intencao'|'pergunta+curta', classe: string }|null}
 *   `null` = o executor não opina; vale a regra de hoje (`isTrivial` do kairos).
 */
export function decidirContinuidade({ texto, anterior } = {}) {
  if (!anterior || typeof anterior !== 'object') return null;
  const classe = classificarResposta(texto);
  if (Array.isArray(anterior.intencao) && anterior.intencao.length) return { trivial: false, motivo: 'intencao', classe };
  if (anterior.terminouComPergunta === true && (classe === 'confirmacao' || classe === 'curta')) {
    return { trivial: false, motivo: 'pergunta+curta', classe };
  }
  return null;
}

export const MAX_CHARS_ULTIMA_DO_ASSISTENTE = 1500;

/**
 * Revisão do conjunto, I1: com continuidade viva, a pergunta do assistente (no FIM da mensagem) tem de chegar ao Jev. A
 * `conversaDoHistorico` descarta a mensagem INTEIRA que passa do teto de caracteres — uma proposta longa viraria
 * `conversa: []`. Aqui a última mensagem do assistente fica só com o fim (`…` + últimos `max` caracteres), que cabe e
 * leva a pergunta. Não muta; sem mensagem do assistente (ou já curta), devolve a própria lista.
 * @param {Array<{role?: string, content?: unknown}>} mensagens histórico bruto, sem a mensagem do turno atual
 */
export function comUltimaDoAssistentePeloFim(mensagens, max = MAX_CHARS_ULTIMA_DO_ASSISTENTE) {
  if (!Array.isArray(mensagens)) return mensagens;
  let i = mensagens.length - 1;
  while (i >= 0 && mensagens[i]?.role !== 'assistant') i -= 1;
  if (i < 0) return mensagens;
  const conteudo = mensagens[i].content;
  if (typeof conteudo !== 'string') return mensagens;
  const texto = conteudo.trim();
  if (texto.length <= max) return mensagens;
  let fim = texto.slice(-max);
  if (/^[\uDC00-\uDFFF]/.test(fim)) fim = fim.slice(1); // não começa no meio de um par substituto
  const copia = [...mensagens];
  copia[i] = { ...mensagens[i], content: `…${fim}` };
  return copia;
}

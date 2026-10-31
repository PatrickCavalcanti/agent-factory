// packages/decisions/src/catalogo.js
export const RESPOND = 'respond_to_user';
export const TETO_OPCOES = 254; // choice aceita 255; uma vaga é do respond_to_user
export const DESC_RESPOND = 'Nenhuma tool é necessária agora: o pedido já está atendido pelas ações executadas, ou se responde com o que já está no contexto. O assistente escreve a resposta final.';

/** @param {{name:string, power:string, desc?:string}} t  @param {'nome'|'curta'|'completa'} nivel */
export function descricaoDaTool(t, nivel = 'curta') {
  const desc = (t.desc || '').trim();
  if (nivel === 'nome' || !desc) return `tool do power ${t.power}`;
  if (nivel === 'curta') return `${desc.split(/(?<=[.!?])\s+/)[0]} (power: ${t.power})`;
  return `${desc} (power: ${t.power})`;
}

/**
 * Monta o `criteria` da pergunta next_tool. Ordena por prioridade de power (menor = mais importante)
 * e corta pelo teto; nome duplicado mantém o primeiro.
 * @param {Array<{name:string, power:string, desc?:string}>} tools
 * @param {{ nivel?: 'nome'|'curta'|'completa', prioridadeDePower?: Record<string, number> }} [opts]
 */
export function montarCriteria(tools, { nivel = 'curta', prioridadeDePower = {} } = {}) {
  const ordenadas = [...tools].map((t, i) => ({ t, i })).sort((a, b) => (prioridadeDePower[a.t.power] ?? 99) - (prioridadeDePower[b.t.power] ?? 99) || a.i - b.i);
  const c = { [RESPOND]: DESC_RESPOND };
  let n = 0;
  for (const { t } of ordenadas) {
    if (n >= TETO_OPCOES) break;
    if (!t?.name || t.name === RESPOND || t.name in c) continue;
    c[t.name] = descricaoDaTool(t, nivel);
    n++;
  }
  return c;
}

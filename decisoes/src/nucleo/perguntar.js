// packages/decisions/src/nucleo/perguntar.js
//
// N1 (adendo §15 da spec): a parte de "estado + perguntas → respostas" que QUALQUER
// aplicação de decisão precisa, extraída de decidir() (../index.js) sem mudar semântica —
// prazo macio e resposta tardia moram aqui agora. Nunca lança: toda falha (sem cliente,
// erro do cliente, prazo estourado) vira `meta.degradado`.

function classificarErro(err) {
  const m = String(err?.message || err);
  if (/timeout/i.test(m)) return 'timeout';
  if (/chave/i.test(m)) return 'sem-chave';
  return 'erro';
}

/**
 * Soma o prazo macio ao teto duro: o cliente precisa aguentar mais que o prazo para a
 * resposta tardia existir. Exportado para quem cria o cliente escolher o teto certo.
 */
export const TETO_TARDIO_MS = 15000;

/**
 * @param {{ state: object, questions: object, cliente: {decidir:Function, modelo?:string}|null, prazoMs?: number, aoChegarTarde?: (r: {answers:object, meta:object}) => void }} p
 * @returns {Promise<{ answers: object, meta: { ms: number, msReal?: number, tokens: number, custo: number, modelo: string|null, degradado: false|string, erro?: string } }>}
 */
export async function perguntar({ state, questions, cliente, prazoMs, aoChegarTarde }) {
  const t0 = performance.now();
  const vazio = (degradado, extra = {}) => ({ answers: {}, meta: { ms: Math.round(performance.now() - t0), tokens: 0, custo: 0, modelo: null, degradado, ...extra } });
  if (!cliente) return vazio('sem-chave');
  const montar = (r) => ({ answers: r.answers, meta: { ms: r.ms ?? Math.round(performance.now() - t0), tokens: r.usage?.input_tokens ?? 0, custo: r.usage?.cost ?? 0, modelo: r.modelo ?? cliente.modelo ?? null, degradado: false } });
  const falha = (err) => vazio(classificarErro(err), { erro: String(err?.message || err) });
  const chamada = cliente.decidir({ state, questions });
  // Prazo macio: o turno não espera além de `prazoMs`, mas a chamada segue até o teto do
  // próprio cliente. Quando a resposta chega tarde, `aoChegarTarde` recebe o que teria
  // valido (com o ms real) — dado para calibrar o prazo, nunca aplicado ao turno.
  if (Number(prazoMs) > 0) {
    let timer;
    const PRAZO = Symbol('prazo');
    const venceu = await Promise.race([chamada, new Promise((res) => { timer = setTimeout(() => res(PRAZO), prazoMs); })]).catch((err) => ({ [PRAZO]: err }));
    clearTimeout(timer);
    if (venceu === PRAZO) {
      if (typeof aoChegarTarde === 'function') {
        chamada.then((r) => montar(r), (err) => falha(err))
          .then((tardia) => { try { aoChegarTarde({ ...tardia, meta: { ...tardia.meta, msReal: Math.round(performance.now() - t0) } }); } catch { /* diagnóstico nunca derruba nada */ } });
      } else chamada.catch(() => {});
      return vazio('timeout', { erro: `decisions: prazo de ${prazoMs}ms (resposta segue em segundo plano)` });
    }
    if (venceu && typeof venceu === 'object' && PRAZO in venceu) return falha(venceu[PRAZO]);
    return montar(venceu);
  }
  try { return montar(await chamada); }
  catch (err) { return falha(err); }
}

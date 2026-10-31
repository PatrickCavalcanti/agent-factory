// packages/decisions/src/cliente.js
// Cliente do endpoint de decisões da OpenRouter (rota alpha). Corpo: { model, state, questions }.
// Sem SDK: fetch nativo, timeout por AbortController, retry só em 429/529.
const URL_PADRAO = 'https://openrouter.ai/api/alpha/decisions';
const MODELO_PADRAO = 'typesafe/jev-1.13'; // alias ~typesafe/jev-latest ainda sem endpoint (2026-09-17)

/**
 * @param {{ chave: string, fetchImpl?: typeof fetch, url?: string, modelo?: string, timeoutMs?: number, esperaMs?: number, tentativas?: number }} opts
 */
export function criarCliente({ chave, fetchImpl = fetch, url = URL_PADRAO, modelo = MODELO_PADRAO, timeoutMs = 1500, esperaMs = 400, tentativas = 3 }) {
  async function decidir({ state, questions }) {
    if (!chave) throw new Error('decisions: chave da OpenRouter ausente');
    const body = JSON.stringify({ model: modelo, state, questions });
    const t0 = performance.now();
    let ultimo = null;
    for (let i = 0; i < tentativas; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r, txt;
      try {
        r = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json', 'X-Title': 'igris-decisions' }, body });
        txt = await r.text();
      } catch (err) {
        clearTimeout(timer);
        if (err?.name === 'AbortError') throw new Error(`decisions: timeout após ${timeoutMs}ms`);
        throw err;
      }
      clearTimeout(timer);
      if (r.status === 429 || r.status === 529) { ultimo = r.status; if (i < tentativas - 1) await new Promise((res) => setTimeout(res, esperaMs * (i + 1))); continue; }
      if (r.status !== 200) throw new Error(`decisions: HTTP ${r.status} ${txt.slice(0, 200)}`);
      let json; try { json = JSON.parse(txt); } catch { throw new Error('decisions: resposta não é JSON'); }
      if (!json.answers) throw new Error('decisions: resposta sem answers');
      return { answers: json.answers, usage: json.usage || {}, modelo: json.model || modelo, id: json.id, ms: Math.round(performance.now() - t0) };
    }
    throw new Error(`decisions: HTTP ${ultimo} após ${tentativas} tentativas`);
  }
  return { decidir, modelo };
}

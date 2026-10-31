// packages/decisions/src/candidatos.js
// Estratégias de candidatos para parâmetros de texto livre das tools de prefetch.
//
// O Jev só escolhe entre opções — não escreve texto. Parâmetro com `enum` já tem opções; um
// parâmetro de texto livre (ex. nome de uma lista do usuário) não tem, e por isso nunca
// entrava no prefetch com argumento. Uma ESTRATÉGIA propõe valores plausíveis a partir do
// pedido; eles viram opções de BAIXA confiança: se o Jev ficar inseguro, o parâmetro só é
// omitido (a consulta roda sem ele), nunca descarta o item — ver `candidatoDinamico` em
// gates.js. Estratégias são plugáveis; a primeira é "o que o usuário citou entre aspas".
// Nenhuma estratégia conhece power, tool ou valor específico (A1 do adendo §14).

import { enumUtilizavelDePrefetch } from './perguntas.js';

const TETO_VALORES = 12;
const TETO_CHARS_VALOR = 80;
// Teto de parâmetros que recebem candidatos por decisão: as perguntas pfarg_* são protegidas
// do corte de 60, então este teto é quem segura o custo quando o pedido tem aspas.
export const TETO_PARAMS_COM_CANDIDATOS = 8;
export const DESC_CANDIDATO = 'valor citado no pedido';

/** Valores entre aspas duplas (retas ou tipográficas) no pedido. */
export function entreAspas({ pedido }) {
  const texto = String(pedido || '');
  const out = [];
  for (const m of texto.matchAll(/"([^"\n]{1,200})"|“([^”\n]{1,200})”/g)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v && v.length <= TETO_CHARS_VALOR) out.push(v);
  }
  return out;
}

export const ESTRATEGIAS_PADRAO = [entreAspas];

/**
 * Devolve uma cópia do catálogo em que os parâmetros `type: 'string'` sem enum utilizável das
 * tools de prefetch ganham os candidatos como `enum` (marcados `candidatoDinamico`). Sem
 * candidato nenhum, devolve o próprio catálogo.
 */
export function aplicarEstrategiasDeCandidatos(catalogo, { pedido, estrategias = ESTRATEGIAS_PADRAO } = {}) {
  if (!Array.isArray(catalogo) || !Array.isArray(estrategias) || !estrategias.length) return catalogo;
  const vistos = new Set();
  const valores = [];
  for (const estrategia of estrategias) {
    let propostos = [];
    try { propostos = estrategia({ pedido }) || []; } catch { propostos = []; }
    for (const v of propostos) {
      const s = String(v).trim();
      if (!s || vistos.has(s)) continue;
      vistos.add(s);
      valores.push(s);
    }
  }
  const dominio = valores.slice(0, TETO_VALORES);
  if (!enumUtilizavelDePrefetch(dominio)) return catalogo;
  let usados = 0;
  return catalogo.map((t) => {
    if (t?.prefetch !== true || !Array.isArray(t.params)) return t;
    const params = t.params.map((p) => {
      if (usados >= TETO_PARAMS_COM_CANDIDATOS) return p;
      if (p?.type !== 'string' || enumUtilizavelDePrefetch(p.enum)) return p;
      usados += 1;
      return { ...p, enum: dominio, enumDescriptions: dominio.map(() => DESC_CANDIDATO), candidatoDinamico: true };
    });
    return { ...t, params };
  });
}

// packages/decisions/src/refinadores/tool.js
//
// Refinador do anel `tool` (Task 7, spec 2026-09-20 §3.2/R9): decide quais FUNÇÕES vão de
// `candidate` a `full` (hidratadas) neste turno. Duas exclusões do seletor: item com
// `meta.hasManual` já tem manual próprio guiando o modelo (perguntar ao Jev seria
// redundante) e item `pinned` já está fixado pelo host — nenhum dos dois precisa da
// pergunta. Diferente do anel `provider`, `classificar` aqui NUNCA rebaixa: abaixo do corte
// o item mantém o `proposedTier` que o motor já calculou (`candidate` continua `candidate`,
// `discard` continua `discard`) — o Jev só ACRESCENTA confiança para subir a `full`, não
// tira o que o score já decidiu. Se o teto de `full` do turno rebaixar um desses de volta a
// `candidate`, é o comportamento esperado do construtor (mesma regra dos outros anéis): uma
// função "consciente, mas sem manual" vai como candidate mesmo assim.
import { criarRefinadorJev } from './criar-refinador-jev.js';

export const PADRAO_TOOL = { corteFull: 0.7, maxFull: 4, enviar: 30 };

// Task 2 (2026-09-21-ajustes-de-uso-da-fabrica): extraída para fora de `refinadorDeFuncoes`
// porque `provider.js` reusa a MESMA pergunta para as funções que manda como extras na
// chamada do anel `provider` — é o que faz a resposta do Jev valer como `(cache)` aqui
// quando o anel `tool` perguntar pelo mesmo `ref` depois (mesma chave, mesma pergunta).
export function perguntaDeFuncao(ref, descricao) {
  return {
    chave: `fn_${ref}`,
    texto: `A função ${ref}${descricao ? ` (${descricao})` : ''} vai ser chamada neste turno? Verdadeiro só se for.`,
  };
}

/**
 * @param {object} p
 * @param {{decidir:Function}|null} p.cliente
 * @param {Partial<typeof PADRAO_TOOL>} [p.config] `config.prazoMs`, se presente, vence `p.prazoMs` só para este anel
 * @param {number} [p.prazoMs]
 * @param {(input: object) => object|null} [p.estadoDoHost]
 * @param {(t: object) => void} [p.aoChegarTarde] diagnóstico da resposta tardia (ver `criarRefinadorJev`)
 * @param {{ obter: (ref: string) => number|undefined, gravar?: (ref: string, noul: number) => void }} [p.cache]
 *   respostas já conhecidas (Task 2: normalmente gravadas pelo anel `provider`, que pergunta
 *   pelas funções das capacidades enviadas na mesma chamada) — item com resposta no cache não
 *   vai ao Jev de novo aqui. 22/09: quando `cache.gravar` existe, o próprio anel `tool` GRAVA de
 *   volta as respostas que ELE recebeu do Jev nesta chamada (via `aoResponder`, abaixo) — sem
 *   isto, uma segunda chamada ao anel `tool` no mesmo turno (ex.: o segundo `discover` do I3a)
 *   reperguntava tudo de novo, mesmo já tendo a resposta.
 */
export function refinadorDeFuncoes({ cliente, config = {}, prazoMs, estadoDoHost, aoChegarTarde, cache, aoChamarJev } = {}) {
  const c = { ...PADRAO_TOOL, ...config };
  // 22/09: o anel `tool` grava as próprias respostas no MESMO cache que lê (`p.cache` acima) —
  // `{ [ref]: noul }` vira uma chamada de `cache.gravar(ref, noul)` por entrada; nunca lança
  // (garantido por `criarRefinadorJev`, que já embrulha a chamada a `aoResponder` em try/catch).
  const aoResponder = typeof cache?.gravar === 'function'
    ? (respostas) => { for (const [ref, n] of Object.entries(respostas)) cache.gravar(ref, n); }
    : undefined;
  return criarRefinadorJev({
    anel: 'tool',
    cliente,
    prazoMs: c.prazoMs ?? prazoMs,
    estadoDoHost,
    aoChegarTarde,
    aoChamarJev,
    config: c,
    cache,
    aoResponder,
    seletor: (items) => items.filter((it) => !it.meta?.hasManual && !it.meta?.pinned).slice(0, c.enviar),
    pergunta: (it) => perguntaDeFuncao(it.ref, it.meta?.description),
    // abaixo do corte MANTÉM o proposto: quem decide manual por score é o motor; o Jev só acrescenta
    classificar: ({ noul, item }) => (noul >= c.corteFull ? 'full' : item.proposedTier),
    tetos: { full: c.maxFull },
  });
}

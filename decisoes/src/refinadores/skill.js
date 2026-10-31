// packages/decisions/src/refinadores/skill.js
//
// Refinador do anel `skill` (Task 7, spec 2026-09-20 §3.2/R9): decide quais HABILIDADES se
// aplicam ao turno. Sem seletor de corte — a lista de skills candidatas de um turno é
// sempre pequena (não tem o volume de capacidades/funções), então todas vão ao Jev, sujeitas
// só ao teto geral de `TETO_PERGUNTAS` do construtor. Escala mais restritiva que a 0,7/0,3
// do anel `provider` (sobe a full = ativar; 0,5–0,8 = sugerir como candidate; abaixo =
// descarta), com teto de apenas 1 `full` por turno — o kairos ativa no máximo uma skill por
// vez, e a ativada fica na memória de trabalho nos turnos seguintes.
//
// 0,8/0,5 (era 0,7/0,3), medido em 23/10 sobre 730 turnos reais: no período com descrição na
// pergunta (desde 21/10), ativação fora de hora caiu de 5 para 1 e sugestão fora de hora de 41
// para 15; toda habilidade que o Jev ativou e foi usada nas sessões de 23/10 teve nota ≥ 0,80.
// Não age quando o Jev estoura o prazo (o decisor local sugere sozinho) nem no semeio por fonte.
import { criarRefinadorJev } from './criar-refinador-jev.js';

export const PADRAO_SKILL = { corteFull: 0.8, corteCandidate: 0.5, maxFull: 1 };

/**
 * @param {object} p
 * @param {{decidir:Function}|null} p.cliente
 * @param {Partial<typeof PADRAO_SKILL>} [p.config] `config.prazoMs`, se presente, vence `p.prazoMs` só para este anel
 * @param {number} [p.prazoMs]
 * @param {(input: object) => object|null} [p.estadoDoHost]
 * @param {(t: object) => void} [p.aoChegarTarde] diagnóstico da resposta tardia (ver `criarRefinadorJev`)
 */
export function refinadorDeHabilidades({ cliente, config = {}, prazoMs, estadoDoHost, aoChegarTarde, aoChamarJev } = {}) {
  const c = { ...PADRAO_SKILL, ...config };
  return criarRefinadorJev({
    anel: 'skill',
    cliente,
    prazoMs: c.prazoMs ?? prazoMs,
    estadoDoHost,
    aoChegarTarde,
    aoChamarJev,
    config: c,
    seletor: (items) => items,
    pergunta: (it) => ({
      chave: `sk_${it.ref}`,
      texto: `Esta habilidade se aplica ao que o usuário pediu agora: ${it.ref}${it.meta?.description ? ` — ${it.meta.description}` : ''}? Verdadeiro só se aplicar.`,
    }),
    classificar: ({ noul }) => (noul >= c.corteFull ? 'full' : noul >= c.corteCandidate ? 'candidate' : 'discard'),
    tetos: { full: c.maxFull },
  });
}

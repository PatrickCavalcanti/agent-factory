// packages/decisions/src/refinadores/provider.js
//
// Refinador do anel `provider` (Task 7, spec 2026-09-20 §3.2/R9): decide quais CAPACIDADES
// (o candidato do anel `provider` do kairos) o turno realmente precisa. Manda os até 30
// primeiros por posição ao Jev (todos, se ≤30) e classifica pelo `noul` puro — diferente do
// anel `tool`, aqui não há "manter o proposto abaixo do corte": o objetivo do anel
// `provider` é justamente o Jev poder REBAIXAR a `discard` (R9) uma capacidade que o motor
// só incluiu por score, sem uso real neste turno.
import { criarRefinadorJev } from './criar-refinador-jev.js';
import { perguntaDeFuncao } from './tool.js';

// `corteFullContinuacao` (23/09, calibração de continuação — ver `classificar` abaixo): corte
// menor que `corteFull`, só para capacidades já carregadas na sessão (`input.state.loadedProviders`).
// 0,45 fica entre o mínimo medido de continuação real (0,49) e o máximo medido do caso de
// controle — pedido que troca de assunto de verdade (0,36) — com folga dos dois lados
// (`E:\tmp\diag-falha1-provider.mjs`, Jev real via Vercel, 3 casos × 2 repetições, 23/09).
export const PADRAO_PROVIDER = { corteFull: 0.7, corteCandidate: 0.3, corteFullContinuacao: 0.45, maxFull: 2, enviar: 30 };

/**
 * @param {object} p
 * @param {{decidir:Function}|null} p.cliente
 * @param {Partial<typeof PADRAO_PROVIDER>} [p.config] `config.prazoMs`, se presente, vence `p.prazoMs` só para este anel
 * @param {number} [p.prazoMs]
 * @param {(input: object) => object|null} [p.estadoDoHost]
 * @param {(t: object) => void} [p.aoChegarTarde] diagnóstico da resposta tardia (ver `criarRefinadorJev`)
 * @param {(capacidadeId: string) => Array<{ ref: string, descricao?: string, pinned?: boolean }>} [p.funcoesDe]
 *   Task 2 (2026-09-21-ajustes-de-uso-da-fabrica): catálogo de funções do host, por capacidade.
 *   Quando presente, o anel `provider` manda, NA MESMA chamada ao Jev, uma pergunta extra por
 *   função não-`pinned` e não hidratada (`input.state?.hydratedTools`) de cada capacidade
 *   enviada — a mesma pergunta que o anel `tool` (`perguntaDeFuncao`) faria depois, para que a
 *   resposta valha como cache lá. Correção do review da Fase 1 (#3): função já em
 *   `hydratedTools` também fica de fora — o anel `tool` já a exclui do próprio seletor
 *   (`meta.hasManual`), então perguntar de novo aqui só gravaria uma resposta no cache que
 *   nunca seria lida.
 *   22/09: além dos itens do anel, também cobre `input.state?.loadedProviders` — as capacidades
 *   de PISO (sempre carregadas pelo host, nunca candidatas deste anel) cujas funções, sem isto,
 *   nunca entravam no cache do turno (medição de 21/09, sessões `97c4bc58`/`3fae43e0`: 12-15 das
 *   18 funções por turno eram delas). Vêm DEPOIS das extras dos itens do anel (prioridade menor:
 *   o anel existe para decidir os itens; o piso é carregado de qualquer forma). Capacidade
 *   carregada que também é item do anel fica de fora aqui — já passou (ou passa) pela extra dos
 *   itens, perguntar de novo duplicaria.
 * @param {() => string[]} [p.capacidadesDePiso]
 *   23/09 (ajuste pontual): ids de capacidade de PISO conhecidos pelo HOST, independente de
 *   `input.state?.loadedProviders` — medição de 21/09 (sessões `40d6f594`/`27a76c4c`): no
 *   PRIMEIRO turno com refino de cada sessão, `state.loadedProviders` ainda não tem as
 *   capacidades de piso (é a descoberta quem as carrega), então as ~15 funções do piso
 *   (memória, redator, roteiros) não entravam na chamada de capacidades e o anel `tool`
 *   perguntava tudo de novo (15 perguntas, 0 cache). `capacidadesDePiso` cobre esse turno —
 *   entra ANTES das de `loadedProviders` (prioridade: itens do anel, depois piso do host,
 *   depois o que a descoberta já carregou). Mesmos filtros (`pinned`, `hydratedTools`); um id
 *   que esteja no anel, em `loadedProviders` E no piso entra só uma vez — dedup por `ref` E por
 *   `id` (capacidade já item do anel não é reconsultada aqui).
 * @param {{ gravar: (ref: string, noul: number) => void }} [p.cache] onde as respostas das
 *   extras (as funções) são gravadas, por `ref`, para o anel `tool` consumir depois.
 */
export function refinadorDeCapacidades({ cliente, config = {}, prazoMs, estadoDoHost, aoChegarTarde, funcoesDe, cache, capacidadesDePiso, aoChamarJev } = {}) {
  const c = { ...PADRAO_PROVIDER, ...config };
  // Ordem das extras: capacidades que o motor já propunha `full` primeiro (a prioridade que o
  // motor dá dentro do anel), depois as demais na ordem em que chegaram; dentro de cada
  // capacidade, a ordem do catálogo (`funcoesDe`). `pinned` fora: o motor já garante `full`
  // para pinned, perguntar de novo é desperdício.
  const perguntasExtras = typeof funcoesDe === 'function'
    // Correção do review da Fase 1 (#10): `aPerguntar`, não `enviados` — é o segundo parâmetro
    // que `criarRefinadorJev` passa a `perguntasExtras` (ver JSDoc de `p.perguntasExtras` em
    // `criar-refinador-jev.js`): os itens do anel que SOBRARAM depois do cache, não todo mundo
    // que o seletor mandou (parte deles já pode ter vindo do cache e nunca chegado aqui).
    ? (input, aPerguntar) => {
        // Correção do review da Fase 1 (#3): função já hidratada (`input.state.hydratedTools`)
        // não entra como extra — o anel `tool` já a exclui do seletor via `meta.hasManual`, e a
        // resposta do Jev para uma pergunta assim iria só para o cache, nunca seria lida.
        const hidratadas = new Set(input.state?.hydratedTools ?? []);
        const porTier = [...aPerguntar].sort((a, b) => (a.proposedTier === 'full' ? 0 : 1) - (b.proposedTier === 'full' ? 0 : 1));
        const dosItens = porTier.flatMap((cap) => (funcoesDe(cap.ref) ?? [])
          .filter((f) => !f.pinned && !hidratadas.has(f.ref))
          .map((f) => ({ ref: f.ref, capacidade: cap.ref, descricao: f.descricao ?? '', ...perguntaDeFuncao(f.ref, f.descricao) })));
        // 22/09: capacidades já carregadas (piso) que NÃO são item deste anel também entram como
        // extra, depois das dos itens — ver JSDoc de `p.funcoesDe` acima. `refsDosItens` evita
        // perguntar de novo por uma capacidade que já é item do anel (ela já passou pela extra
        // acima, via `aPerguntar`, ou vai passar quando sair do cache); `refsJaExtras` evita
        // duplicar um `ref` de função que apareceu nas duas listas (a mesma função de uma
        // capacidade carregada que também é candidata do anel).
        const refsDosItens = new Set(input.items.map((it) => it.ref));
        const refsJaExtras = new Set(dosItens.map((e) => e.ref));
        // 23/09 (ajuste pontual): capacidadesDePiso — ids de piso que o HOST já conhece, sem
        // depender de `input.state?.loadedProviders` (vazio no primeiro turno com refino da
        // sessão, ver JSDoc de `p.capacidadesDePiso` acima). Entra ANTES das de
        // `loadedProviders`: um id presente nas duas listas é coberto aqui, e `refsJaExtras`
        // (atualizado logo abaixo) evita a extra de `loadedProviders` repetir o mesmo `ref`.
        const idsPiso = (capacidadesDePiso?.() ?? []).filter((id) => !refsDosItens.has(id));
        const dasPiso = idsPiso.flatMap((id) => (funcoesDe(id) ?? [])
          .filter((f) => !f.pinned && !hidratadas.has(f.ref) && !refsJaExtras.has(f.ref))
          .map((f) => ({ ref: f.ref, capacidade: id, descricao: f.descricao ?? '', ...perguntaDeFuncao(f.ref, f.descricao) })));
        for (const e of dasPiso) refsJaExtras.add(e.ref);
        const dasCarregadas = (input.state?.loadedProviders ?? [])
          .filter((id) => !refsDosItens.has(id))
          .flatMap((id) => (funcoesDe(id) ?? [])
            .filter((f) => !f.pinned && !hidratadas.has(f.ref) && !refsJaExtras.has(f.ref))
            .map((f) => ({ ref: f.ref, capacidade: id, descricao: f.descricao ?? '', ...perguntaDeFuncao(f.ref, f.descricao) })));
        return [...dosItens, ...dasPiso, ...dasCarregadas];
      }
    : undefined;
  // As respostas das extras (funções) alimentam o cache que o anel `tool` consome depois no
  // mesmo turno — nunca lança (host não pode ver o refino do anel `provider` cair por causa
  // de uma gravação de cache).
  const aoResponderExtras = typeof cache?.gravar === 'function'
    ? (respostas) => { for (const [ref, n] of Object.entries(respostas)) cache.gravar(ref, n); }
    : undefined;
  return criarRefinadorJev({
    anel: 'provider',
    cliente,
    prazoMs: c.prazoMs ?? prazoMs,
    estadoDoHost,
    aoChegarTarde,
    aoChamarJev,
    config: c,
    perguntasExtras,
    aoResponderExtras,
    seletor: (items) => items.slice(0, c.enviar),
    pergunta: (it) => ({
      chave: `cap_${it.ref}`,
      texto: `Esta capacidade é necessária para responder a esta mensagem: ${it.ref}${it.meta?.description ? ` — ${it.meta.description}` : ''}? Verdadeiro só se for.`,
    }),
    // 23/09 (calibração, sessão b54c4434 — falha real medida): continuação curta do mesmo assunto
    // ("e a da OKDS?"/"e depois de amanhã?" depois de "o que tenho na agenda essa semana?")
    // rebaixava `google-calendar` mesmo já carregado — o motor propunha `discard` isolado (sem
    // contar o uso do turno anterior) e o Jev respondia `noul` 0,49–0,86, quase sempre abaixo do
    // corte `corteFull=0,7`. Diagnóstico real via Vercel (`E:\tmp\diag-falha1-provider.mjs`, 3
    // casos × 2 repetições): ACRESCENTAR uma nota ao TEXTO da pergunta sobre "já carregada" NÃO
    // desloca o `noul` de forma confiável (efeito dentro do ruído — às vezes sobe, às vezes desce,
    // ~±0,1) — descartado. O que discrimina bem é o próprio `noul` já respondido: nos dois casos
    // de continuação real, 0,49–0,86; no caso de CONTROLE (pedido que troca de assunto de verdade
    // para tarefas, mesmo com google-calendar em `loadedProviders`), 0,31–0,36 — folga clara dos
    // dois lados de um corte mais baixo. `corteFullContinuacao` (abaixo de `corteFull`, acima de
    // `corteCandidate`) só vale para itens JÁ CARREGADOS (`input.state.loadedProviders`,
    // `applySessionPolicy` do kairos — pegajoso entre turnos, distinto do `contexto.conversa` que
    // só é texto) — a barra para PERMANECER carregado é menor que a de entrar pela primeira vez,
    // sem virar um bypass incondicional (ainda pode cair a `candidate`/`discard` quando o Jev
    // reconhece troca de assunto de verdade, como o caso de controle mediu).
    classificar: ({ noul, item, input }) => {
      const jaCarregada = Array.isArray(input?.state?.loadedProviders) && input.state.loadedProviders.includes(item.ref);
      const corte = jaCarregada ? Math.min(c.corteFull, c.corteFullContinuacao) : c.corteFull;
      return noul >= corte ? 'full' : noul >= c.corteCandidate ? 'candidate' : 'discard';
    },
    tetos: { full: c.maxFull },
  });
}

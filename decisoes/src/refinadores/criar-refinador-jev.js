// packages/decisions/src/refinadores/criar-refinador-jev.js
//
// Construtor genérico de refinador de anel do kairos 0.833 (spec 4, §3.2/R9). O kairos chama,
// por anel, `refine(input) → { full, candidates, explain? }`: `input.items` é a lista ORDENADA
// INTEIRA do anel (com `proposedTier` do motor), `input.proposal` é o que o motor faria sozinho
// e `input.caps` os tetos do anel. Regra do motor (R2): o que o refinador NÃO citar em
// `full`/`candidates` vira `discard` — por isso este construtor sempre devolve os itens que não
// foram enviados ao Jev com o `proposedTier` que o motor já tinha proposto para eles (não é
// omissão: é o próprio refinador preservando a proposta do que não avaliou).
//
// Cada anel (Task 7: `provider.js`/`tool.js`/`skill.js`) só declara CONTEÚDO — quais itens
// perguntar (`seletor`), como formular a pergunta `noul` de cada um (`pergunta`) e como o
// `noul` de resposta vira tier (`classificar`) — este arquivo faz o mecanismo comum: monta o
// `state` do Jev (`cortarEstado`, mesmo teto de 16k chars da hidratação), faz UMA chamada
// `perguntar()` por anel (nunca mais de `TETO_PERGUNTAS`, o teto do núcleo), aplica o teto de
// `full` por turno (o que exceder é rebaixado a `candidate`, não descartado) e nunca lança:
// sem cliente, erro do cliente ou prazo estourado, `perguntar()` já devolve `meta.degradado` —
// aqui isso vira `explain[ref].reason = 'jev:degradado (<motivo>)'` e a proposta do motor segue
// intocada para os itens que seriam enviados.
import { cortarEstado, noul, perguntar, TETO_PERGUNTAS } from '../nucleo/index.js';

const TETO_CHARS_ESTADO = 16000;

function montarEstado({ anel, input, enviados, contexto, extras }) {
  const state = {
    pedido: input.query.text,
    anel,
    itens: enviados.map((it) => ({ ref: it.ref, posicao: it.position, proposto: it.proposedTier, descricao: it.meta?.description ?? '' })),
    ...(extras?.length ? { extras: extras.map((e) => ({ ref: e.ref, ...(e.capacidade ? { capacidade: e.capacidade } : {}), descricao: e.descricao ?? '' })) } : {}),
    ...(contexto ? { contexto } : {}),
  };
  cortarEstado(state, {
    tetoChars: TETO_CHARS_ESTADO,
    ordemDeCorte: [
      // Correção do review da Fase 1 (#1, 2026-09-21-ajustes-de-uso-da-fabrica): extras cortam
      // ANTES dos itens — são perguntas fora da lista do anel (ex.: funções de uma capacidade),
      // menos prioritárias que os próprios itens que o anel precisa classificar. `cortarEstado`
      // esgota cada rótulo NA ORDEM do array (while loop por rótulo); com `itens` primeiro o
      // corte sacrificava o que o anel existe para decidir antes de tocar nas extras.
      { rotulo: 'extras', cortar: () => (state.extras?.length ? (state.extras.pop(), true) : false) },
      { rotulo: 'itens', cortar: () => (state.itens.length > 1 ? (state.itens.pop(), true) : false) },
      { rotulo: 'contexto', cortar: () => (state.contexto ? (delete state.contexto, true) : false) },
    ],
  });
  return state;
}

/**
 * @param {object} p
 * @param {string} p.anel nome do anel (`ring`) — só para o `state` enviado ao Jev, não filtra nada
 * @param {{decidir:Function, modelo?:string}|null} p.cliente cliente de decisões (`null` = degrada)
 * @param {(items: object[], input: object) => object[]} p.seletor recorta, da lista inteira do
 *   anel, quem vai ser perguntado ao Jev (ex.: 30 primeiros por posição); o construtor ainda
 *   corta o resultado em `TETO_PERGUNTAS` (60) por segurança
 * @param {(item: object, input: object) => { chave: string, texto: string }} p.pergunta monta a
 *   pergunta `noul` (chave da resposta + instructions) para cada item enviado
 * @param {(ctx: { noul: number, item: object, input: object }) => 'full'|'candidate'|'discard'} p.classificar
 *   converte a resposta `noul` (0–1) do item em tier
 * @param {{ full?: number }} [p.tetos] teto de itens `full` por turno; o que exceder (por ordem
 *   de confiança) é rebaixado a `candidate`, nunca descartado
 * @param {number} [p.prazoMs] prazo macio da chamada ao Jev; default `input.budgetMs`
 * @param {(t: { anel: string, msReal: number, ms: number, degradado: false|string }) => void} [p.aoChegarTarde]
 *   (`ms` = prazo interno em que o refinador desistiu; `msReal` = quando a resposta chegou)
 *   diagnóstico: chamado quando a resposta do Jev chega DEPOIS do prazo interno (o turno já
 *   seguiu com `jev:degradado (timeout)`), com `msReal` = latência real da chamada. Sem ele o
 *   número morre aqui dentro e não dá para calibrar o orçamento por anel (medição de 21/09:
 *   `skill`/`tool` estouravam 550 ms em todo turno sem ninguém saber quanto levavam de fato)
 * @param {(input: object) => object|null} [p.estadoDoHost] contexto extra opcional para o `state`
 *   (ex.: providers já carregados); primeiro a cair no corte por teto de chars
 * @param {(input: object, aPerguntar: object[]) => Array<{ ref: string, chave: string, texto: string, descricao?: string, capacidade?: string }>} [p.perguntasExtras]
 *   Task 1 (2026-09-21-ajustes-de-uso-da-fabrica): perguntas extras, fora da lista de itens do
 *   anel, respondidas na MESMA chamada ao Jev (ex.: funções de uma capacidade, no anel
 *   `provider`). Cabem até `TETO_PERGUNTAS - aPerguntar.length`; o excedente é cortado do fim.
 *   Vão em `state.extras` (para o Jev ver a descrição) e em `questions[chave]`; nunca entram em
 *   `full`/`candidates`/`explain` do anel.
 * @param {(respostas: Record<string, number>) => void} [p.aoResponderExtras] recebe as respostas
 *   numéricas das extras (`{ [ref]: noul }`); só no caminho não degradado da chamada; nunca lança.
 * @param {(respostas: Record<string, number>) => void} [p.aoResponder] 22/09: recebe as respostas
 *   numéricas dos ITENS DO ANEL respondidas pelo Jev NESTA chamada (`{ [ref]: noul }`) — só quem
 *   veio do Jev agora, nunca os que já vieram do `cache` (esses não fizeram pergunta nova, não há
 *   nada de novo para gravar). Mesma garantia de `aoResponderExtras`: só no caminho não
 *   degradado, nunca lança (o host — ex.: o anel `tool` gravando no cache do turno — não pode
 *   derrubar o refino por causa disto). Pensado para o próprio anel gravar as respostas que ele
 *   mesmo pediu, de volta no `cache` que ele também lê — sem isto, uma segunda chamada ao MESMO
 *   anel no mesmo turno (ex.: o segundo `discover` do I3a) repetia toda pergunta já respondida.
 * @param {{ obter: (ref: string) => number|undefined }} [p.cache] respostas já conhecidas para
 *   itens DESTE anel — item com resposta no cache não vai ao Jev: é classificado direto com ela,
 *   `explain.reason` termina em `(cache)`. Se tudo sobrar do cache, o Jev não é chamado.
 * @param {(registro: { anel: string, tardia: boolean, chamouJev: boolean, itensEnviados: Array<{ref:string,posicao?:number,tierProposto?:string}>, itensDoCache: Array<{ref:string,noul:number}>, full?: string[], candidates?: string[], explain?: object, config?: object, state?: object, questions?: object, answers?: object, meta?: object }) => void} [p.aoChamarJev]
 *   Instrumentação completa do turno pela fábrica (2026-09-23, decisão do dono: "tudo que a
 *   fábrica faz tem que ir para o Tracer"): registro BRUTO de cada chamada ao Jev feita por este
 *   refinador — `state`/`questions`/`answers`/`meta` são exatamente o que `perguntar()` mandou e
 *   recebeu (nunca resumidos aqui; quem decide gravar tudo ou só o resumo é o HOST, na borda —
 *   `@igris/decisions` continua agnóstico do tracer). Chamado uma vez ao final de `refinar(input)`
 *   com `tardia: false` (mesmo quando `aPerguntar`/`extras` ficaram vazios — `chamouJev: false`,
 *   sem `state`/`questions`/`answers`/`meta`, só o resultado vindo do cache); e de novo, com
 *   `tardia: true`, se a resposta do Jev chegar DEPOIS do prazo interno deste refinador (mesmo
 *   evento que já alimentava `aoChegarTarde`, aqui com o corpo inteiro da resposta tardia). Nunca
 *   lança — observabilidade não pode derrubar o refino.
 * @returns {(input: object) => Promise<{ full: string[], candidates: string[], explain: object }>}
 */
// 23/09 (correção: "recarregar o poder no meio do turno refaz a análise inteira"):
// `packages/orchestrator/src/index.js` (`promoverNoTurno`) roda um SEGUNDO `bridge.prepareTurn`
// quando uma capacidade/skill é promovida no meio do turno (I3a ou o loop do Jev) — o kairos
// chama os refinadores de novo. Os anéis `provider`/`skill` já são memoizados por turno
// (`packages/executor/src/orchestration/fabrica/refinadores.js`, `ANEIS_MEMOIZAVEIS`): a mesma
// Promise da primeira chamada é reusada, este `refinar` nem roda de novo para eles. O anel
// `tool` NÃO é memoizável (o universo de funções cresce com a capacidade recém-carregada) — é o
// único que paga uma chamada nova ao Jev na promoção, só para os itens que ainda não têm
// resposta no cache do turno (as funções da capacidade que acabou de entrar).
// `promoverNoTurno` marca essa chamada com `ctx.__promocao = true` (cópia do `ctx`, nunca muta o
// original) antes de repassar ao `bridge.prepareTurn` — o `ctx` chega intacto a
// `RefineInput.ctx` (`context-manager/src/genos/bridge.ts` → `resolve/discover.ts:622`, l.706/
// 780/1141 desestruturam o mesmo `ctx` para cada anel). Com a marca presente: item já no cache
// segue IDÊNTICO (replay, `(cache)`); item SEM cache não vai ao Jev — mantém o `proposedTier` do
// motor (já em `tierDe`) e ganha `explain.reason = 'proposta do motor (promoção)'`, sem
// `confidence` (não houve voto). Sem a marca, nada muda: item sem cache vai para `aPerguntar`
// como sempre. Generalizado (não amarrado a `cache` existir): se um anel sem cache algum dia for
// chamado de novo numa promoção, a regra ainda vale — discover de promoção nunca abre pergunta
// nova ao Jev, só reaproveita o que já foi respondido.
export function criarRefinadorJev({ anel, cliente, seletor, pergunta, classificar, tetos = {}, prazoMs, estadoDoHost, aoChegarTarde, perguntasExtras, aoResponderExtras, aoResponder, cache, aoChamarJev, config: configDoAnel }) {
  return async function refinar(input) {
    const propostoDe = new Map(input.items.map((it) => [it.ref, it.proposedTier]));
    const tierDe = new Map(input.items.map((it) => [it.ref, propostoDe.get(it.ref)]));
    const enviados = (seletor(input.items, input) ?? []).slice(0, TETO_PERGUNTAS);
    const explain = {};
    const discoverDePromocao = Boolean(input.ctx?.__promocao);
    // Instrumentação completa (aoChamarJev acima): preenchido só dentro do bloco que de fato
    // chama `perguntar()` — permanece `null` quando tudo veio do cache (nenhuma chamada ao Jev).
    let chamadaJevBruta = null;

    // Cache por turno (host): item com resposta conhecida não vai ao Jev — classificado direto
    // com ela. `respondidos` alimenta o corte por `tetos.full` mais abaixo mesmo quando o Jev
    // não é chamado (tudo veio do cache).
    const respondidosPeloCache = [];
    const aPerguntar = [];
    for (const it of enviados) {
      const n = cache?.obter?.(it.ref);
      if (typeof n === 'number' && Number.isFinite(n)) {
        respondidosPeloCache.push({ it, n });
      } else if (discoverDePromocao) {
        // Discover de promoção sem resposta no cache: não pergunta de novo — mantém o
        // `proposedTier` do motor (já em `tierDe`, herdado de `propostoDe`) e só registra o
        // motivo. Mesmo tratamento de um item nunca enviado, mas explicitado no `explain`.
        explain[it.ref] = { reason: 'proposta do motor (promoção)' };
      } else {
        aPerguntar.push(it);
      }
    }
    const respondidos = [];
    for (const { it, n } of respondidosPeloCache) {
      const tier = classificar({ noul: n, item: it, input });
      tierDe.set(it.ref, tier);
      explain[it.ref] = { reason: `jev: noul ${n.toFixed(2)} (cache)`, confidence: n };
      respondidos.push({ ref: it.ref, noul: n, tier, proposedTierDoMotor: it.proposedTier });
    }

    // Extras (Task 1): cabem até a sobra do teto de perguntas depois dos itens a perguntar.
    const sobra = Math.max(0, TETO_PERGUNTAS - aPerguntar.length);
    const extras = (typeof perguntasExtras === 'function' ? (perguntasExtras(input, aPerguntar) ?? []) : []).slice(0, sobra);

    if (aPerguntar.length > 0 || extras.length > 0) {
      const itemPorRef = new Map(aPerguntar.map((it) => [it.ref, it]));
      const extraPorRef = new Map(extras.map((e) => [e.ref, e]));
      const contexto = estadoDoHost ? estadoDoHost(input) : null;
      const state = montarEstado({ anel, input, enviados: aPerguntar, contexto, extras });

      // F2 (review Fase 2): `questions` é montado A PARTIR de `state.itens` — depois de
      // `montarEstado` rodar `cortarEstado` sobre ele, nunca antes. `questions ⊆ state` é a
      // mesma regra de `packages/executor/src/orchestration/fabrica/decisor.js:154-209`: sob
      // pressão de tamanho (>16.000 chars) `cortarEstado` pode remover itens do fim de
      // `state.itens` para caber no teto; se `questions` fosse fechado com a lista `enviados`
      // (pré-corte), o Jev receberia pergunta sobre um item que já sumiu do `state` que ele
      // enxerga. Os itens cortados não entram em `questions` e mantêm o `proposedTier`
      // (via `tierDe`, já inicializado acima) — mesmo tratamento de "não enviado". Mesma regra
      // para `state.extras`: só as extras que sobreviveram ao corte viram `questions`.
      const questions = {};
      const chaveDe = new Map();
      const sobreviventes = [];
      for (const s of state.itens) {
        const it = itemPorRef.get(s.ref);
        const { chave, texto } = pergunta(it, input);
        questions[chave] = noul(texto);
        chaveDe.set(it.ref, chave);
        sobreviventes.push(it);
      }
      const extrasSobreviventes = [];
      for (const s of (state.extras ?? [])) {
        const e = extraPorRef.get(s.ref);
        questions[e.chave] = noul(e.texto);
        extrasSobreviventes.push(e);
      }

      // F1 (review Fase 2, corrigido no re-review): prazo interno SEMPRE abaixo do
      // `input.budgetMs` do kairos, por margem — nunca só quando `prazoMs` não é passado. O
      // motor (`context-manager/src/resolve/refiners.ts#runRefiner`) agenda o próprio timer —
      // `min(input.budgetMs, restante)` — num `Promise.race` ANTES de chamar `refinar(input)`;
      // se o nosso prazo aqui dentro empatasse (ou passasse) `input.budgetMs`, o
      // `fallback:timeout` do motor (que não carrega `explain`) sempre venceria a corrida por
      // ter começado primeiro, e a degradação informada (`jev:degradado (timeout)`, com
      // `explain` por item) nunca chegaria ao chamador. A fiação real (Task 12) passa
      // `prazoMs` explícito (ex.: 600) sempre — se usássemos `prazoMs ?? ...` puro, o clamp
      // nunca entraria e o empate voltaria. Por isso o `prazoMs` explícito é um TETO, não um
      // valor fixo: `Math.min` garante que o prazo interno nunca fica igual ou maior que o
      // prazo do motor, e um `prazoMs` explícito mais curto que o clamp continua valendo (ex.:
      // um chamador que já sabe que tem menos tempo pode pedir menos).
      // Piso PROPORCIONAL quando o orçamento é curto (onda 2 do `tool` pode chegar com poucas
      // dezenas de ms sobrando): com `max(50, budget - 50)` um budget de 30 ms virava 50 e o
      // timer do motor voltava a vencer. Metade do budget nunca iguala o budget.
      const MARGEM_MS = 50;
      const budget = input.budgetMs ?? 600;
      const clampDoMotor = budget > 2 * MARGEM_MS ? budget - MARGEM_MS : Math.max(1, Math.floor(budget / 2));
      const prazoInterno = Math.min(prazoMs ?? Infinity, clampDoMotor);
      // `perguntar` já mede a resposta tardia (`meta.msReal`) — repassa ao host como diagnóstico
      // puro: nunca lança, nunca muda o resultado deste refino (que já foi devolvido).
      const tardia = (r) => {
        if (typeof aoChegarTarde === 'function') {
          // `ms` = o prazo interno em que ESTE refinador desistiu (não o `meta.ms` da resposta
          // tardia, que é a latência real de novo — bug visto na sessão `61f9388b`, 21/09).
          try { aoChegarTarde({ anel, msReal: r?.meta?.msReal ?? null, ms: prazoInterno, degradado: r?.meta?.degradado ?? false }); } catch { /* diagnóstico nunca derruba nada */ }
        }
        // Instrumentação completa: a resposta tardia chega DEPOIS de `refinar(input)` já ter
        // devolvido (o turno seguiu com `jev:degradado (timeout)`) — por isso é um segundo
        // registro, `tardia: true`, com o corpo INTEIRO que chegou (estado/perguntas já são os
        // mesmos de `chamadaJevBruta`, capturados abaixo; a resposta é a nova).
        if (typeof aoChamarJev === 'function') {
          try {
            aoChamarJev({
              anel, tardia: true, chamouJev: true,
              itensEnviados: sobreviventes.map((it) => ({ ref: it.ref, posicao: it.position, tierProposto: it.proposedTier })),
              itensDoCache: respondidosPeloCache.map(({ it, n }) => ({ ref: it.ref, noul: n })),
              config: configDoAnel,
              state, questions, answers: r?.answers, meta: r?.meta,
            });
          } catch { /* observabilidade nunca derruba o refino */ }
        }
      };
      const { answers, meta } = await perguntar({ state, questions, cliente, prazoMs: prazoInterno, aoChegarTarde: tardia });
      chamadaJevBruta = { state, questions, answers, meta };

      if (meta.degradado) {
        for (const it of sobreviventes) explain[it.ref] = { reason: `jev:degradado (${meta.degradado})` };
        // Extras e itens do anel no caminho degradado: nenhuma resposta chegou a tempo —
        // `aoResponderExtras` e `aoResponder` não são chamados (a resposta tardia, se vier,
        // também não alimenta: `tardia` acima só repassa diagnóstico, nunca respostas de novo).
      } else {
        // 22/09: acumula as respostas NUMÉRICAS dos itens do anel respondidas pelo Jev nesta
        // chamada — só quem veio de verdade agora (não os do cache, que nem chegam a este
        // laço: já foram classificados antes, ver `respondidosPeloCache` acima) — para repassar
        // a `aoResponder` depois do laço (mesmo formato de `aoResponderExtras`: `{ ref: noul }`).
        const respostasDoAnel = {};
        for (const it of sobreviventes) {
          const resposta = answers?.[chaveDe.get(it.ref)];
          // F3 (review Fase 2, corrigido no re-review): chave ausente (ou `noul` não numérico)
          // não é voto — mantém o `proposedTier` (já em `tierDe`) e registra `jev:sem-resposta`
          // sem `confidence`. `noul: 0` explícito É um voto (resposta veio, o cliente disse
          // "não") e segue o caminho normal de classificação/rebaixamento; só a AUSÊNCIA de
          // resposta não pode rebaixar um `full` do motor sem decisão real por trás. O guard é
          // `typeof resposta?.noul !== 'number'`, não só `!Number.isFinite` — `{ noul: null }`
          // teria `Number(null) === 0`, um `0` finito que passaria como voto de "não" sem
          // nenhum número de verdade ter vindo do Jev.
          if (typeof resposta?.noul !== 'number' || !Number.isFinite(resposta.noul)) {
            explain[it.ref] = { reason: 'jev:sem-resposta' };
            continue;
          }
          const n = resposta.noul;
          const tier = classificar({ noul: n, item: it, input });
          tierDe.set(it.ref, tier);
          explain[it.ref] = { reason: `jev: noul ${n.toFixed(2)}`, confidence: n };
          respondidos.push({ ref: it.ref, noul: n, tier, proposedTierDoMotor: it.proposedTier });
          respostasDoAnel[it.ref] = n;
        }
        if (typeof aoResponder === 'function' && Object.keys(respostasDoAnel).length) {
          try { aoResponder(respostasDoAnel); } catch { /* host nunca derruba o refino */ }
        }
        // Task 1: respostas das extras que sobreviveram ao corte — só no caminho não degradado;
        // nunca lança (o host não pode ver o refino derrubar por causa de uma extra).
        if (typeof aoResponderExtras === 'function' && extrasSobreviventes.length) {
          const respostasExtras = {};
          for (const e of extrasSobreviventes) {
            const r = answers?.[e.chave];
            if (typeof r?.noul === 'number' && Number.isFinite(r.noul)) respostasExtras[e.ref] = r.noul;
          }
          if (Object.keys(respostasExtras).length) { try { aoResponderExtras(respostasExtras); } catch { /* host nunca derruba o refino */ } }
        }
      }
    }

    // Teto de `full` por turno: aplica sobre TODOS os respondidos (cache + Jev), mesmo quando o
    // Jev não foi chamado (tudo veio do cache) — por isso fica fora do bloco acima.
    const tetoFull = tetos.full ?? Infinity;
    // F3 (correção da revisão final do conjunto): ordena primeiro por quem o MOTOR já
    // propunha `full` (desc — `full` antes de `candidate`/`discard`), só depois por `noul`
    // desc. Antes, o corte era só por `noul` — um item que o motor já propunha `full` e o
    // Jev CONFIRMOU (noul acima do corte, mas nem sempre o maior) podia perder o lugar para
    // uma PROMOÇÃO do Jev (item que o motor propunha `candidate`/`discard` mas votou noul
    // mais alto). O motor (R2: "o refinador não citar em full/candidates vira discard") já
    // fez a triagem inicial; o teto do turno é para limitar QUANTOS itens novos o Jev pode
    // promover a `full`, não para desalojar quem o motor e o Jev já concordam que é `full`.
    const fulls = respondidos.filter((r) => r.tier === 'full').sort((a, b) => (
      (b.proposedTierDoMotor === 'full' ? 1 : 0) - (a.proposedTierDoMotor === 'full' ? 1 : 0)
      || b.noul - a.noul
    ));
    for (const r of fulls.slice(tetoFull)) tierDe.set(r.ref, 'candidate');

    const ordem = input.items.map((it) => it.ref);
    const confiancaDe = (ref) => explain[ref]?.confidence ?? -1;
    const porConfianca = (a, b) => confiancaDe(b) - confiancaDe(a) || ordem.indexOf(a) - ordem.indexOf(b);
    const full = ordem.filter((ref) => tierDe.get(ref) === 'full').sort(porConfianca);
    const candidates = ordem.filter((ref) => tierDe.get(ref) === 'candidate').sort(porConfianca);
    // Instrumentação completa: UM registro por chamada de `refinar(input)` (não por resposta
    // tardia, essa já foi registrada dentro de `tardia` acima) — cobre também o caminho todo-
    // cache (`chamadaJevBruta` continua `null`, `chamouJev: false`) e o degradado (`answers`/
    // `meta.degradado` vêm de `chamadaJevBruta` do jeito que `perguntar()` devolveu). `full`/
    // `candidates`/`explain` aqui já são os FINAIS deste refino — é o "tier final" pedido pela
    // instrumentação (spec 2026-09-23, decisão do dono).
    if (typeof aoChamarJev === 'function') {
      try {
        aoChamarJev({
          anel, tardia: false, chamouJev: Boolean(chamadaJevBruta),
          itensEnviados: enviados.map((it) => ({ ref: it.ref, posicao: it.position, tierProposto: it.proposedTier })),
          itensDoCache: respondidosPeloCache.map(({ it, n }) => ({ ref: it.ref, noul: n })),
          full, candidates, explain, config: configDoAnel,
          ...(chamadaJevBruta || {}),
        });
      } catch { /* observabilidade nunca derruba o refino */ }
    }
    return { full, candidates, explain };
  };
}

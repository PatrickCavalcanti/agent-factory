// B3.3, fase 2 — a pista de contexto chega ao RANKING REAL.
//
// Este arquivo tem duas peças, e as duas são LOCAIS AO TURNO:
//  1. `prepararPistaDeRanking` — valida a decisão vinda do host, calcula UM vetor
//     contextual extra e devolve `{ hints, vetores, diagnostico }`. Nunca muta os
//     arrays que recebeu.
//  2. `criarPonteDoTurno` — a fachada que intercepta `discover()` para entregar as
//     `hints` ao manager REAL do kairos (cuja ponte de genos não transporta `hints`)
//     e publicar a seleção no `aoSelecionarProviders` do host.
//
// NADA aqui é global, de sessão ou de catálogo: ponte e hints nascem em
// `executarTurno` e morrem com ele. O manager, o embedder, as refs e o cache
// continuam sendo os MESMOS objetos de sempre (montados uma vez por processo).
//
// Motivos de fallback, todos com o MESMO efeito — caminho original, sem hint
// lexical parcial: `sem-embedder`, `embedding-original-ausente`,
// `embedding-contextual-falhou`, `cancelado`.
import { createGenosBridge } from '@okds/kairos/genos';

// Teto de caracteres da pista inteira — o MESMO do helper de decisão
// (`packages/executor/src/orchestration/fabrica/pista-contexto.js#MAX_CHARS_PISTA`).
// Repetido aqui de propósito: o orquestrador NÃO depende do pacote do executor, e
// uma pista acima do teto é sinal de decisão corrompida, não de texto válido.
const MAX_CHARS_PISTA = 600;

/** Motivo novo, que só a orquestração acrescenta (os demais vêm do helper de T1). */
const MOTIVOS_DE_FALLBACK = new Set([
  'sem-embedder',
  'embedding-original-ausente',
  'embedding-contextual-falhou',
  'cancelado',
]);

/** Vetor utilizável pelo ranking: lista não vazia, toda finita. Mesma exigência do
 *  `asQueryVectors` do kairos, que DESCARTARIA um vetor assim e degradaria a
 *  consulta — aqui o descarte é decidido antes, com o motivo no diagnóstico. */
function vetorUtilizavel(vetor) {
  return Array.isArray(vetor)
    && vetor.length > 0
    && vetor.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** Mesma forma de vetor E mesmos valores — evita anexar ao discover um vetor que
 *  ele já pontua (a fusão é pelo MÁXIMO: duplicar não muda nada e polui `explain`). */
function mesmoVetor(a, b) {
  return vetorUtilizavel(a) && vetorUtilizavel(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Valida o SHAPE e os LIMITES da decisão antes de usar qualquer byte dela.
 * O orquestrador não decide elegibilidade (é o helper de T1): ele só recusa o que
 * não é decisão. Recusa conservadora — shape fora do contrato é o mesmo que não
 * haver pista, nunca uma pista pela metade.
 */
function validarDecisao(decisao) {
  if (!decisao || typeof decisao !== 'object') return false;
  if (typeof decisao.aplicar !== 'boolean') return false;
  if (typeof decisao.motivo !== 'string' || !decisao.motivo) return false;
  if (decisao.regra !== null && decisao.regra !== undefined && typeof decisao.regra !== 'string') return false;
  if (!Number.isInteger(decisao.mensagensUsadas) || decisao.mensagensUsadas < 0) return false;
  if (!Number.isInteger(decisao.chars) || decisao.chars < 0) return false;
  if (!decisao.aplicar) {
    // Decisão negativa: sem pista, sem mensagens, sem caracteres (contrato do helper).
    return decisao.pista === null || decisao.pista === undefined;
  }
  if (typeof decisao.pista !== 'string' || !decisao.pista.trim()) return false;
  // `chars` é a contagem da pista FINAL, separador incluído — divergir dela ou do teto
  // de 600 significa que a decisão não veio do helper (ou veio corrompida).
  return decisao.chars === decisao.pista.length && decisao.chars <= MAX_CHARS_PISTA;
}

/**
 * Aplica a decisão da pista ao RANKING do turno: valida, embeda a consulta
 * contextual (no máximo uma, e só quando o run é elegível) e devolve as `hints`
 * mais os vetores para o `discover`.
 *
 * @param {object} opcoes
 * @param {string} opcoes.texto `entrada.texto` ORIGINAL do turno — nunca reescrito.
 * @param {object} [opcoes.decisao] decisão do helper (`entrada.pistaDeContexto`).
 * @param {number[][]|null} [opcoes.vetores] vetores de consulta JÁ prontos deste run
 *   (host ou fábrica). Não é mutado: devolve um array novo só quando acrescenta.
 * @param {{ embed(text: string, role?: string): Promise<number[]>, modelSlug?: string }|null} [opcoes.embedder]
 * @param {AbortSignal} [opcoes.signal] o sinal de cancelamento do turno (`entrada.abortSignal`).
 * @param {Array<{ texto: string, vetor: number[] }>} [opcoes.jaEmbedadas] consultas que
 *   ESTE run já embedou (vetor 1 e o enriquecimento das fontes). Uma consulta idêntica
 *   reusa o vetor: sem embed novo e sem vetor duplicado.
 * @returns {Promise<{ hints: string[], vetores: number[][]|null, diagnostico: object }>}
 */
export async function prepararPistaDeRanking({ texto, decisao, vetores, embedder, signal, jaEmbedadas } = {}) {
  const diagnostico = {
    solicitada: false,
    aplicada: false,
    motivo: null,
    regra: null,
    mensagensUsadas: 0,
    chars: 0,
    // Tempo e quantidade do embedding CONTEXTUAL, medidos à parte: `embeds` do turno
    // (vetor 1 e enriquecimento das fontes) não pode absorver nem duplicar este número.
    embeds: { quantos: 0, ms: 0, erro: null },
  };
  // Nenhum caminho de fallback mexe em `vetores`/`hints` — devolve o que entrou.
  const semPista = () => ({ hints: [], vetores, diagnostico });

  // Sem decisão (o caso antigo, em que o host não sabe nada de pista) ou com decisão
  // fora do contrato: o turno segue EXATAMENTE como antes.
  if (!validarDecisao(decisao)) return semPista();
  diagnostico.motivo = decisao.motivo;
  diagnostico.regra = decisao.regra ?? null;
  diagnostico.mensagensUsadas = decisao.mensagensUsadas;
  diagnostico.chars = decisao.chars;
  // `solicitada` = houve pedido de continuidade real e a orquestração tentou aplicá-la.
  if (!decisao.aplicar) return semPista();
  diagnostico.solicitada = true;

  const fallback = (motivo) => {
    // Só os quatro motivos de fallback da interface substituem o motivo da decisão.
    if (MOTIVOS_DE_FALLBACK.has(motivo)) diagnostico.motivo = motivo;
    return semPista();
  };

  if (signal?.aborted) return fallback('cancelado');
  // Sem embedder não há como pontuar a consulta enriquecida: hint lexical viria sozinho
  // e mudaria o ranking por um caminho que o resto da decisão não levou.
  if (!embedder || typeof embedder.embed !== 'function') return fallback('sem-embedder');
  const vetorOriginal = Array.isArray(vetores) ? vetores[0] : null;
  if (!vetorUtilizavel(vetorOriginal)) return fallback('embedding-original-ausente');

  // Mesma concatenação que o kairos faz com `hints: [pista]` (`discover.js#discover`,
  // `const queryText = hints?.length ? \`${text} ${hints.join(' ')}\` : text`): o vetor
  // extra descreve a MESMA consulta que o discover vai ranquear.
  const consulta = `${texto} ${decisao.pista}`;
  const reuso = (Array.isArray(jaEmbedadas) ? jaEmbedadas : [])
    .find((item) => item?.texto === consulta && vetorUtilizavel(item.vetor));
  let vetorContextual = reuso?.vetor ?? null;

  if (!vetorContextual) {
    const t0 = Date.now();
    try {
      vetorContextual = await embedder.embed(consulta, 'query');
      diagnostico.embeds.quantos = 1;
    } catch (erro) {
      // Embedder instável não derruba o turno (mesma garantia dos embeds de `executarTurno`).
      diagnostico.embeds.erro = String(erro?.message ?? erro);
      vetorContextual = null;
    }
    diagnostico.embeds.ms += Date.now() - t0;
  }
  if (!vetorContextual) return fallback('embedding-contextual-falhou');
  // Cancelado no meio: a pista NÃO entra depois do sinal (o vetor extra também é
  // descartado — o turno continua com o que tinha).
  if (signal?.aborted) return fallback('cancelado');
  // Mesmo embedder, mesmo `role`, portanto mesma dimensão: vetor de outro tamanho é
  // descartado pelo `asQueryVectors` do kairos (e por bucket no `store`), então nem
  // chegaria ao ranking — melhor recusar aqui, com o motivo no diagnóstico.
  if (!vetorUtilizavel(vetorContextual) || vetorContextual.length !== vetorOriginal.length) {
    diagnostico.embeds.erro ??= `vetor contextual inutilizavel (dimensao ${Array.isArray(vetorContextual) ? vetorContextual.length : '?'} contra ${vetorOriginal.length})`;
    return fallback('embedding-contextual-falhou');
  }

  // Vetores de fontes/host: preservados. O contextual entra por ACÚSCULO (a fusão do
  // kairos é pelo MÁXIMO, então nenhum vetor anterior perde força) e nunca duplica.
  const jaPresente = Array.isArray(vetores) && vetores.some((vetor) => mesmoVetor(vetor, vetorContextual));
  const vetoresComPista = jaPresente ? vetores : [...(vetores ?? []), vetorContextual];
  diagnostico.aplicada = true;
  return { hints: [decisao.pista], vetores: vetoresComPista, diagnostico };
}

/**
 * Fachada do TURNO sobre o manager real.
 *
 * Por que uma fachada e não o manager: o `genos/bridge.js` instalado só repassa
 * `text`, `ctx`, `state`, `limits`, `turn`, `conversation`, `embedding(s)` para
 * `manager.discover()` — não existe `hints` em `PrepareTurnInput`, e o pacote
 * instalado não pode ser alterado. A interceptação acontece AQUI, no objeto que o
 * bridge recebe: as `hints` entram no `discover()` real e a seleção é publicada logo
 * depois do retorno, antes de o bridge renderizar qualquer bloco.
 *
 * `registry`/`store`/`emitter`/`reindex`/`prewarm`/`options` são os MESMOS objetos do
 * manager compartilhado (`createManager` devolve fechões, sem estado em `this`), então
 * a ponte enxerga o mesmo catálogo — nenhum manager novo, nenhum reindex por run.
 *
 * @param {object} opcoes
 * @param {object} opcoes.manager manager real do kairos (o do catálogo cacheado).
 * @param {Function} opcoes.can mesma função de permissão do catálogo.
 * @param {object|null} [opcoes.embedder]
 * @param {(info: {ctx: object, providers: string[], unchanged: boolean}) => void} [opcoes.aoSelecionarProviders]
 * @param {string[]} [opcoes.hints] hints do turno — vazio/ausente = o discover real
 *   recebe o input SEM o campo `hints` (o contrato antigo, byte a byte).
 * @param {boolean} [opcoes.trivial] decisão de trivialidade do host; só entra no discover
 *   quando for boolean (ausente = o kairos aplica `isTrivial(text)`).
 * @returns {{ manager: object, bridge: object, hints: string[] }}
 */
export function criarPonteDoTurno({ manager, can, embedder, aoSelecionarProviders, hints, trivial } = {}) {
  const hintsDoTurno = (Array.isArray(hints) ? hints : [])
    .filter((pista) => typeof pista === 'string' && pista.trim());
  // `trivial` (spec 2026-10-14 §4.1): decisão do HOST, injetada em TODO discover do turno (inicial e
  // promoções). Só quando o executor opinou — sem opinião, o input segue byte a byte e o kairos
  // aplica `isTrivial(text)`.
  const extras = {
    ...(hintsDoTurno.length ? { hints: hintsDoTurno } : {}),
    ...(typeof trivial === 'boolean' ? { trivial } : {}),
  };
  const temExtras = Object.keys(extras).length > 0;
  const managerDoTurno = {
    ...manager,
    async discover(input) {
      // `hints` só entra quando há pista: com o array vazio, o discover real recebe o
      // MESMO objeto de antes — nem um `hints: []` que o kairos leria como ausência.
      const output = await manager.discover(temExtras ? { ...input, ...extras } : input);
      const unchanged = output?.unchanged === true;
      // Publica ANTES do render: o bridge só monta blocos depois que este `discover()`
      // retorna, então quem recebe a seleção (o `ctx`, via o host) já a tem no read.
      aoSelecionarProviders?.({
        ctx: input?.ctx,
        // `unchanged`: o discover nem rodou (texto trivial) e `providers.load` volta
        // vazio DE PROPÓSITO (kairos `emptyOutput({ unchanged: true })`). O que continua
        // carregado é o `state.loadedProviders` do próprio `prepareTurn`.
        providers: unchanged ? [...(input?.state?.loadedProviders ?? [])] : [...(output?.providers?.load ?? [])],
        unchanged,
      });
      return output;
    },
  };
  return {
    manager: managerDoTurno,
    // `skillsActivation: 'host'` — mesmo valor que `montarCatalogo` usava: quem semeia a
    // skill no system é o host, nunca o kairos (R6 do porte dos poderes).
    bridge: createGenosBridge({ manager: managerDoTurno, can, embedder, skillsActivation: 'host' }),
    hints: hintsDoTurno,
  };
}

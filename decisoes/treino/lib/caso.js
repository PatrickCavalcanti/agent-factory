// Caso do turno para o treino contínuo (spec 2026-10-07): monta o caso a partir do artefato da fábrica,
// faz a triagem (válido ou não, e de que tipo) e a conferência (a cabeça trouxe o que foi usado?). Tudo puro.

import { capacidadeDoServidorMcp } from './mcp-servidor.js';

// Meta-tools do orquestrador: não são capacidades. `load_capability` é tratada à parte (é o erro certo).
export const META = new Set(['load_capability', 'call_capability', 'search_capabilities', 'load_bundle', 'load_skill']);
const ANEIS = ['provider', 'tool'];

/**
 * Carimbo da regra de COMPOSIÇÃO/conferência com que o caso foi gravado (spec 2026-10-07 de cortes e composição): cortes fixos por origem, cabeça
 * em todo o anel aprovado, vagas de full do provider para as capacidades novas e "trazidas" = full do local ∪ `ativasNoInicio`. A conferência
 * compara janelas antes × depois de cada versão da cabeça; se as janelas foram gravadas por regras diferentes (ou sem carimbo: casos
 * anteriores a ele), a diferença mistura a mudança de regra com a da versão — `atualizacoes[].comparavel` é `false` nesse caso. Troque o
 * valor SEMPRE que a regra que decide o que o local traz (ou como o caso conta "trazido") mudar de forma visível na conferência.
 *
 * v2: as vagas de full do provider mudaram em `6445922a4` (carregada = ativa ANTES do turno; a promoção do mesmo turno não abre 3ª vaga) sem trocar
 * o carimbo — a v1 cobria casos de antes e de depois dela, que não são da mesma regra. Casos v1 e v2 NÃO são comparáveis entre si: a janela
 * "antes" de uma versão da cabeça que os misture sai marcada como não comparável (`carimbos-diferentes`), em vez de atribuir à cabeça o
 * que foi mudança de regra.
 *
 * O v2 também traz a marca `notas[anel][ref].doMotor` (revisão do conjunto, C1) e o carimbo não foi trocado por isso: o v2 só existe nesta branch
 * (a `fabrica-chat` ainda grava v1), então um caso v2 sem a marca só existiria se um app rodasse esta branch entre o commit do carimbo e o da
 * marca. `cargaNovaDe` exige o carimbo atual no anel tool: caso v1 ou sem carimbo não separa o que o motor manteve em `full` e sai `null` (n/d).
 */
// v3 (10/10): D6 no anel provider (cabeça sozinha ≥ 0,60; de 0,25 a 0,60 só com o aval do Kairos) — muda o que o local traz.
export const REGRA_DO_CASO = 'cortes-composicao-v3';
/** De onde veio o turno: `chat` (o dono falando), `fundo` (execução em segundo plano), `debug`, `bancada` (instância de teste). */
export const ORIGENS_DO_CASO = Object.freeze(['chat', 'fundo', 'debug', 'bancada']);
const TRIVIAIS = new Set(['ok', 'sim', 'não', 'nao', 'pode', 'valeu', 'obrigado', 'obrigada', 'oi', 'beleza']);

const normalizarTexto = (t) => String(t ?? '').toLowerCase().normalize('NFC').replace(/[.,!?;:]+/g, ' ').trim().replace(/\s+/g, ' ');

/** Pedido vazio ou de uma/duas palavras da lista curta (ok, sim, valeu…): não carrega sinal de roteamento. */
export function ehTrivial(texto) {
  const t = normalizarTexto(texto);
  if (!t) return true;
  const palavras = t.split(' ');
  return palavras.length < 3 && palavras.every((p) => TRIVIAIS.has(p));
}

const unicos = (xs) => [...new Set(xs)];

/** Separação treino × avaliação: ~1 de cada 5 casos, determinística (FNV-1a de interactionId || ts). */
export const FRACAO_AVALIACAO = 5;
export function ehDeAvaliacao(chave) {
  let h = 0x811c9dc5;
  for (const ch of String(chave ?? '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % FRACAO_AVALIACAO === 0;
}

// `cap/tool/fn` e o nome exposto `cap__fn` (o que o modelo vê desde os nomes prefixados, 10/10 — `load_capability` pede assim) contam
// pela capacidade. Sem o `__`, `navegador__navegar` virava uma "capacidade" usada que nunca existiu. Nome cru de função (`okapp_entidades`)
// só o catálogo resolve: fica com o chamador (`capacidadesPedidasResolvidas`).
const capDaRef = (ref) => {
  if (ref.includes('/tool/')) return ref.slice(0, ref.indexOf('/tool/'));
  const k = ref.indexOf('__');
  return k > 0 && k + 2 < ref.length ? ref.slice(0, k) : ref;
};

/** Caso sem interactionId: ts + sessão + hash do texto (ou dos primeiros números do vetor). Mesma regra de `chaveDoCaso` (registro.js). */
function chaveDeCasoSemId({ ts, sessionId, texto, vetores }) {
  let h = 0x811c9dc5;
  for (const ch of String(texto ?? JSON.stringify((vetores?.[0] ?? []).slice(0, 16)))) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${ts}|${sessionId ?? ''}|${h.toString(16)}`;
}

const anel_decidido = (decisoes, anel) => Object.hasOwn(decisoes, anel);

/**
 * O que o turno de fato recebeu no anel, para a TRIAGEM e a CONFERÊNCIA: `trazidas[anel]` quando o caso a gravou (provider com
 * `ativasNoInicio` array: full ∪ ativas), senão `carregadas[anel]` (a decisão do local). O TREINO não usa isto: lê `carregadas`.
 */
export const trazidasDe = (caso, anel) => caso?.trazidas?.[anel] ?? caso?.carregadas?.[anel] ?? [];

/**
 * @param {{ts, sessionId?, interactionId?, texto?, vetores, operacoes, selecao, guardarTexto, ativasNoInicio?:string[]}} o
 * `selecao` = selecaoLocal serializada: `{ sombras: [{anel, principalDe, principal:{full,candidates}, sombraDe, sombra}] }`.
 * `ativasNoInicio` = capacidades já carregadas quando o turno COMEÇOU (`state.loadedProviders` da primeira chamada do anel
 * provider, vindo do trace da seleção). É a base do alvo "o que PRECISOU ENTRAR" (usadas − ativasNoInicio) na avaliação do
 * anel provider (spec 2026-10-07 §5). `[]` = capturado e nada estava ativo; `null` = NÃO capturado (caso de log, artefato antigo, ou
 * o anel provider não rodou o local no turno) — a avaliação então usa todas as usadas. Também compõe `trazidas.provider` (full do local ∪
 * ativas no início, só para triagem e conferência — NÃO entra em `carregadas`, que o treino lê).
 * Rótulo = o que o MODELO chamou OU o loop do Jev leu (operações `origem:'jev'` contam como uso — spec §3 — e ficam também
 * em `lidasPeloLoop`, para o relatório distinguir; leitura que falhou não conta). Nome cru de
 * função (sem `/tool/`) vai para `usadas.funcoesCruas`: resolver para capacidade exige o catálogo e fica com o
 * chamador (`mapaFuncoes` em treino-continuo.js).
 */
export function montarCaso({ ts, sessionId, interactionId, texto, vetores, operacoes, selecao, guardarTexto, embedderSlug = null, ativasNoInicio = null, origem = 'chat', kairos = null }) {
  const capacidades = []; const funcoes = []; const funcoesCruas = []; const pedidasPelaLlm = [];
  // Leituras do loop do Jev (`origem:'jev'`, só o `executar` do loop do orquestrador as produz) contam como USO — spec §3:
  // se o loop leu, a capacidade era necessária. Ficam também à parte (`lidasPeloLoop`) para o relatório distinguir.
  const loopCap = []; const loopFun = []; const loopCru = [];
  for (const op of operacoes || []) {
    if (!op) continue;
    if (op.origem === 'jev') {
      const n = String(op.nome ?? '');
      if (!n || op.ok === false || META.has(n)) continue; // leitura que falhou não leu
      const capSrv = capacidadeDoServidorMcp(op);
      if (capSrv) { capacidades.push(capSrv); loopCap.push(capSrv); continue; } // só a capacidade: o ref `mcp-<srv>/tool/<tool>` não existe no índice do anel tool
      if (n.includes('/tool/')) { funcoes.push(n); capacidades.push(capDaRef(n)); loopFun.push(n); loopCap.push(capDaRef(n)); } else { funcoesCruas.push(n); loopCru.push(n); }
      continue;
    }
    const nome = String(op.nome ?? '');
    if (nome === 'load_capability' || nome === 'load_bundle') {
      // Pedido da LLM: o que ela teve de pedir porque a seleção não trouxe. Ref `cap/tool/fn` conta pela capacidade.
      const refs = [...(Array.isArray(op.args?.refs) ? op.args.refs : []), ...(typeof op.args?.power === 'string' ? [op.args.power] : [])];
      for (const ref of refs) { if (typeof ref !== 'string' || !ref) continue; const cap = capDaRef(ref); pedidasPelaLlm.push(cap); capacidades.push(cap); }
      continue;
    }
    if (META.has(nome)) continue;
    const capServidor = capacidadeDoServidorMcp(op);
    if (capServidor) { capacidades.push(capServidor); continue; }
    if (nome.includes('/tool/')) { funcoes.push(nome); capacidades.push(nome.slice(0, nome.indexOf('/tool/'))); } else if (nome) funcoesCruas.push(nome);
  }
  const ativas = Array.isArray(ativasNoInicio) ? unicos(ativasNoInicio.filter((c) => typeof c === 'string' && c)) : null;
  // `carregadas[anel]` = SÓ o full do local (o que ele decidiu trazer): é o que o TREINO lê (negativo fraco = carregado e não usado — punir
  // capacidade que estava ativa e o local não decidiu seria ensinar a cabeça a "descarregar" o que é pegajoso). `trazidas[anel]` é o que o
  // turno de fato recebeu, para a TRIAGEM e a CONFERÊNCIA: no provider, full ∪ `ativasNoInicio` (quando array). A capacidade carregada
  // continua `full` no tier ("carregada nunca cai"), mas pode perder a VAGA de full para uma nova (refinador do provider) e ir para `candidates`
  // — o kairos a hidrata de qualquer jeito; sem a união ela contaria como "não trouxe" (erro-certo falso) e a carga deixaria de ser medida como
  // na regra antiga (carregada sempre em full). `ativasNoInicio` `null` (não capturado) não une nada e `trazidas.provider` não é gravada
  // (`trazidasDe` cai em `carregadas`). Decisão lê `trazidas`; treino lê `carregadas`.
  const trazidasProvider = (full) => (ativas ? unicos([...full, ...ativas]) : null);
  const trazidas = {};
  const registrarTrazidas = (anel, full) => { if (anel === 'provider') { const t = trazidasProvider(full); if (t) trazidas.provider = t; } };
  const carregadas = {}; const candidatas = {}; const sombraJev = {}; const notas = {}; const descartadas = {};
  // Decisão do LOCAL por anel (`selecao.decisoes`, registrada sempre, com ou sem Jev em sombra): é o que o local carregou.
  // A sombra serve só para `sombraJev` (o que o Jev teria trazido). Sem `decisoes` (artefato antigo), cai na sombra.
  const decisoes = selecao?.decisoes || {};
  for (const [anel, d] of Object.entries(decisoes)) {
    if (!d || d.degradado) continue; // degradado = proposta do motor, não decisão do local
    carregadas[anel] = [...(d.full || [])];
    registrarTrazidas(anel, d.full || []);
    candidatas[anel] = [...(d.candidates || [])];
    // ref → { nota, origem: 'base'|'cabeca'|'funcao', reason?, funcao?: {ref, nota} } — `reason` é o motivo cru do refinador (≤ 80 caracteres)
    // e `funcao` só existe na origem 'funcao' (a função que trouxe a capacidade, com a nota dela; `nota` é a da capacidade).
    if (d.notas && typeof d.notas === 'object') notas[anel] = { ...d.notas };
    // O que o local deixou FORA, com a nota (e as duas notas, cabeça e base, quando calculadas): revisão de cortes e retreino (10/10).
    if (d.descartadas && typeof d.descartadas === 'object') descartadas[anel] = { ...d.descartadas };
  }
  for (const s of selecao?.sombras || []) {
    if (!s?.anel) continue;
    const jev = s.principalDe === 'local' ? s.sombra : s.principal;
    if (jev && !(s.principalDe === 'local' ? s.degradadoSombra : s.degradadoPrincipal)) sombraJev[s.anel] = [...(jev.full || [])];
    if (anel_decidido(decisoes, s.anel)) continue;
    const local = s.principalDe === 'local' ? s.principal : s.sombra;
    carregadas[s.anel] = [...(local?.full || [])];
    registrarTrazidas(s.anel, local?.full || []);
    candidatas[s.anel] = [...(local?.candidates || [])];
  }
  // Vetores com 5 casas (como a reposição) e sempre arrays comuns (aceita Float32Array do embedder).
  // `vetores[0]` é o do PEDIDO (o lote usa só ele); a pista de contexto da B3.3, quando houver, vem depois.
  vetores = (Array.isArray(vetores) ? vetores : []).map((v) => Array.from(v, (x) => Math.round(x * 1e5) / 1e5));
  const caso = {
    versao: 1, regra: REGRA_DO_CASO, ts, sessionId, interactionId,
    chave: interactionId ? String(interactionId) : chaveDeCasoSemId({ ts, sessionId, texto, vetores }),
    // Calculado AQUI, antes de descartar o texto: a triagem não pode depender de `guardarTexto`.
    trivial: ehTrivial(texto),
    avaliacao: ehDeAvaliacao(interactionId || ts),
    slug: embedderSlug, dim: Array.isArray(vetores?.[0]) ? vetores[0].length : null,
    vetores,
    carregadas, trazidas, candidatas, notas,
    ativasNoInicio: ativas,
    usadas: { capacidades: unicos(capacidades), funcoes: unicos(funcoes), funcoesCruas: unicos(funcoesCruas) },
    pedidasPelaLlm: unicos(pedidasPelaLlm),
    lidasPeloLoop: { capacidades: unicos(loopCap), funcoes: unicos(loopFun), funcoesCruas: unicos(loopCru) },
    sombraJev,
    // Origem do turno (10/10): o treino escolhe quais origens valem (`IGRIS_CHAT_FABRICA_TREINO.origens`); o caso guarda sempre.
    origem: ORIGENS_DO_CASO.includes(origem) ? origem : 'chat',
  };
  // Sinal do Kairos por item (`kairosDoExplain`): insumo do retreino com o Kairos na entrada e da revisão de cortes.
  // No anel tool (~130 itens por turno) fica só o sinal dos refs que o caso cita (nota, descartada com nota, usada); o provider vai inteiro.
  if (kairos && typeof kairos === 'object') {
    const k = { ...kairos };
    if (k.tool) {
      const citados = new Set([...Object.keys(notas.tool || {}), ...Object.keys(descartadas.tool || {}), ...caso.usadas.funcoes]);
      k.tool = Object.fromEntries(Object.entries(k.tool).filter(([r]) => citados.has(r)));
    }
    caso.kairos = k;
  }
  if (Object.keys(descartadas).length) caso.descartadas = descartadas;
  if (guardarTexto) caso.texto = texto;
  return caso;
}

const arred4 = (x) => Math.round(x * 1e4) / 1e4;
/**
 * Sinal do Kairos por anel e ref, do `discover.explain` do turno: `{final, z, vetor, lexical, boost, proposta}` (números com 4 casas;
 * ausente fica fora). Só provider e tool. Puro; entrada inválida devolve null.
 */
export function kairosDoExplain(explain) {
  if (!Array.isArray(explain)) return null;
  const saida = {};
  for (const e of explain) {
    if (!e || (e.ring !== 'provider' && e.ring !== 'tool') || typeof e.ref !== 'string') continue;
    const s = e.scores || {};
    const k = {};
    for (const [de, para] of [['final', 'final'], ['z', 'z'], ['vector', 'vetor'], ['lexical', 'lexical'], ['boost', 'boost']]) if (Number.isFinite(s[de])) k[para] = arred4(s[de]);
    if (typeof e.proposedTier === 'string') k.proposta = e.proposedTier;
    (saida[e.ring] ??= {})[e.ref] = k;
  }
  return Object.keys(saida).length ? saida : null;
}

/**
 * Erro certo = o modelo usou ou teve de pedir o que o LOCAL não trouxe. Só vale nos anéis em que houve decisão local
 * (`carregadas[anel]` presente): anel em modo `jev` não tem full local e a ausência dele não é erro do local.
 */
function ehErroCerto(caso) {
  const prov = Array.isArray(caso.carregadas?.provider) ? trazidasDe(caso, 'provider') : undefined; // só vale com decisão local no anel
  const tool = Array.isArray(caso.carregadas?.tool) ? trazidasDe(caso, 'tool') : undefined;
  if (Array.isArray(prov)) {
    // Pedida pela LLM só é erro certo se a seleção NÃO a trouxe; pedir o que já veio carregado é uso normal.
    if ((caso.pedidasPelaLlm || []).some((c) => !prov.includes(c)) || (caso.usadas?.capacidades || []).some((c) => !prov.includes(c))) return true;
  } else if (Array.isArray(tool)) {
    if ((caso.usadas?.funcoes || []).some((f) => !tool.includes(f))) return true;
  }
  // Função usada que o anel tool não trouxe, de capacidade que o provider também não trouxe — é o caso das funções NÃO fixas de
  // capacidade piso (o piso está sempre no provider, mas as funções dele passam pela seleção do tool).
  if (Array.isArray(tool) && (caso.usadas?.funcoes || []).some((f) => !tool.includes(f) && !(Array.isArray(prov) ? prov : []).includes(capDaRef(f)))) return true;
  return false;
}

/** @returns {{valido:boolean, tipo?:'erro-certo'|'positivo'|'negativo', motivo?:string}} */
export function triar(caso) {
  if (typeof caso.trivial === 'boolean' ? caso.trivial : ehTrivial(caso.texto)) return { valido: false, motivo: 'trivial' };
  if (!Array.isArray(caso.vetores) || !caso.vetores.length) return { valido: false, motivo: 'sem-vetor' };
  if (caso.slug == null) return { valido: false, motivo: 'sem-slug' }; // sem o embedder que gerou o vetor não dá para saber se ele vale num índice
  if (!caso.carregadas || !Object.keys(caso.carregadas).length) return { valido: false, motivo: 'sem-selecao' }; // sem seleção local não há o que conferir
  const usadasCap = caso.usadas?.capacidades || [];
  const usouAlgo = usadasCap.length > 0 || (caso.usadas?.funcoes?.length ?? 0) > 0;
  const carregouAlgo = ANEIS.some((a) => trazidasDe(caso, a).length > 0);
  if (ehErroCerto(caso)) return { valido: true, tipo: 'erro-certo' };
  if (usouAlgo) return { valido: true, tipo: 'positivo' };
  if (carregouAlgo) return { valido: true, tipo: 'negativo' };
  return { valido: false, motivo: 'sem-sinal' };
}

const usadasDe = (caso, anel) => (anel === 'provider' ? caso?.usadas?.capacidades : caso?.usadas?.funcoes) || [];
// Capacidades que o turno usou (direto ou pela função): base da carga junto, neutra no anel tool.
const capsUsadasDe = (caso) => new Set([...(caso?.usadas?.capacidades || []), ...(caso?.usadas?.funcoes || []).map(capDaRef)]);

/**
 * Carga à toa NOVA: o que o LOCAL pôs em `full` POR NOTA e ninguém usou. No PROVIDER é a que o corte muda (subir o corte só tira). No TOOL é só
 * "o que o local trouxe pela nota": o teto de vagas de `full` (4) costuma estar cheio, e então subir o corte TROCA a função da vaga (uma proposta `full`
 * do kairos que a nota tinha deslocado volta) em vez de tirar carga — não se decide o corte por ela (C2 da revisão do conjunto; o efeito real do
 * corte no tool exige o contrafactual na origem, pendência). A `cargaAToa` (total) mistura isso com o que o local não decidiu e a conferência não
 * separava (revisão de 08/10, D2 e C1 da revisão do conjunto). Ficam FORA da nova:
 * - o que já estava ativo no início do turno (provider, `ativasNoInicio`: pegajosas);
 * - o que o motor segura em `full` independente da nota (`notas[anel][ref].doMotor`): a proposta `full` do kairos no tool (piso, capacidades já
 *   ativas, o que o 1º refine promoveu) e a carregada que nunca cai no provider — no TIER ficam `full` com qualquer nota e com o corte onde
 *   estiver; a VAGA de `full` do tool (teto 4) é que se disputa pela nota, e quem a perde vai a `candidates`, fora do prompt;
 * - o que não tem nota (fixo `pinned`/`hasManual` no tool, ref fora do índice nos dois anéis): o refinador o devolve em `full` sem avaliar;
 * - no tool, a carga junto (função não usada de capacidade usada) e as usadas.
 * - Provider: `carregadas` (o full do local) COM nota − `ativasNoInicio` − `doMotor` − usadas. `null` sem `ativasNoInicio` array (não capturado).
 * - Tool: refs do full do local COM nota − `doMotor` − usadas − carga junto. `null` em caso sem o carimbo atual (`regra !== REGRA_DO_CASO`: gravado
 *   antes da marca `doMotor`, não há como separar o que o motor manteve).
 * Nos dois anéis `null` também sem `notas[anel]` (caso anterior às notas, ou anel que o local não decidiu): n/d, nunca um número inventado.
 * Fonte única: `conferir()` (grava no caso) e a conferência (recalcula nos casos já gravados) usam esta função.
 * @returns {string[]|null}
 */
export function cargaNovaDe(caso, anel) {
  const full = caso?.carregadas?.[anel];
  if (!Array.isArray(full)) return null; // o local não decidiu neste anel
  const usadas = usadasDe(caso, anel);
  const notas = caso.notas?.[anel];
  if (!notas || typeof notas !== 'object') return null; // sem notas não dá para separar o que veio da nota do que o motor ou o refinador (fixo) devolveu
  const daNota = (r) => Object.hasOwn(notas, r) && notas[r]?.doMotor !== true; // tem nota e o motor não o segura em full
  if (anel === 'provider') {
    const ativas = caso.ativasNoInicio;
    if (!Array.isArray(ativas)) return null;
    return full.filter((r) => daNota(r) && !ativas.includes(r) && !usadas.includes(r));
  }
  if (caso.regra !== REGRA_DO_CASO) return null; // sem a marca `doMotor` (carimbo antigo, ou nenhum) a nota não separa o que o motor manteve
  const caps = capsUsadasDe(caso);
  return full.filter((r) => daNota(r) && !usadas.includes(r) && !caps.has(capDaRef(r)));
}

/**
 * O que o Jev em sombra teria entregue ao turno: o `full` dele; no provider, ∪ `ativasNoInicio` (o turno dele também receberia as capacidades já
 * ativas, como as `trazidas` do local). `null` = sem sombra do Jev no anel (o Jev não respondeu, degradou, ou o anel não rodou em sombra).
 * @returns {string[]|null}
 */
export function jevTrazidasDe(caso, anel) {
  const jev = caso?.sombraJev?.[anel];
  if (!Array.isArray(jev)) return null;
  return anel === 'provider' && Array.isArray(caso.ativasNoInicio) ? unicos([...jev, ...caso.ativasNoInicio]) : jev;
}

/**
 * O Jev em sombra teria trazido tudo o que foi usado e o local não? `null` sem sombra no anel — o turno fica FORA do denominador (revisão de
 * 08/10, D3): sem sombra o Jev não estava lá, e contar isso como "não foi melhor" lê a sombra que sumiu como "o local empata ou vence".
 * `false` com sombra e sem uso. Capacidade promovida por skill é neutra (o Jev também a receberia). Fonte única, como `cargaNovaDe`.
 * @returns {boolean|null}
 */
export function jevMelhorDe(caso, anel) {
  const jev = jevTrazidasDe(caso, anel);
  if (!jev) return null;
  const usadas = usadasDe(caso, anel);
  if (!usadas.length) return false;
  const local = trazidasDe(caso, anel);
  const promovidas = new Set(caso.promovidasPorSkill || []);
  return usadas.some((u) => !local.includes(u)) && usadas.every((u) => jev.includes(u) || promovidas.has(capDaRef(u)));
}

/**
 * Por anel: a cabeça trouxe o que o modelo usou? Quanto trouxe à toa? O Jev teria feito melhor?
 * `trouxeUsado` é null quando nada foi usado naquele anel. `cargaAToa` é o TOTAL (o que o turno recebeu e não usou, já ativas e fixas
 * incluídas — compatível com os casos já gravados); `cargaAToaNova` é a do local (`cargaNovaDe`; null = n/d). `jevMelhor` é null sem sombra do
 * Jev no anel (`comSombra: false`).
 */
export function conferir(caso) {
  const saida = {};
  for (const anel of ANEIS) {
    const usadas = usadasDe(caso, anel);
    const carregadas = trazidasDe(caso, anel); // o que o turno recebeu (provider: full ∪ ativas), não só a decisão do local
    const trouxeUsado = usadas.length ? usadas.every((u) => carregadas.includes(u)) : null;
    // Carga junto (neutra, só no anel tool): função carregada e não usada de uma capacidade que FOI usada no turno.
    // Funções pequenas da mesma capacidade vão juntas de propósito; não é carga à toa nem negativo.
    const capsUsadas = capsUsadasDe(caso);
    const naoUsadas = carregadas.filter((r) => !usadas.includes(r));
    const junto = anel === 'tool' ? naoUsadas.filter((r) => capsUsadas.has(capDaRef(r))) : [];
    saida[anel] = {
      trouxeUsado,
      cargaAToa: naoUsadas.filter((r) => !junto.includes(r)),
      cargaAToaNova: cargaNovaDe(caso, anel),
      cargaJunto: junto,
      comSombra: Array.isArray(caso.sombraJev?.[anel]),
      jevMelhor: jevMelhorDe(caso, anel),
    };
  }
  return saida;
}

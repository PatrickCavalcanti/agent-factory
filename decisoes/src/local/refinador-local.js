// packages/decisions/src/local/refinador-local.js
// RingRefiner local (spec 2026-10-07 §3). `obterEstado()` é chamado a cada refine e devolve
//   {indice, cortes:{cabeca:{full,candidate}, base:{full,candidate}, promocao},
//    cabeca:{cabeca:<pesos>, anelAprovado:boolean, nTreinoPorCapacidade:Record<string,number>}|null,
//    funcaoTraz:{ativo,n,candidata,promoverFull}, minCasosCapacidade:number, tetoProvider?:number, ativasNoInicio?:string[]|null}
// ou {indice:null, motivo}. `obterEstadoDe(outroAnel)` devolve o estado do outro anel (mesma forma) ou null — é por
// ele que o `tool` sabe em que caminho está o `provider` (D4a, consultado só se algum item precisa) e que o `provider` pontua as
// funções (D4b). O `explain` de `local:funcao-trouxe` leva `funcao: {ref, nota}` (a função que trouxe a capacidade).
// Nunca lança: qualquer falha devolve a proposta do motor com `local:degradado (<motivo>)`, igual ao refinador do Jev.
//
// Composição:
//  D1  Estado do anel (`estadoDoAnel`): 'cabeca' se a versão em uso foi aprovada pelo portão POR ANEL (e o anel não é skill),
//      senão 'base'. Na cabeça, TODO item recebe a nota da cabeça (probabilidade, escala única); na base, a nota base
//      (cosseno centrado, texto + exemplos). Não há mais mistura de escalas numa lista.
//  D2  Cortes FIXOS vindos do estado (`cortes.cabeca` ou `cortes.base` conforme o caminho); o histórico não decide corte.
//  D5  Na cabeça, capacidade com poucos casos (`< minCasosCapacidade` — não treinada, ex.: servidor MCP externo) vale o MAIOR nível
//      entre a cabeça e a base, nos dois degraus: a cabeça nunca rebaixa o que a base daria, só pode subir (dono, 09/10: ela melhora
//      com os dados do usuário e um dia passa a base). Cabeça `discard` + base `candidate` dá `candidate`; cabeça `candidate` + base
//      `full` dá `full`. Quando a base vence, o item vai pela base (`via: 'base-d5'`) e fica depois dos itens do caminho da cabeça.
//  Carregada NO TURNO (anel tool): capacidade em `state.loadedProviders` OU com algum item não-pinned de `proposedTier` ≠ `discard`
//      — é assim que o kairos marca as funções das capacidades que o provider acabou de trazer; só as `discard` são de fora.
//  D4a (anel tool) Função de capacidade NOVA (fora do turno) só é `full` com nota ≥ `cortes.promocao` (é o que dispara a P1 do
//      kairos); com `promoverFull: 'so-provider-na-base'` e o provider na cabeça — ou DESCONHECIDO (getter ausente, sem resposta,
//      índice montando, ou que lançou: na dúvida não promove) —, nunca é `full` (fica `candidate`, sem efeito no prompt; o
//      `reason` ganha o sufixo ` (promocao)`). Só o estado explícito do provider SEM cabeça (base) deixa promover.
//  Teto de promoção (anel tool) A P1 do kairos promove o provider de TODA função `full` de capacidade nova, sem olhar o teto de
//      full do anel provider. Se o estado traz `tetoProvider` (inteiro ≥ 0; ausente/null = SEM limite, o padrão), só as
//      `tetoProvider` capacidades NOVAS de maior nota podem ter função em `full`; as funções das excedentes viram `candidate` e o `reason` ganha o sufixo
//      ` (teto-promocao)`. Capacidades do turno não contam, e item de `proposedTier: 'full'` nunca é rebaixado.
//  D6  (anel provider, caminho da cabeça; `cortes.comKairos`, dono 10/10) A cabeça carrega SOZINHA só com nota ≥ `comKairos.full`
//      (0,60); de `comKairos.minimo` (0,25) até ali, só quando o Kairos também propôs `full` (`reason` ganha ` (com-kairos)`); o que o
//      par `cabeca` daria `full` sem o aval do Kairos fica `candidate`; abaixo do `candidate` do par, `discard`. A base, o D5 pela base e
//      o anel tool não mudam. `comKairos: null` desliga.
//  D4b (anel provider) Das `n` melhores capacidades que ficaram em `discard` e NÃO estão carregadas no turno (a carregada já tem o
//      tier do motor), a que tiver função ≥ `funcaoTraz.candidata` (pontuada pelo pontuador em uso no anel tool) sobe a `candidate`,
//      dentro de `caps.hard.maxCandidates`.
//
// TETOS OPCIONAIS (ajuste de 09/10): por padrão o local NÃO tem teto de vagas de `full` (provider/tool) nem de promoção — quem filtra é o
//  corte de nota. Teto explícito (`criarRefinadorLocal({tetoFull})`, `estado.tetoProvider`) segue funcionando, só não é o padrão. O anel
//  skill mantém o teto 1. `caps.hard.maxFull` do motor continua limitando.
//
// Marca `doMotor` (revisão do conjunto de 08/10, C1): o ref que TERMINOU em `full` e cujo `full` não depende da nota — o anel não rebaixa abaixo da
//  proposta do kairos (tool sempre; provider carregado, "nunca cai": ativa antes do turno ou promovida pela P1 no meio dele, que o 2º refine vê em
//  `loadedProviders`) e a proposta era `full` — leva `explain[ref].doMotor = true`, com QUALQUER nota (também a que passa do corte). É o motor que
//  o mantém: subir o corte não o tira do `full`, e a conferência (carga à toa NOVA = o que o local trouxe pela nota) não pode contá-lo como carga que o local
//  trouxe. Só entra em `explain` (o kairos copia dali apenas `reason`/`confidence` e ignora o resto, como já faz com `casou`/`funcao`); as listas
//  `full`/`candidates` não mudam. Ausente = o `full` veio da nota (proposta do kairos abaixo de `full`, D5, D4a). Quem perdeu a vaga de `full` e foi a
//  `candidates`, e os itens fixos (sem `explain`), não levam a marca.
//
// Montagem do resultado:
//  1. Itens FIXOS mantêm o `proposedTier`: os intocáveis (tool pinned/hasManual) e os sem nota (fora do índice, ou nota
//     não finita). O teto de full nunca os expulsa e eles NÃO consomem vaga do teto (igual ao refinador do Jev).
//  2. Os AVALIADOS disputam as `teto` vagas de full pela NOTA decrescente (quem o motor propunha não tem prioridade);
//     os que não vieram pelo caminho do anel (D5, ou queda para a base) vêm depois. Desempate por `position`
//     (ausente = Infinity), depois pela ordem de entrada. EXCEÇÃO no anel tool: as funções de capacidade do turno
//     (carregada, ou com item do motor fora de `discard`) vêm ANTES das de capacidade nova — a nova só usa a sobra do teto
//     (senão a nota ≥ 0,70 de uma capacidade nova empurrava para fora do prompt função que o provider acabou de trazer);
//     dentro de cada um dos dois grupos vale a ordem pela nota.
//     No anel PROVIDER, as capacidades já carregadas ANTES do turno (`e.ativasNoInicio`; sem ela, `state.loadedProviders`) disputam as
//     vagas DEPOIS das novas: seguem `full` no tier (carregada nunca cai), mas quem perde a vaga vai para `candidates` — o kairos
//     hidrata as carregadas de qualquer jeito. O que o 1º refine do turno pôs em full e o 2º já vê em `loadedProviders` NÃO é antiga.
//  3. O que perdeu a vaga de full vira candidate. `caps.hard` do motor limita o teto de full e o de candidates.
//  4. Saída: avaliados na mesma ordem, fixos por último (como o Jev).
import { consultaCentrada, pontuarNo } from './pontuador.js';
import { pontuarCabeca } from './cabeca.js';
import { capacidadeDoRef } from './refs.js';
import { FUNCAO_TRAZ_PADRAO } from './cortes-fixos.js';

/** Tetos de referência (o refinador do Jev e o anel skill os usam). O refinador LOCAL não os aplica a provider/tool por padrão: só com `tetoFull` explícito. */
export const TETOS_FULL = Object.freeze({ provider: 2, tool: 4, skill: 1 });
const ORDEM = { discard: 0, candidate: 1, full: 2 };
const MIN_CASOS_PADRAO = 50;

const posicaoDe = (it) => (Number.isFinite(it.position) ? it.position : Infinity);
const cortesValidos = (c) => c && Number.isFinite(c.full) && Number.isFinite(c.candidate);
const comKairosValido = (c) => c && Number.isFinite(c.full) && Number.isFinite(c.minimo);
const porPosicao = (a, b) => (a.pos !== b.pos ? (a.pos < b.pos ? -1 : 1) : a.ordem - b.ordem); // Infinity - Infinity daria NaN
const melhorQue = (a, b) => (a.nota !== b.nota ? a.nota > b.nota : porPosicao(a, b) < 0); // nota maior; empate: position/ordem

/** Caminho de pontuação de um anel dado o estado dele: a cabeça só vale com versão aprovada pelo portão do anel (e nunca em skill). */
export const estadoDoAnel = (e, anel) => (e?.cabeca?.cabeca && e.cabeca.anelAprovado && anel !== 'skill' ? 'cabeca' : 'base');

function degradar(input, motivo) {
  const explain = {};
  for (const it of input?.items || []) explain[it.ref] = { reason: `local:degradado (${motivo})` };
  return { full: [...(input?.proposal?.full || [])], candidates: [...(input?.proposal?.candidates || [])], explain };
}

function nivel(nota, cortes) {
  if (nota >= cortes.full) return 'full';
  if (nota >= cortes.candidate) return 'candidate';
  return 'discard';
}

/** Teto de full efetivo: inteiro ≥ 0 explícito vale; ausente/null = sem limite (provider e tool); o anel skill mantém o teto 1. */
const tetoEfetivo = (anel, tetoFull) => (Number.isInteger(tetoFull) && tetoFull >= 0 ? tetoFull : (anel === 'skill' ? TETOS_FULL.skill : Infinity));

export function criarRefinadorLocal({ anel, obterEstado, obterEstadoDe = null, tetoFull = null }) {
  const tetoDoAnel = tetoEfetivo(anel, tetoFull);
  return async function refinarLocal(input) {
    try {
      const e = obterEstado(input);
      if (!e?.indice) return degradar(input, e?.motivo || 'sem-indice');
      const cf = e.cortes;
      if (!cortesValidos(cf?.cabeca) || !cortesValidos(cf?.base) || !Number.isFinite(cf?.promocao)) return degradar(input, 'sem-cortes-fixos');
      const vetores = input.query?.vectors;
      const consulta = consultaCentrada(e.indice, vetores);
      if (!consulta.length) return degradar(input, 'sem-vetor-de-consulta');

      // A consulta é centrada pela média do PRÓPRIO índice: cada estado (anel) tem a sua.
      const consultas = new Map([[e.indice, consulta]]);
      const consultaDe = (est) => {
        if (!consultas.has(est.indice)) consultas.set(est.indice, consultaCentrada(est.indice, vetores));
        return consultas.get(est.indice);
      };

      // O estado do OUTRO anel é só contexto: getter ausente, sem resposta ou que lança vira null — o anel não degrada por isso.
      const outro = (a) => { try { return obterEstadoDe?.(a, input) ?? null; } catch { return null; } };
      const estado = estadoDoAnel(e, anel); // 'cabeca' | 'base'
      // D4a: em que caminho está o provider. Só o estado EXPLÍCITO e sem cabeça é 'base'; desconhecido conta como cabeça (não promove).
      // PREGUIÇOSO: o getter só é consultado quando um item precisa da resposta — uma função de capacidade fora do turno que chegaria a
      // `full` com `promoverFull: 'so-provider-na-base'` — e no máximo uma vez por refine. Refine sem nenhum item assim não toca o
      // outro anel (nem inicia a montagem dele).
      let estadoProviderMemo = null;
      const estadoProvider = () => {
        if (estadoProviderMemo === null) {
          const ep = outro('provider');
          estadoProviderMemo = ep?.indice ? estadoDoAnel(ep, 'provider') : 'cabeca';
        }
        return estadoProviderMemo;
      };
      const ft = { ...FUNCAO_TRAZ_PADRAO, ...(e.funcaoTraz || {}) };
      const minCasos = Number.isFinite(e.minCasosCapacidade) ? e.minCasosCapacidade : MIN_CASOS_PADRAO;
      const carregados = new Set(Array.isArray(input?.state?.loadedProviders) ? input.state.loadedProviders : []);
      // "Carregada neste turno" (tool): o kairos marca `discard` só as funções das capacidades FORA do turno; as que o provider
      // acabou de trazer chegam como full/candidate mesmo sem estar em `loadedProviders` (pinned é full em qualquer capacidade: não vale).
      const noTurno = new Set(carregados);
      if (anel === 'tool') for (const it of input.items || []) if (!it.meta?.pinned && it.proposedTier !== 'discard') noTurno.add(capacidadeDoRef(anel, it.ref));
      const carregadaNoTurno = (cap) => noTurno.has(cap);
      const teto = Math.min(tetoDoAnel, input.caps?.hard?.maxFull ?? Infinity);
      const maxCandidates = input.caps?.hard?.maxCandidates ?? Infinity;
      const explain = {};
      const fixos = [];
      const avaliados = [];

      const notaCabeca = (ref, est, q) => {
        const centroide = est.indice.nos.get(ref)?.centroide;
        if (!centroide) return null;
        let melhor = -Infinity;
        for (const s of q) melhor = Math.max(melhor, pontuarCabeca(est.cabeca.cabeca, s, centroide));
        return Number.isFinite(melhor) ? melhor : null;
      };
      const notaBase = (ref, est, q) => {
        const b = pontuarNo(est.indice, q, ref);
        return b && Number.isFinite(b.nota) ? b : null;
      };
      // Pontua um ref no estado `est` pelo caminho do anel `anelDe`; devolve {nota, cortes, reason, casou, via} ou null.
      // Cabeça sem centroide (ou nota não finita) cai na base daquele item.
      const pontuar = (ref, est, anelDe) => {
        const q = consultaDe(est);
        if (!q.length) return null;
        if (estadoDoAnel(est, anelDe) === 'cabeca') {
          const n = notaCabeca(ref, est, q);
          if (n !== null) return { nota: n, cortes: est.cortes?.cabeca, reason: 'local:cabeca', casou: 'cabeca', via: 'cabeca' };
        }
        const b = notaBase(ref, est, q);
        return b ? { nota: b.nota, cortes: est.cortes?.base, reason: `local:base (${b.casou})`, casou: b.casou, via: 'base' } : null;
      };

      // D6 (provider, caminho da cabeça): a cabeça carrega sozinha só com nota ≥ `comKairos.full`; de `comKairos.minimo` até ali, só se o
      // Kairos também propôs `full`; fora disso, o que o par `cabeca` daria `full` fica `candidate`. Sem `comKairos` (null), o par puro.
      const comKairos = anel === 'provider' && comKairosValido(cf.comKairos) ? cf.comKairos : null;
      const nivelDe = (p, it) => {
        if (!comKairos || p.via !== 'cabeca') return nivel(p.nota, p.cortes);
        if (p.nota >= comKairos.full || (p.nota >= comKairos.minimo && it.proposedTier === 'full')) return 'full';
        const n = nivel(p.nota, p.cortes);
        return n === 'full' ? 'candidate' : n;
      };

      (input.items || []).forEach((it, ordem) => {
        const pos = posicaoDe(it);
        if (anel === 'tool' && (it.meta?.pinned || it.meta?.hasManual)) { fixos.push({ ref: it.ref, tier: it.proposedTier, pos, ordem }); return; }
        const cap = capacidadeDoRef(anel, it.ref);
        let p = pontuar(it.ref, e, anel);
        // As DUAS notas vão ao explain (10/10: revisão de cortes e retreino): no caminho da cabeça, a base também é calculada.
        const notaCabecaDoItem = p?.via === 'cabeca' ? p.nota : null;
        const bDoItem = p?.via === 'cabeca' ? notaBase(it.ref, e, consulta) : null;
        // D5: pouca história → vale o maior nível entre cabeça e base (a cabeça só sobe, nunca rebaixa o que a base daria)
        if (p && p.via === 'cabeca' && (e.cabeca.nTreinoPorCapacidade?.[cap] ?? 0) < minCasos && nivelDe(p, it) !== 'full') {
          const b = bDoItem;
          if (b && ORDEM[nivel(b.nota, cf.base)] > ORDEM[nivelDe(p, it)]) p ={ nota: b.nota, cortes: cf.base, reason: `local:base (${b.casou})`, casou: b.casou, via: 'base-d5' };
        }
        if (!p) { fixos.push({ ref: it.ref, tier: it.proposedTier, pos, ordem }); return; }

        let tier = nivelDe(p, it);
        // D4a (tool): função de capacidade NOVA (fora do turno) só vira full acima de `promocao` (é o que dispara a P1 do kairos)
        let reason = p.reason;
        if (comKairos && p.via === 'cabeca' && tier === 'full' && p.nota < comKairos.full) reason = `${reason} (com-kairos)`;
        if (anel === 'tool' && !carregadaNoTurno(cap) && tier === 'full') {
          const podeFull = ft.promoverFull === 'sempre' || (ft.promoverFull === 'so-provider-na-base' && estadoProvider() === 'base');
          if (!podeFull || p.nota < cf.promocao) { tier = 'candidate'; reason = `${reason} (promocao)`; }
        }
        // regras dos anéis: no local, tool nunca rebaixa e provider carregado nunca cai (o Jev rebaixa os dois
        // quando o corte dele fica abaixo — só o corte menor, nunca por regra de anel)
        // `doMotor`: onde a regra dos anéis vale (tool sempre; provider carregado) e a proposta do kairos é `full`, o `full` do ref NÃO depende da nota nem
        // do corte — com qualquer nota ele ficaria `full` do mesmo jeito. Só vale se ele terminar em `full` (abaixo).
        const naoRebaixa = anel === 'tool' || (anel === 'provider' && carregados.has(it.ref));
        const doMotor = naoRebaixa && it.proposedTier === 'full';
        if (naoRebaixa && ORDEM[tier] < ORDEM[it.proposedTier]) tier = it.proposedTier;
        explain[it.ref] = { reason, confidence: p.nota, casou: p.casou };
        if (Number.isFinite(notaCabecaDoItem)) explain[it.ref].notaCabeca = notaCabecaDoItem;
        const notaBaseDoItem = p.via === 'cabeca' ? bDoItem?.nota : p.nota;
        if (Number.isFinite(notaBaseDoItem)) explain[it.ref].notaBase = notaBaseDoItem;
        avaliados.push({ ref: it.ref, cap, nota: p.nota, tier, pos, ordem, via: p.via, proposto: it.proposedTier, doMotor });
      });

      // Capacidade NOVA (tool): fora do turno e sem item que o motor tenha proposto `full`. Usada no teto de promoção e na ordem das vagas.
      const novo = (a) => anel === 'tool' && a.proposto !== 'full' && !carregadaNoTurno(a.cap);

      // Teto de promoção (tool): a P1 do kairos carrega o provider de toda função full de capacidade nova, sem passar pelo teto de
      // full do anel provider. Só as `tetoProvider` capacidades novas de maior nota (a melhor função full de cada uma, desempate
      // por position) mantêm funções em full; as demais viram candidate. Capacidades do turno ficam fora da conta, e item que o
      // motor propôs `full` nunca é rebaixado por aqui (conta como carregado).
      if (anel === 'tool') {
        const tetoProvider = Number.isInteger(e.tetoProvider) && e.tetoProvider >= 0 ? e.tetoProvider : Infinity;
        const melhorPorCapacidade = new Map();
        for (const a of avaliados) {
          if (a.tier !== 'full' || !novo(a)) continue;
          const m = melhorPorCapacidade.get(a.cap);
          if (!m || melhorQue(a, m)) melhorPorCapacidade.set(a.cap, a);
        }
        const permitidas = new Set([...melhorPorCapacidade.values()].sort((x, y) => (melhorQue(x, y) ? -1 : 1)).slice(0, tetoProvider).map((a) => a.cap));
        for (const a of avaliados) {
          if (a.tier !== 'full' || !novo(a) || permitidas.has(a.cap)) continue;
          a.tier = 'candidate';
          explain[a.ref] = { ...explain[a.ref], reason: `${explain[a.ref].reason} (teto-promocao)` };
        }
      }

      // D4b (provider): função forte de uma capacidade descartada a traz como candidata
      if (anel === 'provider' && ft.ativo) {
        const et = outro('tool');
        if (et?.indice) {
          // Capacidade JÁ carregada no turno não entra: "carregada nunca cai" a mantém no tier proposto, então avaliá-la gastaria uma das `n`
          // posições (e uma vaga de `maxCandidates`) com o que o motor já tem — e empurraria para fora a descartada que a função poderia trazer.
          const descartadas = avaliados.filter((a) => a.tier === 'discard' && !carregados.has(a.ref)).sort((a, b) => b.nota - a.nota || porPosicao(a, b)).slice(0, ft.n);
          const alvo = new Set(descartadas.map((a) => a.ref));
          const funcoesPorCapacidade = new Map(); // agrupa os refs do tool por capacidade-alvo uma vez por chamada
          if (alvo.size) {
            for (const ref of et.indice.nos.keys()) {
              const cap = capacidadeDoRef('tool', ref);
              if (!alvo.has(cap)) continue;
              if (!funcoesPorCapacidade.has(cap)) funcoesPorCapacidade.set(cap, []);
              funcoesPorCapacidade.get(cap).push(ref);
            }
          }
          for (const a of descartadas) {
            let melhor = null;
            for (const ref of funcoesPorCapacidade.get(a.ref) || []) {
              const q = pontuar(ref, et, 'tool');
              if (q && (!melhor || q.nota > melhor.nota)) melhor = { ref, nota: q.nota };
            }
            if (melhor && melhor.nota >= ft.candidata) {
              a.tier = 'candidate';
              // `funcao` leva a função que trouxe a capacidade e a nota dela (o reason só a mostra com 3 casas); a `confidence` segue sendo a da capacidade.
              explain[a.ref] = { reason: `local:funcao-trouxe (${melhor.ref} ${melhor.nota.toFixed(3)})`, confidence: a.nota, casou: 'funcao', funcao: { ref: melhor.ref, nota: melhor.nota } };
            }
          }
        }
      }

      // Ordem: pela nota, só dentro de uma escala. Quem não veio pelo caminho do anel (D5, queda para a base) vai depois.
      // No anel tool, as funções do turno disputam as vagas de full ANTES das de capacidade nova (a nova só usa a sobra).
      const grupo = (a) => (a.via === estado ? 0 : 1);
      // No anel provider, as capacidades JÁ carregadas disputam as vagas de full DEPOIS das novas: elas seguem `full` no tier (carregada nunca
      // cai) mas, se perderem a vaga, vão para `candidates` sem prejuízo — o kairos hidrata as carregadas de qualquer jeito. Antes, duas
      // carregadas com nota alta ocupavam as duas vagas e uma capacidade nova acima do corte ficava de fora.
      // "Carregada" aqui = ativa ANTES do turno (`e.ativasNoInicio`, capturada pela seleção no 1º refine do provider), não a de
      // `state.loadedProviders` do refine corrente: o kairos refaz o `prepareTurn` (promoção) no mesmo turno, e nesse 2º refine as
      // capacidades que o 1º pôs em full já constam em `loadedProviders` — contá-las como carregadas deixava uma nova passar na
      // frente da que acabara de ganhar a vaga (3 capacidades full, teto 2). Sem trace (`ativasNoInicio` ausente) vale o state.
      const antigas = new Set(Array.isArray(e.ativasNoInicio) ? e.ativasNoInicio : (Array.isArray(input?.state?.loadedProviders) ? input.state.loadedProviders : []));
      const carregadaProvider = (a) => anel === 'provider' && antigas.has(a.ref);
      avaliados.sort((a, b) => Number(carregadaProvider(a)) - Number(carregadaProvider(b)) || Number(novo(a)) - Number(novo(b)) || grupo(a) - grupo(b) || b.nota - a.nota || porPosicao(a, b));
      fixos.sort(porPosicao);

      const full = fixos.filter((f) => f.tier === 'full').map((f) => f.ref);
      const candidates = fixos.filter((f) => f.tier === 'candidate').map((f) => f.ref);
      let fulls = 0; // só os avaliados consomem o teto; fixos ficam fora dele (igual ao refinador do Jev)
      for (const a of avaliados) {
        if (a.tier === 'full' && fulls < teto) { full.push(a.ref); fulls += 1; }
        else if (a.tier === 'full' || a.tier === 'candidate') candidates.push(a.ref);
      }
      // A marca só vai a quem TERMINOU em `full`: quem foi elevado pelo motor mas perdeu a vaga (teto de full) está em `candidates`, e não é carga de full.
      const terminouEmFull = new Set(full);
      for (const a of avaliados) if (a.doMotor && terminouEmFull.has(a.ref)) explain[a.ref].doMotor = true;
      // fixos por último na saída, como o Jev — o corte duro do motor pela cauda nunca corta um avaliado antes de um fixo.
      // Sort estável: dentro de cada grupo a ordem da disputa se mantém.
      const fixosSet = new Set(fixos.map((f) => f.ref));
      const porFixo = (x, y) => Number(fixosSet.has(x)) - Number(fixosSet.has(y));
      full.sort(porFixo); candidates.sort(porFixo);
      return { full, candidates: candidates.slice(0, maxCandidates), explain };
    } catch (err) {
      return degradar(input, `erro: ${err?.message ?? err}`);
    }
  };
}

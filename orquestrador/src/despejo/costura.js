// Costura do despejo (spec 2026-10-29 §4, §5): as regras que ligam os módulos puros ao turno. O orquestrador
// (`executarTurno`) e o avaliador de sessões antigas (`scripts/eval/despejo.mjs`) chamam estas MESMAS funções — o
// avaliador não reescreve nenhuma delas. Puras: não leem `config`, relógio nem estado global.
import { toolEhFixa } from '../capacidades.js';
import { refsAcompanhantes } from '../loop-do-turno.js';
import { registrarTurno, usosDoTurno } from './registro-de-uso.js';
import { alinharKairos, promoverNoKairos } from './kairos.js';
import { refsQueSobemJunto } from './sobe-junto.js';
import { herdarCauda, caudaParaOProximo } from './cauda.js';

const provDaRef = (ref) => ref.split('/')[0];

/**
 * A MESMA noção de `fixa` do resto do orquestrador (`toolEhFixa`), por ref `<capacidade>/tool/<nome>`.
 * Capacidade ou função desconhecida = não é fixa.
 */
export function refEhFixa(ref, capacidades) {
  const [capId, , ...resto] = ref.split('/');
  const cap = (capacidades ?? []).find((c) => c?.id === capId);
  const tool = cap?.tools?.find((t) => t?.name === resto.join('/'));
  return cap && tool ? toolEhFixa(tool, cap) : false;
}

/**
 * Sinal forte (spec §4.5/§5): a seleção trouxe a capacidade com convicção. É a MESMA régua para o que pode voltar à
 * cauda depois de descartado e para o que o despejo não pode tirar no turno.
 * @param {Map<string, any>} explainProvider entradas `explain` do anel `provider`, por ref (`refiner.confidence`, `scores.z`)
 * @param {{ cabeca: number, z: number }} limiares `config.sinalForte`
 * @returns {(capId: string) => boolean}
 */
export function criarSinalForte(explainProvider, limiares) {
  return (capId) => {
    const x = explainProvider.get(capId);
    return (x?.refiner?.confidence ?? 0) >= limiares.cabeca || (x?.scores?.z ?? 0) >= limiares.z;
  };
}

/**
 * "Sobe junto" no começo do turno (spec §4.2), só com a cauda ligada: fixas (e acompanhantes) de capacidade que JÁ está
 * no system chegam ao turno mesmo que o discover não as tenha hidratado.
 * @returns {string[]} refs
 */
export function sobeJuntoNaEntrada({ cauda, capacidades, carregados }) {
  return cauda ? refsQueSobemJunto({ capacidades, noSystem: new Set(carregados ?? []) }).refs : [];
}

/**
 * Proteção do despejo (spec §5): do que `descartaveis` marcou, sai só o que o turno não acabou de pedir.
 * - O loop do Jev trouxe a ref NESTE turno (executada, `paraOModelo`, intenção) ou é acompanhante DESSAS refs: o
 *   registro só vê o uso até o turno anterior, e despejar deixaria o modelo sem o manual que acabou de ganhar. Entram
 *   só as refs do loop — o pino da `fixa` (`tools.hydrate`) faria a acompanhante parecer "do loop" e a capacidade
 *   ociosa nunca sairia (R4).
 * - A seleção trouxe a capacidade com sinal forte agora: despejar tiraria o manual que o discover acabou de pedir.
 *
 * @param {{ marcadosBrutos: { capacidades: string[], funcoes: string[] }, refsDoLoop: Iterable<string>, capacidades: any[],
 *   hidratadas?: Iterable<string>, sinalForte: (capId: string) => boolean }} e
 *   `hidratadas` = `tools.hydrate` do discover deste turno (as `fixa` ficam de fora do filtro das funções).
 * @returns {{ marcados: { capacidades: string[], funcoes: string[] }, doLoop: Set<string>, capsDoLoop: Set<string>, protegidasPeloLoop: string[] }}
 *   `protegidasPeloLoop` = capacidades ociosas que só o loop salvou (diagnóstico).
 */
export function protecaoDoDespejo({ marcadosBrutos, refsDoLoop, capacidades, hidratadas = [], sinalForte }) {
  const refs = [...refsDoLoop];
  const doLoop = new Set([...refs, ...refsAcompanhantes({ capacidades, refs })]);
  const capsDoLoop = new Set([...doLoop].map(provDaRef));
  // `marcados.funcoes` é sempre vazio desde o R4 (só capacidade inteira sai), então este filtro hoje não muda nada;
  // fica para o dia em que `descartaveis` voltar a marcar função: hidratada agora com sinal forte não sai, mas a `fixa`
  // não conta (hidrata pelo pino, não pelo ranking).
  const hidratadasAgora = new Set([...hidratadas].filter((ref) => !refEhFixa(ref, capacidades)));
  const protegidasPeloLoop = marcadosBrutos.capacidades.filter((id) => capsDoLoop.has(id) && !sinalForte(id));
  const marcados = {
    capacidades: marcadosBrutos.capacidades.filter((id) => !capsDoLoop.has(id) && !sinalForte(id)),
    funcoes: marcadosBrutos.funcoes.filter((ref) => !doLoop.has(ref) && !(hidratadasAgora.has(ref) && sinalForte(provDaRef(ref)))),
  };
  return { marcados, doLoop, capsDoLoop, protegidasPeloLoop };
}

/**
 * Continuação curta (spec §4.1): a cauda do turno anterior vale por mais um turno quando este é continuação dele
 * ("posso enviar?" -> "sim"). Só com a cauda ligada. Os três sinais já existem no turno, nenhum é novo.
 * Vale também para a herança de habilidade do aceite de contribuição (spec 2026-10-29 aceite §3.3): `comportamento`
 * (`despejo.comportamento` ligado) é o segundo interruptor que liga a continuação curta; a regra dos três sinais é a mesma.
 * @param {{ cauda?: boolean, comportamento?: boolean, trivial: boolean, continuidade: boolean, pista: boolean }} e
 *   `continuidade`: veto de trivial por continuidade do host (`entrada.trivial === false` com `motivoTrivial`);
 *   `pista`: pista de contexto aplicada.
 */
export function ehContinuacaoCurta({ cauda, comportamento, trivial, continuidade, pista }) {
  return (Boolean(cauda) || Boolean(comportamento)) && (trivial === true || continuidade === true || pista === true);
}

/** Cauda do turno = a própria + a herdada do turno anterior (só em continuação curta). */
export function caudaDoTurnoComHerdada({ continuacaoCurta, estadoDoDespejo, propria, system }) {
  return herdarCauda({
    anterior: continuacaoCurta ? (estadoDoDespejo.caudaAnterior ?? []) : [],
    propria,
    system,
  });
}

/**
 * Uso do turno (spec §4.2): o que o MODELO executou (`usosDoTurno`) mais o que ele carregou por `load_capability`
 * (conta como uso mesmo que a função já viesse na seleção).
 * @param {{ operacoes: any[], recusadas?: Set<string>, nomeParaRef: Map<string, string>, carregadasPeloModelo?: Array<{ ref: string, capId: string }> }} e
 */
export function usadasDoTurno({ operacoes, recusadas, nomeParaRef, carregadasPeloModelo = [] }) {
  const usadas = [...usosDoTurno({ operacoes, recusadas, nomeParaRef })];
  for (const c of carregadasPeloModelo) if (!usadas.some((u) => u.ref === c.ref)) usadas.push(c);
  return { usadas, usadasRefs: new Set(usadas.map((u) => u.ref)), usadasCaps: new Set(usadas.map((u) => u.capId)) };
}

const comManual = (system) => new Set(system.capacidades.flatMap((c) => c.funcoes.filter((f) => f.manual).map((f) => f.ref)));

/**
 * Fecho do turno (spec §4.2, §4.4, §4.5, §5.3): alinha o Kairos ao system, promove o que o modelo usou (com o que sobe
 * junto), registra o uso e guarda a cauda que vale para o próximo turno.
 *
 * @param {object} e
 * @param {any} e.kairos estado do Kairos já fechado pela política de sessão do turno
 * @param {any} e.estadoDoDespejo estado do despejo DEPOIS do descarte do turno (`registrarDescarte`, se disparou)
 * @param {{ capacidades: any[] }} e.system o system do turno, já sem o que o despejo tirou
 * @param {string} e.systemEnviado o system renderizado que foi enviado (base da conta do próximo turno)
 * @param {Array<{ id: string, funcoes: any[] }>} e.cauda cauda PRÓPRIA do turno (`separarCauda`)
 * @param {Array<{ id: string, funcoes: any[] }>} e.caudaDoTurno própria + herdada
 * @param {string[]} e.cortadasPorSinal capacidades que o corte por sinal fraco tirou da cauda
 * @param {{ capacidades: string[], funcoes: string[] }} e.despejadas o que o despejo tirou (vazio se não disparou)
 * @param {Array<{ ref: string, capId: string }>} e.usadas
 * @param {Set<string>} e.providersDoModelo capacidades que o modelo carregou no turno
 * @param {any[]} e.capacidades capacidades declaradas (para o "sobe junto")
 * @param {boolean} e.caudaLigada cauda ligada (`config.despejo.cauda`): só então há "sobe junto"
 * @param {number} e.m limiar de cauda sem uso
 * @param {number} e.turno número do turno
 * @returns {{ kairos: any, estadoDoDespejo: any, sobeJunto: string[] }}
 */
export function fecharTurnoDoDespejo({
  kairos, estadoDoDespejo, system, systemEnviado, cauda: propria, caudaDoTurno, cortadasPorSinal = [],
  despejadas, usadas, providersDoModelo = new Set(), capacidades, caudaLigada, m, turno,
}) {
  const usadasRefs = new Set(usadas.map((u) => u.ref));
  const usadasCaps = new Set(usadas.map((u) => u.capId));
  // Só capacidade que NÃO está no system sai de `loadedProviders`: uma capacidade do system pode ter manual novo na
  // cauda (corte de carregada deixou passar) e continua carregada.
  const noSystemAgora = new Set(system.capacidades.map((c) => c.id));
  const sobreviveu = (id) => usadasCaps.has(id) || providersDoModelo.has(id);
  const caudaFora = propria.filter((c) => !noSystemAgora.has(c.id) && !sobreviveu(c.id));
  // Cortada por falta de sinal forte: o `separarCauda` a tirou da cauda, mas o discover já a pusera no estado — sem tirar
  // daqui, o manual entraria no system no turno seguinte sem ter sido usado. Mesmas exceções de `caudaFora`.
  const cortadasFora = cortadasPorSinal.filter((id) => !noSystemAgora.has(id) && !sobreviveu(id));
  // Despejo (§5.3): o que saiu do system sai do Kairos — salvo o que o modelo usou ou carregou de volta NESTE turno.
  let novoKairos = alinharKairos(kairos, {
    providers: [...caudaFora.map((c) => c.id), ...cortadasFora, ...despejadas.capacidades.filter((id) => !sobreviveu(id))],
    refs: [
      ...propria.flatMap((c) => c.funcoes.map((f) => f.ref)).filter((r) => !usadasRefs.has(r)),
      ...despejadas.funcoes.filter((r) => !usadasRefs.has(r)),
    ],
  });
  // Promoção: a fonte é o registro de uso, não `tools.hydrate`. Toda função usada (ou carregada) que ainda não tem manual
  // no system entra em `hydratedTools`, e o provider dela em `loadedProviders`, qualquer que tenha sido o caminho.
  const jaComManual = comManual(system);
  const aPromover = usadas.filter((u) => !jaComManual.has(u.ref));
  // "Sobe junto" (§4.2): com a capacidade no system (já estava, ou o modelo a promoveu agora), as fixas dela e as
  // acompanhantes — de fixa ou de função usada/carregada — sobem junto. Não transitivo, e nunca traz capacidade.
  const sobeJunto = caudaLigada
    ? refsQueSobemJunto({
      capacidades,
      noSystem: new Set([...(novoKairos.loadedProviders ?? []), ...aPromover.map((u) => u.capId)]),
      usadas: usadas.map((u) => u.ref),
    })
    : { refs: [] };
  novoKairos = promoverNoKairos(novoKairos, {
    providers: aPromover.map((u) => u.capId),
    refs: [...aPromover.map((u) => u.ref), ...sobeJunto.refs],
    turno,
  });
  const registrado = registrarTurno(estadoDoDespejo, { mensagem: turno, system, usadas, caudaIds: propria.map((c) => c.id), m });
  // O registro só conhece o que está no system DESTE turno. O que o modelo usou ou carregou e ainda não está nele
  // (promovido da cauda, carregado por `load_capability`) entra no próximo — e já com o `ultimoUso` deste turno.
  const itens = { ...registrado.itens };
  for (const u of usadas) {
    if (!itens[u.capId]) itens[u.capId] = { tipo: 'capacidade', capId: u.capId, entrouEm: turno, ultimoUso: turno };
    if (!itens[u.ref]) itens[u.ref] = { tipo: 'funcao', capId: u.capId, entrouEm: turno, ultimoUso: turno };
  }
  // A cauda deste turno que ninguém usou vale por mais UM turno (só a PRÓPRIA: o herdado não é herdado de novo, e o
  // herdado também não entra em `caudaIds` acima, para não punir duas vezes). Herdada e sem uso: não soma, mas também
  // não zera a contagem que ela já tinha.
  const caudaSemUso = { ...registrado.caudaSemUso };
  for (const c of caudaDoTurno) {
    if (propria.some((x) => x.id === c.id) || usadasCaps.has(c.id)) continue;
    if (estadoDoDespejo.caudaSemUso?.[c.id] !== undefined) caudaSemUso[c.id] = estadoDoDespejo.caudaSemUso[c.id];
  }
  return {
    kairos: novoKairos,
    estadoDoDespejo: { ...registrado, caudaSemUso, itens, systemEnviado, caudaAnterior: caudaParaOProximo({ propria, usadasRefs }) },
    sobeJunto: sobeJunto.refs,
  };
}

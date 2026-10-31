// Relatório de conferência do treino contínuo (spec 2026-10-07): lê o registro de casos e o histórico das
// atualizações e resume, por anel e por dia, quanto a seleção local trouxe do que o modelo usou, quanto trouxe à toa
// e quanto o Jev em sombra teria feito melhor — mais o efeito de cada versão (antes × depois). Substitui o `sombra.mjs`.
// Carga à toa em DUAS medidas (revisão de 08/10, D2): a NOVA (`cargaAToaNova`: o que o LOCAL pôs em `full` PELA NOTA e ninguém usou — no provider é a que o
// corte muda; no tool o teto de vagas faz o corte TROCAR a função, não tirar carga (re-revisão do conjunto, C2); sem o que o motor segura em `full` independente da nota, `notas[ref].doMotor` (C1 da revisão do conjunto), sem as ativas no início e sem o que
// não tem nota; no tool, caso sem o carimbo atual é n/d) e o TOTAL (`cargaAToa`: inclui tudo isso, as funções fixas e o que já estava ativo). "Jev melhor" só conta turnos com USO e com SOMBRA do Jev (D3): os sem
// sombra saem do denominador e a contagem de cada grupo é publicada. Os campos novos são recalculados pelas funções de `caso.js` (as mesmas do
// `conferir()`), então os casos já gravados também ganham.
// `resumirConferencia` é puro; `conferenciaDoDataDir` faz a leitura. O texto do pedido NUNCA entra no resultado:
// só ids, ts e métricas.
import { join } from 'node:path';
import { lerCasosAsync, lerEstado, registroExiste } from './registro.js';
import { lerHistorico } from './versoes.js';
import { trazidasDe, cargaNovaDe, jevTrazidasDe, jevMelhorDe } from './caso.js';

export const ANEIS_CONFERENCIA = Object.freeze(['provider', 'tool']);
const capDaRef = (anel, ref) => (anel === 'provider' ? ref : String(ref).split('/tool/')[0]);
const dia = (ts) => String(ts).slice(0, 10);
const pct = (num, den) => (den ? num / den : null);
const media = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/**
 * Item de conferência do caso no anel: a conferência gravada + o que distingue as leituras do loop do Jev (contam como uso,
 * spec §3). `lidoTrouxe` = o local tinha carregado o que o loop leu; `soModeloTrouxe` = idem para o que só o modelo chamou.
 * Se o loop só lê o que o local carregou, `lidoTrouxe` tende a 100% — sinal de que o local se reforça (ver `lidoPeloLoop`).
 */
function itemDoCaso(c, anel) {
  const conf = c.conferencia[anel];
  const campo = anel === 'provider' ? 'capacidades' : 'funcoes';
  // Capacidade que entrou por promoção de SKILL (não pelo local) é neutra aqui: fora do denominador de acerto e não conta como
  // acerto (o registro a pôs em `carregadas` para não punir o local; o relatório a tira de volta).
  const promovida = new Set(c.promovidasPorSkill || []);
  const ehPromovida = (ref) => promovida.has(anel === 'provider' ? ref : String(ref).split('/tool/')[0]);
  const usadas = (c.usadas?.[campo] || []).filter((x) => !ehPromovida(x));
  const lidas = (c.lidasPeloLoop?.[campo] || []).filter((x) => !ehPromovida(x));
  const carregadas = trazidasDe(c, anel).filter((x) => !ehPromovida(x)); // o que o turno recebeu (provider: full ∪ ativas), não só a decisão do local
  const soModelo = usadas.filter((x) => !lidas.includes(x));
  // Provider: o que o modelo usou JÁ estava ativo no início do turno (o local não decidiu nada: carregada nunca cai) ou PRECISOU ENTRAR (aí
  // sim é mérito/erro do local). Sem `ativasNoInicio` array (caso de antes da captura, ou o provider não rodou o local) não há como separar: n/d.
  const ativas = anel === 'provider' && Array.isArray(c.ativasNoInicio) ? c.ativasNoInicio : null;
  const jaAtivas = ativas ? usadas.filter((x) => ativas.includes(x)) : [];
  const precisou = ativas ? usadas.filter((x) => !ativas.includes(x)) : [];
  return {
    ...conf,
    // Recalculados pelas MESMAS funções do `conferir()` (fonte única): a conferência gravada no caso pode ser de antes destes campos, ou ter
    // `jevMelhor: false` onde não havia sombra. `null` = n/d (sem notas do anel; sem ativasNoInicio no provider; sem o carimbo atual no tool; sem sombra do Jev no anel).
    cargaAToaNova: cargaNovaDe(c, anel),
    comSombra: Array.isArray(c.sombraJev?.[anel]),
    jevMelhor: jevMelhorDe(c, anel),
    trouxeJaAtiva: ativas && jaAtivas.length ? jaAtivas.every((x) => carregadas.includes(x)) : null,
    trouxePrecisouEntrar: ativas && precisou.length ? precisou.every((x) => carregadas.includes(x)) : null,
    semAtivasNoInicio: anel === 'provider' && !ativas && usadas.length > 0, // n/d: tinha uso e não sabemos o que já estava ativo
    ...(promovida.size ? { trouxeUsado: usadas.length ? usadas.every((x) => carregadas.includes(x)) : null } : {}),
    cargaJunto: conf.cargaJunto || [],
    lidoPeloLoop: lidas.length > 0,
    lidoTrouxe: lidas.length ? lidas.every((x) => carregadas.includes(x)) : null,
    soModeloTrouxe: soModelo.length ? soModelo.every((x) => carregadas.includes(x)) : null,
  };
}

/** Métricas de um conjunto de itens do anel (`itemDoCaso`). */
function metricas(itens) {
  const comUso = itens.filter((i) => i.trouxeUsado !== null);
  const comUsoComSombra = comUso.filter((i) => i.comSombra); // o Jev só pode ser "melhor" onde estava lá
  const comCargaNova = itens.filter((i) => Array.isArray(i.cargaAToaNova)); // n/d (null) fica fora da média
  const comLoop = itens.filter((i) => i.lidoPeloLoop);
  const comModelo = itens.filter((i) => i.soModeloTrouxe !== null);
  return {
    turnos: itens.length,
    trouxeUsado: pct(comUso.filter((i) => i.trouxeUsado).length, comUso.length),
    cargaAToaMedia: media(itens.map((i) => i.cargaAToa.length)), // TOTAL: inclui o que já estava ativo, as funções fixas e o que o motor manteve em full
    cargaAToaNovaMedia: media(comCargaNova.map((i) => i.cargaAToaNova.length)), // o que o LOCAL pôs pela nota e não foi usado (sem `doMotor`); no provider é a que o corte muda, no tool não (C2)
    casosCargaNova: comCargaNova.length,
    cargaJuntoMedia: media(itens.map((i) => i.cargaJunto.length)), // neutra: função carregada junto de uma capacidade usada
    jevMelhor: pct(comUsoComSombra.filter((i) => i.jevMelhor).length, comUsoComSombra.length),
    turnosComUsoComSombra: comUsoComSombra.length,
    turnosComUsoSemSombra: comUso.length - comUsoComSombra.length, // o Jev não estava lá: fora do denominador de jevMelhor
    turnosComLeituraDoLoop: comLoop.length,
    leituraDoLoop: pct(comLoop.length, itens.length),
    trouxeUsadoLidoPeloLoop: pct(comLoop.filter((i) => i.lidoTrouxe).length, comLoop.length),
    trouxeUsadoSoModelo: pct(comModelo.filter((i) => i.soModeloTrouxe).length, comModelo.length),
    // Provider: `trouxeUsado` separado pelo que já estava ativo no início do turno × o que PRECISOU ENTRAR (usadas − ativasNoInicio). `null` = n/d
    // (nenhum caso com `ativasNoInicio` array, ou anel tool). A de "já ativa" é 100% POR DEFINIÇÃO (as "trazidas" do provider incluem as ativas
    // no início) e NÃO mede a seleção: só `precisouEntrar` diz algo sobre o que o local decide.
    ...(() => {
      const ja = itens.filter((i) => i.trouxeJaAtiva !== null && i.trouxeJaAtiva !== undefined);
      const pe = itens.filter((i) => i.trouxePrecisouEntrar !== null && i.trouxePrecisouEntrar !== undefined);
      return {
        trouxeUsadoJaAtiva: pct(ja.filter((i) => i.trouxeJaAtiva).length, ja.length),
        casosJaAtiva: ja.length,
        trouxeUsadoPrecisouEntrar: pct(pe.filter((i) => i.trouxePrecisouEntrar).length, pe.length),
        casosPrecisouEntrar: pe.length,
        casosSemAtivasNoInicio: itens.filter((i) => i.semAtivasNoInicio).length, // n/d
      };
    })(),
  };
}

/**
 * Por capacidade: usos, quantos o local trouxe, vezes carregada à toa (total e nova), carregada junto, lida pelo loop e vezes em que só o Jev
 * trouxe (`jevMelhor` divide pelos usos COM sombra do Jev, não por todos).
 */
function porCapacidade(anel, validos) {
  const m = {};
  const linha = (cap) => (m[cap] ??= { usos: 0, trouxe: 0, cargaAToa: 0, cargaAToaNova: 0, cargaJunto: 0, lidasPeloLoop: 0, usosComSombra: 0, jevMelhor: 0, usosJaAtiva: 0, trouxeJaAtiva: 0, usosPrecisouEntrar: 0, trouxePrecisouEntrar: 0, usosSemAtivas: 0 });
  const campo = anel === 'provider' ? 'capacidades' : 'funcoes';
  for (const c of validos) {
    const usadas = c.usadas?.[campo] || [];
    const carregadas = trazidasDe(c, anel);
    const jev = jevTrazidasDe(c, anel); // null = sem sombra; no provider, Jev ∪ ativasNoInicio (como as trazidas do local)
    const promovida = new Set(c.promovidasPorSkill || []);
    for (const u of usadas) {
      if (promovida.has(capDaRef(anel, u))) continue; // neutra: promovida por skill
      const l = linha(capDaRef(anel, u));
      l.usos++;
      if (carregadas.includes(u)) l.trouxe++;
      if (jev) { l.usosComSombra++; if (!carregadas.includes(u) && jev.includes(u)) l.jevMelhor++; }
      if (anel === 'provider') { // já ativa × precisou entrar (n/d sem `ativasNoInicio` array)
        if (!Array.isArray(c.ativasNoInicio)) l.usosSemAtivas++;
        else if (c.ativasNoInicio.includes(u)) { l.usosJaAtiva++; if (carregadas.includes(u)) l.trouxeJaAtiva++; }
        else { l.usosPrecisouEntrar++; if (carregadas.includes(u)) l.trouxePrecisouEntrar++; }
      }
    }
    for (const u of c.lidasPeloLoop?.[campo] || []) if (!promovida.has(capDaRef(anel, u))) linha(capDaRef(anel, u)).lidasPeloLoop++;
    for (const r of c.conferencia?.[anel]?.cargaAToa || []) linha(capDaRef(anel, r)).cargaAToa++;
    for (const r of cargaNovaDe(c, anel) || []) linha(capDaRef(anel, r)).cargaAToaNova++;
    for (const r of c.conferencia?.[anel]?.cargaJunto || []) linha(capDaRef(anel, r)).cargaJunto++;
  }
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)).map(([cap, l]) => [cap, {
    usos: l.usos, trouxeUsado: pct(l.trouxe, l.usos), cargaAToa: l.cargaAToa, cargaAToaNova: l.cargaAToaNova, cargaJunto: l.cargaJunto, lidasPeloLoop: l.lidasPeloLoop, jevMelhor: pct(l.jevMelhor, l.usosComSombra),
    ...(anel === 'provider' ? {
      usosJaAtiva: l.usosJaAtiva, trouxeUsadoJaAtiva: pct(l.trouxeJaAtiva, l.usosJaAtiva),
      usosPrecisouEntrar: l.usosPrecisouEntrar, trouxeUsadoPrecisouEntrar: pct(l.trouxePrecisouEntrar, l.usosPrecisouEntrar),
      usosSemAtivasNoInicio: l.usosSemAtivas,
    } : {}),
  }]));
}

/** `avaliacao` do estado do anel (gravada ao adiar por falta de casos de avaliação): `{ n: number|null, minimo: number }`; ausente ou fora do formato = `null`. */
function avaliacaoDoEstado(a) {
  if (!a || typeof a !== 'object') return null;
  const n = a.n ?? null;
  return Number.isFinite(a.minimo) && (n === null || Number.isFinite(n)) ? { n, minimo: a.minimo } : null;
}

/**
 * `adiada` = por que o lote espera (`sem-base`, `sem-piso`, `poucos-recentes-avaliacao`, `poucos-recentes`, `sem-recentes`); `aguardaValidos` = quantos
 * válidos faltam para a próxima TENTATIVA (não para o lote rodar: o adiamento por avaliação se repete a cada tentativa); `avaliacao` = quantos
 * casos de avaliação havia na tentativa e o mínimo que o lote exige (`null` = o estado não guardou).
 */
function adiamentoDoEstado(e) {
  if (!e || typeof e !== 'object') return null;
  const validos = Number.isFinite(e.validos) ? e.validos : 0; const tentativaEm = Number.isFinite(e.tentativaEm) ? e.tentativaEm : 0;
  return { adiada: e.adiada ?? null, validos, tentativaEm, aguardaValidos: Math.max(0, tentativaEm - validos), falhas: e.falhas || 0, avaliacao: avaliacaoDoEstado(e.avaliacao) };
}

const SEM_CARIMBO = 'sem-carimbo';
const carimboDe = (c) => (typeof c?.regra === 'string' && c.regra ? c.regra : SEM_CARIMBO);
const contarCarimbos = (cs) => cs.reduce((m, c) => { const k = carimboDe(c); m[k] = (m[k] || 0) + 1; return m; }, {});

/**
 * As janelas antes × depois de uma versão são comparáveis só se TODOS os casos de ambas têm o MESMO carimbo de regra (`caso.regra`, ver
 * `REGRA_DO_CASO`). Senão a diferença de `trouxeUsado` mistura a mudança da regra (o que o local traz, como "trazido" é contado) com a da versão.
 * `motivoIncomparavel`: 'sem-carimbo' (há casos de antes do carimbo), 'carimbos-diferentes' ou 'janela-vazia'. Conta os casos de cada carimbo.
 */
export function comparabilidadeDasJanelas(antes, depois) {
  const ca = contarCarimbos(antes); const cd = contarCarimbos(depois);
  const chaves = new Set([...Object.keys(ca), ...Object.keys(cd)]);
  let motivoIncomparavel = null;
  if (!antes.length || !depois.length) motivoIncomparavel = 'janela-vazia';
  else if (chaves.has(SEM_CARIMBO)) motivoIncomparavel = 'sem-carimbo';
  else if (chaves.size > 1) motivoIncomparavel = 'carimbos-diferentes';
  return { comparavel: motivoIncomparavel === null, motivoIncomparavel, carimbos: { antes: ca, depois: cd } };
}

/**
 * @param {object[]} casos casos do registro (`triagem`, `conferencia`, `usadas`, `carregadas`, `sombraJev`, `ts`, ids)
 * @param {{provider?:object[], tool?:object[]}} historicos histórico de atualizações por anel (`lerHistorico`)
 * @param {{desde?:string|null, anel?:string|null, turnos?:number, estados?:Record<string,object>|null}} o `turnos` = quantos turnos recentes listar (padrão 100);
 *   `estados` = `estado.json` do registro por anel (`aneis[anel]`): vira `adiamento` (o lote espera por quê, e até quantos válidos)
 */
export function resumirConferencia(casos, historicos = {}, { desde = null, anel = null, turnos = 100, estados = null } = {}) {
  const aneis = anel ? [anel] : [...ANEIS_CONFERENCIA];
  const doPeriodo = (casos || []).filter((c) => c?.triagem?.valido === true && (!desde || dia(c.ts) >= desde));
  const saida = { desde: desde ?? null, turnosValidos: doPeriodo.length, aneis: {} };
  for (const a of aneis) {
    // O anel só conta quando o local tinha seleção registrada nele (anel em modo `jev`, ou local degradado, fica de fora).
    const validos = doPeriodo.filter((c) => Array.isArray(c.carregadas?.[a]) && c.conferencia?.[a]);
    const itens = (c) => itemDoCaso(c, a);
    const porDia = {};
    for (const c of validos) (porDia[dia(c.ts)] ??= []).push(itens(c));
    const todas = (historicos[a] || []).filter((h) => !desde || dia(h.quando) >= desde);
    const versoes = todas.filter((h) => h.versao != null).sort((x, y) => String(x.quando).localeCompare(String(y.quando)));
    const atualizacoes = versoes.map((h, i) => {
      const ini = versoes[i - 1]?.quando ?? null; const fim = versoes[i + 1]?.quando ?? null;
      const casosAntes = validos.filter((c) => c.ts < h.quando && (!ini || c.ts >= ini));
      const casosDepois = validos.filter((c) => c.ts >= h.quando && (!fim || c.ts < fim));
      const antes = casosAntes.map(itens);
      const depois = casosDepois.map(itens);
      const a1 = metricas(antes); const a2 = metricas(depois);
      return {
        versao: h.versao, quando: h.quando, casos: h.casos ?? null, resumo: h.resumo ?? null,
        // Portão por anel (spec 2026-10-07 §5): a versão foi aprovada como cabeça do anel? Entradas antigas (portão por capacidade) → null.
        anelAprovado: h.anelAprovado ?? null, metricasAnel: h.metricasAnel ?? null,
        antes: { turnos: a1.turnos, trouxeUsado: a1.trouxeUsado, trouxeUsadoSoModelo: a1.trouxeUsadoSoModelo, cargaAToaMedia: a1.cargaAToaMedia, cargaAToaNovaMedia: a1.cargaAToaNovaMedia, trouxeUsadoJaAtiva: a1.trouxeUsadoJaAtiva, trouxeUsadoPrecisouEntrar: a1.trouxeUsadoPrecisouEntrar, casosPrecisouEntrar: a1.casosPrecisouEntrar },
        depois: { turnos: a2.turnos, trouxeUsado: a2.trouxeUsado, trouxeUsadoSoModelo: a2.trouxeUsadoSoModelo, cargaAToaMedia: a2.cargaAToaMedia, cargaAToaNovaMedia: a2.cargaAToaNovaMedia, trouxeUsadoJaAtiva: a2.trouxeUsadoJaAtiva, trouxeUsadoPrecisouEntrar: a2.trouxeUsadoPrecisouEntrar, casosPrecisouEntrar: a2.casosPrecisouEntrar },
        // O `efeito` só vale entre janelas gravadas pela MESMA regra: com `comparavel: false` ele mistura a mudança da regra com a da versão.
        ...comparabilidadeDasJanelas(casosAntes, casosDepois),
        // O efeito de uma versão é medido no que SÓ o modelo chamou: o que o loop leu quase sempre o local já tinha trazido
        // (ele lê o que está carregado), então o total infla o acerto. O total fica ao lado em `efeitoTotal`.
        efeito: a1.trouxeUsadoSoModelo !== null && a2.trouxeUsadoSoModelo !== null ? a2.trouxeUsadoSoModelo - a1.trouxeUsadoSoModelo : null,
        efeitoTotal: a1.trouxeUsado !== null && a2.trouxeUsado !== null ? a2.trouxeUsado - a1.trouxeUsado : null,
      };
    });
    saida.aneis[a] = {
      ...metricas(validos.map(itens)),
      porDia: Object.fromEntries(Object.entries(porDia).sort(([x], [y]) => x.localeCompare(y)).map(([d, xs]) => [d, metricas(xs)])),
      porCapacidade: porCapacidade(a, validos),
      atualizacoes,
      // Rejeições do portão (treino completo ou lote): a versão nova NÃO foi gravada e a em uso continua (`mantida`). Sem isto a conferência
      // só mostraria as versões gravadas e uma rejeição repetida ficaria invisível.
      rejeitadas: todas.filter((h) => h.rejeitada).sort((x, y) => String(x.quando).localeCompare(String(y.quando)))
        .map((h) => ({ quando: h.quando, motivo: h.rejeitada, mantida: h.mantida === true, resumo: h.resumo ?? null })),
      // Estado atual do anel no `estado.json` (a conferência só via `adiadas` do histórico, que quase nunca se grava: o adiamento por falta de
      // casos de avaliação NÃO escreve histórico). `null` = estado não lido.
      adiamento: adiamentoDoEstado(estados?.[a]),
      falhas: todas.filter((h) => h.falhou).length,
      adiadas: todas.filter((h) => h.adiada).length,
      // `cargaAToa` = total; `cargaAToaNova` = a do local (null = n/d); `jevMelhor` null = sem sombra do Jev no turno.
      turnosRecentes: validos.slice(-turnos).map((c) => {
        const i = itens(c);
        return {
          ts: c.ts, interactionId: c.interactionId ?? null, sessionId: c.sessionId ?? null, tipo: c.triagem.tipo,
          trouxeUsado: i.trouxeUsado, cargaAToa: i.cargaAToa, cargaAToaNova: i.cargaAToaNova, cargaJunto: i.cargaJunto, lidoPeloLoop: i.lidoPeloLoop, jevMelhor: i.jevMelhor,
        };
      }),
    };
  }
  return saida;
}

/** Janela padrão do relatório quando `desde` não vem: 30 dias (o registro guarda até 20 mil casos com vetor). */
export const DIAS_PADRAO_CONFERENCIA = 30;
export const desdePadrao = (agora = new Date()) => new Date(agora.getTime() - DIAS_PADRAO_CONFERENCIA * 86400000).toISOString().slice(0, 10);

/**
 * Lê o registro e os históricos de `<dataDir>/decisoes` e resume. Assíncrono: a leitura devolve o controle ao event loop
 * (o app não congela com o registro cheio). `desde` ausente = últimos 30 dias.
 * @returns {Promise<{ok:true, ...}|{ok:false, motivo:string}>}
 */
export async function conferenciaDoDataDir(dataDir, opcoes = {}) {
  const dirDecisoes = join(dataDir, 'decisoes');
  const dirRegistro = join(dirDecisoes, 'registro');
  if (!registroExiste(dirRegistro)) return { ok: false, motivo: `FALTA: registro de casos ausente em ${dirRegistro} (o treino contínuo grava um caso por turno com o app aberto)` };
  const desde = opcoes.desde ?? desdePadrao();
  // Só os válidos do período, lidos da cauda (para no primeiro ts fora de `desde`), sem vetor nem texto do pedido em memória.
  const casos = await lerCasosAsync(dirRegistro, { desde, validos: true, leve: true });
  const historicos = Object.fromEntries(ANEIS_CONFERENCIA.map((a) => [a, lerHistorico(dirDecisoes, a)]));
  const estados = lerEstado(dirRegistro).aneis || {};
  return { ok: true, ...resumirConferencia(casos, historicos, { ...opcoes, desde, estados }) };
}

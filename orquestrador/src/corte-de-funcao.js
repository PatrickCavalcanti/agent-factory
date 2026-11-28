// Corte de função no anel `tool` (porte do `corte-de-funcao.js` do Igris, sem env e sem nomes do Igris).
//
// Por que existe: no anel `tool` o Kairos propõe `full` para toda função com nota ≥ 0,15 (até 3 por capacidade)
// e o refinador local NUNCA rebaixa essa proposta. O Igris mediu o efeito numa sessão: 197 manuais entraram no
// system e 10 foram chamados (spec do Igris `2026-10-24-corte-de-funcao-em-capacidade-carregada-design.md`). O
// corte decide, depois do refinador do anel `tool`, quais funções ficam `full` (ganham manual) e quais voltam a
// `candidate` (continuam listadas no cartão, carregáveis sob demanda).
//
// Duas regras, ambas opt-in pela config `corteDeFuncao` da fábrica:
//
// 1. Capacidade JÁ CARREGADA (`aplicarCorteDeCarregada`, `corteDeFuncao.carregada`): capacidade que já estava no
//    prompt no início do turno só ganha manual NOVO de função com sinal forte (nota da cabeça local ≥ `cabeca`,
//    ou destaque do `final` do Kairos dentro da capacidade, z ≥ `z`). A 1ª carga da capacidade passa intacta.
// 2. Funções semânticas de capacidades do piso (`aplicarCorteDeFuncao`, `corteDeFuncao.semanticasDoPiso`): a
//    lista de funções semânticas de uma capacidade que tem uma parte no piso e outra por relevância (a `memoria`
//    do Igris) só fica `full` se a nota passar o corte. O host diz quais funções (a fábrica não conhece nome de
//    capacidade).
//
// "Carregou, fica" NÃO depende deste corte: quem garante é o acumulado do prompt-builder, que só tira manual de
// função que perdeu a permissão. Rebaixar aqui uma função cujo manual já está no prompt só muda o `hydrate`
// deste turno — o manual continua lá.
//
// Falha do refinador (timeout, erro, formato): sem o embrulho, o Kairos aplicaria a proposta do motor sem corte e
// as funções entrariam para ficar. `embrulharRefinadorDeTool` responde antes do prazo, com o corte aplicado sobre
// a proposta do motor (regra do `final`, sem promoção).

/** Padrão do corte da capacidade já carregada. Calibrado pelo Igris em 4 sessões reais com o embedder dele. */
export const CORTE_CARREGADA_PADRAO = Object.freeze({
  cabeca: 0.4,
  z: 2.5,
  minFuncoes: 4,
  maxPromovidas: 3,
  excluir: Object.freeze([]),
});

/**
 * Padrão do corte das funções semânticas do piso. Calibrado pelo Igris para a `memoria`, com o embedder dele:
 * `notaBase` das funções-alvo nas intenções positivas 0,329–0,823 e, nas negativas, máximo 0,438 — as zonas se
 * sobrepõem e 0,45 prefere não carregar à toa. Trocar o embedder exige refazer a medição; o host pode declarar
 * outro `corte` por capacidade (forma de objeto de `semanticasDoPiso`).
 */
export const CORTE_SEMANTICAS_PADRAO = Object.freeze({ campo: 'notaBase', corte: 0.45, corteKairos: 0.6 });

/** Teto de promoções por turno (candidate → full), por capacidade, no corte das semânticas do piso. */
export const MAX_PROMOVIDAS = 3;

const CAMPOS_DE_NOTA = ['notaBase', 'notaCabeca', 'confidence'];

const erroDeConfig = (caminho, esperado, valor) => new Error(
  `corteDeFuncao.${caminho} inválido (esperado ${esperado}): ${JSON.stringify(valor)}`,
);

const numeroEntre0e1 = (caminho, valor, padrao) => {
  if (valor === undefined) return padrao;
  if (typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 && valor <= 1) return valor;
  throw erroDeConfig(caminho, 'número entre 0 e 1', valor);
};
const numeroPositivo = (caminho, valor, padrao) => {
  if (valor === undefined) return padrao;
  if (typeof valor === 'number' && Number.isFinite(valor) && valor > 0) return valor;
  throw erroDeConfig(caminho, 'número maior que 0', valor);
};
const inteiroPositivo = (caminho, valor, padrao) => {
  if (valor === undefined) return padrao;
  if (Number.isInteger(valor) && valor >= 1) return valor;
  throw erroDeConfig(caminho, 'inteiro maior ou igual a 1', valor);
};
const listaDeTexto = (caminho, valor, padrao) => {
  if (valor === undefined) return [...padrao];
  if (Array.isArray(valor) && valor.every((x) => typeof x === 'string' && x !== '')) return [...valor];
  throw erroDeConfig(caminho, 'lista de textos não vazios', valor);
};

/**
 * Normaliza a config `corteDeFuncao` do host na forma que o corte usa. Valor inválido LANÇA (o Igris avisava e
 * ficava no padrão porque lia variável de ambiente; aqui é objeto de config, e erro de config é erro de montagem).
 *
 * - `ativo` (padrão `true`): `false` só REGISTRA as decisões, não rebaixa nem promove (para medir).
 * - `carregada`: ausente ou `false` = regra desligada; `true` ou objeto = ligada, com os padrões de
 *   `CORTE_CARREGADA_PADRAO` para o que faltar. `carregada.ativo: false` só registra.
 * - `semanticasDoPiso`: `{ [idCapacidade]: string[] | { funcoes, campo?, corte?, corteKairos? } }`.
 *
 * @param {object} [obj]
 * @returns {{ ativo: boolean, porCapacidade: Record<string, { campo: string, corte: number, corteKairos: number, funcoes: string[] }>, carregada?: { ativo: boolean, cabeca: number, z: number, minFuncoes: number, maxPromovidas: number, excluir: string[] } }}
 */
export function normalizarCorte(obj = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw erroDeConfig('', 'objeto', obj);
  const porCapacidade = {};
  for (const [id, declarado] of Object.entries(obj.semanticasDoPiso ?? {})) {
    const forma = Array.isArray(declarado) ? { funcoes: declarado } : declarado;
    if (forma === null || typeof forma !== 'object') throw erroDeConfig(`semanticasDoPiso.${id}`, 'lista de funções ou objeto', declarado);
    const campo = forma.campo ?? CORTE_SEMANTICAS_PADRAO.campo;
    if (!CAMPOS_DE_NOTA.includes(campo)) throw erroDeConfig(`semanticasDoPiso.${id}.campo`, CAMPOS_DE_NOTA.join(' | '), forma.campo);
    porCapacidade[id] = {
      campo,
      corte: numeroEntre0e1(`semanticasDoPiso.${id}.corte`, forma.corte, CORTE_SEMANTICAS_PADRAO.corte),
      corteKairos: numeroEntre0e1(`semanticasDoPiso.${id}.corteKairos`, forma.corteKairos, CORTE_SEMANTICAS_PADRAO.corteKairos),
      funcoes: listaDeTexto(`semanticasDoPiso.${id}.funcoes`, forma.funcoes, []),
    };
  }
  const declaradaCarregada = obj.carregada === true ? {} : obj.carregada;
  const carregada = declaradaCarregada
    ? {
      ativo: declaradaCarregada.ativo !== false,
      cabeca: numeroEntre0e1('carregada.cabeca', declaradaCarregada.cabeca, CORTE_CARREGADA_PADRAO.cabeca),
      z: numeroPositivo('carregada.z', declaradaCarregada.z, CORTE_CARREGADA_PADRAO.z),
      minFuncoes: inteiroPositivo('carregada.minFuncoes', declaradaCarregada.minFuncoes, CORTE_CARREGADA_PADRAO.minFuncoes),
      maxPromovidas: inteiroPositivo('carregada.maxPromovidas', declaradaCarregada.maxPromovidas, CORTE_CARREGADA_PADRAO.maxPromovidas),
      excluir: listaDeTexto('carregada.excluir', declaradaCarregada.excluir, CORTE_CARREGADA_PADRAO.excluir),
    }
    : undefined;
  return { ativo: obj.ativo !== false, porCapacidade, ...(carregada ? { carregada } : {}) };
}

/**
 * Aplica o corte das funções semânticas do piso à saída de um refinador do anel `tool`.
 *
 * @param {{ full: string[], candidates: string[], explain?: Record<string, any> }} saida
 * @param {{ items?: Array<{ ref: string, scores?: { final?: number }, meta?: { pinned?: boolean, hasManual?: boolean } }> }} input
 * @param {ReturnType<typeof normalizarCorte>} cortes
 * @param {Array<object>} [registro] decisões deste turno
 * @param {number} [chamadaFixa] número da chamada do anel (o embrulho passa o mesmo do marcador de fallback)
 */
export function aplicarCorteDeFuncao(saida, input, cortes, registro = [], chamadaFixa) {
  if (!saida || !Array.isArray(saida.full)) return saida;
  const itens = new Map((input?.items ?? []).map((it) => [it.ref, it]));
  const alvo = new Map();
  for (const [capId, c] of Object.entries(cortes.porCapacidade)) {
    for (const f of c.funcoes) alvo.set(`${capId}/tool/${f}`, c);
  }
  if (alvo.size === 0) return saida;
  const explain = { ...(saida.explain ?? {}) };
  const full = [];
  const rebaixadas = [];
  const promoviveis = [];
  // O anel `tool` pode ser refinado mais de uma vez no turno (discover + loop): cada chamada numera as próprias decisões.
  const chamada = chamadaFixa ?? proximaChamada(registro);
  const desta = [];
  // Avalia também o que NÃO terminou full, para medir a distribuição das notas.
  const avaliar = new Set([...saida.full, ...(saida.candidates ?? [])]);
  for (const ref of avaliar) {
    const c = alvo.get(ref);
    if (!c) continue;
    const it = itens.get(ref);
    if (it?.meta?.pinned || it?.meta?.hasManual) continue;
    const ex = explain[ref] ?? {};
    const nota = Number.isFinite(ex[c.campo]) ? ex[c.campo] : null;
    const final = Number.isFinite(it?.scores?.final) ? it.scores.final : null;
    const passa = nota !== null ? nota >= c.corte : (final !== null && final >= c.corteKairos);
    const eraFull = saida.full.includes(ref);
    desta.push({
      regra: 'semanticas-do-piso', chamada, ref, eraFull, passa, campo: c.campo, corte: c.corte, nota,
      notaBase: Number.isFinite(ex.notaBase) ? ex.notaBase : null,
      notaCabeca: Number.isFinite(ex.notaCabeca) ? ex.notaCabeca : null,
      final, ativo: cortes.ativo,
    });
    if (eraFull && !passa && cortes.ativo) rebaixadas.push(ref);
    if (!eraFull && passa && nota !== null && cortes.ativo) promoviveis.push({ ref, nota, c });
  }
  const porCap = new Map();
  const promovidas = promoviveis.sort((a, b) => b.nota - a.nota).filter(({ c }) => {
    const n = porCap.get(c) ?? 0;
    porCap.set(c, n + 1);
    return n < MAX_PROMOVIDAS;
  }).map((p) => p.ref);
  for (const r of desta) if (promovidas.includes(r.ref)) r.promovida = true;
  registro.push(...desta);
  for (const ref of saida.full) if (!rebaixadas.includes(ref)) full.push(ref);
  if (rebaixadas.length === 0 && promovidas.length === 0) return saida;
  full.push(...promovidas);
  const candidates = (saida.candidates ?? []).filter((ref) => !promovidas.includes(ref));
  for (const ref of rebaixadas) {
    if (!candidates.includes(ref)) candidates.push(ref);
    const motivo = explain[ref]?.reason ? `${explain[ref].reason} ` : '';
    explain[ref] = { ...(explain[ref] ?? {}), reason: `${motivo}(corte-semanticas-do-piso)` };
  }
  for (const ref of promovidas) {
    const motivo = explain[ref]?.reason ? `${explain[ref].reason} ` : '';
    explain[ref] = { ...(explain[ref] ?? {}), reason: `${motivo}(corte-semanticas-do-piso:promovida)` };
  }
  return { ...saida, full, candidates, explain };
}

const proximaChamada = (registro) => 1 + registro.reduce((m, r) => Math.max(m, r.chamada ?? 0), 0);

/** Mesmo predicado do `isValidOutput` do Kairos (refiners.js): listas de string e `explain` objeto. */
const saidaValida = (v) => {
  const lista = (x) => Array.isArray(x) && x.every((r) => typeof r === 'string');
  return !!v && typeof v === 'object' && lista(v.full) && lista(v.candidates)
    && (v.explain === undefined || (typeof v.explain === 'object' && v.explain !== null && !Array.isArray(v.explain)));
};

/**
 * Embrulho do refinador do anel `tool` com os dois cortes. Responde ANTES do prazo do Kairos (`input.budgetMs`
 * menos `margemMs`): refinador lento, que lança ou devolve formato inválido não deixa a proposta do motor passar
 * sem corte — o corte é aplicado sobre ela (sem nota do refinador: regra do `final`, sem promoção). Limite: se o
 * prazo global do turno for menor que `budgetMs`, o Kairos ainda pode cair no próprio fallback antes.
 *
 * Sem `refinar`, o embrulho corta a proposta do motor (é o refinador identidade).
 *
 * @param {{ refinar?: Function|null, registro: Array<object>, cortes: ReturnType<typeof normalizarCorte>, carregadasNoInicio?: string[], margemMs?: number }} opcoes
 * @returns {(input: any) => Promise<any>}
 */
export function embrulharRefinadorDeTool({ refinar, registro, cortes, carregadasNoInicio = [], margemMs = 60 }) {
  return async (input) => {
    // Os dois cortes numeram as decisões desta chamada do anel com o MESMO número — o default é avaliado antes
    // de qualquer registro desta chamada.
    const cortar = (saida, chamada = proximaChamada(registro)) => aplicarCorteDeCarregada(
      aplicarCorteDeFuncao(saida, input, cortes, registro, chamada), input, cortes?.carregada, registro, chamada,
      carregadasNoInicio,
    );
    const daProposta = () => ({ full: [...(input?.proposal?.full ?? [])], candidates: [...(input?.proposal?.candidates ?? [])] });
    if (!refinar) return cortar(daProposta());
    const prazo = Math.max(20, (Number.isFinite(input?.budgetMs) ? input.budgetMs : 600) - margemMs);
    const ESGOTOU = Symbol('esgotou');
    let timer;
    const r = await Promise.race([
      Promise.resolve().then(() => refinar(input)).then((v) => ({ ok: true, v }), () => ({ ok: false })),
      new Promise((ok) => { timer = setTimeout(() => ok(ESGOTOU), prazo); }),
    ]);
    clearTimeout(timer);
    if (r === ESGOTOU || !r.ok || !saidaValida(r.v)) {
      const motivo = r === ESGOTOU ? 'timeout' : r.ok ? 'invalido' : 'erro';
      const chamada = proximaChamada(registro);
      registro.push({ chamada, refinador: `fallback:${motivo}` });
      return cortar(daProposta(), chamada);
    }
    return cortar(r.v);
  };
}

/**
 * Capacidades que o corte da carregada trata como já carregadas: as do estado do fim do turno anterior MAIS as
 * do piso deste turno. O cartão do piso está no prompt desde o 1º turno, mas o turno trivial não roda o
 * discover e deixa o `loadedProviders` vazio — sem o piso aqui, na mensagem seguinte a capacidade do piso
 * passaria como 1ª carga e os manuais dela entrariam no meio do system com nota da cabeça perto de zero
 * (sessão 5a5eda4e do Igris).
 *
 * @param {string[] | undefined} loadedProviders `loadedProviders` do estado no início do turno
 * @param {string[] | undefined} pisoDoTurno ids das capacidades com `piso: true` neste turno
 * @returns {string[]}
 */
export function carregadasNoInicioDoTurno(loadedProviders, pisoDoTurno) {
  return [...new Set([...(loadedProviders ?? []), ...(pisoDoTurno ?? [])])];
}

/**
 * Corte da capacidade já carregada. Capacidade que já estava no prompt no início do turno (`carregadasNoInicio`:
 * o `loadedProviders` do estado ao FIM do turno anterior — NÃO o `input.state`, que já traz as capacidades
 * promovidas neste turno pelas fontes, pela carga por chave e pelo I3a) só ganha manual pela votação do anel
 * `tool` com sinal forte: nota da cabeça local (`explain[ref].notaCabeca`) ≥ `cabeca`, ou destaque do `final`
 * do Kairos dentro da capacidade (z ≥ `z`, com ≥ `minFuncoes` funções com nota). `full` que não passa vira
 * `candidate`; `candidate` que passa sobe (até `maxPromovidas` por capacidade, pela nota da cabeça) — só quando o
 * refinador deu nota da cabeça a alguém: sem nota nenhuma (fallback) vale só o z e não promove. 1ª carga da
 * capacidade, `pinned`, `hasManual` e as capacidades de `excluir` passam intactas. Manual que já está no prompt
 * não sai por isto — quem garante é o acumulado do prompt-builder.
 *
 * @param {{ full: string[], candidates?: string[], explain?: Record<string, any> }} saida
 * @param {{ items?: Array<{ ref: string, scores?: { final?: number }, meta?: { providerId?: string, pinned?: boolean, hasManual?: boolean } }> }} input
 * @param {{ ativo: boolean, cabeca: number, z: number, minFuncoes: number, maxPromovidas?: number, excluir: string[] } | undefined} cfg
 * @param {Array<object>} [registro] decisões deste turno
 * @param {number} [chamadaFixa] número da chamada do anel (o embrulho passa o mesmo do corte das semânticas do piso)
 * @param {string[]} [carregadasNoInicio] sem isso nenhuma capacidade conta como carregada e o corte não age
 */
export function aplicarCorteDeCarregada(saida, input, cfg, registro = [], chamadaFixa, carregadasNoInicio) {
  if (!cfg || !saida || !Array.isArray(saida.full)) return saida;
  const maxPromovidas = cfg.maxPromovidas ?? CORTE_CARREGADA_PADRAO.maxPromovidas;
  const carregadas = new Set(carregadasNoInicio ?? []);
  if (carregadas.size === 0) return saida;
  const capDe = (it) => it?.meta?.providerId ?? String(it?.ref ?? '').split('/')[0];
  const porCap = new Map();
  for (const it of input?.items ?? []) {
    const cap = capDe(it);
    if (!carregadas.has(cap) || cfg.excluir.includes(cap)) continue;
    if (!porCap.has(cap)) porCap.set(cap, []);
    porCap.get(cap).push(it);
  }
  if (porCap.size === 0) return saida;
  // z do `final` do Kairos dentro de cada capacidade (o refinador recebe o catálogo inteiro dela).
  const zDe = new Map();
  for (const lista of porCap.values()) {
    const comNota = lista.filter((it) => Number.isFinite(it?.scores?.final));
    if (comNota.length < cfg.minFuncoes) continue;
    const notas = comNota.map((it) => it.scores.final);
    const media = notas.reduce((a, b) => a + b, 0) / notas.length;
    const desvio = Math.sqrt(notas.reduce((a, b) => a + (b - media) ** 2, 0) / notas.length);
    if (!(desvio > 0)) continue;
    for (const it of comNota) zDe.set(it.ref, (it.scores.final - media) / desvio);
  }
  const itens = new Map((input?.items ?? []).map((it) => [it.ref, it]));
  const explain = { ...(saida.explain ?? {}) };
  const temNotaDaCabeca = Object.values(explain).some((e) => Number.isFinite(e?.notaCabeca));
  const chamada = chamadaFixa ?? proximaChamada(registro);
  const desta = [];
  const rebaixadas = [];
  const promoviveis = [];
  for (const ref of new Set([...saida.full, ...(saida.candidates ?? [])])) {
    const it = itens.get(ref);
    if (!it) continue;
    const cap = capDe(it);
    if (!porCap.has(cap)) continue;
    if (it.meta?.pinned || it.meta?.hasManual) continue;
    const notaCabeca = Number.isFinite(explain[ref]?.notaCabeca) ? explain[ref].notaCabeca : null;
    const z = zDe.has(ref) ? zDe.get(ref) : null;
    const passa = (notaCabeca !== null && notaCabeca >= cfg.cabeca) || (z !== null && z >= cfg.z);
    const eraFull = saida.full.includes(ref);
    desta.push({
      regra: 'carregada', chamada, ref, capacidade: cap, eraFull, passa, notaCabeca,
      z: z === null ? null : Number(z.toFixed(3)),
      final: Number.isFinite(it.scores?.final) ? it.scores.final : null,
      ativo: cfg.ativo,
    });
    if (!cfg.ativo) continue;
    if (eraFull && !passa) rebaixadas.push(ref);
    if (!eraFull && passa && temNotaDaCabeca) promoviveis.push({ ref, cap, nota: notaCabeca ?? -1, z: z ?? -Infinity });
  }
  const porCapPromovidas = new Map();
  const promovidas = promoviveis
    .sort((a, b) => (b.nota - a.nota) || (b.z - a.z))
    .filter(({ cap }) => {
      const n = porCapPromovidas.get(cap) ?? 0;
      porCapPromovidas.set(cap, n + 1);
      return n < maxPromovidas;
    })
    .map((p) => p.ref);
  for (const r of desta) if (promovidas.includes(r.ref)) r.promovida = true;
  registro.push(...desta);
  if (rebaixadas.length === 0 && promovidas.length === 0) return saida;
  const full = [...saida.full.filter((ref) => !rebaixadas.includes(ref)), ...promovidas];
  const candidates = (saida.candidates ?? []).filter((ref) => !promovidas.includes(ref));
  for (const ref of rebaixadas) {
    if (!candidates.includes(ref)) candidates.push(ref);
    const motivo = explain[ref]?.reason ? `${explain[ref].reason} ` : '';
    explain[ref] = { ...(explain[ref] ?? {}), reason: `${motivo}(corte-carregada)` };
  }
  for (const ref of promovidas) {
    const motivo = explain[ref]?.reason ? `${explain[ref].reason} ` : '';
    explain[ref] = { ...(explain[ref] ?? {}), reason: `${motivo}(corte-carregada:promovida)` };
  }
  return { ...saida, full, candidates, explain };
}

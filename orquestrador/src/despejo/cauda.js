// Cauda efêmera (spec 2026-10-29 §4.1): o que a seleção trouxe e o modelo ainda não usou vai para a
// mensagem do turno; o system só recebe o que já está nele, o piso e o promovido (hydratedTools).
const prov = (ref) => ref.split('/')[0];
const semIndice = (ref) => (ref.endsWith('#index') ? ref.slice(0, -'#index'.length) : ref);

export const LEGENDA_CAUDA_PADRAO = 'Manuais trazidos para este pedido; estas funções podem ser chamadas agora. As que você usar passam a ficar no contexto fixo da conversa; as que não usar saem em breve.';

/**
 * `cardsDeCarregadas` (opcional): cards que o host tirou do `turno` por a capacidade constar em `providers.load`.
 * `sobeJunto` (opcional, Set de refs): fixas e acompanhantes que sobem com a capacidade que está no system (`sobe-junto.js`).
 * @returns {{ indice: any[], turno: any[], system: any[], cauda: Array<{ id: string, descricao: string|null, funcoes: Array<{ ref: string, nome: string, indice: string, manual?: string }> }>, cortadasPorSinal: string[] }}
 */
export function separarCauda(e) {
  if (!e.ligado) return { indice: e.indice, turno: e.turno, system: e.system, cauda: [], cortadasPorSinal: [] };
  const noSystem = (p) => e.piso.has(p) || e.carregados.has(p);
  /** @type {Map<string, { id: string, descricao: string|null, funcoes: any[] }>} */
  const cauda = new Map();
  const capDaCauda = (id) => {
    if (!cauda.has(id)) cauda.set(id, { id, descricao: null, funcoes: [] });
    return cauda.get(id);
  };
  const funcaoDaCauda = (capId, ref, nome, indice) => {
    const cap = capDaCauda(capId);
    let f = cap.funcoes.find((x) => x.ref === ref);
    if (!f) { f = { ref, nome, indice }; cap.funcoes.push(f); }
    return f;
  };

  const indice = [];
  for (const item of e.indice) {
    if (noSystem(item.providerId)) { indice.push(item); continue; }
    funcaoDaCauda(item.providerId, semIndice(item.ref), item.nome, item.conteudo);
  }

  const system = [];
  for (const bloco of e.system) {
    if (e.classificar(bloco.ref) === 'instrucoes' && !noSystem(prov(bloco.ref))) {
      capDaCauda(prov(bloco.ref)).descricao = bloco.content;
      continue;
    }
    system.push(bloco);
  }

  const turno = [];
  const cards = [];
  for (const bloco of e.turno) {
    const classe = e.classificar(bloco.ref);
    if (classe === 'card') { cards.push(bloco); continue; }
    if (classe !== 'contrato') { turno.push(bloco); continue; }
    const p = prov(bloco.ref);
    // "Sobe junto" (spec §4.2): fixa e acompanhante de capacidade que JÁ está no system sobem com ela. Capacidade só na
    // cauda (`carregados` não a tem) não é promovida por ter fixa — a fixa fica na cauda com o resto.
    const sobeJunto = e.carregados.has(p) && Boolean(e.sobeJunto?.has(bloco.ref));
    const promovido = e.comManual.has(bloco.ref) || e.piso.has(p) || (e.carregados.has(p) && e.hidratadas.has(bloco.ref)) || sobeJunto;
    if (promovido) { turno.push(bloco); continue; }
    const f = funcaoDaCauda(p, bloco.ref, bloco.label ?? bloco.ref, bloco.label ?? bloco.ref);
    f.manual = bloco.content;
  }

  const cortadasPorSinal = [];
  for (const [id, cap] of [...cauda]) {
    if (!e.exigeSinalForte.has(id) || e.sinalForte(id)) continue;
    const doLoop = cap.funcoes.filter((f) => e.doLoop.has(f.ref));
    if (doLoop.length) cap.funcoes = doLoop;
    else { cauda.delete(id); cortadasPorSinal.push(id); }
  }
  // Card (candidato): sai quando a capacidade vai inteira para a cauda COM descrição (as instruções fazem o papel);
  // sem descrição, o card é a única apresentação dela e fica.
  for (const card of cards) {
    const cap = cauda.get(prov(card.ref));
    if (!cap || !cap.descricao) turno.push(card);
  }
  // Cards que o host já tinha tirado do turno por a capacidade estar "carregada" (`providers.load`), mas que a cauda
  // deixou sem system: só voltam quando a capacidade está na cauda e ficou sem descrição.
  for (const card of e.cardsDeCarregadas ?? []) {
    const cap = cauda.get(prov(card.ref));
    if (cap && !cap.descricao) turno.push(card);
  }

  return { indice, turno, system, cauda: [...cauda.values()], cortadasPorSinal };
}

const attr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

export function renderizarCauda(cauda, { legenda = LEGENDA_CAUDA_PADRAO } = {}) {
  if (!cauda.length) return '';
  const caps = cauda.map((c) => {
    const linhas = c.funcoes.map((f) => `- ${f.nome} — ${f.indice}`).join('\n');
    const manuais = c.funcoes.filter((f) => f.manual).map((f) => `<function name="${attr(f.nome)}">\n${f.manual.trim()}\n</function>`);
    const corpo = [c.descricao?.trim(), linhas, ...manuais].filter(Boolean).join('\n\n');
    return `<capability name="${attr(c.id)}">\n${corpo}\n</capability>`;
  });
  return `<manuais_do_turno>\n${legenda}\n\n${caps.join('\n\n')}\n</manuais_do_turno>`;
}

/** Nomes expostos chamáveis por estarem na cauda (terceira fonte do gate, spec §4.3). */
export function nomesDaCauda(cauda) {
  return new Set(cauda.flatMap((c) => c.funcoes.filter((f) => f.manual).map((f) => f.nome)));
}

/**
 * Cauda herdada (continuação curta): o que o turno anterior trouxe na cauda e o modelo não usou vale por mais UM
 * turno, somado à cauda deste. Só manual entra (é o que o gate e o modelo precisam; linha de índice sem manual não
 * adianta). Não duplica: função que já está na cauda deste turno (a deste turno vence; se ela veio sem manual, recebe o
 * manual herdado) ou que já tem manual no system fica de fora. Capacidade que já está no system não repete a descrição.
 * Puro: não muta a entrada.
 *
 * @param {{ anterior?: any[], propria: any[], system: { capacidades: Array<{ id: string, funcoes: Array<{ ref: string, manual?: string }> }> } }} e
 * @returns {{ cauda: any[], herdadas: string[] }} `herdadas` = refs que vieram do turno anterior
 */
export function herdarCauda({ anterior = [], propria, system }) {
  if (!anterior.length) return { cauda: propria, herdadas: [] };
  const comManualNoSystem = new Set(system.capacidades.flatMap((c) => c.funcoes.filter((f) => f.manual).map((f) => f.ref)));
  const idsNoSystem = new Set(system.capacidades.map((c) => c.id));
  const cauda = propria.map((c) => ({ ...c, funcoes: c.funcoes.map((f) => ({ ...f })) }));
  const herdadas = [];
  for (const velha of anterior) {
    const manuais = velha.funcoes.filter((f) => f.manual && !comManualNoSystem.has(f.ref));
    for (const f of manuais) {
      let cap = cauda.find((c) => c.id === velha.id);
      const propriaF = cap?.funcoes.find((x) => x.ref === f.ref);
      if (propriaF?.manual) continue;
      if (!cap) {
        cap = { id: velha.id, descricao: idsNoSystem.has(velha.id) ? null : velha.descricao, funcoes: [] };
        cauda.push(cap);
      }
      if (propriaF) propriaF.manual = f.manual;
      else cap.funcoes.push({ ...f });
      herdadas.push(f.ref);
    }
  }
  return { cauda, herdadas };
}

/** A cauda deste turno que não foi usada, para valer no seguinte: só manuais não usados, sem repetir o que já foi herdado. */
export function caudaParaOProximo({ propria, usadasRefs }) {
  return propria
    .map((c) => ({ ...c, funcoes: c.funcoes.filter((f) => f.manual && !usadasRefs.has(f.ref)).map((f) => ({ ...f })) }))
    .filter((c) => c.funcoes.length > 0);
}


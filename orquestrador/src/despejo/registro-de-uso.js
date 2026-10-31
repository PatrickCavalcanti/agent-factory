// Registro de uso da cauda efêmera e do despejo (spec 2026-10-29 §4.5, §5). Puro: devolve estado novo.
const provDaRef = (ref) => ref.split('/')[0];

export function estadoDespejoVazio() {
  return { itens: {}, caudaSemUso: {}, descartadas: {}, exigeSinal: {}, systemEnviado: null };
}

/** Funções executadas pelo MODELO no turno: sem `origem` (o Jev marca 'jev'), ok, não recusadas, nome conhecido. */
export function usosDoTurno({ operacoes, recusadas, nomeParaRef }) {
  const vistos = new Set();
  const usadas = [];
  for (const op of operacoes ?? []) {
    if (op.origem || !op.ok || recusadas?.has(op.nome)) continue;
    const ref = nomeParaRef.get(op.nome);
    if (!ref || vistos.has(ref)) continue;
    vistos.add(ref);
    usadas.push({ ref, capId: provDaRef(ref) });
  }
  return usadas;
}

/**
 * Depois do turno: o que está no system ganha registro (entrouEm), o que foi usado ganha
 * ultimoUso, o que saiu do system perde o registro, cauda sem uso conta, descartada usada volta.
 */
export function registrarTurno(estado, { mensagem, system, usadas = [], caudaIds = [], m = Infinity }) {
  const itens = {};
  const anterior = estado.itens;
  for (const cap of system.capacidades) {
    itens[cap.id] = anterior[cap.id] ?? { tipo: 'capacidade', capId: cap.id, entrouEm: mensagem, ultimoUso: null };
    for (const f of cap.funcoes) {
      if (!f.manual) continue;
      itens[f.ref] = anterior[f.ref] ?? { tipo: 'funcao', capId: cap.id, entrouEm: mensagem, ultimoUso: null };
    }
  }
  const descartadas = { ...estado.descartadas };
  const usadasCaps = new Set();
  for (const u of usadas) {
    usadasCaps.add(u.capId);
    if (itens[u.capId]) itens[u.capId] = { ...itens[u.capId], ultimoUso: mensagem };
    if (itens[u.ref]) itens[u.ref] = { ...itens[u.ref], ultimoUso: mensagem };
    delete descartadas[u.capId];
    delete descartadas[u.ref];
  }
  const caudaSemUso = {};
  for (const capId of caudaIds) {
    if (usadasCaps.has(capId)) continue;
    caudaSemUso[capId] = (estado.caudaSemUso[capId] ?? 0) + 1;
  }
  // A exigência de sinal forte NASCE quando a capacidade completa M turnos seguidos na cauda sem uso e PERSISTE — não
  // depende de a contagem (que zera quando ela sai da cauda, e o corte a tira de lá) —, até o modelo usar ou carregar.
  const exigeSinal = { ...(estado.exigeSinal ?? {}) };
  for (const capId of usadasCaps) delete exigeSinal[capId];
  for (const [capId, n] of Object.entries(caudaSemUso)) if (n >= m) exigeSinal[capId] = true;
  return { ...estado, itens, caudaSemUso, descartadas, exigeSinal };
}

const parado = (item, mensagem, x) => mensagem - (item.ultimoUso ?? item.entrouEm) > x;

/**
 * Capacidades do system sem uso pelo modelo há mais de X mensagens. Piso e `sticky` nunca.
 * Função não sai sozinha (spec §5.1, R4): enquanto a capacidade fica, nenhum manual dela é marcado — só a capacidade
 * inteira ociosa. `funcoes` segue no retorno (sempre vazio) porque `despejar` e `registrarDescarte` ainda a aceitam.
 */
export function descartaveis(estado, { mensagem, system, x, piso, porCapacidade }) {
  const capacidades = [];
  const funcoes = [];
  for (const cap of system.capacidades) {
    if (piso.has(cap.id)) continue;
    const regra = porCapacidade.get(cap.id) ?? {};
    if (regra.sticky) continue;
    const xc = regra.x ?? x;
    if (!xc) continue;
    const itemCap = estado.itens[cap.id];
    if (itemCap && parado(itemCap, mensagem, xc)) capacidades.push(cap.id);
  }
  return { capacidades, funcoes };
}

/** Anota o que saiu (para o aviso e para exigir sinal forte na volta) e tira do registro de uso. */
export function registrarDescarte(estado, { mensagem, capacidades = [], funcoes = [], system }) {
  const itens = { ...estado.itens };
  const descartadas = { ...estado.descartadas };
  for (const capId of capacidades) {
    const cap = system.capacidades.find((c) => c.id === capId);
    const nomes = (cap?.funcoes ?? []).filter((f) => f.manual).map((f) => f.nome);
    descartadas[capId] = { tipo: 'capacidade', capId, em: mensagem, usada: itens[capId]?.ultimoUso != null, nomes };
    for (const k of Object.keys(itens)) if (itens[k].capId === capId) delete itens[k];
  }
  for (const ref of funcoes) {
    const capId = provDaRef(ref);
    const f = system.capacidades.find((c) => c.id === capId)?.funcoes.find((x) => x.ref === ref);
    descartadas[ref] = { tipo: 'funcao', capId, em: mensagem, usada: itens[ref]?.ultimoUso != null, nomes: f ? [f.nome] : [] };
    delete itens[ref];
  }
  return { ...estado, itens, descartadas };
}

/** Capacidades que só voltam à cauda com sinal forte: descartadas + cauda sem uso há M mensagens. */
export function exigeSinalForte(estado, { m }) {
  const ids = new Set();
  for (const d of Object.values(estado.descartadas)) if (d.tipo === 'capacidade') ids.add(d.capId);
  for (const [capId, n] of Object.entries(estado.caudaSemUso)) if (n >= m) ids.add(capId);
  for (const capId of Object.keys(estado.exigeSinal ?? {})) ids.add(capId);
  return ids;
}

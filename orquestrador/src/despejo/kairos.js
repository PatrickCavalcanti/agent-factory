// Estado do Kairos igual ao system (spec 2026-10-29 §4.4): o que ficou só na cauda ou foi descartado sai de
// `loadedProviders`/`hydratedTools`. Os providers que saíram também perdem a recência (`recentUse`, `lastUsedTurn`):
// o discover renova os dois para todo provider selecionado, e o ranking dá boost a quem foi "usado há pouco" —
// sem limpar, o que o modelo ignorou seguiria reforçado como se tivesse sido usado. O resto do estado
// (skills, `consciousTools`…) fica intacto.
export function alinharKairos(kairos, { providers = [], refs = [] }) {
  if (!providers.length && !refs.length) return kairos;
  const fora = new Set(providers);
  const foraRefs = new Set(refs);
  const lastUsedTurn = kairos.lastUsedTurn && typeof kairos.lastUsedTurn === 'object'
    ? Object.fromEntries(Object.entries(kairos.lastUsedTurn).filter(([id]) => !fora.has(id)))
    : kairos.lastUsedTurn;
  return {
    ...kairos,
    loadedProviders: (kairos.loadedProviders ?? []).filter((p) => !fora.has(p)),
    hydratedTools: (kairos.hydratedTools ?? []).filter((r) => !foraRefs.has(r) && !fora.has(r.split('/')[0])),
    ...(Array.isArray(kairos.recentUse) ? { recentUse: kairos.recentUse.filter((u) => !fora.has(u.ref)) } : {}),
    ...(lastUsedTurn !== undefined ? { lastUsedTurn } : {}),
  };
}

/**
 * Promoção pelo registro de uso (spec §4.2): o que o modelo USOU ou CARREGOU no turno entra no estado do Kairos
 * — provider em `loadedProviders`, função em `hydratedTools` — seja qual for o caminho por que o manual chegou à cauda
 * (hidratação do discover, loop do Jev, acompanhante, intenção, cauda herdada). Sem isto a promoção dependia de a
 * função estar em `tools.hydrate`, e o que veio por outro caminho era dado como promovido e sumia no turno seguinte.
 * Também renova a recência dos providers promovidos (foram usados agora). Puro.
 */
export function promoverNoKairos(kairos, { providers = [], refs = [], turno }) {
  if (!providers.length && !refs.length) return kairos;
  const unico = (lista) => [...new Set(lista)];
  const promovidos = new Set(providers);
  const ids = [...promovidos];
  return {
    ...kairos,
    loadedProviders: unico([...(kairos.loadedProviders ?? []), ...providers]),
    hydratedTools: unico([...(kairos.hydratedTools ?? []), ...refs]),
    ...(Array.isArray(kairos.recentUse) ? { recentUse: [...kairos.recentUse.filter((u) => !promovidos.has(u.ref)), ...ids.map((ref) => ({ ref, turn: turno }))] } : {}),
    ...(kairos.lastUsedTurn && typeof kairos.lastUsedTurn === 'object' ? { lastUsedTurn: { ...kairos.lastUsedTurn, ...Object.fromEntries(ids.map((id) => [id, turno])) } } : {}),
  };
}


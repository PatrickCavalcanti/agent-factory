// Chave de recriação do orquestrador da sessão (`turno.js`): ids das capacidades + a VERSÃO do manifesto
// dos powers que sintetizam o seu (hoje `okapp`, `versaoDoManifesto()`), no formato `okapp@3`. Sem a
// versão, o catálogo não era remontado quando o manifesto mudava com os mesmos ids (revisão do
// conjunto, I2). `getPower` devolve o registro do power (ou `undefined`); pura, sem I/O.
// `extras.mcp`: versão do registro dos servidores MCP genéricos (`mcp@<versão>`, spec 2026-10-01 §4.4) —
// só sobe quando o conjunto de manifestos muda, então um `list_changed` idêntico não remonta o catálogo.
// `extras.modo`: id do modo ativo na sessão (`modo@<id>`), ausente fora do modo.
// `extras.habilidades`: versão do catálogo de habilidades (`habilidades@<hash>`, `modo.js#versaoDoCatalogo`) —
// muda quando uma habilidade é importada/gravada/habilitada no meio da sessão, com os MESMOS ids de powers.
export function chaveDasCapacidades(ids, getPower, extras = {}) {
  const versoes = [];
  if (extras.mcp !== undefined && extras.mcp !== null) versoes.push(`mcp@${extras.mcp}`);
  // Modo de habilidades (spec 2026-10-23 §3.4.2): entrar/sair do modo muda o catálogo de habilidades.
  if (typeof extras.modo === 'string' && extras.modo) versoes.push(`modo@${extras.modo}`);
  // Correção 3 (E1): habilidade nova/alterada no meio da conversa recria o orquestrador da sessão.
  if (typeof extras.habilidades === 'string' && extras.habilidades) versoes.push(`habilidades@${extras.habilidades}`);
  for (const id of ids) {
    let v;
    try {
      v = getPower?.(id)?.versaoDoManifesto?.();
    } catch {
      v = undefined;
    }
    if (v !== undefined && v !== null) versoes.push(`${id}@${v}`);
  }
  return [...ids].sort().concat(versoes.sort()).join(',');
}

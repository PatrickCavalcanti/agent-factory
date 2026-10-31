// Chamada ao poder MCP genérico que age num servidor dado em `args.servidor` (packages/powers/src/powers/mcp/functions.js).
// O rótulo do treino é a capacidade DO SERVIDOR (`mcp-<slug>`), não a do poder genérico (`mcp`).
const FUNCOES_MCP_COM_SERVIDOR = new Set(['mcp_chamar_tool', 'mcp_listar_tools', 'mcp_enviar_arquivo', 'mcp_ouvir_recurso']);

// Mesma normalização de `sanear` + `idDeCapacidadeGenerica` (packages/mcp/src/capacidade/sintetizar.js).
function sanear(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Capacidade do servidor numa chamada do poder MCP genérico (`mcp-<slug com hífen>`), ou null. Aceita o nome cru e o exposto `cap__fn`. */
export function capacidadeDoServidorMcp(op) {
  const nome = String(op?.nome ?? '');
  const cru = nome.includes('__') ? nome.slice(nome.indexOf('__') + 2) : nome;
  const servidor = op?.args?.servidor;
  if (!FUNCOES_MCP_COM_SERVIDOR.has(cru) || typeof servidor !== 'string' || !servidor.trim()) return null;
  const slug = sanear(servidor).replace(/_/g, '-');
  return `mcp-${slug || 'servidor'}`;
}

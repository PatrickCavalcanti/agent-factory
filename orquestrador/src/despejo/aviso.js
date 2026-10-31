// Aviso curto do que saiu do contexto por falta de uso (spec 2026-10-29 §5.4). Só o que já foi usado.
export function avisoDeDescartadas(descartadas, { tetoChars }) {
  const porCap = new Map();
  for (const d of Object.values(descartadas ?? {})) {
    if (!d.usada) continue;
    const nomes = porCap.get(d.capId) ?? [];
    nomes.push(...d.nomes);
    porCap.set(d.capId, nomes);
  }
  if (porCap.size === 0) return '';
  const linhas = [];
  let usados = 0;
  for (const [capId, nomes] of porCap) {
    const linha = `${capId}${nomes.length ? ` (${nomes.join(', ')})` : ''} — saiu do contexto por falta de uso; carregue de volta com load_capability se precisar.`;
    if (usados + linha.length > tetoChars && linhas.length) break;
    linhas.push(linha);
    usados += linha.length + 1;
  }
  return `<descartadas>\n${linhas.join('\n')}\n</descartadas>`;
}

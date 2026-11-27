// Contribuição por CHAVE: entra no prompt só quando o turno traz uma das chaves dela. Sem `chaves`, é base e entra
// sempre. Determinístico de propósito: o que se sabe pelo trabalho não depende de ranking.

/**
 * @param {{ chaves?: readonly string[] }} contribuicao
 * @param {readonly string[]} chavesDoTurno
 */
export function contribuicaoBateComChaves(contribuicao, chavesDoTurno) {
  if (!contribuicao.chaves) return true;
  const doTurno = new Set(chavesDoTurno);
  return contribuicao.chaves.some((c) => doTurno.has(c));
}

/**
 * @param {ReadonlyArray<{ ref: string, floor?: boolean, chaves?: readonly string[] }>} contribuicoes
 * @param {readonly string[] | undefined} catalogo
 * @returns {string[]} mensagens de recusa
 */
export function validarChavesDasContribuicoes(contribuicoes, catalogo) {
  const erros = [];
  const conhecidas = catalogo ? new Set(catalogo) : null;
  for (const c of contribuicoes) {
    if (c.chaves === undefined) continue;
    if (c.floor !== true) { erros.push(`${c.ref}: \`chaves\` só vale em contribuição de piso (\`floor: true\`)`); continue; }
    if (c.chaves.length === 0) { erros.push(`${c.ref}: \`chaves\` vazia — omita o campo para contribuição base`); continue; }
    if (conhecidas) for (const k of c.chaves) if (!conhecidas.has(k)) erros.push(`${c.ref}: chave "${k}" fora do catálogo`);
  }
  return erros;
}

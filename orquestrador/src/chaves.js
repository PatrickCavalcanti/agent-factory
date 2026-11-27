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

const PRIORIDADE_PADRAO_DO_KAIROS = 50;
const REF_TRES_PARTES = /^[^/]+\/[^/]+\/[^/]+$/;

/**
 * Nível do prompt (`fixas`/`estaveis`/`dinamicas`) de uma contribuição de piso, pelo destino; `null` quando
 * o destino não é `system:*` (vai para o turno e não disputa posição). Mesma regra do prompt-builder.
 * @param {{ destination?: string }} c
 * @returns {'fixas'|'estaveis'|'dinamicas'|null}
 */
function nivelDoPiso(c) {
  const destino = c.destination ?? 'turn:context';
  if (!destino.startsWith('system:')) return null;
  if (destino === 'system:fixed') return 'fixas';
  if (destino === 'system:dynamic') return 'dinamicas';
  return 'estaveis';
}

/**
 * A colisão de prioridade só estoura no `acumular` quando os dois blocos têm conteúdo ao mesmo tempo — com
 * contribuição por chave isso é no meio da sessão, quando a chave entra. Aqui ela é recusada na montagem:
 * toda contribuição com `chaves` declara `priority` (não pode cair no default, que é o das capacidades), não
 * pode usar a posição do bloco de capacidades e não pode empatar com nenhuma outra de piso do mesmo nível
 * (com ou sem chave). Sem nenhuma contribuição com `chaves` não valida nada: host que não usa chave não muda.
 * @param {ReadonlyArray<{ ref: string, floor?: boolean, priority?: number, destination?: string, chaves?: readonly string[] }>} contribuicoes
 * @param {number} [prioridadeDasCapacidades]
 * @returns {string[]} mensagens de recusa
 */
export function validarPrioridadesDePiso(contribuicoes, prioridadeDasCapacidades = PRIORIDADE_PADRAO_DO_KAIROS) {
  const pisos = contribuicoes.filter((c) => c.floor === true && nivelDoPiso(c) !== null);
  if (!pisos.some((c) => c.chaves !== undefined)) return [];
  const erros = [];
  /** @type {Map<string, string[]>} nivel + prioridade → refs */
  const porPosicao = new Map();
  for (const c of pisos) {
    const nivel = /** @type {string} */ (nivelDoPiso(c));
    if (c.chaves !== undefined) {
      if (typeof c.priority !== 'number' || !Number.isFinite(c.priority)) {
        erros.push(`${c.ref}: contribuição com \`chaves\` precisa declarar \`priority\` (sem ela cai em ${PRIORIDADE_PADRAO_DO_KAIROS}, a posição do bloco de capacidades)`);
        continue;
      }
      if (nivel === 'estaveis' && c.priority === prioridadeDasCapacidades) {
        erros.push(`${c.ref}: \`priority\` ${c.priority} é a do bloco de capacidades`);
        continue;
      }
    }
    const prioridade = c.priority ?? PRIORIDADE_PADRAO_DO_KAIROS;
    const chave = `${nivel}\u0000${prioridade}`;
    porPosicao.set(chave, [...(porPosicao.get(chave) ?? []), c.ref]);
  }
  for (const [chave, refs] of porPosicao) {
    if (refs.length < 2) continue;
    const [nivel, prioridade] = chave.split('\u0000');
    erros.push(`${refs.join(', ')}: mesma prioridade (${prioridade}) no nível "${nivel}"`);
  }
  return erros;
}

/**
 * Ref do item de conversa em que uma contribuição com chave que não bateu pode entrar pela semântica:
 * `chave/<kind>/<origem>.<id>`. A origem (primeiro segmento do ref da contribuição) fica no último segmento
 * porque `o1/regra/x` e `o2/regra/x` virariam o mesmo ref.
 * @param {{ ref: string, kind?: string }} c
 */
export function refSemanticoDaChave(c) {
  const partes = c.ref.split('/');
  return `chave/${c.kind}/${partes[0]}.${partes[partes.length - 1]}`;
}

/**
 * Com `semanticaSemChave`, os refs derivados precisam ser válidos (`kind` string não vazia, três segmentos),
 * únicos entre si e não colidir com os refs já ocupados no canal de conversa (contribuições `floor: false`).
 * Só as que podem ser emitidas (têm `chaves` e `semanticText`) entram.
 * @param {ReadonlyArray<{ ref: string, kind?: unknown, chaves?: readonly string[], semanticText?: string }>} contribuicoes
 * @param {readonly string[]} [refsOcupados]
 * @returns {string[]}
 */
export function validarRefsSemanticosDasChaves(contribuicoes, refsOcupados = []) {
  const erros = [];
  const vistos = new Map(refsOcupados.map((r) => [r, r]));
  for (const c of contribuicoes) {
    if (c.chaves === undefined || c.semanticText === undefined) continue;
    if (typeof c.kind !== 'string' || c.kind === '') {
      erros.push(`${c.ref}: \`kind\` precisa ser string não vazia para entrar pela semântica (\`semanticaSemChave\`)`);
      continue;
    }
    const ref = refSemanticoDaChave(/** @type {{ ref: string, kind: string }} */ (c));
    if (!REF_TRES_PARTES.test(ref)) {
      erros.push(`${c.ref}: o ref semântico derivado "${ref}" não tem o formato \`<origem>/<kind>/<chave>\``);
      continue;
    }
    if (vistos.has(ref)) {
      erros.push(`${c.ref}: o ref semântico derivado "${ref}" colide com "${vistos.get(ref)}"`);
      continue;
    }
    vistos.set(ref, c.ref);
  }
  return erros;
}

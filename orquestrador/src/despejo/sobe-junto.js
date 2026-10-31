// "Sobe junto" (spec 2026-10-29 §4.2): quando uma capacidade está no system, as funções `fixa` dela vão para o system
// (não para a cauda), e as `acompanha` de uma função promovida (usada ou carregada pelo modelo) ou fixa sobem com ela.
// Não é transitivo: a acompanhante da acompanhante não sobe. Reusa `refsAcompanhantes` (loop-do-turno.js), o mesmo
// mapeamento de `acompanha` que o loop do Jev já usa — não há outro. Puro.
//
// Nunca traz capacidade para o system: só olha capacidades que JÁ estão nele (`noSystem`). O piso fica de fora (já
// carrega tudo) e fixa de capacidade que só está na cauda continua na cauda.
import { toolEhFixa } from '../capacidades.js';
import { refsAcompanhantes } from '../loop-do-turno.js';

const provDaRef = (ref) => ref.split('/')[0];

/** Capacidades semânticas (fora do piso) que estão no system. */
const semanticasNoSystem = (capacidades, noSystem) => (capacidades ?? []).filter((c) => c && c.piso === false && noSystem.has(c.id));

/**
 * @param {{ capacidades: any[], noSystem: Set<string>, usadas?: Iterable<string> }} e
 *   `noSystem`: ids das capacidades que estão (ou acabaram de entrar) no system. `usadas`: refs que o modelo usou ou
 *   carregou no turno (promoção) — as acompanhantes delas sobem junto.
 * @returns {{ fixas: string[], acompanhantes: string[], refs: string[] }} `refs` = fixas + acompanhantes, sem repetir.
 */
export function refsQueSobemJunto({ capacidades, noSystem, usadas = [] }) {
  const caps = semanticasNoSystem(capacidades, noSystem);
  const fixas = [];
  for (const cap of caps) {
    for (const tool of cap.tools ?? []) if (tool?.name && toolEhFixa(tool, cap)) fixas.push(`${cap.id}/tool/${tool.name}`);
  }
  const ids = new Set(caps.map((c) => c.id));
  const base = [...fixas, ...[...usadas].filter((ref) => typeof ref === 'string' && ids.has(provDaRef(ref)))];
  // Só a lista `acompanha` (a que a simulação v3 mediu): sem as funções `view.exibir: 'auto'` que o helper acrescenta por
  // conta própria no loop do Jev — elas não são "acompanha" e subiriam com qualquer fixa, sem ninguém declarar.
  const soAcompanha = caps.map((c) => ({ id: c.id, tools: (c.tools ?? []).map((t) => ({ name: t?.name, acompanha: t?.acompanha })) }));
  const acompanhantes = base.length ? refsAcompanhantes({ capacidades: soAcompanha, refs: base }) : [];
  return { fixas, acompanhantes, refs: [...new Set([...fixas, ...acompanhantes])] };
}

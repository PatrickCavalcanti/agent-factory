// Intenção declarada (spec 2026-10-14 §5): o modelo registra, fora da tela, as funções que vai usar
// se o dono aceitar. Aqui só se lê e valida — quem julga se vale é o Jev, no turno seguinte. Puro.
import { mapaDeFuncoesDoTurno } from './consultas-anteriores.js';

export const TETO_ITENS_INTENCAO = 5;

/**
 * Chaves: as três formas que o modelo pode usar (revisão do conjunto, I3) — o nome exposto, o sinônimo cru e a ref
 * `cap/tool/fn` —, pela MESMA regra de `mapaDeFuncoesDoTurno`. Todas apontam para a mesma meta, que leva o `exposto`.
 * @returns {Map<string, { exposto: string, capacidade: string, tool: string, effect: string, descricao?: string }>}
 */
export function funcoesParaIntencao(capacidades) {
  const porExposto = new Map();
  for (const cap of capacidades ?? []) {
    for (const t of cap?.tools ?? []) {
      if (!t?.name) continue;
      const exposto = cap.prefixarTools === false ? t.name : `${cap.id}__${t.name}`;
      porExposto.set(exposto, {
        exposto, capacidade: cap.id, tool: t.name, effect: t.effect || 'write',
        ...(t.description ? { descricao: t.description } : {}),
      });
    }
  }
  const mapa = new Map();
  for (const [chave, info] of mapaDeFuncoesDoTurno(capacidades)) {
    const meta = porExposto.get(info.exposto);
    if (meta) mapa.set(chave, meta);
  }
  return mapa;
}

/**
 * @param {string|null|unknown[]} bruto valor do campo `_intencao` (string com JSON, ou já lista)
 * @param {{ funcoes: Map<string, object> }} p
 * @returns {{ itens: Array<{ funcao: string, capacidade: string, tool: string, effect: string, args?: object }>, descartados: Array<{ item: unknown, motivo: string }>, erro: string|null }}
 */
export function lerIntencao(bruto, { funcoes }) {
  const vazio = () => ({ itens: [], descartados: [], erro: null });
  if (bruto == null) return vazio();
  let lista = bruto;
  if (typeof bruto === 'string') {
    if (!bruto.trim()) return vazio();
    try { lista = JSON.parse(bruto); } catch { return { ...vazio(), erro: 'json-invalido' }; }
  }
  if (lista == null) return vazio();
  if (!Array.isArray(lista)) return { ...vazio(), erro: 'nao-e-lista' };
  const itens = [];
  const descartados = [];
  for (const item of lista) {
    const nome = typeof item?.funcao === 'string' ? item.funcao.trim() : '';
    const meta = nome ? funcoes.get(nome) : null;
    if (!meta) { descartados.push({ item, motivo: 'funcao-desconhecida' }); continue; }
    // O item guardado leva sempre o nome EXPOSTO, seja qual for a forma que o modelo usou.
    if (itens.some((i) => i.funcao === meta.exposto)) { descartados.push({ item, motivo: 'repetida' }); continue; }
    if (itens.length >= TETO_ITENS_INTENCAO) { descartados.push({ item, motivo: 'acima-do-teto' }); continue; }
    const args = item.args && typeof item.args === 'object' && !Array.isArray(item.args) ? item.args : null;
    itens.push({ funcao: meta.exposto, capacidade: meta.capacidade, tool: meta.tool, effect: meta.effect, ...(args ? { args } : {}) });
  }
  return { itens, descartados, erro: null };
}

/** Texto curto para a pista do discover: `nome: descrição; nome: descrição`. */
export function textoDaIntencao(itens, funcoes) {
  return (itens ?? []).map((i) => {
    const d = funcoes?.get(i.funcao)?.descricao;
    return d ? `${i.funcao}: ${d}` : i.funcao;
  }).join('; ');
}

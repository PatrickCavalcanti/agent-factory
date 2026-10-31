// Ids rotulados dos turnos anteriores (spec 2026-10-14 §6.2): lê o registro completo de chamadas da
// sessão (`getToolCalls`, mesmo caminho do `stitchOperations`) nas últimas JANELA_TURNOS interações
// do assistente e extrai pelo `produz` de cada função. Puro (o I/O vem injetado).
import { extrairRotulados, mesclarRotulados } from '../../decisoes/src/loop/valores-rotulados.js';
import { mapaDeFuncoesDoTurno } from './consultas-anteriores.js';

export const JANELA_TURNOS = 10;

/**
 * Mapa nome → `produz`. As chaves são as três formas que o modelo pode usar (revisão do conjunto, I3): nome exposto,
 * sinônimo cru e ref `cap/tool/fn` — a mesma regra de `mapaDeFuncoesDoTurno`.
 */
export function produtoresDasCapacidades(capacidades) {
  const produzPorExposto = new Map();
  for (const cap of capacidades ?? []) {
    for (const t of cap?.tools ?? []) {
      if (!Array.isArray(t?.produz) || !t.produz.length) continue;
      produzPorExposto.set(cap.prefixarTools === false ? t.name : `${cap.id}__${t.name}`, t.produz);
    }
  }
  const mapa = new Map();
  for (const [chave, info] of mapaDeFuncoesDoTurno(capacidades)) {
    if (produzPorExposto.has(info.exposto)) mapa.set(chave, produzPorExposto.get(info.exposto));
  }
  return mapa;
}

/**
 * @returns {{ valores: Record<string, Array<{valor: string|number, rotulo: string}>>, descartados: number }}
 *   `descartados` = resultados de função com `produz` cujo texto não fez parse (revisão do conjunto, M7): o item é
 *   pulado, mas a contagem vai ao artefato — sem ela, um produtor que devolve texto fora de JSON some em silêncio.
 */
export function valoresDoRegistro({ mensagens, lerChamadas, produtores }) {
  if (!produtores?.size) return { valores: {}, descartados: 0 }; // nenhuma função do turno declara `produz`: nem lê o registro
  const ids = (mensagens ?? []).filter((m) => m?.role === 'assistant' && m.interactionId).map((m) => m.interactionId);
  const janela = ids.slice(-JANELA_TURNOS).reverse(); // mais recente primeiro
  const registros = [];
  let descartados = 0;
  for (const id of janela) {
    let chamadas = [];
    try { chamadas = lerChamadas(id) ?? []; } catch { chamadas = []; }
    for (const c of [...chamadas].reverse()) {
      if (c?.status !== 'ok' || !c.result?.texto) continue;
      const produz = produtores.get(c.name);
      if (!produz) continue;
      let corpo = c.result.texto;
      if (typeof corpo === 'string') {
        try { corpo = JSON.parse(corpo); } catch { descartados += 1; continue; }
      }
      registros.push(extrairRotulados(corpo, produz));
    }
  }
  return { valores: mesclarRotulados(...registros), descartados };
}

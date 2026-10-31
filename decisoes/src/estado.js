// packages/decisions/src/estado.js
import { cortarEstado } from './nucleo/estado.js';

const clip = (v, max) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? ''); return s.length > max ? s.slice(0, max) + '…' : s; };

/**
 * @param {object} e
 * @param {{ tetoChars?: number }} [opts] teto ~ 32k tokens do Jev menos o catálogo; 24k chars deixa folga para 254 opções em nível curta
 */
export function montarEstado(e, { tetoChars = 24000 } = {}) {
  const msgs = (e.mensagens || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  // a última mensagem de usuário é o próprio pedido — sai da "conversa anterior"
  const semPedido = msgs.length && msgs[msgs.length - 1].role === 'user' && msgs[msgs.length - 1].content === e.pedido ? msgs.slice(0, -1) : msgs;
  const s = {
    pedido_do_usuario: e.pedido || '',
    data_hora: e.dataHora || null,
    anexos_desta_mensagem: (e.anexos || []).map((a) => clip(a, 200)),
    powers_ativos: e.powersAtivos || [],
    candidatos_do_roteamento: (e.candidatos || []).map((c) => ({ power: c.id, score: Number(c.score?.toFixed?.(3) ?? c.score) })),
    memoria_de_trabalho: Array.isArray(e.memoriaDeTrabalho) ? e.memoriaDeTrabalho.map((m) => clip(m, 4000)) : e.memoriaDeTrabalho ? [clip(e.memoriaDeTrabalho, 4000)] : [],
    contexto_dos_powers: Object.fromEntries(Object.entries(e.blocosDosPowers || {}).map(([k, v]) => [k, clip(v, 4000)])),
    regras_dos_powers_ativos: Object.fromEntries(Object.entries(e.regrasDosPowers || {}).map(([k, v]) => [k, clip(v, 4000)])),
    conversa_anterior: semPedido.slice(-6).map((m) => ({ quem: m.role === 'user' ? 'usuario' : 'assistente', texto: clip(m.content, 300) })),
    acoes_ja_executadas: (e.acoesDoTurno || []).map((a) => ({ ...a, args: clip(a.args ?? {}, 300), resultado: clip(a.resultado ?? '', 600) })),
    o_que_o_assistente_ja_disse: (e.falasDoAssistente || []).map((f) => clip(f, 300)),
    _cortes: [],
  };
  // corte genérico por tamanho (nucleo/estado.js), na ordem: contexto dos powers → regras →
  // conversa → resultados. halving (não clip fixo em 100): clip(v,100) aplicado a uma string
  // já cortada em 100 devolve de novo 101 chars (100 + '…'), então "length > 100" nunca deixa
  // de achar o mesmo item — loop que não termina. Halving com piso de busca (40) acima do alvo
  // mínimo garante que cada rodada encolhe de verdade até sair do critério de busca.
  cortarEstado(s, {
    tetoChars,
    registrarCorte: (rotulo) => s._cortes.push(rotulo),
    ordemDeCorte: [
      { rotulo: 'contexto_dos_powers', cortar: () => { const ks = Object.keys(s.contexto_dos_powers); if (!ks.length) return false; const k = ks[ks.length - 1]; s.contexto_dos_powers[k] = clip(s.contexto_dos_powers[k], Math.floor(s.contexto_dos_powers[k].length / 2)); if (s.contexto_dos_powers[k].length < 200) delete s.contexto_dos_powers[k]; return true; } },
      { rotulo: 'regras_dos_powers_ativos', cortar: () => { const ks = Object.keys(s.regras_dos_powers_ativos); if (!ks.length) return false; const k = ks[ks.length - 1]; s.regras_dos_powers_ativos[k] = clip(s.regras_dos_powers_ativos[k], Math.floor(s.regras_dos_powers_ativos[k].length / 2)); if (s.regras_dos_powers_ativos[k].length < 200) delete s.regras_dos_powers_ativos[k]; return true; } },
      { rotulo: 'conversa_anterior', cortar: () => s.conversa_anterior.length ? (s.conversa_anterior.shift(), true) : false },
      { rotulo: 'acoes_ja_executadas', cortar: () => { const a = s.acoes_ja_executadas.find((x) => x.resultado.length > 40); if (!a) return false; a.resultado = clip(a.resultado, Math.floor(a.resultado.length / 2)); return true; } },
    ],
  });
  return s;
}

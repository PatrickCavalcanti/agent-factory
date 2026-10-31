// Extrator logs → casos (spec §7.1). Rótulo = capacidades USADAS no turno (dono de cada função chamada), o
// mesmo `alvo` com que a Fase 1 treinou. Nome de função que não existe no catálogo atual é descartado e
// contado (spec §9: renomeado no porte começa sem casos).
import { capacidadeDoServidorMcp } from './mcp-servidor.js';
export { capacidadeDoServidorMcp };
export const META_TOOLS = new Set(['load_bundle', 'load_skill', 'load_capability', 'search_capabilities', 'call_capability']);

// Turnos que não são pedido do dono: disparos em background, notificações e canal de depuração
// (valores medidos em `input.channel` / `input.source` dos execution-log.json reais).
const CANAIS_FORA = new Set(['background', 'debug']);
const ORIGENS_FORA = new Set(['background', 'notification']);

export function ehTurnoAutomatico(execLog) {
  const i = execLog?.input;
  return CANAIS_FORA.has(i?.channel) || ORIGENS_FORA.has(i?.source);
}

// Bancada com relógio simulado grava interações com data futura (ex.: 2030). `ts` ISO ordenável como texto;
// `agora` é Date ou ISO.
export function ehFuturo(ts, agora = new Date()) {
  const lim = agora instanceof Date ? tsLocal(agora) : String(agora);
  return String(ts) > lim;
}
const p2 = (n) => String(n).padStart(2, '0');
function tsLocal(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

// Marca de bancada olha só o caminho RELATIVO à raiz de sessões (mês/sessão/interação), nunca o `--data`.
export function ehCaminhoDeBancada(caminhoRelativo) {
  return /bench|bancada/i.test(String(caminhoRelativo));
}

// "20261006-224252_interaction-<uuid>" → "2026-10-06T22:42:52" (ordenável como texto, igual aos ts dos casos).
export function tsDaPasta(nome) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(nome));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : String(nome).slice(0, 19);
}

/**
 * nome da função → capacidade. Nome em MAIS de uma capacidade é ambíguo: não pega a última — fica em `mapa.ambiguos` e o
 * caso que o usa vira incerto (o log só traz o nome cru, não dá para saber de qual capacidade era).
 */
export function mapaDeFuncoes(manifests, chaveFuncoes) {
  const m = new Map();
  const ambiguos = new Set();
  const pares = new Set();
  for (const man of manifests) {
    const cap = String(man.id).replace(/_/g, '-');
    for (const f of man[chaveFuncoes] || []) {
      if (!f?.name) continue;
      pares.add(`${cap}__${f.name}`);
      if (m.has(f.name) && m.get(f.name) !== cap) { ambiguos.add(f.name); continue; }
      m.set(f.name, cap);
    }
  }
  for (const n of ambiguos) m.delete(n);
  m.ambiguos = ambiguos;
  m.pares = pares;
  return m;
}

/**
 * Nome de operação → `{cap, fn}`. Os nomes que o orquestrador grava em `operacoes`:
 * - ref interna `cap/tool/fn` (call_capability: `nome` = `args.ref`) — capacidade = prefixo, função = sufixo, sem consultar o catálogo;
 * - nome cru `fn` (tool de power sem prefixo) — pela tabela nome → capacidade do catálogo;
 * - nome exposto `cap__fn` (capacidade com `prefixarTools`, `nomeExposto` em orchestrator/capacidades.js; o resolvedor aceita as
 *   três formas) — vale só quando a tabela diz que `fn` é dessa capacidade.
 * Nome ambíguo (função em mais de uma capacidade) devolve `{ambiguo:true}`; o que nada resolve devolve null (descartado legítimo).
 * @param {string} nome @param {Map<string,string> & {ambiguos?:Set<string>, pares?:Set<string>}} mapa
 */
export function resolverNomeDeOperacao(nome, mapa) {
  const n = String(nome ?? '');
  const i = n.indexOf('/tool/');
  if (i > 0 && i + 6 < n.length) return { cap: n.slice(0, i), fn: n.slice(i + 6) };
  const k = n.indexOf('__');
  if (k > 0 && k + 2 < n.length) {
    const c = n.slice(0, k); const fn = n.slice(k + 2);
    if (mapa?.pares?.has(`${c}__${fn}`) || mapa?.get(fn) === c) return { cap: c, fn };
  }
  if (mapa?.ambiguos?.has(n)) return { ambiguo: true };
  const cap = mapa?.get(n);
  if (cap) return { cap, fn: n };
  return null;
}

/**
 * Capacidade de uma ref pedida ao `load_capability`/`load_bundle`: o modelo pede pela capacidade (`navegador`), pela ref
 * (`navegador/tool/navegar`), pelo nome exposto (`navegador__navegar`, desde os nomes prefixados, 10/10) ou pelo nome cru da função
 * (`okapp_entidades`). Só cortar `/tool/` fazia dos dois últimos uma "capacidade" usada que não existe — rótulo falso no treino.
 */
export function capacidadeDoPedido(ref, mapa) {
  const r = String(ref ?? '');
  const i = r.indexOf('/tool/');
  if (i > 0) return r.slice(0, i);
  const resolvido = resolverNomeDeOperacao(r, mapa);
  if (resolvido?.cap) return resolvido.cap;
  const k = r.indexOf('__');
  return k > 0 && k + 2 < r.length ? r.slice(0, k) : r;
}

export function casoDaInteracao({ id, sessao, ts, execLog, timeline, fabrica, mapa }) {
  const pedido = String(execLog?.input?.userMessage ?? '').trim();
  if (!pedido || ehTurnoAutomatico(execLog)) return null;
  // Mesmas regras do registro: leitura do loop do Jev que FALHOU (`ok === false`) não leu; `load_capability`/`load_bundle`
  // contam a capacidade (não a função) como usada.
  const operacoes = (fabrica?.operacoes || []).filter((o) => !(o?.origem === 'jev' && o?.ok === false));
  const pedidas = operacoes.filter((o) => o?.nome === 'load_capability' || o?.nome === 'load_bundle')
    .flatMap((o) => [...(Array.isArray(o.args?.refs) ? o.args.refs : []), ...(typeof o.args?.power === 'string' ? [o.args.power] : [])])
    .filter((r) => typeof r === 'string' && r).map((r) => capacidadeDoPedido(r, mapa));
  // Chamada genérica a um servidor MCP conta como a capacidade do servidor (`mcp-home-assistant`), não a do poder `mcp`.
  const capsServidor = operacoes.map(capacidadeDoServidorMcp);
  // Chaveado pelo nome CRU (depois do 1º `__`): a timeline traz `mcp_chamar_tool`, a operação pode trazer `mcp__mcp_chamar_tool`.
  const cru = (n) => { const s = String(n ?? ''); const k = s.indexOf('__'); return k >= 0 ? s.slice(k + 2) : s; };
  const comServidor = new Set(operacoes.filter((_, i) => capsServidor[i]).map((o) => cru(o.nome)));
  const semServidor = new Set(operacoes.filter((_, i) => !capsServidor[i]).map((o) => cru(o.nome)));
  const nomes = [
    ...((timeline?.items || []).filter((it) => (it.kind ?? it.type) === 'agent.tool.started').map((it) => it.payload?.toolName ?? it.payload?.name)),
    ...operacoes.map((o) => o.nome),
  ].filter((n) => typeof n === 'string' && !META_TOOLS.has(n) && !(comServidor.has(cru(n)) && !semServidor.has(cru(n))));
  const funcoes = []; const descartadas = []; const capacidades = []; const ambiguas = [];
  for (const cap of capsServidor) if (cap && !capacidades.includes(cap)) capacidades.push(cap);
  for (const n of new Set(nomes)) {
    const r = resolverNomeDeOperacao(n, mapa);
    if (r?.ambiguo) { ambiguas.push(n); continue; }
    if (!r) { descartadas.push(n); continue; }
    if (!funcoes.includes(r.fn)) funcoes.push(r.fn);
    if (!capacidades.includes(r.cap)) capacidades.push(r.cap);
  }
  for (const cap of pedidas) if (!capacidades.includes(cap)) capacidades.push(cap);
  // `incerto`: nome de função em mais de uma capacidade — o rótulo seria chute
  return { id, sessao, ts, pedido, capacidades, funcoes, descartadas, ...(ambiguas.length ? { ambiguas, incerto: true } : {}) };
}

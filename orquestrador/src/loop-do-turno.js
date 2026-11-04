// packages/orchestrator/src/loop-do-turno.js
//
// Loop de decisão do Jev dentro do turno da fábrica (spec 2026-09-22 §6): monta o espaço de
// ações a partir das capacidades, e transforma o rastro na entrega ao modelo. Puro — quem roda o
// loop é o host (`config.loop.rodar`, injetado), para a fábrica não depender de `@igris/decisions`.
// Melhoria 2 (sessão 2026-09-23, spec §4 "argumentos já no primeiro passo"): `espacoDoLoop`
// ordena `funcoes` pela relevância do anel `tool` do kairos para a pergunta do turno (ver
// `scoresPorRefDeTool`/`ordenarPorScore` abaixo) — o objetivo é a função certa já estar entre as
// K do primeiro passo, em vez de só entrar via `foraDasK` (que gasta um passo a mais só para
// perguntar os argumentos dela).
import { nomeExposto } from './capacidades.js';

const TETO_CHARS_RESULTADO = 4000;

function resumir(resultado, teto = TETO_CHARS_RESULTADO) {
  let s;
  try { s = typeof resultado === 'string' ? resultado : JSON.stringify(resultado); } catch { s = String(resultado); }
  s = s ?? '';
  return s.length > teto ? `${s.slice(0, teto)}…[cortado]` : s;
}

/**
 * N1 (correção fluxo de bug, sessão fbab5b12/22-09): serializa o resultado no
 * MESMO formato — e sem o mesmo teto — que o genos usa para o `tool_result`
 * de uma chamada feita pelo próprio modelo (`stringifyToolResult`,
 * `genos-orchestrator/src/orchestrator.ts`: string passa direto,
 * outra coisa vira `JSON.stringify(resultado, null, 2)`; SEM corte nenhum —
 * conferido na fonte, não há teto de tamanho em `stringifyToolResult`).
 *
 * Antes desta correção, `entregaDoLoop` usava `resumir()` (teto de 4000 chars,
 * pensado para o bloco `<pre_hidratacao>` de baixa confiança) TAMBÉM no
 * `tool_result` semeado no histórico — a mensagem que o modelo lê como se
 * tivesse chamado a função ele mesmo. Sessão fbab5b12 (interação 34734295):
 * `task_listar` (15 tarefas, confiança 0,98) foi cortado em 4000 chars com
 * `…[cortado]`; o modelo, vendo o corte, tentou buscar a lista "completa" de
 * novo — dois turnos gastos e a resposta seguinte quebrou (ver correção do
 * envelope truncado, protocolGuard.js/EnvelopeStream). Fora do teto para o
 * `tool_result` semeado: é EXATAMENTE o que o genos entregaria se o modelo
 * tivesse chamado a função ele mesmo, e por isso não pode ser MENOS completo.
 * O corte de `resumir()` continua valendo só para o bloco `<pre_hidratacao>`
 * (linhas de baixa confiança) — ali é resumo para leitura, não substituto de
 * uma chamada real.
 * @param {unknown} resultado
 * @returns {string}
 */
function comoOGenos(resultado) {
  if (typeof resultado === 'string') return resultado;
  try { return JSON.stringify(resultado, null, 2); } catch { return String(resultado); }
}

function funcoesDeLeitura(cap, paramsDe) {
  const prefixar = cap.prefixarTools !== false;
  return (cap.tools ?? [])
    .filter((t) => t.effect === 'read')
    .map((t) => ({
      nome: nomeExposto(cap.id, t.name, { prefixar }),
      descricao: t.description,
      capacidade: cap.id,
      tool: t,
      ...(Array.isArray(t.produz) && t.produz.length ? { produz: t.produz } : {}),
      params: () => paramsDe({ tool: t, capacidade: cap.id }),
    }));
}

// Cada chamada exata do registro é uma opção inteira; o Jev não preenche argumentos.
function acoesAutorizadas(cap, autorizacoes) {
  const saida = [];
  for (const a of autorizacoes ?? []) {
    if (a.capacidade !== cap.id) continue;
    const tool = (cap.tools ?? []).find((t) => t.name === a.funcao);
    if (!tool) continue;
    saida.push({
      nome: `autorizada_${a.id}`,
      descricao: `${a.rotulo}${a.descricao ? ` — ${a.descricao}` : ''}`,
      capacidade: cap.id,
      tool,
      autorizada: { id: a.id, args: a.args ?? {} },
      params: async () => [],
    });
  }
  return saida;
}

/**
 * Melhoria 2 (spec §4, sessão 2026-09-23 — "argumentos já no primeiro passo"): a ordem inicial
 * das funções no espaço do loop segue a relevância da função PARA A PERGUNTA, não a ordem de
 * ativação das capacidades. Fonte: o kairos já calcula, no anel `tool` do discover, um score por
 * função para o turno (`DiscoverExplainEntry.scores.final`, presente quando há refinador de anel
 * `tool` registrado — é o caso do modo combinado padrão da fábrica, `refinadores.js`: os três
 * anéis, `tool` só fica de fora em modo V1 via env).
 *
 * `ref` de uma entrada `ring: 'tool'` é `${providerId}/tool/${key}` (`makeRef`,
 * `@okds/kairos/core/names.js`) — o MESMO formato que `refPorFuncao` já monta em `index.js`
 * (`${f.capacidade}/tool/${f.tool.name}`), então dá para casar sem reimplementar a convenção.
 *
 * Como chega aqui SEM tocar `index.js` (passo zero desta tarefa, spec da sessão): a `explain`
 * que `index.js` já passa para `capacidadesDoLoop` é o ARRAY INTEIRO do discover — todos os
 * anéis, não só `provider` (que é tudo que `capacidadesDoLoop` usava até aqui). O mapa de scores
 * por tool sai da MESMA `explain`, sem pedir dado novo à chamada existente. O problema é só de
 * TRANSPORTE: `capacidadesDoLoop(...)` é passado direto como `carregadas` de `espacoDoLoop(...)`
 * na chamada de `index.js` (que não pode mudar) — não há como acrescentar um parâmetro novo
 * nessa chamada sem editar aquele arquivo. Solução: o mapa viaja PENDURADO no próprio Set que
 * `capacidadesDoLoop` já devolve, numa property de Symbol (não string — não colide com nada que
 * trate o retorno como Set puro de ids: spread/`for...of`/`[...set]` só veem os ELEMENTOS de um
 * Set, nunca properties do objeto). `espacoDoLoop` lê a property ANTES de normalizar `carregadas`
 * num Set novo (`new Set(carregadas)` já descartaria qualquer property extra).
 * @param {Array<{ref: string, ring: string, scores?: {final?: number}}>} explain
 * @returns {Map<string, number>}
 */
function scoresPorRefDeTool(explain) {
  const mapa = new Map();
  for (const e of explain ?? []) {
    if (!e || e.ring !== 'tool' || typeof e.ref !== 'string') continue;
    const final = e.scores?.final;
    if (typeof final === 'number' && Number.isFinite(final)) mapa.set(e.ref, final);
  }
  return mapa;
}

/** Symbol da property de transporte descrita acima — exportado só para o teste inspecionar. */
export const SCORES_TOOL_DO_LOOP = Symbol('scoresToolDoLoop');

function refDaFuncao(f) {
  return `${f.capacidade}/tool/${f.tool?.name}`;
}

/**
 * Teto de funções com `view.exibir: 'auto'` que acompanham um poder tocado no turno (ver
 * `refsAcompanhantes`). Custo limitado de propósito: cada uma é um manual a mais no prompt.
 */
export const TETO_VIEW_AUTO_POR_PODER = 2;

/** Teto TOTAL de funções que acompanham um poder tocado no turno (`acompanha` explícito + view auto). */
export const TETO_ACOMPANHA_POR_PODER = 3;

/**
 * Bug do teste do dono (2026-10-02): exibir um arquivo custava dois `load_capability` — o manual de
 * `arquivo_buscar` e depois o de `arquivo_apresentar`; achar uma nota custava outro (buscar -> ler).
 * Quando uma função de um poder fica hidratada ou é usada/escolhida no turno, entram hidratadas junto,
 * DO MESMO PODER: (1) as funções que ela declara em `acompanha` (manifesto 0.501), na ordem dos refs
 * tocados e da declaração; (2) as que declaram `view` com `exibir: 'auto'` (a que mostra o resultado
 * como card/tela), até `TETO_VIEW_AUTO_POR_PODER`. Só poderes tocados; no máximo `max` por poder (explícitas
 * têm precedência); nunca as refs que o chamador já tem (quem monta o bloco ainda deduplica contra o que
 * já está no prompt). Não é transitivo: acompanhante não puxa os acompanhantes dele.
 * @param {{ capacidades: Array<{id: string, tools?: Array<{name: string, acompanha?: string[], view?: {exibir?: string}}>}>,
 *           refs: Iterable<string>, max?: number }} p
 * @returns {string[]} refs `<capacidade>/tool/<nome>`
 */
export function refsAcompanhantes({ capacidades, refs, max = TETO_ACOMPANHA_POR_PODER }) {
  const tocadas = [...new Set([...(refs ?? [])].filter((r) => typeof r === 'string'))];
  const tocados = new Set(tocadas.map((r) => r.split('/')[0]).filter(Boolean));
  if (!tocados.size) return [];
  const saida = [];
  for (const cap of capacidades ?? []) {
    if (!cap || !tocados.has(cap.id)) continue;
    const tools = cap.tools ?? [];
    const jaTem = new Set(tocadas);
    const doPoder = [];
    const juntar = (nome) => {
      const ref = `${cap.id}/tool/${nome}`;
      if (jaTem.has(ref)) return;
      jaTem.add(ref);
      doPoder.push(ref);
    };
    for (const ref of tocadas) {
      if (ref.split('/')[0] !== cap.id) continue;
      const tool = tools.find((t) => t?.name === ref.split('/').slice(2).join('/'));
      for (const nome of tool?.acompanha ?? []) if (tools.some((t) => t?.name === nome)) juntar(nome);
    }
    let auto = 0;
    for (const t of tools) {
      if (t?.view?.exibir !== 'auto' || auto >= TETO_VIEW_AUTO_POR_PODER) continue;
      auto += 1;
      juntar(t.name);
    }
    // explícitas já estão na frente de `doPoder`: view auto completa o que sobrar do teto.
    saida.push(...doPoder.slice(0, max));
  }
  return saida;
}

/**
 * Spec 2026-10-14 §5.3: refs das funções declaradas na intenção que o Jev julgou válida — leitura E
 * escrita (a escrita só ganha o manual; quem executa é o modelo). Só o que existe no catálogo.
 * @returns {string[]} `<capacidade>/tool/<nome>`
 */
export function refsDaIntencao({ intencao, capacidades }) {
  const saida = [];
  for (const i of intencao ?? []) {
    const cap = (capacidades ?? []).find((c) => c?.id === i?.capacidade);
    if (!cap || !(cap.tools ?? []).some((t) => t?.name === i.tool)) continue;
    const ref = `${cap.id}/tool/${i.tool}`;
    if (!saida.includes(ref)) saida.push(ref);
  }
  return saida;
}

/**
 * Ordena `funcoes` por `scoresPorRef` (descendente), estável: função sem score entra depois de
 * todas as com score, na ordem relativa em que já estava. Sem mapa (ou mapa vazio), devolve
 * `funcoes` sem tocar — é o comportamento de hoje, preservado quando não há refinador de tool
 * registrado (explain sem `scores`) ou nenhuma das funções do espaço tem entrada no anel `tool`.
 * @param {Array<object>} funcoes
 * @param {Map<string, number>|null|undefined} scoresPorRef
 */
function ordenarPorScore(funcoes, scoresPorRef) {
  if (!scoresPorRef || !scoresPorRef.size) return funcoes;
  return funcoes
    .map((f, i) => ({ f, i, score: scoresPorRef.get(refDaFuncao(f)) }))
    .sort((a, b) => {
      const sa = typeof a.score === 'number' ? a.score : -Infinity;
      const sb = typeof b.score === 'number' ? b.score : -Infinity;
      return sa === sb ? a.i - b.i : sb - sa;
    })
    .map((x) => x.f);
}

/**
 * I2 (revisão de qualidade da Fase 3, spec §3.4): o espaço do loop é o que o refino ATIVOU NESTE
 * turno, não o que ficou carregado de turnos anteriores. Antes desta correção, `carregadas` vinha
 * de `providers.load` (pegajoso — inclui todo provider carregado em QUALQUER turno anterior da
 * sessão) mais os pisos, então depois do primeiro uso de qualquer capacidade não-piso o loop
 * pagava o espaço inteiro dela para sempre, contra a spec.
 *
 * `explain` é `prepared.discoverResult.explain` (kairos, `DiscoverExplainEntry[]`,
 * `resolve/discover.d.ts`): cada entrada do anel `provider` tem `ref` = o id da capacidade e
 * `tier` = o resultado FINAL deste turno (`full`/`candidate`/`discard`) — presente
 * INDEPENDENTE de ter refinador registrado (`rank-providers.d.ts`: `tier` vem do ranking puro
 * quando não há refinador, do refino quando há). `tier === 'full'` é o mesmo critério que decide
 * `providers.load` para o restante do turno.
 *
 * `promocoes` é o que o I3a promoveu neste turno (`promocoesSkills`, index.js) — o provider dono
 * de uma skill sugerida sem estar carregado. Entra à parte porque é promovido via
 * `comProvidersNoTurno` (injeção direta no estado), sem passar pelo ranking do anel `provider` —
 * não ganha entrada própria em `explain`.
 *
 * Pisos (`piso: true`) ficam DE FORA de propósito: `providers.load` já os inclui sempre (são
 * `always`), nunca entram no ranking do anel `provider` e o LOOP do Jev não vê funções de piso — o
 * loop só oferece ao Jev funções de capacidades que o refino/ranking carregou. (O refinador do anel
 * `tool` — também o Jev — recebe as funções de piso não fixas para decidir quais manuais hidratar;
 * isso é outra decisão, não execução.) Isto vale mesmo depois
 * do lote 1 do porte (a `memoria` declara 7 funções de leitura): as leituras de piso servem à
 * medida de função (manuais para o modelo), não ao espaço do loop do Jev.
 * @param {{ explain: Array<{ref: string, ring: string, tier?: string}>, promocoes: Iterable<string>,
 *           capacidades?: Array<{id: string, preExecucao?: boolean}>, deFontes?: Iterable<string> }} p
 * @returns {Set<string>}
 */
export function capacidadesDoLoop({ explain, promocoes, capacidades, deFontes }) {
  const doRefino = (explain ?? [])
    .filter((e) => e?.ring === 'provider' && e?.tier === 'full')
    .map((e) => e.ref);
  // Spec 2026-10-01 M6: capacidade com `preExecucao: false` (servidor MCP genérico) nunca entra no
  // espaço do Jev — só o modelo a chama. Sem `capacidades` (testes antigos) não filtra nada.
  const foraDoLoop = new Set((capacidades ?? []).filter((c) => c?.preExecucao === false).map((c) => c.id));
  const resultado = new Set([...doRefino, ...(promocoes ?? []), ...(deFontes ?? [])].filter((id) => !foraDoLoop.has(id)));
  // Melhoria 2: pendura o mapa de scores por tool (mesma `explain`, anel `tool`) no Set de ids —
  // ver o JSDoc de `scoresPorRefDeTool`/`SCORES_TOOL_DO_LOOP` acima para o porquê deste transporte.
  resultado[SCORES_TOOL_DO_LOOP] = scoresPorRefDeTool(explain);
  return resultado;
}

/**
 * @param {{ capacidades: object[], carregadas: Iterable<string>, candidatas: Iterable<string>,
 *           paramsDe: (a: { tool: object, capacidade: string }) => any }} p
 */
export function espacoDoLoop({ capacidades, carregadas, candidatas, paramsDe, autorizacoes = [] }) {
  // `preExecucao: false` (M6): fora do espaço mesmo se vier por `carregadas`/`candidatas` de outra origem.
  const porId = new Map(capacidades.filter((c) => c.preExecucao !== false).map((c) => [c.id, c]));
  // Melhoria 2: lê a property de transporte ANTES de normalizar `carregadas` num Set novo (linha
  // seguinte já descartaria a property). `carregadas` pode ser um array comum (bancada, testes) —
  // sem a property, `scoresPorRef` fica `undefined` e `ordenarPorScore` devolve a ordem de hoje.
  const scoresPorRef = carregadas?.[SCORES_TOOL_DO_LOOP];
  const noTurno = new Set(carregadas);
  const funcoes = [];
  for (const id of noTurno) {
    const cap = porId.get(id);
    if (cap) funcoes.push(...acoesAutorizadas(cap, autorizacoes), ...funcoesDeLeitura(cap, paramsDe));
  }
  const listaCandidatas = [];
  for (const id of candidatas) {
    if (noTurno.has(id)) continue;
    const cap = porId.get(id);
    if (cap && ((cap.tools ?? []).some((t) => t.effect === 'read') || acoesAutorizadas(cap, autorizacoes).length > 0)) listaCandidatas.push({ id, descricao: cap.descricao });
  }
  return {
    funcoes: [...funcoes.filter((f) => f.autorizada), ...ordenarPorScore(funcoes.filter((f) => !f.autorizada), scoresPorRef)],
    candidatas: listaCandidatas,
    funcoesDe: (id) => (porId.has(id) ? [...acoesAutorizadas(porId.get(id), autorizacoes), ...ordenarPorScore(funcoesDeLeitura(porId.get(id), paramsDe), scoresPorRef)] : []),
  };
}

/**
 * I1 (revisão de qualidade da Fase 3): normaliza o resultado de UMA chamada de tool do loop numa
 * mensagem de falha, ou `null` quando não é falha. `criarHandlerDePower` (packages/executor/src/
 * orchestration/powerToolHandler.js) NUNCA lança — todo erro (argumento inválido, exceção dentro
 * do power) vira uma STRING de prosa que começa com `'Erro:'`
 * (`buildToolArgumentError`/`buildToolExecutionError`, powerBundles.js), e no caminho feliz o
 * retorno é o JSON stringificado do power, que pode carregar `{ ok: false, error/reason }` — o
 * MESMO contrato que `envelopeDeErroDeTool` (powerBundles.js) já reconhece para o resto do turno.
 * Antes desta correção, `executar` (index.js) só testava `r.ok === false` em OBJETO — a forma
 * comum (string) sempre contava como sucesso.
 *
 * Reescrita aqui, e não importada de `@igris/executor`, porque a dependência é na direção oposta
 * (`@igris/executor` depende de `@igris/orchestrator`, nunca o contrário) — ver
 * `packages/executor/package.json`.
 * @param {unknown} r
 * @returns {string|null}
 */
/**
 * N2 (correção fluxo de bug, spec 2026-09-22 §6): extrai a mensagem de `error`, que os powers
 * devolvem como OBJETO `{ code, message, ... }` (`toolError`, packages/powers/src/powers/tarefas/
 * functions/_shared.js:19 — e o mesmo formato em vários outros powers), não como string solta.
 * `String(r.error ?? ...)` (a forma de antes desta correção) virava `"[object Object]"` — o rastro
 * do loop passava a mostrar essa string ao invés da falha real. Mesmo critério do `erroDoResultado`
 * do motor (`packages/decisions/src/loop/rodar-loop.js`): `message` antes de `code`; aqui também
 * aceita `error` como STRING direta (contrato antigo, ainda coberto pelos testes existentes).
 * @param {unknown} error
 * @returns {string|undefined}
 */
function mensagemDeErro(error) {
  if (error && typeof error === 'object') return error.message ?? error.code ?? undefined;
  if (typeof error === 'string') return error;
  return undefined;
}

/** Campos onde um power/host põe o motivo da recusa, na ordem de preferência (`error` ganha de `reason`, como sempre). */
const CAMPOS_DO_MOTIVO = ['error', 'erro', 'mensagem', 'message', 'motivo', 'reason'];

/**
 * Primeira string de motivo em `v`: a própria string, ou o primeiro de `CAMPOS_DO_MOTIVO` que dê string (descendo em
 * objeto aninhado, como `error: { message }`); `code` por último, quando é tudo o que há. `undefined` se não achar.
 * @param {unknown} v
 * @param {number} [nivel]
 * @returns {string|undefined}
 */
function motivoDe(v, nivel = 0) {
  if (typeof v === 'string') return v.trim() ? v : undefined;
  if (!v || typeof v !== 'object' || nivel > 2) return undefined;
  for (const campo of CAMPOS_DO_MOTIVO) {
    const achado = motivoDe(v[campo], nivel + 1);
    if (achado) return achado;
  }
  return typeof v.code === 'string' && v.code.trim() ? v.code : undefined;
}

/** Texto de um retorno MCP `{ isError: true, content: [{ type: 'text', text }] }`; `content` em string também vale. */
function textoDoContent(content) {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const textos = content.map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : ''))).filter((t) => t.trim());
  return textos.length ? textos.join('\n') : undefined;
}

/** Falha de um OBJETO de resultado (`ok: false` ou retorno MCP com `isError`), ou `null`. `semMotivo` é o texto quando não há. */
function falhaDeObjeto(r, semMotivo) {
  if (!r || typeof r !== 'object') return null;
  if (r.ok === false) return String(motivoDe(r) ?? semMotivo);
  if (r.isError === true) return String(textoDoContent(r.content) ?? motivoDe(r) ?? 'isError: true');
  return null;
}

export function falhaDoResultado(r) {
  const deObjeto = falhaDeObjeto(r, 'ok: false');
  if (deObjeto !== null) return deObjeto;
  if (typeof r === 'string') {
    if (r.startsWith('Erro:')) return r;
    let parsed;
    try {
      parsed = JSON.parse(r);
    } catch {
      return null;
    }
    return falhaDeObjeto(parsed, r);
  }
  return null;
}

/**
 * Bug 02/10 (sessões 70f74dbb/d163cb50): `gcal_listar_eventos {}` aparecia sem a faixa que o
 * handler resolveu (padrão escondido) e o modelo consultava de novo. Genérico: se o resultado traz
 * `periodo_consultado.descricao`, a linha da consulta mostra a faixa ao lado dos parâmetros.
 * Aceita objeto ou JSON em string; qualquer outra forma → null.
 * @returns {string|null}
 */
function periodoConsultadoDoResultado(resultado) {
  let r = resultado;
  if (typeof r === 'string') {
    if (!r.includes('periodo_consultado')) return null;
    try { r = JSON.parse(r); } catch { return null; }
  }
  const d = r && typeof r === 'object' ? r.periodo_consultado?.descricao : null;
  return typeof d === 'string' && d.trim() ? d.trim() : null;
}

/**
 * Entrega híbrida por confiança (spec §6.3). Acima do corte, duas mensagens no formato que o
 * genos grava no protocolo `json_output` (assistant = envelope com o comando; `tool_result` com
 * `toolName` e `metadata.args`), para o modelo ver como se ele tivesse chamado. Abaixo do corte,
 * só o bloco. O bloco sempre existe quando há rastro: é ele que diz a origem e a confiança.
 * @returns {{ historico: object[], bloco: string|null, destinos: { historico: number, bloco: number, erro: number } }}
 */
export function entregaDoLoop(saida, { corteHistorico = 0.7, autorizadas } = {}) {
  const rastro = saida?.rastro ?? [];
  const destinos = { historico: 0, bloco: 0, erro: 0 };
  if (!rastro.length) return { historico: [], bloco: null, destinos };
  const historico = [];
  const linhas = [];
  for (const item of rastro) {
    const ehAutorizada = Boolean(autorizadas?.has(item.fn));
    const prefixo = ehAutorizada ? '[AÇÃO AUTORIZADA] ' : '';
    const real = autorizadas?.get(item.fn);
    const fn = real?.toolName ?? item.fn;
    const argsReais = real?.args ?? item.args ?? {};
    const args = JSON.stringify(argsReais);
    const conf = Number(item.confianca ?? 0).toFixed(2);
    const periodo = periodoConsultadoDoResultado(item.resultado);
    const trechoPeriodo = periodo ? ` — período consultado: ${periodo}` : '';
    if (item.efeitoDesconhecido) {
      destinos.erro += 1;
      linhas.push(`- [AÇÃO AUTORIZADA] ${fn} ${args} — EFEITO DESCONHECIDO: a execução foi disparada e não confirmou dentro do prazo; ela PODE ter sido executada. NÃO repita esta chamada; confira o estado antes (uma consulta de leitura) ou pergunte ao dono.`);
      continue;
    }
    if (item.erro) {
      destinos.erro += 1;
      if (ehAutorizada) {
        linhas.push(`- [AÇÃO AUTORIZADA] ${fn} ${args} — FALHOU (confirmado): ${item.erro}`);
      } else {
        linhas.push(`- ${fn} ${args} — falhou: ${item.erro}`);
      }
      continue;
    }
    if (item.confianca >= corteHistorico) {
      destinos.historico += 1;
      historico.push(
        { id: `jev-${item.passo}-a`, role: 'assistant', content: JSON.stringify({ blocos: [{ chat: null, comandos: [{ tool: fn, args }] }] }) },
        // N1: SEM resumir() aqui — ver o JSDoc de `comoOGenos` acima.
        { id: `jev-${item.passo}-r`, role: 'tool_result', toolName: fn, content: comoOGenos(item.resultado), metadata: { args: argsReais, origem: 'jev' } },
      );
      // Correção A (fluxo de bug, 22-09): o par assistant/tool_result semeado passou a entrar
      // DEPOIS da mensagem do usuário (`EntradaDaMontagem.aposOPedido`, prompt-builder.js), não
      // mais "acima" dela — o texto tinha que acompanhar a mudança de posição, senão descreve um
      // lugar que não existe mais.
      linhas.push(`- ${prefixo}${fn} ${args} — confiança ${conf}${trechoPeriodo} — resultado logo após este pedido.`);
    } else {
      destinos.bloco += 1;
      linhas.push(`- ${prefixo}${fn} ${args} — confiança ${conf}${trechoPeriodo} — resultado:\n  ${resumir(item.resultado)}`);
    }
  }
  /**
   * N3 (correção fluxo de bug, sessão d82b949d/23-09): o cabeçalho antigo ("Confira se batem com
   * o pedido; se faltar algo ou a escolha estiver errada, chame de novo ou outra função") deixava
   * em aberto SE o dado do resultado era confiável — o modelo, vendo confiança baixa, tratou isso
   * como "o dado pode estar errado" e refez a MESMA consulta (`gcal_listar_eventos` com
   * `periodo:"futuro"`, que já trazia os 5 eventos dos próximos 30 dias, incluindo o procurado)
   * anunciando "vou conferir a agenda" antes de pedir de novo com `periodo:"mes"`. A consulta já
   * tinha sido executada de verdade e o resultado já cobria o pedido — o problema nunca foi
   * veracidade, foi o modelo não confiar no rótulo "confiança baixa" da forma certa.
   * Texto novo (decisão do dono): deixa explícito que toda linha abaixo veio de uma chamada REAL
   * (parâmetros mostrados = usados, resultado = dado atual), que "confiança baixa" é sobre a
   * ESCOLHA da consulta/parâmetros — não sobre a veracidade do dado — e que só vale chamar de
   * novo quando os parâmetros usados não cobrem o pedido.
   */
  const cabecalho = 'Antes deste turno, o decisor rápido (Jev) já executou estas consultas de leitura de verdade — '
    + 'os parâmetros mostrados são os usados, e os resultados são dados reais e atuais; use-os. '
    + 'A confiança abaixo não é sobre a veracidade do dado: é sobre se essa era a consulta certa para o pedido, '
    + 'com os parâmetros certos. Só chame de novo (ou outra função) se os parâmetros usados não cobrirem o pedido '
    + '(ex.: período ou filtro errado, falta um dado que o resultado não traz) — se o resultado já cobre o pedido, '
    + 'responda com ele.'
    + (rastro.some((item) => autorizadas?.has(item.fn))
      ? ' Linhas marcadas [AÇÃO AUTORIZADA] são ESCRITAS que o dono autorizou para esta chamada exata: as de sucesso FORAM executadas de verdade (não as repita; confirme o efeito ao dono usando o resultado), as que FALHARAM (confirmado) não aconteceram, e as de EFEITO DESCONHECIDO podem ter acontecido — nunca as repita sem verificar.'
      : '');
  const aviso = saida.estado === 'estourado' ? ['', 'O decisor parou antes de terminar (orçamento); pode faltar consulta.'] : [];
  const bloco = ['<pre_hidratacao>', cabecalho, ...linhas, ...aviso, '</pre_hidratacao>'].join('\n');
  return { historico, bloco, destinos };
}

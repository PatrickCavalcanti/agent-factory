// packages/decisions/src/loop/rodar-loop.js
//
// Loop de decisão do Jev (spec 2026-09-22 §4): pré-hidratação do turno. A cada passo, UMA
// chamada ao Jev escolhe a ação e os argumentos das K funções mais prováveis; a função escolhida
// é executada pelo host (`executar`, injetado) e o resultado entra no rastro, que o passo
// seguinte vê. Motor PURO: não conhece fábrica, sessão, genos nem frontend. Nunca lança.
// Correções fase 2 (revisão de qualidade, 2026-09-22): abaixo de `PISO_MS` restantes o motor
// nem inicia a próxima chamada/execução; `executar`/`carregar` recebem um sinal combinado
// (`AbortSignal.any([signal, <controller próprio>])`) e o `signal` do turno corta
// chamada ao Jev/execução/carregar por `Promise.race` (não espera o host reagir ao abort).
// Correções fase 2, 2ª rodada (re-revisão, 2026-09-22): a chamada ao Jev também corre contra o
// abort do turno (N1); o prazo total é reconferido depois de resolver os params antes de
// perguntar de novo, não só antes (N2); o sinal combinado usa `setTimeout` próprio, limpo no
// `finally` de quem chama — nunca `AbortSignal.timeout()`, que não tem como ser cancelado e
// segura o processo além da hora (N3/N6); `carregar` também recebe o sinal combinado (N4); o
// piso de tempo é conferido ANTES de marcar/avisar uma `chamada`, nunca depois (N5); e o
// preâmbulo (orçamento/cortes/espaço) nunca lança mesmo com `null` ou itens inválidos (N7).
// Melhoria 1 (sessão 2026-09-23, medição de sessões reais 23/09): toda chamada ao Jev ganha a
// pergunta `mais` (passo.js) junto de `acao` — "depois desta ação, ainda vai precisar de outra
// consulta?". Execução com sucesso + `mais: 'nao'` com confiança >= `corteFim` encerra o loop
// ali mesmo, sem a chamada extra só para confirmar `pronto` — ver o corte logo depois de
// `avisar({ tipo: 'resultado', ... })`, abaixo.
import { perguntar, cortarEstado } from '../nucleo/index.js';
import { perguntasDoPasso, lerPasso, exigeOModelo, ACAO_PRONTO, ACAO_BLOQUEADO, PREFIXO_CARREGAR, MAIS_NAO } from './passo.js';
import { SEM_ARGUMENTO, FORA_DA_LISTA } from '../perguntas.js';
import { extrairRotulados, mesclarRotulados, comOpcoesRotuladas } from './valores-rotulados.js';

// maxPassos 4: uma cadeia de N consultas gasta N+1 chamadas ao Jev (a ultima diz `pronto`); com 3,
// tarefa -> carregar calendario -> eventos estourava o teto depois de acertar tudo (bancada, 22/09).
export const ORCAMENTO_PADRAO = Object.freeze({ maxPassos: 4, prazoTotalMs: 4000, prazoPassoMs: 1500 });
// Calibração 22/09 (varredura com o Jev real via Vercel, 2 repetições, 7 cenários): corte 0,4
// com K 3 fecha 14/14 — o menor K que fecha; o único erro remanescente em cortes mais altos é
// "tarefa → calendário", que encerra com confiança de ação abaixo do corte.
export const CORTE_ACAO_PADRAO = 0.4;
// Piso de confiança para EXECUTAR uma leitura (Task 4, spec fábrica-capacidades-mcp §11; bancada do
// lote 4: `identidade_poderes_listar` executou a 0,33 e `si_listar {tipo:"observation"}` a 0,17 com o
// argumento `tipo` inventado). Até aqui o corte de confiança só decidia entre histórico e bloco na
// entrega — a função rodava de qualquer jeito (`confiancaLeitura`, abaixo, ainda a promove de "pronto"
// a "executa" com `confiancaAcao` baixa). Agora, `confiancaAcao` abaixo do piso NÃO executa: a função
// vai em `paraOModelo` (o modelo tem o pedido em texto livre). Argumento opcional abaixo do piso é
// omitido (como `sem_argumento`) e obrigatório leva a função ao modelo (`lerPasso`, passo.js) — mas SÓ com
// `cortes.execucaoArgs` ligado: por padrão o piso vale apenas para a AÇÃO (ver `pisoArgs`, abaixo).
// PROVISÓRIO — valor padrão a calibrar com o Jev real; configurável por `cortes.execucao` (0 desliga).
export const PISO_EXECUCAO = 0.4;
// Escrita autorizada exige maior confiança; configurável por cortes.escrita.
export const PISO_ESCRITA = 0.7;
// Melhoria 1 (sessão 2026-09-23): corte de confiança de `mais` para o loop encerrar SEM chamar
// o Jev de novo (ver `MAIS_NAO` em passo.js e o uso logo abaixo). Errar para EXECUTAR de mais
// custa um passo (~400-500ms, dentro do orçamento); errar para ENCERRAR de menos custa um turno
// inteiro do modelo de chat tendo que descobrir e chamar a função que faltou (ordens de
// grandeza mais caro) — por isso o corte é alto.
// Calibração 2 (sessão 2026-09-23/24, `E:\tmp\exp-mais.mjs`/`exp-mais-2.mjs`, Jev real via
// Vercel, ver o comentário grande em passo.js sobre o novo texto de `mais`): com o texto de
// cobertura de assunto, 0,7 (valor de partida desta melhoria) deixava passar 44% de
// encerramento errado nos casos de pedido composto — a confiança de `não` nesses casos chegou a
// 0,82. Em 0,85 esse erro caiu a 0/14 (2 rodadas), mantendo 10/10 de acerto nos dois casos de
// passo único testados (agenda amanhã, contas a pagar). Amostra pequena (3-5 repetições por
// caso); a bancada quente de produção (§7.2) segue como validação contínua.
export const CORTE_FIM_PADRAO = 0.85;
export const K_PADRAO = 3;
/** Spec 2026-10-14 §5.3: confiança mínima de `intencao_vale` para a intenção do turno anterior valer. Não medido. */
export const CORTE_INTENCAO = 0.7;
// Calibração 4 (sessão 2026-09-23/24, diagnóstico com sessões reais b54c4434/81854a56): funções
// recém-carregadas por `carregar_<capacidade>` não têm score do anel `tool` do kairos (nunca
// avaliadas no primeiro `discover` do turno, porque a capacidade não estava carregada) —
// `espacoDoLoop`/`ordenarPorScore` (@igris/orchestrator, `loop-do-turno.js`) não tem como
// ordená-las, e o corte de K deixa a função certa fora do `comArgs` na mesma passada em que a
// capacidade acabou de entrar (medido: `gcal_listar_eventos`, prob. 0,54, ficou de fora do K de 3
// porque `gcal_listar_calendarios`/`gcal_status` vieram primeiro na ordem do power). Ver
// `TETO_RECEM_CARREGADAS` abaixo.
const TETO_RECEM_CARREGADAS = 6;
const TETO_CHARS_ESTADO = 16000;
const TETO_CHARS_RESULTADO = 4000;
// C1: teto de opções de um `choice` é 255 (formas.js); `acao` sempre soma `pronto` + `bloqueado`
// às funções/candidatas oferecidas, então o espaço delas precisa caber em 253.
const TETO_ACAO_OFERECIDAS = 255 - 2;
// C1: cada param aceita no máximo 253 opções: o `choice` daquele argumento soma até duas sentinelas
// (`sem_argumento`, nos não-obrigatórios, e `valor_fora_da_lista`, em todos — lote 2, 30/09) e cabe em 255.
const TETO_OPCOES_PARAM = 253;
// I7: abaixo disto não vale iniciar mais uma chamada ao Jev nem uma execução/carregar — só dá
// tempo de fechar como estourado.
const PISO_MS = 150;

export function resumirResultado(resultado, teto = TETO_CHARS_RESULTADO) {
  let s;
  try { s = typeof resultado === 'string' ? resultado : JSON.stringify(resultado); } catch { s = String(resultado); }
  s = s ?? '';
  return s.length > teto ? `${s.slice(0, teto)}…[cortado]` : s;
}

function erroDoResultado(resultado) {
  if (resultado && typeof resultado === 'object' && resultado.ok === false) {
    return String(resultado.error?.message || resultado.error?.code || 'ok: false');
  }
  return null;
}

async function comPrazo(promessa, ms) {
  let timer;
  const PRAZO = Symbol('prazo');
  try {
    const r = await Promise.race([promessa, new Promise((res) => { timer = setTimeout(() => res(PRAZO), Math.max(0, ms)); })]);
    if (r === PRAZO) throw new Error('prazo da execução');
    return r;
  } finally {
    clearTimeout(timer);
  }
}

// I7/N1/N6: espera `promessa` correndo em paralelo com o abort do `signal` do turno e (quando
// `ms` for dado) um prazo próprio — o que resolver primeiro decide. Reage ao abort mesmo que
// quem produziu `promessa` ignore o sinal (é a rede de segurança do motor, não depende do host
// cooperar). NÃO delega a `comPrazo`: aquele cria o próprio timer e só o limpa quando a corrida
// INTERNA dele termina — se o abort vencesse aqui por fora, o timer de `comPrazo` ficava
// pendurado até o prazo vencer sozinho, segurando o processo mesmo com o motor já tendo voltado
// `cancelado` (era o que a prova `handle.mjs` mostrava: loop volta em ~55ms, processo só sai
// ~3000ms depois). Aqui o timer é local a esta chamada e `concluir()` sempre o limpa, não
// importa qual dos três lados decide (promessa, prazo, ou abort). `ms` é OPCIONAL: ausente, não
// aplica prazo próprio nenhum — usado pela chamada a `perguntar`, que já tem prazo macio interno
// (nunca pendura sozinho); dar um `ms` aqui também criaria dois timers mirando o mesmo instante,
// cuja ordem de disparo não é garantida. `executar`/`carregar` continuam passando `ms` (o host
// pode pendurar de verdade).
// U1 (revisor, 2026-09-22): `promessa.then(...)` liga ANTES de qualquer `return` cedo — mesmo
// quando `signal.aborted` já é `true` na entrada (o host pode abortar de forma síncrona dentro
// de `aoPasso('chamada')`, antes desta função rodar). `promessa` (`executar`/`carregar`) roda no
// microtask seguinte e pode rejeitar (comportamento normal de um handler que respeita o sinal
// abortado); sem handler ligado, isso vira `unhandledRejection` solta — que no processo da API
// derruba o processo (`process.exit(1)`, server.js:1204). `concluir` já é idempotente via
// `feito`, então ligar o handler primeiro não muda quem "ganha" a corrida — só garante que
// ninguém fica sem ouvinte.
function comCancelamento(promessa, { signal, ms } = {}) {
  return new Promise((resolve) => {
    let feito = false;
    let timer;
    const aoAbortar = () => concluir({ cancelado: true });
    function concluir(r) {
      if (feito) return;
      feito = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aoAbortar);
      resolve(r);
    }
    promessa.then((valor) => concluir({ valor }), (erro) => concluir({ erro: String(erro?.message || erro) }));
    if (signal) {
      if (signal.aborted) { concluir({ cancelado: true }); return; }
      signal.addEventListener('abort', aoAbortar, { once: true });
    }
    if (Number.isFinite(ms)) timer = setTimeout(() => concluir({ erro: 'prazo da execução' }), Math.max(0, ms));
  });
}

// N3/N4/N6: sinal combinado (turno + prazo do que falta) para o host poder abortar de verdade.
// Controller e `setTimeout` PRÓPRIOS — nunca `AbortSignal.timeout()`, que não expõe forma de
// cancelar: o timer nativo dele fica pendurado até o próprio prazo vencer mesmo depois da
// corrida já ter decidido (era o timer pendurado que segurava o processo minutos depois do
// `cancelado` já ter voltado). Quem chama SEMPRE limpa no `finally`, assim que a corrida contra
// `promessa`/abort terminar — não só quando o timer venceria.
function criarSinalCombinado(signal, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(new DOMException('prazo da execução', 'TimeoutError')); } catch { /* nunca derruba o motor */ }
  }, Math.max(0, Math.round(ms)));
  const limpar = () => clearTimeout(timer);
  return { signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal, limpar };
}

// C2: só aceita valor numérico finito e dentro da faixa; qualquer outra coisa (undefined, NaN,
// 0, negativo, fora da faixa) cai no padrão — nunca lança, nunca deixa `undefined` vazar pro
// merge (era o bug de `orcamento: { maxPassos: undefined }` sobrescrever o teto default).
function sanear(valor, padrao, valido) {
  return typeof valor === 'number' && Number.isFinite(valor) && valido(valor) ? valor : padrao;
}

// C1: normaliza os params de UMA função (cache por função em `paramsDe`): nome/obrigatoria
// tipados, opções sempre array, sem valor vazio/`sem_argumento`/`valor_fora_da_lista`/repetido, no
// máximo `TETO_OPCOES_PARAM` por param. `umDe` (grupos obrigatórios do schema, ver `gruposDe` em
// passo.js) é preservado quando vem no formato certo (array de arrays de nomes não vazios); qualquer
// outra forma é descartada — nunca lança e nunca deixa um grupo malformado bloquear a função.
function normalizarGrupos(umDe) {
  if (!Array.isArray(umDe)) return null;
  const grupos = umDe.map((g) => (Array.isArray(g) ? g.filter((n) => typeof n === 'string' && n) : []));
  return grupos.length && grupos.every((g) => g.length) ? grupos : null;
}
function normalizarParams(params) {
  if (!Array.isArray(params)) return [];
  return params.map((p) => {
    const nome = String(p?.nome ?? '');
    const obrigatoria = Boolean(p?.obrigatoria);
    const brutas = Array.isArray(p?.opcoes) ? p.opcoes : [];
    const vistos = new Set();
    const opcoes = [];
    for (const o of brutas) {
      if (opcoes.length >= TETO_OPCOES_PARAM) break;
      const chave = String(o?.valor);
      if (chave.trim() === '' || chave === SEM_ARGUMENTO || chave === FORA_DA_LISTA || vistos.has(chave)) continue;
      vistos.add(chave);
      opcoes.push(o);
    }
    const umDe = normalizarGrupos(p?.umDe);
    return {
      nome, obrigatoria, opcoes, ...(umDe ? { umDe } : {}),
      ...(typeof p?.papel === 'string' ? { papel: p.papel } : {}),
      ...(typeof p?.tipo === 'string' ? { tipo: p.tipo } : {}),
    };
  });
}

/**
 * @param {{
 *   pergunta: string, contexto?: object|null,
 *   espaco: { funcoes: Array<{ nome: string, descricao?: string, capacidade?: string, params: () => Promise<Array<{nome: string, obrigatoria: boolean, opcoes: Array<{valor: any, descricao?: string}>}>> }>,
 *             candidatas: Array<{ id: string, descricao?: string }> },
 *   cliente: { decidir: Function } | null,
 *   executar: (fn: object, args: object, signal?: AbortSignal) => Promise<any>,
 *   carregar?: (capacidadeId: string, signal?: AbortSignal) => Promise<Array<object>>,
 *     N4: `signal` é o mesmo sinal combinado (turno + prazo do que falta) que `executar`
 *     recebe. O host deve tratar a promoção da capacidade como IDEMPOTENTE: se o motor abortar
 *     (turno cancelado, ou o prazo do passo venceu) enquanto `carregar` ainda está em voo, o
 *     motor segue sem esperar a promessa resolver — ela pode terminar depois, e um novo passo
 *     (ou um novo turno) pode pedir a mesma capacidade de novo.
 *   orcamento?: { maxPassos?: number, prazoTotalMs?: number, prazoPassoMs?: number },
 *   cortes?: { acao?: number, fim?: number, execucao?: number, execucaoArgs?: number }, k?: number, signal?: AbortSignal, aoPasso?: (evento: object) => void,
 *   conversa?: Array<{ papel: 'usuario'|'assistente', texto: string }>,
 *   consultasAnteriores?: Array<{ funcao: string, args?: object, ok: boolean }>,
 *   intencaoAnterior?: Array<{ funcao: string, capacidade?: string, effect?: string, args?: object, prioridade?: boolean }>,
 * }} p
 *   `intencaoAnterior` (spec 2026-10-14 §5.3): as chamadas que o turno anterior declarou que faria se o
 *   dono aceitasse. O passo 1 julga (`intencao_vale`, corte `CORTE_INTENCAO`); aceita: as LEITURAS
 *   declaradas (trazidas por `carregar` se fora do espaço) vão ao topo da ordem e os args declarados
 *   viram opção `fonte:'intencao'`; recusada/sem resposta/Jev degradado: nada disso vale nos passos
 *   seguintes. `prioridade: false` num item tira a leitura do topo da ordem (ela segue no espaço). Escritas nunca são executadas pelo motor por causa da intenção. O retorno leva
 *   `intencao: { vale, confianca, motivo? }` sempre que houve `intencaoAnterior` válida (exceto no
 *   retorno antecipado `vazio`).
 *   `conversa` (2026-09-23, spec §4.1 addendum): mensagens ANTERIORES da mesma sessão, mais
 *   antiga primeiro, já cortada pelo host (`@igris/executor` `conversaDoHistorico`) — o motor só
 *   sanea o formato (item sem `papel`/`texto` string cai fora) e embute em `state.conversa`
 *   (nunca dentro de `contexto`: `conversa` é um campo de PRIMEIRA CLASSE do estado, não um
 *   extra opaco do host). Ausente/vazia: `state` sai idêntico a antes desta mudança.
 *   `consultasAnteriores` (Melhoria A, sessão 2026-09-23, spec §4.1 addendum — medição de sessões
 *   reais 74c42d74/6cf1cfec: "e a da OKDS?" perdia `periodo:"semana"` porque o Jev só via o TEXTO
 *   da conversa, nunca QUAL função/argumento o turno anterior de fato consultou): as consultas de
 *   LEITURA que o loop executou em turno(s) anteriores da mesma sessão — nome da função +
 *   argumentos + se deu certo, SEM o resultado (o host — `@igris/executor` `turno.js` — já corta
 *   pelo teto de turnos configurável antes de repassar aqui). Mesmo tratamento de `conversa`: o
 *   motor só sanea o formato (item sem `funcao` string cai fora; `args` ausente/inválido vira
 *   `{}`; `ok` não-booleano vira `true`) e embute em `state.consultasAnteriores` — campo de
 *   PRIMEIRA CLASSE, nunca dentro de `contexto`. Ausente/vazio: `state` sai idêntico a antes.
 * @returns {Promise<{ estado: 'pronto'|'bloqueado'|'estourado'|'cancelado'|'vazio', motivo?: string, rastro: object[], carregadas: string[], passos: object[], ms: number }>}
 */
/**
 * Quarta fonte de opções de argumento (dono, 10/10), ao lado de enum, valor salvo do poder e trecho entre aspas: o
 * valor que a consulta anterior MAIS RECENTE desta mesma função usou. O Jev continua sem inventar valor — escolhe um que
 * já funcionou. Só valores escalares; não muta os params (eles vêm de cache por função).
 * @param {Array<{nome:string, opcoes?:Array<{valor:unknown, descricao?:string}>}>} params
 * @param {Record<string, unknown>|undefined} anterior args da consulta anterior desta função
 */
export function comOpcoesHerdadas(params, anterior) {
  if (!Array.isArray(params) || !anterior || typeof anterior !== 'object') return params;
  return params.map((p) => {
    const v = anterior[p?.nome];
    if (v == null || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') || String(v).trim() === '') return p;
    const opcoes = Array.isArray(p.opcoes) ? p.opcoes : [];
    if (opcoes.some((o) => String(o?.valor) === String(v))) return p;
    return { ...p, opcoes: [...opcoes, { valor: v, descricao: 'o mesmo valor da consulta anterior', fonte: 'consulta-anterior' }] };
  });
}

/**
 * Spec 2026-10-14 §5.3 (D5): argumento declarado na intenção do turno anterior vira OPÇÃO — nunca
 * resultado reaproveitado. Só escalares; não muta os params (vêm de cache por função).
 */
export function comOpcoesDeclaradas(params, declarados) {
  if (!Array.isArray(params) || !declarados || typeof declarados !== 'object') return params;
  return params.map((p) => {
    const v = declarados[p?.nome];
    if (v == null || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') || String(v).trim() === '') return p;
    const opcoes = Array.isArray(p.opcoes) ? p.opcoes : [];
    if (opcoes.some((o) => String(o?.valor) === String(v))) return p;
    return { ...p, opcoes: [...opcoes, { valor: v, descricao: 'declarado na intenção', fonte: 'intencao' }] };
  });
}

export async function rodarLoop({ pergunta, contexto = null, espaco, cliente, executar, carregar, orcamento, cortes, k: kBruto = K_PADRAO, signal, aoPasso, conversa, consultasAnteriores, intencaoAnterior, valoresRotulados }) {
  // N7: `orcamento`/`cortes`/`espaco` podem chegar `null` explícito (não só `undefined`, que o
  // default do parâmetro já cobre) — normaliza direto pra `{}` antes de tocar qualquer campo, e
  // filtra itens de `funcoes`/`candidatas` que não têm o identificador mínimo (`null`, ou sem
  // `nome`/`id` string), pra nunca lançar mais adiante ao ler `f.nome`/`c.id`.
  const orcamentoSeguro = orcamento ?? {};
  const cortesSeguro = cortes ?? {};
  const espacoSeguro = espaco ?? {};
  // `conversa`: mesma garantia N7 — item sem `papel` válido ou `texto` string cai fora, nunca
  // lança mais adiante. Cópia própria (`[...]`): `cortarEstado` faz `shift()` nela por passo
  // (mutação in-place), e recomeçar a mesma mutação a cada passo do loop seria incorreto — por
  // isso a lista sanada nasce ANTES do laço `for`, e cada passo faz sua PRÓPRIA cópia ao montar
  // `state` (ver abaixo).
  const conversaSegura = Array.isArray(conversa)
    ? conversa.filter((c) => c && (c.papel === 'usuario' || c.papel === 'assistente') && typeof c.texto === 'string' && c.texto.trim())
    : [];
  // Melhoria A: mesma garantia N7 de `conversaSegura` — item sem `funcao` string cai fora, nunca
  // lança mais adiante. `args`/`ok` são saneados por item (nunca `undefined`/tipo errado vazando
  // para o `state`): `args` vira `{}` quando ausente/não-objeto, `ok` vira `true` quando não é
  // booleano (mesmo default que `resultado.ok !== false` usa no resto deste arquivo — omisso é
  // tratado como sucesso, nunca como falha por acidente).
  const consultasAnterioresSeguras = Array.isArray(consultasAnteriores)
    ? consultasAnteriores
      .filter((c) => c && typeof c.funcao === 'string' && c.funcao.trim())
      .map((c) => ({
        funcao: c.funcao,
        args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {},
        ok: typeof c.ok === 'boolean' ? c.ok : true,
      }))
    : [];
  // Argumentos da consulta anterior mais recente de cada função (só as que deram certo): um
  // argumento que o Jev herda dali, com o mesmo valor, não derruba a confiança do item — ver
  // `herdados` em `lerPasso` (uso real 757739e5: "e as concluídas?" herdou a lista, trocou só o
  // status, e a confiança final caiu para 0,4 → bloco → o modelo refez a consulta).
  const argsHerdados = {};
  for (const c of consultasAnterioresSeguras) if (c.ok) argsHerdados[c.funcao] = c.args;
  // Spec 2026-10-14 §5.3: intenção declarada no turno anterior (só itens com `funcao` string).
  const intencaoSegura = Array.isArray(intencaoAnterior)
    ? intencaoAnterior.filter((i) => i && typeof i.funcao === 'string' && i.funcao.trim())
    : [];
  const argsDeclarados = {};
  for (const i of intencaoSegura) if (i.args && typeof i.args === 'object' && !Array.isArray(i.args)) argsDeclarados[i.funcao] = i.args;
  // `prioridade: false` no item (host: resposta LONGA depois da intenção — pedido com assunto próprio, spec §5.3 "Ajuste
  // da revisão do conjunto"): a leitura declarada continua no espaço e o Jev ainda julga `intencao_vale`, mas ela NÃO
  // fura a ordem do passo 1 (nem a vaga de K). Sem a marca (resposta curta), vale a prioridade de sempre.
  const leiturasDeclaradas = intencaoSegura.filter((i) => i.effect === 'read' && i.prioridade !== false).map((i) => i.funcao);
  // `null` até o passo 1 responder; depois `{ vale, confianca, motivo? }`.
  let intencaoJulgada = intencaoSegura.length ? null : undefined;
  const intencaoAtiva = () => intencaoSegura.length > 0 && intencaoJulgada?.vale !== false;
  const orc = {
    maxPassos: sanear(orcamentoSeguro.maxPassos, ORCAMENTO_PADRAO.maxPassos, (v) => v >= 1),
    prazoTotalMs: sanear(orcamentoSeguro.prazoTotalMs, ORCAMENTO_PADRAO.prazoTotalMs, (v) => v > 0),
    prazoPassoMs: sanear(orcamentoSeguro.prazoPassoMs, ORCAMENTO_PADRAO.prazoPassoMs, (v) => v > 0),
  };
  const k = sanear(kBruto, K_PADRAO, (v) => Number.isInteger(v) && v >= 1);
  const corteAcao = sanear(cortesSeguro.acao, CORTE_ACAO_PADRAO, (v) => v >= 0 && v <= 1);
  const corteFim = sanear(cortesSeguro.fim, CORTE_FIM_PADRAO, (v) => v >= 0 && v <= 1);
  const pisoExecucao = sanear(cortesSeguro.execucao, PISO_EXECUCAO, (v) => v >= 0 && v <= 1);
  const pisoEscrita = sanear(cortesSeguro.escrita, PISO_ESCRITA, (v) => v >= 0 && v <= 1);
  // Piso do ARGUMENTO, separado do da ação (`cortes.execucaoArgs`) e DESLIGADO por padrão (0). Decisão
  // do controller, medição de 01/10 (Jev real, 8 repetições): o argumento CERTO de uma continuação de
  // conversa vem com confiança 0,15-0,34 ("e da lista de contas?" → `lista: Contas a pagar`), a mesma faixa
  // do argumento inventado (`si_listar.tipo` a 0,17). Com piso de argumento a 0,4 o #25 cai de 8/8 para 0/8:
  // omitir o filtro abre a consulta (`task_listar {}`), e o item ainda sai com confiança alta. O mecanismo
  // existe e é configurável; só não é ligado por padrão. O piso da ação (`PISO_EXECUCAO`) segue valendo.
  const pisoArgs = sanear(cortesSeguro.execucaoArgs, 0, (v) => v >= 0 && v <= 1);
  const t0 = performance.now();
  const decorrido = () => performance.now() - t0;
  const avisar = (evento) => { try { aoPasso?.(evento); } catch { /* observabilidade nunca derruba o loop */ } };
  const rastro = [];
  const carregadas = [];
  const passos = [];
  let funcoes = [...(espacoSeguro.funcoes ?? [])].filter((f) => f && typeof f.nome === 'string');
  let candidatas = [...(espacoSeguro.candidatas ?? [])].filter((c) => c && typeof c.id === 'string');
  // Correção (sessão 7fe31cb7, 24/09): `extra` carrega campos opcionais do resultado de fim —
  // hoje só `paraOModelo` (funções que o Jev escolheu mas não pôde preencher, ver a checagem de
  // "obrigatório sem opção" mais abaixo). Opcional e não usado pela maioria dos `fim(...)`
  // existentes — `extras` vira `{}` quando ausente, sem mudar nenhum contrato antigo.
  const fim = (estado, motivo, extra) => {
    const ms = Math.round(decorrido());
    const extras = extra && typeof extra === 'object' ? extra : {};
    const comIntencao = intencaoSegura.length ? { intencao: intencaoJulgada ?? { vale: false, confianca: null, motivo: 'nao-julgada' } } : {};
    avisar({ tipo: 'fim', estado, ms, ...(motivo ? { motivo } : {}), ...extras, ...comIntencao });
    return { estado, ...(motivo ? { motivo } : {}), rastro, carregadas, passos, ms, ...extras, ...comIntencao };
  };
  if ((!funcoes.length && !candidatas.length) || !cliente) return { estado: 'vazio', rastro, carregadas, passos, ms: 0 };
  avisar({ tipo: 'inicio', funcoes: funcoes.map((f) => f.nome), candidatas: candidatas.map((c) => c.id) });

  const paramsCache = new Map();
  // C1/I5: params normalizados e com prazo — estouro ou rejeição vira `[]` para aquela função,
  // nunca lança e nunca deixa a chamada pendurada além do orçamento.
  const paramsDe = (f, restanteMs) => {
    if (!paramsCache.has(f.nome)) {
      const bruta = comPrazo(Promise.resolve().then(() => f.params()), restanteMs).catch(() => []);
      paramsCache.set(f.nome, bruta.then((p) => normalizarParams(p)));
    }
    return paramsCache.get(f.nome);
  };
  // Spec 2026-10-14 §6.2: ids rotulados — do host (turnos anteriores) e do rastro DESTE turno (mais recente
  // primeiro). `produzDeFuncao` guarda o `produz` na hora da execução: `tirar()` pode remover a função de
  // `funcoes` depois de ela já ter rendido resultado.
  const produzDeFuncao = new Map();
  const rotuladosAgora = () => mesclarRotulados(
    ...rastro.filter((r) => !r.erro).reverse().map((r) => extrairRotulados(r.resultado, produzDeFuncao.get(r.fn))),
    valoresRotulados ?? {},
  );
  // Fontes extras de opção, em ordem: herdadas → declaradas (se a intenção vale) → rotuladas.
  const comFontesExtras = (params, nome) => {
    const herdados = comOpcoesHerdadas(params, argsHerdados[nome]);
    const declarados = intencaoAtiva() ? comOpcoesDeclaradas(herdados, argsDeclarados[nome]) : herdados;
    return comOpcoesRotuladas(declarados, rotuladosAgora());
  };
  // Melhoria C (sessão 2026-09-23/24, decisão do dono — sessão 0201256f: "e as concluídas?"
  // perdeu `task_listar` do `comArgs` do passo 1 porque o kairos só pontua a PERGUNTA ATUAL —
  // `task_listar` caiu em 7º na ordem por score, fora do K de 3, mesmo sendo a MESMA função que
  // `consultasAnteriores` mostra ter sido executada no turno anterior). As funções que o turno
  // anterior já executou têm o maior peso: entram no TOPO da ordem que decide `comArgs`, na
  // frente do score do kairos (`funcoes`/`ordem` já chegam ordenadas por ele — `ordenarPorScore`,
  // `@igris/orchestrator/loop-do-turno.js`). Calculado UMA vez fora do laço (a lista de consultas
  // anteriores não muda durante ESTE loop — é de turno(s) já encerrados): mais recente primeiro
  // (é a continuação mais provável do pedido atual), sem duplicar. `passo.js` já instrui o Jev a
  // herdar argumento de `consultasAnteriores` (`INSTRUCAO_CONSULTAS_ANTERIORES`) — esta mudança é
  // o que garante que a função chegue a `comArgs` para essa herança valer no passo 1, em vez de
  // só entrar via `foraDasK` (que gasta um passo a mais só perguntando os argumentos).
  const nomesDoTurnoAnterior = [];
  for (let i = consultasAnterioresSeguras.length - 1; i >= 0; i--) {
    const nome = consultasAnterioresSeguras[i].funcao;
    if (!nomesDoTurnoAnterior.includes(nome)) nomesDoTurnoAnterior.push(nome);
  }
  const jaChamadas = new Set();
  // Calibração 3 (sessão 2026-09-23, diagnóstico categoria 7 com `conversa`): funções cuja
  // chamada bem-sucedida já veio acompanhada de `mais: 'nao'` (nesta MESMA chamada — ver
  // `semMaisConfirmado.add` logo antes do corte de `corteFim`, abaixo), mesmo com confiança
  // insuficiente para encerrar o loop inteiro ali (`confiancaMais < corteFim`). Medido: com
  // `conversa` no estado, a confiança de `mais` fica sistematicamente mais baixa (0,00-0,83)
  // porque o valor usado no argumento (herdado da conversa) carrega incerteza própria — o
  // corte de 0,85 continua correto para decidir se o LOOP INTEIRO pode parar (outros
  // assuntos do pedido podem faltar), mas reaproveitar esse `nao` para vetar RESSELEÇÃO DA
  // MESMA função é seguro mesmo com confiança baixa: só corta uma repetição do que já foi
  // consultado, nunca uma função DIFERENTE que o Jev ainda não tocou. Sem isso, o Jev
  // reselecionava a mesma função com args piores (ex.: `gcal_listar_eventos` sem `periodo`,
  // cenário #26) ou ficava girando até o teto de passos sem nunca dizer `pronto` (#27).
  const semMaisConfirmado = new Set();
  const tirar = (nome) => { funcoes = funcoes.filter((f) => f.nome !== nome); };
  // Funções com parâmetro obrigatório sem opção que caíram entre as K (ver o laço de `comArgs`):
  // seguem em `funcoes` (oferecidas em `acao`), mas sem perguntas de argumento e sem vaga de K.
  const soOModeloPreenche = new Set();
  // Ordem para escolher as K: primeiro as funções do turno anterior (`nomesDoTurnoAnterior`,
  // acima), depois a do motor (a ordem do espaço, já por score do kairos); nos passos seguintes,
  // as probabilidades que o próprio Jev deu em `acao` (spec §3.2) — a prioridade do turno
  // anterior é REAPLICADA a cada passo logo abaixo (`ordemComPrioridadeAnterior`), não só aqui,
  // senão a partir do passo 2 a atualização de `ordem` pelo `peloJev` a apagaria.
  // Função da consulta anterior FORA do espaço deste turno (dono, 10/10, bancada 28098471): a capacidade dela ficou
  // carregada de antes, mas o espaço só traz as que o anel provider classificou NESTE turno — "busca de novo esse
  // desenho" não tinha `arquivo_buscar` para repetir. Traz SÓ essas funções, pela capacidade do nome exposto
  // (`cap__fn`), com o mesmo `carregar` das candidatas; falha ou demora não atrapalha o loop.
  const faltamDoAnterior = nomesDoTurnoAnterior.filter((nome) => nome.includes('__') && !funcoes.some((f) => f.nome === nome));
  if (faltamDoAnterior.length && typeof carregar === 'function') {
    for (const cap of new Set(faltamDoAnterior.map((nome) => nome.slice(0, nome.indexOf('__'))))) {
      try {
        const r = await comCancelamento(Promise.resolve().then(() => carregar(cap, signal)), { signal, ms: orc.prazoPassoMs });
        const trazidas = Array.isArray(r?.valor) ? r.valor.filter((f) => f && faltamDoAnterior.includes(f.nome) && !funcoes.some((x) => x.nome === f.nome)) : [];
        funcoes = [...funcoes, ...trazidas];
      } catch { /* sem a função anterior, o loop segue com o espaço do turno */ }
    }
  }
  // Spec 2026-10-14 §5.3: leituras declaradas na intenção FORA do espaço vêm pela capacidade, com a mesma forma.
  const faltamDaIntencao = intencaoSegura.filter((i) => i.effect === 'read' && !funcoes.some((f) => f.nome === i.funcao));
  if (faltamDaIntencao.length && typeof carregar === 'function') {
    for (const cap of new Set(faltamDaIntencao.map((i) => i.capacidade).filter(Boolean))) {
      try {
        const r = await comCancelamento(Promise.resolve().then(() => carregar(cap, signal)), { signal, ms: orc.prazoPassoMs });
        const nomes = new Set(faltamDaIntencao.map((i) => i.funcao));
        const trazidas = Array.isArray(r?.valor) ? r.valor.filter((f) => f && nomes.has(f.nome) && !funcoes.some((x) => x.nome === f.nome)) : [];
        funcoes = [...funcoes, ...trazidas];
      } catch { /* sem a função declarada, o loop segue com o espaço do turno */ }
    }
  }
  let ordem = [...leiturasDeclaradas, ...nomesDoTurnoAnterior, ...funcoes.map((f) => f.nome)].filter((nome, i, arr) => arr.indexOf(nome) === i);
  // Calibração 4: nomes das funções que ENTRARAM no espaço no último `carregar_` (limpo depois de
  // usado uma vez, ver abaixo) — só vale para o PRÓXIMO passo, não fica valendo o loop inteiro.
  let recemCarregadas = new Set();

  try {
    for (let n = 1; ; n++) {
      if (signal?.aborted) return fim('cancelado');
      if (n > orc.maxPassos) return fim('estourado', 'teto de passos');
      const restante = orc.prazoTotalMs - decorrido();
      if (restante < PISO_MS) return fim('estourado', 'prazo total');

      // I4: função já chamada com sucesso (sem erro no rastro) não disputa vaga de K de novo —
      // vai para o fim da ordem só para efeito de "quem recebe pergunta de argumento".
      const chamadasComSucesso = new Set(rastro.filter((r) => !r.erro).map((r) => r.fn));
      // Melhoria C: reaplica a prioridade do turno anterior a CADA passo (ver comentário de
      // `nomesDoTurnoAnterior` acima) — sempre na frente do resto de `ordem`, mas ainda cedendo à
      // regra I4 logo abaixo: uma função já resolvida NESTE turno vai para o fim mesmo que tenha
      // vindo do turno anterior (herdar argumento de antes nunca é motivo para reconsultar algo
      // que este turno já respondeu).
      const prioridade = [...(intencaoAtiva() ? leiturasDeclaradas : []), ...nomesDoTurnoAnterior];
      const ordemComPrioridadeAnterior = [...prioridade, ...ordem].filter((nome, i, arr) => arr.indexOf(nome) === i);
      const ordemParaK = [
        ...ordemComPrioridadeAnterior.filter((nome) => !chamadasComSucesso.has(nome)),
        ...ordemComPrioridadeAnterior.filter((nome) => chamadasComSucesso.has(nome)),
      ];
      // `soOModeloPreenche`: funções que já se mostraram com obrigatório sem opção — não disputam
      // vaga de K de novo (seguem oferecidas em `acao`, ver o laço de `comArgs`, abaixo).
      const candidatosParaK = ordemParaK.filter((nome) => !soOModeloPreenche.has(nome) && funcoes.some((f) => f.nome === nome));
      // Registro para o tracer (`espacoOferecido.prioridadeConsultasAnteriores` abaixo): quais
      // funções do turno anterior de fato disputaram vaga de K neste passo (ainda no espaço,
      // ainda sem sucesso neste turno) — não muda a ordenação por si só, só documenta a origem.
      const prioridadeConsultasAnteriores = nomesDoTurnoAnterior.filter(
        (nome) => candidatosParaK.includes(nome) && !chamadasComSucesso.has(nome),
      );
      // Calibração 4: no passo seguinte a um `carregar_`, se as funções recém-carregadas ainda
      // disponíveis forem poucas (`TETO_RECEM_CARREGADAS`), TODAS elas entram em `comArgs` — não
      // só as K primeiras da ordem (que não tem score de relevância para decidir entre elas, ver
      // comentário de `TETO_RECEM_CARREGADAS`). `recemCarregadas` só vale por ESTE passo — limpa
      // logo abaixo, nunca reaplica no passo seguinte sem um novo `carregar_`.
      const aindaRecemCarregadas = candidatosParaK.filter((nome) => recemCarregadas.has(nome));
      const nomesK = aindaRecemCarregadas.length && aindaRecemCarregadas.length <= TETO_RECEM_CARREGADAS
        ? [...new Set([...aindaRecemCarregadas, ...candidatosParaK.slice(0, k)])]
        : candidatosParaK.slice(0, k);
      recemCarregadas = new Set();
      // I5: params das K em paralelo, cada uma com o prazo restante.
      const resolvidos = await Promise.all(nomesK.map(async (nome) => {
        const f = funcoes.find((x) => x.nome === nome);
        // Valor da consulta anterior vira OPÇÃO do parâmetro (dono, 10/10): sem isto, parâmetro de texto livre (o
        // `query` de uma busca) não tinha opção nenhuma e a repetição da chamada sempre ia ao modelo.
        return { nome, params: comFontesExtras(await paramsDe(f, orc.prazoTotalMs - decorrido()), nome) };
      }));
      const comArgs = [];
      for (const { nome, params } of resolvidos) {
        // Propriedade obrigatória sem opção (spec §3.2: o Jev nunca inventa valor): a função NÃO
        // recebe perguntas de argumento neste passo — mas continua no espaço e, portanto, entre as
        // opções de `acao`. Correção (re-revisão do conjunto, 7fe31cb7): o `tirar(nome)` antigo
        // tirava a função também de `acao`, então o Jev nunca a via e escolhia um substituto
        // (`gcal_listar_eventos` herdando `periodo` do turno anterior no lugar de
        // `gcal_disponibilidade`) — a mesma troca silenciosa do caminho fora das K. Se o Jev a
        // escolher, `lerPasso` devolve `foraDasK: true` (ela não está em `comArgs`) e o ramo
        // `foraDasK`, mais abaixo, confere `paramsCache` (mesmo resultado, cache por função),
        // encerra o loop e a devolve em `paraOModelo`. `soOModeloPreenche` só evita que ela gaste
        // vaga de K nos passos seguintes (ver `candidatosParaK`).
        // Lote 2 (30/09): `exigeOModelo` cobre também os grupos obrigatórios do schema (`umDe`) em que
        // nenhum grupo dá para o Jev completar (ex.: `note_ler`, id|path sem opções).
        if (exigeOModelo(params)) {
          soOModeloPreenche.add(nome); continue;
        }
        comArgs.push({ nome, params });
      }
      if (!funcoes.length && !candidatas.length) return fim('pronto', 'espaço esgotado');
      // N2/N1: params podem levar quase todo o prazo total (cada um corre com o seu próprio
      // resto via `paramsDe`, mas o passo só segue depois que TODOS voltam) — reconfere o piso
      // aqui, depois deles, em vez de reusar o `restante` de antes de esperar; senão um
      // `prazoTotalMs` curto com params lentos escapa do corte e só estoura na EXECUÇÃO, minutos
      // (relativamente) depois do previsto.
      if (signal?.aborted) return fim('cancelado');
      const restanteAposParams = orc.prazoTotalMs - decorrido();
      if (restanteAposParams < PISO_MS) return fim('estourado', 'prazo total');

      const state = {
        pedido: pergunta,
        ...(contexto ? { contexto } : {}),
        // `conversa` (2026-09-23): cópia PRÓPRIA deste passo (`[...conversaSegura]`) — `cortarEstado`
        // faz `shift()` nela sob pressão de tamanho, e a lista sanada é compartilhada entre todos
        // os passos do loop (montada uma vez, fora do `for`); sem a cópia, um corte no passo 1
        // encolheria a conversa vista pelos passos seguintes também.
        ...(conversaSegura.length ? { conversa: [...conversaSegura] } : {}),
        // Melhoria A: cópia PRÓPRIA deste passo, mesmo motivo de `conversa` acima (`cortarEstado`
        // faz `shift()` sob pressão de tamanho; a lista sanada é compartilhada entre todos os
        // passos do loop, montada uma vez fora do `for`).
        ...(consultasAnterioresSeguras.length ? { consultasAnteriores: [...consultasAnterioresSeguras] } : {}),
        // Spec 2026-10-14 §5.3 item 4: só no passo 1 (a pergunta `intencao_vale` só existe nele). Cópia
        // própria, cortável: a lista também vai na instrução de `intencao_vale`, então perdê-la aqui
        // sob pressão de tamanho não tira do Jev o que ele precisa para julgar.
        ...(n === 1 && intencaoSegura.length
          ? { intencaoAnterior: intencaoSegura.map((i) => ({ funcao: i.funcao, ...(i.args ? { args: i.args } : {}) })) }
          : {}),
        rastro: rastro.map((r) => ({ funcao: r.fn, args: r.args, ...(r.erro ? { erro: r.erro } : { resultado: r.resultadoResumido }) })),
      };
      cortarEstado(state, {
        tetoChars: TETO_CHARS_ESTADO,
        ordemDeCorte: [
          // `conversa` cede PRIMEIRO: é texto livre, a fonte menos estruturada de pano de fundo.
          // `consultasAnteriores` cede em SEGUNDO — mais estruturado e mais barato de o Jev
          // aproveitar para herdar argumento (é o dado que a Melhoria A introduz para resolver
          // "e a da OKDS?" perdendo `periodo`), então mais protegido que a conversa em texto
          // livre — mas ainda cede ANTES do `rastro`: o que o loop já consultou NESTE turno
          // pesa mais que o que foi consultado em turnos passados.
          { rotulo: 'conversa', cortar: () => (state.conversa?.length ? (state.conversa.shift(), true) : false) },
          { rotulo: 'consultasAnteriores', cortar: () => (state.consultasAnteriores?.length ? (state.consultasAnteriores.shift(), true) : false) },
          { rotulo: 'intencaoAnterior', cortar: () => (state.intencaoAnterior?.length ? (state.intencaoAnterior.shift(), true) : false) },
          { rotulo: 'rastro', cortar: () => (state.rastro.length > 1 ? (state.rastro.shift(), true) : false) },
          { rotulo: 'contexto', cortar: () => (state.contexto ? (delete state.contexto, true) : false) },
        ],
      });
      // C1: `acao` soma 2 opções fixas (`pronto`/`bloqueado`) às funções e candidatas — corta a
      // cauda (pela ordem atual) pra caber em 255 opções; se as candidatas sozinhas passarem do
      // teto, corta as candidatas também.
      let candidatasOferecidas = candidatas;
      if (candidatasOferecidas.length > TETO_ACAO_OFERECIDAS) candidatasOferecidas = candidatasOferecidas.slice(0, TETO_ACAO_OFERECIDAS);
      const espacoFuncoes = Math.max(0, TETO_ACAO_OFERECIDAS - candidatasOferecidas.length);
      const nomesNaOrdem = ordem.filter((nome) => funcoes.some((f) => f.nome === nome));
      const nomesForaDaOrdem = funcoes.map((f) => f.nome).filter((nome) => !nomesNaOrdem.includes(nome));
      const nomesFuncoesOferecidas = [...nomesNaOrdem, ...nomesForaDaOrdem].slice(0, espacoFuncoes);
      const funcoesOferecidas = nomesFuncoesOferecidas.map((nome) => funcoes.find((f) => f.nome === nome));

      // Calibração 2: `state.rastro` já foi montado acima (com o corte de tamanho aplicado) —
      // repassado para `perguntasDoPasso` só para o texto de `mais` embutir o resumo do que já
      // foi consultado (ver passo.js `instrucoesMais`).
      const questions = perguntasDoPasso({
        funcoes: funcoesOferecidas.map((f) => ({ nome: f.nome, descricao: f.descricao, autorizada: Boolean(f.autorizada) })), candidatas: candidatasOferecidas, comArgs, rastro: state.rastro,
        temMemorias: Array.isArray(contexto) ? contexto.length > 0 : Boolean(contexto),
        intencao: n === 1 && intencaoSegura.length ? intencaoSegura : null,
      });
      // Instrumentação completa do turno pela fábrica (2026-09-23, decisão do dono: "tudo que a
      // fábrica faz tem que ir para o Tracer"): o espaço OFERECIDO neste passo — as funções e
      // candidatas mandadas ao Jev, as K com argumentos perguntados (`comArgs`, já com as opções
      // por parâmetro e a fonte de cada uma — `paramsDaTool`, `@igris/executor/fabrica/loop.js`)
      // e por que elas entraram (recém-carregadas por um `carregar_` anterior furam a ordem por
      // score, ver `TETO_RECEM_CARREGADAS` acima). Avisado ANTES da chamada ao Jev — o host
      // (fábrica) grava isto no artefato mesmo que o passo degrade ou seja cancelado a seguir.
      const espacoOferecido = {
        funcoesOferecidas: nomesFuncoesOferecidas, candidatasOferecidas: candidatasOferecidas.map((c) => c.id),
        comArgs, recemCarregadas: [...aindaRecemCarregadas],
        // Melhoria C: nomes das funções do turno anterior que estavam disputando vaga de K neste
        // passo — ver `prioridadeConsultasAnteriores` acima.
        prioridadeConsultasAnteriores: [...prioridadeConsultasAnteriores],
        criterioK: [
          prioridadeConsultasAnteriores.length ? 'consultas-anteriores' : null,
          aindaRecemCarregadas.length ? 'recem-carregadas' : null,
          'score',
        ].filter(Boolean).join(' + '),
      };
      avisar({ tipo: 'espaco', passo: n, ...espacoOferecido });
      const t0Passo = decorrido();
      // N1: a chamada ao Jev corre na mesma corrida contra o abort que a execução usa — sem
      // isso, um abort durante a chamada (o Jev pode legitimamente levar mais que o prazo macio
      // por baixo) só era notado depois que `perguntar` resolvesse, e podia até chegar a
      // executar. `comCancelamento` sem `ms` não duplica o prazo interno do `perguntar`.
      const rp = await comCancelamento(
        Promise.resolve().then(() => perguntar({
          state, questions, cliente, prazoMs: Math.min(orc.prazoPassoMs, restanteAposParams),
          aoChegarTarde: (t) => {
            avisar({ tipo: 'tardia', passo: n, msReal: t?.meta?.msReal ?? null });
            // Instrumentação completa: a resposta tardia chega DEPOIS deste passo já ter
            // encerrado o loop (`jev:degradado (timeout)`) — segundo evento, `tardia: true`, com
            // o corpo inteiro que chegou (mesma garantia de `criar-refinador-jev.js`).
            avisar({ tipo: 'jev', passo: n, origem: 'loop', tardia: true, state, questions, answers: t?.answers, meta: t?.meta, inicioMs: Math.round(t0Passo) });
          },
        })),
        { signal },
      );
      if (rp.cancelado) return fim('cancelado');
      const { answers, meta } = rp.valor ?? { answers: {}, meta: { degradado: 'erro', ms: Math.round(decorrido()), erro: rp.erro } };
      if (signal?.aborted) return fim('cancelado');
      // Instrumentação completa: UM evento `jev` por passo (não-tardio) — bruto (`state`/
      // `questions`/`answers`/`meta`), com início relativo ao PASSO (o motor não conhece o
      // início do TURNO inteiro; o host soma o que falta) e a duração já em `meta.ms`.
      avisar({ tipo: 'jev', passo: n, origem: 'loop', tardia: false, state, questions, answers, meta, inicioMs: Math.round(t0Passo) });
      if (meta.degradado) {
        passos.push({ passo: n, degradado: meta.degradado, ms: meta.ms, espacoOferecido, jev: { state, questions, answers, meta } });
        if (n === 1 && intencaoSegura.length) intencaoJulgada = { vale: false, confianca: null, motivo: 'jev-degradado' };
        return fim('estourado', `jev: ${meta.degradado}`);
      }

      const lido = lerPasso(answers, { comArgs, herdados: argsHerdados, pisoExecucao: pisoArgs });
      if (n === 1 && intencaoSegura.length) {
        intencaoJulgada = typeof lido.intencaoVale === 'number'
          ? { vale: lido.intencaoVale >= CORTE_INTENCAO, confianca: lido.intencaoVale }
          : { vale: false, confianca: null, motivo: 'sem-resposta' };
      }
      // M-confiança (correção da revisão do conjunto): o artefato do loop (`passos[]`) só levava
      // `confianca` (o mínimo entre ação e argumentos — o que decide histórico/bloco na entrega),
      // nunca `confiancaAcao` (só a confiança de `acao`, sem misturar com a dos argumentos — o que
      // de fato decide a PARADA do loop, ver `lerPasso` acima e o corte logo abaixo). Sem os dois
      // lado a lado no registro, quem inspeciona um `fabrica.json` não tinha como distinguir "o
      // loop parou porque a ação era incerta" de "a ação era certa mas um argumento não foi".
      const registro = {
        passo: n, acao: lido.acao, confianca: lido.confianca, confiancaAcao: lido.confiancaAcao,
        // Melhoria 1: `mais`/`confiancaMais` sempre registrados, mesmo quando `acao` não é uma
        // função executável (carregar/pronto/bloqueado) — é a MESMA chamada que já respondeu
        // `acao`; quem decide se o valor importa é o trecho logo após a execução, abaixo.
        mais: lido.mais, confiancaMais: lido.confiancaMais,
        args: lido.args, argsOmitidos: lido.argsOmitidos, ...(lido.foraDaLista?.length ? { foraDaLista: lido.foraDaLista } : {}),
        ...(lido.argsAbaixoDoPiso?.length ? { argsAbaixoDoPiso: lido.argsAbaixoDoPiso } : {}),
        probabilidades: lido.probabilidades, ms: meta.ms,
        ...(n === 1 && intencaoSegura.length ? { intencaoVale: lido.intencaoVale } : {}),
        // Instrumentação completa (2026-09-23): espaço oferecido + a chamada bruta ao Jev deste
        // passo — o host (fábrica) decide se preserva ou descarta em modo `resumo`
        // (`IGRIS_TRACE_FABRICA`); o motor sempre captura (são referências, não cópias
        // profundas — custo desprezível).
        espacoOferecido, jev: { state, questions, answers, meta },
      };
      passos.push(registro);
      avisar({ tipo: 'decisao', ...registro });
      const peloJev = Object.entries(lido.probabilidades).sort((a, b) => b[1] - a[1]).map(([nome]) => nome);
      ordem = [...peloJev, ...ordem].filter((nome, i, arr) => arr.indexOf(nome) === i);

      // I1: o corte de "vale como pronto" usa a confiança da AÇÃO, não o mínimo com argumentos
      // (`confianca`, que continua indo para o rastro — é o que a entrega usa pra histórico/bloco).
      // Correção (sessão fbab5b12, 22/09): "Tem uma lista de tarefa aí chamado trabalho" — o Jev
      // escolheu `task_listar` com `confiancaAcao` 0.26 (abaixo do corte 0,4) e o loop virou
      // `pronto` sem executar nada, mesmo as funções de LEITURA somando 0,89 contra 0,09 de
      // `pronto` (ele só estava dividido sobre QUAL leitura, não SE deveria ler). Quando a ação
      // escolhida é uma FUNÇÃO do espaço deste passo (não `pronto`/`bloqueado`/`carregar_*`) e a
      // confiança da ação não basta sozinha, `confiancaLeitura` soma as probabilidades das
      // funções OFERECIDAS neste passo (`nomesFuncoesOferecidas` — ignora `pronto`, `bloqueado` e
      // `carregar_*`); se isso bate o corte, executa a função escolhida normalmente. `confianca`/
      // `confiancaAcao` do item não mudam — continuam baixas, então na entrega vão para o bloco
      // de confiança baixa, não para o histórico; só a decisão de PARAR o loop muda.
      // ATENÇÃO (revisão do conjunto, M2): este ramo só age quando `cortes.execucao < cortes.acao` — a soma
      // das leituras faz a ação passar do corte de "pronto", mas o piso de execução (adiante) ainda barra
      // quando `confiancaAcao < pisoExecucao`. No padrão (ambos 0,4) a soma só destrava ações que o piso
      // recusa em seguida: o ramo fica INERTE. Só tem efeito se o piso de execução for configurado mais baixo.
      let acaoConfiavel = Boolean(lido.acao) && lido.confiancaAcao >= corteAcao;
      if (!acaoConfiavel && lido.acao && lido.acao !== ACAO_PRONTO && lido.acao !== ACAO_BLOQUEADO
        && !lido.acao.startsWith(PREFIXO_CARREGAR) && nomesFuncoesOferecidas.includes(lido.acao)
        && !funcoes.find((f) => f.nome === lido.acao)?.autorizada) {
        const confiancaLeitura = nomesFuncoesOferecidas.reduce((soma, nome) => {
          const p = lido.probabilidades?.[nome];
          return soma + (typeof p === 'number' && Number.isFinite(p) ? p : 0);
        }, 0);
        registro.confiancaLeitura = confiancaLeitura;
        if (confiancaLeitura >= corteAcao) acaoConfiavel = true;
      }
      if (!lido.acao || lido.acao === ACAO_PRONTO || !acaoConfiavel) return fim('pronto');
      if (lido.acao === ACAO_BLOQUEADO) return fim('bloqueado');

      if (lido.acao.startsWith(PREFIXO_CARREGAR)) {
        const id = lido.acao.slice(PREFIXO_CARREGAR.length);
        if (!candidatas.some((c) => c.id === id) || typeof carregar !== 'function') return fim('pronto');
        candidatas = candidatas.filter((c) => c.id !== id);
        const restanteCarregar = orc.prazoTotalMs - decorrido();
        if (restanteCarregar < PISO_MS) return fim('estourado', 'prazo total');
        if (signal?.aborted) return fim('cancelado');
        // N4: `carregar` recebe o mesmo tipo de sinal combinado que `executar` (turno + prazo do
        // que falta) — ver JSDoc acima sobre idempotência. N6: `limpar()` sempre no `finally`,
        // assim que a corrida decidir, pra não deixar o timer do controller pendurado.
        const { signal: sinalCarregar, limpar: limparCarregar } = criarSinalCombinado(signal, restanteCarregar);
        let r;
        try {
          r = await comCancelamento(Promise.resolve().then(() => carregar(id, sinalCarregar)), { signal, ms: restanteCarregar });
        } finally {
          limparCarregar();
        }
        if (r.cancelado) return fim('cancelado');
        // I6: só conta como carregada em sucesso; falha (lançou, prazo, ou não devolveu array)
        // vira aviso e segue — a candidata já saiu da lista, então não é oferecida de novo.
        if (r.erro || !Array.isArray(r.valor)) {
          avisar({ tipo: 'carregar', passo: n, capacidade: id, erro: r.erro ?? 'carregar não devolveu um array' });
          continue;
        }
        carregadas.push(id);
        const ineditas = r.valor.filter((f) => !funcoes.some((x) => x.nome === f.nome));
        funcoes = [...funcoes, ...ineditas];
        ordem = [...ineditas.map((f) => f.nome), ...ordem];
        // Calibração 4: marca as recém-carregadas para o PRÓXIMO passo (lido no início do laço,
        // logo depois limpo) — `carregar_` pode acontecer mais de uma vez no mesmo loop
        // (2 capacidades candidatas), então cada carga tem sua própria janela de "recente".
        recemCarregadas = new Set(ineditas.map((f) => f.nome));
        avisar({ tipo: 'carregar', passo: n, capacidade: id, funcoes: ineditas.map((f) => f.nome) });
        continue;
      }

      const fn = funcoes.find((f) => f.nome === lido.acao);
      if (!fn) return fim('pronto');
      // Piso de execução (Task 4): a ação passou pelo corte de "vale como pronto" (acima — direto, ou pela
      // soma das leituras), mas a confiança da AÇÃO em si está abaixo do piso: o Jev não sabe SE esta
      // função é a certa, só que alguma leitura é. Não executa (o resultado errado entraria no contexto
      // do modelo e gastaria tempo); devolve a função ao modelo, mesmo tratamento de `faltaObrigatoria`.
      const pisoDaFuncao = fn.autorizada ? Math.max(pisoExecucao, pisoEscrita) : pisoExecucao;
      if (lido.confiancaAcao < pisoDaFuncao) {
        registro.abaixoDoPiso = true;
        return fim('pronto', `confiança abaixo do piso de ${fn.autorizada ? 'escrita' : 'execução'} (${lido.confiancaAcao.toFixed(2)} < ${pisoDaFuncao}): ${fn.nome}`, { paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }] });
      }
      // Correção (revisão do conjunto, 7fe31cb7, 24/09): irmão do bug de "obrigatório sem opção"
      // (caminho (a), acima) — aqui o parâmetro TEM opção (foi perguntado em `comArgs`), mas a
      // resposta não veio válida (ausente, inválida, ou a pergunta nem coube no TETO_PERGUNTAS do
      // passo — `lerPasso`, `passo.js`). Chegamos aqui só quando a ação já passou pelo corte de
      // confiança (`acaoConfiavel`, ver o `return fim('pronto')` mais acima) — o Jev escolheu esta
      // função com confiança. `tirar(fn.nome); continue;` (comportamento antigo) fazia a função sair
      // do espaço em SILÊNCIO e o Jev reselecionava outra no passo seguinte, sem o modelo nunca
      // saber que a escolha original ficou sem resposta — mesma classe do defeito corrigido em
      // 9edeea6b (prova do revisor: `E:\tmp\rev-7fe31cb7\prova-irmaos.mjs`, caso A). Mesmo
      // tratamento do caminho (a): encerra aqui e devolve a função para o modelo decidir/perguntar
      // o argumento que faltou, sem gastar mais um passo reselecionando.
      //
      // Lote 2 (30/09): dois irmãos entram aqui. (1) grupos obrigatórios do schema (`umDe`) sem nenhum
      // grupo completo — `lerPasso` marca `faltaObrigatoria` (`note_buscar` com `pasta: sem_argumento` e
      // `query` sem opções rodava `{}`). (2) `foraDaLista`: o Jev escolheu `FORA_DA_LISTA` — o pedido
      // NOMEIA um valor que a lista não tem ("a pasta de atas", sem pasta assim); escolher
      // `sem_argumento` ali rodava a leitura mais larga que o pedido e escolher uma opção seria errado.
      // Mesmo tratamento: encerra e devolve a função ao modelo, que tem o pedido em texto livre.
      if (lido.foraDaLista?.length) {
        return fim('pronto', `o pedido cita valor fora das opções: ${lido.foraDaLista.map((pn) => `${fn.nome}.${pn}`).join(', ')}`, { paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }] });
      }
      if (lido.faltaObrigatoria) {
        return fim('pronto', `função escolhida sem argumento obrigatório respondido: ${fn.nome}`, { paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }] });
      }
      // Revisão do conjunto (14/10): o Jev recusou a intenção NESTA mesma chamada do passo 1, mas a ação escolhida usa um
      // argumento que só a intenção oferecia (opção `fonte:'intencao'`). O plano declarado foi julgado inválido, então
      // esse valor não vale como dado: não executa (o resultado entraria no histórico como confiável) e volta ao modelo.
      if (n === 1 && intencaoJulgada?.vale === false && lido.args) {
        const paramsDaAcao = comArgs.find((f) => f.nome === fn.nome)?.params ?? [];
        const soDaIntencao = Object.entries(lido.args).some(([nomeParam, valor]) => paramsDaAcao
          .find((p) => p.nome === nomeParam)?.opcoes?.find((o) => String(o?.valor) === String(valor))?.fonte === 'intencao');
        if (soDaIntencao) {
          return fim('pronto', `intenção recusada: ${fn.nome} escolhida com argumento que só a intenção oferecia`, { paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }] });
        }
      }

      // Calibração 3: reseleção de uma função que já executou com sucesso E já tinha
      // confirmado `mais: 'nao'` naquela chamada — encerra aqui em vez de gastar mais um
      // passo repetindo (ou piorando) a mesma consulta. Ver comentário de `semMaisConfirmado`
      // acima. Não se aplica a `carregar_*`/`pronto`/`bloqueado` (não chegam neste ramo).
      if (chamadasComSucesso.has(fn.nome) && semMaisConfirmado.has(fn.nome)) {
        return fim('pronto', 'reconsulta evitada: Jev já tinha confirmado que esta função bastava');
      }
      // Calibração 3b (pista do controller, confirmada no diagnóstico): a reconsulta acima só
      // pega quem já passou por um `mais: 'nao'` — quando o PRIMEIRO `mais` depois da chamada
      // original veio `sim` (baixa confiança, cenário #26 "e a da OKDS?"), o Jev ainda assim
      // reselecionava a MESMA função com um argumento herdado A MENOS (ex.: sem `periodo`),
      // como quem "confere sem o palpite" — e essa primeira reconsulta reduzida escapava do
      // guard acima por não ter passado por um `nao` ainda. Aqui o corte é só nos ARGUMENTOS,
      // sem depender de `mais`: se os args agora propostos para esta função são um SUBCONJUNTO
      // PRÓPRIO estrito (mesmas chaves, mesmos valores, só que menos chaves) de uma chamada
      // ANTERIOR bem-sucedida da mesma função, é a mesma pergunta com menos informação — nunca
      // uma pergunta nova. Não dispara quando o valor de alguma chave MUDA (isso é uma consulta
      // genuinamente diferente, ex.: `periodo:"hoje"` depois de `periodo:"amanha"`) nem quando
      // os args crescem (mais específico, não menos).
      if (chamadasComSucesso.has(fn.nome) && lido.args && !lido.foraDasK) {
        const chavesNovas = Object.keys(lido.args);
        const reduzAlgumaAnterior = rastro.some((r) => {
          if (r.erro || r.fn !== fn.nome) return false;
          const antigos = r.args || {};
          const chavesAntigas = Object.keys(antigos);
          if (chavesNovas.length >= chavesAntigas.length) return false;
          return chavesNovas.every((k) => JSON.stringify(antigos[k]) === JSON.stringify(lido.args[k]));
        });
        if (reduzAlgumaAnterior) {
          return fim('pronto', 'reconsulta evitada: repete a mesma função com menos argumentos que uma chamada anterior');
        }
      }

      // Melhoria B (sessão 2026-09-23, medição de sessões reais 74c42d74/6cf1cfec): reconsulta
      // EXATA de uma chamada já bem-sucedida neste turno — mesma função, MESMOS argumentos (não
      // um subconjunto: isso já é a Calibração 3b acima, que cobre "menos argumentos que uma vez
      // anterior") — encerra o loop aqui, SEM depender de `mais`: reexecutar a função com os
      // MESMOS argumentos devolve o MESMO resultado, então insistir só custa mais um passo
      // (~400-500ms) sem informação nova. Diferente das travas de Calibração 3/3b (que dependem
      // de `semMaisConfirmado`/subconjunto de chaves), esta é incondicional — não muda nenhuma
      // delas, só cobre o caso que nenhuma das duas cobria: args IDÊNTICOS, sem passar por
      // `mais: 'nao'` confirmado antes. Comparação por `JSON.stringify` do objeto inteiro (mesma
      // técnica de `chave`/`jaChamadas`, logo abaixo) — segura porque `lido.args` vem sempre da
      // MESMA iteração de `alvo.params` (mesma função), então a ordem das chaves é estável entre
      // as duas chamadas. `!lido.foraDasK`: fora das K, `lido.args` é sempre `null` (a função
      // ainda não recebeu pergunta de argumento neste passo — ver `lerPasso`), então a comparação
      // nunca bateria mesmo se fosse tentada; o guard só documenta a intenção.
      if (chamadasComSucesso.has(fn.nome) && lido.args && !lido.foraDasK) {
        const igualAUmaAnterior = rastro.some((r) => !r.erro && r.fn === fn.nome && JSON.stringify(r.args ?? {}) === JSON.stringify(lido.args ?? {}));
        if (igualAUmaAnterior) {
          return fim('pronto', 'reconsulta evitada: mesma chamada (função e argumentos) já executada com sucesso neste turno');
        }
      }

      let argsParaExecutar = lido.args;
      let argsOmitidosParaExecutar = lido.argsOmitidos;
      let confiancaParaExecutar = lido.confianca;
      if (lido.foraDasK) {
        // I3: função sem parâmetro obrigatório e sem opção nenhuma não precisa de mais uma
        // rodada só para perguntar argumentos que não existem — executa já, neste passo.
        const paramsFn = comFontesExtras(await paramsDe(fn, orc.prazoTotalMs - decorrido()), fn.nome);
        // Correção (sessão 7fe31cb7, 24/09), caminho (a): a escolha fora das K pode ter parâmetro
        // obrigatório sem opção nenhuma (ex.: `gcal_disponibilidade` exige `timeMin`/`timeMax`,
        // livres, sem fonte de opção) — o Jev nunca inventa valor (spec §3.2), então promover essa
        // função só adiava o problema: no passo seguinte ela caía no `tirar` de obrigatório-sem-
        // opção (comArgs, abaixo) e SUMIA do espaço sem aviso — o Jev então reselecionava outra
        // função (ex.: `gcal_listar_eventos` herdando `periodo` do turno anterior com confiança
        // 0,24) e essa segunda escolha era entregue como se fosse a resposta certa ao pedido
        // original. Decide aqui, na mesma chamada que descobriu o parâmetro sem opção — sem gastar
        // o passo de promoção — e devolve a função escolhida em `paraOModelo` para o modelo
        // preencher o argumento (ele tem o pedido em texto livre; o Jev só escolhe entre opções).
        // `{ nome, capacidade }` (revisão do conjunto, 7fe31cb7): mesma forma que `rastro` já usa —
        // o orquestrador casa por nome+capacidade, não só por nome (que pode repetir entre
        // capacidades diferentes).
        // Lote 2: `exigeOModelo` = obrigatório sem opção OU grupos obrigatórios (`umDe`) que o Jev não completa.
        const obrigatoriaSemOpcao = exigeOModelo(paramsFn);
        if (obrigatoriaSemOpcao) {
          return fim('pronto', `função escolhida precisa de argumento que só o modelo preenche: ${fn.nome}`, { paraOModelo: [{ nome: fn.nome, capacidade: fn.capacidade }] });
        }
        const semParametrosUteis = paramsFn.every((p) => !p.opcoes.length && !p.obrigatoria);
        if (!semParametrosUteis) {
          // Escolha fora das K com parâmetro real (askável): promove na `ordem` e pergunta os
          // argumentos no passo seguinte (spec L3).
          ordem = [fn.nome, ...ordem.filter((x) => x !== fn.nome)];
          continue;
        }
        argsParaExecutar = {};
        argsOmitidosParaExecutar = [];
        confiancaParaExecutar = lido.confiancaAcao;
      }

      // N5: o piso vem ANTES de marcar `jaChamadas`/avisar `chamada` — senão o motor emite
      // `chamada` (que na fábrica já vira chip "rodando" no chat) e devolve `estourado` no
      // mesmo fôlego, sem nunca mandar o `resultado` correspondente.
      const restanteExec = orc.prazoTotalMs - decorrido();
      if (restanteExec < PISO_MS) return fim('estourado', 'prazo total');
      if (signal?.aborted) return fim('cancelado');

      const chave = `${fn.nome}\n${JSON.stringify(argsParaExecutar)}`;
      if (jaChamadas.has(chave)) { tirar(fn.nome); continue; }
      jaChamadas.add(chave);

      avisar({ tipo: 'chamada', passo: n, fn: fn.nome, capacidade: fn.capacidade, args: argsParaExecutar, confianca: confiancaParaExecutar });
      const t1 = performance.now();
      // I7/N3/N6: sinal combinado (turno + prazo do que falta) pro host poder abortar de
      // verdade; `comCancelamento` também corta o `await` na hora se o turno abortar, mesmo que
      // o host ignore o sinal. `limpar()` sempre no `finally` — nunca deixa o timer pendurado
      // além do necessário (era o `AbortSignal.timeout()` que segurava o processo depois do
      // `cancelado` já ter voltado).
      const { signal: sinalCombinado, limpar: limparExec } = criarSinalCombinado(signal, restanteExec);
      let r;
      try {
        r = await comCancelamento(Promise.resolve().then(() => executar(fn, argsParaExecutar, sinalCombinado)), { signal, ms: restanteExec });
      } finally {
        limparExec();
      }
      let resultado;
      let erro = null;
      let cancelado = false;
      if (r.cancelado) { cancelado = true; erro = 'cancelado'; }
      else if (r.erro) { erro = r.erro; }
      else { resultado = r.valor; erro = erroDoResultado(resultado); }
      // Ação autorizada que estourou o prazo ou foi cancelada DEPOIS do despacho: o efeito é DESCONHECIDO (pode ter acontecido).
      const efeitoDesconhecido = Boolean(fn.autorizada) && (cancelado || erro === 'prazo da execução');
      const item = {
        passo: n, fn: fn.nome, capacidade: fn.capacidade, args: argsParaExecutar, argsOmitidos: argsOmitidosParaExecutar,
        confianca: confiancaParaExecutar, resultado, resultadoResumido: resumirResultado(resultado), ms: Math.round(performance.now() - t1),
        ...(erro ? { erro } : {}),
        ...(efeitoDesconhecido ? { efeitoDesconhecido: true } : {}),
      };
      rastro.push(item);
      if (Array.isArray(fn.produz)) {
        produzDeFuncao.set(fn.nome, fn.produz);
        // Resultado novo com ids rotulados muda as opções das funções que só o modelo preenchia
        // (obrigatório sem opção): voltam a disputar vaga de K no passo seguinte.
        if (!erro && Object.keys(extrairRotulados(resultado, fn.produz)).length) soOModeloPreenche.clear();
      }
      if (erro) tirar(fn.nome);
      avisar({ tipo: 'resultado', passo: n, fn: fn.nome, ok: !erro, ms: item.ms, ...(erro ? { erro } : {}) });
      if (cancelado) return fim('cancelado');
      if (erro === 'prazo da execução') return fim('estourado', 'prazo total');
      // Melhoria 1 (spec §4, sessão 2026-09-23): execução deu certo E o próprio Jev, na MESMA
      // chamada que escolheu esta ação, disse que depois dela não vai precisar de mais nenhuma
      // consulta — com confiança >= corteFim. Encerra aqui, sem gastar mais uma chamada só para
      // confirmar `pronto` (o caso medido em 23/09: 1 dos 4 passos de toda sessão observada era
      // só isso). Erro de execução NUNCA cai aqui — já teria retornado (`cancelado`/`prazo`) ou
      // seguido para o próximo passo com a função fora do espaço (`tirar`, acima); `carregar_*`
      // também nunca chega aqui, tem `continue` próprio antes deste trecho.
      // Calibração 3: registra o `nao` desta função MESMO com confiança baixa — quem decide
      // se ela pode ser reaproveitada para vetar reseleção é o corte acima, no próximo passo;
      // o corte abaixo (fim do loop inteiro) continua exigindo `corteFim`, sem mudança.
      if (!erro && lido.mais === MAIS_NAO) semMaisConfirmado.add(fn.nome);
      if (!erro && lido.mais === MAIS_NAO && lido.confiancaMais >= corteFim) {
        return fim('pronto', 'jev disse que bastava');
      }
    }
  } catch (e) {
    // C1: rede final — nada aqui deveria lançar, mas o motor nunca derruba o turno do usuário.
    return fim('estourado', `erro interno: ${String(e?.message || e)}`);
  }
}

// packages/decisions/src/loop/passo.js
//
// Um passo do loop de decisão do Jev (spec 2026-09-22 §3): UMA chamada responde a próxima ação
// (`acao`, escolha única entre funções de leitura, `carregar_<cap>`, `pronto`, `bloqueado`) e os
// argumentos das K funções mais prováveis (`arg_<fn>_<param>`, escolha entre opções válidas). O
// Jev nunca escreve valor: só escolhe entre opções que vieram do schema, do power ou da mensagem.
import { choice, noul, TETO_PERGUNTAS } from '../nucleo/index.js';
import { SEM_ARGUMENTO, DESC_SEM_ARGUMENTO, FORA_DA_LISTA, DESC_FORA_DA_LISTA } from '../perguntas.js';

export const ACAO_PRONTO = 'pronto';
export const ACAO_BLOQUEADO = 'bloqueado';
export const PREFIXO_CARREGAR = 'carregar_';

// Texto calibrado contra o Jev real (fase 4, experimento `exp-texto-acao{,-2}.mjs`, 22/09):
// "novo + 1ª frase + valores" foi a única variante a passar de 7/12 para 9/12 de acerto
// estrito nos 6 cenários-sonda; as 3 falhas remanescentes não são chamada errada (ver plano).
// 2026-09-23 (spec §4.1 addendum): quando `state.conversa` vier preenchido (mensagens
// ANTERIORES da mesma sessão), ela é pano de fundo para entender REFERÊNCIAS ("essa", "a mesma",
// "e amanhã?") e para herdar filtro/período já citado antes ("e a da OKDS?" depois de "quais
// tarefas da OKDS essa semana?" deveria manter `periodo:"semana"`, medido na bancada ampliada
// categoria 7 sem esta frase: 10/15) — nunca um pedido novo a atender por conta própria. Uma
// frase só, aqui: `comArgs`/`mais` reusam esta mesma leitura sem repetir o parágrafo inteiro.
const INSTRUCAO_CONVERSA = 'Se "conversa" vier no estado, use-a só para entender referências e herdar filtro/período já citado antes — ela é pano de fundo, o pedido a atender é sempre "pedido".';
// Melhoria A (sessão 2026-09-23, spec §4.1 addendum, medição de sessões reais 74c42d74/6cf1cfec):
// "consultasAnteriores" é o companheiro ESTRUTURADO de "conversa" — a mesma continuação que o
// texto livre só sugere ("e a da OKDS?"), a lista de consultas traz LITERAL (função + argumentos
// + se deu certo, sem o resultado). Frase curta, mesmo padrão de `INSTRUCAO_CONVERSA`: reusada
// pelo texto de `acao` (aqui) e pelo texto de cada `arg_*` (mais abaixo) — sem repetir o
// parágrafo inteiro duas vezes.
const INSTRUCAO_CONSULTAS_ANTERIORES = 'Se "consultasAnteriores" vier no estado, é a lista de consultas de turnos anteriores (função + argumentos usados, sem o resultado) — use-a para saber o que já foi perguntado antes e herdar argumento omitido numa continuação curta (ex.: "e a da OKDS?" reusa o período da consulta anterior, só trocando o calendário). Isso NUNCA é resposta pronta: um pedido que troca um valor já consultado (status, período, calendário, lista) por outro — ex.: "e as concluídas?" depois de ver as pendentes — pede uma consulta NOVA com o valor trocado, nunca `pronto`; isso não vale para pedido de escrita nem confirmação de uma ação já descrita, mesmo que cite um valor de filtro.';
const INSTRUCOES_ACAO = 'Você prepara dados para um assistente responder o pedido do usuário. '
  + 'Escolha a função de leitura cujo RESULTADO traz a informação que o pedido quer, e que ainda não está no rastro. '
  + 'Funções de diagnóstico ou de listagem auxiliar (conexão, lista de listas, lista de calendários) só quando o próprio pedido for sobre elas. '
  + 'Escolha `carregar_<capacidade>` quando a informação estiver numa capacidade ainda não carregada. '
  + 'Escolha `pronto` quando nenhuma consulta ajuda: o pedido é conversa, é uma ação de escrita (criar, editar, apagar), ou o RASTRO DESTE TURNO já contém a resposta — "conversa" e "consultasAnteriores" nunca contam sozinhos como resposta já dada, só servem para herdar valor omitido. '
  + INSTRUCAO_CONVERSA + ' ' + INSTRUCAO_CONSULTAS_ANTERIORES;
const DESC_ACAO_PRONTO = 'Nenhuma consulta ajuda agora: é conversa, é pedido de escrita, ou o rastro DESTE TURNO já tem a resposta.';
const DESC_ACAO_BLOQUEADO = 'O pedido quer uma informação que nenhuma das funções traz.';

// Spec 2026-10-10 §4.1: memórias orientam a escolha, só entre funções e valores das opções.
const INSTRUCAO_MEMORIAS = 'Se "contexto" vier no estado, são memórias do usuário aplicáveis a este pedido; quando uma delas indica a chamada para este pedido, escolha essa função (e só valores que estejam entre as opções) — a memória orienta a escolha, nunca cria função ou valor que não esteja nas opções.';

const INSTRUCAO_AUTORIZADAS = 'Opções marcadas AUTORIZADA são ações de escrita que o dono já autorizou, com argumentos fixos: isto é exceção à regra de escolher `pronto` para escrita. Escolha uma delas somente quando o pedido do usuário pede exatamente aquela ação; nunca por semelhança vaga, e nunca para um pedido que não a pede.';

// Spec 2026-10-10 §4.1: a instrução de memória também vale nas perguntas de argumento (a memória costuma trazer o
// valor, ex.: a área do dispositivo), sempre restrita às opções.
const SUFIXO_MEMORIAS_ARG = ' Se "contexto" trouxer uma memória que indica o valor deste parâmetro para este pedido, use esse valor — somente se ele estiver entre as opções.';

// Melhoria 1 (sessão 2026-09-23, medição de 23/09: em 2 de 4 passos de toda sessão observada
// não consultavam nada — um deles era só o passo final dizendo `pronto`, ~450-580ms sem
// trazer informação nova). Pergunta nova, JUNTO de `acao` na mesma chamada (custa perto de
// zero — a V1 já provou que perguntar mais nessa mesma decisão não pesa): o próprio Jev diz
// se, DEPOIS da ação que acabou de escolher, o pedido ainda vai precisar de outra consulta.
// Quando a execução dá certo e a resposta é `nao` com confiança alta, `rodarLoop` encerra o
// loop ali mesmo, sem gastar a chamada extra só para confirmar `pronto` (ver corteFim/
// CORTE_FIM_PADRAO em rodar-loop.js). `carregar_*` nunca lê esta resposta — carregar uma
// capacidade nunca encerra o loop sozinho (rodar-loop.js sempre dá `continue` nesse ramo,
// antes de chegar no trecho que consultaria `mais`).
export const MAIS_SIM = 'sim';
export const MAIS_NAO = 'nao';

// Calibração 2 (sessão 2026-09-23/24, `E:\tmp\exp-mais.mjs`/`exp-mais-2.mjs`, Jev real via
// Vercel): o texto original acima ("depois desta ação, ainda vai precisar de outra consulta?")
// NUNCA disparava contra o Jev real — em toda chamada onde uma função tinha acabado de ser
// escolhida, ele respondia `sim`; o `não` confiante só aparecia na própria chamada que já dizia
// `pronto` (spec §4.4, medição de 23/09). Hipótese confirmada pelo experimento: aquele texto
// pede uma previsão sobre o RESULTADO antes dele existir — o Jev não sabe se a função vai achar
// o que precisa, então nunca se arrisca a dizer que já basta. A variante abaixo reformula como
// cobertura de ASSUNTO (o pedido pode ter mais de um — tarefas e agenda — e a pergunta é só se
// sobra algum sem nenhuma consulta prevista, não se a resposta final está pronta) e embute o
// rastro já consultado DIRETO no texto da pergunta (não só no `state`, que sozinho não pesava o
// bastante). Resultado: 10/10 `não` confiante nos 2 casos de passo único (agenda amanhã, contas
// a pagar) contra 0/14 de encerramento errado nos casos de pedido composto (2 rodadas, 3-5
// repetições cada) — desde que `corteFim` suba de 0,7 para 0,85 (ver CORTE_FIM_PADRAO em
// rodar-loop.js); com 0,7 o mesmo texto errava 44% dos casos compostos (a confiança de `não`
// nesses casos chegou a 0,82, nunca a 0,85). O caso "passo final de um pedido composto" (ex.:
// agenda já carregada, só falta ler o período) nunca passou de ~0,65 de confiança — o mecanismo
// segue conservador ali (sem economia, mas também sem risco de encerrar errado).
function resumoRastro(rastro) {
  if (!rastro?.length) return 'nada ainda';
  return rastro.map((r) => `${r.funcao}(${Object.entries(r.args || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'sem args'})`).join('; ');
}
function instrucoesMais(rastro) {
  return 'O pedido do usuário pode ter mais de um assunto (por exemplo, tarefas e agenda). '
    + `Já foi consultado: ${resumoRastro(rastro)}. `
    + 'Olhando isso e a ação que você acabou de escolher agora (mesmo sem saber o resultado dela ainda), '
    + 'sobra algum assunto do PEDIDO ATUAL que nenhuma consulta — já feita ou esta — vai tocar? '
    + '("conversa" no estado, se houver, não conta como assunto novo — é só pano de fundo do pedido atual.)';
}
const CRITERIOS_MAIS = {
  [MAIS_SIM]: 'Sim: ainda sobra um assunto do pedido sem nenhuma consulta prevista, mesmo depois desta ação.',
  [MAIS_NAO]: 'Não: esta ação, somada ao que já foi consultado, cobre todos os assuntos do pedido.',
};

// Teto do sufixo "Valores: ..." acrescentado ao critério das funções em `comArgs` (a menos
// que a função esteja fora das K, que fica só com a descrição). Medido no experimento: dar
// os VALORES reais das opções (não só o nome do parâmetro) foi o que resolveu "contas a
// pagar" ficando sempre `bloqueado` — o Jev não sabia que "Contas a pagar" era uma lista.
const TETO_VALORES_POR_PARAM = 12;
const TETO_CHARS_SUFIXO = 300;

// Rótulo de cada valor: `String(o.valor)` normalmente. Quando o valor é longo/opaco (ex.: um
// id de calendário) e há `descricao`, mostra a descrição em vez do valor — um id não ajuda o
// Jev a escolher, uma descrição ("Principal") ajuda. Corte arbitrário em 24 chars: acima
// disso o valor deixa de parecer um rótulo legível e passa a parecer um identificador.
function rotuloValor(o) {
  const v = String(o.valor);
  return o.descricao && v.length > 24 ? o.descricao : v;
}

function sufixoValores(funcaoComArgs) {
  const partes = [];
  for (const p of funcaoComArgs.params || []) {
    const opcoes = (p.opcoes || []).filter((o) => String(o.valor) !== SEM_ARGUMENTO && String(o.valor) !== FORA_DA_LISTA);
    if (!opcoes.length) continue;
    const rotulos = opcoes.slice(0, TETO_VALORES_POR_PARAM).map(rotuloValor);
    if (opcoes.length > TETO_VALORES_POR_PARAM) rotulos.push('…');
    partes.push(`${p.nome} = ${rotulos.join(', ')}`);
  }
  if (!partes.length) return '';
  let texto = `Valores: ${partes.join('; ')}`;
  if (texto.length > TETO_CHARS_SUFIXO) texto = `${texto.slice(0, TETO_CHARS_SUFIXO - 1)}…`;
  return texto;
}

export function chaveDeArg(fn, param) {
  return `arg_${fn}_${param}`;
}

// Spec 2026-10-14 §5.3: no turno seguinte a uma intenção declarada, o Jev julga se a mensagem atual
// aceita seguir aquela intenção — "ok", "sim, mas sem X" (mesmas funções, outro argumento) valem;
// "não, outra coisa" não vale.
const TETO_CHARS_VALOR_INTENCAO = 60;
const TETO_CHARS_LISTA_INTENCAO = 400;

// Só args escalares (string/número/boolean, cada valor cortado) e a lista inteira com teto: a
// intenção vem do modelo e o texto vai para o Jev em todo passo 1 — não pode crescer sem limite
// nem virar "[object Object]".
function listaDaIntencao(intencao) {
  const corta = (texto, max) => (texto.length > max ? `${texto.slice(0, max - 1)}…` : texto);
  const lista = intencao.map((i) => {
    const escalares = i.args && typeof i.args === 'object' && !Array.isArray(i.args)
      ? Object.entries(i.args).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      : [];
    const args = escalares.map(([k, v]) => `${k}=${corta(String(v), TETO_CHARS_VALOR_INTENCAO)}`).join(', ');
    return `${i.funcao}${args ? `(${args})` : ''}`;
  }).join('; ');
  return corta(lista, TETO_CHARS_LISTA_INTENCAO);
}

function instrucaoIntencao(intencao) {
  const lista = listaDaIntencao(intencao);
  return 'No turno anterior o assistente perguntou algo ao usuário e declarou que, se ele aceitasse, chamaria: '
    + `${lista}. O PEDIDO atual é a resposta do usuário. Ele aceita seguir esse plano — mesmo com um ajuste de valor (ex.: "sim, mas sem X") — ou muda o plano (recusa, pede outra coisa, outro lugar, outra ação)? `
    + '"conversa" mostra a pergunta. Responda alto quando o pedido aceita o plano, baixo quando o muda.';
}

/**
 * @param {{ funcoes: Array<{nome: string, descricao?: string}>, candidatas: Array<{id: string, descricao?: string}>,
 *           comArgs: Array<{nome: string, params: Array<{nome: string, obrigatoria: boolean, opcoes: Array<{valor: any, descricao?: string}>}>}>,
 *           rastro?: Array<{funcao: string, args?: object}>, temMemorias?: boolean }} p
 *   `rastro` (Calibração 2, ver comentário acima de `instrucoesMais`): o mesmo formato que
 *   `rodarLoop` monta em `state.rastro` — usado só para embutir o resumo no texto de `mais`,
 *   opcional (default `[]`, vira "nada ainda" no texto — cobre quem ainda chama sem esse campo).
 */
export function perguntasDoPasso({ funcoes, candidatas, comArgs, rastro = [], temMemorias = false, intencao = null }) {
  const criteria = {};
  const comArgsPorNome = new Map((comArgs || []).map((f) => [f.nome, f]));
  for (const f of funcoes) {
    const base = f.descricao || f.nome;
    const alvo = comArgsPorNome.get(f.nome);
    const sufixo = alvo ? sufixoValores(alvo) : '';
    criteria[f.nome] = f.autorizada ? `AUTORIZADA — ${base}` : (sufixo ? `${base} ${sufixo}` : base);
  }
  for (const c of candidatas) criteria[`${PREFIXO_CARREGAR}${c.id}`] = `Carregar a capacidade ${c.id}${c.descricao ? `: ${c.descricao}` : ''}`;
  criteria[ACAO_PRONTO] = DESC_ACAO_PRONTO;
  criteria[ACAO_BLOQUEADO] = DESC_ACAO_BLOQUEADO;
  // Melhoria 1: `mais` entra em toda chamada, junto de `acao` — 2 perguntas de base agora
  // (antes 1) antes das `arg_*` das K funções; o teto de `TETO_PERGUNTAS` abaixo já conta a
  // partir daqui, então uma função com muitos parâmetros perde 1 opção de argumento a menos
  // pelo mesmo teto — folga que sobra com K=3 (spec §3.2).
  const temAutorizadas = funcoes.some((f) => f.autorizada);
  const instrucaoAcao = [INSTRUCOES_ACAO, temMemorias && INSTRUCAO_MEMORIAS, temAutorizadas && INSTRUCAO_AUTORIZADAS].filter(Boolean).join(' ');
  const questions = { acao: choice(instrucaoAcao, criteria), mais: choice(instrucoesMais(rastro), CRITERIOS_MAIS) };
  let total = 2;
  if (Array.isArray(intencao) && intencao.length) {
    questions.intencao_vale = noul(instrucaoIntencao(intencao));
    total += 1;
  }
  for (const f of comArgs) {
    for (const p of f.params) {
      if (!(p.opcoes?.length)) continue;
      if (total >= TETO_PERGUNTAS) return questions;
      const c = {};
      for (const o of p.opcoes) c[String(o.valor)] = o.descricao || String(o.valor);
      if (!p.obrigatoria) c[SEM_ARGUMENTO] = DESC_SEM_ARGUMENTO;
      // Correção (lote 2, 30/09): em TODO parâmetro com opções, obrigatório ou não — ver
      // `FORA_DA_LISTA` em perguntas.js. O parâmetro obrigatório é o pior caso: sem esta saída o Jev era
      // FORÇADO a escolher uma opção errada quando o pedido nomeia um valor que a lista não tem.
      c[FORA_DA_LISTA] = DESC_FORA_DA_LISTA;
      // 2026-09-23: cobre o caso medido (bancada ampliada, categoria 7): "e a da OKDS?" depois de
      // "quais tarefas da OKDS essa semana?" perdia o argumento `periodo:"semana"` porque nada
      // pedia ao Jev para olhar a conversa NA hora de escolher o VALOR, só na hora da ação.
      // Calibração 2 (mesmo dia, medição real via Vercel): a primeira versão desta frase ("se não
      // foi dito agora... use o valor citado antes", sem ressalva) regrediu #25/#26 — "e da lista
      // de CONTAS?" depois de falar de "Projetos / Trabalho" herdava "Projetos / Trabalho" em vez
      // de reconhecer que o pedido atual JÁ nomeia outra lista ("contas"); "e a da OKDS?" depois
      // de "Família" herdava o calendário errado (`family...`) pelo mesmo motivo — o pedido atual
      // já cita "OKDS", só não cita o período. A ressalva abaixo distingue os dois casos: herdar
      // só quando o PEDIDO ATUAL não aponta nenhum valor para este parâmetro (omissão pura, tipo
      // período em "e depois de amanhã?"), nunca quando ele já nomeia algo diferente do que a
      // conversa tinha (nesse caso o valor novo, do pedido, vence).
      // Melhoria A: mesma ressalva de "conversa" acima (herdar só na OMISSÃO pura, nunca por
      // cima de um valor que o pedido atual já nomeia) agora vale também para
      // "consultasAnteriores" — ela é MAIS específica que a conversa em texto livre (traz o
      // argumento literal que uma consulta anterior usou para esta MESMA função), então é a
      // primeira fonte a checar para herdar; a conversa em texto continua como apoio para casos
      // sem consulta estruturada equivalente.
      questions[chaveDeArg(f.nome, p.nome)] = choice(`Se a ação escolhida for \`${f.nome}\`, qual valor usar em \`${p.nome}\`? Só herde um valor de "consultasAnteriores" (a chamada mais recente da MESMA função) ou da conversa quando o PEDIDO ATUAL não apontar nenhum valor para este parâmetro (omissão pura); se o pedido atual já nomeia algo diferente do que já foi consultado ou dito antes, o valor do pedido atual vence.${temMemorias ? SUFIXO_MEMORIAS_ARG : ''}`, c);
      total += 1;
    }
  }
  return questions;
}

/**
 * Lê a resposta de um passo. `confianca` = menor valor entre a confiança de `acao` e a dos
 * argumentos usados (spec §3.3) — é o que decide, na entrega, histórico ou bloco.
 * `confiancaAcao` = só a confiança da pergunta `acao`, sem misturar com a dos argumentos — é o
 * que decide se o passo "vale como pronto" (correção I1: um argumento incerto não deve encerrar
 * o loop se a ação em si tinha confiança alta).
 * `foraDasK`: a função escolhida não recebeu perguntas de argumento neste passo.
 * `faltaObrigatoria`: recebeu, mas um parâmetro obrigatório ficou sem resposta válida — ou a função tem
 * grupos obrigatórios (`umDe`) e nenhum ficou completo com os argumentos escolhidos.
 * `foraDaLista` (lote 2): nomes dos parâmetros em que o Jev escolheu `FORA_DA_LISTA` (o pedido cita um
 * valor que não está entre as opções) — sempre array (vazio quando nenhum).
 * `mais`/`confiancaMais` (Melhoria 1): a resposta de `mais` (`MAIS_SIM`/`MAIS_NAO`/`null` se
 * ausente) e a confiança dela — sempre lidas da mesma chamada, independente de `acao`; quem usa
 * para decidir parada é `rodarLoop` (só quando `acao` executou uma função com sucesso).
 * `argsAbaixoDoPiso` (Task 4): nomes dos parâmetros cuja escolha ficou abaixo de `pisoExecucao` (e não era
 * herança) — opcionais foram omitidos, obrigatórios viram `faltaObrigatoria`.
 * `herdados` (opcional): `{ [função]: args }` da consulta anterior mais recente de cada função.
 * Um argumento escolhido com o MESMO valor que a consulta anterior da mesma função usou é
 * herança, não palpite — não entra no mínimo de `confianca` (a ação continua entrando) — mas só
 * quando a confiança do Jev naquele argumento bate `PISO_CONFIANCA_HERANCA` (ver abaixo).
 */
// Correção (sessão 7fe31cb7, 24/09): herança só conta com confiança mínima no argumento — abaixo
// do piso, o Jev não estava reafirmando o valor da conversa, só "sem certeza" mesmo. Os dois casos
// medidos que fixam o valor: sessão 757739e5 (commit 2c52f84c) — "e as concluídas?" herdou
// `lista` da consulta anterior com confiança 0,4, uma herança LEGÍTIMA que precisa continuar fora
// do mínimo — e sessão 7fe31cb7 (24/09) — "Tô livre quinta de manhã?" herdou `periodo:"amanha"` da
// pergunta anterior ("agenda de amanhã") com confiança 0,24: o pedido nomeava OUTRO dia (quinta),
// o Jev não tinha certeza do valor herdado, e a herança escondeu isso do mínimo — o item saiu como
// dado confiável (confiança 0,99, só da ação) e o modelo respondeu sobre o dia errado. 0,3 fica
// entre os dois: cobre a herança legítima (0,4) e derruba a incerta (0,24).
export const PISO_CONFIANCA_HERANCA = 0.3;

// Confiança fora de [0,1] ou não finita é INVÁLIDA e vale 0 (falha fechada: nunca atravessa um piso).
const confValida = (c) => (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1 ? c : 0);

// Correção (lote 2, 30/09): "grupos obrigatórios" do schema. Um manifesto que declara
// `anyOf`/`oneOf: [{required:[a]},{required:[b]}]` no nível dos parâmetros exige que PELO MENOS UM
// grupo esteja completo — mas a exigência não é `required`, então o loop a ignorava: `note_buscar`
// (`query` ou `pasta`, ambas opcionais no schema) rodou `{}` e voltou `params_required`; `note_ler`
// (`id` ou `path`, sem opções) rodaria vazia. `paramsDaTool` (@igris/executor, fabrica/loop.js) copia
// o dado para cada param envolvido em `umDe: [[nome, ...], ...]` (o MESMO array em todos).
/** @returns {string[][]|null} os grupos (cada um = nomes que precisam estar todos preenchidos), ou `null` se a função não tem. */
export function gruposDe(params) {
  for (const p of params || []) if (Array.isArray(p?.umDe) && p.umDe.length) return p.umDe;
  return null;
}

/**
 * A função é "só o modelo preenche"? (spec §3.2: o Jev nunca inventa valor.) Dois casos: parâmetro
 * obrigatório sem opção nenhuma; ou grupos obrigatórios em que TODO grupo tem ao menos um membro sem
 * opção (nenhum grupo dá para o Jev completar escolhendo). `note_ler` (id|path, ambos livres) cai aqui;
 * `note_buscar` (query livre | pasta com opções) não — o grupo `pasta` o Jev preenche.
 */
export function exigeOModelo(params) {
  const lista = params || [];
  if (lista.some((p) => p.obrigatoria && !p.opcoes?.length)) return true;
  const grupos = gruposDe(lista);
  if (!grupos) return false;
  const temOpcao = (nome) => Boolean(lista.find((p) => p.nome === nome)?.opcoes?.length);
  return grupos.every((g) => !g.every(temOpcao));
}

// Piso de confiança para EXECUTAR (Task 4, spec fábrica-capacidades-mcp §11; bancada do lote 4):
// `pisoExecucao` (opcional, 0 = sem piso — o `rodarLoop` passa o dele) vale para o ARGUMENTO escolhido:
// abaixo do piso o Jev estava chutando (`si_listar {tipo:"observation"}` com `tipo` a 0,17, valor que o
// pedido nunca citou). Opcional → omitido como `sem_argumento` (`argsOmitidos`, e anotado em
// `argsAbaixoDoPiso`), a função roda sem ele; obrigatório → `faltaObrigatoria` (a função vai ao modelo).
// Herança legítima (mesmo valor da consulta anterior, confiança >= `PISO_CONFIANCA_HERANCA`) NÃO passa
// pelo piso: é reafirmação, não palpite — o piso só vale para o que não é herdado.
export function lerPasso(answers, { comArgs, herdados = {}, pisoExecucao = 0 }) {
  const a = answers?.acao;
  const acao = typeof a?.choice === 'string' ? a.choice : null;
  const confAcao = confValida(a?.confidence);
  const probabilidades = a?.probabilities && typeof a.probabilities === 'object' ? a.probabilities : {};
  const m = answers?.mais;
  const mais = typeof m?.choice === 'string' ? m.choice : null;
  const confiancaMais = confValida(m?.confidence);
  const iv = answers?.intencao_vale;
  const intencaoVale = typeof iv?.noul === 'number' && Number.isFinite(iv.noul) ? iv.noul : null;
  const alvo = comArgs.find((f) => f.nome === acao);
  if (!alvo) {
    return {
      acao, confianca: confAcao, confiancaAcao: confAcao, args: null, argsOmitidos: [], probabilidades,
      foraDasK: true, faltaObrigatoria: false, foraDaLista: [], argsAbaixoDoPiso: [], mais, confiancaMais, intencaoVale,
    };
  }
  const args = {};
  const argsOmitidos = [];
  const foraDaLista = [];
  const argsAbaixoDoPiso = [];
  let confianca = confAcao;
  let faltaObrigatoria = false;
  for (const p of alvo.params) {
    const opcoesP = p.opcoes ?? [];
    const r = answers?.[chaveDeArg(alvo.nome, p.nome)];
    const escolha = r?.choice;
    // `FORA_DA_LISTA`: o Jev disse que o pedido nomeia um valor que a lista não tem — não é omissão
    // (`SEM_ARGUMENTO`) nem falta de resposta; quem decide o que fazer é `rodarLoop` (devolve ao modelo).
    if (escolha === FORA_DA_LISTA) { foraDaLista.push(p.nome); continue; }
    const opcao = typeof escolha === 'string' && escolha !== SEM_ARGUMENTO ? opcoesP.find((o) => String(o.valor) === escolha) : undefined;
    if (!opcao) {
      if (p.obrigatoria) faltaObrigatoria = true;
      else argsOmitidos.push(p.nome);
      continue;
    }
    const temConf = typeof r?.confidence === 'number';
    const confArg = confValida(r?.confidence);
    const anterior = herdados?.[alvo.nome];
    const confSuficiente = temConf && confArg >= PISO_CONFIANCA_HERANCA;
    const herdado = anterior && Object.prototype.hasOwnProperty.call(anterior, p.nome)
      && String(anterior[p.nome]) === String(opcao.valor) && confSuficiente;
    if (!herdado && temConf && confArg < pisoExecucao) {
      argsAbaixoDoPiso.push(p.nome);
      if (p.obrigatoria) faltaObrigatoria = true;
      else argsOmitidos.push(p.nome);
      continue;
    }
    args[p.nome] = opcao.valor;
    if (!herdado && temConf) confianca = Math.min(confianca, confArg);
  }
  // Grupos obrigatórios do schema (`umDe`): nenhum grupo completo com o que o Jev escolheu = falta
  // obrigatória (mesmo tratamento: `rodarLoop` devolve a função em `paraOModelo`). Um grupo satisfeito
  // executa normalmente — ex.: `note_buscar {pasta: "Sebrae"}`. Com `foraDaLista` já vale o retorno ao
  // modelo, então nem confere (o valor que o pedido nomeia pode ser justamente o do grupo).
  const grupos = gruposDe(alvo.params);
  if (grupos && !foraDaLista.length && !grupos.some((g) => g.every((nome) => Object.prototype.hasOwnProperty.call(args, nome)))) {
    faltaObrigatoria = true;
  }
  return {
    acao, confianca, confiancaAcao: confAcao, args: faltaObrigatoria || foraDaLista.length ? null : args, argsOmitidos, probabilidades,
    foraDasK: false, faltaObrigatoria, foraDaLista, argsAbaixoDoPiso, mais, confiancaMais, intencaoVale,
  };
}

// Pista de contexto é uma decisão puramente sintática e deliberadamente conservadora.
// Ela nunca tenta resolver referências fora dos padrões aprovados nem altera o texto
// que será entregue ao ranking.
export const MAX_CHARS_PAPEL = 300;
export const MAX_CHARS_PISTA = 600;
// Resposta curta a uma pergunta do assistente (spec 2026-10-14 §4.3): o assunto é a PERGUNTA, então
// o texto do assistente vem primeiro, cortado pelo FIM (onde estão a proposta e a pergunta).
export const MAX_CHARS_ASSISTENTE_RESPOSTA_CURTA = 450;
export const MAX_CHARS_USUARIO_RESPOSTA_CURTA = 150;
// Com intenção declarada (§5.3): intenção, assistente e usuário dividem o mesmo teto de 600.
const LIMITES_COM_INTENCAO = { intencao: 200, assistente: 300, usuario: 100 };

const PAPEIS_VALIDOS = new Set(['usuario', 'assistente']);
// Reconhecimentos só na forma normalizada: `normalizar` remove o diacrítico antes da comparação,
// então "não" chega como "nao" e a forma acentuada nunca seria alcançada (entrada morta).
const RECONHECIMENTOS = new Set(['ok', 'sim', 'nao', 'obrigado', 'obrigada', 'valeu', 'perfeito']);
// Tipos em forma normalizada (sem acento): os padrões abaixo só correm sobre `normalizar`.
// `agenda` entra porque é um dos domínios nomeados pela spec (§8) e, sem ele, o gate de
// ambiguidade fica cego justamente em "mostre a agenda A e a agenda B".
const TIPOS = ['agente', 'nota', 'tarefa', 'lista', 'conta', 'item', 'arquivo', 'evento', 'reuniao', 'agenda'];
const TIPOS_DE_REFERENCIA = `(?:${TIPOS.join('|')})`;
// Plural derivado do tipo normalizado: "nota" -> "notas" e "reuniao" -> "reunioes" (o "ão" vira
// "ões"; no texto normalizado o "ã" já é "a", então o sufixo troca "ao" por "oes").
// O sufixo sozinho erra os plurais irregulares em português: "item" viraria "items", que não é
// palavra, e o plural correto ficaria fora do gate. A tabela abaixo é a fonte da verdade para
// esses casos e é coberta pela lista derivada exercitada na suíte.
const PLURAIS_IRREGULARES = new Map([['item', 'itens']]);
const PLURAIS_DE_REFERENCIA = TIPOS
  .map((tipo) => PLURAIS_IRREGULARES.get(tipo)
    ?? (tipo.endsWith('ao') ? `${tipo.slice(0, -2)}oes` : `${tipo}s`))
  .join('|');
// Vocabulário fechado de período/data, já sem acento (`normalizar` remove os diacríticos):
// separa "duas referências alternativas do mesmo atributo" (nota de março e abril) de
// "uma referência com qualificador descritivo composto" (nota de viagem e reserva).
const PERIODOS = '(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|domingo|segunda|terca|quarta|quinta|sexta|sabado|(?:19|20)\\d{2})';
const DEMONSTRATIVOS = '(?:ela|ele|isso|isto|esse|essa|aquele|aquela)';
// Frase-demo: a sentença inteira é o demonstrativo, com `e` e pontuação opcionais ("e ela?",
// "essa?", "isso."). Cobre a retomada curta que nenhuma família de continuidade nomeia.
const FRASE_DEMO = new RegExp(`^(?:e\\s+)?${DEMONSTRATIVOS}\\s*[?!.]?$`);
const VERBOS_DE_PEDIDO = '(?:abre|abra|mostra|mostre|confere|confira|veja|olha|lista|liste|pesquise|procure|crie|envie|marque|agende)';
const INTERROGATIVAS_DE_PEDIDO = '(?:qual|quais|quem|onde|quando|como|por que)';
const CHAVES_DE_OPERACAO = '(?:operation|operacao|tool_call|tool_result)';

function resposta(aplicar, motivo, regra = null, pista = null, mensagensUsadas = 0) {
  return {
    aplicar,
    motivo,
    regra,
    pista,
    mensagensUsadas,
    chars: pista ? pista.length : 0,
  };
}

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cortarUnicode(texto, limite) {
  let resultado = '';
  for (const caractere of texto) {
    if (resultado.length + caractere.length > limite) break;
    resultado += caractere;
  }
  return resultado;
}

function cortarPeloFim(texto, limite) {
  const caracteres = [...texto];
  let resultado = '';
  for (let i = caracteres.length - 1; i >= 0; i -= 1) {
    if (resultado.length + caracteres[i].length > limite) break;
    resultado = caracteres[i] + resultado;
  }
  return resultado;
}

// A última fala do assistente e o pedido do usuário imediatamente antes dela.
function antecedenteDaPergunta(conversa) {
  for (let i = conversa.length - 1; i >= 0; i -= 1) {
    if (conversa[i].papel !== 'assistente') continue;
    let usuario = null;
    for (let j = i - 1; j >= 0; j -= 1) if (conversa[j].papel === 'usuario') { usuario = conversa[j]; break; }
    return { assistente: conversa[i], usuario };
  }
  return null;
}

// Remove as linhas que são só a cerca de código (crases triplas ou til triplo, com info string),
// mantendo o conteúdo do bloco. Exclusivo da resposta curta: a B3.3 continua recusando cercas.
function semLinhasDeCerca(texto) {
  return String(texto).replace(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*$\n?/gm, '');
}

function pistaDeRespostaCurta(conversa, continuidade) {
  const ant = antecedenteDaPergunta(conversa);
  if (!ant) return resposta(false, 'sem-antecedente');
  // A proposta do assistente costuma vir num bloco de código (árvore de nós). Só as linhas de cerca
  // saem; o conteúdo do bloco fica e passa pelo mesmo gate (envelope, base64, data URI, tags).
  const textoAssistente = semLinhasDeCerca(ant.assistente.texto);
  const textoUsuario = ant.usuario ? semLinhasDeCerca(ant.usuario.texto) : '';
  if (textoInseguro(textoAssistente) || (ant.usuario && textoInseguro(textoUsuario))) {
    return resposta(false, 'historico-inseguro');
  }
  // Sem o gate de ambiguidade da B3.3: a proposta do assistente costuma ser uma lista, e aqui a
  // pista só ajuda a RELEVÂNCIA (nunca vira argumento).
  const intencao = typeof continuidade.pistaDaIntencao === 'string' ? continuidade.pistaDaIntencao.trim() : '';
  const lim = intencao
    ? LIMITES_COM_INTENCAO
    : { intencao: 0, assistente: MAX_CHARS_ASSISTENTE_RESPOSTA_CURTA, usuario: MAX_CHARS_USUARIO_RESPOSTA_CURTA };
  const partes = [
    intencao ? cortarUnicode(intencao, lim.intencao) : '',
    cortarPeloFim(textoAssistente, lim.assistente),
    ant.usuario ? cortarUnicode(textoUsuario, lim.usuario) : '',
  ].filter(Boolean);
  const pista = cortarUnicode(partes.join('\n'), MAX_CHARS_PISTA);
  const motivo = continuidade.motivo === 'intencao' ? 'intencao' : 'resposta-curta';
  return resposta(true, motivo, 'resposta-curta', pista, ant.usuario ? 2 : 1);
}

function ehTrivial(normalizado) {
  return RECONHECIMENTOS.has(normalizado.replace(/[.!?]+$/, ''));
}

/**
 * Famílias de continuidade. Todas consomem a sentença inteira: a âncora `$` é a barreira
 * que recusa pedido composto e nova cláusula ("mostra ela e abre o navegador", "e da lista
 * de contas? abra o navegador"). A pontuação final é o conjunto uniforme `[?!.]?`, opcional,
 * porque o canal de fala não pontua (`_fala.text`); opcional não enfraquece a âncora.
 */
function regraDeContinuidade(normalizado) {
  const acao = new RegExp(
    `^(?:(?:mostra|mostre|abre|abra|confere|confira|veja|olha)\\s+${DEMONSTRATIVOS}(?:\\s+${TIPOS_DE_REFERENCIA})?`
    + `|(?:confere|confira)\\s+se\\s+${DEMONSTRATIVOS}\\s+(?:ainda\\s+)?esta\\s+pendente)\\s*[?!.]?$`,
  );
  if (acao.test(normalizado)) return 'acao-referencia';
  if (new RegExp(`^e\\s+(?:esse|essa|aquele|aquela)\\s+${TIPOS_DE_REFERENCIA}\\s*[?!.]?$`).test(normalizado)) {
    return 'pergunta-e-demonstrativo';
  }
  if (/^e\s+da\s+lista\s+de\s+[\p{L}\p{N}_-]+[?!.]?$/u.test(normalizado)) return 'continuidade-lista';
  if (/^e\s+depois\s+de\s+amanha\s*[?!.]?$/.test(normalizado)) return 'continuidade-depois-de-amanha';
  return null;
}

/**
 * Classifica a mensagem de usuário em quatro estados, para a busca do antecedente:
 * - `reconhecimento`: "ok"/"perfeito" e afins; não é assunto e pode ser pulado;
 * - `retomada`: a mensagem tem a forma da família de continuidade — a mesma forma que decide a
 *   elegibilidade da mensagem atual —, ou é uma frase-demo. Não cria antecedente próprio e pode
 *   ser pulada. Reconhecer retomada por varredura de demonstrativo seria largo demais: um pedido
 *   novo que nomeia o próprio sujeito ("Mostre esse arquivo novo.", "Veja essa parte do texto.")
 *   seria pulado e a busca voltaria ao assunto antigo, atravessando a barreira de tema.
 * - `pedido-autonomo`: verbo ou interrogativa conhecidos e sem referência; selecionável;
 * - `nao-classificado`: qualquer outra coisa. Não é atravessado — encerra a busca, porque
 *   atravessar texto não reconhecido é o que ressuscita assunto antigo.
 */
function classificarMensagemUsuario(normalizado) {
  if (!normalizado || ehTrivial(normalizado)) return 'reconhecimento';
  if (regraDeContinuidade(normalizado) || FRASE_DEMO.test(normalizado)) return 'retomada';
  if (new RegExp(`^${VERBOS_DE_PEDIDO}\\b`).test(normalizado)) return 'pedido-autonomo';
  if (new RegExp(`^(?:e\\s+)?${INTERROGATIVAS_DE_PEDIDO}\\b`).test(normalizado)) return 'pedido-autonomo';
  return 'nao-classificado';
}

// Gate de ambiguidade: duas referências plausíveis no par escolhido são recusadas inteiras,
// sem extrair nem preferir a primeira. Super-disparar é o lado seguro: perder pista nunca é
// pior que pista errada.
function temReferenciaCoordenada(texto) {
  const normalizado = normalizar(texto);
  const termo = '[\\p{L}\\p{N}_-]+';
  // tipo ... tipo coordenados na mesma janela ("nota A e nota B").
  const tipoRepetido = new RegExp(`\\b${TIPOS_DE_REFERENCIA}s?\\b[^.\\n]{0,80}\\be\\b[^.\\n]{0,80}\\b${TIPOS_DE_REFERENCIA}s?\\b`);
  // plural do tipo com rótulos coordenados ("notas A e B"); plurais derivados de TIPOS.
  const listaDoMesmoTipo = new RegExp(`\\b(?:${PLURAIS_DE_REFERENCIA})\\s+[a-z0-9]+\\s+e\\s+[a-z0-9]+\\b`);
  // rótulo curto colado ao tipo, com separador e segundo rótulo. Lookaheads, um por linha:
  // 1. depois do tipo não pode vir preposição (senão é qualificador: "nota de março");
  // 2. separador e/ou, barra ou vírgula, com artigo e tipo opcionais no segundo rótulo;
  // 3. o segundo rótulo também não pode ser qualificador, para não puxar "nota de X e Y".
  const referenciaAbreviada = new RegExp(
    `\\b${TIPOS_DE_REFERENCIA}\\s+(?!(?:de|da|do|para)\\b)${termo}\\s*(?:\\b(?:e|ou)\\b|/|,)\\s*(?:(?:a|o)\\s+)?(?:${TIPOS_DE_REFERENCIA}\\s+)?(?!(?:de|da|do|para)\\b)${termo}\\b`,
    'u',
  );
  // Qualificadores enumerados com vírgula ("nota de março, abril e maio").
  const listaDeQualificadores = new RegExp(
    `\\b${TIPOS_DE_REFERENCIA}s?\\s+(?:${termo}\\s+)?de\\s+${termo}\\s*,\\s*${termo}(?:\\s*(?:,|\\be\\b)\\s*${termo})*`,
    'u',
  );
  // Alternativas explícitas do mesmo qualificador ("nota de março ou abril", "março/abril").
  const alternativaDeQualificador = new RegExp(
    `\\b${TIPOS_DE_REFERENCIA}s?\\s+(?:${termo}\\s+)?de\\s+${termo}\\s*(?:\\bou\\b|/)\\s*${termo}\\b`,
    'u',
  );
  // Elipse do tipo com a preposição repetida ("nota de março e a de abril").
  const elipseDeTipo = new RegExp(
    `\\b${TIPOS_DE_REFERENCIA}\\s+de\\s+${termo}\\s+e\\s+(?:a|o)\\s+de\\s+${termo}\\b`,
    'u',
  );
  // Dois períodos coordenados no mesmo qualificador: duas referências igualmente plausíveis.
  // Restrito ao par de períodos para não atingir qualificador descritivo composto.
  const coordenacaoDePeriodo = new RegExp(
    `\\b${TIPOS_DE_REFERENCIA}s?\\s+(?:${termo}\\s+)?de\\s+${PERIODOS}\\s+e\\s+${PERIODOS}\\b`,
    'u',
  );
  return tipoRepetido.test(normalizado)
    || listaDoMesmoTipo.test(normalizado)
    || referenciaAbreviada.test(normalizado)
    || listaDeQualificadores.test(normalizado)
    || alternativaDeQualificador.test(normalizado)
    || elipseDeTipo.test(normalizado)
    || coordenacaoDePeriodo.test(normalizado);
}

// A introdução nomeia o tipo no PLURAL quando contém um dos plurais derivados de `TIPOS`. É o que
// separa "Notas encontradas:" (lista de referências) de "A nota fiscal de março:" e "Lista de
// compras:" (uma entidade só, com linhas de atributo ou itens abaixo).
function introducaoNomeiaPlural(texto) {
  return new RegExp(`\\b(?:${PLURAIS_DE_REFERENCIA})\\b`, 'u').test(normalizar(texto));
}

/**
 * Enumeração em linhas separadas ("- Nota 1: março" / "1. Nota A: março." / "Nota fiscal: 10,50"):
 * duas referências igualmente plausíveis que `normalizar` não consegue enxergar, porque achatar
 * `\n` em espaço transforma a lista em uma frase só ("nota 1: março - nota 2: abril"). Por isso a
 * estrutura é lida no texto cru, antes de qualquer normalização, e o gate devolve `ambiguo` para o
 * par inteiro — sem extrair nem escolher uma das notas.
 * Quatro formas contam como enumeração:
 * 1. item de lista ou item numerado, em qualquer indentação e com marcador `-`, `*`, `+`, `•` ou
 *    `1.`/`1)`, com ou sem espaço depois do marcador. O tipo pode vir no plural irregular
 *    ("Reuniões de março"), porque o casamento usa os conjuntos já derivados `TIPOS` e
 *    `PLURAIS_DE_REFERENCIA`;
 * 2. elipse: a introdução anterior ao primeiro marcador nomeia o tipo no plural ("Encontrei duas
 *    notas:\n- a de março\n- a de abril"), então os itens não precisam repetir o tipo;
 * 3. linha sem marcador que COMEÇA pelo tipo e traz rótulo ("Nota fiscal: 10,50", "Nota 1: março");
 * 4. linhas sem marcador e sem rótulo, contadas depois da introdução plural
 *    ("Notas encontradas:\nNota de março\nNota de abril"). A introdução é ancorada por CONTEÚDO, e
 *    não por posição: é a primeira linha não vazia que nomeia o plural, e as duas linhas contadas
 *    são as que vêm depois dela. Sem isso, uma linha de cortesia antes do cabeçalho
 *    ("Aqui está o resultado:\nNotas encontradas:\n…") desligaria a regra e devolveria pista sobre
 *    um par com duas referências — o caminho perigoso, e uma inconsistência com as formas 1 e 3,
 *    que já toleram preâmbulo.
 * CONTROLE: uma nota única descrita em duas linhas não tem marcador de item e continua aplicando;
 * um único item de lista também não é enumeração.
 *
 * A introdução só declara uma lista de REFERÊNCIAS quando nomeia o tipo no PLURAL ("Notas
 * encontradas:", "Itens:"). Nome no singular é uma entidade ("A nota fiscal de março:", "Lista de
 * compras:"), e as linhas que seguem são atributos ou itens dela — contá-las seria recusar uma
 * referência única. Essa discriminação é o que fecha, por construção, a família "cabeçalho que nomeia
 * o tipo + duas linhas de atributo" que fez a contagem ampla de linhas subir o falso positivo de
 * 18,5% para 44,4% (E:/tmp/r6, ver task-1-report.md).
 */
function temEnumeracaoMultilinha(texto) {
  if (typeof texto !== 'string' || !texto.includes('\n')) return false;
  const linhas = texto.split(/\r?\n/);
  const tipo = new RegExp(`\\b(?:${TIPOS_DE_REFERENCIA}|${PLURAIS_DE_REFERENCIA})s?\\b`, 'u');
  // O espaço depois do marcador é opcional ("-Nota A" é item de lista colado, "•Nota A" também),
  // mas nenhum dígito pode seguir o ponto, para não ler "10.5 kg" como item numerado.
  const marcador = /^[ \t]*(?:[-*+•][ \t]*|\d{1,3}[.)](?!\d)[ \t]*)/;
  const inicio = linhas.findIndex((linha) => marcador.test(linha));
  if (inicio >= 0) {
    const marcadores = linhas.slice(inicio).filter((linha) => marcador.test(linha));
    if (marcadores.length >= 2) {
      // A introdução declara o tipo no PLURAL: vale mesmo quando os itens são elípticos.
      return marcadores.some((linha) => tipo.test(normalizar(linha)))
        || introducaoNomeiaPlural(linhas.slice(0, inicio).join(' '));
    }
  }
  // Enumeração sem marcador nem rótulo: a introdução nomeia o tipo no plural e as duas linhas
  // seguintes são as referências ("Notas encontradas:\nNota de março\nNota de abril"). A introdução
  // é a PRIMEIRA linha não vazia que nomeia o plural, e não a primeira linha não vazia: assim um
  // preâmbulo neutro não desliga a regra e a lista de um item só (uma linha depois da introdução)
  // continua aplicando.
  const cheias = linhas.filter((linha) => linha.trim());
  const introducao = cheias.findIndex((linha) => introducaoNomeiaPlural(linha));
  if (introducao >= 0 && cheias.length - introducao - 1 >= 2) return true;
  // Enumeração sem marcador: a linha começa pelo tipo e traz rótulo. Casa sobre `normalizar`,
  // porque o texto cru é escrito com maiúsculas e acentuado ("Nota fiscal: 10,50").
  const comRotulo = new RegExp(`^\\s*${TIPOS_DE_REFERENCIA}s?\\b[^\\n]{0,60}:|^\\s*${TIPOS_DE_REFERENCIA}\\s+\\S+:`, 'u');
  return linhas.map(normalizar).filter((linha) => comRotulo.test(linha)).length >= 2;
}

function pareceEnvelope(texto) {
  const inicio = texto.trimStart();
  if (/^[{[]/.test(inicio)) {
    // Envelope "puro" no primeiro caractere: chave de operação logo após a abertura ou JSON real.
    if (new RegExp(`^[{\\[]\\s*"?${CHAVES_DE_OPERACAO}"?\\s*[:=]`).test(inicio)) return true;
    const bloco = inicio.match(/^[{[][\s\S]*[}\]]/)?.[0];
    if (bloco) {
      try {
        JSON.parse(bloco);
        return true;
      } catch {
        // Texto comum que começa com [ ou { (Markdown, por exemplo) não é envelope.
      }
    }
  }
  // Envelope no meio do texto: `{`/`[` seguido de aspa em janela curta ("Resposta: {"ok": true}").
  // Exige um caractere antes da chave, então o envelope puro ancorado no início continua sendo
  // julgado só pelo bloco acima — a forma de chave sem aspa ("resumo {1, 2}") não é JSON.
  if (/[^\s]\s*[{[]\s*"[^"\n]{0,60}"/.test(texto)) return true;
  // Chave de operação em qualquer posição, com aspas opcionais ("operation": ...).
  return new RegExp(`"?${CHAVES_DE_OPERACAO}"?\\s*[:=]`).test(normalizar(texto));
}

// Base64 de texto legível decodifica para bytes ASCII imprimíveis; base64 de dado binário, não.
function decodificaParaTextoImprimivel(token) {
  const bytes = Buffer.from(token, 'base64');
  return bytes.length > 0
    && bytes.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126));
}

function pareceBase64Canonico(token) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) return false;
  if (token.length < 16 || token.length % 4 !== 0) return false;
  if (/^(.)\1+$/.test(token)) return false;
  if (Buffer.from(token, 'base64').toString('base64') !== token) return false;
  // Evidência de payload, não de identificador. O round-trip acima é vazio para token sem
  // padding, então a discriminação é: padding, dígito (hash), ausência total de minúsculas
  // (payload só maiúsculas) ou decodificação para texto imprimível (base64 de frase, em que os
  // bytes são ASCII legível). Identificador camuflado ("IdentificadorDoRelatorioMensalDe") decodifica
  // para bytes binários e continua aplicando.
  return /=/.test(token)
    || /\d/.test(token)
    || !/[a-z]/.test(token)
    || decodificaParaTextoImprimivel(token);
}

// Trechos de URL: o alfabeto base64 inclui `/` e o de URL usa `-`, então varrer o texto cru produz
// um token longo que é só o caminho da URL — nunca payload. A exclusão é POSICIONAL, pelo trecho
// `://`, e é a única: a classe do token já contém `/` e `matchAll` casa da esquerda para a direita,
// então um token nunca começa logo depois de `/` nem termina logo antes dele — as barras adjacentes
// eram inalcançáveis (mutante R5-5b sobrevivia à suíte).
function trechosDeUrl(texto) {
  return [...texto.matchAll(/\S*:\/\/\S+/g)].map((achado) => [achado.index, achado.index + achado[0].length]);
}

function textoInseguro(texto) {
  const normalizado = normalizar(texto);
  return pareceEnvelope(texto)
    || /```/.test(texto)
    // Cerca de código é reconhecida pela forma (til no início da linha, até três espaços de
    // indentação, três ou mais til, info string opcional), não pela presença do caractere:
    // "Use ~~~ como marcador de bloco." é frase comum e continua aplicando.
    || /^[ \t]{0,3}~{3,}[^\n]*$/m.test(texto)
    || /<\/?(?:contexto|context|operation|operacao|tool|system)\b/.test(normalizado)
    // data URI exige tipo MIME (data: texto/...); data comum ("Data:15/03/2026") passa.
    || /\bdata:(?=[a-z]+[a-z0-9.+-]*\/)[a-z0-9.+-]+\/[a-z0-9.+-]+/i.test(texto)
    // data URI com o tipo de mídia omitido ou só com parâmetros ("data:,conteudo",
    // "data:;charset=utf-8,conteudo"): o que separa o URI de um rótulo comum é a vírgula do
    // separador colada ao tipo, e o tipo, quando presente, tem forma MIME (`letra/subtipo`), de
    // modo que "Data: 15/03/2026, valor da nota" e "Data:15/03, valor" continuam aplicando.
    || /\bdata:(?:[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+)?(?:;[^\s,]*)?,/i.test(texto)
    || /\bbase64,[a-z0-9+/=]{8,}/i.test(texto)
    || temPayloadBase64(texto);
}

function temPayloadBase64(texto) {
  const trechos = trechosDeUrl(texto);
  for (const achado of texto.matchAll(/[A-Za-z0-9+/]{12,}={0,2}/g)) {
    const token = achado[0];
    if (token.length < 16) continue;
    const emTrechoDeUrl = trechos.some(([de, ate]) => achado.index >= de && achado.index < ate);
    if (emTrechoDeUrl) continue;
    if (pareceBase64Canonico(token)) return true;
  }
  return false;
}

function validarEntrada(texto, conversa) {
  if (typeof texto !== 'string' || !texto.trim() || !Array.isArray(conversa)) return false;
  return conversa.every((mensagem) => mensagem
    && PAPEIS_VALIDOS.has(mensagem.papel)
    && typeof mensagem.texto === 'string'
    && mensagem.texto.trim());
}

function encontrarAntecedente(conversa) {
  for (let indice = conversa.length - 1; indice >= 0; indice -= 1) {
    const mensagem = conversa[indice];
    if (mensagem.papel !== 'usuario') continue;
    const classe = classificarMensagemUsuario(normalizar(mensagem.texto));
    // Reconhecimento e retomada não são assunto: pode-se seguir para trás.
    if (classe === 'reconhecimento' || classe === 'retomada') continue;
    // Mensagem não classificada encerra a busca: atravessá-la ressuscitaria assunto antigo.
    if (classe !== 'pedido-autonomo') return null;
    const seguinte = conversa[indice + 1];
    if (!seguinte || seguinte.papel !== 'assistente') return null;
    return { usuario: mensagem, assistente: seguinte };
  }
  return null;
}

/**
 * Decide se o pedido atual deve fornecer uma pista curta da conversa anterior.
 * `conversa` já deve vir sanitizada por `conversaDoHistorico`.
 * CONTRATO DA PISTA: `pista` são DOIS papéis (o texto do usuário e o do assistente) unidos por um
 * `\n`; o texto de cada papel preserva as próprias quebras de linha, então `pista.split('\n')` pode
 * devolver mais de duas partes. Um consumidor de T2 não pode separar papéis contando linhas.
 * `continuidade` (opcional) é o resultado de `decidirContinuidade`, mais `pistaDaIntencao` na fase 2.
 * Com `motivo` `'pergunta+curta'` ou `'intencao'`, o ramo de resposta curta decide antes do gate de
 * trivial: a pista é a última fala do assistente (cortada pelo fim) com o pedido do usuário antes dela.
 */
export function decidirPistaDeContexto({ texto, conversa, continuidade } = {}) {
  if (!validarEntrada(texto, conversa)) return resposta(false, 'entrada-invalida');
  if (conversa.length === 0) return resposta(false, 'sem-historico');
  if (continuidade && (continuidade.motivo === 'pergunta+curta' || continuidade.motivo === 'intencao')) {
    return pistaDeRespostaCurta(conversa, continuidade);
  }

  const atual = normalizar(texto);
  if (ehTrivial(atual)) return resposta(false, 'trivial');
  const regra = regraDeContinuidade(atual);
  if (!regra) return resposta(false, 'pedido-autonomo');

  const antecedente = encontrarAntecedente(conversa);
  if (!antecedente) return resposta(false, 'sem-antecedente');
  const { usuario, assistente } = antecedente;
  if (textoInseguro(usuario.texto) || textoInseguro(assistente.texto)) {
    return resposta(false, 'historico-inseguro');
  }
  if (temReferenciaCoordenada(usuario.texto)
    || temReferenciaCoordenada(assistente.texto)
    || temEnumeracaoMultilinha(usuario.texto)
    || temEnumeracaoMultilinha(assistente.texto)) {
    return resposta(false, 'ambiguo');
  }

  const pedido = cortarUnicode(usuario.texto, MAX_CHARS_PAPEL);
  const respostaAssistente = cortarUnicode(
    assistente.texto,
    Math.min(MAX_CHARS_PAPEL, MAX_CHARS_PISTA - pedido.length - 1),
  );
  const pista = `${pedido}\n${respostaAssistente}`;
  return resposta(true, 'continuidade', regra, pista, 2);
}
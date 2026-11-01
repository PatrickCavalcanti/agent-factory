// Construtor de prompt para um host do `@okds/kairos`.
//
// **Agnóstico de plataforma de propósito.** Não sabe o que é Ariadne, projeto,
// MCP ou capacidade de dados; sabe montar um prompt a partir dos BLOCOS que a
// ponte genos do pacote entrega. Tudo que é específico entra por
// `ConfiguracaoDoPrompt` — o texto base, os nomes das seções. O candidato
// natural a virar pacote próprio é este arquivo, sozinho.
//
// A configuração do Ariadne vive em `perfil.ts`; quem instancia é `turno.ts`.
//
// ## Os quatro níveis de volatilidade, e o que cada um custa
//
// Esta é A decisão de desenho do arquivo, e ela não é sobre organização: é
// sobre cache. Provedores cacheiam por PREFIXO — o acerto vai até o primeiro
// byte que mudou, e tudo depois dele é reprocessado. Então a pergunta para
// cada pedaço de conteúdo é uma só: **com que probabilidade ele muda dentro de
// uma sessão?** A resposta decide onde ele pousa.
//
// | nível | muda | onde pousa | o que a mudança custa |
// |---|---|---|---|
// | **fixo** | nunca | topo do system | nada — não muda |
// | **estável** | de vez em quando; a maioria das sessões não vê mudar | system, depois do fixo | invalida o que vem depois dele + o histórico. Aceita-se: é raro |
// | **dinâmico** | provavelmente muda durante a sessão | ainda no system, ANTES do histórico | invalida o histórico quase todo turno. **Deve tender a vazio** |
// | **efêmero** | todo turno | mensagem do turno, depois do histórico | nada — já está depois de tudo que se quer cachear |
//
// **"Estável" não quer dizer imutável.** Quer dizer que a maioria das sessões
// não vai vê-lo mudar. Uma sessão em que o usuário mexe explicitamente naquilo
// vai quebrar o cache mais de uma vez — e não há o que fazer: o conteúdo mudou
// mesmo, e mandá-lo desatualizado seria pior que pagar o reprocessamento.
//
// **"Dinâmico" é um lugar que se quer vazio.** Ele ainda está antes do
// histórico, então mudar ali derruba o histórico inteiro. Conteúdo que muda
// toda hora não é dinâmico: é EFÊMERO, e o lugar dele é a mensagem do turno.
// Se algo está caindo em dinâmico com frequência, a classificação está errada.
//
// Isto NÃO é vocabulário deste arquivo — é o contrato de `Destination` do
// `@okds/kairos` (`core/types.ts:3`), e o design-spec do pacote diz o
// mesmo com as mesmas palavras: `system:stable` é "muda raramente, mudança
// controlada" (l.103), `system:dynamic` "muda entre turnos; deve tender a
// vazio" (l.104), e a tabela de custo (l.338-339) explica por quê. O host honra
// a orientação do destino; não a reinventa.
//
// ### A ordem dentro do system sai da mesma conta
//
// Fixo → o que CRESCE (índice, contratos: append-only, nunca desloca nada
// acima) → o que TROCA (estado do projeto, tela aberta). O que troca fica
// encostado no histórico de propósito: é a menor superfície possível, então
// uma troca invalida só ela mesma e o que vem depois. Inverter isso faria uma
// troca pequena (uma linha de tela) deslocar todos os contratos, que são a
// parte cara.
//
// ## As duas regras que governam tudo aqui
//
// **1. Por turno se monta só duas coisas: o system prompt e a última
// mensagem.** O histórico vai verbatim, byte a byte, como foi enviado antes.
//
// **2. O system prompt é APPEND-ONLY.** Provedores cacheiam por prefixo: o
// cache acerta até o primeiro byte que mudou. Um item que já entrou nunca sai,
// nunca muda de posição e nunca muda de conteúdo — capacidade nova entra no
// FIM. A única remoção possível é perda de permissão (ver `acumular`), e é
// correto que ela quebre.
//
// Medido em conversa real (sessão `69f5e981`, turnos 5→8): **99,9% do prefixo
// do system preservado** quando entra um contrato novo — o único byte que
// diverge é o `</funcoes_carregadas>`, que o append empurra para a frente.
// Quando entra uma CAPACIDADE nova, cai para ~23%: o índice cresce antes dos
// contratos e desloca todos eles. É o custo aceito, e o raro.
//
// **Segunda exceção (spec 2026-10-29, cauda efêmera e despejo de capacidades).**
// Com o despejo da fábrica ligado (`despejo/`), o host tira em lote, de uma vez, o
// que ficou sem uso (manuais e capacidades). Isso quebra o append-only de propósito:
// a quebra é decidida pela conta do cache (`despejo/conta.js`), que só dispara quando
// o custo de manter o prefixo supera o de recriá-lo. Com o despejo desligado, a regra 2
// vale sem exceção.
//
// Daí a divisão system × mensagem: o que é estável e caro (índice, contratos)
// fica no system, acumulado; o que é efêmero (tela aberta, cards de
// candidatas) desce para a mensagem do turno, onde muda sem custo de cache.

/** @typedef {import('@okds/kairos/assemble').Block} Block */

/** @typedef {'developer' | 'user' | 'assistant'} PapelDeMensagem */

/**
 * `images` é o canal multimodal do genos (`MessageImage`): base64 SEM o prefixo
 * `data:`, que o provider monta. Só a mensagem DESTE turno as carrega — o
 * histórico é texto, e é por isso que uma imagem não sobrevive ao turno em que
 * foi enviada (ver `anexosDoTurno.ts`).
 *
 * @typedef {Object} MensagemDoTurno
 * @property {string} id
 * @property {PapelDeMensagem} role
 * @property {string} content
 * @property {Array<{ base64: string, mimeType: string, label?: string }>} [images]
 */

/**
 * Uma seção do prompt, já renderizada — é o que o rastro grava.
 * @typedef {Object} SecaoDoPrompt
 * @property {string} nome
 * @property {'system' | 'turno'} destino
 * @property {string} conteudo
 */

/**
 * @typedef {Object} PayloadDoTurno
 * @property {MensagemDoTurno[]} mensagens Exatamente o que vai em `initialMessages` do genos.
 * @property {string} system O system prompt inteiro, para gravar como arquivo.
 * @property {string} mensagemDoTurno A mensagem do turno (efêmeros + texto do usuário), idem.
 * @property {SecaoDoPrompt[]} secoes As mesmas duas, abertas por seção, para o log literal.
 */

// -- XML ---------------------------------------------------------------------

/**
 * @param {string} valor
 * @returns {string}
 */
function escaparAtributo(valor) {
  return valor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

/**
 * @param {string} nome
 * @param {Record<string, string | undefined>} atributos
 * @param {string} corpo
 * @returns {string}
 */
export function tag(nome, atributos, corpo) {
  const attrs = Object.entries(atributos)
    .filter((par) => typeof par[1] === 'string' && par[1] !== '')
    .map(([k, v]) => ` ${k}="${escaparAtributo(v)}"`)
    .join('')
  return `<${nome}${attrs}>\n${corpo.trim()}\n</${nome}>`
}

// -- rótulos dos grupos de função ---------------------------------------------

// Os dois grupos dentro de `<functions>` (Mudança 2, 2026-09-18): funções que
// JÁ carregaram manual (chamáveis agora) e funções que só têm nome e resumo
// (precisam de `load_capability` antes). Constantes nomeadas — não string
// literal dentro de `renderizarCapacidade` — porque só a ESTRUTURA
// (`NOMES_PADRAO`) está em inglês por ora; o texto continua em português, e
// uma tradução futura vira uma linha aqui, não uma busca pelo arquivo.
// ⚠️ O grupo de disponíveis NÃO leva rótulo, e isso é decisão.
//
// Ele levava "Disponíveis agora — chame direto:", repetido em TODA capacidade.
// Função listada com o manual embaixo já é obviamente chamável — o rótulo
// gastava tokens dizendo o óbvio uma vez por capacidade. A regra (o que é cada
// grupo) vive na legenda do BLOCO, uma vez só; aqui fica só o que distingue os
// dois, que é o rótulo dos carregáveis.
const ROTULO_FUNCOES_CARREGAVEIS = 'Outras funções desta capacidade, que você pode carregar conforme a necessidade:'
// Layout `lista-fixa`: rótulo LOCAL do grupo de manuais, logo abaixo da lista fixa — é o que diz,
// dentro da própria capacidade, quais funções já estão carregadas.
const ROTULO_FUNCOES_CARREGADAS = 'Carregadas — manual completo, chame direto:'

// -- prioridade de capacidade (Mudança 1, 2026-09-18) -------------------------

// Default de quem não declara `CapacidadeDeclarada.prioridade`. Números
// CRESCENTES a partir daqui (500, 501, 502…) são o que faz "ordenar por
// prioridade" e "ordem de chegada" darem o MESMO resultado para todo mundo
// que não declara nada — ver `proximaPrioridadeLivre`.
const PRIORIDADE_CAPACIDADE_PADRAO = 500

/**
 * A prioridade que uma capacidade NOVA recebe: a desejada, ou — se já estiver
 * ocupada por outra capacidade acumulada — o próximo inteiro livre. Resolver a
 * colisão AQUI, na inserção, é o miolo da Mudança 1: sem isso, duas
 * capacidades com o mesmo default empatariam e a ordem cairia de volta no
 * desempate por índice de array (que É a ordem de chegada, mas não fica
 * DECLARADA em lugar nenhum — a próxima capacidade a reclamar o mesmo número
 * quebraria o empate ao acaso).
 *
 * @param {number} desejada
 * @param {CapacidadeAcumulada[]} capacidades
 * @returns {number}
 */
function proximaPrioridadeLivre(desejada, capacidades) {
  const ocupadas = new Set(capacidades.map(c => c.prioridade))
  let candidata = desejada
  while (ocupadas.has(candidata)) candidata += 1
  return candidata
}

// -- classificação dos blocos ------------------------------------------------

/**
 * A que seção um bloco pertence, deduzido da FORMA da `ref` que a ponte do
 * pacote produz (`@okds/kairos/genos/bridge.ts#prepareTurn`):
 *
 *   `<provider>/instructions`         instruções do provider
 *   `<provider>/card`                 card de provider candidato
 *   `<provider>/tool/<key>#index`     linha de índice de uma tool consciente
 *   `<provider>/tool/<key>`           contrato completo de uma tool hidratada
 *   `skills/suggest`                  lista de habilidades sugeridas
 *   qualquer outra                    contribuição de contexto
 *
 * Deduzir pela forma — e não por um mapa nome→seção — é o que mantém este
 * arquivo agnóstico: um provider novo não exige linha nenhuma aqui.
 *
 * @typedef {'instrucoes' | 'indice' | 'contrato' | 'card' | 'contribuicao' | 'skills'} Classe
 */

/**
 * @param {string} ref
 * @returns {Classe}
 */
export function classificar(ref) {
  if (ref === 'skills/suggest') return 'skills'
  if (ref.endsWith('#index')) return 'indice'
  if (ref.endsWith('/instructions')) return 'instrucoes'
  if (ref.endsWith('/card')) return 'card'
  if (/^[^/]+\/tool\/[^/]+$/.test(ref)) return 'contrato'
  return 'contribuicao'
}

/**
 * `dados/tool/listar#index` → `dados`; `dados/card` → `dados`.
 * @param {string} ref
 * @returns {string}
 */
export function providerDaRef(ref) {
  return ref.split('/')[0] ?? ref
}

/**
 * `dados/tool/listar#index` → `dados/tool/listar`. A ref sem a marca de índice
 * é a identidade da TOOL — é ela que a lista de permitidas usa.
 * @param {string} ref
 * @returns {string}
 */
export function refDaTool(ref) {
  return ref.endsWith('#index') ? ref.slice(0, -'#index'.length) : ref
}

// -- acumulado ---------------------------------------------------------------

/**
 * @typedef {Object} ItemDeCapacidade
 * @property {string} ref ref do bloco que originou o item — a chave de identidade.
 * @property {string} providerId id do provider dono, para a revalidação de permissão.
 * @property {string} nome O NOME EXPOSTO da função — a string exata que o modelo vai emitir na
 *   chamada, e que tem de estar registrada com esse mesmo nome no runtime de execução. NÃO é a
 *   chave da tool no registry, nem a `ref`. O corpo (`conteudo`) descreve; este atributo ENDEREÇA.
 * @property {string} conteudo conteúdo CONGELADO na primeira vez que o item entrou.
 */

/**
 * Uma função dentro de uma capacidade. `indice` é a linha curta (entra assim
 * que a capacidade carrega); `manual` é o contrato completo, e só aparece
 * quando a função hidrata — pode nunca aparecer.
 *
 * @typedef {Object} FuncaoAcumulada
 * @property {string} ref
 * @property {string} nome
 * @property {string} indice
 * @property {string} [manual]
 */

/**
 * Uma capacidade inteira, como um bloco fechado do prompt: descrição, o índice
 * de todas as funções dela, e os manuais que já foram carregados.
 *
 * **Por que agrupado por capacidade, e não por tipo de conteúdo.** A versão
 * anterior tinha uma seção global de índices e outra de manuais. Isso fazia
 * uma capacidade NOVA acrescentar ao índice — que fica ANTES dos manuais —, e
 * portanto deslocar TODOS os manuais de TODAS as capacidades. Medido na sessão
 * `69f5e981`: quando `anexos` carregou, o prefixo caiu de 99,9% para 22,7%,
 * derrubando 19k chars de contratos que não tinham mudado em nada.
 *
 * Com a capacidade como bloco fechado, capacidade nova é append puro: entra no
 * fim e não move nada acima. E funciona na prática porque a capacidade
 * carregada por último é a que está em uso — é nela que os próximos manuais
 * vão hidratar, e ela já está no fim.
 *
 * O preço, que existe: um manual novo de uma capacidade ANTIGA desloca as
 * capacidades abaixo dela. É limitado e termina — uma capacidade tem ~10
 * funções e depois para de crescer —, enquanto o custo do desenho anterior só
 * aumentava, porque crescia com o total de manuais acumulados.
 *
 * @typedef {Object} CapacidadeAcumulada
 * @property {string} id
 * @property {string} [descricao] `Provider.instructions`, quando a capacidade declara.
 * @property {FuncaoAcumulada[]} funcoes
 * @property {number} prioridade Posição do bloco `<capability>` desta capacidade dentro de
 *   `<capabilities>` — atribuída UMA vez, na inserção (`acharOuCriar`), e nunca recalculada
 *   depois: é o que faz a ordem do bloco de capacidades não mudar sozinha entre turnos. Ver
 *   `CapacidadeDeclarada.prioridade` (capacidades.js) para a regra de default e colisão.
 */

/**
 * Uma contribuição — INFORMAÇÃO, não capacidade.
 *
 * Capacidade é o que o modelo pode CHAMAR; contribuição é o que ele precisa
 * SABER. Elas pertencem a uma capacidade (quem as registra), mas não são
 * funções e não se comportam como funções: um manual, uma vez escrito, é
 * sempre o mesmo texto; uma contribuição tem sempre a MESMA ref com conteúdo
 * diferente (a tela troca, o catálogo ganha uma entidade). Por isso a regra
 * dela é a oposta — ref repetida **substitui** em vez de ser ignorada.
 *
 * O que pode pousar aqui é aberto por desenho, e não se limita ao que existe
 * hoje. Exemplos que a estrutura já aceita, de capacidades diferentes:
 *
 * - `contexto` → catálogo de entidades, tela aberta (o que existe hoje);
 * - `dados` → os REGISTROS de uma entidade pequena e imóvel. Uma listagem
 *   completa de 3 municípios ou 4 áreas-chave, uma vez consultada, pode ficar
 *   no prompt em vez de ser reconsultada a cada turno — é a saída para o
 *   histórico não guardar retorno de tool sem o modelo perder o dado. Falta
 *   a entidade poder declarar que é imóvel; a estrutura do prompt já aceita;
 * - `projetos` → dados institucionais do dono do projeto (nome, logo,
 *   telefone), que são `fixo`.
 *
 * @typedef {Object} ContribuicaoAcumulada
 * @property {string} ref
 * @property {number} prioridade posição dentro do próprio nível. ÚNICA — ver `acumular`.
 * @property {string} conteudo
 */

// O que já entrou no system prompt desta conversa.
//
// As capacidades CRESCEM (append-only, ordem de chegada); as contribuições
// TROCAM (substituição em lugar, ordem de prioridade). E as contribuições são
// separadas pelos TRÊS níveis de `system:*` do pacote, porque cada um pousa num
// lugar diferente — a volatilidade decide a posição:
//
// ```
// base                    ← escrito no perfil, nunca muda
// fixas                   ← system:fixed   não muda DENTRO DA JANELA DE CACHE
// ┌ system:stable, por prioridade ─────────────────────────────┐
// │ contribuição @10       ex.: um anexo grande, imóvel        │
// │ <capacidades> @50      ← as capacidades são UM ITEM daqui  │
// │ contribuição @100      ex.: catálogo de entidades          │
// │ contribuição @200      ex.: tela aberta                    │
// └────────────────────────────────────────────────────────────┘
// dinamicas               ← system:dynamic troca quase todo turno; tende a vazio
// ─ histórico ─
// ```
//
// **As capacidades não são uma camada — são uma contribuição estável de nível
// médio.** É o que abre as 49 posições anteriores para conteúdo que é MAIS
// estável que uma capacidade e portanto não deve ser invalidado quando uma
// capacidade nova entra. O caso que justifica: um ANEXO. Um arquivo que o
// usuário mandou pode ter milhares de tokens, entra uma vez e sobrevive à
// sessão inteira — pagar o cache dele uma vez e nunca mais é a diferença entre
// viável e caro.
//
// A conta para decidir antes ou depois é TAMANHO × ESTABILIDADE RELATIVA, nunca
// estabilidade sozinha: o catálogo de entidades muda raramente e mesmo assim
// fica DEPOIS (@100), porque tem ~400 chars — pô-lo antes faria uma entidade
// nova invalidar os ~20k de manuais, e o troco não compensa.
//
// **`fixo` é uma afirmação sobre a janela de cache, não sobre o mundo.** O
// telefone da empresa dona do projeto muda um dia; o que importa é que ele não
// muda nas próximas horas de conversa. Por isso ele pode ficar acima das
// capacidades sem risco: nada ali vai invalidá-las.
//
// `dinamicas` fica DEPOIS de tudo que se quer cachear e ainda assim antes do
// histórico — é por isso que o pacote manda esse nível tender a vazio
// (design-spec l.104). Conteúdo que muda toda hora não é dinâmico: é efêmero, e
// o lugar dele é a mensagem do turno.
/**
 * Uma entrada do diário de capacidades (layout `diario`, spec 2026-10-15). O conteúdo é
 * CONGELADO quando a entrada nasce — é o que garante que o texto já enviado não muda. A única
 * coisa que o render consulta fora dela é se a função ainda existe (perda de permissão).
 *
 * @typedef {{ ref: string, nome: string, indice: string }} LinhaDoDiario
 * @typedef {(
 *   { tipo: 'capacidade', capId: string, descricao: string | null, funcoes: LinhaDoDiario[] }
 *   | { tipo: 'extra', capId: string, descricao: string | null, funcoes: LinhaDoDiario[] }
 *   | { tipo: 'manual', capId: string, ref: string, nome: string, texto: string }
 * )} EntradaDoDiario
 */

/**
 * @typedef {Object} SystemAcumulado
 * @property {CapacidadeAcumulada[]} capacidades
 * @property {ContribuicaoAcumulada[]} fixas
 * @property {ContribuicaoAcumulada[]} estaveis
 * @property {ContribuicaoAcumulada[]} dinamicas
 * @property {EntradaDoDiario[]} [diario] Ordem de chegada de cartões e manuais. Mantido nos dois
 *   layouts (barato); só o layout `diario` o renderiza.
 */

/** @returns {SystemAcumulado} */
export function systemVazio() {
  return { capacidades: [], fixas: [], estaveis: [], dinamicas: [], diario: [] }
}

/**
 * Diário inicial a partir de capacidades já acumuladas sem diário (estado anterior ao layout):
 * um cartão por capacidade, na ordem de render do layout agrupado, e um manual por função
 * hidratada. Só roda uma vez por sessão, quando o estado chega sem `diario`.
 *
 * @param {CapacidadeAcumulada[]} capacidades
 * @returns {EntradaDoDiario[]}
 */
function diarioDeCapacidades(capacidades) {
  /** @type {EntradaDoDiario[]} */
  const diario = []
  const ordenadas = [...capacidades].sort((a, b) => a.prioridade - b.prioridade)
  for (const cap of ordenadas) {
    diario.push({
      tipo: 'capacidade',
      capId: cap.id,
      descricao: cap.descricao ?? null,
      funcoes: cap.funcoes.map(f => ({ ref: f.ref, nome: f.nome, indice: f.indice })),
    })
  }
  for (const cap of ordenadas) {
    for (const f of cap.funcoes) {
      if (f.manual) diario.push({ tipo: 'manual', capId: cap.id, ref: f.ref, nome: f.nome, texto: f.manual })
    }
  }
  return diario
}

/**
 * O nível de um bloco `system:*`. `system:stable` é o default de quem não
 * declara — é o meio-termo, e o único que não precisa de justificativa.
 * @typedef {'fixas' | 'estaveis' | 'dinamicas'} NivelDeContribuicao
 */

/**
 * @param {string} destino
 * @returns {NivelDeContribuicao}
 */
function nivelDoBloco(destino) {
  if (destino === 'system:fixed') return 'fixas'
  if (destino === 'system:dynamic') return 'dinamicas'
  return 'estaveis'
}

/**
 * @typedef {Object} EntradaDaAcumulacao
 * @property {SystemAcumulado} anterior
 *   ⚠️ `acumular` CONSOME este objeto: os itens são reaproveitados por REFERÊNCIA e escritos em
 *   lugar (conteúdo de contribuição, prioridade, manual de função, descrição de capacidade). Não
 *   reuse `anterior` depois da chamada nem tente diffar contra ele — o estado novo é
 *   `resultado.system`, e o rastro do que mudou é `resultado.entraram` / `resultado.sairam`.
 * @property {readonly string[]} [remover] Refs de contexto que o host recalcula a cada turno. São removidas antes
 *   de aplicar os blocos atuais; estes podem reintroduzi-las no mesmo turno.
 * @property {Block[]} system `prepared.blocks.system`
 * @property {Block[]} turno `prepared.blocks.turn`
 * @property {ItemDeCapacidade[]} indice Linha de índice de TODA tool consciente, hidratada ou não — montada do
 *   registry pelo host, não dos blocos.
 *
 *   Por que não dos blocos: a ponte do pacote SUPRIME o `#index` de uma tool
 *   que hidratou no mesmo turno (`bridge.ts:247` — "hidratada já carrega
 *   contrato completo abaixo, o índice separado seria redundante"). Numa
 *   montagem por turno isso economiza tokens; numa montagem acumulada é
 *   veneno: a linha aparece atrasada, no primeiro turno em que a tool NÃO
 *   hidrata, e o índice cresce no meio da conversa por um motivo espúrio —
 *   deslocando todos os contratos abaixo.
 *
 *   ⚠️ Deve conter apenas refs presentes em `conscientes`. O passo do índice roda DEPOIS da
 *   revalidação de permissão e reintroduziria o que você mandar a mais.
 * @property {string[]} conscientes `discoverResult.tools.conscious` — o permitido AGORA.
 * @property {string[]} providersCarregados `discoverResult.providers.load` — quem revalidou neste turno.
 * @property {Map<string, number>} [prioridadeDeclarada] `id da capacidade → CapacidadeDeclarada.prioridade`
 *   (capacidades.js), só para quem declarou um valor. Montado pelo host (`index.js`) a partir de
 *   `config.capacidades` — o construtor de prompt não conhece a declaração original, só o `id`
 *   que chega em `indice`/`turno`. Capacidade ausente do mapa cai no default (ver `acharOuCriar`).
 */

/**
 * @typedef {Object} ResultadoDaAcumulacao
 * @property {SystemAcumulado} system
 * @property {Block[]} efemeros blocos `turn:*` que NÃO são contrato. Vão na mensagem do turno e morrem
 *   com ela.
 * @property {string[]} entraram para o rastro: o que mudou no system neste turno.
 * @property {string[]} sairam
 */

// -- operações de um turno ---------------------------------------------------

/**
 * @typedef {Object} OperacaoDoTurno
 * @property {string} nome
 * @property {unknown} args
 * @property {boolean} ok
 * @property {string} [erro]
 */

// -- configuração ------------------------------------------------------------

/**
 * Uma seção fixa do system, montada por turno a partir do contexto do host.
 * @typedef {Object} SecaoBase
 * @property {string} nome
 * @property {string} conteudo
 */

// As três seções de INFORMAÇÃO no system, uma por nível de volatilidade.
// Não se chamam "contexto": `contexto` é o nome de uma CAPACIDADE (a que
// registra a tela e o catálogo hoje), e o que pousa aqui vem de qualquer
// capacidade — inclusive `dados`, quando ele congelar os registros de uma
// entidade imóvel. O que define a seção é a volatilidade, não a origem.
/**
 * O VOCABULÁRIO ESTRUTURAL do prompt — nome de tag e de seção — é em INGLÊS,
 * por decisão do dono da fábrica (2026-09-18): "capacidades, em inglês, ali
 * tudo". As LEGENDAS continuam em português (`legendasPadrao`, abaixo) — o
 * que muda aqui é só o rótulo da estrutura, não o texto que ela carrega.
 *
 * @typedef {Object} NomesDeSecao
 * @property {string} capacidades o bloco que reúne todas as capacidades carregadas.
 * @property {string} capacidade cada capacidade dentro dele.
 * @property {string} indice o bloco `<functions>` de uma capacidade — os dois grupos,
 *   disponíveis e carregáveis (ver `renderizarCapacidade`). Não é mais só o índice: a
 *   Mudança 2 (2026-09-18) fundiu índice e manuais numa seção só, para uma função com
 *   manual carregado deixar de aparecer duas vezes.
 * @property {string} item cada função, dentro do grupo "disponíveis" (com manual completo).
 *   O grupo "carregáveis" não usa tag — é linha `- nome — descrição`.
 * @property {string} fixas `system:fixed` — não muda dentro da janela de cache.
 * @property {string} dinamicas `system:dynamic` — troca quase todo turno; tende a vazio.
 * @property {string} efemeras contribuições EFÊMERAS, na mensagem do turno.
 * @property {string} candidatos
 * @property {string} habilidades
 * @property {string} operacoes
 */

/** @type {NomesDeSecao} */
export const NOMES_PADRAO = {
  capacidades: 'capabilities',
  capacidade: 'capability',
  // Layout `diario` (spec 2026-10-15): descrição ou funções que chegam DEPOIS do cartão de uma
  // capacidade entram numa entrada própria no fim do diário, nunca reescrevendo o cartão.
  capacidadeExtra: 'capability_extra',
  indice: 'functions',
  item: 'function',
  fixas: 'fixed_info',
  dinamicas: 'current_info',
  efemeras: 'turn_context',
  candidatos: 'suggested_capabilities',
  habilidades: 'suggested_skills',
  operacoes: 'turn_operations',
}

/**
 * Remove registros de operações imitados pelo modelo no texto da resposta,
 * antes de costurar o bloco da plataforma no histórico (senão o bloco aparece
 * duas vezes e o modelo passa a imitá-lo). Só remove blocos COMPLETOS
 * (`<nome>…</nome>`); abertura sem fechamento — p.ex. a tag citada em prosa —
 * mantém o texto intacto. (Do Ariadne 7d5e76e5; o descarte do resto foi
 * trocado por este comportamento.)
 * @param {string} texto
 * @param {string} [nome] nome da tag (padrão `NOMES_PADRAO.operacoes`)
 */
export function removerBlocosDeOperacoes(texto, nome = NOMES_PADRAO.operacoes) {
  const abertura = `<${nome}>`;
  const fechamento = `</${nome}>`;
  let limpo = '';
  let inicio = 0;
  let fecha;
  while ((fecha = texto.indexOf(fechamento, inicio)) !== -1) {
    // Só bloco COMPLETO: o par é o fechamento e a abertura mais próxima antes dele. Uma abertura
    // citada em prosa (sem par) fica no texto, e não leva consigo o que vem depois.
    const abre = texto.lastIndexOf(abertura, fecha - abertura.length);
    if (abre < inicio) { limpo += texto.slice(inicio, fecha + fechamento.length); inicio = fecha + fechamento.length; continue; }
    limpo += texto.slice(inicio, abre);
    inicio = fecha + fechamento.length;
  }
  return limpo + texto.slice(inicio);
}

/**
 * Legenda de cada seção do catálogo. **Default no motor, não opção do host** —
 * a V2 do Ariadne herdou o mecanismo do orquestrador de tela e não herdou esta
 * configuração, e o modelo passou a receber `<funcoes>`, `<manuais>` e
 * `<capacidades_sugeridas>` sem uma linha dizendo o que aquilo é
 * (pendência 2026-09-12, item "as três legendas do prompt estão vazias").
 * Botão opcional é botão que o próximo host esquece.
 *
 * ⚠️ O default NÃO cita verbo de carregamento. O texto equivalente do Ariadne
 * (`orquestrador/perfil.ts:216-227`) menciona `load_capability`/`call_capability`,
 * que são meta-tools DAQUELE host. A fábrica expõe as tools direto pelo nome
 * (`capacidades.js#nomeExposto`) e quem decide o que hidrata é o discover do
 * kairos, não o modelo. Um default que nomeasse um verbo inexistente mandaria o
 * modelo chamar o que não existe — que é o defeito que estas legendas
 * combatem. Host com verbo próprio sobrescreve.
 */
/**
 * As legendas default do catálogo.
 *
 * ⚠️ **É FUNÇÃO DOS NOMES, e isso não é elegância — é o conserto de um defeito
 * medido.** Enquanto o texto do protocolo morava no host (o
 * `protocolo_de_capacidades` do orquestrador de tela do Ariadne), ele citava
 * `<funcoes_carregadas>` CINCO vezes — uma tag que a fábrica não emite: a
 * seção se chama `<functions>` (`NOMES_PADRAO.indice`). O host escrevia sobre
 * uma estrutura que só a fábrica conhece, a fábrica renomeou, e o texto ficou
 * mandando o modelo procurar uma tag inexistente. Sem erro, sem sinal.
 *
 * Quem sabe o nome da tag é quem a escreve. Derivando daqui, renomear em
 * `NOMES_PADRAO` corrige a legenda no mesmo movimento.
 *
 * @param {NomesDeSecao} n
 */
function legendasPadrao(n, { mecanicaNoCatalogo = false, estrategia } = {}) {
  // `mecanicaNoCatalogo` (vindo do Ariadne, 2026-10-24, `fc2457a8` + `b7bec589`): a mecânica de
  // chamada sai do topo do system e passa a viver DENTRO do catálogo, escrita pela estratégia de
  // protocolo. Desligado = o texto de sempre (Igris).
  const nativo = mecanicaNoCatalogo && estrategia?.registraCapacidades === false
  return {
    // A legenda do BLOCO: explica o que é o catálogo que acaba de abrir E como
    // o mecanismo funciona. Sem ela o modelo recebe uma árvore de tags sem
    // nenhuma frase dizendo que aquilo são funções chamáveis — foi o "catálogo
    // mudo" medido no pipeline V2 do Ariadne.
    //
    // Mudança 2 (2026-09-18): esta legenda NÃO nomeia mais `load_capability`/
    // `call_capability`/`search_capabilities`. A fábrica só conhece a FORMA do
    // catálogo (capacidade → grupo disponível/carregável); quem regista as
    // três meta-tools é a PONTE do kairos, não este módulo — nomear aqui era a
    // fábrica falando sobre um mecanismo que não é dela. Quem nomeia o verbo de
    // carregamento é a camada de PROTOCOLO (`estrategia.secaoInvariante()`), a
    // mesma que já nomeia o verbo de chamada de qualquer tool.
    capacidades: [
      'As funções que você pode chamar chegam por camada, e este bloco é o catálogo deste turno.',
      '',
      `- Cada \`<${n.capacidade}>\` agrupa funções de um mesmo assunto; a primeira linha dela diz para que serve.`,
      `- Dentro dela, \`<${n.indice}>\` separa as funções em dois grupos: as que JÁ TÊM manual`,
      '  completo — argumentos, regras, casos de borda — e ' + (mecanicaNoCatalogo ? 'estão prontas para execução' : 'você pode chamar direto') + '; e as que só',
      '  têm nome e o que fazem, e precisam ser CARREGADAS antes de poderem ser chamadas.',
      '  O que já tem manual NÃO sai: função carregada num turno anterior continua carregada.',
      '',
      'No manual, cada argumento vem marcado: `*` obrigatório, `?` opcional, seguido do tipo e',
      'do que ele significa. Argumento obrigatório ausente é recusa, não default.',
      '',
      'A ordem importa:',
      '',
      ...(!mecanicaNoCatalogo ? [
        `- Função já com manual em \`<${n.indice}>\`: **chame direto**. Não peça o manual de novo.`,
        '- Função listada sem manual: carregue o manual dela primeiro, e só então chame. Chamar sem',
        '  o manual é chamar sem saber os argumentos, e a chamada é recusada.',
      ] : nativo ? [
        `- Função já com manual em \`<${n.indice}>\`: execute por \`call_capability\`, com o valor do atributo \`ref\` dela em \`ref\` e os argumentos em \`args\`. Não peça o manual de novo.`,
        '- Função listada sem manual: carregue por `load_capability`, incluindo esse `ref` em `refs`, antes de executar.',
      ] : [
        `- Função já com manual em \`<${n.indice}>\`: siga a orientação de execução abaixo. Não peça o manual de novo.`,
        '- Função listada sem manual: carregue o manual dela primeiro, e só então chame. Chamar sem',
        '  o manual é chamar sem saber os argumentos, e a chamada é recusada.',
      ]),
      `- Função listada numa capacidade de \`<${n.candidatos}>\`: carregue o manual pelo nome DA`,
      '  FUNÇÃO — o nome da capacidade não é chamável, uma capacidade não se carrega inteira.',
      ...(nativo ? ['- `search_capabilities({ query })`: procure por texto livre só quando o catálogo não indicar uma função adequada.'] : []),
      ...(mecanicaNoCatalogo ? [
        '',
        `O bloco \`<${n.operacoes}>\` nas mensagens anteriores registra fatos já executados pela plataforma.`,
        'Ele preserva a referência da função, os argumentos e o resultado (ok ou erro), não o retorno completo.',
        'Consulte esse registro antes de repetir uma operação; identificadores já usados continuam disponíveis ali.',
        'Esse registro não é sintaxe de chamada. A plataforma o escreve: nunca o escreva na sua resposta.',
      ] : []),
    ].join('\n'),

    // Legenda do bloco no layout `diario` (spec 2026-10-15). A estrutura é outra — cartão da
    // capacidade com a lista de funções, e os manuais DEPOIS, em ordem de carga —, então a
    // explicação também: a do layout agrupado falaria de "dois grupos" que não existem aqui.
    capacidadesDiario: [
      'As funções que você pode chamar chegam por camada, e este bloco é o catálogo desta conversa, em ordem de chegada.',
      '',
      `- Cada \`<${n.capacidade}>\` é o cartão de uma capacidade: para que serve e a lista das funções dela`,
      `  em \`<${n.indice}>\` (nome e o que faz).`,
      `- Cada manual vem depois do cartão da capacidade dele, num \`<${n.item} name="…" capability="…">\`, na`,
      '  ordem em que foi carregado — argumentos, regras, casos de borda. Cartões de capacidades que chegaram',
      '  depois podem aparecer entre manuais. O que já tem manual NÃO sai.',
      `- \`<${n.capacidadeExtra}>\` acrescenta descrição ou funções a uma capacidade que já tem cartão acima.`,
      '',
      'No manual, cada argumento vem marcado: `*` obrigatório, `?` opcional, seguido do tipo e',
      'do que ele significa. Argumento obrigatório ausente é recusa, não default.',
      '',
      'A ordem importa:',
      '',
      `- Função com \`<${n.item}>\` (manual) neste bloco: **chame direto**. Não peça o manual de novo.`,
      '- Função só listada num cartão: carregue o manual dela primeiro, e só então chame. Chamar sem',
      '  o manual é chamar sem saber os argumentos, e a chamada é recusada.',
      `- Função listada numa capacidade de \`<${n.candidatos}>\`: carregue o manual pelo nome DA`,
      '  FUNÇÃO — o nome da capacidade não é chamável, uma capacidade não se carrega inteira.',
    ].join('\n'),

    // Legenda do bloco no layout `lista-fixa` (decisão do dono, 2026-10-15): cada capacidade
    // continua um bloco fechado, com a lista de TODAS as funções (que não muda na sessão) e, logo
    // abaixo, os manuais das que já foram carregadas. Carregar uma função acrescenta o manual dela
    // no fim do grupo da própria capacidade — a lista não se mexe.
    capacidadesListaFixa: [
      'As funções que você pode chamar chegam por camada, e este bloco é o catálogo desta conversa.',
      '',
      `- Cada \`<${n.capacidade}>\` é uma capacidade: para que serve, a lista de TODAS as funções dela em`,
      `  \`<${n.indice}>\` (nome e o que faz) e, logo abaixo da lista, o manual completo de cada função já`,
      `  carregada, em \`<${n.item} name="…">\` — argumentos, regras, casos de borda.`,
      '  O que já tem manual NÃO sai: função carregada num turno anterior continua carregada.',
      '',
      'No manual, cada argumento vem marcado: `*` obrigatório, `?` opcional, seguido do tipo e',
      'do que ele significa. Argumento obrigatório ausente é recusa, não default.',
      '',
      'A ordem importa:',
      '',
      `- Função com manual dentro da capacidade: **chame direto**. Não peça o manual de novo.`,
      '- Função só listada, sem manual abaixo da lista: carregue o manual dela primeiro, e só então',
      '  chame. Chamar sem o manual é chamar sem saber os argumentos, e a chamada é recusada.',
      `- Função listada numa capacidade de \`<${n.candidatos}>\`: carregue o manual pelo nome DA`,
      '  FUNÇÃO — o nome da capacidade não é chamável, uma capacidade não se carrega inteira.',
    ].join('\n'),

    // ⚠️ VAZIA POR DEFAULT, e de propósito. É renderizada DENTRO de cada
    // `<capacidade>` (ver `renderizarCapacidade`), então com sete capacidades
    // carregadas o mesmo parágrafo entrava sete vezes. Tudo o que ela diria já
    // está na legenda do bloco acima, uma vez só — repetir engorda o prompt e
    // ensina o modelo a pular texto repetido.
    //
    // Continua configurável: um host que queira a legenda por capacidade passa
    // `legendas.indice`. Só não é mais o default.
    //
    // Não há mais `contratos`: a Mudança 2 (2026-09-18) fundiu índice e
    // manuais num bloco só (`<functions>`), e a legenda que existia para o
    // extinto `<manuais>` ficaria sem seção para pousar.
    indice: '',

    // ⚠️ Esta legenda mudou junto com o CARD. A redação anterior era "diga o
    // que quer fazer em vez de inventar um nome de função" — correta enquanto
    // o card não trazia nome nenhum, e obsoleta no instante em que passou a
    // trazer (`cardsComFuncoes`, `index.js`).
    //
    // O par card+legenda tem de mudar junto: o card dá o NOME, a legenda diz o
    // que fazer com ele, e o guarda (`recusaSemManual`, `index.js`) cobra se
    // ele pular o passo. Três peças de um mecanismo só.
    candidatos: [
      'Capacidades relacionadas ao seu pedido que ainda NÃO estão carregadas. As funções listadas '
        + 'em cada uma existem, mas você ainda não recebeu o manual delas — chamar uma agora falha, '
        + 'porque você não sabe os argumentos.',
      '',
      ...(nativo ? [
        'Os nomes de função listados aqui são valores de `ref`. Para usá-los, siga a ordem de carregamento e execução do catálogo; nunca use o nome da capacidade como `ref`.',
      ] : ['Para usar qualquer uma: carregue o manual dela pelo NOME DA FUNÇÃO exatamente como aparece '
        + 'aqui (nunca o nome da capacidade — capacidade não é chamável). O manual chega, e aí você '
        + 'chama normal.']),
      '',
      'Se nada aqui servir, diga o que você quer fazer — nunca invente um nome de função.',
    ].join('\n'),
  }
}

/**
 * @template [TContexto=Record<string, unknown>]
 * @typedef {Object} ConfiguracaoDoPrompt
 * @property {(contexto: TContexto) => SecaoBase[]} base As seções fixas do system — identidade, protocolo, regras de resposta.
 *   É a metade que NENHUM discover produz, e a parte mais estável do prefixo.
 *
 *   Recebe o contexto do host (projeto aberto, usuário, o que for) porque
 *   costuma haver um dado que muda por conversa e não por turno. Precisa ser
 *   DETERMINÍSTICA: mesmo contexto, mesmos bytes — senão o prefixo do cache
 *   quebra em todo turno.
 * @property {Partial<Record<'capacidades' | 'capacidadesDiario' | 'capacidadesListaFixa' | 'indice' | 'candidatos', string>>} [legendas] Legenda de cada seção acumulada — o catálogo sozinho não se explica.
 * @property {Partial<NomesDeSecao>} [nomes] Nomes das tags, quando o host quiser outro vocabulário.
 * @property {import('./protocolo/index.js').EstrategiaDeProtocolo} [estrategia] Estratégia de registro e execução das funções (lida só com `mecanicaNoCatalogo`).
 * @property {boolean} [mecanicaNoCatalogo] Default `false`. `true` = a mecânica de chamada (carregar, executar) vive
 *   dentro do bloco de capacidades, escrita pela estratégia de protocolo (`contexto.__instrucoesDeCapacidades`), e
 *   nunca no topo do system; no nativo o manual sai como `<function ref="…">`; o registro de operações do turno sai em
 *   forma neutra (`Operação executada | referência: … | argumentos: … | resultado: …`). Só no layout `agrupado`.
 * @property {'agrupado' | 'diario' | 'lista-fixa'} [layoutDasCapacidades] Como o bloco de capacidades é escrito.
 *   `'lista-fixa'` (decisão do dono, 2026-10-15): bloco fechado por capacidade, como no agrupado, mas a
 *   lista de funções é FIXA (todas, na ordem em que entraram, sem separar carregadas) e os manuais das
 *   carregadas vêm logo abaixo dela, na ordem de carga — carregar acrescenta no fim do grupo da própria
 *   capacidade (perde o cache dali para baixo, aceito em troca de cartão e manual juntos). Default
 *   `'agrupado'` (cada capacidade como bloco fechado, manuais dentro dela). `'diario'` (spec
 *   2026-10-15, estabilização do cache): cartões e manuais em ORDEM DE CHEGADA, cada entrada
 *   congelada quando entra — hidratar um manual ou carregar uma capacidade só ACRESCENTA ao fim, e o
 *   prefixo já enviado fica byte a byte igual. O que é chamável não muda: vem de `capacidades`, não
 *   do texto.
 * @property {number} [prioridadeDasCapacidades] A posição do bloco `<capacidades>` na faixa `system:stable`. Default 50.
 *
 *   **As capacidades são uma contribuição estável como as outras** — a única
 *   diferença é que o conteúdo delas é sintetizado aqui, e não lido de um
 *   `read()`. Ficarem no meio da faixa é o ponto: sobram 49 posições para o que
 *   é MAIS estável que uma capacidade (e portanto nunca é invalidado quando uma
 *   capacidade nova entra) e infinitas para o que é menos.
 *
 *   Quando vale pôr algo antes (prioridade < 50): quando ele é grande E
 *   genuinamente mais estável. O caso que justifica o desenho é um ANEXO — um
 *   arquivo que o usuário mandou, que pode ter milhares de tokens, entra uma
 *   vez e sobrevive a sessão inteira. Pagar o cache dele uma vez e nunca mais é
 *   a diferença entre viável e caro.
 *
 *   Quando NÃO vale: conteúdo pequeno, mesmo que estável. O catálogo de
 *   entidades tem ~400 chars e muda raramente — mas pôr antes das capacidades
 *   significaria que uma entidade nova invalida os ~20k de manuais. É mais
 *   barato deixá-lo depois e sacrificá-lo quando uma capacidade entra. A conta
 *   é TAMANHO × ESTABILIDADE RELATIVA, nunca estabilidade sozinha.
 */

/**
 * @template TContexto
 * @typedef {Object} EntradaDaMontagem
 * @property {TContexto} contexto
 * @property {string} texto o que o usuário escreveu, cru. Fecha a mensagem do turno (recência).
 * @property {SystemAcumulado} system
 * @property {Block[]} efemeros blocos que morrem com este turno.
 * @property {MensagemDoTurno[]} historico Mensagens dos turnos anteriores, VERBATIM. Vão entre o system e a mensagem
 *   deste turno, sem serem remontadas: remontar trocaria bytes de um prefixo já
 *   cacheado.
 * @property {{ bloco: string, imagens: MensagemDoTurno['images'] }} [anexos] anexos desta mensagem: o bloco de texto que os descreve e as imagens.
 * @property {string} [preHidratacao] bloco do loop do Jev (spec 2026-09-22 §6.3): o que ele já
 *   consultou antes deste turno, com confiança. Entra na mensagem do turno, depois dos anexos e
 *   antes do texto do usuário (o pedido continua sendo a última coisa que o modelo lê).
 * @property {Array<{ nome: string, conteudo: string }>} [extrasDoTurno] blocos extras da mensagem deste turno (spec
 *   2026-10-29, cauda efêmera e despejo): entram DEPOIS dos efêmeros e ANTES dos anexos e do pedido. Ficam fora
 *   do system; `conteudo` vazio é descartado. A seção de cada um sai em `secoes` com `destino: 'turno'`.
 * @property {MensagemDoTurno[]} [aposOPedido] Correção A (fluxo de bug, sessões 54862f78/08cd7835,
 *   22-09): mensagens do loop do Jev com confiança acima do corte (par `assistant`/`tool_result`,
 *   `entregaDoLoop`/loop-do-turno.js), que precisam entrar DEPOIS da mensagem `usr` — nunca junto
 *   de `historico` (turnos ANTERIORES). Antes desta correção, `index.js` juntava as duas coisas
 *   num `historico` só, e o par do Jev pousava ANTES do pedido deste turno: o modelo lia a
 *   chamada como se tivesse acontecido num turno passado e refazia a mesma consulta (medido:
 *   `gcal_listar_eventos`/`task_listar` repetidos com os MESMOS argumentos). A ordem
 *   `[...historico, usr, ...aposOPedido]` é exatamente a que o genos produz quando o PRÓPRIO
 *   modelo chama uma função (a resposta dele vira `assistant`, e o `tool_result` entra logo
 *   depois, ambos DEPOIS da mensagem que motivou a chamada) — ver JSDoc de `entregaDoLoop`.
 */

/**
 * @template TContexto
 * @typedef {Object} ConstrutorDePrompt
 * @property {(entrada: EntradaDaAcumulacao) => ResultadoDaAcumulacao} acumular
 * @property {(entrada: EntradaDaMontagem<TContexto>) => PayloadDoTurno} montar
 * @property {(texto: string) => string} removerOperacoes `removerBlocosDeOperacoes` com o nome efetivo da tag de operações (após mesclar com `NOMES_PADRAO`) — a mesma fonte de `blocoDeOperacoes`.
 * @property {(operacoes: OperacaoDoTurno[]) => string} blocoDeOperacoes O registro compacto do que um turno executou, para costurar na mensagem do
 *   assistente daquele turno.
 *
 *   Existe porque o histórico pode não guardar `tool_result` — e sem nenhum
 *   vestígio o modelo não sabe o que já rodou e repete a chamada. Guardar
 *   nome/args/desfecho custa uma linha. Foi assim que, num teste real, o
 *   modelo editou um registro no turno seguinte usando o id que ele só tinha
 *   visto nos ARGUMENTOS da chamada anterior.
 */

// -- fábrica -----------------------------------------------------------------

/**
 * @template [TContexto=Record<string, unknown>]
 * @param {ConfiguracaoDoPrompt<TContexto>} config
 * @returns {ConstrutorDePrompt<TContexto>}
 */
export function criarConstrutorDePrompt(config) {
  /** @type {NomesDeSecao} */
  // Mescla por CHAVE, ignorando `undefined`: `{ operacoes: undefined }` cai no padrão em vez de virar a tag `<undefined>`.
  const nomes = { ...NOMES_PADRAO, ...Object.fromEntries(Object.entries(config.nomes ?? {}).filter(([, v]) => v !== undefined)) }
  // Mescla por CHAVE, não por objeto. `{ ...PADRAO, ...config.legendas }`
  // sobrescreve por chave PRESENTE: um host que passe `{ indice: '' }` ou
  // `{ indice: undefined }` apagaria o default e o catálogo voltaria a chegar
  // mudo — o defeito que estas legendas existem para impedir (review da Fase 2,
  // medido com `criarOrquestrador` real).
  //
  // Consequência aceita: **não há como suprimir uma legenda passando vazio.**
  // É deliberado — legenda ausente é o defeito, não uma configuração. Quem não
  // quiser a redação do motor passa a sua, não o vazio.
  //
  // ⚠️ O fallback é por `||`, o que também trataria `0` e `false` como vazio.
  // Vale aqui porque as três legendas são sempre `string` — NÃO copie este
  // padrão para um campo numérico ou booleano (`prioridade: 0` viraria
  // "ausente" e cairia no default sem ninguém notar).
  // `||`, e não `??`: legenda vazia vinda do host é o defeito do "catálogo
  // mudo", não uma configuração — travado em `test/travas.test.js`. Continua
  // valendo onde importa (`capacidades`, `candidatos`); para `indice` o
  // default JÁ é vazio, então os dois operadores dão no mesmo.
  const mecanicaNoCatalogo = config.mecanicaNoCatalogo === true
  const padrao = legendasPadrao(nomes, { mecanicaNoCatalogo, estrategia: config.estrategia })
  const legendas = {
    capacidades: config.legendas?.capacidades || padrao.capacidades,
    capacidadesDiario: config.legendas?.capacidadesDiario || padrao.capacidadesDiario,
    capacidadesListaFixa: config.legendas?.capacidadesListaFixa || padrao.capacidadesListaFixa,
    indice: config.legendas?.indice || padrao.indice,
    candidatos: config.legendas?.candidatos || padrao.candidatos,
  }
  const prioridadeDasCapacidades = config.prioridadeDasCapacidades ?? 50
  const layoutDasCapacidades = config.layoutDasCapacidades ?? 'agrupado'
  if (!['agrupado', 'diario', 'lista-fixa'].includes(layoutDasCapacidades)) {
    throw new Error(`layoutDasCapacidades inválido: "${layoutDasCapacidades}" (use 'agrupado', 'diario' ou 'lista-fixa')`)
  }
  // As instruções de execução só têm lugar no layout agrupado; nos outros elas seriam perdidas em silêncio.
  if (mecanicaNoCatalogo && layoutDasCapacidades !== 'agrupado') {
    throw new Error(`mecanicaNoCatalogo só é suportada no layout 'agrupado' (pedido: '${layoutDasCapacidades}')`)
  }
  /** No nativo com a mecânica no catálogo, o manual é endereço (`ref`), não definição de tool (`name`). */
  const atributoDoManual = mecanicaNoCatalogo && config.estrategia?.registraCapacidades === false ? 'ref' : 'name'

  /** Ordem das seções efêmeras na mensagem do turno.
   * @type {Classe[]}
   */
  const ordemEfemera = ['contribuicao', 'card', 'skills', 'instrucoes', 'indice', 'contrato']

  /** @type {Record<Classe, { secao: string, item?: string, atributo?: string, legenda?: string }>} */
  const moldeEfemero = {
    // `atributo` é o nome do ATRIBUTO XML — `name`/`source`, em inglês, como o
    // resto do vocabulário estrutural (`NOMES_PADRAO`). É o rótulo em volta
    // que é português (`legenda`).
    contribuicao: { secao: nomes.efemeras, item: 'info', atributo: 'source' },
    card: { secao: nomes.candidatos, item: nomes.capacidade, atributo: 'name', legenda: legendas.candidatos },
    skills: { secao: nomes.habilidades },
    // Não alcançáveis pela rota efêmera (sobem para o acumulado), mas o mapa é
    // total para o `Record` não mentir sobre a cobertura. Desde a Mudança 2
    // (2026-09-18) não há mais um nome próprio para "manuais" — os dois
    // apontam para o mesmo bloco fundido (`nomes.indice`, o `<functions>`).
    instrucoes: { secao: nomes.capacidades, item: nomes.capacidade, atributo: 'name' },
    indice: { secao: nomes.indice, item: nomes.item, atributo: 'name' },
    contrato: { secao: nomes.indice, item: nomes.item, atributo: 'name' },
  }

  /**
   * Soma o que o discover trouxe agora ao que já estava no system prompt.
   *
   * **Por que a acumulação é do host e não do pacote.** `applySessionPolicy`
   * (`session/policy.ts:136`) descarta, de propósito, os refs de um provider
   * que recarrega no turno. O comentário B2/F9 explica: uma união monotônica
   * *"nunca removeria uma tool que perdeu permissão entre turnos"*. É recusa
   * deliberada de acumular, não lacuna — então acumular aqui só é legítimo
   * carregando junto a obrigação que ele estava cumprindo:
   *
   * `conscientes` é o catálogo PERMITIDO agora dos providers que carregaram
   * neste turno (PROTOCOL §7). Para esses providers, item acumulado que não
   * aparece mais na lista **sai** — perdeu permissão. Provider que não carregou
   * neste turno é mantido intacto: não há sinal novo sobre ele.
   *
   * Perda de permissão é a ÚNICA remoção possível, e a única coisa que remove
   * do meio da lista. Quebra o cache dali para baixo, e é correto que quebre.
   *
   * @param {EntradaDaAcumulacao} input
   * @returns {ResultadoDaAcumulacao}
   */
  function acumular(input) {
    const permitidas = new Set(input.conscientes.map(refDaTool))
    const revalidados = new Set(input.providersCarregados)
    const prioridadeDeclarada = input.prioridadeDeclarada ?? new Map()
    /** @type {string[]} */
    const entraram = []
    /** @type {string[]} */
    const sairam = []

    // Cópia rasa por nível — as listas são reescritas abaixo, os itens não.
    /** @type {CapacidadeAcumulada[]} */
    const capacidades = input.anterior.capacidades.map(c => ({
      ...c,
      funcoes: c.funcoes.filter(f => {
        // Revalidação de permissão: só mexe em quem carregou NESTE turno.
        // Provider que não carregou não teve sinal novo — fica intacto.
        if (!revalidados.has(c.id)) return true
        if (permitidas.has(f.ref)) return true
        sairam.push(f.ref)
        return false
      }),
    })).filter(c => c.funcoes.length > 0 || c.descricao)

    // Diário (spec 2026-10-15): o que já foi escrito NÃO é reescrito — entradas novas vão ao fim.
    // Estado sem diário (sessão que começou antes do layout existir) ganha um diário inicial.
    /** @type {EntradaDoDiario[]} */
    const diario = input.anterior.diario
      ? [...input.anterior.diario]
      : diarioDeCapacidades(input.anterior.capacidades)
    const comCartao = new Set(diario.filter(e => e.tipo === 'capacidade').map(e => e.capId))
    /** Capacidades que ganham cartão NESTA acumulação, em ordem de criação. */
    /** @type {string[]} */
    const cartoesNovos = []
    /** O que chega depois do cartão, por capacidade (ordem de primeira ocorrência). */
    /** @type {Map<string, { descricao: string | null, funcoes: LinhaDoDiario[] }>} */
    const extras = new Map()
    /** @type {EntradaDoDiario[]} */
    const manuaisNovos = []
    /** @param {string} capId */
    const extraDe = (capId) => {
      if (!extras.has(capId)) extras.set(capId, { descricao: null, funcoes: [] })
      return /** @type {{ descricao: string | null, funcoes: LinhaDoDiario[] }} */ (extras.get(capId))
    }
    /** @param {string} capId @param {LinhaDoDiario} linha */
    const anotarLinha = (capId, linha) => {
      if (!comCartao.has(capId)) {
        if (!cartoesNovos.includes(capId)) cartoesNovos.push(capId)
        return // entra no cartão, montado no fim a partir de `cap.funcoes`
      }
      extraDe(capId).funcoes.push(linha)
    }

    /**
     * @param {string} id
     * @returns {CapacidadeAcumulada}
     */
    const acharOuCriar = (id) => {
      const existente = capacidades.find(c => c.id === id)
      // A prioridade NÃO é recalculada para quem já existe — atribuída uma
      // vez, na inserção, e o objeto é reaproveitado por referência (ver o
      // aviso em `EntradaDaAcumulacao.anterior`). É isso que persiste a
      // ordem de um turno para o outro: a mesma capacidade volta com a mesma
      // prioridade, sem depender de o host redeclará-la.
      if (existente) return existente
      // Capacidade NOVA entra no FIM da lista (append puro — nada acima dela
      // se move), mas sua POSIÇÃO NO RENDER é a prioridade: desejada (declarada
      // pelo host ou o default 500) ou, se já ocupada, o próximo inteiro livre.
      const desejada = prioridadeDeclarada.get(id) ?? PRIORIDADE_CAPACIDADE_PADRAO
      const prioridade = proximaPrioridadeLivre(desejada, capacidades)
      /** @type {CapacidadeAcumulada} */
      const nova = { id, funcoes: [], prioridade }
      capacidades.push(nova)
      return nova
    }

    // 1. Índice: vem do registry, INTEIRO (ver `EntradaDaAcumulacao.indice`).
    //    Entra completo no turno em que a capacidade carrega e não cresce mais.
    for (const item of input.indice) {
      if (typeof item.nome !== 'string' || !item.nome) {
        throw new Error(
          `item de capacidade sem \`nome\` (ref "${item.ref}"). O \`nome\` é o NOME EXPOSTO — a `
          + `string que o modelo emite na chamada. Sem ele a tag sai sem atributo e a função fica `
          + `anunciada sem forma de ser chamada.`,
        )
      }
      if (typeof item.providerId !== 'string' || !item.providerId) {
        throw new Error(
          `item de capacidade sem \`providerId\` (ref "${item.ref}"). Sem ele a capacidade sai sem `
          + `nome e todas as funções caem no mesmo bloco.`,
        )
      }
      if (typeof item.conteudo !== 'string' || !item.conteudo) {
        throw new Error(
          `item de capacidade sem \`conteudo\` (ref "${item.ref}"). O \`conteudo\` é a LINHA DE ÍNDICE `
          + `que descreve a função no prompt (vem de \`tool.indexLine\`). Sem ele a função entra no `
          + `índice sem texto nenhum, e o erro só apareceria tarde e anônimo em \`montar\`.`,
        )
      }
      const alvo = refDaTool(item.ref)
      // DIVERGÊNCIA DELIBERADA do original (ariadne/promptBuilder.ts): lá esta guarda não
      // existe, e o invariante "perda de permissão remove do prompt" dependia de o host
      // filtrar o índice — contrato que não estava escrito. Sem ela, o passo do índice
      // desfaz a revalidação acima em silêncio, e `sairam` nem registra. Entre falhar
      // silenciosamente correto e silenciosamente inseguro, correto ganha.
      if (revalidados.has(item.providerId) && !permitidas.has(alvo)) continue
      const cap = acharOuCriar(item.providerId)
      if (cap.funcoes.some(f => f.ref === alvo)) continue
      cap.funcoes.push({ ref: alvo, nome: item.nome, indice: item.conteudo })
      anotarLinha(cap.id, { ref: alvo, nome: item.nome, indice: item.conteudo })
      entraram.push(item.ref)
    }

    // 2. Manuais: chegam um a um, conforme o discover hidrata. Preenchem a
    //    função que já está no índice; nunca reescrevem um manual existente —
    //    o texto é determinístico e reescrever trocaria bytes já cacheados.
    /** @type {Block[]} */
    const efemeros = []
    for (const bloco of input.turno) {
      if (classificar(bloco.ref) !== 'contrato') { efemeros.push(bloco); continue }
      const cap = acharOuCriar(providerDaRef(bloco.ref))
      const funcao = cap.funcoes.find(f => f.ref === bloco.ref)
      if (funcao) {
        if (funcao.manual) continue
        // CÓPIA, não escrita em lugar: o objeto da função é compartilhado com `anterior` (a cópia
        // das capacidades acima é rasa). Escrever em lugar vazava o manual para o estado anterior —
        // e um turno que falha DEPOIS do `acumular` (provider relança, guarda de resposta vazia)
        // deixa o turno seguinte partir desse estado: o manual já "existia", caía no `continue`
        // acima e nunca ganhava entrada no diário (revisão de 2026-10-15, achado 1).
        cap.funcoes[cap.funcoes.indexOf(funcao)] = { ...funcao, manual: bloco.content }
      } else {
        // Hidratou sem estar no índice (o discover pode trazer uma tool cujo
        // provider não carregou neste turno). Entra com as duas metades: sem a
        // linha de índice ela não teria como ser listada.
        cap.funcoes.push({ ref: bloco.ref, nome: bloco.label, indice: bloco.label, manual: bloco.content })
        anotarLinha(cap.id, { ref: bloco.ref, nome: bloco.label, indice: bloco.label })
      }
      manuaisNovos.push({ tipo: 'manual', capId: cap.id, ref: bloco.ref, nome: funcao?.nome ?? bloco.label, texto: bloco.content })
      entraram.push(bloco.ref)
    }

    // 3. Contribuições — informação, não capacidade. Vêm nos blocos `system:*`
    //    que não são índice: a `instructions` de um provider e as contribuições
    //    que a arbitragem mandou para o system. Separadas pelos TRÊS níveis,
    //    porque cada um pousa num lugar diferente do prompt.
    /** @type {Record<NivelDeContribuicao, ContribuicaoAcumulada[]>} */
    const niveis = {
      fixas: [...input.anterior.fixas],
      estaveis: [...input.anterior.estaveis],
      dinamicas: [...input.anterior.dinamicas],
    }
    const contribuicoesAnteriores = new Map(
      (['fixas', 'estaveis', 'dinamicas']).flatMap(nivel =>
        input.anterior[nivel].map(contribuicao => [
          contribuicao.ref,
          `${nivel}\u0000${contribuicao.prioridade}\u0000${contribuicao.conteudo}`,
        ]),
      ),
    )
    const refsParaRemover = new Set(input.remover)
    if (refsParaRemover.size) {
      for (const lista of Object.values(niveis)) {
        for (let i = lista.length - 1; i >= 0; i--) {
          if (!refsParaRemover.has(lista[i].ref)) continue
          sairam.push(lista[i].ref)
          lista.splice(i, 1)
        }
      }
    }
    for (const bloco of input.system) {
      // Blocos `#index` são ignorados de propósito: o índice já veio completo
      // acima, e reaproveitá-los reintroduziria a entrada atrasada.
      if (classificar(bloco.ref) === 'indice') continue

      // `instructions` é do PROVIDER — descreve a capacidade, então mora nela.
      if (classificar(bloco.ref) === 'instrucoes') {
        const cap = acharOuCriar(providerDaRef(bloco.ref))
        if (cap.descricao) continue
        cap.descricao = bloco.content
        if (comCartao.has(cap.id)) extraDe(cap.id).descricao = bloco.content
        else if (!cartoesNovos.includes(cap.id)) cartoesNovos.push(cap.id)
        entraram.push(bloco.ref)
        continue
      }

      const nivel = nivelDoBloco(bloco.destination)
      const lista = niveis[nivel]

      // Uma contribuição pode MUDAR DE NÍVEL entre turnos (a fonte reclassifica).
      // Sem tirá-la do nível antigo, ela apareceria duas vezes no prompt.
      for (const outro of ['fixas', 'estaveis', 'dinamicas']) {
        if (outro === nivel) continue
        const i = niveis[outro].findIndex(c => c.ref === bloco.ref)
        if (i >= 0) niveis[outro].splice(i, 1)
      }

      const existente = lista.find(c => c.ref === bloco.ref)
      if (existente) {
        // A regra OPOSTA à das capacidades: a mesma ref com conteúdo novo
        // SUBSTITUI. A tela troca, o catálogo de entidades ganha uma linha —
        // ignorar seria congelar o prompt num estado que não existe mais.
        if (existente.conteudo === bloco.content && existente.prioridade === bloco.priority) continue
        existente.conteudo = bloco.content
        existente.prioridade = bloco.priority
        entraram.push(bloco.ref)
        continue
      }

      // A posição das capacidades é ocupada — elas disputam a mesma faixa. Uma
      // contribuição ali empataria com o bloco inteiro de manuais, e a ordem
      // entre os dois ficaria indefinida.
      if (nivel === 'estaveis' && bloco.priority === prioridadeDasCapacidades) {
        throw new Error(
          `a contribuição "${bloco.ref}" usa a prioridade ${bloco.priority}, que é a do bloco `
          + `de capacidades. Escolha abaixo (mais estável que uma capacidade — vale para `
          + `conteúdo GRANDE, como um anexo) ou acima (menos estável, o caso comum).`,
        )
      }

      // Prioridade ÚNICA dentro do nível, cobrada aqui. Com empate, o
      // desempate cairia na ref alfabética — e aí uma contribuição nova
      // poderia pousar no MEIO do bloco, deslocando as de baixo sem ninguém
      // ter pedido. Com prioridade explícita, quem declara a contribuição
      // escolhe a posição, e ela é estável para sempre.
      const colisao = lista.find(c => c.prioridade === bloco.priority)
      if (colisao) {
        throw new Error(
          `duas contribuições "${nivel}" com a mesma prioridade (${bloco.priority}): `
          + `"${colisao.ref}" e "${bloco.ref}". A prioridade decide a POSIÇÃO no prompt, `
          + `e duas iguais deixariam a ordem na mão do desempate alfabético — uma contribuição `
          + `nova entraria no meio do bloco e invalidaria o cache de tudo abaixo. `
          + `Dê prioridades distintas na declaração de cada contribuição do mesmo nível.`,
        )
      }
      lista.push({ ref: bloco.ref, prioridade: bloco.priority, conteudo: bloco.content })
      entraram.push(bloco.ref)
    }

    for (const lista of Object.values(niveis)) lista.sort((a, b) => a.prioridade - b.prioridade)

    // O rastro é uma mudança LÍQUIDA: uma ref retirada para ser reconstruída
    // no mesmo turno continua presente e não pode parecer uma saída (sobretudo
    // para capacidades revalidadas e reintroduzidas no índice atual).
    const refsAtuais = new Set([
      ...capacidades.flatMap(capacidade => capacidade.funcoes.map(funcao => funcao.ref)),
      ...Object.values(niveis).flatMap(lista => lista.map(contribuicao => contribuicao.ref)),
    ])
    const sairamLiquidas = sairam.filter((ref, indice) => !refsAtuais.has(ref) && sairam.indexOf(ref) === indice)
    const contribuicoesAtuais = new Map(
      (['fixas', 'estaveis', 'dinamicas']).flatMap(nivel =>
        niveis[nivel].map(contribuicao => [
          contribuicao.ref,
          `${nivel}\u0000${contribuicao.prioridade}\u0000${contribuicao.conteudo}`,
        ]),
      ),
    )
    const entraramLiquidas = entraram.filter(ref => {
      const atual = contribuicoesAtuais.get(ref)
      return atual === undefined || contribuicoesAnteriores.get(ref) !== atual
    })

    // Fecha o diário desta acumulação, sempre no FIM: cartões novos (ordem de criação), o que chegou
    // para capacidade que já tinha cartão, e os manuais (ordem dos blocos do turno). O cartão é
    // fotografado agora — descrição e linhas que chegaram junto —, e nunca mais muda.
    // Cartões novos da MESMA acumulação em ordem de prioridade (o piso primeiro): continua sendo
    // acréscimo ao fim, e deixa o 1º turno determinístico — a ordem de `conscious` acompanha o
    // ranking do pedido, e um 1º turno estável é o que se reaproveita entre sessões.
    const prioridadeDe = (id) => capacidades.find(c => c.id === id)?.prioridade ?? Infinity
    cartoesNovos.sort((a, b) => prioridadeDe(a) - prioridadeDe(b))
    for (const capId of cartoesNovos) {
      const cap = capacidades.find(c => c.id === capId)
      if (!cap) continue
      diario.push({
        tipo: 'capacidade',
        capId,
        descricao: cap.descricao ?? null,
        funcoes: cap.funcoes.map(f => ({ ref: f.ref, nome: f.nome, indice: f.indice })),
      })
    }
    for (const [capId, extra] of extras) {
      if (extra.descricao === null && extra.funcoes.length === 0) continue
      diario.push({ tipo: 'extra', capId, descricao: extra.descricao, funcoes: extra.funcoes })
    }
    diario.push(...manuaisNovos)
    // Defesa: toda função chamável (com manual) tem o manual escrito no diário. Cobre estado que
    // chegou com manual sem entrada (ex.: estado de antes desta correção, ou montado por fora).
    const comEntradaDeManual = new Set(diario.filter(e => e.tipo === 'manual').map(e => e.ref))
    for (const cap of capacidades) {
      for (const f of cap.funcoes) {
        if (f.manual && !comEntradaDeManual.has(f.ref)) {
          diario.push({ tipo: 'manual', capId: cap.id, ref: f.ref, nome: f.nome, texto: f.manual })
          comEntradaDeManual.add(f.ref)
        }
      }
    }

    return { system: { capacidades, ...niveis, diario }, efemeros, entraram: entraramLiquidas, sairam: sairamLiquidas }
  }

  /**
   * Uma entrada do diário, só a partir do conteúdo dela. `presentes` são as refs de função que
   * ainda existem no acumulado: perda de permissão tira a linha/o manual (e invalida o cache dali
   * para baixo — a única exceção aceita ao append-only, como no layout agrupado).
   *
   * @param {EntradaDoDiario} entrada
   * @param {Set<string>} presentes
   * @param {{ linhas: Set<string>, manuais: Set<string> }} vistos refs já escritas antes nesta montagem — uma
   *   função que perdeu e recuperou a permissão reaparece numa entrada nova; a primeira ocorrência vale.
   * @returns {string}
   */
  function renderizarEntradaDoDiario(entrada, presentes, vistos) {
    if (entrada.tipo === 'manual') {
      if (!presentes.has(entrada.ref) || vistos.manuais.has(entrada.ref)) return ''
      vistos.manuais.add(entrada.ref)
      return tag(nomes.item, { name: entrada.nome, capability: entrada.capId }, entrada.texto)
    }
    const linhas = entrada.funcoes
      .filter(f => presentes.has(f.ref) && !vistos.linhas.has(f.ref))
      .map(f => { vistos.linhas.add(f.ref); return `- ${f.nome} — ${f.indice}` })
    /** @type {string[]} */
    const partes = []
    if (entrada.descricao) partes.push(entrada.descricao.trim())
    if (linhas.length > 0) partes.push(tag(nomes.indice, {}, linhas.join('\n')))
    if (partes.length === 0) return ''
    const nomeDaTag = entrada.tipo === 'capacidade' ? nomes.capacidade : nomes.capacidadeExtra
    return tag(nomeDaTag, { name: entrada.capId }, partes.join('\n\n'))
  }

  /**
   * Uma capacidade no layout `lista-fixa`: descrição, a lista de TODAS as funções (fixa — a ordem é a
   * de chegada no índice e nenhuma linha muda quando a função carrega) e, logo abaixo, os manuais das
   * carregadas na ordem de carga (a do diário). Carregar uma função só ACRESCENTA ao fim deste grupo:
   * o que vem antes dentro da capacidade — e as capacidades acima — ficam byte a byte iguais.
   *
   * @param {CapacidadeAcumulada} cap
   * @param {EntradaDoDiario[]} diario
   * @returns {string}
   */
  function renderizarCapacidadeListaFixa(cap, diario) {
    /** @type {string[]} */
    const partes = []
    if (cap.descricao) partes.push(cap.descricao.trim())
    if (cap.funcoes.length > 0) {
      partes.push(tag(nomes.indice, {}, cap.funcoes.map(f => `- ${f.nome} — ${f.indice}`).join('\n')))
    }
    const porRef = new Map(cap.funcoes.filter(f => f.manual).map(f => [f.ref, f]))
    /** @type {FuncaoAcumulada[]} */
    const emOrdem = []
    for (const e of diario) {
      if (e.tipo !== 'manual' || e.capId !== cap.id) continue
      const f = porRef.get(e.ref)
      if (!f) continue
      emOrdem.push(f)
      porRef.delete(e.ref)
    }
    // Defesa: manual sem entrada no diário (estado montado por fora) vai ao fim, nunca some.
    emOrdem.push(...porRef.values())
    if (emOrdem.length > 0) {
      partes.push([
        ROTULO_FUNCOES_CARREGADAS,
        '',
        emOrdem.map(f => tag(nomes.item, { name: f.nome }, /** @type {string} */ (f.manual))).join('\n\n'),
      ].join('\n'))
    }
    return tag(nomes.capacidade, { name: cap.id }, partes.join('\n\n'))
  }

  /**
   * O conteúdo do bloco de capacidades no layout `diario`: legenda + entradas em ordem de chegada.
   * @param {SystemAcumulado} acumulado
   * @returns {string}
   */
  function conteudoDoDiario(acumulado) {
    const presentes = new Set(acumulado.capacidades.flatMap(c => c.funcoes.map(f => f.ref)))
    const diario = acumulado.diario ?? diarioDeCapacidades(acumulado.capacidades)
    const vistos = { linhas: new Set(), manuais: new Set() }
    const entradas = diario.map(e => renderizarEntradaDoDiario(e, presentes, vistos)).filter(Boolean)
    return tag(nomes.capacidades, {}, [
      ...(legendas.capacidadesDiario ? [legendas.capacidadesDiario, ''] : []),
      entradas.join('\n\n'),
    ].join('\n'))
  }

  /**
   * Uma capacidade como bloco fechado: descrição + funções em DOIS grupos, sem
   * repetição — disponíveis (com manual, chamáveis já) e carregáveis (só nome
   * e o que fazem). Antes de 2026-09-18 toda função hidratada aparecia duas
   * vezes (índice + manual); medido num prompt real: 7,6% do system inteiro
   * era função duplicada, e 20% dos índices eram só andaime de tag repetida
   * sem informação nova. Fundir os dois grupos numa seção só (`nomes.indice`,
   * o `<functions>`) elimina as duas.
   *
   * @param {CapacidadeAcumulada} cap
   * @returns {string}
   */
  function renderizarCapacidade(cap) {
    /** @type {string[]} */
    const partes = []
    if (cap.descricao) partes.push(cap.descricao.trim())

    const disponiveis = cap.funcoes.filter(f => f.manual)
    const carregaveis = cap.funcoes.filter(f => !f.manual)

    /** @type {string[]} */
    const grupos = []
    // Disponíveis primeiro: é o que o modelo pode chamar JÁ. Carregáveis
    // depois — precisam de um passo a mais (`load_capability`) antes de
    // poderem ser chamados.
    if (disponiveis.length > 0) {
      // Manual completo, multiparágrafo — precisa da tag para delimitar onde
      // uma função acaba e a próxima começa. Sem rótulo acima: ver o
      // comentário de ROTULO_FUNCOES_CARREGAVEIS.
      grupos.push(disponiveis.map(f => tag(nomes.item, { [atributoDoManual]: f.nome }, f.manual)).join('\n\n'))
    }
    if (carregaveis.length > 0) {
      grupos.push([
        ROTULO_FUNCOES_CARREGAVEIS,
        '',
        // Sem tag: uma linha só (nome + o que faz), o andaime de abrir/fechar
        // `<function>` não paga o preço numa linha que não tem mais nada
        // dentro. `f.indice` já vem sem o nome duplicado — ver `linhasDeIndice`
        // em index.js, que tira o prefixo `${key} — ` do `indexLine` do kairos.
        carregaveis.map(f => `- ${f.nome} — ${f.indice}`).join('\n'),
      ].join('\n'))
    }

    // Grupo vazio não emite rótulo — e capacidade sem NENHUMA função (só
    // descrição, ex.: `instructions` sozinha) não emite `<functions>` vazio.
    if (grupos.length > 0) {
      partes.push(tag(
        nomes.indice,
        {},
        [
          ...(legendas.indice ? [legendas.indice, ''] : []),
          grupos.join('\n\n'),
        ].join('\n'),
      ))
    }
    return tag(nomes.capacidade, { name: cap.id }, partes.join('\n\n'))
  }

  /**
   * @param {string} nome
   * @param {ContribuicaoAcumulada[]} itens
   * @returns {SecaoDoPrompt | null}
   */
  function secaoDeContribuicoes(nome, itens) {
    if (itens.length === 0) return null
    return {
      nome,
      destino: 'system',
      conteudo: tag(nome, {}, itens.map(c => tag('info', { source: c.ref }, c.conteudo)).join('\n\n')),
    }
  }

  /**
   * @param {TContexto} contexto
   * @param {SystemAcumulado} acumulado
   * @returns {SecaoDoPrompt[]}
   */
  function secoesDoSystem(contexto, acumulado) {
    /** @type {SecaoDoPrompt[]} */
    const secoes = config.base(contexto)
      .map(s => ({ nome: s.nome, destino: 'system', conteudo: s.conteudo }))

    // Ordem por volatilidade crescente. Cada bloco só pode ser invalidado pelo
    // que está ACIMA dele, então o que muda menos fica mais no topo.

    // 1. Fixas — não mudam dentro da janela de cache.
    const fixas = secaoDeContribuicoes(nomes.fixas, acumulado.fixas)
    if (fixas) secoes.push(fixas)

    // 2. A faixa ESTÁVEL, ordenada por prioridade — e as capacidades são um
    //    item DELA, não um bloco à parte. É o que abre as 49 posições anteriores
    //    para o que é mais estável que uma capacidade: um anexo grande entra em
    //    10, paga o cache uma vez, e nenhuma capacidade nova o invalida.
    const instrucoesDeCapacidades = mecanicaNoCatalogo ? (contexto.__instrucoesDeCapacidades || '') : ''
    const blocoDeCapacidades = acumulado.capacidades.length > 0 || instrucoesDeCapacidades
      ? {
        prioridade: prioridadeDasCapacidades,
        secao: {
          nome: nomes.capacidades,
          destino: 'system',
          // A legenda do bloco vem ANTES das capacidades e entra UMA vez — não
          // por capacidade, como `indice`. É conteúdo fixo, então pousa no
          // topo da faixa estável junto com o bloco e não invalida nada
          // quando uma capacidade nova entra depois dela.
          conteudo: layoutDasCapacidades === 'diario'
            // Diário: ordem de chegada, entradas congeladas — o que entra vai ao fim e o que já
            // foi enviado fica byte a byte igual (spec 2026-10-15). Prioridade não reordena aqui.
            ? conteudoDoDiario(acumulado)
            : layoutDasCapacidades === 'lista-fixa'
            // Lista fixa (decisão do dono, 2026-10-15): bloco fechado por capacidade, na ordem de
            // prioridade (o host põe as que mudam menos primeiro), manuais junto da capacidade.
            ? tag(nomes.capacidades, {}, [
              ...(legendas.capacidadesListaFixa ? [legendas.capacidadesListaFixa, ''] : []),
              [...acumulado.capacidades]
                .sort((a, b) => a.prioridade - b.prioridade)
                .map(c => renderizarCapacidadeListaFixa(c, acumulado.diario ?? []))
                .join('\n\n'),
            ].join('\n'))
            : tag(nomes.capacidades, {}, [
              ...(legendas.capacidades ? [legendas.capacidades, ''] : []),
              ...(instrucoesDeCapacidades ? [instrucoesDeCapacidades, ''] : []),
              // Ordenado por `prioridade`, não pela ordem de `push` em
              // `acharOuCriar` (append puro) — `sort` é ESTÁVEL, então em caso de
              // empate (não deveria acontecer: `proximaPrioridadeLivre` garante
              // unicidade) o desempate cai na ordem de chegada mesmo assim.
              [...acumulado.capacidades]
                .sort((a, b) => a.prioridade - b.prioridade)
                .map(renderizarCapacidade)
                .join('\n\n')
            ].join('\n')),
        },
      }
      : null

    // Cada contribuição vira uma seção própria, e não um bloco agrupado: o
    // agrupamento impediria as capacidades de pousar NO MEIO delas.
    const naFaixa = [
      ...acumulado.estaveis.map(c => ({
        prioridade: c.prioridade,
        secao: {
          // Prefixo de nome de SEÇÃO (não de tag XML — este nome nunca é
          // impresso no prompt, é só a chave que `secoes[]` usa para o rastro
          // achar de volta uma contribuição específica). Consumido fora da
          // fábrica em DOIS lugares que precisam mudar junto com este prefixo
          // — `orquestrador/v2/executarTurno.ts` e
          // `dev-host/src/components/OrquestradorChat.tsx` — grep por
          // `'info:'` antes de renomear de novo.
          nome: `info:${c.ref}`,
          destino: 'system',
          conteudo: tag('info', { source: c.ref }, c.conteudo),
        },
      })),
      ...(blocoDeCapacidades ? [blocoDeCapacidades] : []),
    ].sort((a, b) => a.prioridade - b.prioridade)

    secoes.push(...naFaixa.map(x => x.secao))

    // 3. Dinâmicas — por último no system, encostadas no histórico. Ainda estão
    //    ANTES dele, então mudar aqui derruba o histórico inteiro: é por isso
    //    que este nível deve tender a vazio.
    const dinamicas = secaoDeContribuicoes(nomes.dinamicas, acumulado.dinamicas)
    if (dinamicas) secoes.push(dinamicas)

    return secoes
  }

  /**
   * @param {Block[]} blocos
   * @returns {SecaoDoPrompt[]}
   */
  function secoesEfemeras(blocos) {
    /** @type {Map<Classe, Block[]>} */
    const porClasse = new Map()
    for (const bloco of blocos) {
      const classe = classificar(bloco.ref)
      const lista = porClasse.get(classe)
      if (lista) lista.push(bloco)
      else porClasse.set(classe, [bloco])
    }

    /** @type {SecaoDoPrompt[]} */
    const secoes = []
    for (const classe of ordemEfemera) {
      const lista = porClasse.get(classe)
      if (!lista || lista.length === 0) continue
      const molde = moldeEfemero[classe]
      const itens = lista.map(b => (
        molde.item
          ? tag(molde.item, {
            [molde.atributo ?? 'ref']: classe === 'card' ? providerDaRef(b.ref) : b.ref,
          }, b.content)
          : b.content.trim()
      ))
      const corpo = [...(molde.legenda ? [molde.legenda, ''] : []), itens.join('\n\n')].join('\n')
      secoes.push({ nome: molde.secao, destino: 'turno', conteudo: tag(molde.secao, {}, corpo) })
    }
    return secoes
  }

  /**
   * @param {EntradaDaMontagem<TContexto>} entrada
   * @returns {PayloadDoTurno}
   */
  function montar(entrada) {
    const secoesSystem = secoesDoSystem(entrada.contexto, entrada.system)
    const secoesTurno = secoesEfemeras(entrada.efemeros)
    const extras = (entrada.extrasDoTurno ?? []).filter((x) => x && x.conteudo)

    const system = secoesSystem.map(s => s.conteudo).join('\n\n')
    // O texto do usuário fecha a mensagem, sem moldura, para o pedido não
    // parecer mais um bloco de contexto entre outros. O efêmero é dobrado só
    // AQUI, na mensagem deste turno — o que for para o histórico é o texto cru.
    // O bloco de anexos vem ANTES do texto do usuário e depois dos efêmeros: é
    // contexto do pedido, e o pedido continua sendo a última coisa que o modelo
    // lê (recência). Sem o bloco, as imagens chegariam anônimas — o `label` de
    // `MessageImage` não é enviado por provider nenhum.
    const anexos = entrada.anexos
    const mensagemDoTurno = [
      ...secoesTurno.map(s => s.conteudo),
      ...extras.map(x => x.conteudo),
      ...(anexos?.bloco ? [anexos.bloco] : []),
      ...(entrada.preHidratacao ? [entrada.preHidratacao] : []),
      entrada.texto,
    ].join('\n\n')

    return {
      mensagens: [
        { id: 'sys', role: 'developer', content: system },
        ...entrada.historico,
        {
          id: 'usr', role: 'user', content: mensagemDoTurno,
          ...(anexos?.imagens?.length ? { images: anexos.imagens } : {}),
        },
        // Correção A: o rastro do Jev (quando houver) entra AQUI — depois do pedido deste
        // turno, nunca junto de `historico` (turnos anteriores). Ver JSDoc de
        // `EntradaDaMontagem.aposOPedido`.
        ...(entrada.aposOPedido ?? []),
      ],
      system,
      mensagemDoTurno,
      secoes: [
        ...secoesSystem,
        ...secoesTurno,
        ...extras.map(x => ({ nome: x.nome, destino: 'turno', conteudo: x.conteudo })),
        ...(anexos?.bloco ? [{ nome: 'anexos', destino: 'turno', conteudo: anexos.bloco }] : []),
        ...(entrada.preHidratacao ? [{ nome: 'pre_hidratacao', destino: 'turno', conteudo: entrada.preHidratacao }] : []),
        { nome: 'pedido_do_usuario', destino: 'turno', conteudo: entrada.texto },
      ],
    }
  }

  /**
   * @param {OperacaoDoTurno[]} operacoes
   * @returns {string}
   */
  function blocoDeOperacoes(operacoes) {
    if (operacoes.length === 0) return ''
    const linhas = operacoes.map(op => {
      const args = Object.entries(op.args ?? {})
        .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
        .join(', ')
      const cabeca = mecanicaNoCatalogo
        ? `Operação executada | referência: ${op.nome} | argumentos: {${args}} | resultado: ${op.ok ? 'ok' : 'erro'}`
        : `${op.nome} {${args}} → ${op.ok ? 'ok' : 'erro'}`
      return op.ok || !op.erro ? cabeca : `${cabeca}\n   ${op.erro}`
    })
    return tag(nomes.operacoes, {}, linhas.join('\n'))
  }

  /**
   * O system exato que `montar` produziria para este acumulado — usado pela conta do despejo.
   * @param {TContexto} contexto o MESMO contexto que será passado a `montar` (inclui `__secoesExtra`, se houver)
   * @param {SystemAcumulado} system
   * @returns {string}
   */
  function renderizarSystem(contexto, system) {
    return secoesDoSystem(contexto, system).map(s => s.conteudo).join('\n\n')
  }

  /** Remove blocos de operações imitados, com o nome EFETIVO da tag (o mesmo de `blocoDeOperacoes`). */
  const removerOperacoes = (texto) => removerBlocosDeOperacoes(texto, nomes.operacoes)
  return { acumular, montar, blocoDeOperacoes, removerOperacoes, renderizarSystem }
}

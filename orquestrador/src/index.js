// criarOrquestrador — o conector.
//
// Ela liga quatro peças que existem sozinhas: o @okds/kairos (quais capacidades
// importam), o prompt-builder (onde cada uma pousa e por quanto tempo fica), a
// estratégia de protocolo (como a chamada é expressa) e o genos (o loop).
//
// Ela NÃO sabe o que é shadow, agente de banco ou Igris: quem sabe é o perfil
// que a instancia. E ela NÃO faz budget, cancelamento, behaviors, delivery nem
// contabilidade — isso é do consumidor, e entra por `decorarTool`.
import { randomUUID } from 'node:crypto';
import { createOrchestrator, InMemoryRunStore, ToolRegistry } from 'genos-orchestrator';
import { createManager, isTrivial } from '@okds/kairos/resolve';
import { centeredStrategy } from '@okds/kairos/index/similarity';
import { applySessionPolicy, initialSessionState } from '@okds/kairos/session';
import { assemble, groupBlocks } from '@okds/kairos/assemble';
import { criarConstrutorDePrompt, systemVazio, classificar } from './prompt-builder.js';
// Cauda efêmera e despejo (spec 2026-10-29): módulos puros em ./despejo/. Tudo atrás de dois interruptores
// (`config.despejo.cauda` / `.despejo`) que entram DESLIGADOS — desligado, o turno é byte a byte o de antes.
import { normalizarDespejo, parametrosDoModelo } from './despejo/config.js';
import { separarCauda, renderizarCauda, nomesDaCauda } from './despejo/cauda.js';
import { estadoDespejoVazio, exigeSinalForte, descartaveis, registrarDescarte } from './despejo/registro-de-uso.js';
import { criarSinalForte, sobeJuntoNaEntrada, protecaoDoDespejo, ehContinuacaoCurta, caudaDoTurnoComHerdada, usadasDoTurno, fecharTurnoDoDespejo } from './despejo/costura.js';
import { despejar } from './despejo/despejar.js';
import { horizonte, decidirDespejo } from './despejo/conta.js';
import { avisoDeDescartadas } from './despejo/aviso.js';
import { separarPreparadas, conteudoDaHabilidadeSugerida, ofertaDoTurno, saidaDoComportamento, notaDeNaoFixadas } from './despejo/comportamento.js';
import { montarProviders, toolsExpostas, sinonimosCrus, tudoPiso, nomeExposto } from './capacidades.js';
import { resolverProtocolo } from './protocolo/index.js';
import { espacoDoLoop, entregaDoLoop, capacidadesDoLoop, falhaDoResultado, refsAcompanhantes, refsDaIntencao } from './loop-do-turno.js';
import { montarContextoDeMemorias } from './memoria-do-loop.js';
// B3.3 fase 2: a pista de contexto vira consulta do RANKING deste turno. `criarPonteDoTurno`
// também é dona da FACHADA que publica a seleção (C3P) — ela saiu do catálogo para cá
// porque as `hints` são do pedido, não do processo (ver o bloco da ponte em `executarTurno`).
import { criarPonteDoTurno, prepararPistaDeRanking } from './pista-contexto.js';
import { envolverEmbedderComCache, limparCacheDeEmbeddingsDoProcesso, limiaresEmCache } from './cache-catalogo.js';
import { contentHash } from '@okds/kairos/core/hash';
import { exemplosDasCapacidades, calibrarLimiares } from './calibracao.js';
import { envolverEmbedderComDisco } from './cache-exemplos.js';
import { criarCacheSemantica } from './cache-semantica.js';
import { cacheDoCatalogoEmDisco, limparCacheDoCatalogoEmDisco } from './cache-catalogo-disco.js';
import { formatarMensagensIntraTurno } from './mensagem-intra-turno.js';
import { AVISO_PERTO_DO_PRAZO } from './protocolo/perto-do-teto.js';

// Quanto antes do prazo de tempo da mensagem o aviso entra: um passo longo (render) leva minutos.
const AVISO_DE_PRAZO_ANTES_MS = 4 * 60_000;
const ID_AVISO_DE_PRAZO = 'aviso-de-prazo';

/**
 * @typedef {object} ConfigDoOrquestrador
 * @property {(ctx: any) => Array<{nome: string, conteudo: string}>} base seções fixas do system
 * @property {import('./capacidades.js').CapacidadeDeclarada[]} capacidades
 * @property {Array<import('@okds/kairos/core/types').Contribution & { volatil?: boolean }>} [contribuicoes]
 *   Contribuição que o agente precisa SABER, não CHAMAR — a metade do modelo
 *   de contribuição do kairos que a fábrica não tinha caminho nenhum para
 *   receber. `floor` decide o DESTINO, e os dois são caminhos de primeira
 *   classe: `floor: true` é PISO (sempre presente, registrada num provider
 *   próprio `always` — ver `montarCatalogo`); `floor: false` é SEMÂNTICA
 *   (entra por relevância, a cada turno, pelo canal `conversation` do kairos
 *   — ver `executarTurno`). A fábrica só decide o roteamento; `destination` e
 *   `priority` continuam decisão de cada contribuição.
 *
 *   ⚠️ **`floor` declarado como boolean é OBRIGATÓRIO e é COBRADO** —
 *   `montarCatalogo` recusa a montagem, nomeando o `ref`, quando uma
 *   contribuição não declara `floor: true` NEM `floor: false` (ausente, ou
 *   qualquer coisa que não seja exatamente um dos dois — ex.: `1`, `"sim"`).
 *   Isto NÃO é a mesma trava de antes: até esta mudança, só `floor: true`
 *   passava — `floor: false` era recusado junto da omissão, porque o kairos
 *   não tinha canal nenhum para uma contribuição que não é piso, e
 *   `floor: false` ACEITO e IGNORADO EM SILÊNCIO foi o defeito medido que
 *   fez a trava nascer. Agora `floor: false` tem destino real (o canal
 *   `conversation`), então proibi-lo virou obstáculo — mas a propriedade que
 *   a trava original protegia (o esquecimento não passa) continua: omitir o
 *   campo, ou escrever algo truthy/falsy que não é o boolean exato, segue
 *   recusado, porque a fábrica não tem como saber se foi PISO ou SEMÂNTICA
 *   que o host quis dizer.
 *
 *   🚨 **Contribuição semântica (`floor: false`) exige `ref` de TRÊS
 *   partes** (`<origem>/<kind>/<chave>`, dois `/`) — é a convenção que o
 *   `ConversationItem` do kairos exige; um `ref` fora do formato é item
 *   REJEITADO EM SILÊNCIO pelo kairos (só um rastro no explain, nunca
 *   throw), e sem esta trava aqui o host acreditaria ter entregue conteúdo
 *   que nunca chegou ao prompt. `montarCatalogo` recusa a montagem, nomeando
 *   o `ref`, antes de o turno rodar.
 *
 *   **`volatil` é obrigatório quando `floor: true`**, e é campo DA FÁBRICA
 *   (removido antes de registrar no kairos). `true` = o `read(ctx)` produz
 *   valor diferente a cada turno e precisa ser RECALCULADO quando o discover é
 *   pulado por texto trivial; `false` = uma vez no prompt, fica lá.
 *
 *   Por que obrigatório e por que aqui: `refsVolateis` (abaixo) é uma lista
 *   PARALELA, declarada longe da contribuição — a forma que permite esquecer.
 *   A V2 do Ariadne esqueceu: `decisionsFloor` e `projectStatus` mudam dentro
 *   da conversa e não foram declarados, e o supervisor lia um piso congelado
 *   sem nenhum sinal. Declarar no ponto da declaração torna o esquecimento
 *   impossível; declarar `false` é resposta válida, o silêncio é que não é.
 *
 *   **`volatil` NÃO é exigido quando `floor: false`** — uma contribuição
 *   semântica é reavaliada pelo discover a cada turno por natureza (é o
 *   próprio canal de conversa que decide se ela entra), então cobrar
 *   `volatil` dela seria exigir resposta para uma pergunta que não se faz.
 *   Se o host declarar `volatil` mesmo assim (ex.: reaproveitando um objeto
 *   que também serve de piso em outro perfil), a fábrica aceita e IGNORA —
 *   não vale quebrar o host por um campo a mais que não muda nada aqui.
 * @property {(ctx: any) => string[]} [refsVolateis] Refs de CONTRIBUIÇÃO (não de tool) cujo
 *   `read(ctx)` produz um valor diferente a cada turno (ex.: lê a tela aberta, um contador). São
 *   as que precisam ser RECALCULADAS — não só reexibidas — quando o discover é pulado por texto
 *   trivial (ver `reconstruirBlocosDoTurno`). Uma contribuição de piso cujo conteúdo não muda por
 *   turno não precisa entrar aqui: uma vez no prompt, ela fica lá (é o próprio `acumular` que a
 *   mantém).
 * @property {'envelope'|'fence'|'nativo'} protocolo
 * @property {object} [protocoloOpts] repassado à estratégia (ex.: { headless }).
 * @property {boolean} [mecanicaNoCatalogo] Default `false`. `true` = a mecânica de chamada sai do topo do system e vive no
 *   bloco de capacidades (legenda por protocolo; no nativo, `<function ref="…">` e sem seção de protocolo), e o registro
 *   de operações do turno sai em forma neutra. Veio do Ariadne (`fc2457a8`, `b7bec589`). Só com o layout `agrupado`.
 *   Em `envelope` aceita também `prefixoDoEnvelope` (string, padrão ausente): prefixo do
 *   NOME do schema de resposta enviado ao provider — sem ele `envelope`,
 *   `envelope_headless`, `envelope_contribuicoes`; com ele `<prefixo>_envelope*`. O Igris
 *   passa `'igris'` (nomes `igris_envelope*`, byte a byte como antes). Escolha uma vez por
 *   host: o nome entra na chave de cache de gramática do vendor.
 * @property {Partial<Record<'indice'|'candidatos', string>>} [legendas] Sobrescreve a
 *   legenda de uma seção do catálogo. Mescla POR CHAVE, com fallback em valor
 *   falsy: uma chave ausente, `''` ou `undefined` cai de volta no default do
 *   builder (`LEGENDAS_PADRAO`) — não há como suprimir a legenda passando
 *   vazio, porque legenda ausente foi o que deixou o catálogo mudo na V2 do
 *   Ariadne. Passe isto quando o host tiver verbo próprio de carregamento para
 *   nomear.
 * @property {object} [nomes] Nomes das tags do prompt, quando o host quiser outro vocabulário.
 * @property {'agrupado'|'diario'|'lista-fixa'} [layoutDasCapacidades] Repassado ao prompt-builder (ver
 *   `ConfiguracaoDoPrompt.layoutDasCapacidades`). Default `'agrupado'`.
 * @property {number} [prioridadeDasCapacidades] Repassado ao prompt-builder: posição do bloco de
 *   capacidades na faixa `system:stable` (default 50).
 * @property {boolean} [pisoCompletoNoTurnoTrivial] Spec 2026-10-15 (D2): no turno trivial
 *   (`unchanged`), o piso entra com a descrição (`<provider>/instructions`) e o índice de TODAS as
 *   tools dos providers `loading.always` — a mesma forma de um turno normal —, em vez de só as
 *   `pinned`. Sem isto o turno seguinte reescreve o começo do bloco de capacidades. Default false.
 * @property {(ctx?: object) => object} provider provider do genos — chamado a CADA turno com o ctx do turno (o mesmo de `executarTurno`), para o host escolher o modelo por execução. Quem ignora o argumento segue funcionando.
 * @property {(nome: string, definicao: object) => object} [decorarTool] gancho do consumidor
 * @property {object|null} [embedder] Embedder do Kairos. Três valores, três
 *   significados, e a diferença entre os dois últimos importa:
 *   - uma instância — o caso normal;
 *   - AUSENTE com capacidade semântica no catálogo — erro de programação,
 *     recusa de montagem;
 *   - `null` EXPLÍCITO — o host sabe que não tem embedder e quer o modo
 *     degradado do kairos, que ranqueia só pelo léxico (`rank-providers.js`
 *     pula o `rawFloor` quando `queryEmbedding === null`, §6.6). Monta.
 * @property {import('@okds/kairos/core/types').CanFn} [can] Gate de permissão por TOOL —
 *   assinatura `(requires: string[] | undefined, ctx: any) => boolean`, a mesma que
 *   `CreateGenosBridgeOptions.can` (`@okds/kairos/genos/bridge`) e `ConfiguracaoDoOrquestrador.can`
 *   (`src/orquestrador/motor.ts`) esperam — confirmada nos dois. Chamado a CADA discover, para
 *   cada tool candidata: `requires` vem de `ToolDeclarada.requires`/`CapacidadeDeclarada`, `ctx` é
 *   o mesmo `HostContext` do turno. Default: `() => true` — libera tudo, o comportamento de antes
 *   desta lacuna existir. Sem um `can` real, migrar um host que dependia de filtro por permissão
 *   (o orquestrador de tela do Ariadne, `criarCan()` em `src/orquestrador/can.ts`) removeria a
 *   filtragem em silêncio — é o motivo desta lacuna ser tratada como segurança, não conveniência.
 * @property {(ctx: any) => Array<object> | Promise<Array<object>>} [conversa] Itens DINÂMICOS do
 *   canal `conversation` do kairos, montados a cada TURNO a partir do `ctx` do turno (registro
 *   aberto na tela, emissão em curso — o que muda turno a turno e seria caro manter como piso
 *   permanente). A forma de cada item é `ItemDeConversa` do kairos (`ref` de TRÊS partes
 *   `<origem>/<kind>/<chave>`, `content`, e opcionais `semanticText`/`title`/`description`/
 *   `destination`/`priority`/`threshold`/`requires`/`vector` — ver
 *   `@okds/kairos/dist/resolve/conversation.d.ts`). Os itens que `conversa()` devolve SOMAM aos
 *   vindos de contribuição `floor: false` (nunca substituem); um `ref` que aparece nas duas
 *   fontes ao mesmo tempo é erro de HOST — a fábrica recusa a montagem do TURNO (não do catálogo),
 *   nomeando o `ref` duplicado, em vez de deixar uma fonte sobrescrever a outra em silêncio no
 *   `ConversationItem[]` que segue ao kairos. Um `conversa()` que LANÇA não derruba o turno: cai
 *   em `renderErrors`, mesma garantia que o `read()` de uma contribuição semântica já tem.
 * @property {(ctx: any, refs: string[]) => void} [aoIncluirConversa] Chamado uma vez por turno,
 *   depois do discover — e depois do SEGUNDO `bridge.prepareTurn` de I3a, quando ele dispara
 *   (provider dono de uma skill sugerida sem estar carregado; a promoção de `carregar` das
 *   fontes não dispara mais turno extra desde a Task 10 — entra no ESTADO do primeiro
 *   `prepareTurn`, ver `refinadores`/R10 abaixo) —, com o discover já FINAL, com as refs que de
 *   fato ENTRARAM no prompt
 *   (`discoverResult.conversation?.included ?? []`). **Não é conveniência — fecha o laço da
 *   permanência**: o canal `conversation` é stateless (nada dele toca o índice compartilhado do
 *   catálogo), então quem quiser que um item continue entrando nos turnos seguintes, depois de
 *   incluído uma vez, precisa SABER que ele entrou — é o próprio host quem decide "não descarrega"
 *   releendo essa marca no próximo `conversa(ctx)` (ex.: `threshold: 0` no item enquanto marcado).
 *   Sem este callback, um item incluído num turno some no turno seguinte mesmo que o host quisesse
 *   mantê-lo. Erro dentro do handler não derruba o turno — é callback de observação do host, mesma
 *   garantia de `aoEvento`/`aoChamada`.
 * @property {number} [maxIteracoes] default 12
 * @property {boolean} [aterrissarNoTeto] default `false`. `true`: estourar `maxIteracoes` conclui o
 *   turno com `AVISO_TETO_DE_ITERACOES` (`tetoAtingido: true`) em vez de lançar
 *   `Max iterations exceeded`. Opt-in do chat; shadows/agentes LLM precisam do erro.
 * @property {number} [limiteDeTools] default 6
 * @property {'streaming'|'json'} [outputMode] Repassado direto a
 *   `createOrchestrator({ outputMode })` do genos (`orchestrator.ts`, default 'json' LÁ —
 *   sem streaming). Sem valor aqui, vale o default do genos. `'streaming'` usa
 *   `provider.stream()` e alimenta `aoTexto` pedaço a pedaço; `'json'` usa `provider.generate()`,
 *   que entrega UM `onMessage`/`agent.output.delta` com o texto INTEIRO no fim. O chat da
 *   fábrica pede `'streaming'` no perfil (executor/.../fabrica/perfil.js); outros hosts
 *   (shadows, decisions) seguem no default. Com `provider.stream` ausente, o genos cai
 *   sozinho em `generate()` mesmo com `'streaming'`.
 * @property {(input: {assistantText: string, iteration: number}) => {retry: boolean, message?: string}} [validateTurn]
 *   Gate do host no fim de um turno sem comandos. Repassado ao hook já existente do genos;
 *   quem fornece a função limita retries e decide a correção.
 * @property {{ onEvent: (evento: object) => void|Promise<void> }} [runtimeObserver] Observador de
 *   runtime do genos (`createOrchestrator({ runtimeObserver })`): recebe os eventos NORMALIZADOS
 *   `agent.*` (`kind`, `seq`, `turnIndex`, `payload`), diferentes dos crus de `aoEvento`. Repassado
 *   sem tocar — serve às projeções de observabilidade do host (agentic-loop, run-timeline).
 * @property {object} [genos] Opções extras repassadas ao `createOrchestrator` do genos, para abrir uma
 *   opção que a fábrica não expõe. As chaves são mescladas ANTES das que a fábrica define: em
 *   conflito, a FÁBRICA vence (ela controla `provider`, `tools`, `toolProtocol`, `initialMessages`,
 *   `outputMode`, `maxIterations`, `metadata`, `formatUserMessages`, `runStore`, etc.). Chave que a
 *   fábrica só define condicionalmente (ex.: `pricingResolver`, `runtimeObserver`, `validateTurn`,
 *   `unknownToolMessage`) vale a do host quando o campo próprio da config está ausente. Default
 *   ausente (nada é repassado).
 * @property {{ estimateCostUsd: (i: { provider: string, model: string, usage?: object }) => number|null }} [pricingResolver]
 *   Repassado cru para `createOrchestrator({ pricingResolver })`: é o genos quem resolve `costUsd`
 *   de cada `provider.completed` (`response.costUsd ?? pricingResolver.estimateCostUsd(...)`). Sem
 *   este campo o custo nunca é calculado (o adapter devolve `costUsd: null`). A fábrica não sabe o
 *   que é preço — quem passa é o host. (Do Ariadne 26be46a9.)
 * @property {{ zFull?: number, zCandidate?: number, rawFloor?: number,
 *              tool?: { hydrate?: number, topKPerProvider?: number },
 *              skill?: { centralizar?: boolean, candidate?: number } }} [limiares] Cortes do
 *   ranking de capacidades (`thresholds.provider`) e da hidratação de funções
 *   (`thresholds.tool`, honrado pelo kairos desde 0.831). Omitido: defaults da estratégia
 *   (`zFull: 0.8, zCandidate: 0.3, rawFloor: 0.8`; `tool` fica com o `DEFAULT_THRESHOLDS.tool`
 *   do kairos). Motivo de existir: com POUCAS capacidades semânticas o z-score satura (N=2 ⇒
 *   ±1) e a perdedora nem vira candidata — o host pode abaixar `zCandidate` para que tudo
 *   acima do piso absoluto (`rawFloor`, cosseno cru) apareça ao menos como card. `zFull`/
 *   `zCandidate`/`rawFloor` são repassados JUNTOS (o kairos exige `rawFloor` quando
 *   `zFull`/`zCandidate` são dados); `tool` é independente dos três e vai direto para
 *   `thresholds.tool` de `createManager`. `skill` (kairos 0.835 — ver `opcoesDeLimiares`):
 *   `centralizar: true` troca a comparação do bucket `skill` para cosseno centrado pela média
 *   do catálogo (`similarityByBucket.skill`); `candidate` vai para `thresholds.skill.candidate`.
 *   Com kairos < 0.835 instalado, ambos são ignorados em silêncio pelo `createManager`.
 * @property {(info: { ctx: any, providers: string[], unchanged: boolean }) => void}
 *   [aoSelecionarProviders] Chamado SÍNCRONO, uma vez por `discover()` do turno, já com a
 *   SELEÇÃO FINAL de providers — depois do retorno real de `manager.discover()` e ANTES de a
 *   ponte (`createGenosBridge`) montar/renderizar qualquer bloco, ou seja, antes de o primeiro
 *   `read(ctx)` do turno. `ctx` é o `ctx` EXATO daquele `prepareTurn` (o do discover de
 *   promoção é a cópia marcada com `__promocao`, não o do turno) e `providers` é a lista
 *   `discover.providers.load` — a decisão do motor, não o catálogo disponível e não o
 *   `explain` (que é incompleto: omite `always`, já carregados, refiner e filtro).
 *
 *   Por que existe: as contribuições do host leem `ctx.poderesPresentes` para decidir se o
 *   poder está PRESENTE no turno, e a única fonte honesta disso é a seleção — publicar o
 *   catálogo inteiro (ou o `explain`) traz poder que não foi escolhido para o prompt e faz
 *   poder ausente ler dado. `aoMontar` não serve: dispara depois de a ponte ter renderizado.
 *
 *   Em `unchanged` (texto trivial — o discover nem roda) `providers` é o `state.loadedProviders`
 *   do próprio `prepareTurn`: o que já estava carregado continua carregado, e `unchanged: true`
 *   diz ao host que não houve decisão nova neste turno.
 *
 *   Não é engolido: se o host lançar aqui, a exceção sobe pelo `discover()` e o turno falha
 *   — renderizar com presença falsa em silêncio é pior que falhar.
 * @property {(texto: string) => void} [aoTexto] delta de texto do modelo
 * @property {(evento: object) => void} [aoEvento] eventos crus do genos — e também o
 *   diagnóstico sintético `fabrica:catalogo-mudo` da própria fábrica (ver `executarTurno`).
 *   Não colidem: os eventos do genos chegam com `.type`, os da fábrica com `.tipo`.
 * @property {(c: object) => void} [aoChamada] início e fim de cada chamada, já correlacionados
 * @property {(info: object) => void} [aoMontar] Chamado UMA vez por turno, logo depois de
 *   `construtor.montar(...)`, com `{ mensagens, secoes, system, mensagemDoTurno, entraram, sairam,
 *   discover, embeds, capacidadesAcumuladas, renderErrors, eventosDoKairos, fontes, promocoes,
 *   skillsAtivadas, refino }` — o payload que o turno de fato montou (os quatro primeiros campos são
 *   `payload.mensagens`/`payload.secoes`/`payload.system`/`payload.mensagemDoTurno` de
 *   `prompt-builder.js#montar`), `entraram`/`sairam` são o retorno de `construtor.acumular(...)`
 *   (o que mudou no system NESTE turno — o dado mais valioso aqui, mostra a evolução do prompt
 *   turno a turno), `discover` é `prepared.discoverResult` — desde o kairos 0.833 (Task 9, R1) já
 *   vem com o refino por anel aplicado DENTRO do próprio `discover()` (ver `refinadores` abaixo):
 *   `discover.explain[].proposedTier`/`.refiner` mostram o que o refinador mudou, sem precisar de
 *   um segundo discover por fora. `eventosDoKairos` (I3, revisão final do conjunto; `refiner.*`
 *   desde a Task 9) é o array de eventos `{ type: 'degraded', reason } | { type: 'budget.cut', ref,
 *   kind } | { type: 'refiner.applied', ring, ms, changed } | { type: 'refiner.fallback', ring,
 *   reason }` que o manager do kairos emitiu nos `prepareTurn` deste turno (`[]` quando nenhum,
 *   inclusive quando `refinadores` está ausente) — ver comentário de `pararKairos`
 *   em `executarTurno`. `fontes` (Task 6, spec 2 §3.4) é
 *   `Array<{ id, ms, degradado, incluidos, candidatos, carregar, semear, enriqueceu }>`, uma
 *   entrada por capacidade que declarou `fonte.selecionar` — mesmo valor entregue no retorno de
 *   `executarTurno`. Dois consumidores: o tracer do orquestrador de tela
 *   (`src/orquestrador/tracer.ts#payload`) e um inspetor ao vivo futuro. `promocoes` (I3a) é
 *   `{ fontes: string[], skills: string[], semVoto: string[] }` — ids de capacidade promovidos
 *   neste turno, por ORIGEM, e `semVoto` (Task 4, `2026-09-21-ajustes-de-uso-da-fabrica`) as refs
 *   de skill SUGERIDAS que NÃO promoveram a capacidade dona porque o anel `skill` não teve voto
 *   real do Jev (ver comentário do bloco I3a em `executarTurno`). `skillsAtivadas` (Task 10, R6) são
 *   as refs de `discover.skills.activate` que este turno tentou semear via `config.aoSemear` —
 *   ver JSDoc de `aoSemear` acima. `refino` (Task 11, spec R11/§3.4) é
 *   `{ msTotal: number, degradado: 'parcial'|null, porAnel: Record<'provider'|'tool'|'skill'|
 *   'source'|'conversation', { enviados: number, respondidos: number, ms: number|null, degradado:
 *   string|null, mudancas: Array<{ ref: string, de: string, para: string, confianca?: number }>,
 *   ignoradas: string[] }>
 *   }`, ou `null` quando nenhum anel teve refinador registrado neste turno (nenhuma entrada de
 *   `discover.explain[]` ganhou `proposedTier`/`refiner`). Derivado só de dado que já existe —
 *   `discover.explain[]` (`proposedTier` = o que o MOTOR propôs sozinho, `tier` = o resultado
 *   FINAL depois do refino, `refiner.{reason,confidence}` = o que o refinador do anel devolveu
 *   para aquele ref, quando citou) e `eventosDoKairos` (`refiner.applied{ring,ms,changed}` /
 *   `refiner.fallback{ring,reason}`, Task 9). Por anel: `mudancas` é toda entrada em que
 *   `proposedTier !== tier` (o refinador de fato mudou o tier do motor), com `confianca` só
 *   quando o refinador devolveu `confidence` numérico para aquele ref; `ms` é a SOMA de todo
 *   evento `refiner.applied` daquele anel no turno (`null` se o anel nunca emitiu o evento) —
 *   correção da revisão final do conjunto: I3a (ver bloco "I3a" acima) pode disparar um SEGUNDO
 *   `prepareTurn`/`discover()` no mesmo turno, e um anel com refinador registrado roda de novo
 *   nele, emitindo um SEGUNDO `refiner.applied` para o MESMO `ring` — somar (em vez de
 *   sobrescrever) é o tempo de parede real que o refinador daquele anel consumiu no turno
 *   inteiro, não só na última rodada;
 *   `degradado` vem do `reason` de `refiner.fallback` (`'timeout'`/`'error'`/`'invalid'`/
 *   `'budget'` — SEM o prefixo `fallback:` que `discover.explain[].refiner.reason` mantém,
 *   porque o evento já vem sem ele, ver `discover.js` do kairos: `reason: run.outcome.replace(
 *   'fallback:', '')`), `null` quando o refinador respondeu dentro do prazo. `enviados`/
 *   `respondidos` (correção Q5 da revisão da Fase 3: agnóstico de host — a versão anterior só
 *   contava `reason` prefixado `jev:`, convenção do Igris dentro de uma fábrica GENÉRICA que
 *   qualquer host pode consumir) contam sinal do REFINADOR daquele anel, não de um host
 *   específico: `enviados` conta entradas com `refiner` presente cujo `reason` NÃO veio do
 *   fallback do MOTOR (`fallback:*`, ninguém respondeu — refinador nunca rodou, ou não citou
 *   este ref a tempo) nem é o `'teto'` sintético que o motor estampa quando um item foi CITADO
 *   pelo refinador mas só cortado pelo teto duro de `full`, sem `explain` próprio dele para esse
 *   ref (`discover.js` do kairos, C5: `refiner ? {...} : { reason: 'teto' }`) — nos dois casos o
 *   refinador não devolveu nada sobre ESTE item, só o motor mexeu; `respondidos` conta entradas
 *   com `refiner.confidence` numérico (o refinador respondeu de verdade, de qualquer host, não
 *   é o `{ reason: outcome }` sintético de um fallback nem de um corte por teto). `doCache`
 *   (Task 4, `2026-09-21-ajustes-de-uso-da-fabrica`) conta as entradas de `respondidos` cujo
 *   `refiner.reason` CONTÉM `(cache)` (`reason.includes('(cache)')`, não `endsWith`: o motor pode
 *   estampar sufixo depois, ex. `(cortado por teto)`) — convenção do `criarRefinadorJev` do Igris
 *   (`packages/decisions`) para item respondido pelo cache de respostas do Jev por turno, sem ir
 *   ao Jev nesta chamada: continuam contando em `respondidos` (têm `confidence`), mas NÃO em
 *   `enviados` (não foram, de fato, perguntados agora). `refino.
 *   msTotal` (correção Q2: o anel `tool` roda numa SEGUNDA onda do kairos, DEPOIS de
 *   `provider`/`skill`/`source`/`conversation` — que rodam juntos, em paralelo, na PRIMEIRA onda
 *   — então somar `tool.ms` ao maior `ms` da primeira onda é o tempo de parede real da rodada;
 *   `Math.max` puro entre os cinco, como antes, subestimava o custo sempre que `tool` tinha
 *   refinador registrado) é `Math.max(0, ...ms da primeira onda) + (porAnel.tool?.ms ?? 0)` —
 *   `Math.max(0, ...)` para nunca dar `-Infinity` quando a primeira onda não tem nenhum anel
 *   presente (`porAnel` vazio já cai no `null` acima antes de chegar aqui). `refino.degradado` é
 *   `'parcial'` quando QUALQUER anel degradou, `null` quando nenhum. Erro dentro do handler não
 *   derruba o turno — mesma garantia de `aoEvento`: engolido com try/catch. ⚠️ Q8: a presença de
 *   `refino` (não-`null`) só prova que ALGUM anel teve refinador REGISTRADO neste turno — nunca
 *   que um decisor externo de fato respondeu (um refinador sem cliente, ou sempre em fallback,
 *   ainda produz `refino` não-nulo); para saber se algo respondeu de verdade, olhe
 *   `enviados`/`respondidos` por anel. `tempos` (Mudança 2, 2026-09-23) é `{ catalogo,
 *   discoverInicial: { total, refinadores }, fontesMemoria, loop, promocao,
 *   prepareTurnAcumulacao, montagemDoPrompt, ateOModelo }` — ms de PAREDE por fase deste turno,
 *   do início de `executarTurno` até este `aoMontar` disparar. A chamada ao MODELO em si roda
 *   FORA deste arquivo (o laço agêntico do genos, mais abaixo em `executarTurno`, depois deste
 *   `aoMontar`) — por isso `ateOModelo` é o teto observável daqui, não o turno inteiro. `catalogo`
 *   é `montarCatalogo()` (memoizado — quase 0 do segundo turno do processo em diante).
 *   `discoverInicial.total` é a parede do PRIMEIRO `bridge.prepareTurn`; `.refinadores` é a soma
 *   de `refiner.applied.ms` (ver `eventosDoKairos`) medida NO MOMENTO em que esse primeiro
 *   `prepareTurn` resolve — antes de qualquer `promoverNoTurno` rodar, então nunca inclui refino
 *   de um SEGUNDO discover (esse cai em `promocao`, não aqui). `fontesMemoria` cobre a seleção das
 *   fontes (`capsComFonte`), o embed de ENRIQUECIMENTO delas (que tem medição própria em `embeds.ms`
 *   — os dois números se referem ao mesmo trabalho) e o `aoSemear`; o embed CONTEXTUAL da pista de
 *   contexto (B3.3 fase 2) NÃO entra nessa janela desde o fix round 1 — ele é medido só em
 *   `pistaDeContexto.embeds.ms`, e o que sobrou do bloco da pista cai em `outros` (fix round 1, A4).
 *   `loop` é só `config.loop.rodar(...)` — não inclui a promoção que
 *   ele pode disparar depois. `promocao` soma qualquer `promoverNoTurno` deste turno (I3a sozinho,
 *   o do loop, ou os dois — nunca os dois no mesmo turno hoje, `loopVaiRodar` é exclusivo, mas o
 *   campo soma por segurança); `0` quando nenhuma promoção rodou.
 *   `prepareTurnAcumulacao` cobre, depois do `finally` do bloco de discover:
 *   `aoIncluirConversa`/diagnóstico de catálogo mudo/`derivarRefino`/`contratosDeCarregadas`/
 *   `contratosDoLoop`/`construtor.acumular`. `montagemDoPrompt` é `construtor.montar(...)` (com
 *   `secaoProtocolo`/`entregaDoLoop`). `ateOModelo` é a parede total desde o início do turno até
 *   este `aoMontar` — a SOMA das fases acima nunca deve exceder este número (pode ser MENOR: há
 *   trabalho síncrono entre fases — ex. a leitura de contribuições semânticas antes do embed — que
 *   nenhuma fase cobre de propósito, por não ter custo de kairos/host associado).
 * @property {Partial<Record<'provider'|'tool'|'skill'|'source'|'conversation', import('@okds/kairos/resolve').RingRefiner>>} [refinadores]
 *   Refinador por anel (kairos 0.833, spec `2026-09-20-decisor-por-anel-refinadores-do-kairos-
 *   design.md`, R1-R6) — substitui o gancho `aoDescobrir` (J3, removido na Task 9: ver histórico
 *   deste arquivo). Onde J3 era um decisor OPCIONAL rodando DEPOIS do discover, disparando um
 *   SEGUNDO `bridge.prepareTurn` por fora para aplicar o que pediu, o refinador entra DENTRO do
 *   próprio `discover()` do kairos: cada anel presente aqui (`provider`, `tool`, `skill`,
 *   `source`, `conversation`) recebe a lista ORDENADA INTEIRA do anel e a proposta que o motor
 *   faria sozinho (`input.proposal.{full,candidates}`), e devolve a classificação final — o motor
 *   aplica o resultado no MESMO discover, sem turno extra, sem `promoverNoTurno`. Repassado
 *   direto para `createManager({ refiners: config.refinadores })` — a fábrica não interpreta o
 *   contrato (`RingRefiner`, ver `@okds/kairos/dist/resolve/refiners.d.ts`), só transporta. Anel
 *   ausente (chave não declarada, ou `{}`) segue 100% a proposta do motor — saída idêntica à de
 *   antes do refino (R1: "sem `refiners`, saída idêntica à de 0.832, inclusive a ordem do
 *   `explain`"). Erro OU timeout de um refinador NUNCA derruba o turno — o kairos cai em
 *   `discover.explain[].refiner.reason` (`'fallback:timeout'`/`'fallback:error'`/
 *   `'fallback:invalid'`/`'fallback:budget'`) e aplica a proposta do motor para aquele anel; o
 *   evento `refiner.fallback` (ver `eventosDoKairos` em `aoMontar`) registra o motivo.
 * @property {{ rodar: (entrada: object) => Promise<object>, paramsDe: (a: { tool: object, capacidade: string, ctx: object, pergunta: string }) => any,
 *              corteHistorico?: number }} [loop] Loop de decisão do Jev (spec 2026-09-22): pré-hidratação
 *   depois do refino e do I3a, antes da montagem. `rodar` recebe `{ pergunta, espaco, executar, carregar,
 *   signal }` e devolve `{ estado, rastro, carregadas, passos, ms }` (`@igris/decisions/loop`,
 *   injetado pelo host — a fábrica não depende de decisions). Ausente: turno como antes.
 * @property {{ prazoMs?: number, prazoGeralMs?: number, candidateProvidersForRefine?: number,
 *              maxActivate?: number }} [refino] Orçamentos e tetos do refino por anel (R4/R6).
 *   `prazoMs` (default 600, `DEFAULT_REFINER_BUDGET_MS` do kairos) vai para
 *   `createManager({ refinerBudgetMs })` — prazo por refinador; um refinador lento (ex.: chamada
 *   de LLM) não pode taxar o turno inteiro, e o estouro cai no fallback descrito acima.
 *   `prazoGeralMs` (default 800, `DEFAULT_REFINERS_BUDGET_MS`) vai para
 *   `createManager({ refinersBudgetMs })` — teto da RODADA de refino inteira (todos os anéis),
 *   soma-se ao prazo por refinador. `candidateProvidersForRefine` (default 8) vai para
 *   `createManager({ tool: { candidateProvidersForRefine } })` — quantos providers CANDIDATOS
 *   (além dos já hidratados) entram no universo que o refinador do anel `tool` pode ver.
 *   `maxActivate` (default 2) vai para `createManager({ skills: { maxActivate } })` — teto duro
 *   de skills que o refinador do anel `skill` pode marcar `full` num turno.
 * @property {{ aneis: Array<'provider'|'tool'|'skill'>, arquivoCache?: string }} [semantica] Kairos 0.836.
 *   `aneis` vai para `createManager({ semantica: { aneis } })`: no `reindex` o kairos monta vetores
 *   `query` do texto semântico e de cada exemplo por item e os entrega aos refinadores (`RefineItem.
 *   semantica`, `RefineInput.semantica`). `arquivoCache` (`selecao-embeddings.json`, o mesmo do decisor
 *   local) vira `createManager({ cacheVetores })` via `cache-semantica.js`. Ausente: sem vetores por item.
 * @property {(semantica: object|null) => void} [aoSemanticaDoCatalogo] Kairos 0.838. Depois de cada `manager.reindex()` (aquecimento do boot e
 *   `montarCatalogo` da sessão) recebe o snapshot de `manager.semantica()` (catálogo INTEIRO por anel: `{ slug, aneis: { <anel>: { itens, media, versao } } }`
 *   ou `null`) — é como o host (decisor local) treina com o catálogo todo, não só com os itens do turno. Só chamado se o manager expõe `semantica()`;
 *   exceção do callback é engolida (nunca derruba o catálogo).
 * @property {number} [prazoDaFonteMs] Task 6 (spec 2 §3.1/§3.4) — default 800. Prazo de
 *   `fonte.selecionar(ctx, { vetor1, embedar })` de CADA capacidade com `fonte` declarada,
 *   corrido em paralelo (`Promise.allSettled`), um prazo por fonte (não um total). Fonte que
 *   estoura o prazo ou lança entra sem seleção neste turno — `fontes[].degradado` registra
 *   `'prazo'` ou `'erro: <mensagem>'` —, e o turno nunca cai por causa de UMA fonte (mesma
 *   garantia de `aoEvento`/`aoMontar`).
 * @property {(ids: string[], ctx: any) => (Array<{id: string, nome?: string, corpo?: string, aviso?: string}>|
 *   {sucessos: Array<{id: string, nome?: string, corpo?: string, aviso?: string}>, falhas?: Array<{id: string,
 *   erro: any}>}|void|Promise<Array<{id: string, nome?: string, corpo?: string, aviso?: string}>|
 *   {sucessos: Array<{id: string, nome?: string, corpo?: string, aviso?: string}>, falhas?: Array<{id: string,
 *   erro: any}>}|void>)} [aoSemear] Task 6
 *   (spec 2 §3.4/F6/F10), estendido na Task 10 (spec "decisor por anel: refinadores do kairos"
 *   §3.3, R6) — chamado até DUAS vezes por turno, com origens distintas: (1) a UNIÃO (sem
 *   duplicata) dos ids de skill que `Selecao.semear` de todas as fontes pediram, ANTES do
 *   primeiro `prepareTurn`; (2) os ids de skill que o refinador do anel `skill` ATIVOU neste
 *   turno (`discover.skills.activate`, com `skills.activation: 'host'` — ver JSDoc de
 *   `refinadores` abaixo), DEPOIS do `prepareTurn` final — um id pedido pelas DUAS origens no
 *   mesmo turno semeia uma vez só (a fábrica deduplica contra o que já chamou em (1)). É o host
 *   quem sabe semear (`hab_carregar`, fora desta fábrica) — a fábrica só repassa o pedido e,
 *   desde a Task 10, injeta o RETORNO da chamada (2) na mensagem do turno: sem retorno (`void`,
 *   array vazio, ou item sem `corpo` string não-vazia) nada é injetado; cada `{ id, nome?, corpo?
 *   }` com corpo vira um bloco `turn:context` ("Habilidade carregada agora: ..."). Com
 *   `comportamento` ligado, a da seleção vira "Habilidade sugerida para este pedido" e só semeia no fecho, se declarada.
 *   A chamada (1) (fontes) IGNORA os SUCESSOS do retorno — sempre ignorou, ver `Selecao.semear` — só a (2)
 *   (skill ativada) usa `sucessos` para montar blocos. Ausente ou sem nenhum id pedido: nada é
 *   chamado. Erro (síncrono ou rejeição) em qualquer uma das duas chamadas não derruba o turno —
 *   cai em `renderErrors`/`errosDeFontes` (`ref: 'fontes/semear'`), mesma garantia de
 *   `aoEvento`/`aoMontar`.
 *
 *   F4 (correção da revisão final do conjunto): o retorno aceita DOIS formatos —
 *   `Array<{id,nome?,corpo?,aviso?}>` (só sucessos, formato antigo, compatível com qualquer `aoSemear`
 *   existente) OU `{ sucessos: Array<{id,nome?,corpo?,aviso?}>, falhas?: Array<{id,erro}> }` (o formato
 *   que `semearNaMemoriaDeTrabalho` do chat — `packages/executor/.../fabrica/turno.js` — devolve
 *   desde esta correção: `hab_carregar` recusando UM id não derruba mais os `sucessos` dos
 *   demais ids do mesmo `aoSemear`). `normalizarRetornoDeSemear` (helper interno deste arquivo)
 *   lê os dois formatos; cada entrada de `falhas` vira uma linha própria em
 *   `renderErrors`/`errosDeFontes` (`ref: 'fontes/semear', error: '<id>: <erro>'`) — nunca lança
 *   por causa de uma falha parcial.
 *
 *   Dedup (2026-10-29): um sucesso com `jaCarregada: true` diz que a skill JÁ estava na memória de
 *   trabalho (o host não escreveu nada). Na chamada (2) esse sucesso NÃO vira bloco `#ativada` (o
 *   corpo já entra no system pela memória) — a ref vai para `skillsJaSemeadas`; na (1) o id vai
 *   para `fontes[].semearPulado`. Cada falha também vira `fontes[].semearFalhou: [{id, codigo}]`
 *   (`codigo` = `erro.code` do host, ex. `skill_not_found`).
 * @property {(ids: string[], ctx: any) => (Array<object>|{sucessos: Array<{id: string, nome?: string, corpo?: string,
 *   aviso?: string, requires?: boolean, jaCarregada?: boolean}>, falhas?: Array<{id: string, erro: any}>}|
 *   Promise<Array<object>|{sucessos: Array<object>, falhas?: Array<object>}>)} [aoPrepararHabilidade]
 *   Aceite de contribuição (spec 2026-10-29 aceite, Task 2.1) — só lido com `despejo.comportamento` ligado
 *   (e ctx não headless). Mesmo formato de retorno de `aoSemear`, mas o host NÃO escreve na memória de trabalho:
 *   devolve o corpo pronto. A habilidade ativada pelo refinador (`discover.skills.activate`) vira o bloco do turno
 *   ("Habilidade sugerida para este pedido: <nome> (id: <id>)") e entra em `comportamento.oferecidas` da saída;
 *   só sobe para a memória de trabalho se o modelo a declarar (o host semeia no fecho). Sucesso com `requires: true`
 *   (script, precisa do `skill-system`) ou `jaCarregada: true` segue para `aoSemear`, como sempre. Ausente: o
 *   caminho de sempre (`aoSemear` direto).
 */

const IDENTIDADE = (_nome, definicao) => definicao;

/** @param {ConfigDoOrquestrador} config */
/**
 * Os nomes das três meta-tools do kairos, espelhando `RESERVED_TOOL_NAMES`
 * (`@okds/kairos/dist/genos/bridge.js`). Ficam aqui, e não no construtor de
 * prompt, porque quem as registra é a PONTE — o construtor sabe a forma do
 * catálogo e mais nada.
 */
const META_TOOLS = ['load_capability', 'call_capability', 'search_capabilities'];

/**
 * Texto que o genos anexa a `Unknown tool '<nome>'` (`unknownToolMessage`).
 * No protocolo nativo só as três meta-tools são registradas, mas o índice do
 * prompt mostra o nome exposto (`<capacidade>__<tool>`) e o modelo às vezes o
 * chama direto — e recebia só "not registered in this run". Nome que não é de
 * catálogo (não-string, meta-tool, sem `__`) → `undefined` (mensagem padrão).
 * (Do Ariadne 1901880d.)
 * @param {unknown} toolName
 * @returns {string|undefined}
 */
export function mensagemDeToolDesconhecida(toolName) {
  if (typeof toolName !== 'string' || META_TOOLS.includes(toolName) || !toolName.includes('__')) return undefined;
  return `"${toolName}" é uma função do catálogo e não se chama pelo nome direto. ` +
    `Chame call_capability com { "ref": "${toolName}", "args": { ... } } — ` +
    `use load_capability com essa ref antes, se ainda não leu o manual dela.`;
}

/**
 * Q4 (correção do review de qualidade da Fase 2): teto do texto agregado de
 * `enriquecimentoDasFontes.join('\n')` antes de virar o embed 2 — sem ele, N fontes
 * `enriquecer`iam sem limite e o embed 2 pagaria um texto arbitrariamente grande (custo de
 * embedder, e o vetor deixa de representar bem a consulta original conforme o enriquecimento
 * cresce). Truncado com reticências ao final.
 */
const TETO_ENRIQUECIMENTO_CHARS = 2000;

/**
 * Acrescenta à seção de PROTOCOLO o parágrafo que nomeia as meta-tools.
 *
 * 🚨 Existe por uma assimetria medida no genos, e sem ela um host em
 * `envelope`/`fence` fica sem saber como carregar um manual:
 *
 * - em `provider_native`, `buildAnthropicNativePayload` manda `tools` no
 *   payload — o modelo recebe nome e schema das três como definição nativa, e
 *   o prompt não precisa nomeá-las (por isso `nativo.secaoInvariante()`
 *   devolve `null`);
 * - em qualquer outro protocolo, `buildAnthropicPayload` devolve
 *   `{ model, max_tokens, system, messages }` — **sem `tools`**. O texto do
 *   system é o ÚNICO canal, e se ele não nomear, o modelo não tem como saber
 *   que existe uma função de carregar.
 *
 * A seção de capacidades deliberadamente NÃO nomeia ferramenta (é o
 * construtor, que não conhece a ponte). Aqui conhece — e é o lugar que o dono
 * escolheu: "vai entrar no prompt através do prompt do protocolo de tool
 * calls".
 *
 * Com `mecanicaNoCatalogo`, a seção do nativo é nula: a legenda do catálogo já
 * ensina carregar e executar, colada nos itens (Ariadne `b7bec589`); envelope e
 * fence ganham a linha "chame direto" no começo.
 *
 * @param {{nome: string, conteudo: string}|null} secao
 * @param {{tools: Map<string, object>}} bridge
 * @param {{estrategia?: import('./protocolo/index.js').EstrategiaDeProtocolo, mecanicaNoCatalogo?: boolean}} [opts]
 */
function comoCarregarNoProtocolo(secao, bridge, { estrategia, mecanicaNoCatalogo = false } = {}) {
  // Protocolo sem secao invariante nao recebe o paragrafo. Hoje os tres tem
  // secao — `nativo` passou a ter quando deixou de registrar as capacidades no
  // registry: sem schema nativo, o unico lugar que ensina a chamar e o texto.
  if (!secao) return secao;

  // Se a ponte deixar de registrar alguma, é rename no kairos — e o certo é
  // FALHAR ALTO, não emitir um prompt que manda chamar algo inexistente.
  const ausentes = META_TOOLS.filter((n) => !bridge.tools.has(n));
  if (ausentes.length) {
    throw new Error(
      `a ponte do kairos não registrou ${ausentes.join(', ')} — o texto de protocolo mandaria o `
      + 'modelo chamar uma função que não existe. Provável rename em RESERVED_TOOL_NAMES.',
    );
  }

  // No nativo com a mecânica no catálogo, a legenda do catálogo concentra a orientação de execução.
  if (mecanicaNoCatalogo && estrategia?.registraCapacidades === false) return null;

  return {
    ...secao,
    conteudo: [
      secao.conteudo,
      '',
      ...(mecanicaNoCatalogo
        ? ['Função com manual disponível: chame direto pelo nome exato do catálogo. Não peça o manual de novo.', '']
        : []),
      'Três funções movem o catálogo de capacidades:',
      '',
      '- `load_capability({ refs })` — traz o manual completo de funções listadas como',
      '  carregáveis. `refs` são nomes de FUNÇÃO, nunca de capacidade: uma capacidade não',
      '  se carrega inteira. Chamar sem o manual é chamar sem saber os argumentos, e a',
      '  chamada é recusada.',
      '- `call_capability({ ref, args })` — EXECUTA uma função já disponível.',
      '- `search_capabilities({ query })` — procura por texto livre, quando nem o catálogo',
      '  nem o que está carregado deixam claro se existe função para o que você precisa.',
      '  É último recurso, nunca o primeiro passo.',
    ].join('\n'),
  };
}

/**
 * Soma ao `tools.hydrate` do discover as refs que o `load_capability` trouxe
 * DURANTE o turno.
 *
 * 🚨 Conserta um defeito medido: capacidade carregada no meio do turno não
 * voltava hidratada no turno seguinte. `applySessionPolicy` monta
 * `hydratedTools` a partir de `discoverOut.tools.hydrate`
 * (`kairos/session/policy.js`), que é a decisão do DISCOVER — tirada no início
 * do turno, antes de o modelo pedir qualquer coisa. O que a meta-tool trouxe
 * depois ficava de fora, e o modelo recarregava a mesma capacidade a cada
 * turno.
 *
 * O modelo pode citar a função de três formas (nome curto, composto, ref
 * completa), então cada pedido é resolvido contra o REGISTRY: o que não casa
 * com tool registrada é descartado em silêncio — pedido recusado por permissão
 * ou nome errado não pode virar hidratação fantasma.
 *
 * @param {object} discover
 * @param {Set<string>} pedidas
 * @param {object} manager
 */
/**
 * Kairos 0.838: entrega ao host o snapshot do catálogo inteiro (`manager.semantica()`) depois de um `reindex()`. Só se o manager
 * expõe `semantica()` (kairos < 0.838 não); o callback nunca derruba o catálogo.
 * @param {object} manager
 * @param {((semantica: object|null) => void)|undefined} aoSemanticaDoCatalogo
 */
export function entregarSemanticaDoCatalogo(manager, aoSemanticaDoCatalogo) {
  if (typeof aoSemanticaDoCatalogo !== 'function' || typeof manager?.semantica !== 'function') return;
  try { aoSemanticaDoCatalogo(manager.semantica()); } catch { /* observabilidade do host: nunca derruba o catálogo */ }
}

/**
 * `config.semantica` → opções do `createManager` (kairos 0.836): `semantica: { aneis }` liga os
 * vetores `query` por item (texto semântico + exemplos) entregues aos refinadores, e
 * `cacheVetores` os persiste no `arquivoCache`. Sem `semantica` (ou sem anéis): `{}` — saída
 * idêntica à de antes. Kairos < 0.836 ignora as duas chaves.
 * @param {{ aneis?: string[], arquivoCache?: string }|undefined} semantica
 */
export function opcoesDeSemantica(semantica) {
  if (!semantica || !Array.isArray(semantica.aneis) || !semantica.aneis.length) return {};
  return {
    semantica: { aneis: semantica.aneis },
    ...(semantica.arquivoCache ? { cacheVetores: criarCacheSemantica(semantica.arquivoCache) } : {}),
  };
}

/**
 * `config.limiares` (forma da fábrica) → opções do `createManager`. Aditivo: chave ausente
 * não chega ao kairos. `skill` (kairos 0.835) tem régua própria: `centralizar: true` troca a
 * comparação do bucket `skill` para cosseno centrado pela média do catálogo (a regra da V1,
 * `semantic-routing`), e `candidate` é o corte de candidata nessa escala (o kairos 0.835 não
 * tem `skill.full`: o motor nunca propõe skill como `full`, quem ativa é o refinador).
 * Com o kairos 0.834 instalado, `similarityByBucket` e `thresholds.skill` são ignorados.
 * @param {object|undefined} limiares
 * @returns {{ thresholds?: object, similarityByBucket?: object }}
 */
export function opcoesDeLimiares(limiares) {
  if (!limiares) return {};
  const { tool, skill, ...provider } = limiares;
  const cortesDeSkill = skill?.candidate !== undefined ? { candidate: skill.candidate } : {};
  const thresholds = {
    ...(Object.keys(provider).length ? { provider: { zFull: 0.8, zCandidate: 0.3, rawFloor: 0.8, ...provider } } : {}),
    ...(tool ? { tool } : {}),
    ...(Object.keys(cortesDeSkill).length ? { skill: cortesDeSkill } : {}),
  };
  return {
    ...(Object.keys(thresholds).length ? { thresholds } : {}),
    ...(skill?.centralizar ? { similarityByBucket: { skill: centeredStrategy } } : {}),
  };
}

// Mapa de resolução de `comCarregadasNoTurno` (abaixo) contra o registry — extraído para reuso
// (até a Task 9, também servia ao extinto gancho `aoDescobrir`; hoje é só de `comCarregadasNoTurno`).
//
// Mapa de TODAS as formas aceitas → { ref completa, provider }, do registry.
// @param {object} manager
// @returns {Map<string, {ref: string, provider: string}>}
function mapaDeNomesDoRegistry(manager) {
  const porNome = new Map();
  for (const provider of manager.registry.listProviders()) {
    for (const tool of manager.registry.listTools(provider.id)) {
      const alvo = { ref: `${provider.id}/tool/${tool.key}`, provider: provider.id };
      porNome.set(alvo.ref, alvo);
      porNome.set(tool.key, alvo);
      // 🚨 `nomeExposto`, NUNCA montado a mão. Esta linha ja foi
      // `${provider.id}_${tool.key}` — uma TERCEIRA definicao da convencao de
      // nome exposto, alem de `nomeExposto` e do `exposedName` do kairos. Quando
      // o separador virou `__`, ela ficou para tras em silencio: o modelo pedia
      // `codigo__ler_codigo`, o mapa so tinha `codigo_ler_codigo`, o `get`
      // devolvia undefined, `refs` ficava vazio e a funcao retornava o discover
      // INTACTO — sem erro, sem log.
      //
      // Efeito medido (2026-09-19, sessao 5b9c99c3): o turno 1 carregava
      // `codigo` e o estado de saida nao registrava nada; o turno 2 recomecava
      // sem a capacidade, e o modelo so operava porque lembrava da conversa.
      // Todo o controle de prompt entre turnos dependia desta string.
      porNome.set(nomeExposto(provider.id, tool.key), alvo);
    }
  }
  return porNome;
}

function comCarregadasNoTurno(discover, pedidas, manager) {
  if (pedidas.size === 0) return discover;

  const porNome = mapaDeNomesDoRegistry(manager);

  const refs = new Set();
  const providers = new Set();
  for (const pedida of pedidas) {
    const alvo = porNome.get(pedida);
    if (!alvo) continue;
    refs.add(alvo.ref);
    providers.add(alvo.provider);
  }
  if (refs.size === 0) return discover;

  // 🚨 O provider entra em `providers.load`, e não só a tool em `hydrate`.
  //
  // Foi a metade que faltou na primeira tentativa, e sem ela o conserto não
  // funcionava: `applySessionPolicy` monta `loadedProviders` de
  // `discoverOut.providers.load` (`kairos/session/policy.js`), e é `loadedProviders`
  // que faz a capacidade sobreviver ao turno. Injetar só em `hydrate` deixava
  // a tool marcada como hidratada num provider que a sessão nunca considerou
  // carregado — e no turno seguinte ela sumia junto com ele.
  //
  // ⚠️ `replaceForLoadedProviders` (mesma policy) DESCARTA as refs anteriores
  // de todo provider que carregou neste turno e as substitui pelas deste. Ou
  // seja: marcar o provider como carregado obriga a mandar o conjunto INTEIRO
  // de tools dele, não só a que o modelo pediu agora — senão carregar uma
  // segunda tool da mesma capacidade APAGARIA a primeira.
  const todasDoProvider = [];
  for (const id of providers) {
    for (const tool of manager.registry.listTools(id)) {
      todasDoProvider.push(`${id}/tool/${tool.key}`);
    }
  }

  const d = discover;
  return {
    ...d,
    providers: {
      ...d.providers,
      load: [...new Set([...(d.providers?.load ?? []), ...providers])],
    },
    tools: {
      ...d.tools,
      hydrate: [...new Set([...(d.tools?.hydrate ?? []), ...refs])],
      // Conscientes = o índice. Carregar uma tool de uma capacidade põe a
      // capacidade inteira no índice do turno seguinte, que é o que o bloco
      // `<capabilities>` mostra.
      conscious: [...new Set([...(d.tools?.conscious ?? []), ...todasDoProvider])],
    },
  };
}

/**
 * Irmão mínimo de `comCarregadasNoTurno` para o caso que ele não cobre: uma capacidade pedida
 * pelo id sem NENHUMA tool `fixa` (pinned). Chamado hoje só por `promoverNoTurno` (I3a — provider
 * dono de uma skill sugerida sem estar carregado). Nasceu na Task 6 para a promoção de `carregar`
 * das fontes (antes da Task 9, também o extinto gancho `aoDescobrir`) — a Task 10 tirou esse
 * chamador: `carregar` das fontes hoje entra pelo ESTADO do primeiro `prepareTurn`
 * (`estadoKairosDoTurno`, `executarTurno`), que o próprio kairos já trata como `loadedProviders`
 * sem precisar desta função. Correção do review da Fase 2 (motivo original de existir) — antes,
 * o tradutor de pedido expandia esse id para um Set de refs vazio, o gate de `refs.size > 0` via
 * `comCarregadasNoTurno` ficava falso, e a capacidade inteira era descartada em silêncio: nunca
 * entrava em `providers.load`, nunca ganhava índice.
 *
 * Só o que uma capacidade SEM manual forçado precisa: o provider em `providers.load` (índice +
 * instruções, mesmo mecanismo de `comCarregadasNoTurno`) — sem tocar `tools.hydrate`. Puxar o
 * conjunto inteiro de refs para `tools.hydrate` aqui forçaria manual em funções que o kairos
 * nunca decidiu hidratar (nenhuma é `fixa`, nenhuma bateu score) — quem pede a capacidade AMPLIA
 * o que o kairos decidiu, nunca decide no lugar dele.
 *
 * @param {object} discover
 * @param {Set<string>} providers ids de capacidade (providers) a garantir em `providers.load`
 * @param {object} manager
 */
function comProvidersNoTurno(discover, providers, manager) {
  if (providers.size === 0) return discover;

  const todasDoProvider = [];
  for (const id of providers) {
    for (const tool of manager.registry.listTools(id)) {
      todasDoProvider.push(`${id}/tool/${tool.key}`);
    }
  }

  const d = discover;
  return {
    ...d,
    providers: {
      ...d.providers,
      load: [...new Set([...(d.providers?.load ?? []), ...providers])],
    },
    tools: {
      ...d.tools,
      conscious: [...new Set([...(d.tools?.conscious ?? []), ...todasDoProvider])],
    },
  };
}

/**
 * Blocos de contrato para um conjunto de refs de função (`provider/tool/key`) que precisam de
 * MANUAL no prompt deste turno mesmo sem o discover ter hidratado — cada chamador tem sua própria
 * razão para "precisar" (ver `contratosDeCarregadas`/`contratosDoLoop`, abaixo, que só diferem na
 * ORIGEM do conjunto de refs). Extraída na correção B (fluxo de bug, spec 2026-09-22 §6.4): antes,
 * `contratosDeCarregadas` tinha esta lógica inteira duplicada — a correção B precisava do MESMO
 * comportamento para outra origem de refs (o que o loop do Jev usou), e duplicar de novo
 * comprometia a manutenção (a mesma correção de bug já feita duas vezes neste arquivo, ver os
 * comentários `⚠️` abaixo).
 *
 * O ref no formato `provider/tool/key` é o que `classificar` (prompt-builder) reconhece como
 * 'contrato' — é assim que ele entra no `<functions>` como manual e não como linha de índice.
 *
 * @param {object} manager
 * @param {Iterable<string>} refs
 * @param {Array<{ref: string}>} jaNoSystem blocos já presentes (evita duplicar contrato de uma
 *   ref que outra origem — ou o discover normal — já trouxe neste turno).
 */
async function contratosParaRefs(manager, refs, jaNoSystem, nomeDe = null) {
  const pedidas = [...(refs ?? [])];
  if (pedidas.length === 0) return [];
  const presentes = new Set(jaNoSystem.map((b) => b.ref));

  const extras = [];
  for (const ref of pedidas) {
    if (presentes.has(ref)) continue;
    const [providerId, , ...resto] = ref.split('/');
    const key = resto.join('/');
    if (!providerId || !key) continue;
    const tool = manager.registry.getTool(providerId, key);
    // Tool desregistrada desde o estado salvo, ou sem contrato: não inventa.
    if (!tool?.contract) continue;
    // ⚠️ `contract` no registry do kairos é FUNÇÃO (resolvida sob demanda),
    // não string. Passá-la crua produz `corpo.trim is not a function` lá no
    // `tag()`, três camadas abaixo — medido.
    // `label` importa no caminho em que a função ainda não está no índice: o
    // acumulador a cria com as duas metades, e sem label ela entraria anônima.
    // ⚠️ `contract` no registry do kairos devolve PROMISE — resolvida sob
    // demanda. Sem o await, o bloco levava `[object Promise]` e era
    // descartado pelo teste de string logo abaixo, em silêncio.
    const texto = typeof tool.contract === 'function' ? await tool.contract() : tool.contract;
    if (typeof texto !== 'string' || !texto.trim()) continue;
    // O label vira o NOME da função quando ela não está no índice do turno (acumulador, "2. Manuais"). A linha de
    // índice do kairos (`bash — Executa…`) ali virava `<function name="bash — Executa…">`: nem o modelo nem o guarda de
    // manual a reconheciam, e a função carregada num turno anterior era recarregada (sessão 68607343, 10/10).
    extras.push({ ref, content: texto, label: nomeDe ? nomeDe(providerId, key) : (tool.indexLine ?? key) });
  }
  return extras;
}

/**
 * Blocos de contrato para as tools que o modelo carregou por `load_capability`
 * em turnos anteriores e que o discover deste turno NÃO hidratou.
 *
 * @param {object} manager
 * @param {{kairos?: {hydratedTools?: string[]}}} estadoAnterior
 * @param {Array<{ref: string}>} jaNoSystem
 */
async function contratosDeCarregadas(manager, estadoAnterior, jaNoSystem, nomeDe = null) {
  return contratosParaRefs(manager, estadoAnterior?.kairos?.hydratedTools ?? [], jaNoSystem, nomeDe);
}

/**
 * Correção B (fluxo de bug, spec 2026-09-22 §6.4): blocos de contrato para as funções cujo manual
 * o modelo precisa ter neste turno por causa do loop do Jev — as que o loop EXECUTOU COM SUCESSO
 * e as que ele ESCOLHEU mas não executou (`paraOModelo`, revisão do conjunto 7fe31cb7) — mesmo
 * quando não são `fixa`/pinned.
 *
 * Sem isto, a spec §6.4 ("o modelo SEMPRE tem o contrato do que foi usado") só se sustentava para
 * função `fixa` — que hidrata sempre, fora do ranking. Uma função usada pelo loop sem ser `fixa`
 * (ex.: `task_listas`, `gcal_ver_evento`, `gcal_listar_calendarios`, `gcal_status` — pendência
 * "orchestrator/kairos (loop, IMPORTANTE)", `docs/pendencias/2026-09-22-loop-de-decisao-do-jev.md`)
 * dependia de `promoverNoTurno` (acima, bloco do loop) fazer um SEGUNDO `bridge.prepareTurn`
 * hidratá-la — o que só funciona por ACIDENTE: `comCarregadasNoTurno`/`applySessionPolicy` marcam
 * a ref em `discoverAumentado.tools.hydrate` (entra em `state.hydratedTools`), mas o discover
 * FRESCO que `bridge.prepareTurn` roda em cima desse estado recalcula `tools.hydrate` pela RANKING
 * de verdade (`hydrateProvider`, kairos `resolve/hydrate.ts`) — sem `pinned`, sem bater o embedder,
 * a função não entra, ponto final (medido: `E:\tmp\debug-n1.mjs`, comentário do teste "N1: função
 * ainda não hidratada..." em `test/loop-do-jev.test.js`). O caminho que já funciona para uma
 * função hidratada em turno ANTERIOR (`contratosDeCarregadas`, acima) resolve o mesmo problema
 * aqui: o manual entra como bloco `turno` de classe 'contrato' — `acumular()` (prompt-builder.js,
 * "2. Manuais") o anexa à função que JÁ está no índice (toda tool de um provider CARREGADO entra
 * em `conscious`/índice, `comCarregadasNoTurno`/`comProvidersNoTurno` — só o CONTRATO dependia de
 * ranking), sem depender de `tools.hydrate`. Isso também resolve a guarda de `registryDoTurno`: o
 * manual entra em `acumulacao.system.capacidades[].funcoes[].manual`, e é dali que
 * `nomesComManualNoPrompt(acumulacao)` lê o que a chamada direta do modelo pode executar.
 *
 * @param {object} manager
 * @param {Iterable<string>} refsComManualDoLoop refs executadas com sucesso pelo loop + refs de `paraOModelo`
 * @param {Array<{ref: string}>} jaNoSystem
 */
async function contratosDoLoop(manager, refsComManualDoLoop, jaNoSystem, nomeDe = null) {
  return contratosParaRefs(manager, refsComManualDoLoop, jaNoSystem, nomeDe);
}

/**
 * Task 11 (spec "decisor por anel: refinadores do kairos" R11/§3.4): agrega o refino por anel de
 * um turno num único objeto, a partir de duas fontes que já existem — não recalcula nada, só lê
 * o que o kairos 0.833 já produziu:
 *  - `explain[]` (`prepared.discoverResult.explain`, Task 9, R1/R5): cada entrada que teve
 *    refinador registrado para o seu `ring` ganha `proposedTier` (o que o MOTOR propôs sozinho) e
 *    `tier` (o resultado FINAL, depois do refino — pode ser igual). `e.refiner` só existe quando
 *    o refinador CITOU aquele ref no `explain` que devolveu (`RefineOutput.explain`,
 *    `refiners.d.ts`) — um refinador de teste que devolve só `{ full, candidates }` sem `explain`
 *    estampa `proposedTier`/`tier` mas nunca `refiner`;
 *  - `eventosDoKairos`: `refiner.applied { ring, ms, changed }` quando o refinador respondeu
 *    dentro do prazo, `refiner.fallback { ring, reason }` quando estourou/errou/devolveu formato
 *    inválido — `reason` aqui já vem SEM o prefixo `fallback:` (kairos `discover.js`: `reason:
 *    run.outcome.replace('fallback:', '')`), diferente do `e.refiner.reason` do explain, que
 *    mantém o prefixo.
 * `enviados`/`respondidos` só fazem sentido para os refinadores do HOST (Igris/jev) — a convenção
 * deste projeto é prefixar `reason` com `jev:` (ver JSDoc de `refinadores` no docblock de
 * `ConfigDoOrquestrador`: "reason começa com fallback: quando o refinador não respondeu, jev:
 * quando o refinador do Igris respondeu"). Um refinador de outra origem (ex.: os de teste em
 * `test/refino.test.js`, casos `(a)`-`(k)`) nunca incrementa os dois — só `mudancas`/`tier`
 * mudam, que não dependem do prefixo.
 * Anel sem refinador registrado nunca aparece em `porAnel` (R8: sem `proposedTier`, a entrada de
 * `explain` não tem sinal de que o anel foi refinado) — é o desejado.
 *
 * N2 (correção do re-review final, kairos 0.834 — bump pendente): com 0.834, `explain[]` ganha
 * entradas SINTÉTICAS para refs que o refinador citou FORA do anel que estava avaliando —
 * `{ ref, ring, reason: 'refinador citou ref fora do anel', refiner: { reason: 'ignorada' } }`.
 * Sem proposedTier/tier (não é uma decisão de tier, é o kairos descartando em silêncio uma
 * citação fora de escopo), então nunca vira `mudanca`. Mas ANTES desta correção, `e.refiner`
 * presente com `reason` diferente de `fallback:`/`teto` bastava para contar em `enviados` — uma
 * entrada `ignorada` inflava o denominador de "quantos itens o refinador respondeu de verdade"
 * sem o refinador ter respondido nada sobre aquele ref. Correção: `reason === 'ignorada'` nunca
 * conta em `enviados`/`respondidos`, e vai para `porAnel[ring].ignoradas` (não é uma capacidade
 * real do anel — o inspetor da fábrica também precisa saber para não tratá-la como candidata,
 * ver `packages/api/src/routes/session-review/inspetor-da-fabrica.js`).
 *
 * Extraída para função EXPORTADA (antes era uma IIFE dentro de `executarTurno`) — testável direto
 * com um `explain` sintético, sem montar um turno inteiro só para provar o filtro de `ignorada`
 * (kairos ainda não emite essas entradas na versão instalada, 0.833; o teste em
 * `test/refino.test.js` constrói o `explain` à mão).
 * @param {Array<{ref: string, ring: string, proposedTier?: string, tier?: string, refiner?: {reason?: string, confidence?: number}}>} explain
 * @param {Array<{type: string, ring: string, ms?: number, reason?: string}>} eventosDoKairos
 * @returns {{msTotal: number, degradado: 'parcial'|null, porAnel: Record<string, {enviados: number, respondidos: number, doCache: number, ms: number|null, degradado: string|null, mudancas: Array, ignoradas: string[]}>}|null}
 */
export function derivarRefino(explain, eventosDoKairos) {
  const porAnel = {};
  const anel = (ring) => (porAnel[ring] ??= {
    enviados: 0, respondidos: 0, doCache: 0, ms: null, degradado: null, mudancas: [], ignoradas: [],
  });
  for (const e of explain ?? []) {
    if (e.proposedTier === undefined && e.refiner === undefined) continue;
    const a = anel(e.ring);
    const reason = e.refiner?.reason ?? '';
    // N2: entrada sintética "citou ref fora do anel" — não é resposta do refinador sobre um item
    // do universo que ele avaliou, não conta em enviados/respondidos, não vira mudança.
    if (reason === 'ignorada') { a.ignoradas.push(e.ref); continue; }
    // Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`): item respondido pelo cache de respostas
    // do Jev por turno (`criarRefinadorJev`, `packages/decisions`) — não foi, de fato, perguntado
    // ao Jev NESTA chamada, então não conta em `enviados`; ver JSDoc desta função acima.
    // Correção do review da Fase 1 (#6): `includes`, não `endsWith` — o kairos pode sufixar a
    // reason com `(cortado por teto)` depois do `(cache)` (item respondido pelo cache mas ainda
    // assim cortado do turno por um teto de tamanho), e `endsWith` perderia essas duas contagens
    // (`doCache` abaixo e a exclusão de `enviados` logo adiante).
    const doCache = reason.includes('(cache)');
    // Q5 (correção do review da Fase 3): agnóstico de host — ver JSDoc desta função acima para a
    // explicação completa.
    if (e.refiner && !reason.startsWith('fallback:') && reason !== 'teto' && !doCache) a.enviados += 1;
    if (typeof e.refiner?.confidence === 'number') {
      a.respondidos += 1;
      if (doCache) a.doCache += 1;
    }
    if (e.proposedTier && e.tier && e.proposedTier !== e.tier) {
      a.mudancas.push({
        ref: e.ref,
        de: e.proposedTier,
        para: e.tier,
        ...(typeof e.refiner?.confidence === 'number' ? { confianca: e.refiner.confidence } : {}),
      });
    }
  }
  for (const ev of eventosDoKairos ?? []) {
    // F1 (correção da revisão final do conjunto): SOMA, não sobrescreve — I3a pode disparar um
    // SEGUNDO `prepareTurn`/`discover()` no mesmo turno (ver bloco "I3a" em `executarTurno`), e
    // um anel com refinador registrado roda de novo nele, emitindo um SEGUNDO `refiner.applied`
    // para o MESMO `ring`. Sobrescrever perdia o tempo da primeira rodada; somar reflete o custo
    // REAL do turno (as duas chamadas ao Jev aconteceram de verdade, mesmo com a memoização do
    // lado do chat evitando refazer a pergunta — `ms` aqui é tempo de parede do refinador, que a
    // fábrica só evita para o cliente do Jev, não para o kairos rodar `discover()` de novo).
    if (ev?.type === 'refiner.applied') { const a = anel(ev.ring); a.ms = (a.ms ?? 0) + ev.ms; }
    if (ev?.type === 'refiner.fallback') { const a = anel(ev.ring); a.degradado = ev.reason; }
  }
  if (Object.keys(porAnel).length === 0) return null;
  // Q2 (correção do review da Fase 3): `tool` roda numa SEGUNDA onda do kairos, DEPOIS de
  // `provider`/`skill`/`source`/`conversation` (que rodam juntos, em paralelo, na PRIMEIRA — ver
  // `discover.js` do kairos, comentário "5b. Skills" e "onda 1"/"onda 2" citados no JSDoc desta
  // função acima). `Math.max` puro entre os cinco anéis subestimava o tempo de parede real sempre
  // que `tool` tinha refinador registrado — a soma certa é o maior `ms` da primeira onda MAIS o
  // `ms` de `tool` (que só começa depois dela terminar).
  const { tool: anelTool, ...aneisDaPrimeiraOnda } = porAnel;
  const msOnda1 = Math.max(0, ...Object.values(aneisDaPrimeiraOnda).map((a) => a.ms ?? 0));
  const msTotal = msOnda1 + (anelTool?.ms ?? 0);
  const degradado = Object.values(porAnel).some((a) => a.degradado) ? 'parcial' : null;
  return { msTotal, degradado, porAnel };
}

/**
 * Registra CADA capacidade (Provider + tools + skills da fonte) num `manager` do kairos —
 * fatorada para fora de `montarCatalogo` (dentro de `criarOrquestrador`) para que ELA e
 * `aquecerCatalogo` (abaixo) rodem exatamente a MESMA sequência de registro. O aquecimento de
 * processo só vale a pena se embeda EXATAMENTE os mesmos documentos que uma sessão real
 * embedaria — duas cópias desta lógica divergiriam mais cedo ou mais tarde.
 * @param {ReturnType<typeof createManager>} manager
 * @param {import('./capacidades.js').CapacidadeDeclarada[]} capacidades
 */
export async function registrarCapacidadesNoManager(manager, capacidades) {
  const providers = montarProviders(capacidades);
  for (let i = 0; i < providers.length; i += 1) {
    const { provider, tools, fonte } = providers[i];
    // `montarProviders` devolve UMA entrada por capacidade, na MESMA ordem de `capacidades`
    // (`capacidades.map(...)`, sem filtrar) — o índice correlaciona direto de volta ao objeto
    // original do host, que é onde `skillsDeclaradas` (abaixo, Task 10) precisa pousar.
    const cap = capacidades[i];
    // `fonte.skills()` (spec 2 §3.1, Task 5) — registradas no MESMO provider da capacidade, ao
    // lado das `tools`. Erro (ou fonte sem `skills`) não pode derrubar o catálogo inteiro por
    // causa de UMA fonte: loga e segue sem skills dela, mesma garantia que `aoEvento`/`aoMontar`
    // já dão a callback do host (ver docblock de `ConfigDoOrquestrador`) — só que aqui não há
    // `renderErrors` de turno para acumular (isto roda uma vez, na montagem do catálogo, não por
    // turno).
    // Idempotência (revisão do conjunto, item 4/M5): esta função pode rodar DUAS VEZES sobre a
    // MESMA `cap` — uma vez cedo (registro descartável, só para popular `skillsDeclaradas` ANTES
    // de `limiaresDoConjunto` calcular seu hash — ver `montarCatalogo`) e outra vez no manager
    // REAL. `fonte.skills()` é I/O assíncrono do host — chamá-lo de novo na segunda passada
    // pagaria o custo em dobro (e, pior, arriscaria uma fonte com efeito colateral por chamada).
    // `cap.skillsDeclaradas !== undefined` é o sinal de "já rodou" — reusa o array cru já obtido
    // em vez de rechamar `fonte.skills()`.
    let declaradas = cap?.skillsDeclaradas;
    if (declaradas === undefined) {
      declaradas = [];
      if (typeof fonte?.skills === 'function') {
        try {
          declaradas = (await fonte.skills()) ?? [];
        } catch (err) {
          console.warn(`[fabrica] fonte.skills() de "${provider.id}" falhou: ${err?.message ?? err}`);
          declaradas = [];
        }
      }
      // Task 10 (spec do porte §5.3): guarda o array CRU (com `exemplos`, quando a skill tiver —
      // `catalogo.js#fonteDeHabilidades`) no objeto de capacidade do HOST, para
      // `exemplosDasCapacidades` (calibracao.js) ler sem precisar rechamar `fonte.skills()` (que é
      // assíncrona e só roda aqui). Mutação deliberada de `cap` — o mesmo padrão que o host já
      // espera ao ler `cap.piso`/`cap.tools` de volta em outros pontos da fábrica.
      if (cap) cap.skillsDeclaradas = declaradas;
    }
    const skills = declaradas.map((s) => ({
      ref: `${provider.id}/skill/${s.key}`,
      kind: 'skill',
      providerId: provider.id,
      key: s.key,
      description: s.descricao,
      ...(s.semanticText ? { semanticText: s.semanticText } : {}),
      // Kairos 0.836: `examples` da Skill (ver a tool em `capacidades.js#montarProviders`).
      ...(Array.isArray(s.exemplos) && s.exemplos.length ? { examples: s.exemplos } : {}),
      // `Skill` exige `read` (herdado de `Contribution`) E `body` — os dois apontando para o
      // MESMO `corpo` do host (confirmado em `@okds/kairos/core/types#Skill`,
      // `core/registry.ts#registerProvider`).
      read: s.corpo,
      body: s.corpo,
    }));
    manager.registry.registerProvider(provider, { tools, ...(skills.length ? { skills } : {}) });
  }
}

/**
 * Calcula (ou aceita o `padrao`, ou aplica o `override`) os limiares do kairos para um conjunto
 * de capacidades — FUNÇÃO ÚNICA usada tanto por `montarCatalogo` (dentro de `criarOrquestrador`,
 * hoje só no primeiro turno de cada sessão) quanto por `aquecerCatalogo` (achado 2 da revisão da
 * Fase 2 do porte dos poderes: sem isto, o aquecimento do boot só reindexava o CATÁLOGO — os
 * embeddings dos EXEMPLOS e o cálculo de `calibrarLimiares` só rodavam quando o primeiro turno
 * real chegava, pagando o custo de qualquer forma). Os dois chamadores batem na MESMA chave de
 * `limiaresEmCache` (`cache-catalogo.js`) para o MESMO conjunto — quem chega primeiro (boot ou
 * turno) calcula; o outro encontra a promessa já resolvida.
 *
 * ⚠️ A chave de `limiaresEmCache` NÃO inclui `padrao`/`calibracao.parametros` no hash (só
 * `embedder.modelSlug` + ids das capacidades + hash dos exemplos) — um chamador que passa um
 * `limiares`/`calibracao` diferente do outro contaminaria o cache com limiares calculados sobre
 * um padrão errado, que o outro chamador reusaria sem saber. `aquecerCatalogoDaFabrica`
 * (`packages/executor/.../fabrica/aquecimento.js`) por isso reusa `limiaresDoChat()`/
 * `calibracaoDoChat()` de `perfil.js` — nunca uma cópia local.
 *
 * @param {{ capacidades: import('./capacidades.js').CapacidadeDeclarada[], limiares?: object,
 *   calibracao?: { ativa?: boolean, parametros?: object, arquivoCache?: string, override?: object } }} config
 * @param {import('@okds/kairos/index/embedder').Embedder | null} embedderCru
 * @returns {Promise<{ infoLimiares: { valores: object, origem: 'padrao'|'calculado'|'override', resumo: object|null, motivo?: string }, msCalibracao: number }>}
 */
export async function limiaresDoConjunto(config, embedderCru) {
  const padrao = config.limiares ?? {};
  let infoLimiares = { valores: { ...padrao }, origem: 'padrao', resumo: null };
  let msCalibracao = 0;
  if (config.calibracao?.ativa && embedderCru) {
    const t0Calibracao = Date.now();
    // Achado 3 da revisão da Fase 2: calibração é cálculo best-effort sobre o embedder real
    // (rede/E5 podem falhar) — uma falha aqui NÃO pode derrubar o turno (nem o aquecimento do
    // boot). Cai para o `padrao` (mesmo formato do ramo "poucos exemplos" de `calibrarLimiares`),
    // avisa uma vez (esta função roda uma vez por chave, memoizada em `limiaresEmCache` — não há
    // aviso repetido por turno) e segue. `limiaresEmCache` já remove a entrada ANTES de relançar
    // — o erro nunca fica preso em cache, a próxima chamada tenta de novo.
    try {
      const exemplos = exemplosDasCapacidades(config.capacidades);
      // Só as capacidades da conta entram na chave (as `calibravel !== false`): o genérico não participa do
      // cálculo (`calibrarLimiares` o deixa fora do manager de calibração), então cadastrar/remover servidor
      // MCP não pode invalidar nem recalcular os limiares.
      const idsDaConta = config.capacidades.filter((c) => c.calibravel !== false).map((c) => c.id).sort();
      const chave = `${embedderCru?.modelSlug}|${idsDaConta.join(',')}|${contentHash(JSON.stringify(exemplos))}`;
      const embedderExemplos = envolverEmbedderComDisco(embedderCru, { arquivo: config.calibracao.arquivoCache });
      const r = await limiaresEmCache(chave, async () => {
        const res = await calibrarLimiares({ capacidades: config.capacidades, embedder: embedderExemplos, padrao, parametros: config.calibracao.parametros });
        await embedderExemplos.salvar();
        return res;
      });
      // M3 (revisão do conjunto): `r.motivo` só existe no ramo "poucos exemplos"/"sem-embedder" de
      // `calibrarLimiares` (o early-return, ANTES do cálculo por exemplo) — precisa SAIR daqui
      // junto de `valores`/`origem`/`resumo`, senão o motivo do fallback se perde no caminho até
      // o artefato do turno (era descartado aqui antes desta correção).
      infoLimiares = { valores: r.limiares, origem: r.origem, resumo: r.resumo, ...(r.motivo ? { motivo: r.motivo } : {}) };
    } catch (err) {
      const motivo = `erro: ${err?.message ?? err}`;
      console.warn(`[fabrica] calibração de limiares falhou, usando padrão (${motivo})`);
      infoLimiares = { valores: { ...padrao }, origem: 'padrao', resumo: null, motivo };
    }
    msCalibracao = Date.now() - t0Calibracao;
  }
  if (config.calibracao?.override) {
    infoLimiares = { ...infoLimiares, valores: { ...infoLimiares.valores, ...config.calibracao.override }, origem: 'override' };
  }
  return { infoLimiares, msCalibracao };
}

/**
 * Aquece o cache de embeddings do catálogo (`cache-catalogo.js`) para o conjunto de
 * `capacidades`/`embedder` dado — SEM criar uma sessão nem rodar turno nenhum. Pensado para
 * rodar em BACKGROUND no boot do processo (depois que o embedder real estiver pronto), e para
 * ser chamado de novo sempre que o conjunto de capacidades mudar em runtime (ex.: um MCP novo
 * instalado) — nesse caso é o MESMO papel que `recalcularCatalogo` cobre, só que sem limpar o
 * que já está em cache.
 *
 * Cria um `manager` do kairos DESCARTÁVEL — `can: () => true` e sem refinadores, porque nenhum
 * dos dois importa para `reindex()` (o único método chamado aqui): eles só entram em
 * `discover()`, que este manager nunca roda. O `manager` em si é jogado fora ao final; o que
 * sobra é o cache de processo, que `montarCatalogo` (dentro de `criarOrquestrador`) e a PRÓXIMA
 * chamada a `aquecerCatalogo` reaproveitam.
 *
 * Sem embedder (`config.embedder` ausente/`null`): não há o que aquecer (`reindex()` degrada
 * para BM25 puro, ver `discover.ts`) — devolve cedo, sem criar manager nenhum.
 *
 * Achado 2 da revisão da Fase 2: quando `config.calibracao?.ativa`, também roda
 * `limiaresDoConjunto` (acima) — os embeddings dos EXEMPLOS e o cálculo dos limiares ficam
 * quentes no boot, não só o índice do catálogo. `config.limiares`/`config.calibracao` PRECISAM
 * ser os mesmos valores que a sessão real passaria (ver aviso na JSDoc de `limiaresDoConjunto`).
 *
 * B1.5: `config.catalogoCache.arquivoCache` (mesma forma de `config.calibracao.arquivoCache`, mas
 * o arquivo do CATÁLOGO, não o dos exemplos) faz o que este aquecimento embeda SOBREVIVER ao
 * processo — `montarCatalogo`, em qualquer processo seguinte, lê os vetores em vez de reembedar.
 * Precisa ser o MESMO caminho que a sessão real passa (mesmo cuidado do parágrafo acima), e é o
 * que `perfil.js` monta. Ausente = só cache de processo, como antes.
 *
 * @param {{ capacidades: import('./capacidades.js').CapacidadeDeclarada[], embedder?: import('@okds/kairos/index/embedder').Embedder | null, limiares?: object, calibracao?: object, catalogoCache?: { arquivoCache?: string }, semantica?: { aneis: string[], arquivoCache?: string }, aoSemanticaDoCatalogo?: (semantica: object|null) => void }} config
 * @returns {Promise<{ ok: boolean, motivo?: string }>}
 */
export async function aquecerCatalogo(config) {
  const embedderCru = config?.embedder ?? null;
  if (!embedderCru) return { ok: false, motivo: 'sem-embedder' };
  // B1.5: o vetor que este aquecimento paga também é GRAVADO em disco
  // (`cache-catalogo-disco.js`), para o próximo boot do processo não pagar de novo — a espera
  // medida de 14–37 s no 1º turno era o RESTO deste aquecimento, com a sessão chegando no meio
  // dele. `cacheDoCatalogoEmDisco` devolve SEMPRE o mesmo wrapper (memoizado pelo embedder cru),
  // que é o que mantém o bucket do `WeakMap` de `cache-catalogo.js` compartilhado com
  // `montarCatalogo` e entre sessões.
  const disco = cacheDoCatalogoEmDisco(embedderCru, { arquivo: config?.catalogoCache?.arquivoCache });
  const embedder = envolverEmbedderComCache(disco.embedder);
  const manager = createManager({ embedder, can: () => true, skills: { activation: 'none' }, ...opcoesDeSemantica(config?.semantica) });
  await registrarCapacidadesNoManager(manager, config.capacidades ?? []);
  await manager.reindex();
  entregarSemanticaDoCatalogo(manager, config?.aoSemanticaDoCatalogo);
  // Só depois do `reindex()` inteiro: `salvar()` sai sem tocar o arquivo quando nada embedou
  // novo, e uma gravação parcial deixaria o resto para o próximo boot pagar de novo.
  await disco.salvar();
  if (config.calibracao?.ativa) {
    await limiaresDoConjunto(config, embedderCru);
  }
  return { ok: true };
}

/**
 * Força a invalidação do cache de embeddings do catálogo (`cache-catalogo.js`) — escape hatch
 * manual: a invalidação NORMAL já acontece sozinha (chave por `contentHash` do texto + `modelSlug`
 * do embedder — texto ou embedder diferente vira hash diferente, cache miss, reembeda). Isto é
 * para o caso em que o texto/hash NÃO mudou mas o vetor em cache precisa ser jogado fora mesmo
 * assim (ex.: suspeita de vetor corrompido).
 *
 * Com `config`: limpa e IMEDIATAMENTE reaquece (equivalente a `limparCacheDeEmbeddingsDoProcesso()`
 * seguido de `aquecerCatalogo(config)`) — o caso comum de "um MCP novo foi instalado, quero o
 * catálogo pronto antes da próxima sessão pedir". Sem `config`: só invalida; a próxima sessão que
 * chamar `montarCatalogo()` reembeda sob demanda, como sempre.
 * @param {Parameters<typeof aquecerCatalogo>[0]} [config]
 */
export async function recalcularCatalogo(config) {
  limparCacheDeEmbeddingsDoProcesso();
  // B1.5: e a camada de disco, senão o escape hatch não escaparia de nada — o `reindex()` logo
  // abaixo leria os mesmos vetores de volta do arquivo. Ver `limparCacheDoCatalogoEmDisco`.
  limparCacheDoCatalogoEmDisco();
  if (!config) return { ok: true, invalidado: true };
  return aquecerCatalogo(config);
}

/**
 * A-I6 — aviso com que o turno TERMINA quando o laço agêntico estoura `maxIteracoes`
 * (o genos lança `Max iterations exceeded (N)`). Mesmo texto da V1
 * (`packages/executor/src/executor.js`, `limitReached`). Sem fala sintetizada: quem consome
 * (`fabrica/turno.js`) acrescenta ao chat; a resposta falada é a que o modelo já deu.
 * Só vale com `config.aterrissarNoTeto: true` (opt-in; default `false` = o erro sobe).
 */
export const AVISO_TETO_DE_ITERACOES = 'Atingi o limite de tentativas desta ação e não consegui concluir tudo. Quer que eu continue tentando ou prefere seguir de outra forma?';

export function criarOrquestrador(config) {
  // Task 9 (spec "decisor por anel: refinadores do kairos", R1): `aoDescobrir` (J3),
  // `prazoDoDecisorMs` e `tetoDoDecisor` saíram — o decisor entre o discover e a montagem do
  // prompt, que rodava DEPOIS do discover e disparava um segundo `bridge.prepareTurn` por fora
  // para aplicar o que pediu, foi substituído pelo refino por anel do kairos 0.833
  // (`config.refinadores`/`config.refino`, ver JSDoc de `ConfigDoOrquestrador` acima): o
  // refinador roda DENTRO do próprio `discover()`, sem turno extra. FALHA ALTA aqui, e não um
  // aviso — um host que ainda passa a config antiga (perfil não migrado) ficaria mudo em
  // silêncio: `aoDescobrir` nunca seria chamado, e nada avisaria que o decisor parou de rodar.
  if (config.aoDescobrir !== undefined || config.prazoDoDecisorMs !== undefined || config.tetoDoDecisor !== undefined) {
    throw new TypeError(
      'ConfigDoOrquestrador.aoDescobrir/prazoDoDecisorMs/tetoDoDecisor foram removidos: use '
      + 'refinadores/refino (kairos 0.833)',
    );
  }

  // O protocolo vem ANTES das seções do perfil de propósito: é a parte que
  // menos muda de todas, e o prompt-builder monta o system por volatilidade
  // crescente — o que muda menos fica mais no topo. Com `mecanicaNoCatalogo`,
  // identidade e comportamento abrem o system e a mecânica vai para o catálogo.
  const mecanicaNoCatalogo = config.mecanicaNoCatalogo === true;
  const estrategia = resolverProtocolo(config.protocolo, config.protocoloOpts);
  const construtor = criarConstrutorDePrompt({
    base: (ctx) => [...(ctx.__secoesExtra || []), ...config.base(ctx)],
    ...(mecanicaNoCatalogo ? { mecanicaNoCatalogo: true, estrategia } : {}),
    ...(config.legendas ? { legendas: config.legendas } : {}),
    ...(config.nomes ? { nomes: config.nomes } : {}),
    // Estabilização do cache (spec 2026-10-15): o host escolhe o layout do bloco de capacidades
    // e onde ele pousa na faixa estável. Sem estes campos, o comportamento é o de antes.
    ...(config.layoutDasCapacidades ? { layoutDasCapacidades: config.layoutDasCapacidades } : {}),
    ...(config.prioridadeDasCapacidades !== undefined ? { prioridadeDasCapacidades: config.prioridadeDasCapacidades } : {}),
  });
  const decorar = config.decorarTool || IDENTIDADE;
  // Cauda efêmera / despejo (spec 2026-10-29): `config.despejo` ausente ou inválido = padrão (tudo desligado).
  // Motivos de normalização saem uma vez, na criação — nunca derrubam o orquestrador.
  const { config: despejoCfg, motivos: motivosDoDespejo } = normalizarDespejo(config.despejo);
  for (const motivo of motivosDoDespejo) console.warn('[fabrica] despejo:', motivo);
  const despejoLigado = despejoCfg.cauda || despejoCfg.despejo;
  // Ids de capacidade do piso (`piso` default true — capacidades.js): nunca vão para a cauda nem são descartadas.
  const pisoIds = new Set(config.capacidades.filter((c) => c.piso !== false).map((c) => c.id));
  const maxIteracoes = config.maxIteracoes ?? 12;
  const limiteDeTools = config.limiteDeTools ?? 6;
  // Sem valor, vale o default do genos ('json'). O host que mostra a resposta ao vivo pede
  // 'streaming' — o perfil do chat da fábrica (executor/.../fabrica/perfil.js) pede.
  const outputMode = config.outputMode;
  // `prefixarTools` (ver CapacidadeDeclarada, capacidades.js) é decidido POR
  // CAPACIDADE — este mapa evita reler `config.capacidades` a cada tool nos
  // dois lugares abaixo que precisam saber (linhasDeIndice, reconstruirBlocosDoTurno).
  const prefixarPorCapacidade = new Map(
    config.capacidades.map((cap) => [cap.id, cap.prefixarTools !== false]),
  );
  const capPorNomeExposto = new Map();
  for (const cap of config.capacidades) {
    const prefixar = cap.prefixarTools !== false;
    for (const tool of cap.tools || []) {
      capPorNomeExposto.set(nomeExposto(cap.id, tool.name, { prefixar }), cap);
    }
  }
  const ehMcpGenerico = (c) => c?.mcp?.generico === true;

  // Nome cru repetido entre capacidades (ou igual a um nome exposto) não vira sinônimo: o prefixado continua valendo.
  // Avisa na criação, dizendo quem colidiu — sem isto, um power novo com nome repetido só apareceria como "Unknown tool".
  // Desde 2026-10-17: não avisa quando todos os nomes da colisão forem de capacidades MCP genéricas (spec §3.2).
  const sinonimosDoCatalogo = sinonimosCrus(toolsExpostas(config.capacidades));
  for (const { cru, nomes } of sinonimosDoCatalogo.colisoes) {
    const todosMcp = nomes.length > 0 && nomes.every((n) => ehMcpGenerico(capPorNomeExposto.get(n)));
    if (!todosMcp) {
      console.warn(`[orquestrador] nome cru "${cru}" repetido (${nomes.join(', ')}) — sem sinônimo; só o nome prefixado resolve`);
    }
  }
  // Mudança 1 (2026-09-18): `CapacidadeDeclarada.prioridade` é opcional — só
  // entram aqui as capacidades que de fato declararam um valor. O construtor de
  // prompt não conhece `config.capacidades` (só recebe `id`s pelo índice/turno),
  // então este mapa é a ponte: quem não está aqui cai no default do builder.
  const prioridadePorCapacidade = new Map(
    config.capacidades
      .filter((cap) => typeof cap.prioridade === 'number')
      .map((cap) => [cap.id, cap.prioridade]),
  );

  // Catálogo montado UMA vez: manager e índice não dependem de quem fala.
  // Memoiza a PROMISE, não o valor resolvido — dois `executarTurno` concorrentes
  // no primeiro turno (antes de a promise assentar) precisam esperar a MESMA
  // montagem, e não disparar `createManager` + `reindex()` duas vezes (`reindex`
  // é índice vetorial com o embedder do host (o Kairos 0.836 não tem modelo próprio) — caro, e um bridge órfão sobraria do
  // segundo). Mesmo padrão do Ariadne (`orquestrador/motor.ts#montarUmaVez`).
  let catalogo = null;

  function montarCatalogo() {
    if (catalogo) return catalogo;
    const promessa = (async () => {
      // `undefined` (o host ESQUECEU) e `null` (o host SABE) são coisas
      // diferentes, e tratá-los igual matava um host legítimo.
      //
      // A trava recusava qualquer catálogo semântico sem embedder, dizendo que
      // "o ranking não tem como rodar". Isso é FALSO, e a fonte está no
      // kairos: `rank-providers.js` pula o piso absoluto quando
      // `queryEmbedding === null`, exatamente para não matar o fallback léxico
      // (§6.6, comentado lá). O orquestrador de tela do Ariadne depende disso
      // em produção — o modelo de embeddings são ~470MB que um container pode
      // não conseguir baixar, e o host então passa `embedder: null` (desde o Kairos 0.836 o
      // embedder vem SEMPRE do host; o Kairos não carrega modelo) e segue ranqueando pelo léxico.
      //
      // Com a trava velha, a mesma falha de rede que o V1 sobrevive derrubaria
      // o chat inteiro — e no boot, não no turno. O valor real da trava é pegar
      // quem esqueceu de passar o embedder; esse valor fica.
      const embedderCru = config.embedder ?? null;
      if (config.embedder === undefined && !tudoPiso(config.capacidades)) {
        throw new Error(
          'há capacidade semântica (piso: false) e nenhum embedder — o ranking não tem como rodar. '
          + 'Passe `embedder`, marque todas as capacidades como piso, ou passe `embedder: null` '
          + 'explicitamente para aceitar o modo degradado (ranking só pelo léxico).',
        );
      }
      // Cache de embeddings do CATÁLOGO por PROCESSO (`cache-catalogo.js` — ver JSDoc lá para o
      // porquê: custo medido, e por que não compartilhar o `manager` inteiro entre sessões).
      // Envolve SÓ os embeds de `role: 'passage'` — o `reindex()` do kairos logo abaixo passa a
      // reusar, entre TODAS as sessões do processo, o vetor de qualquer capacidade cujo texto
      // semântico e embedder não mudaram desde a última vez. Embeds de `'query'` (a pergunta do
      // usuário, mais abaixo em `executarTurno`) atravessam sem cache — mesmo comportamento de
      // antes.
      //
      // B1.5: por baixo desse cache de processo há o de DISCO (`cache-catalogo-disco.js`), que
      // sobrevive ao reinício do processo — o aquecimento do boot grava o que embedou e a sessão
      // seguinte, em outro processo, lê do arquivo em vez de reembedar. O `WeakMap` de
      // `envolverEmbedderComCache` é chaveado pelo objeto que recebe, e `cacheDoCatalogoEmDisco`
      // devolve SEMPRE o mesmo wrapper para o mesmo embedder cru (e mesmo arquivo) — é isso que
      // mantém o bucket compartilhado entre esta sessão, a próxima e o aquecimento. `arquivoCache`
      // ausente = só memória, exatamente como antes.
      const disco = embedderCru ? cacheDoCatalogoEmDisco(embedderCru, { arquivo: config.catalogoCache?.arquivoCache }) : null;
      const embedder = embedderCru ? envolverEmbedderComCache(disco.embedder) : null;
      // A guarda acima pega "quer ranquear e não tem com quê". Esta pega o
      // caso pior, porque é silencioso: ranqueia, mas sobre um documento
      // montado só com a `descricao` — texto escrito para humano ler.
      //
      // Foi o defeito medido no pipeline V2 do Ariadne (pendência
      // 2026-09-12, pipeline 64dd4273): nenhuma capacidade declarava
      // `semanticText` nem `awareness`, o ranking não ofereceu candidato
      // nenhum, o modelo chamou tool que nunca hidratou e o prompt passou a
      // compensar com nomes literais de tool. Nada disso apareceu como erro —
      // por isso a recusa é aqui, e não um aviso.
      //
      // VEM DEPOIS da guarda do embedder de propósito: `test/fabrica.test.js:234`
      // declara `piso: false` sem embedder e sem `semanticText`, e a mensagem
      // que aquele teste espera é a do embedder.
      const semDocumento = config.capacidades
        .filter((cap) => cap.piso === false && !cap.semanticText)
        .map((cap) => cap.id);
      if (semDocumento.length) {
        throw new Error(
          `capacidade semântica (piso: false) sem \`semanticText\`: ${semDocumento.join(', ')}. `
          + 'O ranking pontuaria um documento montado só com a `descricao`, que é escrita para o '
          + 'modelo LER, não para casar com a pergunta do usuário. Declare `semanticText` (e, de '
          + 'preferência, `awareness.useWhen`), ou marque a capacidade como `piso: true` para '
          + 'tirá-la do ranking.',
        );
      }
      // Gate de permissão por tool — chamado pelo kairos a cada discover
      // (rank/hydrate) e de novo aqui embaixo na ponte genos (`createGenosBridge`),
      // com a MESMA função: os dois precisam concordar, senão uma tool aparece
      // consciente no discover e o dispatcher a recusa (ou o oposto). Default
      // `() => true` é o comportamento de antes desta lacuna existir — retrocompatível.
      const can = config.can ?? (() => true);
      // Spec do porte (§5.4): quando `config.calibracao.ativa`, os limiares que ALIMENTAM o
      // `createManager` abaixo vêm de `calibrarLimiares` (a MESMA função do calibrador de linha
      // de comando — `packages/powers/porte/calibrar.mjs`) rodada sobre os exemplos das
      // capacidades ATIVAS deste catálogo, com o MESMO embedder do turno. `config.limiares`
      // (o objeto estático, ex. `LIMIARES_CHAT`) vira o `padrao`: usado como está quando não há
      // exemplo suficiente (`origem: 'padrao'`), e como base para os campos que o cálculo não
      // determina (ex.: `rawFloor`) quando há (`origem: 'calculado'`). O cálculo em si é
      // memoizado por PROCESSO (`limiaresEmCache`, `cache-catalogo.js`) — chave = modelo do
      // embedder + ids das capacidades + hash dos exemplos, para duas sessões concorrentes com o
      // MESMO conjunto ativo não pagarem o custo duas vezes. `config.calibracao.override` (uso de
      // teste/depuração) sobrescreve o resultado inteiro, valores por valor, com origem `override`.
      // Achado 2 da revisão da Fase 2: `limiaresDoConjunto` (fatorada logo acima de
      // `aquecerCatalogo`) é a MESMA função que `aquecerCatalogo` chama no boot — quem chegar
      // primeiro (boot ou este turno) paga o custo; o outro reusa a promessa de `limiaresEmCache`.
      //
      // M5 (revisão do conjunto, item 4): a chave de `limiaresEmCache` (dentro de
      // `limiaresDoConjunto`) hasheia `exemplosDasCapacidades(config.capacidades)` — que inclui os
      // exemplos de HABILIDADE, só presentes depois que `cap.skillsDeclaradas` é populado (efeito
      // colateral de `registrarCapacidadesNoManager`, mais abaixo). `aquecerCatalogo` já registra
      // ANTES de calibrar (mesma ordem: registro → calibração); aqui a calibração rodava ANTES do
      // registro — a chave calculada no boot (aquecimento, registro já feito) e a calculada aqui
      // no primeiro turno real (registro ainda por fazer) divergiam sempre que alguma capacidade
      // tivesse skill com exemplo, e o aquecimento do boot nunca "pegava" no primeiro turno.
      // Registro DESCARTÁVEL (embedder/thresholds nunca importam — só o efeito colateral em
      // `cap.skillsDeclaradas`, nunca chamamos `discover()` neste manager) ANTES de calibrar,
      // igualando a ordem; o registro de verdade (`registrarCapacidadesNoManager(manager, ...)`,
      // logo abaixo) reusa `skillsDeclaradas` já populado (guarda de idempotência dentro de
      // `registrarCapacidadesNoManager`) — não paga `fonte.skills()` duas vezes.
      if (config.calibracao?.ativa && embedderCru) {
        const managerDescartavel = createManager({ embedder: null, can: () => true, skills: { activation: 'none' } });
        await registrarCapacidadesNoManager(managerDescartavel, config.capacidades);
      }
      const { infoLimiares, msCalibracao } = await limiaresDoConjunto(config, embedderCru);
      // `limiares` é aditivo: só chega ao kairos quando o host declara algo. `tool` é
      // extraído à parte porque tem forma PRÓPRIA (`{ hydrate?, topKPerProvider? }`,
      // repassado direto) — os demais campos (`zFull`/`zCandidate`/`rawFloor`) vão JUNTOS
      // como `thresholds.provider` (default da estratégia como base, override por chave; o
      // kairos lança se receber zFull/zCandidate sem rawFloor, ver JSDoc de `limiares`
      // acima). `thresholds.tool` é honrado pelo kairos desde 0.831 (hidratação de FUNÇÃO,
      // `hydrate`/`topKPerProvider` — antes era aceito e ignorado). `skill` (kairos 0.835,
      // Task 5 do loop do Jev) tem régua própria — ver `opcoesDeLimiares`. Nota: para
      // `config.limiares = {}` (objeto vazio, sem call site real hoje) o código antigo
      // passava `thresholds: {}`; `opcoesDeLimiares` não passa a chave — equivalente para
      // o kairos (nenhum threshold real muda), comportamento novo mantido.
      const manager = createManager({
        embedder,
        can,
        ...opcoesDeSemantica(config.semantica),
        ...opcoesDeLimiares(infoLimiares.valores),
        // Task 9 (spec "decisor por anel: refinadores do kairos", R1/R4/R6): refino por anel do
        // kairos 0.833 — substitui o gancho `aoDescobrir` (J3) e o segundo `bridge.prepareTurn`
        // que ele disparava por fora. `refiners` só entra quando o host declarou algo (ausente ⇒
        // saída idêntica à de antes do refino, R1). `refinerBudgetMs`/`refinersBudgetMs` só
        // entram quando `config.refino` os declara — omitidos, o kairos usa os próprios defaults
        // (`DEFAULT_REFINER_BUDGET_MS`=600, `DEFAULT_REFINERS_BUDGET_MS`=800).
        ...(config.refinadores ? { refiners: config.refinadores } : {}),
        ...(config.refino?.prazoMs !== undefined ? { refinerBudgetMs: config.refino.prazoMs } : {}),
        ...(config.refino?.prazoGeralMs !== undefined ? { refinersBudgetMs: config.refino.prazoGeralMs } : {}),
        // R6: ativação de skill pelo HOST, sempre `'host'` — não é opcional aqui (ver
        // `createGenosBridge`/`applySessionPolicy` mais abaixo): sem isto, `skills.activate`
        // promovido por um refinador do anel `skill` faria o kairos renderizar o corpo da skill
        // DIRETO no system, duplicando o que `aoSemear`/`hab_carregar` já fazem pelo canal que o
        // host controla. `maxActivate` (teto duro de skills que o refinador pode marcar `full`)
        // segue configurável, default do kairos (2) quando ausente.
        skills: {
          activation: 'host',
          ...(config.refino?.maxActivate !== undefined ? { maxActivate: config.refino.maxActivate } : {}),
        },
        ...(config.refino?.candidateProvidersForRefine !== undefined
          ? { tool: { candidateProvidersForRefine: config.refino.candidateProvidersForRefine } }
          : {}),
      });
      await registrarCapacidadesNoManager(manager, config.capacidades);
      // As `contribuicoes` NÃO são uma capacidade: o modelo não chama nada
      // aqui, só lê. Por isso entram num provider PRÓPRIO — `informacoes`, não
      // `contexto` nem o id de nenhuma capacidade de verdade — e não como
      // `contributions` penduradas num provider de capacidade qualquer.
      //
      // Duas razões para o provider próprio, e as duas vêm do mesmo lugar:
      // `rank-providers.ts` pula provider `always` de propósito ("always não
      // disputa ranking — hidrata sempre"). Se as contribuições morassem no
      // provider de uma capacidade que TAMBÉM tem tools ranqueáveis
      // (`piso: false`), marcar esse provider como `always` tiraria a
      // capacidade inteira do ranking para sempre — o efeito colateral que
      // o comentário do Ariadne chama de "hub": descrição curta e genérica
      // (a da contribuição) ficando sempre carregada e vencendo capacidades
      // específicas por omissão, não por relevância. Um provider dedicado
      // isola o efeito `always` no que É, de fato, sempre necessário.
      //
      // No Igris isso importa duas vezes: (1) o catálogo fechado (só
      // capacidades piso) do Bug 1 depende de o agente SABER que aquelas
      // tools existem desde o primeiro turno — e ele só sabe pelo que está
      // no prompt, não pelo ranking; (2) um agente com capacidades piso E
      // semânticas ao mesmo tempo (ex.: um agente de banco com tools fixas
      // de sistema mais busca semântica sobre dados) não pode ter uma
      // contribuição de piso decidindo, de graça, que uma tool específica
      // nunca aparece pra concorrer.
      // `contribuicoesSemanticas` guarda as `floor: false` cruas — não viram
      // `Contribution` no registry do kairos (ver comentário acima do bloco
      // de piso): viram `ConversationItem`, montadas turno a turno em
      // `executarTurno`, porque o `read(ctx)` de uma contribuição semântica
      // só pode rodar contra o `ctx` DAQUELE turno.
      // `pisoDasFontes`: contribuições `floor: true` de `fonte.piso` de CADA capacidade (spec 2
      // §3.1/§3.4 passo 3) — somadas às de `config.contribuicoes` e validadas pela MESMA guarda
      // abaixo, não uma cópia dela. Capacidade sem `fonte`, ou com `fonte` sem `piso`, não
      // contribui nada aqui (`?? []`). `selecionar`/`aoFechar` da fonte são Task 6 — esta task
      // só cataloga piso e skills.
      const pisoDasFontes = config.capacidades.flatMap((c) => c.fonte?.piso ?? []);
      let contribuicoesSemanticas = [];
      if (config.contribuicoes?.length || pisoDasFontes.length) {
        // União ANTES de validar — as fontes entram no MESMO catálogo que `config.contribuicoes`,
        // então a validação abaixo (floor booleano, `volatil` obrigatório em piso, formato de
        // `ref` em semântica) precisa valer para as duas origens. Duplicar a validação por
        // origem reabriria a mesma lacuna que a validação única já fecha.
        const todasContribuicoes = [...(config.contribuicoes ?? []), ...pisoDasFontes];

        // VEM ANTES das demais, de propósito: uma contribuição sem `floor`
        // declarado como boolean (ausente, ou qualquer coisa que não seja
        // exatamente `true`/`false`) é o esquecimento mais provável — e sem
        // saber se é PISO ou SEMÂNTICA a fábrica não tem como decidir nada
        // do que vem depois. Se esta guarda viesse depois de alguma das
        // outras duas, uma contribuição sem `floor` receberia uma mensagem
        // sobre `volatil` ou sobre formato de `ref` que não é a causa raiz.
        const floorInvalido = todasContribuicoes
          .filter((c) => typeof c.floor !== 'boolean')
          .map((c) => c.ref);
        if (floorInvalido.length) {
          throw new Error(
            `contribuição sem \`floor\` declarado como boolean: ${floorInvalido.join(', ')}. `
            + 'Declare `floor: true` para conteúdo de PISO — sempre presente, registrado no '
            + 'catálogo do agente — ou `floor: false` para conteúdo SEMÂNTICO — entra por '
            + 'relevância, pelo canal `conversation` do kairos. Omitir o campo (ou passar algo '
            + 'que não é exatamente `true`/`false`) é o esquecimento mais provável, por isso é '
            + 'recusado em vez de assumido como um dos dois.',
          );
        }

        const pisoContribs = todasContribuicoes.filter((c) => c.floor === true);
        const semanticContribs = todasContribuicoes.filter((c) => c.floor === false);

        // O canal `conversation` do kairos exige convenção de TRÊS partes
        // (`<origem>/<kind>/<chave>`) para o `ref` de um `ConversationItem`
        // — fora do formato, o item é REJEITADO EM SILÊNCIO (só um rastro
        // no explain, nunca throw). Sem esta trava aqui, o host acreditaria
        // ter entregue conteúdo que nunca chegou ao prompt — o mesmo
        // defeito que a trava de `floor` original fechava, só que num ponto
        // mais silencioso (nada neste caminho lê o explain do kairos).
        const REF_TRES_PARTES = /^[^/]+\/[^/]+\/[^/]+$/;
        const refFormatoInvalido = semanticContribs
          .filter((c) => typeof c.ref !== 'string' || !REF_TRES_PARTES.test(c.ref))
          .map((c) => c.ref);
        if (refFormatoInvalido.length) {
          throw new Error(
            'contribuição semântica (`floor: false`) com `ref` fora do formato '
            + `\`<origem>/<kind>/<chave>\`: ${refFormatoInvalido.join(', ')}. `
            + 'O canal `conversation` do kairos exige exatamente três segmentos separados por '
            + '"/" — sem isso o item é rejeitado em silêncio (só um rastro no explain), e nunca '
            + 'chega ao prompt.',
          );
        }

        // `volatil` só é cobrado de PISO (ver JSDoc de `contribuicoes`) —
        // daqui em diante toda contribuição de `pisoContribs` já tem
        // `floor === true` (a guarda acima recusou o resto).
        const semVolatilidade = pisoContribs
          .filter((c) => typeof c.volatil !== 'boolean')
          .map((c) => c.ref);
        if (semVolatilidade.length) {
          throw new Error(
            `contribuição de piso sem \`volatil\`: ${semVolatilidade.join(', ')}. `
            + 'Quando o discover é pulado por texto trivial, só o que está declarado volátil é '
            + 'recalculado — o resto é reexibido como estava. Declare `volatil: true` se o '
            + '`read(ctx)` muda dentro da conversa, ou `volatil: false` se não muda. '
            + 'Não declarar deixa o agente lendo piso congelado sem sinal nenhum.',
          );
        }

        if (pisoContribs.length) {
          manager.registry.registerProvider(
            {
              id: 'informacoes',
              name: 'informacoes',
              description: 'Informação de piso da sessão — não é uma capacidade chamável.',
              kind: 'native',
              loading: { always: true },
            },
            // `volatil` é campo da FÁBRICA e não existe no schema de
            // `Contribution` do kairos — o strip é higiene de contrato, não
            // defesa contra um erro em runtime.
            //
            // O kairos instalado hoje NÃO valida o shape de uma contribuição
            // registrada: `registerProvider` (core/registry.ts) guarda
            // `items.contributions` como vieram, sem checar chave desconhecida.
            // `runtime/schema-validate.ts` existe, mas só é usado por
            // `runtime/dispatch.ts` para validar ARGUMENTOS de chamada de tool
            // contra `tool.inputSchema` — nunca para validar a forma de uma
            // Contribution. Repassar `volatil` cru para o kairos não lançaria
            // nada: o campo simplesmente ficaria pendurado ali, ignorado por
            // tudo que lê `Contribution`, e vazaria silenciosamente para quem
            // inspecionar o registry de fora. (Uma versão anterior deste
            // comentário afirmava que o kairos recusaria com "campo não
            // previsto" — essa afirmação veio do caso de ARGUMENTO de tool
            // acima, não se aplica a contribuições, e nunca foi verdade aqui.)
            { contributions: pisoContribs.map(({ volatil: _volatil, ...c }) => c) },
          );
        }

        contribuicoesSemanticas = semanticContribs;
      }
      await manager.reindex();
      entregarSemanticaDoCatalogo(manager, config.aoSemanticaDoCatalogo);
      // B1.5: persiste o que este `reindex()` acabou de embedar, para o próximo processo não
      // pagar o mesmo custo. No-op quando nada embedou novo (o aquecimento do boot costuma ter
      // gravado tudo antes) — e, com `embedder` `null` (modo degradado, só léxico), nem há o que
      // gravar.
      if (disco) await disco.salvar();
      // Fix (Task 5, exceção de escopo autorizada, 2026-09-20): antes só olhava
      // `config.contribuicoes` — o piso das FONTES (`pisoDasFontes`, acima) nunca entrava
      // aqui, então o piso de uma fonte declarado `volatil: true` ficava CONGELADO em
      // turno `unchanged`/trivial (a reconstrução só relê o que está nesta lista). Mesma
      // união (`config.contribuicoes` + `pisoDasFontes`) que alimenta `pisoContribs`
      // acima — recomputada aqui porque `todasContribuicoes` é local ao bloco `if` e não
      // está no escopo deste ponto.
      const refsVolateisDeclaradas = [...(config.contribuicoes ?? []), ...pisoDasFontes]
        .filter((c) => c.floor === true && c.volatil === true)
        .map((c) => c.ref);
      // C3P: a FACHADA de manager (a que intercepta `discover` para publicar a seleção e,
      // desde B3.3 fase 2, para entregar as `hints` da pista de contexto) NÃO é mais criada
      // aqui: ela virou `criarPonteDoTurno` (`./pista-contexto.js`), LOCAL AO TURNO, montada
      // em `executarTurno` — hints são estado de um pedido, não do catálogo, e uma ponte
      // cacheada por processo guardaria a pista do primeiro turno para todos os seguintes.
      // O que este retorno precisa preservar é o que o catálogo É: o manager, a MESMA função
      // `can`, o MESMO embedder, as refs e o cache — nada disso é recalculado por run.
      // Só `discover` é interceptado lá; `registry`/`store`/`emitter`/`reindex`/`prewarm`/
      // `options` são os MESMOS objetos do manager compartilhado (o kairos devolve um objeto
      // literal de fechos — `createManager`, `src/resolve/discover.ts` — sem estado em
      // `this`), então a ponte continua enxergando o mesmo catálogo.
      return {
        manager,
        // Mesma função que `createManager` recebeu acima — repassada para a ponte do turno
        // montar a ponte de genos com a MISMA política de permissão do catálogo (a ponte
        // precisa dela para as meta-tools e para filtrar skills por `requires`).
        can,
        refsVolateisDeclaradas,
        contribuicoesSemanticas,
        // Repassado a `executarTurno` (Task 11, spec F1): a fábrica embeda a pergunta UMA
        // vez lá fora do `createGenosBridge`, para reusar o mesmo vetor nos possíveis dois
        // `prepareTurn` do turno (I3a — provider dono de skill sugerida sem estar carregado —
        // pode disparar um segundo; a promoção de `carregar` das fontes não dispara mais, desde
        // a Task 10).
        embedder,
        // Spec do porte (§5.4): `{ valores, origem, resumo }` dos limiares que ALIMENTARAM este
        // manager — repassado a `executarTurno` para sair no retorno do turno (`limiares`) e no
        // `aoMontar`, e a `tempos.calibracao` (só neste PRIMEIRO turno do processo; memoizado
        // depois, como `tempos.catalogo`).
        infoLimiares,
        msCalibracao,
      };
    })();
    // Falha (ex.: embedder faltando) não pode ficar em cache para sempre — sem
    // resetar ANTES de relançar, toda chamada futura receberia a mesma rejeição
    // até o processo reiniciar. Resetar antes dá à PRÓXIMA chamada uma tentativa nova.
    catalogo = promessa.catch((err) => { catalogo = null; throw err; });
    return catalogo;
  }

  /** Índice completo do registry — a ponte suprime o `#index` de tool hidratada
   *  no mesmo turno, e numa montagem acumulada isso faz a linha entrar atrasada. */
  function linhasDeIndice(manager, conscientes) {
    const itens = [];
    for (const ref of conscientes) {
      const [providerId, , ...resto] = ref.split('/');
      const key = resto.join('/');
      if (!providerId || !key) continue;
      const tool = manager.registry.getTool(providerId, key);
      if (!tool) continue;
      // O atributo name= é o NOME EXPOSTO — o que o modelo chama. O corpo
      // (conteudo) descreve; o atributo endereça. Mesma convenção do Ariadne.
      const prefixar = prefixarPorCapacidade.get(providerId) ?? true;
      // `tool.indexLine` do kairos vem pronto como `${key} — ${description}`
      // (`@okds/kairos/dist/adapters/native.js#defineProvider`) — a KEY CRUA,
      // não o nome exposto. Na linha "carregável" do prompt novo
      // (`renderizarCapacidade`, prompt-builder.js) o atributo `name=`/o nome
      // que abre a linha JÁ é o nome exposto; repetir a key aqui duplicaria
      // (`- dados__descrever — descrever — Catálogo…`). A fábrica CONHECE a
      // key — tira o prefixo aqui, não mexe no kairos.
      const prefixoDoIndice = `${key} — `;
      const conteudo = tool.indexLine.startsWith(prefixoDoIndice)
        ? tool.indexLine.slice(prefixoDoIndice.length)
        : tool.indexLine;
      itens.push({
        ref: `${ref}#index`,
        providerId,
        nome: nomeExposto(providerId, key, { prefixar }),
        conteudo,
      });
    }
    return itens;
  }

  /**
   * Acrescenta ao card de cada capacidade CANDIDATA os nomes expostos das
   * funções dela.
   *
   * A legenda de `nomes.candidatos` (ver `legendas.candidatos` em
   * `prompt-builder.js`) manda "carregue antes de chamar", e o guarda de
   * `registryDoTurno` RECUSA qualquer tool cujo nome exposto não tem manual
   * no prompt acumulado — mas o card que o `@okds/kairos` monta (`buildCard`)
   * é só descrição + `useWhen`/`skipWhen`: diz PARA QUE a capacidade serve,
   * não o que ela TEM. Sem nome nenhum ali, a instrução da legenda é
   * impossível de obedecer — o modelo não tem o que passar para
   * `load_capability`.
   *
   * O nome é o EXPOSTO (`nomeExposto`, honrando `prefixarTools` pelo mesmo
   * `prefixarPorCapacidade` que `linhasDeIndice` já usa), não a `key` crua do
   * registry: é essa string — e só essa — que `load_capability` aceita nas
   * três formas e que o guarda revalida contra `acumulacao...funcoes[].nome`.
   * Um nome cru chamaria "tool não registrada" no guarda por vir com o prefixo
   * errado.
   *
   * O card é efêmero (vive só na mensagem deste turno — `secoesEfemeras` em
   * prompt-builder.js resolve a classe `card` para `destino: 'turno'`, nunca
   * `system`); enriquecê-lo aqui não cria estado novo para acumular. Assim que
   * a capacidade carrega de verdade, o bloco vira `instrucoes`/`indice` no
   * acumulado e este card não aparece mais no turno seguinte.
   */
  function cardsComFuncoes(manager, blocos) {
    return blocos.map((bloco) => {
      if (!bloco.ref.endsWith('/card')) return bloco;
      const providerId = bloco.ref.slice(0, -'/card'.length);
      const tools = manager.registry.listTools(providerId);
      if (tools.length === 0) return bloco;
      const prefixar = prefixarPorCapacidade.get(providerId) ?? true;
      const nomes = tools
        .map((t) => `- ${nomeExposto(t.providerId, t.key, { prefixar })} — ${t.description}`)
        .join('\n');
      return { ...bloco, content: `${bloco.content}\nFunções desta capacidade:\n${nomes}` };
    });
  }

  /**
   * I-A (correção da revisão do conjunto, spec 2026-09-22): tira do card/candidato que vai ao
   * prompt qualquer provider que o discover FINAL deste turno já marcou `providers.load`.
   *
   * 🚨 O kairos (`context-manager/src/resolve/discover.ts` ~l.1029, `candidateProviders`) monta a
   * lista de candidatos a partir da proposta bruta do anel `provider` (`providerApplied.
   * candidates`) — SEM filtrar contra `providersToHydrate`/`state.loadedProviders`. Um provider
   * `piso: false` cuja relevância cai (ou que nunca teve `tier: 'full'` pelo ranking, só entrou em
   * `providers.load` por estar pegajoso na sessão — `state.loadedProviders` — ou por ter acabado de
   * ser promovido NESTE turno, via `load_capability`/o loop do Jev/I3a) continua aparecendo como
   * CANDIDATO. O card diz "carregue antes de chamar" (legenda `candidatos`/`suggested_capabilities`)
   * para uma capacidade que já está carregada — o modelo lia essa instrução contraditória logo
   * abaixo do próprio `tool_result` que ele semeou ao carregar.
   *
   * Medido (prova da revisão, caso C, `carregar_tarefas` seguido de `task_listar`):
   * `discover.providers: {"load":["agenda","tarefas"],"candidates":[{"id":"tarefas",...}]}` — o
   * MESMO discover final que decide o prompt deste turno já tem `tarefas` nos dois lados.
   *
   * `prepared.discoverResult.providers.load` é a fonte da verdade de "carregada" — inclui tanto o
   * que a sessão já carregou em turnos anteriores (é pegajoso, ver comentário em `executarTurno`
   * sobre `idsCandidatos`) quanto o que este turno acabou de promover (I3a, `load_capability`, ou o
   * loop do Jev via `promoverNoTurno` — `prepared` já é reatribuído para o `preparedDoLoop`/
   * `preparedComFontes` final antes deste ponto). Por isso a MESMA correção também cobre o caso
   * entre turnos (capacidade carregada num turno anterior voltando como candidata num turno
   * seguinte): não há um discover "mais final" que este para nenhum dos dois casos.
   *
   * @param {object} discoverResult `prepared.discoverResult` já final (pós I3a/loop deste turno)
   * @param {Array<{ref: string}>} blocos `blocks.turn`
   */
  function semCardsDeCarregados(discoverResult, blocos) {
    const carregados = new Set(discoverResult.providers?.load ?? []);
    if (carregados.size === 0) return blocos;
    return blocos.filter((bloco) => (
      !bloco.ref.endsWith('/card') || !carregados.has(bloco.ref.slice(0, -'/card'.length))
    ));
  }

  /** `applySessionPolicy` (kairos) precisa do `loading` de cada provider
   *  registrado — ela não conhece o registry, então quem chama extrai este
   *  mapa (mesmo padrão do `configDeCarregamento` do Ariadne). */
  function loadingPorProvider(manager) {
    return Object.fromEntries(manager.registry.listProviders().map((p) => [p.id, p.loading ?? {}]));
  }

  /**
   * Promove um conjunto de refs de função + ids de capacidade no discover deste turno:
   * `comCarregadasNoTurno`/`comProvidersNoTurno` sobre o discover BASE, `applySessionPolicy` para
   * fechar um estado hipotético, e um SEGUNDO `bridge.prepareTurn` com esse estado — é isto que
   * faz o provider pedido entrar em `providers.load` e ganhar índice/instruções NESTE MESMO
   * turno.
   *
   * Histórico de quem chamou esta função: nasceu na Task 6 (spec 2 §3.4 passo 4) para as fontes
   * promoverem `carregar`; até a Task 9, o extinto gancho `aoDescobrir` (J3) também a chamava,
   * encadeado em cima. A Task 9 removeu o chamador de `aoDescobrir` (refino por anel do kairos
   * 0.833 não precisa de turno extra). A Task 10 (spec "decisor por anel: refinadores do kairos",
   * R10) removeu o chamador das FONTES: `carregar` das fontes entra no ESTADO do PRIMEIRO
   * `prepareTurn` (`estadoKairosDoTurno`, em `executarTurno`), sem turno extra. O ÚNICO chamador
   * restante é I3a (revisão final do conjunto): o provider dono de uma skill SUGERIDA sem estar
   * carregado — a única promoção que só se descobre DEPOIS de ver o resultado do primeiro
   * discover, porque depende do próprio `discover.skills.suggest`.
   *
   * @param {object} bridge
   * @param {object} manager
   * @param {object} discoverBase discover a partir do qual promover (o `prepared.discoverResult` corrente)
   * @param {Set<string>} refs refs de FUNÇÃO (`comCarregadasNoTurno`)
   * @param {Set<string>} providers ids de CAPACIDADE (`comProvidersNoTurno`)
   * @param {{kairos: object, turno: number}} estadoAnterior
   * @param {string} texto
   * @param {object} ctx
   * @param {object} comVetores
   * @param {Array<object>} itensDeConversa
   */
  async function promoverNoTurno({ bridge, manager, discoverBase, refs, providers, estadoAnterior, texto, ctx, comVetores, itensDeConversa }) {
    const discoverAumentado = comProvidersNoTurno(
      comCarregadasNoTurno(discoverBase, refs, manager),
      providers,
      manager,
    );
    const estadoAplicadoKairos = applySessionPolicy(
      estadoAnterior.kairos,
      discoverAumentado,
      estadoAnterior.turno,
      loadingPorProvider(manager),
      // R6: mesma opção do `kairosFechado` mais abaixo — `skillsActivation: 'host'` em toda
      // chamada de `applySessionPolicy` deste arquivo, para o estado intermediário (usado só
      // como `state` do segundo `prepareTurn` das fontes) não divergir do estado final na forma
      // como trata `skills.activate`.
      { skillsActivation: 'host' },
    );
    // Recálculo sem bônus falso de "uso recente": `applySessionPolicy` registra em `recentUse`
    // tudo de `providers.load` com o turno ATUAL; no segundo discover isso daria `turnsAgo = 0`
    // (`recencyBoost(0) = 0.05`, kairos `resolve/score.ts`) a quem só estava carregado NESTE
    // turno — scores inflados no `explain` gravado. Só o `recentUse` volta ao de ANTES do turno;
    // `loadedProviders`/`loadedSkills` etc. seguem os que a policy atualizou. Vale só para este
    // estado intermediário: o `kairosFechado` (fim do turno) continua registrando o uso do turno.
    const estadoAumentadoKairos = { ...estadoAplicadoKairos, recentUse: estadoAnterior.kairos.recentUse ?? [] };
    // 23/09 (correção: "recarregar o poder no meio do turno refaz a análise inteira"): este
    // `prepareTurn` é o SEGUNDO discover do turno — o kairos chama os refinadores de novo (o
    // anel `tool`, que não é memoizável por turno — `packages/executor/src/orchestration/
    // fabrica/refinadores.js#ANEIS_MEMOIZAVEIS` — paga uma chamada nova ao Jev). `ctx.__promocao`
    // marca ESTE discover como "de promoção", numa CÓPIA de `ctx` — nunca muta o `ctx` do
    // chamador, que segue sendo usado fora desta função. `Object.assign(Object.create(getPrototypeOf(ctx)), ctx, …)`,
    // não `{ ...ctx, … }`: o `ctx` do turno é o ctx do EXECUTOR — no Igris, uma instância de
    // `EventEmitter`, cujo `emit` vive no PROTÓTIPO, não como propriedade própria (mesma
    // pegadinha do comentário "C1" acima, no `executar` do loop) — um spread simples perderia
    // `emit` para quem lê este `ctx` mais adiante no segundo discover. `Object.create` preserva o
    // protótipo (logo `emit`), `Object.assign` copia as próprias propriedades de `ctx` por cima,
    // e `__promocao` entra como própria só nesta cópia. O `ctx` chega intacto a `RefineInput.ctx`
    // no kairos (`context-manager/src/genos/bridge.ts` → `resolve/discover.ts:622`);
    // `packages/decisions/src/refinadores/criar-refinador-jev.js` lê a marca: item já no cache do
    // turno segue idêntico (replay), item sem cache não é perguntado de novo — mantém o
    // `proposedTier` do motor. Ver o comentário espelhado lá.
    const ctxDePromocao = Object.assign(Object.create(Object.getPrototypeOf(ctx ?? {})), ctx, { __promocao: true });
    const prepared = await bridge.prepareTurn({
      text: texto,
      ctx: ctxDePromocao,
      state: estadoAumentadoKairos,
      limits: { tools: limiteDeTools },
      turn: estadoAnterior.turno,
      ...comVetores,
      ...(itensDeConversa.length ? { conversation: { items: itensDeConversa } } : {}),
    });
    return { discoverAumentado, prepared };
  }

  /**
   * M5 (revisão final do conjunto): mescla `renderErrors` de um SEGUNDO `prepareTurn` (fontes
   * promovendo `carregar`/skill) no `renderErrors` acumulado do turno
   * — sem isto, um bloco que falha ao renderizar SÓ no segundo `prepareTurn` (o primeiro nunca o
   * viu, porque ele só entrou no catálogo depois da promoção) nunca aparecia no retorno. Dedup
   * por `(ref, error)` idêntico: o segundo `prepareTurn` reprocessa em cima do primeiro e pode
   * reportar o MESMO erro de novo, para o MESMO bloco.
   * @param {Array<{ref: string, error: string}>} alvo mutado in-place (mesmo array que `onError` já usa)
   * @param {Array<{ref: string, error: string}>|undefined} novos
   */
  function mesclarRenderErrors(alvo, novos) {
    for (const erro of novos ?? []) {
      if (!alvo.some((e) => e.ref === erro.ref && e.error === erro.error)) alvo.push(erro);
    }
  }

  /**
   * F4 (correção da revisão final do conjunto): normaliza o retorno de `config.aoSemear` —
   * aceita o formato ANTIGO (`Array<{id,nome,corpo}>`, só sucessos, compatibilidade com um
   * `aoSemear` de teste/host que nunca reporta falha parcial) e o NOVO
   * (`{ sucessos: Array<{id,nome,corpo}>, falhas: Array<{id,erro}> }`, o que
   * `semearNaMemoriaDeTrabalho` do chat devolve desde esta correção — ver JSDoc de `aoSemear`
   * acima). Qualquer outra forma (`undefined`, `null`, algo sem `sucessos` nem ser array) vira
   * `{ sucessos: [], falhas: [] }` — mesma garantia de "erro do host não derruba o turno" que o
   * resto deste arquivo já dá a `aoEvento`/`aoMontar`/`aoIncluirConversa`.
   * @param {Array<{id:string,nome?:string,corpo?:string}>|{sucessos?:Array,falhas?:Array}|undefined} retorno
   * @returns {{ sucessos: Array<{id:string,nome?:string,corpo?:string}>, falhas: Array<{id:string,erro:*}> }}
   */
  function normalizarRetornoDeSemear(retorno) {
    if (Array.isArray(retorno)) return { sucessos: retorno, falhas: [] };
    if (retorno && typeof retorno === 'object' && Array.isArray(retorno.sucessos)) {
      return { sucessos: retorno.sucessos, falhas: Array.isArray(retorno.falhas) ? retorno.falhas : [] };
    }
    return { sucessos: [], falhas: [] };
  }

  /** Refs de toda tool PINNED de um provider `always` — as tools de
   *  capacidade PISO. `pinned` (não `floor`) é o campo certo aqui: `floor`
   *  numa Tool nunca teve efeito (o kairos rejeita no registro; ver
   *  `core/registry.ts`) — quem hidrata sempre, sem ranking, é `pinned`. */
  function refsDeToolsPiso(manager, { todas = false } = {}) {
    const refs = [];
    for (const provider of manager.registry.listProviders()) {
      if (!provider.loading?.always) continue;
      for (const tool of manager.registry.listTools(provider.id)) {
        // `todas` (D2, spec 2026-10-15): para o ÍNDICE do turno trivial — a mesma lista que um
        // provider carregado ganha num turno normal (`comProvidersNoTurno`: todas as tools dele).
        // O manual continua só das `pinned` (`reconstruirBlocosDoTurno`).
        if (todas || tool.pinned) refs.push(tool.ref);
      }
    }
    return refs;
  }

  /**
   * Reconstrói o que o discover teria produzido, para o turno em que ele foi
   * PULADO por texto trivial. `bridge.prepareTurn` devolve blocos vazios DE
   * PROPÓSITO nesse caso (comentário do pacote: "o host reusa a recomendação
   * anterior — permanência é política dele, não nossa") — correto para um host
   * que já tem tudo acumulado, errado para um catálogo FECHADO cujo primeiro
   * turno é justamente onde ele precisa aparecer (Bug 1).
   *
   * Dois conteúdos, duas regras — e a diferença entre elas é DE PROPÓSITO:
   *
   * 1. Contratos das tools PISO: sempre, INDEPENDENTE de `refsVolateis`. Um
   *    piso é "sempre presente; ranking decide o que entra ALÉM, nunca o que
   *    sai" (`core/types.ts`) — isso vale também para o turno em que o
   *    discover não rodou. Exigir que quem monta o perfil se lembre de listar
   *    cada tool piso em `refsVolateis` só para o catálogo fechado funcionar
   *    reintroduziria, por outra porta, o mesmo defeito que esta correção
   *    fecha: um default que só funciona quando o chamador passa o parâmetro
   *    certo. E não há risco em fazer isso incondicionalmente: `tool.contract()`
   *    não lê `ctx` (é texto determinístico da própria tool — `adapters/
   *    native.ts`), então reconstruí-lo a cada turno trivial é idempotente.
   * 2. Contribuições de piso cujo `ref` está em `refsVolateis`: ao contrário do
   *    contrato de tool, `contribuicao.read(ctx)` PODE ler algo que muda por
   *    turno (a tela aberta, um contador). Sem o host dizer QUAIS são
   *    voláteis, reconstruir a lista inteira a cada turno trivial arriscaria
   *    reintroduzir uma contribuição que outra parte do turno já tirou de
   *    propósito (`remover`, no acumulador) — a tool não corre esse risco
   *    porque não tem `remover` equivalente.
   */
  async function reconstruirBlocosDoTurno({ manager, ctx, refsVolateis, onError, pisoCompleto = false }) {
    const refsVolateisSet = new Set(refsVolateis ?? []);
    /** @type {import('@okds/kairos/assemble').BlockSpec[]} */
    const specs = [];

    for (const provider of manager.registry.listProviders()) {
      // D2 (spec 2026-10-15): a descrição do piso entra já no turno trivial, com o MESMO bloco que a
      // ponte do kairos emite num turno normal (`genos/bridge.js`, `${providerId}/instructions`).
      // Sem isto o turno 2 escreve a descrição dentro do cartão do piso e o prefixo quebra ali.
      if (pisoCompleto && provider.loading?.always && provider.instructions) {
        const instructions = provider.instructions;
        specs.push({
          ref: `${provider.id}/instructions`,
          label: `${provider.name} — instructions`,
          destination: 'system:stable',
          priority: 0,
          render: async () => (typeof instructions === 'function' ? instructions() : instructions),
        });
      }
      if (provider.loading?.always) {
        for (const tool of manager.registry.listTools(provider.id)) {
          if (!tool.pinned) continue;
          specs.push({
            ref: tool.ref,
            label: nomeExposto(tool.providerId, tool.key, {
              prefixar: prefixarPorCapacidade.get(tool.providerId) ?? true,
            }),
            destination: 'turn:context',
            priority: 0,
            render: () => tool.contract(),
          });
        }
      }
      for (const contribuicao of manager.registry.listContributions(provider.id)) {
        if (!contribuicao.floor || !refsVolateisSet.has(contribuicao.ref)) continue;
        specs.push({
          ref: contribuicao.ref,
          label: contribuicao.ref,
          destination: contribuicao.destination ?? 'system:stable',
          priority: contribuicao.priority ?? 50,
          render: (ctxDoRender) => contribuicao.read(ctxDoRender),
        });
      }
    }

    return groupBlocks(await assemble(specs, ctx, onError));
  }

  /**
   * Resultado que o guarda de manual devolve no lugar do handler real — o
   * modelo LÊ isto como o retorno da tool (não é exceção, não vira
   * `tool.failed`). Nomeia `load_capability` porque é a meta-tool da ponte do
   * kairos que resolve o problema, e ela está sempre registrada (regra 5 do
   * `REGRAS.md` — catálogo fechado não perde nada com isso).
   */
  function recusaSemManual(nomeExposto) {
    return {
      erro: 'manual_nao_carregado',
      mensagem: `A função "${nomeExposto}" ainda não tem manual carregado neste prompt — `
        + `chame "load_capability" com o nome dela antes de chamar esta função, para saber `
        + 'os argumentos e as regras.',
    };
  }

  /**
   * O guarda usa `registryDoTurno(bridge, ctx, nomesComManual, registraCapacidades, manager,
   * carregadasNoTurno)`.
   * @param {Set<string>} nomesComManual nomes EXPOSTOS (`funcoes[].nome`) das
   *   funções cujo manual já está no prompt ACUMULADO — não o `discover`
   *   deste turno (que só tem o que hidratou AGORA). Um manual que entrou há
   *   três turnos continua no prompt e continua chamável; é por isso que o
   *   chamador passa o conjunto pronto, calculado a partir de
   *   `acumulacao.system.capacidades[].funcoes[]` (ver `executarTurno`), em
   *   vez de recalculado aqui dentro.
   *
   *   N-guarda (correção fluxo de bug, sessão fbab5b12/22-09): `nomesComManual`
   *   sozinho não basta mais — ele é fixado ANTES do turno rodar, e não
   *   destrava o que `load_capability` carregou NO MEIO do turno. `manager`/
   *   `carregadasNoTurno` (opcionais, ausentes = comportamento antigo) dão ao
   *   guarda uma segunda fonte, RECONSULTADA a cada chamada — ver o comentário
   *   no laço de `registryDoTurno`.
   */
  /**
   * Troca a `ref` interna pelo NOME EXPOSTO nos resultados da busca.
   *
   * O modelo não deve ver duas grafias da mesma função. A ref interna
   * (`provider/tool/key`) continua existindo por dentro — é a identidade do
   * registry —, mas nunca chega ao prompt nem a um retorno de tool.
   *
   * @param {unknown} saida o retorno cru de `search_capabilities`
   */
  function comNomeExposto(saida) {
    const hits = saida && typeof saida === 'object' ? saida.hits : null;
    if (!Array.isArray(hits)) return saida;
    return {
      ...saida,
      hits: hits.map((h) => {
        const [providerId, , ...resto] = String(h?.ref ?? '').split('/');
        const key = resto.join('/');
        if (!providerId || !key) return h;
        const prefixar = prefixarPorCapacidade.get(providerId) ?? true;
        return { ...h, ref: nomeExposto(providerId, key, { prefixar }) };
      }),
    };
  }

  /** Ids das capacidades cujas instruções (`Provider.instructions`) já estão no prompt acumulado. */
  function idsComInstrucoesNoPrompt(acumulacao, cauda = []) {
    // Com a cauda, as instruções também chegam na mensagem do turno (`descricao` da capacidade na cauda).
    return new Set([
      ...(acumulacao?.system?.capacidades ?? []).filter((c) => c?.descricao).map((c) => c.id),
      ...cauda.filter((c) => c.descricao).map((c) => c.id),
    ]);
  }

  /**
   * Instruções da capacidade junto do manual do `load_capability` (dono, 10/10, sessão efd02127): a capacidade que entra
   * NO MEIO do turno só trazia os contratos das funções — o `prompt.md` do poder (no caso, as "duas cadências" do quadro
   * visual: uma etapa por chamada, fala com `await`) só chegaria no turno seguinte. Vai uma vez por capacidade no turno, e
   * nunca para quem já tem as instruções no prompt.
   */
  function comInstrucoesDaCapacidade(texto, entregues) {
    if (typeof texto !== 'string') return texto;
    const ids = new Set();
    for (const m of texto.matchAll(/^## (\S+?)__\S+$/gm)) ids.add(m[1]);
    for (const m of texto.matchAll(/^## (\S+)$/gm)) {
      const dono = config.capacidades.find((c) => c.prefixarTools === false && (c.tools || []).some((t) => t.name === m[1]));
      if (dono) ids.add(dono.id);
    }
    const blocos = [];
    for (const id of ids) {
      if (entregues.has(id)) continue;
      const cap = config.capacidades.find((c) => c.id === id);
      if (!cap?.instrucoes) continue;
      entregues.add(id);
      blocos.push(`## Instruções da capacidade ${id}\n${cap.instrucoes}`);
    }
    return blocos.length ? `${blocos.join('\n\n')}\n\n${texto}` : texto;
  }

  /** Manual do `load_capability` (texto do kairos): troca o cabeçalho `## <provider>__<key>` pelo nome exposto da fábrica. */
  function manualComNomeExposto(saida) {
    if (typeof saida !== 'string') return saida;
    return saida.replace(/^## (\S+?)__(\S+)$/gm, (linha, providerId, key) => (
      prefixarPorCapacidade.has(providerId)
        ? `## ${nomeExposto(providerId, key, { prefixar: prefixarPorCapacidade.get(providerId) })}`
        : linha
    ));
  }

  /**
   * N-guarda (correção fluxo de bug, sessão fbab5b12/22-09): traduz refs cruas
   * (as três formas que `load_capability` aceita: key, ref completa `provider/
   * tool/key`, nome exposto) pedidas DURANTE o turno para o conjunto de NOMES
   * EXPOSTOS que elas destravam — mesma tradução de `comCarregadasNoTurno`
   * (acima), aqui só para uso do guarda de `registryDoTurno`.
   * @param {Iterable<string>} pedidas
   * @param {object} manager
   * @returns {Set<string>}
   */
  function nomesExpostosCarregadosNoTurno(pedidas, manager) {
    const nomes = new Set();
    const porNome = mapaDeNomesDoRegistry(manager);
    for (const pedida of pedidas) {
      const alvo = porNome.get(pedida);
      if (!alvo) continue;
      const key = alvo.ref.split('/').slice(2).join('/');
      const prefixar = prefixarPorCapacidade.get(alvo.provider) ?? true;
      nomes.add(nomeExposto(alvo.provider, key, { prefixar }));
    }
    return nomes;
  }

  /**
   * Copia as propriedades próprias E herdadas (string e symbol, enumeráveis) de `ctx` para um objeto plano.
   * O spread (`{ ...ctx }`) só copia as próprias; o ctx de uma chamada interna de roteiro é derivado por
   * protótipo do ctx do genos (`criarCallTool`, `Object.create(toolCtx)`) — sem achatar, `emit`/`signal`
   * sumiriam ao entrar no handler da tool.
   * @param {object|null|undefined} ctx
   */
  function achatarCtx(ctx) {
    const plano = {};
    for (let o = ctx; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const chave of Reflect.ownKeys(o)) {
        if (Object.hasOwn(plano, chave) || !Object.prototype.propertyIsEnumerable.call(o, chave)) continue;
        plano[chave] = o[chave];
      }
    }
    return plano;
  }

  function registryDoTurno(bridge, ctx, nomesComManual, registraCapacidades, manager, carregadasNoTurno, idsComInstrucoes = new Set(), recusadas = null) {
    const registry = new ToolRegistry();
    // Instruções de capacidade já entregues NESTE turno pelo `load_capability` (uma vez por capacidade).
    const instrucoesEntregues = new Set(idsComInstrucoes);
    // As meta-tools do bridge (`load_capability`, `search_capabilities`,
    // `call_capability`) NUNCA são guardadas — são a saída de emergência do
    // modelo (é `load_capability` que resolve a recusa abaixo), e uma saída
    // de emergência que dependesse de si mesma para abrir não seria saída
    // nenhuma. Este laço fica como estava, de propósito.
    for (const [nome, definicao] of bridge.tools.entries()) {
      const original = definicao.handler;
      const comCtx = {
        ...definicao,
        handler: async (args, ctxDoGenos) => {
          // Mesma precedência do caminho direto (`handlerReal`): `achatarCtx` para não perder `emit`/`signal` herdados por
          // protótipo (chamada interna de roteiro) e `toolsDoTurno` = ESTE registry, para que um poder com `recebeCallTool`
          // (roteiros) chamado via `call_capability` alcance as tools — sem ele, `sem_call_tool`.
          const contexto = { ...achatarCtx(ctxDoGenos), ...ctx, toolsDoTurno: registry };
          // A identidade da chamada, transportada pela meta-tool (revisão do
          // bloco A, item 2). `call_capability` NÃO é uma tool como as outras: o
          // que o modelo chama é a meta-tool, e é a meta-tool que abre o
          // registro/captura — mas o HANDLER que roda é o da capability alvo,
          // cujo nome cru é outro (`task_listar` ≠ `call_capability`). Sem levar
          // a identidade junto, o depósito do retorno saía numa chave que ninguém
          // retirava: a chamada ficava sem resultado (`hasResult:false`), sem
          // dono (o `powerId` é procurado pelo nome exposto, e aqui o nome é a
          // ref interna), com o status do DESPACHO em vez do RETORNO (uma
          // chamada que devolveu `{ok:false,…}` era registrada como sucesso) e
          // com o custo declarado pela tool perdido.
          //
          // A marca viaja no `ctx` que o dispatcher repassa ao handler da
          // capability (`dispatch.js#call`), e é lida pelo embrulho de captura do
          // host (`tool-call-capture.js`, via `beginToolCall`/`holdToolResult`).
          // Só `call_capability` marca: as outras duas meta-tools não executam
          // tool de capacidade, e `load_capability`/`search_capabilities` não
          // podem virar a chave de um registro alheio.
          if (nome === 'call_capability') {
            contexto.metaToolDaChamada = { nome, ref: typeof args?.ref === 'string' ? args.ref : null };
          }
          const saida = await original(args, contexto);
          // 🚨 UM NOME SÓ. O prompt anuncia `<function name="codigo__ler_codigo">`
          // (nome exposto), e o `search_capabilities` do kairos devolvia
          // `"ref": "codigo/tool/ler_codigo"` — a ref interna. Dois nomes para
          // a mesma função no mesmo turno, e o modelo usa o que viu por último:
          // medido, ele chamou `load_capability` ora com um, ora com o outro,
          // e repetiu a chamada porque não tinha como saber que eram a mesma
          // coisa.
          //
          // O resolvedor aceita as três formas, então nada QUEBRAVA — só
          // custava voltas. Traduzir aqui é o lugar certo: quem define a
          // convenção de nome exposto é a fábrica (`nomeExposto`), não o kairos.
          // O mesmo vale para o manual do `load_capability`: o kairos escreve o cabeçalho de cada função com o `exposedName`
          // DELE (`## <provider>__<key>`, sempre prefixado), e a capacidade com `prefixarTools: false` (os poderes da fábrica)
          // está no registry pelo nome cru. Medido (sessão fd97c8ba, 2026-10-10): o modelo chamou o nome do cabeçalho, tomou
          // "Unknown tool" e só passou na volta seguinte, por `call_capability`.
          if (nome === 'search_capabilities') return comNomeExposto(saida);
          if (nome === 'load_capability') return comInstrucoesDaCapacidade(manualComNomeExposto(saida), instrucoesEntregues);
          return saida;
        },
      };
      registry.register(nome, decorar(nome, comCtx));
    }
    // As tools das capacidades entram TAMBÉM no registry do genos, sob o nome
    // exposto — é ele que o bloco de funções anuncia (atributo name=), e é
    // ele que o modelo chama. Sem isto, o modelo faria o que o prompt ensina e
    // o genos responderia "tool desconhecida": o prompt anuncia `agenda__listar`,
    // não `call_capability`. Registro ≠ anúncio: registrar todas é barato; o
    // que o modelo conhece é o que o acumulador pôs no prompt.
    //
    // Mas registrar todas TAMBÉM abre a porta para o modelo chamar uma cujo
    // índice ele viu mas cujo MANUAL nunca chegou a hidratar (a anatomia do
    // defeito medido no pipeline V2: `projeto/tool/ler` chamada com `args: {}`
    // e recusada por campo obrigatório ausente) — daí o guarda abaixo, por
    // dentro do handler e ANTES de `decorar(...)`: a decoração do CONSUMIDOR
    // (budget, behaviors — `decorarTool`, ver docblock de `ConfigDoOrquestrador`)
    // fica por fora, enxerga a chamada normalmente e recebe a recusa como
    // resultado, então o rastro do host registra a recusa como qualquer outra
    // chamada. Sem flag de configuração: nos dois perfis do Igris o catálogo é
    // fechado (`tudoPiso` — tudo `piso: true`), então toda tool sempre tem
    // manual (pinned não passa por score) e este guarda nunca dispara — seguro
    // por construção, não por opção.
    // Quem decide e o PROTOCOLO (`estrategia.registraCapacidades`), nao o perfil:
    // em `nativo` o registry e tambem o anuncio (`request.tools`), entao so as
    // tres meta-tools entram e a unica porta e `call_capability`. Em
    // `envelope`/`fence` o adapter nao manda `request.tools` — registrar e de
    // graca e o despacho depende disso.
    if (!registraCapacidades) return registry;

    // N-guarda: pré-computado UMA vez por turno (não por tool, não por chamada)
    // — `carregadasNoTurno` é o MESMO Set mutado pelo `onEvent` de
    // `tool.started` de `load_capability` em `executarTurno`; o handler abaixo
    // relê essa referência A CADA CHAMADA (nunca um valor capturado no
    // instante da montagem do registry), porque `load_capability` pode rodar
    // entre a montagem do registry e a chamada direta seguinte, no MESMO
    // turno. Sem isto — o defeito medido (sessão fbab5b12, interação
    // 34734295): o modelo chamou `load_capability({refs:["task_listas"]})`
    // seguido de `task_listas({})`, e a segunda recusou "manual não
    // carregado" porque `nomesComManual` foi calculado a partir do prompt
    // ACUMULADO ANTES do turno começar (`nomesComManualNoPrompt(acumulacao)`,
    // ver o chamador abaixo) — o par se repetiu (5 chamadas, ~30s) até o
    // modelo desistir e chamar `call_capability` (a meta-tool, nunca
    // guardada) para conseguir executar.
    const expostas = toolsExpostas(config.capacidades);
    // Sinônimo cru (capacidade com `aliasCru`): o mesmo handler sob o nome sem prefixo, quando ele é único.
    const { porCru } = sinonimosCrus(expostas);
    for (const tool of expostas) {
      // `nomeDaChamada` = o nome com que o modelo chamou (exposto ou sinônimo): é a chave com que o host abriu o registro
      // da chamada (`tool.started`), e a captura do resultado precisa depositar sob ela.
      // `toolsDoTurno`: o PRÓPRIO registry do turno (o mesmo que o modelo usa), entregue ao handler para que um
      // poder com `recebeCallTool` (roteiros) alcance as outras tools — `.get(nome)` → `{ handler, argsSchema }`.
      // Vem por último: nem `ctxDoGenos` nem `ctx` do host podem sobrescrever. `achatarCtx` porque o ctx de uma
      // chamada interna de roteiro herda `emit`/`signal` por PROTÓTIPO (`criarCallTool`) e o spread os perderia.
      const handlerReal = (args, ctxDoGenos, nomeDaChamada) => tool.handler(args, {
        ...achatarCtx(ctxDoGenos), ...ctx, nomeDaChamada, toolsDoTurno: registry,
      });
      const handlerSob = (nomeDaChamada) => (args, ctxDoGenos) => {
        const temManual = nomesComManual.has(tool.nome)
          || (carregadasNoTurno && carregadasNoTurno.size > 0
            && nomesExpostosCarregadosNoTurno(carregadasNoTurno, manager).has(tool.nome));
        if (temManual) return handlerReal(args, ctxDoGenos, nomeDaChamada);
        // A recusa volta como `ok: true` para o genos; quem decide promoção por uso precisa saber que NÃO foi uma execução.
        // Pelo nome COM QUE FOI CHAMADA (a operação do turno abre sob ele, e é por ele que `usosDoTurno` procura): o
        // sinônimo cru (`aliasCru`) é outro nome para a mesma função.
        recusadas?.add(tool.nome);
        recusadas?.add(nomeDaChamada);
        return recusaSemManual(tool.nome);
      };
      const definicaoSob = (nomeDaChamada) => ({
        description: tool.description,
        argsSchema: tool.schema,
        effect: tool.effect,
        handler: handlerSob(nomeDaChamada),
      });
      registry.register(tool.nome, decorar(tool.nome, definicaoSob(tool.nome)));
      if (tool.cru && porCru.get(tool.cru) === tool.nome) registry.register(tool.cru, decorar(tool.cru, definicaoSob(tool.cru)));
    }
    return registry;
  }

  /** Nomes EXPOSTOS das funções com manual já hidratado no prompt acumulado
   *  — ver o JSDoc de `registryDoTurno` para o porquê de ser o acumulado e
   *  não o `discoverResult` deste turno. */
  function nomesComManualNoPrompt(acumulacao) {
    const nomes = new Set();
    for (const cap of acumulacao.system.capacidades) {
      for (const funcao of cap.funcoes) {
        if (funcao.manual) nomes.add(funcao.nome);
      }
    }
    return nomes;
  }

  /**
   * Executa um turno.
   *
   * ⚠️ `entrada.historico` (ENTRA) e `retorno.historico` (SAI) são coisas
   * DIFERENTES, mesmo nome, propósitos diferentes — já confundiu gente nesta
   * sessão. O de entrada é o histórico de TURNOS ANTERIORES, verbatim (inclui
   * `tool_result`, quando o chamador tiver): vai para `initialMessages` do
   * genos, entre o system e a mensagem deste turno, sem remontar (ver JSDoc de
   * `EntradaDaMontagem.historico` em prompt-builder.js). O de saída é outra
   * coisa: texto CRU deste turno + o bloco de operações costurado (ver
   * comentário no `return`, abaixo) — a forma que o PRÓXIMO turno deveria
   * mandar de volta como entrada, não o que o genos rodou por dentro.
   * `anexos` e o canal MULTIMODAL desta mensagem: `bloco` descreve os arquivos
   * em texto, `imagens` sao os bytes que o modelo ve. O construtor ja sabia
   * monta-los (`EntradaDaMontagem.anexos`); o que faltava era o repasse daqui.
   * O bloco entra ANTES do texto do usuario, e existe porque sem ele as imagens
   * chegariam anonimas — o `label` de cada uma nao viaja no canal de imagem.
   * @param {{ texto: string, ctx?: object, estado?: object, historico?: object[],
   *           anexos?: { bloco: string, imagens?: object[] },
   *           vetoresDaPergunta?: number[][], embeddingDaPergunta?: number[],
   *           abortSignal?: AbortSignal,
   *           pistaDeContexto?: object, trivial?: boolean, motivoTrivial?: string,
   *           intencaoAnterior?: Array<{funcao: string, capacidade: string, tool: string, effect: string, args?: object}> }} entrada
   *   `vetoresDaPergunta`: consulta já embedada pelo host (um ou mais vetores — crua e
   *   enriquecida; kairos funde pelo máximo). `embeddingDaPergunta` (um vetor) é o nome antigo,
   *   aceito como `[embeddingDaPergunta]`. Sem nenhum dos dois, a fábrica embeda UMA vez aqui
   *   e reaproveita nos dois `prepareTurn` do turno — o kairos nunca reembeda a consulta.
   *   `pistaDeContexto` (B3.3 fase 2): decisão de continuidade JÁ PRONTA, calculada pelo host
   *   (`decidirPistaDeContexto`, no pacote do executor) — `{ aplicar, motivo, regra, pista,
   *   mensagensUsadas, chars }`. A fábrica NÃO decide elegibilidade e NÃO escolhe antecedente:
   *   ela valida a decisão, embeda no máximo UM vetor contextual extra e entrega as `hints`
   *   ao discover deste turno. AUSENTE = contrato antigo no COMPORTAMENTO (nenhum hint,
   *   nenhum embed extra, ranking idêntico); o único acréscimo é a chave neutra
   *   `pistaDeContexto` no retorno/`aoMontar`, que o plano exige sempre. `text` continua o
   *   texto original.
   *   `trivial` (spec 2026-10-14 §4): decisão de trivialidade do host (executor), que tem o contexto
   *   da conversa; ausente = `isTrivial(texto)` do kairos. Vale para o embed daqui e para o discover
   *   de todas as promoções do turno (via `criarPonteDoTurno`). `motivoTrivial`: por que o host decidiu
   *   (vai ao artefato `trivial.motivo`).
   */
  async function executarTurno(entrada) {
    // Mudança 2 (2026-09-23, medição das fases antes do modelo): `t0Turno` é o relógio do turno
    // inteiro; cada fase grava a PRÓPRIA diferença em `tempos`, nunca sobrescreve as outras — ver
    // JSDoc de `aoMontar` (`tempos`) acima para o que cada chave cobre.
    const t0Turno = Date.now();
    const tempos = {
      catalogo: 0,
      calibracao: 0,
      discoverInicial: { total: 0, refinadores: 0 },
      fontesMemoria: 0,
      loop: 0,
      promocao: 0,
      prepareTurnAcumulacao: 0,
      montagemDoPrompt: 0,
      ateOModelo: 0,
    };
    // M4 (revisão do conjunto): `catalogo` (closure de `criarOrquestrador`, ver `let catalogo`
    // acima de `montarCatalogo`) já é truthy quando este turno é o SEGUNDO ou mais a chegar — a
    // promise memoizada resolve para o MESMO objeto sempre, `msCalibracao` incluso, então o
    // fechamento antigo (comentário abaixo) estava ERRADO: `msCalibracao` NÃO vira 0 sozinho nos
    // turnos seguintes, ele carrega o valor medido no turno 1 para sempre (`tempos.calibracao`
    // saía "velho" — maior que `tempos.catalogo`, que É recalculado a cada turno). A checagem
    // abaixo, feita ANTES de `await montarCatalogo()`, é o único jeito de saber se ESTA chamada
    // foi quem pagou o custo (promise ainda não existia) ou só reusou o resultado de outra.
    const catalogoJaMontado = catalogo !== null;
    const {
      manager, can, refsVolateisDeclaradas, contribuicoesSemanticas, embedder, infoLimiares, msCalibracao,
    } = await montarCatalogo();
    tempos.catalogo = Date.now() - t0Turno;
    // Spec do porte (§5.4): só custa de verdade no PRIMEIRO turno do processo para este conjunto
    // de capacidades — turnos seguintes (promise já memoizada antes desta chamada) recebem 0,
    // nunca o `msCalibracao` velho do turno que de fato calculou.
    tempos.calibracao = catalogoJaMontado ? 0 : msCalibracao;
    const ctx = entrada.ctx || {};
    // `kairos` precisa vir no formato de `initialSessionState()` (@okds/kairos/session)
    // — não um literal escrito à mão aqui: sem a chave, `discover()` desreferencia
    // `state.recentUse` de um `undefined` e crasha (ver report do review de Fase 3).
    const estadoAnterior = entrada.estado || { system: systemVazio(), turno: 0, kairos: initialSessionState() };

    // Contribuições semânticas (`floor: false`) viram `ConversationItem` a
    // cada turno — `read(ctx)` só pode rodar agora, contra o `ctx` DESTE
    // turno (mesmo motivo do `contribuicao.read` do caminho de piso, em
    // `reconstruirBlocosDoTurno`). Só os campos que `ConversationItem`
    // conhece são repassados; `floor`/`volatil` ficam para trás (o primeiro
    // já cumpriu seu papel de roteamento em `montarCatalogo`, o segundo é
    // ignorado de propósito para este canal).
    //
    // Um `read` que lança não pode derrubar o turno inteiro por causa de UM
    // item semântico: cai em `renderErrors` — mesma garantia que o resto
    // deste arquivo já dá ao piso — e o turno segue sem aquele item.
    const itensDeConversa = [];
    const errosDeLeituraSemantica = [];
    for (const c of contribuicoesSemanticas) {
      try {
        const content = await c.read(ctx);
        itensDeConversa.push({
          ref: c.ref,
          content,
          ...(c.semanticText !== undefined ? { semanticText: c.semanticText } : {}),
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
          ...(c.destination !== undefined ? { destination: c.destination } : {}),
          ...(c.priority !== undefined ? { priority: c.priority } : {}),
          ...(c.threshold !== undefined ? { threshold: c.threshold } : {}),
          ...(c.requires !== undefined ? { requires: c.requires } : {}),
        });
      } catch (erro) {
        errosDeLeituraSemantica.push({ ref: c.ref, error: String(erro) });
      }
    }

    // `config.conversa(ctx)` — itens DINÂMICOS do canal de conversa, montados
    // pelo HOST a cada turno (registro aberto na tela, emissão em curso — o
    // que muda turno a turno e não faria sentido como contribuição de piso
    // permanente). Somam aos vindos de contribuição semântica (`floor: false`)
    // acima, nunca substituem: os dois laços empurram para o MESMO array.
    //
    // Mesma garantia que o `read()` de uma contribuição semântica já tem: um
    // `conversa()` que lança não derruba o turno inteiro — cai em
    // `renderErrors` (via `errosDeLeituraSemantica`, unido logo abaixo) e o
    // turno segue sem os itens dela.
    if (config.conversa) {
      try {
        const itensDinamicos = await config.conversa(ctx);
        for (const item of itensDinamicos ?? []) itensDeConversa.push(item);
      } catch (erro) {
        errosDeLeituraSemantica.push({ ref: 'conversa/dinamica/erro', error: String(erro) });
      }
    }

    // Colisão de `ref` entre as duas fontes (contribuição semântica e
    // `config.conversa()`) é erro de HOST, não um render que falhou: as duas
    // reivindicariam o MESMO item no canal `conversation`, e uma sobrescreveria
    // a outra em silêncio no `ConversationItem[]` que segue ao kairos — o
    // kairos não tem como saber qual dos dois prevalece. Recusa a montagem do
    // TURNO (não do catálogo, que é por processo e não vê `conversa()`
    // nenhuma), nomeando o `ref` duplicado.
    const refsDeConversaVistos = new Set();
    for (const item of itensDeConversa) {
      if (refsDeConversaVistos.has(item.ref)) {
        throw new Error(
          `ref duplicado no canal de conversa: "${item.ref}" — entregue tanto por contribuição `
          + 'semântica (`floor: false`) quanto por `config.conversa()` no mesmo turno. As duas '
          + 'fontes precisam de `ref`s distintos.',
        );
      }
      refsDeConversaVistos.add(item.ref);
    }

    // Embed único da consulta (Task 11, spec F1): o host pode mandar o vetor pronto
    // (`vetoresDaPergunta`, vários; `embeddingDaPergunta`, um, nome antigo — vira
    // `[embeddingDaPergunta]`). Sem nenhum dos dois, a fábrica embeda a pergunta AQUI, uma
    // única vez, e reaproveita o(s) mesmo(s) vetor(es) nos possíveis dois `prepareTurn` do turno
    // (I3a pode disparar um segundo; a promoção de `carregar` das fontes não dispara mais, desde
    // a Task 10 — ver `estadoKairosDoTurno` mais abaixo).
    //
    // Correção da revisão de qualidade da Fase 4: sem vetor do host, o kairos tenta embedar de
    // novo com o MESMO embedder (é a instância do manager, `discover.ts#discover` — ver
    // `resolve/discover.ts` linhas 486-496 do 0.831) — só degrada para léxico (`degraded:
    // 'no-embedder'`) se essa SEGUNDA tentativa também falhar. A segunda tentativa não entra em
    // `embeds.quantos` (a fábrica não vê o embed interno do kairos) — `embeds.erro` é o rastro
    // de que a primeira, aqui, falhou.
    //
    // I1 (revisão final do conjunto, kairos 0.832): sem vetor do host, se o texto é trivial
    // (`isTrivial`, `@okds/kairos/resolve`, mesma regra que o discover usa para devolver
    // `unchanged` sem rodar) a fábrica NEM tenta embedar — `embeds.origem` vira `'trivial'` e
    // `vetores` fica `null`. `origem` passa a ter quatro valores: `'entrada'` (host mandou),
    // `'fabrica'` (a fábrica tentou embedar aqui), `'nenhum'` (sem embedder configurado),
    // `'trivial'` (texto trivial — nem tentou).
    const embeds = { quantos: 0, ms: 0, origem: entrada.vetoresDaPergunta || entrada.embeddingDaPergunta ? 'entrada' : 'nenhum', erro: null };
    let vetores = entrada.vetoresDaPergunta ?? (entrada.embeddingDaPergunta ? [entrada.embeddingDaPergunta] : null);
    // Consultas que ESTE run já embedou, com o texto EXATO que produziu cada vetor.
    // Serve à pista de contexto (B3.3 fase 2): uma consulta idêntica reusa o vetor em vez de
    // pagar um embed novo (e de anexar um vetor duplicado ao discover).
    // DEFESA, NÃO CAMINHO ATIVO (fix round 1, A6; motivo corrigido no fix round 2): a consulta
    // contextual é `${texto} ${pista}` — na posição em que a consulta BRUTA (`${texto}`) TERMINA
    // ela tem um espaço, e na posição em que a ENRIQUECIDA (`${texto}\n\n${textoEnriquecido}`)
    // tem o primeiro `\n` ela tem um espaço também: as duas têm `\n`/`fim` ali, nunca `' '`.
    // Ou seja, é GEOMÉTRICO: por construção do template, nenhuma das duas pode casar, qualquer
    // que seja a pista (pista vazia daria `"${texto} "`, e `validarDecisao` recusa pista vazia
    // de todo modo). Hoje o reuso é inalcançável no produto (só o teste de unidade o exercita);
    // fica porque é barato e protege um `texto` degenerado. `consultasEmbeddingadas` é `const`
    // dentro de `executarTurno`: um embedder diferente no Turno seguinte não tem com o que casar.
    // Quem mexer aqui NÃO está consertando bug: está decidindo se quer manter a defesa.
    const consultasEmbeddingadas = [];
    // mesma regra `isTrivial` do discover: embedar aqui seria pagar um e5 que o kairos descarta (revisão final I1)
    // (vale também sem embedder: 'trivial' é "nem tentou", e sem embedder também não tentaria)
    // Spec 2026-10-14 §4.2: o host (executor) decide o trivial quando tem contexto (resposta curta a uma
    // pergunta, intenção declarada); sem opinião dele, a regra de sempre.
    const trivialDoTurno = typeof entrada.trivial === 'boolean' ? entrada.trivial : isTrivial(entrada.texto);
    if (!vetores && trivialDoTurno) {
      embeds.origem = 'trivial';
    } else if (!vetores && embedder) {
      const t0 = Date.now();
      try {
        vetores = [await embedder.embed(entrada.texto, 'query')];
        consultasEmbeddingadas.push({ texto: entrada.texto, vetor: vetores[0] });
        embeds.quantos = 1;
        embeds.origem = 'fabrica';
      } catch (erro) {
        vetores = null; // sem vetor: o kairos tenta de novo, e só degrada para léxico se a segunda também falhar
        embeds.origem = 'fabrica';
        embeds.erro = String(erro?.message ?? erro);
      }
      embeds.ms = Date.now() - t0;
    }

    // Passos 3 e 4 (spec 2 §3.1/§3.4, Task 6) — fontes das capacidades. Rodam em PARALELO, com
    // prazo (`prazoDaFonteMs`, default 800ms): uma fonte que estoura ou lança entra sem seleção
    // neste turno (`fontes[].degradado`), o turno nunca cai por causa de UMA fonte. Roda ANTES
    // do primeiro `prepareTurn` por duas razões: (1) o piso da fonte (`fonte.piso[].read(ctx)`,
    // já registrado no catálogo pela Task 5) lê a seleção deste turno por identidade de `ctx` —
    // sem rodar antes, o piso leria a seleção do turno ANTERIOR ou nenhuma; (2) `enriquecer`
    // decide se há um segundo embed (vetor2) ANTES de `comVetores` ser montado, para o PRIMEIRO
    // `prepareTurn` já receber os dois vetores. Roda mesmo com texto trivial (`vetores === null`)
    // — a fonte recebe `vetor1: null` e decide sozinha (memória "sempre"/condição não depende de
    // vetor).
    // Mudança 2: início da fase `fontesMemoria` — cobre a seleção das fontes (`capsComFonte`
    // abaixo), o embed de ENRIQUECIMENTO e o `aoSemear` delas. O embed de enriquecimento tem
    // medição própria em `embeds.ms` — os dois números se referem ao MESMO trabalho, e aqui
    // ele ESTÁ dentro desta janela (é por isso que fechar a janela antes do embed contextual
    // foi a correção; estreitá-la para "tirar medição das fontes" reintroduz a leitura errada:
    // `fontesMemoria` medindo o enrich, `embeds.ms` medindo o mesmo enrich). O embed
    // CONTEXTUAL da pista de contexto NÃO entra nesta janela (fix round 1, A4): ele fecha
    // antes, e a janela dele é `pistaDeContexto.embeds.ms`.
    const t0FontesMemoria = Date.now();
    const prazoDaFonteMs = config.prazoDaFonteMs ?? 800;
    const embedar = embedder ? (texto) => embedder.embed(texto, 'query') : null;
    const capsComFonte = config.capacidades.filter((cap) => typeof cap.fonte?.selecionar === 'function');
    // Q3 (correção do review de qualidade da Fase 2): ids de capacidade REGISTRADA, para
    // validar `s.carregar` abaixo — uma fonte pode pedir um id que não existe em
    // `config.capacidades` (typo, capacidade renomeada/removida). Sem esta checagem, o id
    // inválido ia direto a `promocoesDasFontes` e `promoverNoTurno` recebia um provider
    // inexistente em silêncio.
    const idsDeCapacidadesConhecidas = new Set(config.capacidades.map((cap) => cap.id));
    // Capacidades já carregadas NESTE momento do turno (a fonte roda antes do decisor): as da
    // sessão (`estadoAnterior.kairos.loadedProviders`, pegajosas) + as de piso (sempre
    // presentes). Entregue à fonte em `selecionar(ctx, { capacidadesCarregadas })` — é o que a
    // condição `powers` de uma memória precisa ver na fábrica, onde `ctx.loadedPowerBundles`
    // (V1) não existe. Ids de capacidade (`idDeCapacidade`: `_` vira `-`); a fonte decide como casar.
    const capacidadesCarregadas = [...new Set([
      ...(estadoAnterior.kairos?.loadedProviders ?? []),
      ...config.capacidades.filter((cap) => cap.piso === true).map((cap) => cap.id),
    ])];
    const fontes = [];
    const selecaoPorCap = new Map();
    const blocosDasFontes = [];
    // M2 (revisão final do conjunto): contador GLOBAL do default de prioridade (`2000 +
    // contador`), incrementado através de TODAS as fontes — não reiniciado por fonte. Antes,
    // `indice` vinha de `forEach` DENTRO do laço `for (const r of resultadosDasFontes)`, reiniciando
    // em 0 a cada fonte: a segunda fonte com itens sem `prioridade` explícita colidia com o
    // default da primeira (as duas ganhavam `2000`, `2001`, ...), e a ordem relativa entre itens
    // de fontes diferentes virava acidente de `Promise.allSettled`, não uma prioridade real.
    let contadorIncluidosDasFontes = 0;
    const promocoesDasFontes = new Set();
    const memoriasDoTurno = [];
    // Aceite de contribuição (spec 2026-10-29 aceite): com `comportamento` ligado, a habilidade que a seleção traz — pedida
    // pelo Jev (`discover.skills.activate`) ou por `carrega: skill/<id>` de memória (`Selecao.semear`) — vale SÓ no turno:
    // o host a prepara sem escrever na memória de trabalho (`aoPrepararHabilidade`) e ela só sobe se o modelo a declarar
    // (`_contribuicoes_usadas`, fecho do turno). `headless` fica de fora: o schema dele não tem o campo, a habilidade
    // nunca seria declarada. Desligado (ou host sem o callback): o caminho de sempre, intacto.
    const comportamentoNoTurno = despejoCfg.comportamento === true && ctx?.headless !== true
      && typeof config.aoPrepararHabilidade === 'function';
    const ofertaDeHabilidades = [];
    // Memória do turno (fonte `memoria`) que o modelo pode declarar em `_contribuicoes_usadas`: o id é o `ref` do bloco, o
    // mesmo `source` do `<info>` que ele lê no `turn_context`. A que o host já promoveu para a memória de trabalho
    // (`entrada.memoriasPromovidas`, guardada por ele entre turnos) não volta: já está no system pelo piso de trabalho.
    // Só a seleção deste turno decide o que sai; a promovida que a seleção não traz agora nem aparece no diagnóstico.
    const memoriasPromovidasNaEntrada = comportamentoNoTurno && Array.isArray(entrada.memoriasPromovidas)
      ? new Set(entrada.memoriasPromovidas.filter((r) => typeof r === 'string' && r)) : new Set();
    const ofertaDeMemorias = [];
    const memoriasJaPromovidas = [];
    // Habilidades pedidas por `Selecao.semear` que valem só no turno: o bloco entra junto das do Jev (mais abaixo).
    let sugeridasDasFontes = [];
    const refDoSemearDaFonte = new Map();
    const semearDasFontes = [];
    const enriquecimentoDasFontes = [];
    const errosDeFontes = [];
    if (capsComFonte.length) {
      const vetor1 = vetores?.[0] ?? null;
      const resultadosDasFontes = await Promise.allSettled(capsComFonte.map(async (cap) => {
        const t0 = Date.now();
        let timer;
        try {
          const selecao = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('prazo')), prazoDaFonteMs);
            Promise.resolve()
              .then(() => cap.fonte.selecionar(ctx, { vetor1, embedar, capacidadesCarregadas }))
              .then(resolve, reject);
          });
          return { id: cap.id, ms: Date.now() - t0, degradado: null, selecao };
        } catch (erro) {
          return {
            id: cap.id,
            ms: Date.now() - t0,
            degradado: erro?.message === 'prazo' ? 'prazo' : `erro: ${erro?.message ?? erro}`,
            selecao: null,
          };
        } finally {
          clearTimeout(timer);
        }
      }));
      for (const r of resultadosDasFontes) {
        // `Promise.allSettled` só rejeitaria por bug na função acima (que já não deixa escapar
        // nada) — coberto com uma linha própria, em vez de sumir do array em silêncio.
        const f = r.status === 'fulfilled'
          ? r.value
          : { id: '?', ms: 0, degradado: `erro: ${r.reason?.message ?? r.reason}`, selecao: null };
        const s = f.selecao ?? { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null };
        selecaoPorCap.set(f.id, f.selecao);
        if (f.id === 'memoria') {
          memoriasDoTurno.push(...(s.incluidos ?? []).map((i) => ({ ref: i.ref, valor: i.valorCompleto ?? i.valor, carrega: i.carrega ?? [] })));
        }
        fontes.push({
          id: f.id,
          ms: f.ms,
          degradado: f.degradado,
          // `valor`/`carrega` (opcionais, só a fonte de memória os dá): o que a memória dizia e o que
          // mandava carregar NO MOMENTO do turno — vão ao trace, nunca ao prompt (este usa `conteudo`).
          incluidos: (s.incluidos ?? []).map(({ ref, motivo, score, valor, carrega }) => ({
            ref,
            motivo,
            ...(score != null ? { score } : {}),
            ...(valor ? { valor } : {}),
            ...(carrega?.length ? { carrega } : {}),
          })),
          candidatos: (s.candidatos ?? []).map(({ ref, motivo, score }) => ({ ref, motivo, ...(score != null ? { score } : {}) })),
          carregar: s.carregar ?? [],
          semear: s.semear ?? [],
          enriqueceu: Boolean(s.enriquecer),
        });
        (s.incluidos ?? []).forEach((item) => {
          if (f.id === 'memoria' && comportamentoNoTurno && typeof item.ref === 'string' && item.ref) {
            if (memoriasPromovidasNaEntrada.has(item.ref)) {
              if (!memoriasJaPromovidas.includes(item.ref)) memoriasJaPromovidas.push(item.ref);
              return;
            }
            if (!ofertaDeMemorias.some((o) => o.id === item.ref)) {
              // `texto`: o que o host grava na memória de trabalho se o modelo declarar a memória (valor inteiro, sem a moldura do bloco).
              const texto = String(item.valorCompleto ?? item.valor ?? '').trim() || String(item.conteudo ?? '').trim();
              ofertaDeMemorias.push({ id: item.ref, ref: item.ref, texto });
            }
          }
          blocosDasFontes.push({
            ref: item.ref,
            destination: 'turn:context',
            priority: item.prioridade ?? (2000 + contadorIncluidosDasFontes),
            content: item.conteudo,
          });
          contadorIncluidosDasFontes += 1;
        });
        // Q3: só promove id de capacidade CONHECIDA — o que a fonte pediu continua listado em
        // `fontes[].carregar` (linha acima, é o que ela pediu de verdade), mas um id
        // desconhecido não entra em `promocoesDasFontes` (não vira `providers` de
        // `promoverNoTurno`) e sai em `errosDeFontes`/`renderErrors` para o host perceber.
        for (const id of s.carregar ?? []) {
          if (idsDeCapacidadesConhecidas.has(id)) {
            promocoesDasFontes.add(id);
          } else {
            errosDeFontes.push({ ref: 'fontes/carregar', error: `capacidade desconhecida: ${id}` });
          }
        }
        semearDasFontes.push(...(s.semear ?? []));
        for (const idSemear of s.semear ?? []) if (!refDoSemearDaFonte.has(idSemear)) refDoSemearDaFonte.set(idSemear, `${f.id}/skill/${idSemear}`);
        if (s.enriquecer) enriquecimentoDasFontes.push(s.enriquecer);
      }
    }

    // `enriquecer` não vazio dispara o embed 2 (F7, spec 2): os DOIS vetores vão ao(s)
    // `prepareTurn`(s) deste turno (`comVetores.embeddings`) — só quando a fábrica já tinha um
    // vetor 1 (sem ele — sem embedder, ou texto trivial sem vetor do host — não há o que
    // enriquecer) e o embedder está disponível. Falha aqui não derruba o turno: `embeds.erro`
    // registra, o turno segue só com o vetor 1.
    if (enriquecimentoDasFontes.length && embedar && vetores?.length === 1) {
      const t0 = Date.now();
      try {
        let textoEnriquecido = enriquecimentoDasFontes.join('\n');
        if (textoEnriquecido.length > TETO_ENRIQUECIMENTO_CHARS) {
          textoEnriquecido = `${textoEnriquecido.slice(0, TETO_ENRIQUECIMENTO_CHARS)}…`;
        }
        const consultaEnriquecida = `${entrada.texto}\n\n${textoEnriquecido}`;
        const vetor2 = await embedar(consultaEnriquecida);
        consultasEmbeddingadas.push({ texto: consultaEnriquecida, vetor: vetor2 });
        vetores = [vetores[0], vetor2];
        embeds.quantos += 1;
      } catch (erro) {
        embeds.erro = embeds.erro ?? String(erro?.message ?? erro);
      }
      embeds.ms += Date.now() - t0;
    }
    // `semear` das fontes: ids de SKILL a semear na memória de trabalho neste turno (F6/F10 —
    // fora de escopo aqui QUEM semeia, só o repasse ao host). Chamado uma vez, com a união das
    // fontes; erro no callback do host não derruba o turno (mesma garantia de
    // `aoEvento`/`aoMontar`) — registrado em `errosDeFontes`, mesclado a `renderErrors` mais
    // abaixo (`renderErrors` ainda não existe neste ponto do turno). O retorno em si é
    // DESCARTADO aqui (esta chamada não monta bloco nenhum, ao contrário da de skill ATIVADA
    // mais abaixo) — mas F4 (correção da revisão final do conjunto) normaliza mesmo assim, para
    // reportar cada FALHA parcial (`{sucessos,falhas}`) em `errosDeFontes`: antes, uma falha
    // parcial de `semearNaMemoriaDeTrabalho` lançava e o `catch` abaixo registrava um erro
    // genérico só com os ids que falharam; agora ela não lança mais para falha parcial (só para
    // power `habilidades` ausente), então sem isto uma falha parcial sumiria em silêncio.
    if (semearDasFontes.length && typeof config.aoSemear === 'function') {
      try {
        const idsDasFontes = [...new Set(semearDasFontes)];
        let idsParaSemear = idsDasFontes;
        // Falhas ao PREPARAR (comportamento ligado) entram junto das do semeio em `semearFalhou`.
        const falhasDoPreparo = [];
        if (comportamentoNoTurno) {
          // Prepara sem semear (spec §7.5): o corpo vira bloco do turno. `requires` e já semeada seguem para o `aoSemear`.
          const preparo = normalizarRetornoDeSemear(await config.aoPrepararHabilidade(idsDasFontes, ctx));
          falhasDoPreparo.push(...preparo.falhas);
          const separadas = separarPreparadas(preparo.sucessos);
          sugeridasDasFontes = separadas.sugeridas;
          idsParaSemear = separadas.semearDireto;
        }
        const retornoDoSemeio = idsParaSemear.length
          ? normalizarRetornoDeSemear(await config.aoSemear(idsParaSemear, ctx))
          : { sucessos: [], falhas: [] };
        const sucessos = retornoDoSemeio.sucessos;
        const falhas = [...falhasDoPreparo, ...retornoDoSemeio.falhas];
        for (const falha of falhas) {
          errosDeFontes.push({ ref: 'fontes/semear', error: `${falha.id}: ${String(falha.erro?.message ?? falha.erro)}` });
        }
        // Dedup (fix 2026-10-29): o host devolve `jaCarregada: true` para a skill que já estava na
        // memória de trabalho (corpo idêntico ao disco — `hab_carregar` foi no-op, nada foi escrito
        // nem virou card). Aqui só se REGISTRA o pulo em `fontes[].semearPulado`; e o id que o host
        // recusou (inexistente, desabilitada...) em `fontes[].semearFalhou` com o código — antes só
        // havia a frase em `renderErrors`. Campos só aparecem quando há o que dizer.
        const jaSemeadas = new Set(sucessos.filter((s) => s?.jaCarregada === true).map((s) => s.id));
        const motivoPorId = new Map(falhas.map((falha) => [
          falha.id,
          typeof falha.erro === 'string' ? falha.erro.slice(0, 120) : String(falha.erro?.code ?? 'erro'),
        ]));
        for (const f of fontes) {
          const pulados = f.semear.filter((id) => jaSemeadas.has(id));
          if (pulados.length) f.semearPulado = pulados;
          const falhou = f.semear.filter((id) => motivoPorId.has(id)).map((id) => ({ id, codigo: motivoPorId.get(id) }));
          if (falhou.length) f.semearFalhou = falhou;
        }
      } catch (erro) {
        errosDeFontes.push({ ref: 'fontes/semear', error: String(erro?.message ?? erro) });
      }
    }
    tempos.fontesMemoria = Date.now() - t0FontesMemoria;

    // B3.3, fase 2 — a pista de contexto entra AQUI: depois do vetor 1 e do enriquecimento
    // das fontes (que têm medição própria em `embeds`), e ANTES de `comVetores`, que é o
    // que o discover recebe. UM vetor contextual no máximo por run elegível, ZERO em
    // inelegível; os vetores de fontes/host são preservados e nenhum array do chamador é
    // mutado (`vetoresComPista` é um array novo quando o contextual entra por acréscimo).
    // `texto` continua `entrada.texto` — a pista NUNCA reescreve a consulta original.
    //
    // POSIÇÃO (fix round 1, A4): logo DEPOIS do fechamento de `tempos.fontesMemoria`, e
    // não antes. O `embed` contextual é uma ida ao embedder que não tem nada de fonte, e
    // dentro daquela janela ele aparecia inteiro em `fontesMemoria` (medido: ~200 ms de
    // embed dentro de uma fase em que as fontes levaram ~0 ms), enquanto `embeds.ms` do
    // turno — o número do MESMO trabalho — dizia 0: o host lia dois números discordando
    // sobre a mesma chamada. A ordem exigida pelo plano continua a mesma em relação ao que
    // importa: depois do vetor 1 e do enriquecimento, antes de `comVetores`.
    //
    // NADA DEPENDE DA ORDEM DO `aoSemear` ACIMA (fix round 2, A4): ele é o repasse do
    // `semear` das fontes ao host, não lê nem escreve vetor, `consultasEmbeddingadas` nem
    // tempo; nenhum contrato escrito exige uma ordem ou outra entre ele e o embed
    // contextual, e o teste não a fixa. Quem mover um dos dois não está quebrando nada —
    // e quem precisar de uma ordem, que a torne explícita em contrato, não por posição
    // de linha.
    const {
      hints: hintsDoTurno,
      vetores: vetoresComPista,
      diagnostico: pistaDeContexto,
    } = await prepararPistaDeRanking({
      texto: entrada.texto,
      decisao: entrada.pistaDeContexto,
      vetores,
      embedder,
      signal: entrada.abortSignal,
      jaEmbedadas: consultasEmbeddingadas,
    });
    vetores = vetoresComPista;
    const comVetores = vetores ? { embeddings: vetores } : {};

    // A ponte do TURNO (B3.3 fase 2): `manager` e `can` são os MESMOS do catálogo cacheado
    // (nenhum manager novo, nenhum reindex, nenhuma recalibração por run) e o embedder é o
    // mesmo; o que é novo a cada `executarTurno` é a FACHADA que intercepta `discover` —
    // ela carrega as `hints` do pedido e publica a seleção (C3P) ANTES do render. Com
    // `hints` vazio (turno sem pista, ou com fallback), o discover real recebe o input
    // SEM o campo `hints`: o contrato antigo, byte a byte. Todas as promoções do turno
    // recebem ESTA ponte por parâmetro (`promoverNoTurno`), nunca uma do catálogo.
    const { bridge } = criarPonteDoTurno({
      manager,
      can,
      embedder,
      aoSelecionarProviders: config.aoSelecionarProviders,
      hints: hintsDoTurno,
      trivial: typeof entrada.trivial === 'boolean' ? entrada.trivial : undefined,
    });

    // I3 (revisão final do conjunto): assina os eventos do manager do kairos (a MESMA
    // instância entre turnos — `montarCatalogo` cacheia `catalogo`, ver `let catalogo` mais
    // acima no arquivo) ANTES do primeiro `prepareTurn`. É `manager.discover()` (chamado por
    // `bridge.prepareTurn`, `genos/bridge.ts`) quem pode emitir `degraded`/`budget.cut` (e, desde
    // a Task 9, `refiner.applied`/`refiner.fallback` — R1/R4, o refino por anel roda DENTRO do
    // próprio `discover()`) — o emitter é criado uma vez dentro de `createManager`
    // (`resolve/discover.ts`) e reusado por TODO `discover()` daquele manager. As meta-tools do
    // bridge (`load_capability`/`search_capabilities`, `runtime/meta-tools.ts`) NUNCA chamam
    // `manager.discover()` — só consultam `manager.registry`/`manager.store` diretamente —,
    // então nada se perde por não manter o listener aberto durante o loop do genos: os
    // `prepareTurn`s deste turno (o de baixo, e o segundo que I3a pode disparar via
    // `promoverNoTurno` — a Task 9 removeu o SEGUNDO `prepareTurn` que o extinto gancho
    // `aoDescobrir` disparava, e a Task 10 removeu o das fontes, que hoje entra no ESTADO do
    // primeiro `prepareTurn`; só I3a ainda pode disparar um segundo) são os únicos pontos que
    // podem emitir.
    // `parar()` no `finally` evita vazar listener no manager cacheado entre turnos — sem ele, um
    // turno que lança no meio (ex.: ref duplicado de conversa, mais acima) deixaria um listener a
    // mais registrado para sempre.
    const eventosDoKairos = [];
    // Premissa: UM `executarTurno` por vez nesta instância (um turno por sessão) — o listener
    // é da instância do manager, e dois turnos concorrentes veriam os eventos um do outro.
    const pararKairos = manager.emitter.onEvent((evento) => {
      if (
        evento?.type === 'degraded'
        || evento?.type === 'budget.cut'
        // Task 9 (R1/R4): eventos do refino por anel — `applied` quando o refinador rodou dentro
        // do prazo, `fallback` quando estourou/errou/devolveu formato inválido (o motor aplica a
        // proposta dele mesmo nesses casos, nunca derruba o turno).
        || evento?.type === 'refiner.applied'
        || evento?.type === 'refiner.fallback'
      ) eventosDoKairos.push(evento);
    });

    // `let`, não `const`: a promoção de `carregar` das fontes (`promoverNoTurno`, mais abaixo)
    // pode reatribuir a um SEGUNDO `prepareTurn`, com o discover aumentado.
    let prepared;
    let renderErrors;
    let blocks;
    let indicePiso;
    // I3a (revisão final do conjunto): declarados aqui (fora do `try`) para sobreviverem até o
    // `config.aoMontar`/`return` deste turno, mais abaixo — dentro do `try` seriam block-scoped
    // e sumiriam. Populados logo depois do primeiro `prepareTurn`, ver bloco "I3a" abaixo.
    let promocoesFontes = new Set();
    let promocoesSkills = new Set();
    // Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`): refs de skill sugeridas que NÃO
    // promoveram a capacidade dona porque o anel `skill` não teve voto real do Jev — ver bloco
    // "I3a" abaixo.
    let promocoesSemVoto = new Set();
    // Skills com voto numérico do refinador mas tier final ≠ `full` (candidate): continuam só
    // sugeridas, NÃO promovem o provider dono — `[{ skill, voto, tier }]`, para a tela explicar.
    let promocoesSkillsAbaixoDoCorte = [];
    // Loop de decisão do Jev (spec 2026-09-22 §6.1): populado dentro do `try`, depois do
    // refino e do I3a — declarado aqui (fora do `try`) pela mesma razão das flags acima: precisa
    // sobreviver até a montagem do payload/retorno mais abaixo.
    let saidaDoLoop = null;
    let autorizadasDoLoop = new Map();
    let entrega = null;
    // Correção B (fluxo de bug, spec 2026-09-22 §6.4): refs de função (`capacidade/tool/chave`)
    // cujo manual o loop do Jev leva ao prompt neste turno — as EXECUTADAS COM SUCESSO (`rastro`)
    // mais as ESCOLHIDAS e não executadas (`paraOModelo`; revisão do conjunto, 7fe31cb7). O nome
    // não diz "usadas": o conjunto inclui função que o loop NÃO executou. Declarado aqui (mesma
    // razão das flags acima) para sobreviver ao `finally` do bloco do loop e alimentar
    // `contratosDoLoop`, logo antes de `construtor.acumular(...)`.
    let refsComManualDoLoop = new Set();
    // Spec 2026-10-14 §5.3/§7.1: refs hidratadas porque o Jev julgou a intenção declarada válida
    // (vazio quando não houve intenção ou ela foi recusada) — vai ao artefato em `loop.intencaoHidratada`.
    let refsIntencaoHidratadas = [];
    // Mudança 2: soma de parede de todo `promoverNoTurno` deste turno (I3a sozinho, o do loop, ou
    // os dois) — declarado aqui pela mesma razão das flags acima, os dois pontos que somam vivem
    // dentro do `try` mas o valor precisa sobreviver até `tempos.promocao`, na montagem do payload.
    let msPromocao = 0;

    // Task 10 (spec "decisor por anel: refinadores do kairos", R10): a promoção de `carregar`
    // das fontes deixa de disparar um SEGUNDO `bridge.prepareTurn` (o antigo bloco "Task 6",
    // removido — ver comentário mais abaixo, onde ele rodava) e passa a entrar no ESTADO do
    // PRIMEIRO `prepareTurn`. `discover.js` (kairos) monta `providers.load` a partir de
    // `dedupe([...alwaysProviderIds, ...fullIds, ...state.loadedProviders])` — um id de
    // capacidade em `state.loadedProviders` é hidratado (índice + instruções) no MESMO
    // `discover()`, exatamente como um provider carregado num turno anterior. `unchanged`
    // (texto trivial) só olha o TEXTO (`isTrivial`, `discover.js`), nunca o `state` — passar o
    // estado aumentado aqui não muda esse resultado.
    //
    // Pegajoso como antes: um provider que já estava em `estadoAnterior.kairos.loadedProviders`
    // (turno anterior) continua carregado sem a fonte pedir de novo — é `[...new Set(...)]`
    // (não há `dedupe` exportado neste arquivo; mesmo idioma usado em todo o resto do pacote,
    // ex.: `comCarregadasNoTurno` acima) sobre a UNIÃO dos dois.
    const estadoKairosDoTurno = promocoesDasFontes.size
      ? { ...estadoAnterior.kairos, loadedProviders: [...new Set([...estadoAnterior.kairos.loadedProviders, ...promocoesDasFontes])] }
      : estadoAnterior.kairos;

    // `operacoes`/`avisar` — movidos para ANTES do `try` (Task 15, loop do Jev, spec
    // 2026-09-22 §6.1): originalmente declarados mais abaixo, depois do `payload`, mas o loop do
    // Jev roda DENTRO deste `try` (logo depois do bloco I3a) e precisa registrar em `operacoes` e
    // avisar `config.aoChamada` (`origem: 'jev'`) antes de o resto do turno existir. Nada muda no
    // TIPO nem no comportamento — só a posição.
    /** @type {Array<{nome: string, args: unknown, ok: boolean, erro?: string}>} */
    const operacoes = [];

    // `aoChamada`, `aoEvento` e `aoTexto` são do HOST (log, métrica, UI) —
    // observam o turno, não participam dele. Um bug num handler de log não
    // pode derrubar a conversa que ele estava logando (mesma garantia que
    // `fabrica:catalogo-mudo` já tem, ver comentário mais acima). Engolido
    // sem acumular em `renderErrors`: não há consumidor DENTRO do turno que
    // precise saber que a observação do host falhou.
    // Contrato é SÍNCRONO (os typedefs declaram `=> void`): este `try/catch`
    // não pega promise rejeitada. Um handler `async` que rejeita ainda vaza
    // uma unhandled rejection e derruba o processo — mesmo limite que as
    // chamadas cruas já tinham antes desta proteção existir.
    const avisar = (fn, arg) => {
      if (!fn) return;
      try {
        fn(arg);
      } catch {
        // engolido de propósito — ver comentário acima.
      }
    };

    // Mudança 2: início da fase `discoverInicial` — a parede do PRIMEIRO `bridge.prepareTurn`
    // (ver JSDoc de `aoMontar`, `tempos`).
    const t0DiscoverInicial = Date.now();
    try {
      prepared = await bridge.prepareTurn({
        text: entrada.texto,
        ctx,
        state: estadoKairosDoTurno,
        limits: { tools: limiteDeTools },
        turn: estadoAnterior.turno,
        ...comVetores,
        // Só quando há item: um `conversation: { items: [] }` presente muda a
        // saída do discover (`conversationHadInput`, ver kairos) mesmo sem
        // nada para avaliar — mesma forma condicional de `motor.ts:618`.
        ...(itensDeConversa.length ? { conversation: { items: itensDeConversa } } : {}),
      });
      tempos.discoverInicial.total = Date.now() - t0DiscoverInicial;
      // Neste ponto `eventosDoKairos` só pode ter eventos DESTE `prepareTurn` — nenhum
      // `promoverNoTurno` rodou ainda (I3a/loop, mais abaixo), então somar `refiner.applied.ms`
      // agora é seguro sem precisar de um índice de corte no array (ver JSDoc de `aoMontar`).
      tempos.discoverInicial.refinadores = eventosDoKairos
        .filter((ev) => ev?.type === 'refiner.applied')
        .reduce((soma, ev) => soma + (ev.ms || 0), 0);

      // `unchanged` (texto trivial) ⇒ `prepared.blocks` vem vazio DE PROPÓSITO
      // (ver doc de `reconstruirBlocosDoTurno`) — reconstrói o que o discover
      // teria produzido para o piso, sem depender de o discover ter rodado de
      // verdade. Um render que falha aqui não pode derrubar o turno: entra em
      // `renderErrors` (mesma garantia de `bridge.prepareTurn`), nunca lança.
      renderErrors = [...(prepared.renderErrors ?? []), ...errosDeLeituraSemantica, ...errosDeFontes];

      blocks = prepared.blocks;
      indicePiso = [];
      if (prepared.discoverResult.unchanged) {
        const refsPiso = refsDeToolsPiso(manager, { todas: config.pisoCompletoNoTurnoTrivial === true });
        const reconstruidos = await reconstruirBlocosDoTurno({
          manager,
          ctx,
          pisoCompleto: config.pisoCompletoNoTurnoTrivial === true,
          // União, não substituição — mas a razão NÃO é "o host pode registrar
          // contribuição por outro caminho": `criarOrquestrador` devolve só
          // `{ executarTurno, fechar }` (ver o `return`, no fim do arquivo);
          // `manager`/`registry` nunca saem da fábrica, e contribuição só entra
          // por `config.contribuicoes`. A razão de verdade é compatibilidade:
          // `config.refsVolateis` já existia como o ÚNICO parâmetro desta
          // chamada antes de `contribuicoes[].volatil` nascer (a linha era
          // `refsVolateis: config.refsVolateis?.(ctx)` — ver histórico deste
          // arquivo). Nenhum perfil atual (`src/perfis/`) passa
          // `config.refsVolateis` hoje, mas o campo continua público na
          // `ConfigDoOrquestrador` e a fábrica não pode assumir que nenhum
          // consumidor externo o usa — a união preserva o contrato antigo em
          // vez de quebrá-lo em silêncio.
          refsVolateis: [...refsVolateisDeclaradas, ...(config.refsVolateis?.(ctx) ?? [])],
          onError: (ref, erro) => renderErrors.push({ ref, error: String(erro) }),
        });
        blocks = { system: reconstruidos.system, turn: reconstruidos.turn };
        // Linha de índice completa (`key — description`), não só o nome exposto
        // que o fallback de `acumular` usaria sem isto — a mesma fonte (registry)
        // que o caminho normal usa via `linhasDeIndice`, só que com os refs de
        // PISO no lugar de `discoverResult.tools.conscious` (vazio quando
        // `unchanged`).
        indicePiso = linhasDeIndice(manager, refsPiso);
      }

      // I3a (revisão final do conjunto): promove o provider DONO de uma skill que o kairos
      // sugeriu neste turno (`discover.skills.suggest`, refs `<providerId>/skill/<chave>` — ver
      // `test/skills.test.js`). Sem isto o modelo vê a sugestão (bloco `turn:context`, "Skills
      // sugeridas para este turno") mas a capacidade que sabe AGIR sobre ela (ex.: `habilidades`,
      // dona de `hab_carregar`) pode não estar em `providers.load` neste turno — sugestão sem
      // caminho de ação. Task 10 (R10): `promocoesFontes` é o que de fato ENTROU neste turno pelo
      // estado injetado antes do primeiro `prepareTurn` (`estadoKairosDoTurno`, acima de `try`) —
      // ids de `promocoesDasFontes` que NÃO estavam em `estadoAnterior.kairos.loadedProviders`
      // (já carregado de um turno anterior não "entra" de novo; ver teste (h) de pegajosidade em
      // `test/refino.test.js`). `fontes[].carregar` (telemetria por fonte, acima) continua sendo
      // "o que a fonte pediu", promovido ou não. Nunca roda em `unchanged` — mesma guarda do
      // bloco seguinte, texto trivial não tem `discover.skills` para sugerir nada, e o estado
      // injetado nunca chegou a um `discover()` de verdade.
      if (!prepared.discoverResult.unchanged) {
        promocoesFontes = new Set(
          [...promocoesDasFontes].filter((id) => !estadoAnterior.kairos.loadedProviders.includes(id)),
        );
        const carregadosAgora = new Set(prepared.discoverResult.providers?.load ?? []);
        // Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`, medição de 21/09): em todo turno frio
        // o anel `skill` degradava (timeout do Jev) e o I3a promovia a capacidade dona por
        // engano, mesmo sem voto real — pagando um segundo `discover()`/rodada de funções para
        // uma sugestão que nem o próprio Jev confirmou. `explainSkill` indexa o `explain` do
        // anel `skill` deste (primeiro) discover por `ref`, para checar o voto ANTES de
        // promover. Sem refinador registrado no anel (`refiner` ausente): comportamento de
        // antes (J0) — o kairos ainda decide sozinho, e a fábrica confia na sugestão dele.
        // Acabamento do review final (I3a): critério trocado de lista NEGRA (por `reason`) para
        // lista BRANCA (por `confidence`) — a lista negra deixava passar `reason: 'teto'`/
        // `'ignorada'` (e qualquer motivo futuro do kairos não antecipado aqui), promovendo sem
        // voto real. `confidence` só existe no `explain` quando o refinador respondeu um `noul`
        // numérico de verdade (ver `typeof e.refiner?.confidence === 'number'`, mesmo critério
        // usado por `respondidos`/`porAnel` acima nesta função) — `refiner` presente mas SEM
        // `confidence` numérica (qualquer motivo de degradação/fallback/silêncio) vai para
        // `semVoto`; `refiner` ausente continua J0 (promove como antes).
        const explainSkill = new Map(
          (prepared.discoverResult.explain ?? []).filter((e) => e.ring === 'skill').map((e) => [e.ref, e]),
        );
        for (const ref of prepared.discoverResult.skills?.suggest ?? []) {
          const providerId = typeof ref === 'string' ? ref.split('/')[0] : null;
          if (!providerId || carregadosAgora.has(providerId)) continue;
          const voto = explainSkill.get(ref)?.refiner;
          if (voto && typeof voto.confidence !== 'number') {
            promocoesSemVoto.add(ref);
            continue;
          }
          // Voto real mas tier final ≠ `full` (`explain.tier` = decisão FINAL do refinador do anel
          // `skill`; `proposedTier` seria só a do motor): candidata só é sugerida, não promove o
          // poder dono (caso real 107433a5: votos 0,31/0,38 promoveram `habilidades` inteiro).
          // `refiner` ausente (J0) segue promovendo como antes.
          const explicada = explainSkill.get(ref);
          if (voto && explicada.tier !== 'full') {
            promocoesSkillsAbaixoDoCorte.push({ skill: ref, voto: voto.confidence, tier: explicada.tier ?? null });
            continue;
          }
          if (idsDeCapacidadesConhecidas.has(providerId)) {
            promocoesSkills.add(providerId);
          } else {
            // `errosDeFontes` já foi consumido em `renderErrors` (linha acima, antes deste
            // bloco rodar) — push direto em `renderErrors` (mesmo array mutável que
            // `onError` do `reconstruirBlocosDoTurno`, logo acima, já usa).
            renderErrors.push({ ref: 'fontes/skill', error: `capacidade desconhecida: ${providerId}` });
          }
        }
      }

      // Task 10 (spec "decisor por anel: refinadores do kairos", R10): o bloco "Task 6" que
      // promovia `carregar` das fontes por aqui (um SEGUNDO `bridge.prepareTurn`, o mesmo
      // `promoverNoTurno` logo abaixo) SAIU — essa promoção agora entra no ESTADO do PRIMEIRO
      // `prepareTurn` (`estadoKairosDoTurno`, acima de `try`), sem turno extra.
      // `promoverNoTurno` segue existindo só para I3a: o provider dono de uma skill SUGERIDA (não
      // ativada) sem estar carregado — a única promoção que só se descobre DEPOIS de ver o
      // resultado do primeiro discover (o próprio `discover.skills.suggest`), então não tem como
      // entrar no estado de antes. `providers: promocoesSkills` (não mais `promocoesDasFontes`)
      // — só o que I3a de fato acrescentou aqui: o que as fontes pediram via `carregar` já está
      // refletido em `prepared.discoverResult` desde o primeiro `prepareTurn`.
      //
      // Task 9 (spec "decisor por anel: refinadores do kairos", R1): até a Task 9, um SEGUNDO
      // bloco rodava logo depois — o gancho `aoDescobrir` (J3), um decisor OPCIONAL do host que
      // recebia o discover deste turno, pedia mais capacidades/funções, e a fábrica aplicava o
      // pedido com um SEGUNDO `bridge.prepareTurn` por cima (o mesmo `promoverNoTurno` usado
      // aqui). Esse gancho, `config.prazoDoDecisorMs`, `config.tetoDoDecisor`, o campo `decisor`
      // (aqui e no retorno/`aoMontar`) e as funções que só ele usava (`capacidadesParaDecisor`,
      // `expandirPedidosDoDecisor`) saíram inteiros: o decisor por anel do kairos 0.833
      // (`config.refinadores`/`config.refino`, ver JSDoc de `ConfigDoOrquestrador`) resolve o
      // MESMO problema (um decisor — tipicamente LLM do host — amplia o que o motor propôs)
      // rodando DENTRO do `discover()` que já ia rodar, anel por anel, sem turno extra.
      // `criarOrquestrador` lança `TypeError` se a config antiga ainda for passada — ver o guard
      // no topo desta função.
      // I3 (revisão de qualidade da Fase 3, spec §6.1): quando o loop VAI rodar, a promoção do
      // I3a (`promocoesSkills`) sai daqui e se junta à promoção do Jev numa chamada só, DEPOIS do
      // loop (bloco abaixo) — antes eram DUAS chamadas de `promoverNoTurno` neste turno, cada uma
      // reprocessando o discover por cima da anterior. Quando o loop NÃO roda (desligado, ou
      // turno `unchanged`), o comportamento fica IDÊNTICO ao de antes desta correção: uma
      // promoção só de `promocoesSkills`, mesma chamada, mesmos argumentos.
      const loopVaiRodar = Boolean(config.loop?.rodar) && !prepared.discoverResult.unchanged;

      if (!loopVaiRodar && promocoesSkills.size && !prepared.discoverResult.unchanged) {
        // Mudança 2: soma em `msPromocao` (fase `promocao`) — único ponto de promoção quando o
        // loop não roda.
        const t0Promocao = Date.now();
        const { prepared: preparedComFontes } = await promoverNoTurno({
          bridge,
          manager,
          discoverBase: prepared.discoverResult,
          refs: new Set(),
          providers: promocoesSkills,
          estadoAnterior,
          texto: entrada.texto,
          ctx,
          comVetores,
          itensDeConversa,
        });
        msPromocao += Date.now() - t0Promocao;
        prepared = preparedComFontes;
        blocks = preparedComFontes.blocks;
        mesclarRenderErrors(renderErrors, preparedComFontes.renderErrors);
      }

      // Loop de decisão do Jev (spec 2026-09-22 §6.1): depois do refino, antes da montagem.
      // Turno trivial (`unchanged`) não roda — "oi" não custa nada a mais.
      if (loopVaiRodar) {
        // I2 (revisão de qualidade da Fase 3, spec §3.4): o espaço do loop é o que o anel
        // `provider` ATIVOU NESTE turno (`tier: 'full'` no `explain` do discover deste turno),
        // não o que ficou carregado de turnos anteriores (`providers.load` é pegajoso — soma o
        // histórico da sessão inteira) nem os pisos (`capacidadesDoLoop`, loop-do-turno.js, tem o
        // porquê completo). `promocoesSkills` entra à parte, unida dentro de `capacidadesDoLoop`.
        const idsCandidatos = (prepared.discoverResult.providers?.candidates ?? []).map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean);
        const paramsDe = ({ tool, capacidade }) => config.loop.paramsDe({ tool, capacidade, ctx, pergunta: entrada.texto });
        let autorizacoes = [];
        try { autorizacoes = (await config.loop.autorizacoes?.({ ctx })) ?? []; } catch { autorizacoes = []; }
        // Spec 2026-10-14 §5.3: a intenção mantém o espaço disponível mesmo sem ativação no discover.
        const capacidadesDaIntencao = (entrada.intencaoAnterior ?? []).map((i) => i?.capacidade).filter((id) => typeof id === 'string');
        const espaco = espacoDoLoop({
          capacidades: config.capacidades,
          carregadas: capacidadesDoLoop({ explain: prepared.discoverResult.explain, promocoes: promocoesSkills, capacidades: config.capacidades, deFontes: [...promocoesDasFontes] }),
          candidatas: [...new Set([...idsCandidatos, ...capacidadesDaIntencao])],
          paramsDe,
          autorizacoes,
        });
        // `config.loop.rodar` é código do HOST (o motor `rodarLoop` de `@igris/decisions/loop`,
        // injetado) — mesma garantia do resto deste turno: uma falha aqui não pode derrubar o
        // turno inteiro. Vira um `estado: 'estourado'` com rastro vazio, e o turno segue sem
        // pré-hidratação nenhuma.
        // Mudança 2: início da fase `loop` — só `config.loop.rodar(...)`, sem a promoção que ele
        // pode disparar depois (essa soma em `msPromocao`/`tempos.promocao`).
        const t0Loop = Date.now();
        try {
          saidaDoLoop = await config.loop.rodar({
            pergunta: entrada.texto,
            ...(Array.isArray(entrada.intencaoAnterior) && entrada.intencaoAnterior.length ? { intencaoAnterior: entrada.intencaoAnterior } : {}),
            contexto: montarContextoDeMemorias(memoriasDoTurno, config.loop.memoria),
            espaco: { funcoes: espaco.funcoes, candidatas: espaco.candidatas },
            signal: entrada.abortSignal,
            carregar: async (id) => espaco.funcoesDe(id),
            // C1 (revisão de qualidade da Fase 3): o `ctx` do turno é o ctx do EXECUTOR — no
            // Igris, uma instância de `EventEmitter`, cujo `emit` vive no PROTÓTIPO, não como
            // propriedade própria. `{ ...ctx, ...(signal && {abortSignal}) }` (a forma de antes
            // desta correção) perde `emit` — spread só copia propriedades PRÓPRIAS — e
            // `criarHandlerDePower` (packages/executor/src/orchestration/powerToolHandler.js)
            // chama `toolCtx.emit(...)` incondicionalmente: toda chamada do loop a uma tool de
            // power REJEITAVA. `ctxDaFerramenta` é o contexto no FORMATO que o genos entrega a
            // um handler de tool (`ToolExecutionContext`, genos-orchestrator `orchestrator.ts`
            // ~877-912: runId/iteration/signal/loadSection/finish/emit/emitProgress — sem
            // `history`/`metadata`, que nenhum handler de power lê). `{ ...ctxDaFerramenta, ...ctx }`
            // é a MESMA ordem que `registryDoTurno` já usa (`original(args, { ...(ctxDoGenos||{}),
            // ...ctx })`, acima) — o `ctx` do turno sobrescreve o que tiver como propriedade
            // PRÓPRIA, sem apagar `emit` (que `ctx` nunca tem como própria).
            executar: async (fn, args, signal) => {
              const autorizada = fn.autorizada ?? null;
              const argsReais = autorizada ? autorizada.args : args;
              const nome = autorizada ? nomeExposto(fn.capacidade, fn.tool.name, { prefixar: config.capacidades.find((c) => c.id === fn.capacidade)?.prefixarTools !== false }) : fn.nome;
              const auditoria = autorizada ? { autorizacaoId: autorizada.id } : {};
              const id = `jev-${fn.nome}-${JSON.stringify(argsReais)}`;
              avisar(config.aoChamada, { fase: 'inicio', id, ref: `${fn.capacidade}/tool/${fn.tool.name}`, nome, args: argsReais, origem: 'jev', ...auditoria });
              const ctxDaFerramenta = {
                runId: 'jev-loop', iteration: 0, signal, abortSignal: signal,
                // Origem da chamada para a política de abertura de views (exibição unificada §6): o Jev
                // não abre telas por padrão; a decisão (jev-restrito) é registrada no fabrica.json.
                origemDaChamada: 'jev',
                // Só 'view'/'view_decisao' sobem ao host (mesmo canal 'tool.emitted' que o genos usa
                // para o caminho do modelo); o resto continua descartado como antes.
                emit: (evento, dados) => {
                  if (evento !== 'view' && evento !== 'view_decisao') return;
                  avisar(config.aoEvento, { type: 'tool.emitted', toolName: nome, event: evento, data: dados, origem: 'jev' });
                },
                emitProgress: () => {}, finish: () => {},
                loadSection: async (nomeDaSecao) => { throw new Error(`loadSection('${nomeDaSecao}') indisponível no loop do Jev`); },
              };
              let r;
              let motivo;
              try {
                r = await fn.tool.handler(argsReais, { ...ctxDaFerramenta, ...ctx });
                // I1 (revisão de qualidade da Fase 3): `criarHandlerDePower` NUNCA lança — todo
                // erro (argumento inválido, exceção dentro do power) já vira STRING de prosa, ou,
                // no caminho feliz, o JSON do power, que pode carregar `{ ok: false, ... }`. Sem
                // `falhaDoResultado`, só `r.ok === false` em OBJETO contava — a forma comum
                // (string) sempre passava como sucesso. Ver JSDoc de `falhaDoResultado`.
                motivo = falhaDoResultado(r);
              } catch (erro) {
                motivo = String(erro?.message || erro);
              }
              operacoes.push({ nome, args: argsReais, ok: !motivo, origem: 'jev', ...auditoria, ...(motivo ? { erro: motivo } : {}) });
              // `resultado`: o retorno da leitura, para o host gravar no registro completo (D-1, 10/10) — o Jev não emite
              // `tool.started`, então a captura do host não o pega.
              avisar(config.aoChamada, { fase: 'fim', ok: !motivo, id, nome, args: argsReais, origem: 'jev', resultado: r, ...auditoria, ...(motivo ? { erro: motivo } : {}) });
              if (!motivo && autorizada) {
                // Auditoria em segundo plano: nunca atrasa nem derruba a execução (uma auditoria lenta estourava o prazo com a escrita já feita).
                Promise.resolve().then(() => config.loop.aoUsarAutorizacao?.(autorizada.id)).catch(() => {});
              }
              // O motor (`rodarLoop`, `@igris/decisions/loop`) trata rejeição de `executar` como
              // falha DAQUELA chamada (`comCancelamento` captura, `item.erro` entra no rastro,
              // `tirar(fn.nome)` — rodar-loop.js) — lançar aqui é o canal certo para uma falha só
              // detectada DEPOIS do handler resolver (o caminho que `catch` sozinho não cobria).
              if (motivo) throw new Error(motivo);
              return r;
            },
          });
        } catch (erro) {
          saidaDoLoop = {
            estado: 'estourado',
            motivo: `erro do loop: ${String(erro?.message ?? erro)}`,
            rastro: [],
            carregadas: [],
            passos: [],
            ms: 0,
          };
        }
        // M2 (revisão de qualidade da Fase 3): o loop nunca derruba o turno — nem por exceção
        // (capturada acima), nem por um retorno que não é o objeto que `rodarLoop` documenta (um
        // host de teste, ou uma versão futura do motor com formato diferente).
        if (!saidaDoLoop || typeof saidaDoLoop !== 'object' || !Array.isArray(saidaDoLoop.rastro)) {
          saidaDoLoop = { estado: 'estourado', motivo: 'retorno inválido do loop', rastro: [], carregadas: [], passos: [], ms: 0 };
        }
        tempos.loop = Date.now() - t0Loop;
        // I3 (revisão de qualidade da Fase 3): UMA chamada só de `promoverNoTurno`, cobrindo o
        // que o I3a promoveria (`promocoesSkills`) E o que o Jev usou/carregou. Filtra o que já
        // está presente (refs já hidratadas, providers já carregados) — sem isto, toda vez que o
        // loop rodasse (mesmo sem achar nada novo) pagaríamos outra chamada — e nunca promove com
        // o turno já abortado.
        // N1 (correção fluxo de bug, spec 2026-09-22 §6): `usadas` guardava o NOME EXPOSTO da
        // função (`r.fn`, ex. `listar_eventos`), mas era comparado contra `refsJaHidratadas`, que
        // guarda REFS completas (`agenda/tool/listar_eventos`, formato `discoverResult.tools.
        // hydrate`) — nunca batia, e todo uso de uma função JÁ hidratada disparava uma promoção (e
        // o segundo `discover` que ela custa) à toa. O rastro tem `fn` (nome exposto) e
        // `capacidade`, mas não o nome CRU da tool que o formato da ref exige — só `espaco.funcoes`
        // (e as funções que `carregar` trouxe para capacidades novas neste turno, mesma forma —
        // `funcoesDeLeitura`, loop-do-turno.js) carregam `.tool.name`. Por isso o mapeamento por
        // `capacidade+nome` antes de montar a ref.
        const carregadasPeloJev = new Set(saidaDoLoop.carregadas ?? []);
        const funcoesConhecidas = [
          ...espaco.funcoes,
          ...[...carregadasPeloJev].flatMap((id) => espaco.funcoesDe(id)),
        ];
        autorizadasDoLoop = new Map(funcoesConhecidas.filter((f) => f.autorizada).map((f) => [f.nome, {
          toolName: nomeExposto(f.capacidade, f.tool.name, { prefixar: config.capacidades.find((c) => c.id === f.capacidade)?.prefixarTools !== false }),
          args: f.autorizada.args,
          id: f.autorizada.id,
        }]));
        const refPorFuncao = new Map(
          funcoesConhecidas.map((f) => [`${f.capacidade}::${f.nome}`, `${f.capacidade}/tool/${f.tool.name}`]),
        );
        const usadas = new Set(
          (saidaDoLoop.rastro ?? [])
            .filter((r) => !r.erro)
            .map((r) => refPorFuncao.get(`${r.capacidade}::${r.fn}`))
            .filter(Boolean),
        );
        // Correção B (fluxo de bug, spec 2026-09-22 §6.4, pendência "orchestrator/kairos (loop,
        // IMPORTANTE)"): guardado FORA deste bloco (`refsComManualDoLoop`, declarado antes do
        // `try` — ver comentário lá) para alimentar `contratosDoLoop` mais abaixo, depois do
        // `finally`. É o conjunto INTEIRO de refs usadas com sucesso — não só `refsParaPromover`
        // (que exclui as já hidratadas): o de-dup contra `blocks.turn` que `contratosParaRefs` já
        // faz cobre a sobreposição (função `fixa`/pinned que já tem manual pela via normal).
        // Correção (revisão do conjunto, 7fe31cb7, 24/09): agora soma `refsParaOModelo` (logo
        // abaixo) — ver o comentário dela para o porquê.
        // Correção (revisão do conjunto, 7fe31cb7, 24/09): `saidaDoLoop.paraOModelo` é a função que
        // o Jev ESCOLHEU mas não pôde preencher — parâmetro obrigatório sem opção nenhuma, ou com
        // opção mas sem resposta válida, grupo obrigatório (`anyOf`/`oneOf`) incompleto, ou valor que
        // o pedido cita fora das opções (`valor_fora_da_lista`) (spec §3.2, `rodar-loop.js`) — o motor encerra e devolve
        // `{ nome, capacidade }` (mesma forma que `rastro` já usa — casa por nome+capacidade, não só
        // por nome, que pode repetir entre capacidades diferentes) para o MODELO decidir/preencher.
        // PRIMEIRA VERSÃO desta correção (9edeea6b) somava estas refs em `refsParaPromover` — errado:
        // `promoverNoTurno` faz um SEGUNDO `bridge.prepareTurn`, que recalcula `tools.hydrate` pelo
        // RANKING de verdade (`hydrateProvider`, kairos `resolve/hydrate.ts`) e nunca hidrata uma
        // função sem `fixa`/pinned que não bate o embedder — a tool nunca ganhava manual, só pagava
        // o discover extra à toa (medido: `E:\tmp\rev-7fe31cb7\prova-manual.mjs`, a chamada direta
        // do modelo voltava `manual_nao_carregado`). Consertado somando estas refs a
        // `refsComManualDoLoop` (mesmo caminho de `usadas`, acima) — `contratosDoLoop` hidrata o
        // manual direto, sem depender de ranking (ver o JSDoc de `contratosDoLoop`) — e TIRANDO-as
        // de `refsParaPromover`: `paraOModelo` não executou nada (sem resultado para seedar no
        // histórico), então pagar o discover extra só por ela é desperdício.
        const refsParaOModelo = new Set(
          (saidaDoLoop.paraOModelo ?? [])
            .map((item) => funcoesConhecidas.find((f) => f.nome === item?.nome && f.capacidade === item?.capacidade))
            .filter(Boolean)
            .map((f) => refPorFuncao.get(`${f.capacidade}::${f.nome}`))
            .filter(Boolean),
        );
        // Bug do teste do dono (2026-10-02): leitura que o Jev escolheu e FALHOU (`item.erro`) ou que
        // nem pôde rodar sem o argumento do modelo também precisa do manual — `usadas` só conta
        // sucesso, e o modelo ia gastar um `load_capability` para chamar a mesma função. Só entra o que
        // o motor de fato tentou (acima do piso de execução); `cancelado` não é escolha do Jev.
        const refsComErro = new Set(
          (saidaDoLoop.rastro ?? [])
            .filter((r) => r.erro && r.erro !== 'cancelado' && !r.efeitoDesconhecido)
            .map((r) => refPorFuncao.get(`${r.capacidade}::${r.fn}`))
            .filter(Boolean),
        );
        refsComManualDoLoop = new Set([...usadas, ...refsParaOModelo, ...refsComErro]);
        // Spec 2026-10-14 §5.3: intenção julgada válida pelo Jev → manuais de TODAS as funções declaradas
        // (e as acompanhantes delas, pelo `refsAcompanhantes` que já roda sobre este conjunto).
        const refsIntencao = saidaDoLoop.intencao?.vale === true
          ? refsDaIntencao({ intencao: entrada.intencaoAnterior, capacidades: config.capacidades })
          : [];
        refsIntencaoHidratadas = [...refsIntencao];
        for (const ref of refsIntencao) refsComManualDoLoop.add(ref);
        const providersJaCarregados = new Set(prepared.discoverResult.providers?.load ?? []);
        const refsJaHidratadas = new Set(prepared.discoverResult.tools?.hydrate ?? []);
        const providersParaPromover = new Set(
          [...promocoesSkills, ...carregadasPeloJev, ...refsIntencao.map((r) => r.split('/')[0])].filter((id) => !providersJaCarregados.has(id)),
        );
        const refsParaPromover = new Set(
          [...usadas].filter((ref) => !refsJaHidratadas.has(ref)),
        );
        if ((providersParaPromover.size || refsParaPromover.size) && !entrada.abortSignal?.aborted) {
          // Mudança 2: soma em `msPromocao` mesmo no caminho de erro (`finally`) — a parede da
          // tentativa conta para `tempos.promocao` de qualquer forma, sucesso ou não.
          const t0Promocao = Date.now();
          try {
            const { prepared: preparedDoLoop } = await promoverNoTurno({
              bridge, manager, discoverBase: prepared.discoverResult, refs: refsParaPromover, providers: providersParaPromover,
              estadoAnterior, texto: entrada.texto, ctx, comVetores, itensDeConversa,
            });
            prepared = preparedDoLoop;
            blocks = preparedDoLoop.blocks;
            mesclarRenderErrors(renderErrors, preparedDoLoop.renderErrors);
          } catch (erro) {
            renderErrors.push({ ref: 'loop', error: String(erro?.message ?? erro) });
          } finally {
            msPromocao += Date.now() - t0Promocao;
          }
        }
      }
    } finally {
      // Cobre os `prepareTurn`s deste turno (o de cima, e o segundo que I3a pode disparar) — são
      // os únicos pontos deste turno em que `manager.discover()` roda. Ver comentário de
      // `pararKairos` acima.
      pararKairos();
    }
    // Mudança 2: início da fase `prepareTurnAcumulacao` — `aoIncluirConversa`, diagnóstico de
    // catálogo mudo, `derivarRefino`, `contratosDeCarregadas`, `contratosDoLoop` e
    // `construtor.acumular` (fechada logo depois dele, ver JSDoc de `aoMontar`).
    const t0PrepareTurnAcumulacao = Date.now();

    // R6 (Task 10, spec "decisor por anel: refinadores do kairos" §3.3): skill que o refinador
    // do anel `skill` ATIVOU neste turno (`discover.skills.activate`, refs
    // `<providerId>/skill/<chave>` — distinto de `discover.skills.suggest`/I3a acima, que só
    // SUGERE; `activate`/`suggest` são mutuamente exclusivos no kairos — `resolve/discover.ts`:
    // `activate = full`, `suggest = candidates` do mesmo anel). Com `skills.activation: 'host'`
    // (`createManager`, acima) o kairos NUNCA renderiza o corpo sozinho — `genos/bridge.js`
    // deixa `discoverResult.skills.activate` DE FORA do que ele carrega em `system:stable` (ver
    // comentário "R6" lá). É a fábrica quem pede ao host o corpo de cada skill ativada
    // (`config.aoSemear`, o MESMO canal que as fontes já usam para `Selecao.semear`) e injeta o
    // retorno na MENSAGEM deste turno (`turn:context`, nunca `system:stable` — skill ativada não
    // é piso permanente, é o que acabou de entrar agora). Skill ativada ≠ skill sugerida: por
    // isso não passa pelo I3a acima e não entra em `promocoes.skills`.
    const skillsAtivadas = prepared.discoverResult?.skills?.activate ?? [];
    const blocosDeSkillAtivada = [];
    const skillsJaSemeadas = [];
    const skillsComCorpo = [];
    if (skillsAtivadas.length && typeof config.aoSemear === 'function') {
      // Dedup contra o que as FONTES já pediram semear (`semearDasFontes`, acima, já chamado):
      // a MESMA skill pedida pelas duas origens no mesmo turno semeia uma vez só — chamar de
      // novo aqui duplicaria a chamada ao host para um id que ele já recebeu.
      const idsAtivadas = [...new Set(
        skillsAtivadas.map((ref) => ref.split('/').pop()).filter((id) => !semearDasFontes.includes(id)),
      )];
      if (idsAtivadas.length) {
        let semeadas = [];
        let sugeridas = [];
        try {
          let idsParaSemear = idsAtivadas;
          if (comportamentoNoTurno) {
            // Prepara sem semear: o corpo vem pronto e a memória de trabalho não muda. `requires` e já semeada seguem
            // para o `aoSemear` logo abaixo, como hoje (spec §7.3 e dedup).
            const preparo = normalizarRetornoDeSemear(await config.aoPrepararHabilidade(idsAtivadas, ctx));
            for (const falha of preparo.falhas) {
              renderErrors.push({ ref: 'fontes/semear', error: `${falha.id}: ${String(falha.erro?.message ?? falha.erro)}` });
            }
            const separadas = separarPreparadas(preparo.sucessos);
            sugeridas = separadas.sugeridas;
            idsParaSemear = separadas.semearDireto;
          }
          // F4 (correção da revisão final do conjunto): `normalizarRetornoDeSemear` aceita o
          // formato ANTIGO (array só de sucessos) e o NOVO (`{sucessos,falhas}`, o que
          // `semearNaMemoriaDeTrabalho` do chat devolve desde esta correção) — cada FALHA
          // parcial vira uma entrada em `renderErrors`, sem lançar; antes, uma falha parcial
          // lançava e derrubava TODOS os sucessos do mesmo `aoSemear`, mesmo os ids que
          // carregaram de verdade.
          if (idsParaSemear.length) {
            const { sucessos, falhas } = normalizarRetornoDeSemear(await config.aoSemear(idsParaSemear, ctx));
            semeadas = sucessos;
            for (const falha of falhas) {
              renderErrors.push({ ref: 'fontes/semear', error: `${falha.id}: ${String(falha.erro?.message ?? falha.erro)}` });
            }
          }
        } catch (erro) {
          // `renderErrors` já está montado (dentro do `try` do primeiro `prepareTurn`, acima) —
          // um erro daqui (depois do `try`/`finally`) vai direto nele, mesmo array mutável que
          // `onError` do `reconstruirBlocosDoTurno` e o bloco I3a já usam. Mesma garantia de
          // `aoEvento`/`aoMontar`: erro do host não derruba o turno.
          renderErrors.push({ ref: 'fontes/semear', error: String(erro?.message ?? erro) });
        }
        for (const s of semeadas) {
          // Dedup (fix 2026-10-29): skill que já estava na memória de trabalho (`jaCarregada`, corpo
          // idêntico ao disco) já entra no system a cada turno por `info:memoria/piso/trabalho` —
          // repetir o corpo aqui (11 mil caracteres, medido na sessão 5ca73137) só duplica. Fica o
          // registro em `skillsJaSemeadas` (fabrica.json). Skill com EDIÇÕES na memória nem chega
          // aqui: o host a recusa (`memoria_com_edicoes`, cai em `falhas`/renderErrors) e a versão
          // editada já está no system pela memória.
          if (s?.jaCarregada === true) {
            skillsJaSemeadas.push(skillsAtivadas.find((ref) => ref.split('/').pop() === s.id) ?? s.id);
            continue;
          }
          if (typeof s?.corpo !== 'string' || !s.corpo.trim()) continue;
          const refOriginal = skillsAtivadas.find((ref) => ref.split('/').pop() === s.id) ?? s.id;
          skillsComCorpo.push(refOriginal);
          blocosDeSkillAtivada.push({
            ref: `${refOriginal}#ativada`,
            destination: 'turn:context',
            priority: 1900,
            // Revisão do conjunto (I1): o aviso de versão/semântica (`s.aviso`, opcional) vai entre o cabeçalho e o
            // corpo — o modelo o lê NESTE turno, como na V1 (`load_skill` põe o aviso na frente do corpo).
            content: `Habilidade carregada agora: ${s.nome ?? s.id}\n\n${typeof s.aviso === 'string' && s.aviso.trim() ? `${s.aviso}\n\n` : ''}${s.corpo}`,
          });
        }
        // Habilidade que vale só no turno (`comportamento` ligado): mesmo bloco `#ativada`, cabeçalho com o ID e sem a
        // palavra "carregada" — ela não está na memória de trabalho. Entra na oferta do turno (o que o modelo pode declarar).
        for (const s of sugeridas) {
          if (typeof s?.corpo !== 'string' || !s.corpo.trim()) continue;
          const refOriginal = skillsAtivadas.find((ref) => ref.split('/').pop() === s.id) ?? s.id;
          skillsComCorpo.push(refOriginal);
          // `origem`/`nome`: o host usa para o card "Habilidade sugerida..." (o dono vê de onde veio a oferta).
          ofertaDeHabilidades.push({ id: s.id, ref: refOriginal, nome: s.nome, origem: 'jev' });
          blocosDeSkillAtivada.push({
            ref: `${refOriginal}#ativada`,
            destination: 'turn:context',
            priority: 1900,
            content: conteudoDaHabilidadeSugerida(s),
          });
        }
      }
    }

    // Habilidade de `carrega:` de memória que vale só no turno (`comportamento` ligado): mesmo bloco `#ativada` da do Jev.
    // O mesmo id pedido pelas duas origens já foi tirado da lista do Jev (dedup `semearDasFontes`, acima): o bloco sai
    // uma vez só, daqui. Ref: a do refinador, se ele também a ativou; senão `<capacidade da fonte>/skill/<id>`.
    for (const s of sugeridasDasFontes) {
      if (typeof s?.corpo !== 'string' || !s.corpo.trim()) continue;
      if (ofertaDeHabilidades.some((o) => o.id === s.id)) continue;
      const refOriginal = skillsAtivadas.find((ref) => ref.split('/').pop() === s.id) ?? refDoSemearDaFonte.get(s.id) ?? s.id;
      ofertaDeHabilidades.push({ id: s.id, ref: refOriginal, nome: s.nome, origem: 'memoria' });
      blocosDeSkillAtivada.push({
        ref: `${refOriginal}#ativada`,
        destination: 'turn:context',
        priority: 1900,
        content: conteudoDaHabilidadeSugerida(s),
      });
    }

    // Herança curta (spec §3.3): habilidade OFERECIDA no turno anterior e que o host não semeou (o modelo não a declarou)
    // vale mais UM turno quando este é continuação curta ("posso enviar?" -> "sim"). Só as ofertas FRESCAS do turno
    // anterior entram em `comportamentoAnterior` (a herdada não se herda de novo: vale uma vez). O corpo não fica no
    // estado: o host prepara de novo, e a mesma dedup de sempre decide — se a habilidade já está na memória de trabalho
    // (declarada e semeada no fecho, ou carregada pelo modelo), `jaCarregada` a tira da herança.
    const herdadasDescartadas = [];

    // Declarada e NÃO fixada no fecho do turno anterior (teto da memória de trabalho cheio, `memoria_com_edicoes`, modo,
    // poder ausente): o host deixou `{ id, ref, motivo }` em `despejo.comportamentoFalhasNoFecho`. Com `comportamento`
    // ligado ela volta como bloco neste turno MESMO sem continuação curta (a herança curta não a pegaria) e o modelo
    // recebe a nota `<nao_fixadas>` — o protocolo prometia o contexto fixo e ele não veio. Vale uma vez: o estado novo não
    // carrega a chave (o host a repõe só se o semeio falhar de novo, porque o modelo declarou de novo). Vem ANTES da
    // herança curta: o id reofertado aqui sai da lista dela (`ofertaDeHabilidades`).
    const falhasDoFechoAnterior = Array.isArray(estadoAnterior.despejo?.comportamentoFalhasNoFecho)
      ? estadoAnterior.despejo.comportamentoFalhasNoFecho.filter((f) => typeof f?.id === 'string' && f.id) : [];
    const naoFixadasNoTurno = [];
    const naoFixadasReofertadas = [];
    if (comportamentoNoTurno && falhasDoFechoAnterior.length) {
      const doEstado = new Map(falhasDoFechoAnterior.map((f) => [f.id, f]));
      // Já ofereceu de novo por outra via neste turno (Jev ou `carrega:`): o bloco já está lá, falta só a nota.
      for (const f of falhasDoFechoAnterior) {
        const jaOferecida = ofertaDeHabilidades.find((o) => o.id === f.id);
        if (!jaOferecida) continue;
        jaOferecida.origem = 'reofertada';
        naoFixadasNoTurno.push({ id: f.id, motivo: f.motivo });
        naoFixadasReofertadas.push({ id: f.id, motivo: f.motivo ?? null });
      }
      const idsParaReofertar = [...doEstado.keys()].filter((id) => !ofertaDeHabilidades.some((o) => o.id === id));
      if (idsParaReofertar.length) {
        try {
          const preparo = normalizarRetornoDeSemear(await config.aoPrepararHabilidade(idsParaReofertar, ctx));
          const { sugeridas } = separarPreparadas(preparo.sucessos);
          const sugeridasIds = new Set(sugeridas.map((x) => x.id));
          for (const falha of preparo.falhas) herdadasDescartadas.push({ id: falha.id, motivo: 'nao-fixada-falhou' });
          for (const p of preparo.sucessos) {
            if (!sugeridasIds.has(p.id)) herdadasDescartadas.push({ id: p.id, motivo: p.jaCarregada ? 'ja-na-memoria' : 'requires' });
          }
          for (const h of sugeridas) {
            if (typeof h?.corpo !== 'string' || !h.corpo.trim()) continue;
            const doFecho = doEstado.get(h.id);
            const refOriginal = doFecho?.ref ?? h.id;
            // `herdada`: veio do turno anterior — não entra em `comportamentoAnterior` (não se encadeia).
            ofertaDeHabilidades.push({ id: h.id, ref: refOriginal, herdada: true, nome: h.nome, origem: 'reofertada' });
            blocosDeSkillAtivada.push({
              ref: `${refOriginal}#ativada`,
              destination: 'turn:context',
              priority: 1900,
              content: conteudoDaHabilidadeSugerida(h),
            });
            naoFixadasNoTurno.push({ id: h.id, nome: h.nome, motivo: doFecho?.motivo });
            naoFixadasReofertadas.push({ id: h.id, motivo: doFecho?.motivo ?? null });
          }
        } catch (erro) {
          herdadasDescartadas.push({ id: '*', motivo: `erro: ${String(erro?.message ?? erro)}` });
        }
      }
    }
    const notaDeNaoFixadasDoTurno = notaDeNaoFixadas(naoFixadasNoTurno);

    const anteriorDoComportamento = Array.isArray(estadoAnterior.despejo?.comportamentoAnterior)
      ? estadoAnterior.despejo.comportamentoAnterior : [];
    if (comportamentoNoTurno && anteriorDoComportamento.length && ehContinuacaoCurta({
      cauda: false,
      comportamento: true,
      trivial: trivialDoTurno === true,
      continuidade: entrada.trivial === false && Boolean(entrada.motivoTrivial),
      pista: pistaDeContexto?.aplicada === true,
    })) {
      const idsHerdaveis = anteriorDoComportamento.map((a) => a?.id).filter((id) => typeof id === 'string' && id
        && !ofertaDeHabilidades.some((o) => o.id === id));
      if (idsHerdaveis.length) {
        try {
          const preparo = normalizarRetornoDeSemear(await config.aoPrepararHabilidade(idsHerdaveis, ctx));
          const { sugeridas } = separarPreparadas(preparo.sucessos);
          const sugeridasIds = new Set(sugeridas.map((x) => x.id));
          // Quem não volta não é erro do turno: vai para o diagnóstico, com o motivo (sem `renderErrors`).
          for (const falha of preparo.falhas) herdadasDescartadas.push({ id: falha.id, motivo: 'falhou' });
          for (const p of preparo.sucessos) {
            if (!sugeridasIds.has(p.id)) herdadasDescartadas.push({ id: p.id, motivo: p.jaCarregada ? 'ja-na-memoria' : 'requires' });
          }
          for (const h of sugeridas) {
            if (typeof h?.corpo !== 'string' || !h.corpo.trim()) continue;
            const refOriginal = anteriorDoComportamento.find((a) => a?.id === h.id)?.ref ?? h.id;
            ofertaDeHabilidades.push({ id: h.id, ref: refOriginal, herdada: true, nome: h.nome, origem: 'herdada' });
            blocosDeSkillAtivada.push({
              ref: `${refOriginal}#ativada`,
              destination: 'turn:context',
              priority: 1900,
              content: conteudoDaHabilidadeSugerida(h),
            });
          }
        } catch (erro) {
          herdadasDescartadas.push({ id: '*', motivo: `erro: ${String(erro?.message ?? erro)}` });
        }
      }
    }

    // Oferta de comportamento do turno (`{ oferecidas, herdadas }`; `undefined` desligado — a saída não ganha a chave).
    const oferecidasDoTurno = ofertaDoTurno(ofertaDeHabilidades, ofertaDeMemorias);
    const comportamentoDoTurno = saidaDoComportamento(comportamentoNoTurno, oferecidasDoTurno, herdadasDescartadas, naoFixadasReofertadas, memoriasJaPromovidas, Object.fromEntries(ofertaDeMemorias.map((m) => [m.id, m.texto])));

    // Fecha o laço da permanência: o canal `conversation` é stateless, então
    // quem quiser que um item continue entrando depois de incluído precisa
    // SABER que ele entrou — é isto que permite ao host reler essa marca no
    // próximo `conversa(ctx)` e decidir manter o item. Chamado uma vez por
    // turno, com as refs que de fato ENTRARAM (não as que só foram oferecidas)
    // — `discoverResult.conversation` só existe quando `conversation.items`
    // foi passado ao `prepareTurn` (algum item, de qualquer das duas fontes).
    // Erro dentro do handler é observação do host: não pode derrubar o turno.
    //
    // Correção do review da Fase 2: chamado AQUI, depois de I3a (o único bloco que ainda pode
    // disparar um SEGUNDO `prepareTurn` — Task 10 removeu o da promoção de `carregar` das
    // fontes, que hoje entra no estado do PRIMEIRO), lendo `prepared.discoverResult` já FINAL (o
    // discover AUMENTADO quando I3a promoveu algo, ou o original quando não). Antes desta
    // correção, a chamada usava o `prepared` do PRIMEIRO `prepareTurn` — anterior ao segundo, que
    // pode incluir itens de conversa diferentes (mesmo canal, resultado potencialmente distinto).
    try {
      config.aoIncluirConversa?.(ctx, prepared.discoverResult.conversation?.included ?? []);
    } catch {
      // engolido de propósito — mesma garantia de `aoEvento`/`aoChamada`.
    }

    // Diagnóstico do catálogo mudo. Não é trava: é o sinal que faltou no
    // pipeline V2 do Ariadne, onde a descoberta não ofereceu nada e o sintoma
    // só apareceu três camadas abaixo (tool chamada com `args: {}`, recusada
    // por campo obrigatório ausente). Uma sessão inteira de investigação para
    // um fato que cabia num evento.
    //
    // `unchanged` está fora de propósito: quando o texto é trivial o discover
    // devolve vazio DE PROPÓSITO, e avisar ali seria ruído em todo "ok".
    if (!prepared.discoverResult.unchanged) {
      const candidatos = prepared.discoverResult.providers?.candidates ?? [];
      // Curto-circuito ANTES do cálculo: `semanticasNaoCarregadas` só importa
      // quando `candidatos.length === 0` (linha abaixo) — computá-lo sempre
      // era trabalho jogado fora em todo turno não-trivial que já tinha
      // candidato, proporcional a `config.capacidades.length`.
      if (candidatos.length === 0) {
        const carregados = new Set(prepared.discoverResult.providers?.load ?? []);
        const semanticasNaoCarregadas = config.capacidades
          .filter((cap) => cap.piso === false && !carregados.has(cap.id))
          .map((cap) => cap.id);
        if (semanticasNaoCarregadas.length > 0) {
          // O handler é do host (log/métrica) e roda no caminho MENOS
          // exercitado — exatamente onde algo já está errado e um bug no
          // handler tem mais chance de existir. Mesma garantia que
          // `renderErrors` dá ao pacote: um evento de diagnóstico não pode
          // derrubar o turno. Engolido (não acumulado em `renderErrors`)
          // porque este evento não é sobre o PROMPT desta chamada — é
          // metadado externo para o host observar; não há consumidor dentro
          // do turno que precise saber que o `aoEvento` falhou.
          try {
            config.aoEvento?.({
              tipo: 'fabrica:catalogo-mudo',
              turno: estadoAnterior.turno,
              candidatos: 0,
              semanticasNaoCarregadas,
              degradado: prepared.discoverResult.degraded ?? null,
            });
          } catch {
            // engolido de propósito — ver comentário acima.
          }
        }
      }
    }


    const refino = derivarRefino(prepared.discoverResult?.explain ?? [], eventosDoKairos);

    const nomeDaFuncao = (providerId, key) => nomeExposto(providerId, key, { prefixar: prefixarPorCapacidade.get(providerId) ?? true });
    const contratosExtras = await contratosDeCarregadas(manager, estadoAnterior, blocks.turn, nomeDaFuncao);
    // Correção B (fluxo de bug, spec 2026-09-22 §6.4): contrato das funções que o loop do Jev
    // executou com sucesso NESTE turno, e das que ele escolheu e não executou (`paraOModelo`,
    // revisão do conjunto 7fe31cb7), para as que a promoção acima (bloco do loop) não conseguiu
    // hidratar de verdade (não são `fixa`/pinned, ranking não bateu) — ver JSDoc de
    // `contratosDoLoop`. `jaNoSystem` inclui `contratosExtras` para não duplicar uma ref que as
    // DUAS origens (carregada em turno anterior E usada pelo loop agora) pediram.
    // `refsComManualDoLoop` inclui as refs de `saidaDoLoop.paraOModelo` (escolhidas pelo Jev mas
    // não executadas) — mesmo caminho, mesma razão: o modelo precisa do manual mesmo sem depender
    // de ranking.
    // Bug do teste do dono (2026-10-02): a função de apresentar (`view.exibir: 'auto'`) do mesmo poder
    // acompanha o que ficou hidratado (discover) ou foi usado/escolhido pelo loop neste turno — ver
    // `refsAcompanhantes`. Tem o mesmo caminho de manual (`contratosDoLoop`), sem discover extra.
    const refsAcompanhantesDoTurno = refsAcompanhantes({
      capacidades: config.capacidades,
      refs: [...(prepared.discoverResult?.tools?.hydrate ?? []), ...refsComManualDoLoop],
    });
    // "Sobe junto" (spec 2026-10-29 §4.2), só com a cauda ligada: as fixas (e as acompanhantes delas) de capacidade que JÁ está
    // no system têm o manual no system, não na cauda. Entram aqui para o contrato chegar ao turno mesmo que o discover não
    // o tenha hidratado; quem decide que sobem é o `separarCauda`, que só promove de capacidade carregada (`sobeJunto`).
    const sobeJuntoDoTurno = sobeJuntoNaEntrada({ cauda: despejoCfg.cauda, capacidades: config.capacidades, carregados: estadoAnterior.kairos?.loadedProviders });
    const contratosDoLoopNesteTurno = await contratosDoLoop(manager, [...refsComManualDoLoop, ...refsAcompanhantesDoTurno, ...sobeJuntoDoTurno], [...blocks.turn, ...contratosExtras], nomeDaFuncao);

    // Cauda efêmera (spec 2026-10-29 §4.1): o que a seleção trouxe e o modelo ainda não usou vai para a mensagem do
    // turno em vez do system. `separarCauda` roda ANTES do `acumular` e só decide o que entra nele. Desligado
    // (`despejoCfg.cauda === false`) devolve as MESMAS referências que recebeu — o `acumular` não percebe diferença.
    const estadoDoDespejo = estadoAnterior.despejo ?? estadoDespejoVazio();
    const indiceDoTurno = [...linhasDeIndice(manager, prepared.discoverResult.tools.conscious), ...indicePiso];
    const cardsDoTurno = semCardsDeCarregados(prepared.discoverResult, blocks.turn);
    // Cards que `semCardsDeCarregados` tirou (a capacidade está em `providers.load`). Com a cauda, "carregada neste
    // turno" não é "no system": se a capacidade vai inteira para a cauda e fica sem descrição, o card volta.
    const cardsDeCarregadas = despejoCfg.cauda
      ? cardsComFuncoes(manager, blocks.turn.filter((b) => b.ref.endsWith('/card') && !cardsDoTurno.includes(b)))
      : [];
    const turnoDoTurno = [
      ...cardsComFuncoes(manager, cardsDoTurno),
      ...contratosExtras,
      ...contratosDoLoopNesteTurno,
      // `incluidos` das fontes (Task 6, spec 2 §3.4 passo 3) — ref de TRÊS partes
      // (`<capacidade>/<kind>/<chave>`), classificado como 'contribuicao' por `classificar`
      // (prompt-builder.js): entra como efêmero na mensagem DESTE turno, nunca no system
      // acumulado — é o `acumular` (não esta fábrica) quem faz a separação, pela mesma via
      // que qualquer bloco `turn:*` não-contrato já usava.
      //
      // M2 (revisão final do conjunto): `secoesEfemeras` (prompt-builder.js) NÃO ordena por
      // `priority` dentro de uma classe — renderiza na ordem do ARRAY (`lista.map(...)`). Sem
      // ordenar aqui, `priority` era um campo morto para blocos efêmeros: blocos efêmeros nunca
      // passam por dedup (só o `system` acumulado passa por `acumular`) — o campo não tinha
      // efeito nenhum, nem em dedup nem na ordem de leitura. `.sort` é ESTÁVEL (V8/Node ≥ 11) —
      // itens com a mesma `priority` mantêm a ordem relativa original.
      //
      // Task 10 (R6): `blocosDeSkillAtivada` ANTES de `blocosDasFontes` — o que o refinador do
      // anel `skill` acabou de ativar neste turno é mais urgente que o que as fontes ofereceram
      // por relevância comum.
      ...blocosDeSkillAtivada,
      ...[...blocosDasFontes].sort((a, b) => a.priority - b.priority),
    ];
    const explainProvider = new Map((prepared.discoverResult?.explain ?? []).filter((x) => x.ring === 'provider').map((x) => [x.ref, x]));
    // Sinal forte deste turno (spec §4.5/§5): a seleção trouxe a capacidade com convicção. É a MESMA régua para o que
    // pode voltar à cauda depois de descartado e para o que o despejo não pode tirar neste turno.
    const sinalForteAgora = criarSinalForte(explainProvider, despejoCfg.sinalForte);
    const separado = separarCauda({
      ligado: despejoCfg.cauda,
      classificar,
      indice: indiceDoTurno,
      turno: turnoDoTurno,
      system: blocks.system,
      piso: pisoIds,
      carregados: new Set(estadoAnterior.kairos?.loadedProviders ?? []),
      hidratadas: new Set(estadoAnterior.kairos?.hydratedTools ?? []),
      comManual: new Set(estadoAnterior.system.capacidades.flatMap((c) => c.funcoes.filter((f) => f.manual).map((f) => f.ref))),
      exigeSinalForte: exigeSinalForte(estadoDoDespejo, { m: despejoCfg.m }),
      sinalForte: sinalForteAgora,
      cardsDeCarregadas,
      doLoop: new Set(refsComManualDoLoop),
      sobeJunto: new Set(sobeJuntoDoTurno),
    });

    let acumulacao = construtor.acumular({
      anterior: estadoAnterior.system,
      // Os contratos de quem foi carregado por `load_capability` em turnos
      // ANTERIORES. Sem isto a capacidade volta ao prompt (o provider persiste
      // em `loadedProviders`) mas volta como CARREGÁVEL: o discover re-decide
      // hidratação por relevância a cada turno, e quem guarda o manual entre
      // turnos é o acumulado — que nunca o recebeu, porque a acumulação roda
      // ANTES do laço em que o modelo pediu o manual.
      //
      // Medido: `T2 load: [agenda, relatorios]` mas `T2 hydrate: [agenda/…]` —
      // a capacidade de volta, o manual não, e o modelo recarregando a cada
      // turno.
      system: separado.system,
      // ⚠️ Os contratos entram por `turno`, e não por `system`: é o laço de
      // `input.turno` que preenche `funcao.manual` (prompt-builder, "2.
      // Manuais"). Pelo `system` eles caem na rotina de CONTRIBUIÇÃO e
      // estouram a trava de prioridade duplicada — medido.
      turno: separado.turno,
      indice: separado.indice,
      conscientes: prepared.discoverResult.tools.conscious,
      providersCarregados: prepared.discoverResult.providers.load,
      prioridadeDeclarada: prioridadePorCapacidade,
    });
    tempos.prepareTurnAcumulacao = Date.now() - t0PrepareTurnAcumulacao;
    // Mudança 2: início da fase `montagemDoPrompt` — `secaoProtocolo`, `entregaDoLoop` e
    // `construtor.montar` (fechada logo antes de `config.aoMontar`).
    const t0Montagem = Date.now();

    // A seção do protocolo é FIXA: entra no topo do system, junto das seções do
    // perfil, e nunca invalida nada.
    const secaoProtocolo = comoCarregarNoProtocolo(estrategia.secaoInvariante(), bridge, { estrategia, mecanicaNoCatalogo });
    // O contexto do prompt é UM só: a conta do despejo e o `montar` leem o mesmo, senão a conta mediria um system
    // que não é o enviado (a seção do protocolo entra no topo do system — ou no catálogo, com `mecanicaNoCatalogo`).
    const contextoDoPrompt = mecanicaNoCatalogo
      ? { ...ctx, __secoesExtra: [], __instrucoesDeCapacidades: secaoProtocolo?.conteudo || '' }
      : { ...ctx, __secoesExtra: secaoProtocolo ? [secaoProtocolo] : [] };

    // Despejo em lote (spec 2026-10-29 §5): o que o modelo não usou há mais de X mensagens sai do system, numa
    // quebra de cache só, quando a conta compensa. Roda DEPOIS do `acumular` (que decide o que está no system) e
    // ANTES da montagem (a conta mede o system exato que vai ser enviado).
    let diagDespejo = null;
    let estadoDoDespejoTurno = estadoDoDespejo;
    if (despejoCfg.despejo) {
      // `evictAfterIdleTurns: null` = nunca despejar (como na V1, que só age com valor > 0); `x: 0` faz o módulo puro
      // pular a capacidade. Ausente cai no X global. Atenção: `sticky: true` aqui também NUNCA despeja (spec §5.1), o que
      // difere da V1, onde `sticky` só protegia da evicção por ociosidade do Kairos.
      const porCapacidade = new Map(config.capacidades.map((c) => [c.id, {
        x: c.sessionBehavior?.evictAfterIdleTurns === null ? 0 : (c.sessionBehavior?.evictAfterIdleTurns ?? undefined),
        sticky: c.sessionBehavior?.sticky === true,
      }]));
      const marcadosBrutos = descartaveis(estadoDoDespejo, { mensagem: estadoAnterior.turno, system: acumulacao.system, x: despejoCfg.x, piso: pisoIds, porCapacidade });
      // Proteção do despejo (costura.js): o que o loop do Jev trouxe NESTE turno e o que a seleção trouxe de volta com
      // sinal forte não saem. `refsAcompanhantesDoTurno` NÃO serve aqui (parte de `tools.hydrate`, que traz as `fixa`).
      const { marcados } = protecaoDoDespejo({
        marcadosBrutos,
        refsDoLoop: refsComManualDoLoop,
        capacidades: config.capacidades,
        hidratadas: prepared.discoverResult?.tools?.hydrate ?? [],
        sinalForte: sinalForteAgora,
      });
      if (marcados.capacidades.length || marcados.funcoes.length) {
        const medidas = entrada.medidasDoCache ?? {};
        const { r, w } = parametrosDoModelo(despejoCfg, medidas.modelo ?? null);
        const systemCom = despejar(acumulacao.system, marcados);
        const { H } = horizonte({ chamadas: medidas.chamadasPorMensagem ?? [], k: despejoCfg.k, n: despejoCfg.n, nEstimado: medidas.nEstimado ?? null });
        const conta = decidirDespejo({
          systemAnterior: estadoDoDespejo.systemEnviado,
          systemSem: construtor.renderizarSystem(contextoDoPrompt, acumulacao.system),
          systemCom: construtor.renderizarSystem(contextoDoPrompt, systemCom),
          historicoChars: (entrada.historico ?? []).reduce((soma, m) => soma + (typeof m.content === 'string' ? m.content.length : 0), 0),
          razao: medidas.razaoTokensPorChar ?? despejoCfg.razaoPadrao,
          r, w, H,
          minutosDesdeUltima: typeof medidas.ultimaChamadaEm === 'number' ? (Date.now() - medidas.ultimaChamadaEm) / 60000 : null,
          pausaMin: despejoCfg.pausaMin,
        });
        if (conta.disparou) {
          // `registrarDescarte` lê os nomes das funções no system ANTES do despejo.
          estadoDoDespejoTurno = registrarDescarte(estadoDoDespejo, { mensagem: estadoAnterior.turno, ...marcados, system: acumulacao.system });
          acumulacao = { ...acumulacao, system: systemCom, sairam: [...acumulacao.sairam, ...marcados.capacidades, ...marcados.funcoes] };
        }
        diagDespejo = { marcados, conta };
      }
    }
    // Aviso do que saiu por falta de uso (só o que já foi usado), vai na mensagem do turno junto da cauda.
    // Cauda herdada (continuação curta): a cauda do turno anterior que não foi usada vale por mais um turno quando este
    // é continuação do anterior — "posso enviar?" -> "sim". Os três sinais já existem aqui, nenhum é novo: turno trivial,
    // veto de trivial por continuidade do host (`entrada.trivial === false` com `motivoTrivial`, que o executor só envia
    // quando `decidirContinuidade` opina) e pista de contexto aplicada. Fora disso, `caudaAnterior` é ignorada.
    const continuacaoCurta = ehContinuacaoCurta({
      cauda: despejoCfg.cauda,
      trivial: trivialDoTurno === true,
      continuidade: entrada.trivial === false && Boolean(entrada.motivoTrivial),
      pista: pistaDeContexto?.aplicada === true,
    });
    const { cauda: caudaDoTurno, herdadas: herdadasDoTurno } = caudaDoTurnoComHerdada({
      continuacaoCurta, estadoDoDespejo, propria: separado.cauda, system: acumulacao.system,
    });
    const textoDoAviso = despejoCfg.despejo ? avisoDeDescartadas(estadoDoDespejoTurno.descartadas, { tetoChars: despejoCfg.tetoAvisoChars }) : '';
    // M2 (revisão de qualidade da Fase 3): `entregaDoLoop` é código deste pacote, não do host —
    // mas ainda assim não pode derrubar um turno cujo loop já rodou com sucesso. Mesma garantia
    // que o resto deste bloco dá a `config.loop.rodar`.
    try {
      entrega = saidaDoLoop ? entregaDoLoop(saidaDoLoop, { corteHistorico: config.loop?.corteHistorico ?? 0.7, autorizadas: autorizadasDoLoop }) : null;
    } catch (erro) {
      entrega = null;
      renderErrors.push({ ref: 'loop', error: String(erro?.message ?? erro) });
    }
    const payload = construtor.montar({
      contexto: contextoDoPrompt,
      texto: entrada.texto,
      system: acumulacao.system,
      efemeros: acumulacao.efemeros,
      // `historico` é só dos turnos ANTERIORES, verbatim (ver JSDoc de `EntradaDaMontagem.
      // historico`, prompt-builder.js). O rastro do Jev é deste turno — exceção deliberada à
      // regra de não guardar payload de tool (spec L7: não atravessa turnos; `ctx.processedMessages`,
      // que alimenta `entrada.historico` do turno SEGUINTE, nunca carrega o que só existe aqui) —
      // e por isso entra em `aposOPedido`, nunca somado a `historico`. Correção A (fluxo de bug,
      // sessões 54862f78/08cd7835, 22-09): antes desta correção o rastro entrava ANTES do `usr`
      // (junto de `historico`), e o modelo lia a chamada do Jev como se fosse de um turno passado
      // — ver JSDoc de `aposOPedido`.
      historico: entrada.historico || [],
      ...(entrada.anexos ? { anexos: entrada.anexos } : {}),
      ...(entrega?.bloco ? { preHidratacao: entrega.bloco } : {}),
      ...(entrega?.historico?.length ? { aposOPedido: entrega.historico } : {}),
      // Cauda efêmera: manuais que a seleção trouxe e ainda não foram usados. Vazia = `renderizarCauda`
      // devolve '' e o prompt-builder descarta a seção (desligado, nada muda).
      extrasDoTurno: [
        { nome: 'manuais_do_turno', conteudo: renderizarCauda(caudaDoTurno) },
        { nome: 'descartadas', conteudo: textoDoAviso },
        // Aceite de contribuição: habilidade declarada que não foi fixada no fecho anterior (vazio fora do caso).
        { nome: 'nao_fixadas', conteudo: notaDeNaoFixadasDoTurno },
      ],
    });
    tempos.montagemDoPrompt = Date.now() - t0Montagem;
    // Mudança 2: fecha `tempos` — `promocao` (acumulado nos dois pontos de `promoverNoTurno`,
    // ver `msPromocao`), `ateOModelo` (parede total do turno até aqui — a chamada ao MODELO em si
    // roda DEPOIS deste ponto, no laço agêntico do genos, fora deste arquivo) e `outros` (o que
    // sobra depois de somar as fases nomeadas — trabalho síncrono entre fases que nenhuma cobre
    // de propósito, ex. a leitura de contribuições semânticas antes do embed; correção do dono
    // 2026-09-23: "sem buraco", `outros` é o buraco medido, não escondido. Desde o fix round 1
    // (A4) o embed CONTEXTUAL da pista de contexto também cai aqui: ele saiu da janela de
    // `fontesMemoria` para não atribuir ao host um custo que não é de fonte — o número próprio
    // dele continua em `pistaDeContexto.embeds.ms`).
    tempos.promocao = msPromocao;
    tempos.ateOModelo = Date.now() - t0Turno;
    tempos.outros = tempos.ateOModelo - (
      tempos.catalogo + tempos.discoverInicial.total + tempos.fontesMemoria + tempos.loop
      + tempos.promocao + tempos.prepareTurnAcumulacao + tempos.montagemDoPrompt
    );

    // Emite o payload MONTADO deste turno — uma vez, logo depois de
    // `construtor.montar(...)`. Dois consumidores: o tracer do orquestrador de
    // tela (`src/orquestrador/tracer.ts#payload`) e um inspetor ao vivo
    // futuro. `entraram`/`sairam` vêm do retorno de `construtor.acumular(...)`
    // (calculado ACIMA, não daqui) — é o dado mais valioso: mostra a EVOLUÇÃO
    // do prompt turno a turno, não só o estado final. Erro dentro do handler
    // é observação do host: não pode derrubar o turno (mesma garantia de
    // `aoEvento`/`aoChamada`/`aoIncluirConversa`).
    try {
      config.aoMontar?.({
        mensagens: payload.mensagens,
        secoes: payload.secoes,
        system: payload.system,
        mensagemDoTurno: payload.mensagemDoTurno,
        // Despejo (spec 2026-10-29): o que ficou marcado e a conta do cache; `null` sem nada marcado. O host grava no artefato.
        despejo: diagDespejo,
        entraram: acumulacao.entraram,
        sairam: acumulacao.sairam,
        discover: prepared.discoverResult,
        // `embeds` (Task 11, spec F1; `'trivial'` desde o I1 da revisão final / kairos 0.832):
        // quantos embeds de CONSULTA a fábrica fez ela mesma neste turno (0 quando o host mandou
        // `vetoresDaPergunta`/`embeddingDaPergunta`, quando o texto é trivial, ou quando a
        // tentativa falhou), o tempo gasto, a origem (`'entrada'` veio do host, `'fabrica'`
        // embedou aqui, `'nenhum'` sem embedder, `'trivial'` texto trivial — nem tentou) e `erro`,
        // quando a tentativa daqui falhou (o kairos ainda pode tentar de novo por conta própria —
        // ver comentário acima do bloco de embed).
        embeds,
        // B3.3 fase 2 — DIAGNÓSTICO da pista de contexto deste turno, SEM o texto dela:
        // `solicitada`/`aplicada`, `motivo` (incluindo os quatro de fallback da
        // orquestração), `regra`, `mensagensUsadas`, `chars` e os `embeds` CONTEXTUAIS,
        // medidos à parte de `embeds` acima (que não os absorve nem os duplica). Sem
        // `pistaDeContexto` na entrada, vem o diagnóstico neutro — sem embed, sem hint.
        pistaDeContexto,
        // Spec 2026-10-14 §7.1: quem decidiu o trivial deste turno (`host` = executor; `regra-kairos` = `isTrivial`).
        trivial: {
          valor: trivialDoTurno,
          motivo: typeof entrada.trivial === 'boolean' ? (entrada.motivoTrivial ?? 'host') : 'regra-kairos',
          enviadoAoKairos: typeof entrada.trivial === 'boolean',
        },
        // As capacidades ACUMULADAS com a prioridade que cada uma recebeu na
        // inserção. Sai daqui, e não do `discover`, porque o discover é do
        // TURNO (quem carregou agora) e a prioridade é do ACUMULADO —
        // inclusive das que entraram turnos atrás e continuam no prompt. É o
        // número que explica a ORDEM do bloco; sem ele a ordem parece
        // arbitrária para quem inspeciona.
        capacidadesAcumuladas: acumulacao.system.capacidades.map((c) => ({
          id: c.id,
          prioridade: c.prioridade,
          // As funções COMO ESTÃO NO PROMPT, e não como o discover deste turno
          // as decidiu. A diferença é visível e confundiu o dono: uma tool
          // cujo manual veio do ACUMULADO (carregada num turno anterior) não
          // aparece em `discover.tools.hydrate`, que é só a decisão de agora —
          // e o inspetor mostrava a capacidade carregada com as funções dela
          // ausentes da lista de hidratadas.
          funcoes: c.funcoes.map((f) => ({ nome: f.nome, ref: f.ref, temManual: Boolean(f.manual) })),
        })),
        // Os pisos que falharam ao renderizar, na hora em que o host ainda
        // pode gravá-los junto do turno a que pertencem. Eles também saem no
        // retorno, mas lá chegam depois do laço inteiro — e um turno que morre
        // no meio nunca os entregaria, que é justo aquele em que saber qual
        // bloco NÃO entrou no prompt mais importa.
        renderErrors,
        // I3 (revisão final do conjunto): eventos `degraded`/`budget.cut` que o manager do
        // kairos emitiu nos `prepareTurn` deste turno — ver comentário de `pararKairos` acima.
        eventosDoKairos,
        // Task 6 (spec 2 §3.4): telemetria por fonte deste turno — mesmo valor entregue no
        // retorno de `executarTurno` (ver comentário lá).
        fontes,
        // I3a (revisão final do conjunto; Task 10, R10): ids de capacidade promovidos neste
        // turno, por ORIGEM — `fontes` são os ids que ENTRARAM de fato pelo estado injetado
        // antes do primeiro `prepareTurn` (`promocoesFontes`, nunca em `unchanged` — ver
        // comentário do bloco I3a acima); `skills` é o que o SEGUNDO `prepareTurn` (I3a,
        // `promoverNoTurno`) acrescentou por skill sugerida sem provider carregado
        // (`promocoesSkills`). Não confundir com `fontes[].carregar` (acima), que é o que cada
        // fonte PEDIU, promovido ou não. Mesmo valor entregue no retorno de `executarTurno` (ver
        // comentário lá).
        promocoes: { fontes: [...promocoesFontes], skills: [...promocoesSkills], semVoto: [...promocoesSemVoto], skillsAbaixoDoCorte: [...promocoesSkillsAbaixoDoCorte] },
        // Task 10 (R6): refs de skill que o refinador do anel `skill` ATIVOU neste turno
        // (`discover.skills.activate`) — mesmo valor entregue no retorno de `executarTurno` (ver
        // comentário lá). `blocosDeSkillAtivada`/`payload.mensagemDoTurno` já carregam o corpo
        // que `config.aoSemear` devolveu; isto aqui é só a lista de refs que o kairos ativou,
        // para quem quiser correlacionar sem reparsear a mensagem.
        skillsAtivadas,
        // Dedup: refs ativadas que já estavam na memória de trabalho (sem bloco `#ativada`).
        skillsJaSemeadas,
        // Refs ativadas cujo bloco `#ativada` entrou de fato no turn_context (semeio ok, corpo novo).
        skillsComCorpo,
        // Aceite de contribuição (spec 2026-10-29 aceite): só com `comportamento` ligado — a oferta do turno.
        ...(comportamentoDoTurno ? { comportamento: comportamentoDoTurno } : {}),
        // Task 11 (R11/§3.4): agregado do refino por anel deste turno — mesmo valor entregue no
        // retorno de `executarTurno` (ver comentário lá, e o comentário do bloco `const refino =
        // (() => {...})()` acima, onde ele é calculado).
        refino,
        // Mudança 2 (2026-09-23): ms de parede por fase deste turno — mesmo valor entregue no
        // retorno de `executarTurno` (ver comentário lá, e o JSDoc de `aoMontar` acima).
        tempos,
        // Spec do porte (§5.4): `{ valores, origem, resumo }` dos limiares deste turno — mesmo
        // valor entregue no retorno de `executarTurno` (ver comentário lá). `motivo` (M3, revisão
        // do conjunto) só aparece quando `infoLimiares` veio do ramo de fallback global
        // (sem-embedder/poucos-exemplos/erro) — omitido, não `undefined`, para não sujar o objeto.
        limiares: { valores: infoLimiares.valores, origem: infoLimiares.origem, resumo: infoLimiares.resumo, ...(infoLimiares.motivo ? { motivo: infoLimiares.motivo } : {}) },
      });
    } catch {
      // engolido de propósito — ver comentário acima.
    }

    // Uma vez só: `schema()` é tipado como função pura devolvendo constante, e
    // chamá-la três vezes por turno convida alguém a torná-la stateful depois.
    const schemaDaResposta = estrategia.schema();

    // O genos não dá id de chamada, e os eventos de fim carregam só o
    // `toolName` — sem correlação, quem consome não tem como saber QUAL
    // chamada terminou, e vira uma linha por evento em vez de uma linha que
    // muda de estado. As chamadas chegam em ordem, então uma FILA por toolName
    // casa cada fim com o início certo.
    const emAberto = new Map();
    let seq = 0;

    /**
     * Refs que o `load_capability` trouxe DURANTE este turno.
     *
     * 🚨 Sem isto elas evaporam, e o efeito foi medido: uma capacidade
     * carregada no meio do turno NÃO volta hidratada no turno seguinte. A
     * causa está no kairos (`session/policy.js`): `applySessionPolicy` monta
     * `hydratedTools` a partir de `discoverOut.tools.hydrate` — o que o
     * DISCOVER decidiu no INÍCIO do turno. O que a meta-tool carregou depois
     * não está ali, e o `loaded` que ela devolve era descartado.
     *
     * Consequência sem o conserto: o modelo carrega a mesma capacidade a cada
     * turno, de novo, pagando a volta perdida que a legenda manda evitar.
     */
    const carregadasNoTurno = new Set();
    // Funções que o guarda recusou neste turno (`manual_nao_carregado`) — não contam como uso (spec §4.2).
    const recusadasNoTurno = new Set();

    const abrir = (toolName, args) => {
      // Só a meta-tool `call_capability` embrulha `{ ref, args }`. Função com argumento próprio
      // chamado `ref` (`navegador__clicar {"ref":"e10"}`) não pode virar a chamada "e10".
      const meta = toolName === 'call_capability' && args && typeof args === 'object' ? args : {};
      const ref = typeof meta.ref === 'string' ? meta.ref : toolName;
      const argsReais = meta.args ?? args;
      // `toolName` viaja junto de propósito (revisão do bloco A, item 8): para a
      // meta-tool `call_capability`, `ref`/`nome` é o NOME INTERNO da função
      // alvo (`memoria/tool/mem_ler`), enquanto os eventos crus da tool
      // (`tool.started`/`tool.emitted`) trazem `call_capability`. Quem correlaciona
      // os dois lados por fila (a fábrica, `fabrica/turno.js`) precisa da MESMA
      // chave nos dois — sem este campo a fila abria sob `ref` e o `tool:result`
      // chegava órfão. Para tool normal `ref === toolName`, então nada muda.
      const chamada = { id: `c${++seq}`, ref, toolName, nome: ref, args: argsReais };
      const fila = emAberto.get(toolName);
      if (fila) fila.push(chamada); else emAberto.set(toolName, [chamada]);
      return chamada;
    };

    const fechar = (toolName) => emAberto.get(toolName)?.shift()
      // Fim sem início casado não deveria acontecer; se acontecer, ganha linha
      // própria em vez de o evento sumir em silêncio.
      ?? { id: `orfa-${++seq}`, ref: toolName, toolName, nome: toolName, args: null };

    const runStore = new InMemoryRunStore();
    const runId = randomUUID();
    // Gancho opcional do host: recebe o par do turno antes de o run começar, para
    // conseguir ler o histórico mesmo quando `executarTurno` lança (ver
    // async-shadows/agents/motor-llm.js). Erro do host não derruba o turno.
    try { entrada.aoAbrirRun?.({ runId, runStore }); } catch { /* observação do host */ }
    // Mensagem intra-turno (spec 2026-10-28): textos aceitos pelo genos e ids que
    // entraram no loop, para o histórico do turno.
    const textosIntraTurno = new Map();
    const entreguesNoTurno = [];
    // Registro do que foi ao modelo (o host grava no `fabrica.json`): o genos chama `formatUserMessages` na fronteira entre
    // iterações e só depois emite `user_message_delivered`. Guardamos o lote formatado aqui e o anexamos a esse evento —
    // o enquadramento não volta ao host por outro caminho (o genos o põe no histórico e não o devolve).
    let ultimoLote = null;
    let avisoDePrazoEm = null;
    const formatarELembrar = (itens) => {
      const enquadramento = formatarMensagensIntraTurno(itens);
      ultimoLote = {
        ids: itens.map((m) => m.id),
        enquadramento,
        mensagens: itens.map((m) => {
          const sistema = Boolean(m?.metadata?.sistema);
          return { id: m.id, texto: String(m.content ?? ''), sistema, ...(sistema && avisoDePrazoEm ? { recebidaEm: avisoDePrazoEm } : {}) };
        }),
      };
      return enquadramento;
    };
    const orchestrator = createOrchestrator({
      // Passagem genérica (`config.genos`): vem PRIMEIRO, então toda chave que a fábrica define
      // abaixo vence. Chaves que a fábrica só define condicionalmente (ex.: `pricingResolver`,
      // `validateTurn`) valem do host quando a fábrica não as define.
      ...(config.genos ?? {}),
      provider: config.provider(ctx),
      runStore,
      // N-guarda: `manager`/`carregadasNoTurno` habilitam o guarda a reconsultar,
      // A CADA CHAMADA (não só na montagem), o que `load_capability` trouxe NO
      // MEIO deste turno — ver o comentário no laço de `registryDoTurno` acima.
      // Gate (spec §4.3): terceira fonte de manual — as funções com manual na CAUDA deste turno executam
      // mesmo sem estar no system acumulado.
      tools: registryDoTurno(bridge, ctx, new Set([...nomesComManualNoPrompt(acumulacao), ...nomesDaCauda(caudaDoTurno)]), estrategia.registraCapacidades, manager, carregadasNoTurno, idsComInstrucoesNoPrompt(acumulacao, caudaDoTurno), recusadasNoTurno),
      initialMessages: payload.mensagens,
      toolProtocol: estrategia.toolProtocol,
      outputMode,
      // Só onde as capacidades NÃO são registradas (nativo): lá a porta é `call_capability`.
      // Em envelope/fence o nome direto é a porta, e o texto mentiria.
      ...(estrategia.registraCapacidades === false ? { unknownToolMessage: ({ toolName }) => mensagemDeToolDesconhecida(toolName) } : {}),
      maxIterations: maxIteracoes,
      formatUserMessages: formatarELembrar,
      ...(config.validateTurn ? { validateTurn: config.validateTurn } : {}),
      ...(estrategia.forceFinishMessage ? { forceFinishMessage: estrategia.forceFinishMessage } : {}),
      // Observador de runtime do genos (eventos normalizados `agent.*`, com
      // `kind`/`seq`/`turnIndex`/`payload`) — repassado cru, é do HOST: é o
      // que alimenta as projeções de observabilidade (homura: agentic-loop,
      // run-timeline) sem a fábrica conhecer nenhuma delas.
      ...(config.runtimeObserver ? { runtimeObserver: config.runtimeObserver } : {}),
      // Ver o JSDoc de `ConfigDoOrquestrador.pricingResolver` — repasse cru.
      ...(config.pricingResolver ? { pricingResolver: config.pricingResolver } : {}),
      // `responseSchema` viaja no metadata até o provider adapter (o genos
      // clona config.metadata para request.metadata). É como o schema do
      // envelope chega ao structured output sem a fábrica conhecer o adapter.
      metadata: {
        // 🚨 A CHAVE SEGMENTA O CACHE NO PROVIDER. Cair no `runId` — que é
        // `randomUUID()` NOVO a cada turno — faz o turno seguinte procurar o
        // prefixo noutra gaveta: por mais idêntico que ele seja, não há como
        // acertar. Medido (sessão d359a6e8): dentro do turno 1 o cache subia
        // (4247 → 4259 → 5044 → 5691 → 7726) e a PRIMEIRA chamada do turno 2
        // vinha `cache=0`, com 7204 tokens de entrada reprocessados. Parecia
        // invalidação por mudança no system; era chave nova.
        //
        // `conversaId` nunca foi preenchido por ninguém (nem V1 nem V2) — o
        // fallback era o caminho ÚNICO, não a exceção. `threadId` é o mesmo
        // conceito com o nome do host: estável na conversa, novo a cada F5.
        // `runId` fica como último recurso, para host que não tenha nenhum dos
        // dois — aí o cache degrada para dentro do turno, que é o que sempre foi.
        promptCacheKey: ctx.conversaId || ctx.threadId || runId,
        ...(schemaDaResposta ? { responseSchema: schemaDaResposta } : {}),
      },
      // `config.aoTexto` também é observação de host (delta de streaming, não
      // consumido por dentro do turno) — mesma garantia de `avisar` acima.
      // Empacotado numa função em vez de passar a referência crua porque o
      // genos chama `onMessage` sem proteção própria (`orchestrator.js`, tanto
      // no laço de streaming quanto no fechamento não-streaming): sem isto,
      // uma exceção do host ali dentro sobe pelo `try/catch` do genos e vira
      // `provider.failed` — reportando a chamada ao provider como tendo
      // falhado quando na verdade só o observador quebrou.
      onMessage: (texto) => avisar(config.aoTexto, texto),
      onEvent: (evento) => {
        if (evento?.type === 'tool.started') {
          // As refs vêm dos ARGUMENTOS (o que foi pedido), não do retorno: o
          // evento do genos não carrega o resultado. Pedido ⊇ carregado — uma
          // ref recusada (permissão, nome errado) entraria aqui sem ter
          // carregado. É aceitável porque o passo seguinte resolve contra o
          // registry e descarta o que não existe.
          if (evento.toolName === 'load_capability') {
            const refs = evento.args?.refs ?? evento.args?.args?.refs;
            for (const r of Array.isArray(refs) ? refs : []) carregadasNoTurno.add(r);
          }
          const c = abrir(evento.toolName, evento.args);
          avisar(config.aoChamada, { fase: 'inicio', ...c });
        } else if (evento?.type === 'tool.completed') {
          const c = fechar(evento.toolName);
          operacoes.push({ nome: c.nome, args: c.args, ok: true });
          avisar(config.aoChamada, { fase: 'fim', ok: true, ...c });
        } else if (evento?.type === 'tool.failed') {
          const c = fechar(evento.toolName);
          operacoes.push({ nome: c.nome, args: c.args, ok: false, erro: evento.error });
          avisar(config.aoChamada, { fase: 'fim', ok: false, erro: evento.error, ...c });
        }
        let eventoParaOHost = evento;
        if (evento?.type === 'user_message_delivered') {
          // O aviso de prazo também passa pela fila, mas não é mensagem do usuário: não vira "entregue".
          entreguesNoTurno.push(...(evento.messageIds || []).filter((id) => id !== ID_AVISO_DE_PRAZO));
          // O host recebe também o lote e o enquadramento EXATO que foi ao modelo (só se o lote lembrado é o deste evento).
          const mesmoLote = ultimoLote
            && ultimoLote.ids.length === (evento.messageIds || []).length
            && ultimoLote.ids.every((id, i) => id === evento.messageIds[i]);
          if (mesmoLote) eventoParaOHost = { ...evento, enquadramento: ultimoLote.enquadramento, mensagens: ultimoLote.mensagens };
        }
        avisar(config.aoEvento, eventoParaOHost);
      },
    });

    // `.catch(() => {})`: se `cancel()` rejeitar, é uma unhandled rejection —
    // ninguém aguarda esta chamada (é fire-and-forget de propósito, ver comentário
    // abaixo). `{ once: true }` evita acumular listener em signal de sessão
    // reusado por vários turnos (o caso do executor, na próxima spec): sem isso,
    // depois de 10 turnos o Node emite MaxListenersExceededWarning porque cada
    // turno empilhava mais um listener retendo `orchestrator`/`runStore`.
    const aoAbortar = () => { void orchestrator.cancel(runId, 'cancelado').catch(() => {}); };
    if (entrada.abortSignal) {
      // `addEventListener('abort', ...)` num signal JÁ abortado nunca dispara —
      // o evento foi emitido no passado. Sem este `if`, um signal abortado ANTES
      // de `executarTurno` ser chamado deixaria o turno rodar inteiro sem cortar
      // nada (mesma guarda do `in-process.js` dos shadows).
      if (entrada.abortSignal.aborted) aoAbortar();
      else entrada.abortSignal.addEventListener('abort', aoAbortar, { once: true });
    }

    // Fora do `try`: o `finally` devolve ao ctx o que o genos aceitou e não entregou.
    let resultado;
    let sobrasDoErro = [];
    let timerDoPrazo = null;
    try {
      // A-I6 (aterrissagem suave, mesma regra da V1) — OPT-IN (`config.aterrissarNoTeto`): o
      // teto de iterações do laço agêntico NÃO derruba o turno. SÓ esse erro é capturado
      // (`Max iterations exceeded (N)`, do genos); qualquer outro (provider, rede, bug) segue
      // subindo. O turno conclui sem texto do modelo, com `tetoAtingido: true` e `aviso` na
      // saída — o host mostra o aviso ao usuário. Sem a opção (shadows, agentes LLM), o erro
      // sobe como antes: esses consumidores o contam como falha (disjuntor, `failed`).
      let tetoAtingido = false;
      try {
        // A fila do genos abre na chamada de start (síncrono): a porta do ctx é
        // ligada logo depois, e o que ela guardou entra na primeira iteração.
        const inicio = orchestrator.start({ runId });
        if (typeof ctx.registrarAlvoDeMensagem === 'function') {
          ctx.registrarAlvoDeMensagem((m) => {
            const r = orchestrator.enqueueUserMessage(runId, {
              id: m.id,
              content: m.texto,
              ...(m.modoVoz ? { metadata: { modoVoz: m.modoVoz } } : {}),
            });
            if (r.aceita) textosIntraTurno.set(m.id, m.texto);
            return r;
          });
        }
        // Prazo de tempo da mensagem (o pipeline marca `ctx.prazoDaEtapaEm`): alguns minutos antes de vencer,
        // um aviso do sistema entra pela fila intra-turno para o modelo fechar explicando o que falta, em vez
        // de o prazo abortar o turno no meio (teste do editor de vídeo, 28/10: 10 min, erro sem explicação).
        if (typeof ctx.prazoDaEtapaEm === 'number') {
          const espera = Math.max(0, ctx.prazoDaEtapaEm - AVISO_DE_PRAZO_ANTES_MS - Date.now());
          timerDoPrazo = setTimeout(() => {
            avisoDePrazoEm = new Date().toISOString();
            orchestrator.enqueueUserMessage(runId, { id: ID_AVISO_DE_PRAZO, content: AVISO_PERTO_DO_PRAZO, metadata: { sistema: true } });
          }, espera);
          timerDoPrazo.unref?.();
        }
        resultado = await inicio;
      } catch (erro) {
        // O genos anexa ao erro as mensagens aceitas e não entregues.
        sobrasDoErro = Array.isArray(erro?.undeliveredUserMessages) ? erro.undeliveredUserMessages : [];
        if (!config.aterrissarNoTeto || !/Max iterations exceeded/i.test(erro?.message || '')) throw erro;
        tetoAtingido = true;
        resultado = { type: 'completed', value: '', runId, undeliveredUserMessages: sobrasDoErro };
      }
      // Correção 1 (Fase 4, paridade): `resultado.value` é o texto CRU do
      // protocolo (em `envelope`, o `{"blocos":[...]}` inteiro) — não o que o
      // modelo escreveu para o leitor. `extrairTexto` é quem sabe desembrulhar
      // (identidade em fence/nativo, junção dos `chat` em envelope).
      const texto = resultado.type === 'completed'
        ? estrategia.extrairTexto(String(resultado.value ?? ''))
        : '';

      // Histórico `sem-retorno-de-tool`: o texto CRU do usuário (não a mensagem
      // montada — os efêmeros valiam só para aquele turno) e a resposta com o
      // bloco de operações costurado. Sem esse bloco o modelo não sabe o que já
      // rodou e repete a chamada.
      const blocoDeOperacoes = construtor.blocoDeOperacoes(operacoes);
      const historico = [
        ...(entrada.historico || []),
        { id: `u${estadoAnterior.turno}`, role: 'user', content: entrada.texto },
        ...entreguesNoTurno
          .filter((id) => textosIntraTurno.has(id))
          .map((id, i) => ({ id: `u${estadoAnterior.turno}.${i + 1}`, role: 'user', content: textosIntraTurno.get(id) })),
        {
          id: `a${estadoAnterior.turno}`,
          role: 'assistant',
          // No teto, o aviso entra no histórico: é o que o usuário vê, e o "sim, continua" do
          // turno seguinte só faz sentido se o modelo souber que perguntamos.
          content: [construtor.removerOperacoes(texto), blocoDeOperacoes, tetoAtingido ? AVISO_TETO_DE_ITERACOES : ''].filter(Boolean).join('\n\n'),
        },
      ];

      // Fecha o ciclo de sessão do kairos: `applySessionPolicy` dobra o
      // `discoverResult` deste turno no estado (populando `recentUse`,
      // revalidando que providers/tools continuam conscientes). Sem isto, o
      // `estado.kairos` devolvido seria o do turno ANTERIOR — o seguinte faria
      // discover como se fosse o primeiro, e o ranking por recência nunca
      // aprende.
      //
      // 🚨 DEPOIS do laço, e não antes: é o que permite incluir o que o
      // `load_capability` trouxe NO MEIO do turno. Calculado antes, ele só
      // enxergaria a decisão do discover inicial — e a capacidade carregada
      // durante o turno não voltava hidratada no turno seguinte (medido).
      // R6 (kairos 0.833): `skillsActivation: 'host'` — a política NÃO trata
      // `discoverResult.skills.activate` promovido pelo refinador do anel `skill` como
      // "carregada pelo kairos" em `loadedSkills`; é o HOST (via `aoSemear`/`hab_carregar`) quem
      // decide quando semear/descartar a skill, o mesmo canal que já existia antes do refino.
      // O discover do turno + o que o modelo carregou por `load_capability` no meio dele. Calculado UMA vez: o
      // `applySessionPolicy` abaixo e a cauda (quem o modelo promoveu) leem o mesmo resultado.
      // Uso do turno (spec §4.2), calculado ANTES de fechar o Kairos: o que o modelo usou da cauda HERDADA não veio do
      // discover deste turno e precisa entrar no estado por outro caminho.
      let usadas = [];
      let usadasRefs = new Set();
      let usadasCaps = new Set();
      let providersDoModelo = new Set();
      if (despejoLigado) {
        // Nome exposto (o que o modelo chama) -> ref interna, para as funções que o turno viu: no system, na cauda
        // e no discover. A ref interna também resolve (`call_capability` abre a operação sob a ref).
        const nomeParaRef = new Map();
        for (const ref of [
          ...acumulacao.system.capacidades.flatMap((c) => c.funcoes.map((f) => f.ref)),
          ...caudaDoTurno.flatMap((c) => c.funcoes.map((f) => f.ref)),
          ...(prepared.discoverResult.tools.conscious ?? []).map((x) => (typeof x === 'string' ? x : x.ref)),
        ]) {
          const [p, , key] = ref.split('/');
          if (key) { nomeParaRef.set(nomeDaFuncao(p, key), ref); nomeParaRef.set(ref, ref); }
        }
        // Sinônimo cru (`aliasCru`): o modelo pode chamar `enviar` em vez de `whatsapp__enviar`; é a mesma função.
        for (const [cru, nome] of sinonimosDoCatalogo.porCru) {
          if (nomeParaRef.has(nome)) nomeParaRef.set(cru, nomeParaRef.get(nome));
        }
        // Pedido do modelo conta como uso (spec §4.2): o que ele carregou por `load_capability` neste turno, mesmo
        // que a função já viesse na seleção (por isso a resolução parte de um discover VAZIO, não do `fechadoPeloModelo`).
        const pedidoPeloModelo = comCarregadasNoTurno({ providers: { load: [] }, tools: { hydrate: [], conscious: [] } }, carregadasNoTurno, manager);
        providersDoModelo = new Set(pedidoPeloModelo.providers?.load ?? []);
        const carregadasPeloModelo = (pedidoPeloModelo.tools?.hydrate ?? []).map((ref) => ({ ref, capId: ref.split('/')[0] }));
        ({ usadas, usadasRefs, usadasCaps } = usadasDoTurno({ operacoes, recusadas: recusadasNoTurno, nomeParaRef, carregadasPeloModelo }));
      }
      const fechadoPeloModelo = comCarregadasNoTurno(prepared.discoverResult, carregadasNoTurno, manager);
      const kairosFechado = applySessionPolicy(
        estadoAnterior.kairos,
        fechadoPeloModelo,
        estadoAnterior.turno,
        loadingPorProvider(manager),
        { skillsActivation: 'host' },
      );

      // Cauda efêmera / despejo (spec 2026-10-29 §4.2, §4.4, §4.5). Desligados: `kairosFinal === kairosFechado`,
      // o estado de despejo segue como veio e a saída leva `despejo: null` — o turno é o de antes.
      let kairosFinal = kairosFechado;
      let estadoDoDespejoNovo = estadoAnterior.despejo;
      let saidaDoDespejo = null;
      if (despejoLigado) {
        // Fecho (costura.js): alinha o Kairos ao system, promove o uso (com o "sobe junto"), registra e guarda a cauda herdável.
        const despejadas = diagDespejo?.conta.disparou ? diagDespejo.marcados : { capacidades: [], funcoes: [] };
        const fecho = fecharTurnoDoDespejo({
          kairos: kairosFechado,
          estadoDoDespejo: estadoDoDespejoTurno,
          system: acumulacao.system,
          systemEnviado: payload.system,
          cauda: separado.cauda,
          caudaDoTurno,
          cortadasPorSinal: separado.cortadasPorSinal,
          despejadas,
          usadas,
          providersDoModelo,
          capacidades: config.capacidades,
          caudaLigada: despejoCfg.cauda,
          m: despejoCfg.m,
          turno: estadoAnterior.turno,
        });
        kairosFinal = fecho.kairos;
        estadoDoDespejoNovo = fecho.estadoDoDespejo;
        saidaDoDespejo = {
          cauda: separado.cauda.map((c) => c.id),
          caudaFuncoes: separado.cauda.flatMap((c) => c.funcoes.filter((f) => f.manual).map((f) => f.ref)),
          promovidas: [...usadasRefs],
          sobeJunto: fecho.sobeJunto,
          cortadasPorSinal: separado.cortadasPorSinal,
          recusadas: [...recusadasNoTurno],
          herdadas: herdadasDoTurno,
          continuacaoCurta,
          descartaveis: diagDespejo?.marcados ?? null,
          conta: diagDespejo?.conta ?? null,
          descartadas: Object.keys(estadoDoDespejoTurno.descartadas),
          aviso: Boolean(textoDoAviso),
          // Conferência da conta: o system que a conta mediu é o que o `montar` enviou (mesmo render, mesmo contexto).
          systemConfere: construtor.renderizarSystem(contextoDoPrompt, acumulacao.system) === payload.system,
        };
      }
      // Aceite de contribuição: o que ESTE turno ofereceu de novo fica no estado para a herança curta do próximo (só as
      // frescas — a herdada não se herda outra vez). Fora de `comportamentoNoTurno` o estado segue como veio, sem a chave.
      // `comportamentoFalhasNoFecho` (declarada e não fixada no fecho) vale um turno: este já a consumiu (reofertou). Sai do
      // estado; o host a repõe, depois do fecho deste turno, só se o semeio falhar de novo.
      if (comportamentoNoTurno) {
        const { comportamentoFalhasNoFecho: _consumida, ...base } = estadoDoDespejoNovo ?? estadoDespejoVazio();
        estadoDoDespejoNovo = {
          ...base,
          // Herança curta é só de habilidade (Fase 3: memória não herda — a seleção a traz de novo se o assunto continuar).
          comportamentoAnterior: oferecidasDoTurno.filter((o) => o.tipo === 'habilidade' && !o.herdada).map(({ id, ref }) => ({ id, ref })),
        };
      } else if (estadoDoDespejoNovo && ('comportamentoAnterior' in estadoDoDespejoNovo || 'comportamentoFalhasNoFecho' in estadoDoDespejoNovo)) {
        const { comportamentoAnterior: _descartado, comportamentoFalhasNoFecho: _descartadas, ...resto } = estadoDoDespejoNovo;
        estadoDoDespejoNovo = resto;
      }

      return {
        resultado,
        texto,
        // A-I6: `true` quando o laço estourou `maxIteracoes` e o turno foi concluído por
        // aterrissagem suave (`aviso` = o texto a mostrar). Sem `aviso` quando não estourou.
        tetoAtingido,
        ...(tetoAtingido ? { aviso: AVISO_TETO_DE_ITERACOES } : {}),
        payload,
        operacoes,
        // Um piso que falha ao renderizar não pode calar o agente: o bloco não
        // entra, o turno segue, e o erro sai por aqui para quem quiser registrar.
        renderErrors,
        // Diagnóstico do turno, somente-leitura: `unchanged`, `degraded`,
        // `providers.{load,candidates}`, `tools.{hydrate,conscious}`,
        // `contributions[]` e `explain[]` (com `scores`/`tier`/`reason` — e, desde a Task 9
        // (kairos 0.833, refino por anel), `proposedTier`/`refiner` quando o anel teve
        // refinador registrado em `config.refinadores`).
        // Aditivo e sem efeito no comportamento — existe porque sem ele não há
        // como um consumidor MOSTRAR por que uma tool ficou no índice sem
        // contrato, que foi o defeito medido no pipeline V2 do Ariadne. Mesma
        // direção do ARCHITECTURE.md §7: quem cria e grava observabilidade é o
        // consumidor; a fábrica só entrega o que já tem na mão.
        discover: prepared.discoverResult,
        // `embeds` — mesmo valor entregue a `config.aoMontar` (ver acima): quantos embeds de
        // consulta a fábrica fez neste turno, tempo gasto e origem.
        embeds,
        // B3.3 fase 2 — mesmo valor entregue a `config.aoMontar` (ver lá): diagnóstico da
        // pista de contexto, sem texto histórico.
        pistaDeContexto,
        // Spec 2026-10-14 §7.1: mesmo valor entregue a `config.aoMontar` (ver lá).
        trivial: {
          valor: trivialDoTurno,
          motivo: typeof entrada.trivial === 'boolean' ? (entrada.motivoTrivial ?? 'host') : 'regra-kairos',
          enviadoAoKairos: typeof entrada.trivial === 'boolean',
        },
        // I3 (revisão final do conjunto; `refiner.applied`/`refiner.fallback` desde a Task 9) —
        // mesmo valor entregue a `config.aoMontar` (ver comentário de `pararKairos` acima):
        // eventos `degraded`/`budget.cut`/`refiner.*` do manager do kairos neste turno.
        eventosDoKairos,
        // Task 6 (spec 2 §3.4): telemetria por fonte deste turno — `{ id, ms, degradado,
        // incluidos, candidatos, carregar, semear, enriqueceu }`, na ordem de
        // `config.capacidades` que declararam `fonte.selecionar`. `turno.js` grava em
        // `fabrica.json.fontes` (fora desta task); mesmo valor entregue a `config.aoMontar`.
        fontes,
        // I3a (revisão final do conjunto): ids de capacidade promovidos neste turno, por ORIGEM
        // — mesmo valor entregue a `config.aoMontar` (ver comentário lá).
        promocoes: { fontes: [...promocoesFontes], skills: [...promocoesSkills], semVoto: [...promocoesSemVoto], skillsAbaixoDoCorte: [...promocoesSkillsAbaixoDoCorte] },
        // Task 10 (R6): refs de skill ativadas pelo refinador do anel `skill` neste turno —
        // mesmo valor entregue a `config.aoMontar` (ver comentário lá).
        skillsAtivadas,
        // Dedup: refs ativadas que já estavam na memória de trabalho (sem bloco `#ativada`).
        skillsJaSemeadas,
        // Refs ativadas cujo bloco `#ativada` entrou de fato no turn_context (semeio ok, corpo novo).
        skillsComCorpo,
        // Aceite de contribuição (spec 2026-10-29 aceite): `{ oferecidas }` só com `comportamento` ligado (o host lê no
        // fecho do turno, junto do `_contribuicoes_usadas`). Desligado a saída não ganha a chave.
        ...(comportamentoDoTurno ? { comportamento: comportamentoDoTurno } : {}),
        // Task 11 (R11/§3.4): `{ msTotal, degradado, porAnel: { <ring>: { enviados, respondidos,
        // ms, degradado, mudancas } } }` — mesmo valor entregue a `config.aoMontar` (ver
        // comentário lá, e o bloco `const refino = (() => {...})()` mais acima, onde é
        // calculado). `null` quando nenhum anel teve refinador registrado neste turno.
        refino,
        // Mudança 2 (2026-09-23): mesmo valor entregue a `config.aoMontar` (ver comentário lá) —
        // este ponto do retorno já roda DEPOIS do laço agêntico do genos (o modelo já foi
        // chamado), então `tempos` aqui é só passthrough do que foi medido ANTES da montagem do
        // payload, não um dado novo deste ponto.
        tempos,
        // Spec do porte (§5.4): `{ valores, origem, resumo }` dos limiares que este turno usou —
        // `origem` é `'padrao'` (config.limiares tal como veio, sem calibração ativa ou sem
        // exemplo suficiente), `'calculado'` (saída de `calibrarLimiares`) ou `'override'`
        // (`config.calibracao.override` sobrescreveu o resultado). Mesmo valor entregue a
        // `config.aoMontar` (a fábrica só passa adiante o que `montarCatalogo()` já calculou).
        // `motivo` (M3, revisão do conjunto): só quando veio do fallback global — ver comentário
        // gêmeo no `aoMontar` acima.
        limiares: { valores: infoLimiares.valores, origem: infoLimiares.origem, resumo: infoLimiares.resumo, ...(infoLimiares.motivo ? { motivo: infoLimiares.motivo } : {}) },
        // Loop do Jev (spec 2026-09-22 §6.5): `null` quando não rodou. O rastro sai sem o
        // `resultado` cru (pode ser grande); `resultadoResumido` já vem cortado pelo motor.
        loop: saidaDoLoop
          ? {
            estado: saidaDoLoop.estado,
            ...(saidaDoLoop.motivo ? { motivo: saidaDoLoop.motivo } : {}),
            ms: saidaDoLoop.ms,
            passos: saidaDoLoop.passos,
            carregadas: saidaDoLoop.carregadas,
            corteHistorico: config.loop?.corteHistorico ?? 0.7,
            destinos: entrega?.destinos ?? { historico: 0, bloco: 0, erro: 0 },
            rastro: (saidaDoLoop.rastro ?? []).map(({ resultado, ...resto }) => ({ ...resto, ...(autorizadasDoLoop.has(resto.fn) ? { autorizacaoId: autorizadasDoLoop.get(resto.fn).id } : {}) })),
            // Correção (revisão do conjunto, 7fe31cb7, 24/09): funções que o Jev escolheu mas não
            // pôde preencher (obrigatório sem opção, com opção mas sem resposta válida, grupo obrigatório
            // incompleto, ou valor fora das opções) —
            // hidratadas para o modelo neste turno via `contratosDoLoop` (união com
            // `refsComManualDoLoop`, ver `refsParaOModelo` acima); aqui só para o Tracer mostrar
            // que isto aconteceu. O campo é OMITIDO (não vira `[]`) quando o loop não devolveu
            // nenhuma função nessa situação — leitores tratam ausência como "nenhuma" (o
            // LoopViewer só mostra a linha quando `loop.paraOModelo` tem itens).
            ...(Array.isArray(saidaDoLoop.paraOModelo) && saidaDoLoop.paraOModelo.length
              ? { paraOModelo: saidaDoLoop.paraOModelo }
              : {}),
            // Spec 2026-10-14 §7.1: julgamento do Jev sobre a intenção declarada (`{ vale, confianca, ... }`)
            // e o que ele fez hidratar por causa dela — sem isso o artefato do turno nunca vê o julgamento.
            ...(saidaDoLoop.intencao ? { intencao: saidaDoLoop.intencao } : {}),
            ...(refsIntencaoHidratadas.length ? { intencaoHidratada: refsIntencaoHidratadas } : {}),
          }
          : null,
        historico,
        // `despejo` só entra no estado quando há o que guardar (ligado, ou herdado de uma sessão que o tinha):
        // desligado, o formato do estado é o de antes.
        estado: { system: acumulacao.system, turno: estadoAnterior.turno + 1, kairos: kairosFinal, ...(estadoDoDespejoNovo ? { despejo: estadoDoDespejoNovo } : {}) },
        // Cauda efêmera / despejo (spec 2026-10-29): diagnóstico do turno para o host gravar. `null` desligado.
        despejo: saidaDoDespejo,
        schema: schemaDaResposta,
        // `runId`/`runStore` são do TURNO (descartáveis, um par novo a cada
        // chamada) — servem para o consumidor recuperar o histórico de MENSAGENS
        // do genos via `runStore.load(runId)` (ex.: verificação de efeito de uma
        // tool, behavior de tracing). É outra coisa do `historico` acima, que é
        // do prompt-builder: texto cru do usuário + bloco de operações.
        runId,
        runStore,
      };
    } finally {
      if (timerDoPrazo) clearTimeout(timerDoPrazo);
      // Task 6 (spec 2 §3.1/§3.4 passo 6): `aoFechar` de cada fonte — telemetria/hits,
      // fire-and-forget (sem `await` no caminho da resposta, mesma garantia que o JSDoc de
      // `FonteDeclarada.aoFechar` promete). Recebe a seleção CRUA que a própria fonte devolveu
      // (`selecaoPorCap`, não o `fontes[]` já normalizado) — é o formato que a fonte conhece
      // (ex.: `resultado._selecao` da fachada de memória). Erro aqui é observação do host, nunca
      // deriva o turno — mesma garantia de `aoEvento`/`aoMontar`.
      //
      // Q1 (correção do review de qualidade da Fase 2): SÓ para a fonte cujo `selecionar`
      // respondeu dentro do prazo (`fontes[i].degradado === null`, mesma ordem de `capsComFonte`
      // — ver o `for` que monta `fontes` mais acima). Uma fonte degradada por PRAZO não teve a
      // promise cancelada (`Promise.allSettled` só desiste de ESPERAR, não de rodar) — se
      // `selecionar` da memória terminasse depois, gravaria a seleção no `WeakMap` por `ctx`
      // (`lerSelecao`/`setSelecao`, `packages/memory/src/fonte/index.js`), e o fallback
      // `resultado?._selecao ?? lerSelecao(ctx)` de `aoFechar` pegaria essa seleção TARDIA — o
      // host registraria hits de memórias que nunca entraram no prompt deste turno.
      //
      // Task 8 (2026-09-21, correção): estava dentro do `try`, só no caminho de SUCESSO — se
      // `orchestrator.start` (o laço agêntico do genos) lançasse, este bloco nunca rodava e a
      // fonte perdia a telemetria/hits daquele turno inteiro. `finally` roda tanto no retorno
      // normal quanto na exceção — e exatamente uma vez por `try` (garantia do Node/da spec de
      // `try/finally`), então não precisa de guarda contra dupla execução (a flag `fontesFechadas`
      // que existia aqui era código morto: nenhum caminho deste `finally` podia rodar duas vezes).
      capsComFonte.forEach((cap, indice) => {
        if (fontes[indice]?.degradado !== null) return;
        try {
          cap.fonte.aoFechar?.(ctx, selecaoPorCap.get(cap.id));
        } catch (erro) {
          console.warn(`[fabrica] fonte.aoFechar() de "${cap.id}" falhou: ${erro?.message ?? erro}`);
        }
      });
      // Sempre remove — inclusive quando o turno lança — para não reter
      // `orchestrator`/`runStore` num signal de sessão que sobrevive ao turno.
      entrada.abortSignal?.removeEventListener('abort', aoAbortar);
      // Fecha a porta do ctx e devolve o que o genos aceitou e não entregou.
      if (typeof ctx.removerAlvoDeMensagem === 'function') {
        ctx.removerAlvoDeMensagem(
          (resultado?.undeliveredUserMessages || sobrasDoErro || []).map((m) => ({ id: m.id, texto: m.content })),
        );
      }
    }
  }

  return { executarTurno, fechar: async () => { catalogo = null; } };
}

// Config da cauda e do despejo (spec 2026-10-29): o host normaliza/valida com a mesma função do orquestrador.
export { normalizarDespejo, DESPEJO_PADRAO } from './despejo/config.js';

# ARCHITECTURE — @igris/decisions

> **Copiado de `igris@430d2c9`; o texto ainda descreve o Igris como host de referência.** Links para `docs/`, `packages/executor` e `packages/powers` apontam para o GitHub do Igris no sha de origem; ver [`ORIGEM.md`](../ORIGEM.md).

> Molde: `docs/ok-playbook/templates/ARCHITECTURE.md`. Ver também a spec
> [`2026-09-17-decisoes-jev-hidratacao-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/done/2026-09-17-decisoes-jev-hidratacao-design.md)
> (§15 para o núcleo reutilizável e a hidratação por power) e o plano
> [`2026-09-18-nucleo-e-hidratacao-por-power.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/plans/2026-09-18-nucleo-e-hidratacao-por-power.md)
> para o histórico de decisão. Para quem vai **usar o núcleo numa decisão
> nova** (não mexer na estrutura deste pacote): `docs/project-architecture/decisions.md`.
> Este doc nasce com o pacote — atualize-o no mesmo commit que mudar a
> estrutura interna.

## Propósito

Decide, a cada interação, o que vale a pena fazer antes do primeiro passo da
LLM: qual tool é mais provável em seguida (`sugestao`, para o "Sugestão do
roteador" do prompt — não hidrata sozinha), quais powers candidatos vale a
pena hidratar de fato (`hidratar`, um `noul` por power não ativo — Fase 1,
adendo §15/H1-H2), quais leituras baratas pré-buscar, e dicas de argumento
vindas de valores rotulados da sessão. O provedor é o
**Jev** (`typesafe/jev-1.13`, via OpenRouter `/api/alpha/decisions`) — um
modelo que não gera texto, só responde `choice`/`noul` com confiança
calibrada.

## Ponto de contato

`decidir()` (`src/index.js`) é a **única** função que um consumidor externo
chama para a **aplicação** hidratação. Recebe `{ estado, catalogo,
candidatos?, perguntasDosPowers?, cliente, cortes?, nivel?,
prioridadeDePower?, tetoChars?, powersCandidatos? }` e devolve sempre um
objeto `Decisao` — nunca lança, mesmo quando o provedor falha
(`meta.degradado` carrega o motivo: `'sem-chave'`, `'catalogo-vazio'`,
`'timeout'`, `'erro'`). `powersCandidatos` (`Array<{id, desc?}>`, Fase 1) é
quem faz `decidir()` perguntar `hidratar_<id>` por power — sem ele, a saída
`hidratar` sempre vem vazia (a `sugestao`, top-k de `next_tool`, continua
saindo normalmente). A saída relevante para hidratação: `hidratar`
(`{power, noul}[]`, um item por power candidato acima do corte — o que a
costura hidrata de fato) e `sugestao` (`{tool, power, confidence}[]`, o
antigo campo `hidratar` de antes da Fase 1 — só dica de prompt, não hidrata).
Todo
consumidor (hoje só a costura do executor,
`packages/executor/src/orchestration/decisoes.js`) importa só isso — nada em
`cliente.js`/`catalogo.js`/`estado.js`/`gates.js`/`perguntas.js` deveria ser
importado diretamente fora do próprio pacote, exceto pelos subpaths que o
`package.json` expõe (`@igris/decisions/cliente`, `/catalogo`, `/estado`,
`/gates`, `/perguntas`) para quem precisa montar uma pergunta ou um estado
sob medida (ex.: a bancada em `eval/`).

Uma aplicação de decisão **nova** (não a hidratação) não entra por aqui —
importa `@igris/decisions/nucleo` diretamente. Ver
`docs/project-architecture/decisions.md` para o contrato do núcleo e um
exemplo guiado; este documento cobre só a estrutura interna do pacote e a
hidratação como primeira aplicação real dele.

## `src/nucleo/` — núcleo genérico (N1–N3, spec §15)

Fase 0 (2026-09-18) separou do resto do pacote a parte de "estado + perguntas
→ respostas" que **não conhece tool, power, nem qualquer domínio** — qualquer
aplicação de decisão nova (não só a hidratação) importa daqui, via o subpath
`@igris/decisions/nucleo` (`package.json`: `"./nucleo":
"./src/nucleo/index.js"`):

| Arquivo | Responsabilidade |
|---|---|
| `src/nucleo/perguntar.js` | `perguntar({state, questions, cliente, prazoMs, aoChegarTarde})` — chama `cliente.decidir(...)`, aplica o prazo macio (o turno nunca espera além de `prazoMs`) e a resposta tardia (`aoChegarTarde`, só diagnóstico); nunca lança. `TETO_TARDIO_MS` (piso de `timeoutMs` para quem cria o cliente). Movido de `decidir()`/`index.js` na Fase 0 — mesma semântica, testada por `test/prazo-macio.test.js` (roda contra `decidir()`, sem asserção alterada). |
| `src/nucleo/formas.js` | `choice`/`noul`/`score` — montadores das três formas do Jev com os limites do protocolo validados NA MONTAGEM (`ErroDeForma`, lança — bug de quem chamou, não degradação); `TETO_PERGUNTAS` (60 por chamada HTTP, orçamento compartilhado por quem empacota perguntas na mesma chamada). |
| `src/nucleo/estado.js` | `cortarEstado(obj, {tetoChars, ordemDeCorte, registrarCorte})` — corte genérico de um objeto por tamanho, sem conhecer nenhum campo; quem declara os campos e a ordem de corte é o chamador. |
| `src/nucleo/provedor.js` | `criarProvedorDeCliente({listarContas, consumer, agora?, fetchImpl?, timeoutMs?, aquecerDecisao?, criarProtocoloDoGateway?, xTitle?, modoBancada?, chaveDeBancada?})` (`consumer` obrigatório; `modoBancada`/`chaveDeBancada` substituem as envs `IGRIS_TEST`/`NODE_ENV=test`/`IGRIS_DECISOES_BANCADA`/`IGRIS_DECISOES_CHAVE`, que o host lê e passa — ver "Parâmetros que eram do Igris") — fábrica PURA do cliente compartilhado (N3): cache só de sucesso, retry só após 60s, `aquecer({transporte?})` (GET de transporte opcional — default `true`; `{transporte:false}` evita repetir um GET de boot já feito por fora, ver comentário no arquivo) + decisão mínima via `aquecerDecisao` injetada. Não lê `@igris/providers` nem qualquer coisa fora do pacote — quem injeta é o chamador (hoje, o executor, registrado no `@igris/executor-registry` via `setDecisionsClientProvider`/`getDecisionsClientProvider`). |
| `src/nucleo/index.js` | Reexporta os quatro acima + `criarCliente`/`criarFetchKeepAlive`/`aquecer` (de `../cliente.js`/`../transporte.js` — já eram genéricos antes da Fase 0, não movidos por risco a `test/cliente.test.js`/`test/transporte.test.js`). |

Contrato completo e exemplo guiado ("quais memórias carregar"):
`docs/project-architecture/decisions.md`.

## `src/loop/` — loop de decisão do Jev (pré-hidratação do turno, spec 2026-09-22)

Terceiro consumidor de `src/nucleo/`, ao lado da hidratação (abaixo) e de `src/refinadores/`
(o refino por anel — ver `docs/project-architecture/decisions.md §7.1` para o contrato dele;
não documentado nesta seção porque não há mudança de estrutura interna a registrar aqui além
do que §7.1 já cobre). Subpath `@igris/decisions/loop` (`package.json`: `"./loop":
"./src/loop/index.js"`). Contrato de uso e onde cada peça liga no host:
`docs/project-architecture/decisions.md §7.2`.

| Arquivo | Responsabilidade |
|---|---|
| `src/loop/passo.js` | `perguntasDoPasso({funcoes, candidatas, comArgs, rastro})` monta as perguntas `acao`/`mais`/`arg_<fn>_<param>` de UM passo (`chaveDeArg`, `ACAO_PRONTO`, `ACAO_BLOQUEADO`, `PREFIXO_CARREGAR`); `lerPasso(answers, {comArgs, herdados})` lê a resposta — confiança da ação (`confiancaAcao`) separada da confiança mínima com argumentos (`confianca`), herança por `PISO_CONFIANCA_HERANCA`, `mais`/`confiancaMais`. |
| `src/loop/rodar-loop.js` | `rodarLoop({pergunta, contexto, espaco, cliente, executar, carregar, orcamento, cortes, k, signal, aoPasso, conversa, consultasAnteriores})` — o motor: orçamento de passos/tempo (`ORCAMENTO_PADRAO`), cortes de confiança (`CORTE_ACAO_PADRAO`, `CORTE_FIM_PADRAO`, `K_PADRAO`), travas de reconsulta, `paraOModelo`. Cancelamento cooperativo via `AbortSignal` combinado (turno + prazo do passo); nunca lança — o `catch` final devolve `estourado`. |

Mesma regra de pureza do resto do pacote (ver abaixo): `executar`/`carregar`/`cliente` são
injetados pelo host (`packages/executor/src/orchestration/fabrica/loop.js` monta
`loopDoTurno`, que `@igris/orchestrator` chama via `config.loop.rodar`) — o motor não conhece
tool, power, sessão nem `ctx`.

## Os módulos da aplicação (hidratação)

| Arquivo | Responsabilidade |
|---|---|
| `src/index.js` | `decidir()` orquestra estado → perguntas → `perguntar()` (núcleo) → gates; classifica erro em `meta.degradado`; monta `Decisao`. |
| `src/cliente.js` | `criarCliente({chave, xTitle?, …})` — `POST /api/alpha/decisions` com `fetch` nativo (header `X-Title` = `xTitle`, padrão `'agent-factory'`; o Igris passa `'igris-decisions'`), timeout por `AbortController`, retry só em 429/529, `fetchImpl` injetável para teste. Genérico (não conhece tool/power) — reexportado por `nucleo/index.js`. |
| `src/transporte.js` | `criarFetchKeepAlive()`/`aquecer()` — transporte HTTP com keep-alive, GET de aquecimento de DNS/TLS. Genérico — reexportado por `nucleo/index.js`. |
| `src/catalogo.js` | `montarCriteria()` — monta o `criteria` da pergunta `next_tool` a partir do catálogo de tools do escopo: 3 níveis de descrição (`nome`/`curta`/`completa`), corte no teto de 254 opções por prioridade de power. |
| `src/estado.js` | `montarEstado()` — monta o `state` que o Jev recebe a partir do que o host entrega; clip por bloco e chama `cortarEstado` (núcleo) com a ordem de corte específica da hidratação quando estoura `tetoChars`. |
| `src/candidatos.js` | `aplicarEstrategiasDeCandidatos()` — propõe valores plausíveis (ex.: texto entre aspas do pedido) para parâmetros de texto livre de tools de prefetch, como opções de baixa confiança (`candidatoDinamico`) — adendo §14. |
| `src/gates.js` | `aplicarGates()` — lê o `answers` cru do Jev e aplica as faixas de confiança: `sugestao` (top-k de `next_tool`, era `hidratar` antes da Fase 1), `hidratar` (um `noul` por power candidato, `powersCandidatos`, acima de `CORTES_PADRAO.hidratarPower` — Fase 1), quais prefetch entram, quais dicas de argumento valem, quais respostas de power voltam agrupadas. |
| `src/perguntas.js` | Textos fixos das perguntas (`next_tool`, `pronto`, prefetch, argumento) — **não é código, é calibração**: o texto em si foi medido pela bancada. |

`eval/` não é um módulo de produção — é a bancada de calibração (ver
abaixo), versionada ao lado do código que ela mede.

## `src/local/` e `treino/` — decisor local de seleção e treino contínuo (spec 2026-10-06 e 2026-10-07)

`src/local/` é o decisor local (índice por anel, cabeça bilinear, refinador); `treino/lib/` é o que o treina. Tudo em
`treino/lib/` é função pura ou I/O pequeno com `dir` injetado — o app (executor/api) é quem liga. Subpaths do
`package.json` para o executor/api: `./caso`, `./casos`, `./registro`, `./versoes`, `./lote`, `./trava`, `./worker-treino`, `./extrair`,
`./dominio`, `./item-do-registro` (mais `./treino`, o serviço do treino completo, e `./local`). `args.js`, `conferencia-texto.js` e
`linha-sinal.js` não têm subpath: são das CLIs (`treino/*.mjs`), que os importam por caminho relativo; `conferencia.js` é do serviço
(`servico.js`) e da CLI. As duas CLIs (`treinar.mjs`, `conferencia.mjs`) são **estritas**: ver a tabela de `treino/lib/` abaixo (`args.js`).

### `src/local/` — composição, cortes fixos, índice e cabeça (spec 2026-10-07 de cortes e composição)

Tudo atrás do contrato `RingRefiner` do kairos (nada muda em cards, promoções P1–P7 nem no loop).

- **Composição por anel** (`refinador-local.js`). O estado do anel (`estadoDoAnel`) é `cabeca` quando a versão em uso foi aprovada
  pelo **portão por anel** (e o anel não é `skill`, que nunca usa a cabeça), senão `base`. Na cabeça **todo** item recebe a nota da
  cabeça (probabilidade, escala única, inclusive capacidade sem casos); na base, a nota base (cosseno centrado). Não há mais mistura
  de escalas numa lista, e a ordem do `full` é pela **nota** (o `proposedTier` do motor não dá prioridade). Regras extras: **D5**
  (capacidade com menos de `minCasosCapacidade` casos de treino cuja nota da cabeça não passa entra pela base, depois das da cabeça),
  **D4a** (anel tool: função de capacidade que NÃO estava no turno só vira `full`, e dispara a P1 do kairos, com nota ≥
  `cortes.promocao`; com o provider na cabeça ou desconhecido, nunca; no máximo `tetoProvider` capacidades novas por turno),
  **D4b** (anel provider: função forte do anel tool traz a capacidade descartada como `candidate`; `explain` `local:funcao-trouxe`; capacidade JÁ
  carregada no turno fica fora da conta — não gasta as `n` posições nem uma vaga de `maxCandidates`). No anel provider, as **vagas de `full` vão
  primeiro às capacidades novas**: as já carregadas seguem `full` no tier (carregada nunca cai) e disputam as vagas depois; quem perde a vaga vai
  para `candidates` (o kairos hidrata as carregadas de qualquer jeito). "Carregada" aqui é a **ativa ANTES do turno** (`ativasNoInicio`, capturada
  no 1º refine do provider): o que o 1º refine pôs em `full` e o 2º (promoção do kairos) já vê em `loadedProviders` não é antiga, então a promoção do
  mesmo turno não abre uma 3ª vaga (commit `6445922a4`; é o que o carimbo `cortes-composicao-v2` separa).
  O refinador do tool/provider enxerga o estado do outro anel por `obterEstadoDe` (getter cruzado montado em `selecao.js`).
- **Cortes fixos** (`cortes-fixos.js`): `cabeca {full 0,30, candidate 0,15}`, `base {0,35, 0,25}`, `promocao 0,70`, por **origem**
  (cabeça ou base), não por anel nem por percentil do histórico. Override em `IGRIS_CHAT_FABRICA_SELECAO.cortes`, validado (inválido
  cai no padrão com aviso; o formato antigo `cortes.<anel>` é ignorado). O tracer grava `origem: 'fixo' | 'override'`.
- **`cortesSugeridos` — dois relatórios, nunca usados em produção, que medem coisas diferentes.** (1) O do **índice**
  (`calibrarCortes`): p10/p98 exemplo × exemplo, na **base**; vai ao tracer/retrato. (2) O da **versão da cabeça** (`treino.js`/`lote.js`):
  p10 das notas da **cabeça** nos positivos dos casos de avaliação e p98 nos negativos do domínio; `null` com poucos positivos
  (< 20). Servem para o dono comparar com os fixos, e só.
- **Irmão não rouba** (`cortes.js`, `refs.js`): o "exemplo que rouba" só sai do índice quando o ladrão é de **outra** capacidade
  (`capacidadeDoRef`); roubo entre funções irmãs da mesma capacidade fica (`roubados[].irmao: true`, `resumo.roubadosIrmaos`) — os
  centróides dos nós mudaram por isso, então a cabeça precisa ser retreinada. O retrato grava `regra: 'irmao-nao-rouba'`.
- **Índice vem do Kairos** (`indice-do-refino.js`, spec 2026-10-08 da semântica do Kairos). O decisor **não monta catálogo nem aquece**: o índice de
  cada anel é derivado do `RefineInput` (`input.semantica` + `item.semantica`: textos, exemplos e vetores que o Kairos já embedou;
  `indiceDoRefino`, e `indiceDeFuncoesDoProvider` para as funções que o anel provider traz), com a mesma forma e regras de `montarIndice` e
  memo por versão do Kairos **e pelas refs do input** (dois turnos com o mesmo número de itens e refs diferentes não compartilham índice). **Inferência usa só os
  itens do turno; treino usa o catálogo inteiro:** o orchestrator entrega `manager.semantica()` (Kairos 0.838) depois de cada `reindex`
  (`aoSemanticaDoCatalogo`), o executor chama `registrarCatalogoSemantico` (`fabrica/selecao.js`), que monta `indiceDoCatalogo` (mesma conta de
  `indiceDoRefino`, sobre todos os itens do anel), grava o retrato (`hash = hashDosNos`) — só quando a versão do catálogo muda — e o guarda como o
  índice que `indiceEmUso` devolve ao lote. O turno **não** grava retrato nem alimenta `indiceEmUso`. Sem semântica no input o refinador devolve a proposta do Kairos
  (`local:degradado`, motivo `sem-semantica`; `sem-nos` se o anel veio sem nenhum nó). `montarIndice` segue só para o treino
  (re-montagem a partir do retrato). O cache de vetores em disco é o `selecao-embeddings.json`, escrito pelo cache de semântica do
  orchestrator (`cache-semantica.js`) **e** pelo treino (`servico.js`, `comCacheEmDisco(..., { mesclar: true })`) — ambos **mesclam** com o disco.
- **Calibração mantida** (`indice/<anel>-roubados.json`): a lista de exemplos roubados (+ `resumo`, `cortesSugeridos`) é calculada
  **só pelo treino completo** (`treinarAnel` → `servico.js` grava, atomicamente, quando uma versão nova é adotada; `mantida`/rejeitada
  não a troca). O **runtime nunca recalibra**: só aplica `indice/<anel>-roubados.json` ao índice derivado do Kairos (`aplicarRoubadosMantidos`, por
  `ref` + texto do exemplo, não pelo `i`). Sem arquivo: índice sem remoção, `calibracao.origem: 'ausente'` no trace e aviso "rode o treino".
- **Cabeça v2** (`cabeca.js`): `versao: 2` com `anelAprovado`, `metricasAnel {base, cabeca, n}`, `metricas` e `nTreinoPorCapacidade`
  (informativas por capacidade) e `cortesSugeridos`; **não há** `aprovadas` nem `cortes` (`serializarCabeca` lança se receber).
  `carregarCabeca` lê v1 (legado: `anelAprovado` = havia alguma aprovada, `metricasAnel` `null`, `cortes` → `cortesSugeridos`) e v2.
  **Cabeça v1 só vale no anel `provider`**: nos anéis `tool`/`skill` os centróides mudaram com "irmão não rouba" e a v1 foi
  treinada nos antigos, então é ignorada (anel na base) até o retreino v2; no provider o nó é a capacidade e a regra não muda nada.
- **Ponteiro de cabeça quebrado não cai em silêncio no legado** (`versoes.js` `estadoDoPonteiro` + `selecao.js`). Sem `atual.json` (estado de antes
  das versões) o legado `cabecas/<anel>.json` vale e nada avisa. Com `atual.json` que **existe** e não vale (ilegível, ou aponta para versão que
  não está em disco), a cabeça treinada NÃO está valendo: `selecao.js` avisa uma vez por anel e motivo (`atual.json <motivo> — usando a cabeça
  legada cabecas/<anel>.json`, ou `… e sem cabeça legada — usando a base`; `invalidarSelecaoLocal` reabre o aviso, porque a cabeça pode ter mudado)
  e, quando o legado foi o que valeu, o trace do anel leva `cabeca.legado: true`.
- **Avisos da config da seleção** (`IGRIS_CHAT_FABRICA_SELECAO`; um por motivo e por processo): chave de topo desconhecida (`seleção: opção
  desconhecida <k> — ignorada`); `modos` que não é objeto (**um** aviso — antes virava um por caractere); chave desconhecida dentro de `cortes`
  (ex.: `cabeça` com cedilha; `normalizarCortesFixos` devolve `cortes.<k>: chave desconhecida — ignorada`; as chaves `provider`/`tool`/`skill` do
  formato antigo seguem com o motivo próprio). Sem isto o override sumia em silêncio e o dono achava que o corte tinha mudado.

**Portão por anel** (`treino/lib/dominio.js` → `avaliarPortaoAnel`, o mesmo no treino completo e no lote; spec 2026-10-07 §5). A cabeça é
aprovada se o R@3 dela sobre **todas** as capacidades do anel, nos casos de **avaliação**, é ≥ o R@3 da base + `margem` (0). A decisão (`acao`):

| Situação | Ação | Efeito |
|---|---|---|
| `aprovada` | grava | versão nova, anel na cabeça |
| `nao-ganhou` (cabeça < base + margem) | grava | versão nova **com o anel na base** (ponto de partida do lote) |
| `piorou-frente-a-atual` (`r3Nova < r3Atual − toleranciaVersao`, 0,02) | **mantida** | **rejeição**: não grava, a em uso continua |
| `poucos-recentes` (n < `minAvaliacao`, 30: **sem veredito**) com versão em uso válida | **mantida** | a em uso continua (no **lote** é adiamento: nada consumido) |
| `poucos-recentes` sem versão em uso válida | grava | versão nova com o anel na base |

**Não existe "herdar"**: uma cabeça nova não avaliada nunca recebe a aprovação da anterior. **Versão em uso válida** = a de `atual.json` que
a produção também usa: do mesmo embedder e da mesma dimensão do índice remontado, e **não** uma v1 fora do `provider` (`selecao.js` a ignora
porque "irmão não rouba" mudou os centróides de tool/skill) — senão ela mediria uma cabeça que ninguém usa. A régua frente a ela é o R@3 dela
**recalculado nos mesmos casos** da nova (o número que ela gravou é de outra amostra: com n ≈ 100 o erro-padrão de um R@3 é ≈ 0,05, maior que
a tolerância); no treino completo "mesmos casos" = só os de avaliação (log da janela + registro com `avaliacao: true`), porque o lote treinou a
versão em uso no registro de treino da janela — esse registro conta para o R@3 cabeça × base, não para a régua. O critério de `piorou` é igual
nos dois caminhos, e **no treino completo exige `minAvaliacao` casos COMPARADOS** (não o `n` total): com menos, não há veredito de `piorou` e
segue só o portão contra a base. Uma versão em uso **sem avaliação gravada** (v1: `metricasAnel` nulo) que, nos mesmos casos, **perde da
base** não serve de régua (`diagnostico.emUso.descartada: 'perde-da-base'`): a nova é julgada só contra a base — preservá-la só para "não
piorar" seria manter uma cabeça pior que não ter cabeça (a mesma regra vale no **lote**, com `nAv ≥ minAvaliacao`). **Mantida** no treino completo: `treinarAnel` devolve `{ok:true, mantida:true, motivo, resumo}` sem `arquivo`/`reposicao`;
o serviço não grava nem invalida, registra histórico `{completo:true, rejeitada, mantida:true, anelAprovado (o da em uso), portao,
metricasAnel (da candidata), diagnostico, ate, ids}` e consome cursor e contador; a rota devolve `aneis[anel] = {ok:true, mantida:true,
versao: <atual>, …}`. No **lote**, `piorou-frente-a-atual` é rejeição legítima (`rejeicao: true, mantida: true`): nada é gravado e os casos são consumidos; já
`sem-recentes`/`poucos-recentes` DEPOIS dos filtros finos é **adiamento** (`adiada: true`, decidido antes de treinar): nada é gravado e nada é consumido. Config em `IGRIS_CHAT_FABRICA_TREINO.portao` (`{margem, minAvaliacao,
toleranciaVersao}`, `normalizarPortao`: sub-opção inválida ou desconhecida cai no padrão, chaves herdadas como `__proto__` não são opções,
aviso uma vez por processo); o lote automático e a rota do treino completo leem a mesma (`configDoTreino().portao`).

**Diagnóstico** (`resumo.diagnostico`, também no topo da entrada de histórico e na linha-sinal): `n` e `minAvaliacao`; o **funil** da avaliação
por origem (`log`, `registro-avaliacao`, `registro-treino`) — `brutos = semDominio + semAlvo + jaAtivos (alvo vazio depois de tirar
ativasNoInicio) + poucosCandidatos + julgados` —; `emUso: {versao, r3Recalculado, r3Gravado (só diagnóstico), r3Nova e r3BaseNosMesmos (nos mesmos casos),
comparou, comparacaoSuficiente, descartada?}`; e o **pareado** por caso `{cabecaVenceu, baseVenceu, empate}` (R@3 do caso, cabeça × base). Sem ele um `poucos-recentes` ou um
`nao-ganhou` não diz se faltou dado, se o filtro comeu os casos ou se a cabeça empatou.

**Alvo da avaliação e `ativasNoInicio`.** O caso do turno guarda `ativasNoInicio` (capacidades já carregadas quando o turno
começou: `state.loadedProviders` da 1ª chamada do anel provider, vindo do trace da seleção; `null` = não capturado, `[]` = nada
ativo). No anel **provider**, a avaliação do portão conta só o que **precisou entrar** (usadas − `ativasNoInicio`); sem o campo
(caso de log, artefato antigo), todas as usadas; caso sem alvo depois do filtro não é julgado. O treino (positivos) não muda. O campo também compõe as **"trazidas" do provider** no caso, gravadas À PARTE
(`trazidas.provider` = full do local ∪ `ativasNoInicio`; `carregadas.provider` continua sendo SÓ o full do local): **decisão lê `trazidas`**
(triagem, `conferir`, conferência), **treino lê `carregadas`** (o negativo fraco "carregado e não usado" não pune o que já estava ativo e o
local não decidiu). A capacidade carregada que perdeu a vaga de `full` para uma nova não conta como "não trouxe" nem vira erro-certo, e a carga
**total** (`cargaAToa`) continua medida como na regra antiga (a carregada conta como trazida, como quando ela era sempre `full`). O que a
seleção de fato muda é a carga **nova** (`cargaAToaNova`, na linha de `caso.js` abaixo): ela desconta as `ativasNoInicio` e, no tool, as funções
fixas e o que o refinador manteve em `full` por regra do motor (`doMotor`, ver "Conferência honesta") — por isso o ajuste de corte do **provider** se
lê nela, não no total. A do **tool** não serve a esse ajuste: o teto de vagas troca a função em vez de tirar carga (ver "Limites conhecidos da carga
nova"). `null` (não
capturado) não une nada nem grava `trazidas.provider` (`trazidasDe` cai em `carregadas`). O piso e a promovida por skill entram/saem das duas
juntas (`treino-continuo.js`). No
anel **tool** o campo não entra: a métrica é dentro do domínio do 2º estágio (`dominioDoCaso`: as funções das capacidades usadas + as **5**
capacidades distratoras de maior nota base, mais perto do que o 2º estágio recebe em produção; era 2; nunca o catálogo inteiro), no treino e na avaliação.

**Conferência honesta: carga à toa NOVA × TOTAL, e "Jev melhor" só com sombra** (revisão de 08/10, D2/D3). Três funções puras em `caso.js`
são a **fonte única**: `conferir()` as chama para gravar no caso e `conferencia.js` as chama para recalcular nos casos já gravados.

- `cargaAToa` (**total**) = o que o turno recebeu (`trazidasDe`) e ninguém usou, menos a carga junto. Inclui o que o local **não decidiu**: o que
  já estava ativo no início (provider), as funções fixas (`pinned`/`hasManual`, que o refinador devolve em `full` sem avaliar), os refs sem nota e o
  que o motor segura em `full` independente da nota (`doMotor`, abaixo). Fica como está (compatível com os casos já gravados), mas não é a que o
  corte muda.
- `cargaAToaNova` = `cargaNovaDe(caso, anel)`: **o que o local pôs em `full` POR NOTA e ninguém usou — no provider é a que o corte muda; no tool é só
  "o que o local trouxe pela nota" (o teto de vagas troca a função: "Limites conhecidos da carga nova").** Fora dela: as
  `ativasNoInicio` (provider), o que o motor segura (`doMotor`), o que não tem nota (fixos, refs fora do índice) e, no tool, a carga junto. Provider:
  `carregadas` (o full do local) com nota − `ativasNoInicio` − `doMotor` − usadas; `null` sem `ativasNoInicio` array. Tool: full do local com nota −
  `doMotor` − usadas − carga junto; `null` em caso sem o carimbo atual (`regra !== REGRA_DO_CASO`: gravado antes da marca, e sem ela a nota não
  separa o que o motor manteve). Nos dois anéis `null` também sem `notas[anel]` (caso anterior às notas, ou anel que o local não decidiu). `null` é
  **n/d**, nunca um número inventado, e fica fora da média.
- **`doMotor` — quem sabe por que o item ficou `full` é o refinador.** `refinador-local.js` marca `explain[ref].doMotor = true` no ref que terminou
  em `full` e cujo `full` **não depende da nota**: o anel não rebaixa abaixo da proposta do kairos e a proposta era `full` — o **tier** fica `full` com
  **qualquer nota**, também a que passa do corte, e com o corte onde estiver (a **vaga** de `full` do tool, teto 4, se disputa pela nota: quem a perde
  vai a `candidates` e fica fora do prompt — e por isso não leva a marca). No **tool**, quem faz o "nunca rebaixa" é a regra dos anéis do próprio refinador
  (`ORDEM[tier] < ORDEM[it.proposedTier] → tier = it.proposedTier`), não o teto de promoção: vale para toda função com `proposedTier: 'full'`
  (capacidades do turno: piso, já ativas, a que o 1º refine promoveu). No **provider**, é a capacidade carregada que "nunca cai" (ativa antes do
  turno, ou promovida pela P1 do kairos no meio dele, que o 2º refine vê em `loadedProviders`) e proposta `full`. As listas `full`/`candidates`
  **não mudam**: a marca é só um campo no `explain`, e o kairos o ignora (copia dali apenas `reason`/`confidence`, como já faz com
  `casou`/`funcao`). `registrarDecisao` a leva para `notas[anel][ref].doMotor` — campo próprio, nunca sufixo do `reason` (que é cortado em 80).
  Quem perdeu a vaga de `full` e foi a `candidates` não leva a marca (não terminou em `full`). Entre refines do mesmo turno (o 2º refine do provider
  vê em `loadedProviders` o que o 1º trouxe; o kairos propõe `full` a função de capacidade que o 1º refine do tool promoveu), o ref que um refine
  anterior já pôs em `full` **pela nota** não é marcado pela proposta `full` do seguinte — ela é consequência da decisão do local, e o corte ainda a
  controla; o que um refine anterior marcou continua marcado. A nota vem do último refine do turno que pontuou o ref.
- **Limites conhecidos da carga nova** (revisão do conjunto de 08/10, re-revisão: C2, M1, M2). O que a marca `doMotor` não captura:
  - **Tool: o teto troca, não tira (C2).** O teto de `full` do tool (4 por padrão; segue `IGRIS_CHAT_FABRICA_REFINO`) costuma estar cheio (12 de 12
    turnos de 1 refine no registro real de 08/10); aí subir o corte TROCA a função que ocupa a vaga — uma proposta `full` do kairos que a nota tinha
    deslocado para `candidates` volta — em vez de tirar carga; no registro real a queda da carga à toa do tool com o corte máximo foi 0 (4 de 4 turnos com
    carga nova, entre os 12 de 1 refine). Com menos propostas `full` do kairos que vagas, ou no item D4a (que só usa a sobra do teto), o corte tira sem
    trocar. O corte é por origem e vale para os dois anéis: subir `cortes.cabeca.full` também mexe no tool. Por isso a linha do tool não leva a seta "é esta que o
    corte muda" e a conferência avisa para não decidir o corte por ela: o corte se decide pela linha do provider e por "precisou entrar". O efeito real de
    um corte no tool exige o **contrafactual na origem** (o refinador rodar de novo a própria alocação com o corte acima de toda nota) — pendência, **ainda
    não medido**.
  - **Borda de 2ª ordem (M1).** Item do provider que o local traz pela nota no 1º refine, ninguém usa, e que também é dono de uma skill sugerida (I3a,
    via independente do corte): no corte padrão ele conta na carga nova (a I3a não o promove — já está carregado — e `doMotorDe` não o marca); com o corte
    alto ele sai da carga nova mas **continua no prompt** (agora a I3a o promove). Nesse caso a carga nova do provider **exagera** o que subir o corte tira.
    Exige 2 refines (majoritário: 15 de 27 turnos reais) e item dono de skill sugerida (no real: 0 de 18 itens da carga nova do provider).
  - **Subcontagem pela P1 (M2).** A função F de capacidade nova entra pela nota no tool e a P1 carrega a capacidade C; no 2º refine as outras funções de C
    que o kairos propõe `full` saem `doMotor`, embora só estejam no prompt por causa de F, que o corte controla — a carga nova do tool subconta (lado
    conservador; a frequência não foi medida). No provider, a própria capacidade C carregada pela P1 sai `doMotor` no 2º refine (o ref `z` de
    `fabrica-selecao.test.js`) — dormente enquanto o provider estiver na cabeça (aí o D4a não promove).
- `jevMelhor` = `jevMelhorDe(caso, anel)`, sobre `jevTrazidasDe` (o `full` do Jev em sombra; no provider, ∪ `ativasNoInicio`, como as `trazidas` do
  local): o Jev teria trazido tudo o que foi usado e o local não? **`null` sem sombra do Jev no anel** (`comSombra: false`) — o turno sai do
  denominador, porque sem sombra o juiz não estava lá (antes valia `false`, e a sombra que sumiu lia-se como "o local empata ou vence"). `false`
  com sombra e sem uso; capacidade promovida por skill é neutra.
- Na conferência: `itemDoCaso` recalcula `cargaAToaNova`, `comSombra` e `jevMelhor` (casos antigos também ganham); `metricas` publica
  `cargaAToaNovaMedia` + `casosCargaNova` (média só dos não-`null`) e divide `jevMelhor` só pelos turnos **com uso e com sombra**, publicando
  `turnosComUsoComSombra` e `turnosComUsoSemSombra`; `porCapacidade` ganha `cargaAToaNova` e o `jevMelhor` dela divide pelos usos com sombra;
  `atualizacoes[].antes/depois` levam `cargaAToaNovaMedia`; `turnosRecentes[]` leva `cargaAToaNova` e `jevMelhor` (`null` = sem sombra).
- **Carimbo `REGRA_DO_CASO = 'cortes-composicao-v2'`.** As vagas de `full` do provider mudaram em `6445922a4` (carregada = ativa **antes** do turno;
  a promoção do mesmo turno não abre 3ª vaga) sem trocar o carimbo, então o v1 cobria casos de antes e de depois dela. v1 e v2 **não são
  comparáveis**: a versão da cabeça cujas janelas antes × depois misturem os dois sai `comparavel: false` (`carimbos-diferentes`). O v2 também traz
  a marca `doMotor` nas notas (o carimbo não foi trocado por ela: o v2 só existe nesta branch, a `fabrica-chat` ainda grava v1); por isso a carga
  nova do **tool** exige o carimbo atual e dá `null` (n/d) em caso v1 ou sem carimbo.

| Arquivo | Responsabilidade |
|---|---|
| `treino/lib/caso.js` (`./caso`) | Caso do turno: `montarCaso` (rótulo = **o que o modelo chamou ou o loop do Jev leu** (`origem:'jev'`, guardado também em `lidasPeloLoop`; `load_capability` segue erro-certo); carregadas vêm da **decisão do local** por anel, a sombra do Jev só alimenta `sombraJev`), `triar` (válido/erro-certo/positivo/negativo), `conferir` (`trouxeUsado`, `cargaAToa` (total), `cargaAToaNova`, `cargaJunto` — função carregada de capacidade usada, neutra, só no anel tool —, `comSombra`, `jevMelhor` (`null` sem sombra do Jev); os dois últimos e a carga nova vêm de `cargaNovaDe`/`jevTrazidasDe`/`jevMelhorDe`, ver "Conferência honesta" acima), flag de avaliação (~1 em 5, determinística). O caso leva `regra` (carimbo `REGRA_DO_CASO`, hoje `cortes-composicao-v2`: a regra de composição/conferência com que foi gravado — troque o valor quando ela mudar de forma visível na conferência), `ativasNoInicio` (ver acima), `piso` (`{ids, fixas}`, o piso DO TURNO, condicional incluído), `lidasPeloLoop`, `promovidasPorSkill` (capacidade que entrou por promoção de skill: conta como carregada, positivo, e fica neutra no relatório) e `usadas.naoResolvidas` (nome cru sem capacidade no catálogo do turno: vira caso incerto). |
| `treino/lib/registro.js` (`./registro`) | `data/decisoes/registro/casos.jsonl` + `estado.json`: contador, **cursor e backoff por anel**, e no estado do anel `adiada` + `avaliacao` (`{n, minimo}` ou `null`: ver "Fluxo" item 4; `marcarAdiadaDoAnel(…, {tentativaEm, avaliacao})` a grava junto do motivo, e qualquer outro motivo, ou `null`, a zera). `zerarContador` aceita `porAnel: {[anel]: {n, ts, ids}}` = consumo **parcial**: o anel com entrada desconta só `n` e vai ao `ts`/`ids` dele; os demais seguem o `consumidos` global. Com `porAnel` (mesmo vazio) o `validosDesdeUltima` global vira o **maior** `validos` entre os anéis e `ultimaAtualizacao` o cursor mais antigo entre os que avançaram; **sem `porAnel` é o contrato antigo** (o global desconta o retrato inteiro — o treino completo do `servico.js` segue assim). Rotação assíncrona (`rotacionarRegistro`), leitura da cauda (`lerCasos`, `lerCasosAsync` sem congelar o app). `gravarCaso` não rotaciona; se só o `estado.json` falhar devolve `estadoFalhou` e a **recontagem a partir do registro** (`reconciliarEstado`, também na abertura) refaz `linhas` e os contadores — sob a trava única e com conferência síncrona do tamanho do arquivo e do estado antes de escrever (nunca restaura cursor antigo). |
| `treino/lib/versoes.js` (`./versoes`) | `cabecas/<anel>/v<n>.json` + ponteiro `atual.json` + `historico.jsonl`; `voltar` move o ponteiro; reposição da base (`base/<anel>-reposicao.json`, vetor cru + rótulo, sem texto). `estadoDoPonteiro(dir, anel)` → `{arquivo, legado, motivo}` diz **por que** o legado `cabecas/<anel>.json` está em uso: `motivo` `null` (ponteiro bom, ou sem `atual.json` — o estado normal de antes das versões), `'ponteiro-ilegivel'` (existe e não dá para usar) ou `'versao-ausente'` (aponta para versão que não está em disco). `caminhoAtual` é só o `arquivo` dele, igual a antes, para os demais chamadores. |
| `treino/lib/lote.js` (`./lote`) | `atualizarPorLote`: parte dos pesos atuais, treina com os casos novos (sem avaliação) + amostra da reposição, **portão por anel** (`avaliarPortaoAnel`) nos casos de **avaliação**, `cortesSugeridos` (relatório). `atual` = `{cabeca, versao?, anelAprovado, metricasAnel, nTreinoPorCapacidade?}` (a em uso é RECALCULADA nos mesmos casos da nova); `nTreinoPorCapacidade` é **acumulado** (o da versão em uso + os positivos novos do lote; a reposição não conta) porque a proteção D5 lê o histórico. `excluir` = só o piso **incondicional** (sai do índice inteiro: `P`, `porCapacidade`); o piso **condicional** é por caso (`caso.piso`) e uma capacidade normal nunca some das métricas por isso. Cada caso vira item por `item-do-registro.js` (mesma função do treino completo). Devolve `adiada: true` (`sem-recentes`, `poucos-recentes`: **adiamento**, decidido ANTES de treinar — nada gravado, os casos **não** são consumidos; traz `resumo.diagnostico.n`, que o treino contínuo guarda em `avaliacao.n`) ou `rejeicao: true` (`piorou-frente-a-atual`, com `mantida: true`; e `sem-casos-de-treino`) quando a em uso continua — **rejeição**: nada gravado, casos consumidos. `nao-ganhou` da base grava com o anel na base. A reposição grava `{v, rotulos, neutras}` e o domínio refeito na volta exclui as neutras. |
| `treino/lib/item-do-registro.js` | `itemDoRegistro` (caso do registro → `{rotulos, dom, peso, neutras}`): rótulo = refs exatas; piso do caso e piso incondicional fora de rótulos, carregadas e domínio; **incerto** (nenhum rótulo resolve — ref que sumiu do índice ou nome cru não resolvido) é pulado; caso misto, com algum rótulo resolvido, segue positivo; positivo sem a **carga junto**; **fraco** = carregado e não usado (capacidade usada no turno não conta), peso 0,5, no máx. metade do lote (`limitarFracos`). Os dois caminhos (lote e treino completo) o usam, para não divergirem de novo. |
| `treino/lib/dominio.js` | Primitivas de anel (`capacidadeDoRef`, `alvosDoCaso`, `dominioDoCaso` — usadas + 5 distratoras —, `recall3`), o **portão por anel** (`avaliarPortaoAnel`), a config dele (`PORTAO_PADRAO`, `normalizarPortao`) e os helpers do diagnóstico (`novoFunil`, `novoPareado`); `treino.js` as reexporta (o lote importa direto daqui, sem ciclo). |
| `treino/lib/extrair.js` (`./extrair`) | Extração dos casos dos logs e `pisoIncondicional()` (ambos exigem `raizPowers`; `RAIZ_POWERS_PADRAO` saiu): **espelho** dos manifestos (`alwaysLoaded` + `tela`; fixas = `fixa === true`) — NÃO é fallback de treino algum (o serviço exige `obterPiso`; o `treinar.mjs` só chama a rota); **também não serve a `casos.mjs`/`sombra.mjs`** (nenhum dos dois o chama): hoje só o teste de contrato do executor o usa. Os hosts (treino contínuo e a rota do app) injetam o piso derivado de `capacidadeDoPower` + `toolEhFixa` (`executor/.../piso-incondicional.js`, que também devolve `powers`: registry vazio = `sem-piso` transitório; registry cheio sem piso = configuração, segue com aviso); um teste de contrato no executor garante que coincidem. `resolverNomeDeOperacao` (em `casos.js`) é o resolvedor único de nomes de operação (`cap/tool/fn`, nome cru, `cap__fn`) para o log e para o registro. |
| `treino/lib/trava.js` (`./trava`) | Trava única por processo: treino completo × atualização por lote. |
| `treino/lib/worker-treino.js` (`./worker-treino`) | `treinarCabeca` num `worker_thread`, com timeout (`tempo-esgotado`). |
| `treino/lib/conferencia.js` + `treino/conferencia.mjs` | Relatório por anel/dia/capacidade e efeito de cada versão (`trouxeUsado` do provider separado em **já ativa** × **precisou entrar** (usadas − `ativasNoInicio`) no total, por dia, por capacidade e em `antes`/`depois` de cada versão — `n/d` = `null` sem `ativasNoInicio` array; a "já ativa" é 100% por definição (as trazidas incluem as ativas) e não mede a seleção; `atualizacoes[]` leva `comparavel` (as janelas antes × depois foram gravadas pelo MESMO carimbo `regra`; senão o `efeito` mistura a mudança de regra com a da versão), `motivoIncomparavel` (`sem-carimbo`, `carimbos-diferentes`, `janela-vazia`) e `carimbos` (casos por carimbo em cada janela), além de `anelAprovado` e `metricasAnel`, lidos do topo da entrada; `adiamento` por anel = `{adiada, validos, tentativaEm, aguardaValidos, falhas, avaliacao}` lido do `estado.json` (o adiamento por falta de casos de avaliação não escreve histórico; `aguardaValidos` = quantos válidos faltam para a próxima **tentativa**, não para o lote rodar; `avaliacao` = `{n, minimo}` do estado do anel, `null` quando o estado não a guardou ou está fora do formato); a carga à toa **nova** × **total** e o "Jev melhor" só com sombra (`cargaAToaNovaMedia`, `casosCargaNova`, `turnosComUsoComSombra`/`turnosComUsoSemSombra`: ver "Conferência honesta" acima); entrada antiga, do portão por capacidade, vem `null`; `rejeitadas[]` = `{quando, motivo, mantida, resumo}` das rejeições do portão, do lote e do treino completo, que não geram versão); `GET /api/decisoes/conferencia` (janela padrão de 30 dias). |
| `treino/lib/conferencia-texto.js` | `formatarConferencia`: o resumo em texto que o `conferencia.mjs` imprime antes do JSON — as colunas já ativa × precisou entrar por capacidade e no total, e COMPARÁVEL / NÃO COMPARÁVEL por versão. A carga à toa sai em **duas linhas**: no provider `carga à toa nova … (n casos[ — k turnos n/d])  ← o local pôs em full pela nota e não usou (fora as ativas no início e a carregada que nunca cai): é esta que o corte muda`; no tool a linha se chama `trazida pela nota e não usada` (fora o que o kairos propôs full e as fixas), **sem a seta**, e ganha o aviso `⚠ no tool o teto de vagas faz o corte trocar a função, não tirar carga — não decida o corte por esta linha` (ver "Limites conhecidos da carga nova") e, quando há caso antigo, a linha `n/d no tool: caso gravado antes da marca do motor`; e `carga à toa total … (inclui o que já estava ativo e as funções fixas[, e o que o motor manteve em full no tool])`; a linha `Jev melhor … (k turnos com sombra; m sem)` ganha, com `m > 0`, `⚠ sem sombra do Jev em m turnos com uso — o juiz não estava lá`. O lote adiado por falta de casos de avaliação diz `próxima tentativa com X válidos` (não "faltam N"; com a tentativa já liberada, `, já pode`) e `casos de avaliação n de minimo — o lote só roda com o mínimo`; o `sem-base` e o `sem-piso` NÃO têm tentativa por válidos (esperam o treino completo / o registry de powers) e saem sem "próxima tentativa" nem "já pode". |
| `treino/lib/args.js` | `lerArgs(argv, {permitidas, uso})` e `usoDoCabecalho(import.meta.url)`: o leitor de argumentos **estrito** das duas CLIs (`treinar.mjs`: `url, anel, min-avaliacao, margem, dias, data`; `conferencia.mjs`: `data, desde, anel`). Existe porque o parser antigo ignorava o que não conhecia — `treinar.mjs --help` ou `--anel=tool` chegava ao `fetch` e disparava um treino completo real dos dois anéis no data do dono (D7). Agora `--help`/`-h` (em qualquer posição) mostra o uso — o cabeçalho de comentários do próprio `.mjs` — e sai 0 **sem chamar a rota**; flag desconhecida, repetida, sem valor, argumento solto e `--anel` fora de `provider` ou `tool` viram `FALTA:` (exit 1) **antes** de qualquer chamada. Aceita `--k valor` e `--k=valor`. **`node treinar.mjs` sem argumento continua treinando de verdade os dois anéis (é o uso normal).** |
| `treino/lib/linha-sinal.js` | `linhaSinalDoAnel`: a linha-sinal do `treinar.mjs`, uma linha por anel — `cabeça aprovada (R@3 0,56 × base 0,42, n=106; venceu 30, perdeu 8, empate 68)`, `cabeça reprovada — não ganhou da base (n=64: …)`, `cabeça reprovada — poucos-recentes (n=12/30, sem veredito; …)`, `versão v3 mantida — nova 0,52 × atual 0,60 nos mesmos 48 casos (piorou)` (sem imports: o script é um cliente HTTP puro). |

**Fluxo do treino contínuo** (a ligação mora em `packages/executor/src/orchestration/fabrica/treino-continuo.js`, uma
instância por processo e `dataDir`):

1. Fim do turno: o caso é montado (`montarCasoDoTurno`) **antes** do artefato — a conferência vai ao `fabrica.json` — e
   gravado **depois**, sem `await`. Capacidade de **piso** sai de usadas e carregadas.
2. O registro conta os válidos **por anel**. Com `lote` válidos, fora do backoff, com índice em memória e com base (cabeça +
   reposição do treino completo), agenda uma rodada sob a trava única.
3. A rodada lê os casos novos uma vez (cursor do `estado.json`, ou o último `ate`/`ids` do histórico, ou os `tamanhoRecentes`
   mais novos) e cada anel treina no worker os pendentes **do mais antigo**, no máximo `LOTES_POR_RODADA` (4) lotes por rodada. Se o backlog
   do anel passou disso, o consumo é **parcial**: o cursor do anel vai só até o último caso incluído (`n`, `ts` e `ids` — os casos de mesmo `ts`
   que ficaram de fora voltam), o contador desconta só os incluídos (`zerarContador(…, {porAnel})`) e o resto continua contado e reagenda a
   rodada: um backlog de 600 casos drena em rodadas seguidas, e dentro da janela lida nenhum caso é consumido sem passar por um lote. Ressalva
   conhecida: a leitura é limitada a `tamanhoRecentes` (1000) casos, então um backlog **maior que isso** ainda perde os mais antigos que ficaram
   fora da janela (o cursor parcial passa por cima deles; comportamento anterior, não resolvido aqui). **O relógio do treino é a hora real** (`agoraReal`, de `@igris/config/relogio`), não o `Date`
   global: em modo bancada ele é simulado, e um `ts` no futuro faria o cursor pular os casos reais seguintes. O mesmo vale para o treino completo
   (`servico.js` recebe `agora`, padrão `() => new Date()`; a rota passa `agoraReal`): o `quando` do histórico, o `agora` do extrator (o
   `ehFuturo` dele) e o carimbo do contador/cursor.
4. Resultado por anel: **sucesso** grava versão, reposição e histórico (`anelAprovado`, `portao`, `metricasAnel`, `diagnostico`) e avança
   cursor/contador — a versão gravada pode ter o anel **na base** (`nao-ganhou`, ou `poucos-recentes` quando não há versão em uso válida):
   não é rejeição, o refinador volta à base; **rejeição legítima** do portão (`piorou-frente-a-atual`) é `mantida`: avança cursor/contador sem versão e o histórico leva `rejeitada` + `mantida: true` (aparece em
   `rejeitadas[]` da conferência); com menos de `portao.minAvaliacao` casos de avaliação NO REGISTRO (contagem bruta) o lote nem roda: o anel
   fica `adiada: poucos-recentes-avaliacao` (como `sem-base`: não consome casos, sem histórico, não conta falha; o estado mostra o motivo) e
   `tentativaEm` = válidos agora + `ceil(lote/5)`, para não reagendar uma rodada a cada turno; o mesmo vale para `poucos-recentes`/`sem-recentes` que o
   lote decide DEPOIS dos filtros finos (já ativos, sem domínio, poucos candidatos). **Adiamento não é rejeição**: nada é gravado nem consumido, e o
   estado do anel guarda `avaliacao: { n, minimo }` (limpa junto com `adiada` quando o lote roda) para a conferência dizer quantos casos de
   avaliação há. O **`n` tem duas origens**: no adiamento bruto é a contagem de casos de avaliação do registro (`nAvaliacaoNoRegistro`); no
   adiamento depois dos filtros do lote é o nº de casos **julgáveis** (`resumo.diagnostico.n`; `null` se o lote não informou) — por isso pode
   **cair** quando o anel passa do portão bruto (os filtros comem casos). **Erro de verdade** (worker, gravação, divergência, `tempo-esgotado`) mantém os casos e entra em
   backoff exponencial persistido. Anel **sem base** (cabeça legada, ou v1 nos anéis tool/skill, sem treino completo) só fica marcado no `estado.json` (`adiada: sem-base`): sem rodada, sem histórico, sem backoff.
5. O lote deixa rastro no console (`[fabrica] treino: …`): ao gravar, `<anel>: lote gravou vN — cabeça aprovada | anel na BASE (a cabeça não ganhou
   da base) (R@3 cabeça … × base …, n=…)`; ao rejeitar, `<anel>: lote rejeitado (<motivo>) — versão em uso mantida`; o adiamento por avaliação avisa uma
   vez por anel e processo. Todo aviso da **config** do treino (`IGRIS_CHAT_FABRICA_TREINO` inválido, opção desconhecida, `portao.*`) sai **uma vez
   por processo** (`AVISOS_DA_CONFIG`, pelo texto impresso), porque `treinoContinuoDoProcesso(dataDir, configDoTreino())` avalia a config a cada turno.
6. Só o anel que gravou versão invalida o cache da seleção; `voltar(anel)` (treino contínuo) também invalida.

O treino completo (`treino/lib/servico.js`) usa logs + registro (o caso do **registro vence** o do log na mesma interação; o log entra só para as ausentes do registro), lê a versão em uso válida (`emUso`: pesos + `anelAprovado` + `metricasAnel`; `null` se é de outro embedder/dimensão ou v1 fora do provider), devolve por anel `anelAprovado`, `portao`, `metricasAnel` e `diagnostico` (a linha-sinal do `treinar.mjs`) — ou `mantida: true` sem gravar nada —, grava versão e reposição, zera só os anéis que treinaram (ou que o portão manteve) e
re-embeda caso de outro embedder **com texto** (sem texto, descarta). O **piso** tem duas fontes e nenhum arquivo: o do **turno** vai no caso (`caso.piso`) e exclui só aquele caso; o **incondicional** (`alwaysLoaded`) é injetado pelo host (`pisoIncondicionalFn` no treino contínuo, `obterPiso` no serviço) e exclui do índice inteiro. No anel **provider** a capacidade de piso sai de rótulos, domínio e conferência; no anel **tool** saem só as funções **fixas** dela — as demais passam pela seleção, mas o kairos já as propõe `full` (capacidade do turno) e o refinador local não rebaixa o tool: ficam em `full` por regra do motor, e a conferência as tira da carga à toa nova pela marca `doMotor` (ver "Conferência honesta"). O caminho do **log** não tem `carregadas` nem o piso condicional (sem negativo fraco nem carga junto): isso vai em `resumo.limitacoes` do treino completo. O relatório de conferência mostra `cargaJunto`, os turnos com leitura do loop e o acerto separado entre o que o loop leu e o que só o modelo chamou (detecta o local se reforçando).

**A rota nunca derruba a API** (`packages/api/src/routes/decisoes.js`). O `server.js` monta o router dentro de `start()`, sem `.catch`, então
`criarServicoDeTreinoReal` **nunca lança**: erro na montagem (`criarServicoDeTreino` ou `configDoTreino` lançarem) é logado uma vez e vira
`servicoIndisponivel(err)`, cujo `treinar`/`conferencia` lançam `FALTA: serviço de treino indisponível (<motivo>)` com `status` 503 — o resto da
API sobe e as duas rotas respondem 503 (`unavailable`). **O 503 não cobre o `@igris/executor` não carregar:** o `server.js` o importa
**estaticamente** (o `import('@igris/executor')` da rota só reaproveita o módulo já carregado), então, se ele falhar, a API cai antes do `start()`.
O erro leva `name: 'ErroDeTreino'` em vez de usar a classe porque o motivo pode ser,
justamente, a classe não carregar; `responderErro` o identifica pelo nome. A rota passa `agora: agoraReal` ao serviço.

## Parâmetros que eram do Igris (0.1.0)

Antes da extração estes valores estavam gravados no pacote (ou lidos de `process.env`). Agora são
parâmetros; o padrão é neutro e o Igris passa o valor de antes, para o comportamento não mudar.
O texto do resto deste documento ainda cita as envs e os nomes antigos.

| Parâmetro | Onde | Padrão | O que o Igris passa |
|---|---|---|---|
| `modoBancada` + `chaveDeBancada` | `criarProvedorDeCliente` (`src/nucleo/provedor.js`) | `false` / ausente: a chave de bancada é ignorada | `process.env.IGRIS_TEST === '1' \|\| process.env.NODE_ENV === 'test' \|\| process.env.IGRIS_DECISOES_BANCADA === '1'` e `process.env.IGRIS_DECISOES_CHAVE` (lidos pelo host, uma vez) |
| `consumer` | `criarProvedorDeCliente`, `criarClienteDoGateway` | **obrigatório** | `'module:executor'` (`'eval:decisions'` na bancada) |
| `xTitle` | `criarCliente`, `criarProvedorDeCliente` | `'agent-factory'` | `'igris-decisions'` |
| `resolver` | `embedderDoRoteamento` (`treino/lib/embedder.js`) | **obrigatório** (antes: import dinâmico de `@igris/embeddings`) | `getProviderForRole` de `@igris/embeddings` (sem chamador hoje) |
| `raizPowers` | `extrairCasos`, `pisoIncondicional`, `criarServicoDeTreino` | **obrigatório** (antes: `RAIZ_POWERS_PADRAO`, relativo ao monorepo) | `packages/powers/src/powers` (caminho absoluto) |
| `dirCache` | `criarServicoDeTreino` (`treino/lib/servico.js`) | `(dataDir) => join(dataDir, 'agent-factory', 'cache')` | `(dataDir) => join(dataDir, 'igris', 'cache')` |

Valores exatos e arquivos do Igris que os passam: [`../MIGRACAO-IGRIS.md`](../MIGRACAO-IGRIS.md) §4.

## Regra de pureza — zero dependências, nada de `ctx`

`@igris/decisions` **não importa nada do executor, do genos, de nenhum
`@igris/*` do monorepo, e não conhece `ctx`**. `package.json` declara uma única
dependência de workspace, `@igris/providers` (o transporte do Jev), mais
`node:test` como dev tooling implícito (`node --test`); o treino e o decisor
local (`src/local/`, `treino/`) não importam nenhum `@igris/*`. Tudo que o pacote precisa do mundo real entra por parâmetro:
o catálogo é uma lista simples (`{name, power, desc, prefetch?, params?}`), o
estado é um objeto simples, o cliente HTTP é injetado (`cliente:
{decidir(...)}`), até o `fetch` é injetável em `criarCliente`. É essa
fronteira que permite `decidir()` ser importado, sem adaptação, tanto pela
costura do executor (`packages/executor/src/orchestration/decisoes.js`)
quanto — quando o executor portar para a fábrica de orquestradores — por
`@igris/orchestrator`, sem o pacote saber qual dos dois o está chamando.

**Se uma mudança aqui exigir `ctx`, um import de `@igris/algumacoisa`, ou
qualquer I/O que não seja o `fetch` de `cliente.js`, a mudança pertence à
costura do host, não a este pacote.** É a costura (`decisoes.js` no
executor) que sabe o que é `ensurePowerBundleLoaded`, o que é uma sessão, o
que é `registerDecisionContribution` — este pacote não sabe que essas coisas
existem.

## Texto de pergunta e cortes são calibração medida

`perguntas.js` (o texto exato de cada pergunta ao Jev), `descricaoDaTool()`
em `catalogo.js` (o que o `criteria` de `next_tool` diz de cada tool), e os
`CORTES_PADRAO` de `gates.js` (`semHidratacao: 0.3, topK: 0.5, k: 3,
prefetch: 0.7, dica: 0.7`) não são só código — são o resultado de uma
bancada de ~$0,50 em chamadas reais contra sessões de produção (`eval/`,
tabela completa em `eval/README.md` e na spec §10).

**Mudar qualquer um desses três arquivos sem re-rodar a bancada é
descalibrar sem saber.** Antes de subir uma mudança em `perguntas.js`,
`descricaoDaTool()`, a forma do `state` em `estado.js`, ou os cortes de
`gates.js`:

```bash
OPENROUTER_API_KEY=… node packages/decisions/eval/replay2.mjs --nivel curta
OPENROUTER_API_KEY=… node packages/decisions/eval/cheap.mjs --controle 36
```

e comparar contra a tabela de referência em `eval/README.md` (mesma tabela
da spec §10). **±2 pontos percentuais é ruído; mais que isso é regressão ou
ganho real** — que vira linha nova na tabela, não só um número trocado.
`eval/fixtures/` (os casos reconstruídos de log real, com pedido literal do
usuário) é gitignored de propósito — nunca comitar; `eval/resultados/` (os
resumos agregados) é versionado.

## Dependências

| Depende de | Por quê |
|---|---|
| `fetch` nativo (Node 24) | `cliente.js` fala com o endpoint do Jev; nenhum SDK. |
| `node:test` | suíte do pacote (`test/*.test.js`). |

Dependência de workspace: só `@igris/providers` — ver "Regra de pureza" acima.

## Decisões em aberto / dívidas

- **Anel com 1–2 nós degenera a base (D9, parcial).** A nota base é o cosseno **centrado** pela média do índice: com 1 nó o vetor dele é a própria
  média e a nota é 0 (abaixo do corte da base: o local descarta tudo), e com 2 nós as notas saem em ±1, uma para cada lado, qualquer que seja a
  consulta (medido com índice real e embedder falso). Os testes que exercitam o local com catálogo pequeno ficaram fixados; a **borda de produção**
  segue aberta — `IGRIS_CHAT_FABRICA_POWERS` restrito, ou usuário novo com poucos powers (o catálogo do dono tem 38/442/39 nós, bem longe disso) — e
  nenhum teste cobre 1 nó. Pendência: `docs/pendencias/2026-10-06-decisor-local-de-selecao.md` (D9).
- Recorte por contrato (top-K de tools em vez do bundle inteiro do power)
  não existe aqui — é decisão da costura (E1 do plano), fica para quando o
  executor portar para a fábrica.
- `score` (a terceira primitiva do Jev, além de `noul`/`choice`) não é usada
  em lugar nenhum do pacote — nenhum uso encontrado que pagasse o custo
  (spec §12).
- Provedor único (Jev/OpenRouter). `cliente.js` é isolado deliberadamente
  para a TypeSafe direta (`api.typesafe.ai/v1/systemone`, mesmo corpo) ser o
  segundo provedor, se algum dia fizer falta.

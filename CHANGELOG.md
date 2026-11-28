# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões por tag `vX.Y.Z`,
consumidas por `git+https://github.com./PatrickCavalcanti/agent-factory.git#semver:^X.Y.Z`.

## [0.3.0] — 2026-11-27

Peças que estavam coladas no Igris e as que o Ariadne precisa (índice, carga por chave, corte de função, fiação do
decisor, teto do system, registro de casos). **Host que não declara os campos novos não muda: o turno é o da 0.2.5.**
Cada campo é opt-in e nenhum lê `process.env`: o host lê o ambiente e entrega objeto. O porquê de cada campo está em
[`orquestrador/ARCHITECTURE.md`](./orquestrador/ARCHITECTURE.md) §3.

### Adicionado

- **Índice de capacidades** (`config.indiceDeCapacidades`, `true` ou `{ cabecalho?, prioridade? }`): bloco
  `<capability_index>` no system estável, uma linha por capacidade fora do piso com o nome exato de cada função (só a
  primeira frase da `descricao`). Texto calculado uma vez, na montagem. Subpath novo
  `@okds/agent-factory/indice-de-capacidades` (`renderizarIndiceDeCapacidades`, `cabecalhoDoIndice`,
  `contribuicaoDoIndiceDeCapacidades`, `foraDoPisoComFuncao`).
- **Carga por chave** (`config.cargaPorChave`, mapa `chave → [ids de capacidade]`): as capacidades das chaves do
  turno entram carregadas, pelo mesmo caminho do `carregar` das fontes, sem depender do ranking. Exige `chaves` e
  `catalogoDeChaves`. `aoMontar` e o retorno trazem `cargaPorChave`; o que a chave carregou não entra em
  `promocoes.fontes`.
- **Corte de função** (`config.corteDeFuncao`, `{ carregada?, semanticasDoPiso?, ativo? }`): a fábrica embrulha o
  refinador do anel `tool`; `full` que não passa vira `candidate`. `carregada` corta manual novo em capacidade que já
  estava no prompt; `semanticasDoPiso` corta as funções semânticas de capacidade que mistura piso e relevância. A
  fábrica não exclui capacidade nenhuma por padrão (`carregada.excluir: []`): o host declara. O retorno e o
  `aoMontar` trazem `corteDeFuncao` (as decisões do turno).
- **Fiação do decisor e seleção local**, subpaths `@okds/agent-factory/decisoes/refinadores-do-turno`
  (`refinadoresDoTurno`, `normalizarRefino`, `REFINO_PADRAO`, `comTardias`) e `@okds/agent-factory/decisoes/selecao`
  (`criarSelecaoLocal`, `configDaSelecao`, `registrarCatalogoSemantico`, `serializarSelecao` e o estado por
  `dataDir`). Portados do `refinadores.js` e do `selecao.js` do Igris com config por objeto, `dataDir`,
  `limiaresDoModelo` e `embedder` por parâmetro.
- **Teto por tamanho do system** (`config.tetoDoSystem: { chars }`): acima do teto, `renderErrors` ganha
  `{ ref: 'teto-do-system', error }` e `aoEvento` recebe `{ tipo: 'fabrica:teto-do-system', turno, tamanho, teto }`.
  É aviso: o turno completa.
- **Registro de casos para treino** (`config.aoRegistrarCaso(caso, insumos)` e `config.dadosDoCaso(ctx)`): no fecho de
  cada turno não trivial a fábrica monta o caso com `montarCaso` e o entrega ao gancho, sem aguardar. Erro síncrono vai
  a `renderErrors`; rejeição tardia também sai por `aoEvento({ tipo: 'fabrica:registro-de-casos', erro })`.

### Recusas novas de montagem (só para quem liga o campo)

- **R9:** `indiceDeCapacidades` ligado sem nenhuma capacidade fora do piso com função.
- **R10:** `cargaPorChave` com chave fora de `catalogoDeChaves`, id de capacidade desconhecido, lista vazia, mapa sem
  `catalogoDeChaves` ou sem `chaves`.
- **R11:** `corteDeFuncao` com valor fora do domínio (cabeça e cortes fora de 0..1, `z` ≤ 0, inteiros < 1, lista que
  não é lista, `campo` desconhecido), campo vazio (sem `carregada` nem `semanticasDoPiso`), ou capacidade/função que
  não existem em `config.capacidades`. Corte `0` explícito é aceito, como no Igris.
- **Teto:** `tetoDoSystem` com `chars` que não é inteiro maior que 0.

### Atenção

- Host sem nenhum campo novo: turno igual ao da 0.2.5.
- O evento do teto usa `.tipo` (a convenção dos diagnósticos da fábrica, ao lado de `fabrica:catalogo-mudo`), não
  `.type`, que é dos eventos do genos. Quem ouve `aoEvento` e testa `.type` não vê este evento.
- `normalizarCorte` lança em vez de avisar e seguir no padrão (o Igris avisava porque lia variável de ambiente).
- `_limparSelecaoParaTestes` e `_memoDeDerivacoesParaTestes` (em `decisoes/selecao`) existem só para teste: o
  snapshot do contrato as lista por serem exports, mas não dependa delas fora de teste.
- Em `0.x` o `^` não atravessa minor: o host que estava em `^0.2.5` precisa trocar para `^0.3.0`.

## [0.2.5] — 2026-11-27

Contribuição por chave. **Host que não declara chaves não muda.**

### Adicionado

- `contribuicoes[].chaves` (só em `floor: true`): a contribuição entra só quando o turno traz uma das chaves; sem o
  campo, é base e entra sempre. É volátil por definição (dispensa `volatil`): relida a cada turno, inclusive no
  trivial, e retirada do prompt acumulado quando a chave sai.
- `config.chaves(ctx)`: as chaves do trabalho do turno. Sem a função, o turno tem todas as chaves. Se lançar, o
  turno segue só com a base e o erro vai para `renderErrors`. Memoizado pelo objeto `ctx`.
- `config.catalogoDeChaves`: chave de contribuição fora dele é recusa de montagem; chave do turno fora dele é
  ignorada e registrada em `renderErrors`.
- `config.semanticaSemChave` (opt-in): contribuição com chave que não bateu e tem `semanticText` vira item de
  conversa `chave/<kind>/<origem>.<id>`.
- `config.limiaresDeConversa` (`{ include, candidate }`): cortes do canal de conversa do kairos.
- `aoMontar` publica `chaves: { doTurno, entraram, ficaram }` quando o host usa chaves.

### Recusas novas de montagem (só para quem declara chaves)

- contribuição com `chaves` sem `priority` ou com a prioridade do bloco de capacidades; empate de `priority` entre
  pisos do mesmo nível (decimal vale: 51.01, 51.02); com `semanticaSemChave`, `kind` vazio ou ref derivado repetido.

### Atenção

- Pôr `chaves` numa contribuição que era `volatil: false` muda a posição dela no system (passa para a parte
  volátil), e com isso o prefixo de cache.

## [0.2.4] — 2026-11-25

Leva à linha 0.2.x as mudanças da 0.1.1 (ramo `release/0.1.x`).

### Adicionado

- `config.cartaoSugerido`: `completo` (padrão, o card de sempre) | `funcoesSugeridas` (só os nomes das funções
  que o anel `tool` marcou para o turno, até 5, pela nota) | `nenhum` (sem card de candidata). A legenda de
  `candidatos` acompanha o formato, salvo se o host passar a sua. Cards de capacidade já carregada que voltam com a
  cauda ficam sempre completos (`1365060`, `fa1a2db`).
- `config.idsDeclaradosNoTurno(ctx)`: consulta feita pelo loop do Jev entra na oferta de `_contribuicoes_usadas`
  como tipo `funcao`; oferecida E declarada pelo modelo, conta como uso no fecho do despejo (sobe para o contexto
  fixo). Turno cancelado não promove. `comportamento.funcoesDeclaradas` só aparece quando há declaração; a operação
  do Jev ganha `ref` (`83c5dc9`, `50d6044`).

### Atenção para hosts sem índice próprio de capacidades

- Com `nenhum` (ou com a legenda de `funcoesSugeridas`), a candidata só é achável pelo índice; o índice interno do
  orquestrador lista só `tools.conscious`. O Igris tem índice próprio com todas as capacidades.

## [0.2.3] — 2026-11-16

### Corrigido

- **No protocolo nativo, a função do catálogo COM manual pode ser chamada pelo nome, como no envelope.** A orientação de
  `mensagemDeToolDesconhecida` (0.1) ensinava `call_capability`, mas a volta não sumiu: no chat do Ariadne o modelo
  chamou `codigo__ler_codigo` direto no primeiro turno de toda conversa com o manual no prompt (4 de 4 de 2026-10-29 a
  2026-11-14), e a pessoa via um erro vermelho antes de o turno se corrigir. O Igris não tinha o problema porque no
  envelope o nome é a porta. Agora a fábrica embrulha o provider do turno (`provedorComAtalhoDoCatalogo`, export novo de
  `.`) e troca, na resposta, a chamada pelo nome do catálogo (nome exposto ou sinônimo cru) por
  `call_capability({ ref, args })` — **só se a função tem manual** (no prompt, na cauda ou carregado antes, no turno: a
  mesma guarda do envelope). A troca acontece antes de o genos executar e gravar o histórico, então eventos,
  `nativeToolCalls`, `<turn_operations>` e `aoChamada` continuam vendo só `call_capability`; o kairos confere escopo,
  permissão e argumentos como em qualquer chamada; e a lista nativa segue com as três meta-tools (o cache de
  `7ac494bb` não muda). Vale para `generate` e para o `response.completed` do `stream`; nunca para nome registrado
  como função nativa. Diferença do envelope: a conferência é na chegada da resposta, então carregar e chamar no
  MESMO lote é recusado (lá passa, porque a guarda roda na execução). Envelope e fence não mudam.

### Mudado

- **`mensagemDeToolDesconhecida(toolName, nomesDoCatalogo?)`** ganhou o segundo argumento e textos novos. Função do
  catálogo que chega a ela é a que ficou sem manual: o texto manda carregar com `load_capability` pela `ref`. Nome com
  `__` fora do catálogo: diz que não existe e aponta `search_capabilities`. Sem o mapa, todo nome com `__` cai no
  segundo caso (antes o texto mandava usar `call_capability` com o próprio nome).

## [0.2.2] — 2026-11-04

### Adicionado

- **`separarSystemVolatil`** (opção de `criarOrquestrador` e de `criarConstrutorDePrompt`, padrão `false`): o system sai em
  DUAS mensagens `developer` — `id: 'sys'` com tudo até antes da primeira seção volátil e `id: 'sys-volatil'` dali em diante. É
  volátil a primeira seção que vem de um piso declarado `volatil: true` (o `montar` ganhou `refsVolateis`, que a fábrica preenche
  com `contribuicoes[].volatil` e `config.refsVolateis(ctx)`) ou o nível dinâmico (`system:dynamic`, volátil por definição).
  Para o cache de prompt entre execuções: com o system num bloco só, a marca de cache do provider ficava depois de um
  final que muda a cada job (worktree, tentativa, mensagem), e o prefixo igual dos jobs nunca era reaproveitado. Com a
  fronteira, o host marca o primeiro bloco. `system` e `secoes` do payload e do `aoMontar` seguem inteiros; a junção das duas
  mensagens com dois LF dá exatamente os bytes de `system` (testado). Sem seção volátil, ou com a volátil abrindo o
  system (nada estável antes), sai uma mensagem só, idêntica a quando a opção está desligada. Com a opção desligada nada
  muda. O genos repassa as duas mensagens ao provider em ordem, antes do histórico e do pedido; quem lê `mensagens` do
  payload e supunha uma só mensagem `developer` deve olhar `id` (`sys` / `sys-volatil`).

## [0.2.1] — 2026-11-03

### Corrigido

- **Registro de operações do turno marcava `ok` a função que devolve recusa sem lançar.** O genos emite
  `tool.completed` sempre que o handler retorna (o evento não traz o retorno), e o dispatcher do kairos
  devolve `{ ok: true, result }` mesmo quando o handler devolve `{ ok: false }`. Resultado: `operacoes`, o
  bloco `<turn_operations>` e o `aoChamada` (`fase: 'fim'`) diziam `ok`/`resultado: ok` para uma recusa
  (caso medido: `pipeline__abrir_pedido` recusado por falta de autorização, registrado como `ok`). Agora o
  retorno de cada chamada é observado (por fora do `decorarTool`) e passa por `falhaDoResultado` — a mesma
  regra do loop do Jev, sem segunda heurística; pela meta-tool `call_capability` o retorno é desembrulhado do
  envelope do dispatcher (`result`) antes. A falha sai com `ok: false` e o motivo em `erro`, cortado em
  300 caracteres (entra no bloco e no histórico de todo turno seguinte). Handler de sucesso segue `ok`.
- **`falhaDoResultado` lê mais formas de motivo.** Além de `error` e `reason`, agora `erro`, `mensagem`, `message`, `motivo`
  (primeira string encontrada, no objeto ou aninhada) e `code` como último recurso; `{ ok: false, faltas }` segue
  sem texto (`ok: false`). Retorno MCP `{ isError: true, content }` também é falha: vale o primeiro item de texto do `content`; se for
  JSON com motivo (`{"ok":false,"error":{"message":"…"}}`), o motivo do JSON; senão, o texto. Vale para o loop do Jev também, que usa a mesma função.
- **Linha do kairos no `load_capability`.** Quando o kairos terminar o retorno com `Para executar: call_capability, com ref = o nome do cabeçalho (##) e args = os parâmetros.`, a fábrica ajusta por protocolo: no nativo
  (`registraCapacidades === false`) acrescenta "Não chame pelo nome direto."; em envelope/fence remove a linha (lá o
  nome direto é a porta). Testado com a linha real do kairos `0.841.261103` (devDependency subida de `^0.841.261021`) em nativo, envelope e fence.

### Adicionado

- **`aoChamada` (`fase: 'fim'`) ganha o campo aditivo `desfecho`**: `'concluiu'`, `'recusa'` (o handler devolveu a
  recusa) ou `'lancou'` (exceção, `tool.failed`). Os campos atuais não mudam, mas `ok: false` agora também vale
  para recusa devolvida: host que lia `ok === false` como "lançou" (ex.: `tool_threw`) deve olhar `desfecho`.

### Comportamento que muda por consequência

- Função recusada deixa de contar como "usada" no registro de uso do despejo (`usosDoTurno` ignora `!op.ok`) e
  `consultasDoTurnoDe` (apoio) passa a devolver `ok: false` para consulta recusada.

### Pendências

- `recusaSemManual` (`manual_nao_carregado`, devolve `{ erro, mensagem }` sem `ok: false`) segue `ok` no
  histórico e em `aoChamada`; só o conjunto `recusadas` a distingue (para o registro de uso). Tornar essa recusa
  uma falha do registro é decisão de comportamento, fora desta versão.

## [0.2.0] — 2026-11-01

### Adicionado

- **`mecanicaNoCatalogo`** (opção de `criarOrquestrador` e de `criarConstrutorDePrompt`, padrão `false`):
  porta do Ariadne `fc2457a8` + `b7bec589`. A mecânica de chamada sai do topo do system e vive no
  bloco de capacidades, escrita pela estratégia de protocolo; no `nativo` o manual sai como
  `<function ref="…">` e não há seção de protocolo (a legenda ensina `call_capability`/`load_capability`);
  o registro de operações do turno sai em forma neutra (`Operação executada | referência: … |
  argumentos: … | resultado: …`). Só no layout `agrupado` (outro layout é recusado na montagem).
  Desligada, o prompt é byte a byte o de antes — o Igris não muda. Teste: `orquestrador/test/mecanica-no-catalogo.test.js`.

## [0.1.0] — 2026-10-31

Primeira versão: a fábrica do Igris como biblioteca própria.

### Adicionado

- **Cópia literal** da fábrica de `igris@430d2c9` (`313a67a`): `orquestrador/` ← `packages/orchestrator`
  (sem `bancada/`, `SINCRONIA.md`), `decisoes/` ← `packages/decisions` (sem `eval/` e sem as CLIs
  `treino/*.mjs`; fica `treino/lib/`). Os testes de D9 não vieram (ver `ORIGEM.md`). Ver `ORIGEM.md`.
- **`apoio/`** (`8ea5198`): peças puras do host — `continuidade`, `intencao`, `consultas-anteriores`,
  `chaveDasCapacidades`, `conversa`, `valores-do-registro`, `pista-contexto` (subpaths `./apoio/<peça>`).
- **Genericização** (padrão neutro + parâmetro; o Igris passa o valor de antes):
  - `protocoloOpts.prefixoDoEnvelope` e `schemasDoEnvelope(prefixo)` (`a7353d3`).
  - `criarProvedorDeCliente({ modoBancada, chaveDeBancada, consumer, xTitle })`, `xTitle` em
    `criarCliente`, `embedderDoRoteamento({ resolver })`, `raizPowers` em `extrairCasos` /
    `pisoIncondicional` / `criarServicoDeTreino`, `dirCache` em `criarServicoDeTreino` (`2c7d258`).
- **Portes do Ariadne** (genéricos, com teste que falha antes): `config.pricingResolver` (`c45d15d`),
  `config.provider(ctx)` (`fac102d`), tool de catálogo chamada pelo nome ensina `call_capability` no
  protocolo nativo — `mensagemDeToolDesconhecida` (`c52b2b4`), `removerBlocosDeOperacoes` e
  `NOMES_PADRAO` exportados de `prompt-builder` (`af11bb5`).
- `config.genos`: opções extras para o `createOrchestrator` do genos; as da fábrica vencem (`355b9a3`).
- `test/contrato.test.js` (congela os 52 subpaths e os nomes exportados) e `test/pureza.test.js`
  (falha com `@igris/`, `IGRIS_` em código ou import relativo para fora do pacote) (`116b2c6`).
- Subpaths para o código que fica no Igris: `./decisoes/{args,conferencia,conferencia-texto,linha-sinal,sombra}`
  e `./despejo/{config,registro-de-uso,conta,despejar,cauda,aviso,costura}`.
- `perfilAgenteLlm` e `perfilShadowLoop` aceitam `prefixoDoEnvelope` na entrada (vai para
  `protocoloOpts.prefixoDoEnvelope`; sem ele, nome neutro).
- `instrucoesNextTool(assistente)` (`./decisoes/perguntas`, export novo) e a opção `assistente` em
  `montarPerguntas`/`decidir`: o texto do `next_tool` deixa de dizer "Igris" (padrão neutro:
  `assistente pessoal`); o Igris passa `'assistente pessoal Igris'` e recebe o texto de antes, byte a byte.
  `INSTRUCOES_NEXT_TOOL` continua exportado, agora com o texto neutro.
- `test/pureza.test.js` cobre também `process['env']`/`process?.env`, desestruturação de `process.env`
  (`const { env } = process`), `new URL('…', import.meta.url)` e `createRequire(…)(…)` que saiam da
  raiz do pacote.
- `README.md`, `ORIGEM.md`, `MIGRACAO-IGRIS.md`, `docs/pendencias/2026-10-31-criacao.md`.

### Alterado

- `nomeExposto` delega a `exposedName` de `@okds/kairos/core/names`; nome prefixado com mais de 64
  caracteres lança já em `nomeExposto` (`209fe07`).
- `refino.test.js` lê a versão do kairos pelo pacote resolvido, não por caminho fixo.
- `@okds/kairos` (`>=0.840.261021 <0.842.0` — a 0.841 só muda o `call_capability` do bridge; o consumidor escolhe) e `genos-orchestrator` (`^0.3.12`) são `peerDependencies`
  (semver, porque o pnpm recusa URL git em peer) e `devDependencies` (URL git); `zod` é dependência.

### Quebras em relação a `@igris/orchestrator` e `@igris/decisions`

- **Nomes de pacote e subpaths:** `@igris/orchestrator[/x]` → `@okds/agent-factory[/x]`;
  `@igris/decisions[/x]` → `@okds/agent-factory/decisoes[/x]`. `@igris/orchestrator/bancada` saiu.
- **Nome do schema do envelope:** o padrão deixa de ser `igris_envelope*` e passa a `envelope*`;
  para os bytes do Igris, `protocoloOpts: { prefixoDoEnvelope: 'igris' }` — inclusive depois dos
  perfis `perfilAgenteLlm`/`perfilShadowLoop`, que repassam o prefixo recebido na `entrada`
  (`prefixoDoEnvelope`). As constantes `SCHEMA_*` têm nome neutro; o nome do Igris vem de
  `schemasDoEnvelope('igris')`.
- **`consumer` obrigatório** em `criarClienteDoGateway` e `criarProvedorDeCliente` (era `'module:executor'`).
- **Fim da leitura de `process.env`** em `criarProvedorDeCliente`: `IGRIS_TEST`, `NODE_ENV`,
  `IGRIS_DECISOES_BANCADA`, `IGRIS_DECISOES_CHAVE` viram `modoBancada`/`chaveDeBancada`, lidos pelo host.
- **`X-Title`** padrão `'agent-factory'` (era `'igris-decisions'`): `xTitle`.
- **`raizPowers` obrigatório** em `extrairCasos`, `pisoIncondicional` e `criarServicoDeTreino`;
  `RAIZ_POWERS_PADRAO` deixou de ser exportado. `criarServicoDeTreino` com o extrator padrão sem
  `raizPowers` lança já na criação (`TypeError`), não só no primeiro `treinar()`.
- **`embedderDoRoteamento({ resolver })` obrigatório**: some o import dinâmico de `@igris/embeddings`.
- **Cache de embeddings do treino:** `<dataDir>/agent-factory/cache` (era `<dataDir>/igris/cache`);
  `dirCache` devolve o do Igris.
- **Peças de apoio** deixam de ser relativas ao executor (`./conversa.js` → `@okds/agent-factory/apoio/conversa`).
- **Histórico da conversa** (comportamento): o `<turn_operations>…</turn_operations>` completo imitado
  pelo modelo é removido antes de costurar o bloco da plataforma. Só blocos completos: abertura sem
  fechamento (inclusive a tag citada em prosa) mantém o texto intacto — o porte do Ariadne `7d5e76e5`
  descartava o resto da resposta.
- **Nome da tag de operações:** `nomes.operacoes` explicitamente `undefined` cai no padrão
  (`turn_operations`) no construtor de prompt (antes virava a tag `<undefined>`), e o histórico remove
  com o mesmo nome efetivo que o construtor usa (`construtor.removerOperacoes`).
- **Tool desconhecida no protocolo nativo** responde com a orientação de `call_capability`.

Ligação do Igris: [`MIGRACAO-IGRIS.md`](./MIGRACAO-IGRIS.md).

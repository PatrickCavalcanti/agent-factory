# ARCHITECTURE — orquestrador (`@okds/agent-factory`)

> **Este é o documento de estado da fábrica.** Diz o que ela é hoje, o que cada campo de configuração
> faz e por que ele existe. Quem lê (Igris, Ariadne ou quem chegar) deve sair sabendo o que existe e
> o motivo. Atualize-o no mesmo commit que mudar a estrutura interna ou a `ConfigDoOrquestrador`.
>
> De onde o código veio: [`../ORIGEM.md`](../ORIGEM.md). Os links deste texto que apontam para o
> Igris (`igris@430d2c9`: `docs/`, `packages/executor`, `packages/powers`) são **referência histórica**
> do que a cópia descrevia; o Igris segue mudando.

## Propósito

`criarOrquestrador(config)` é a fábrica de orquestradores de LLM. Ela liga quatro peças que
existiam soltas — o ranking de capacidades (kairos), o montador de prompt, o protocolo de chamada de
função e o loop do genos — num único ciclo de turno: decidir quais capacidades importam, montar o
prompt sem quebrar cache, expressar a chamada de função num protocolo que o runtime sabe ler e rodar
o loop. O pacote é `@okds/agent-factory`, versão **0.2.5** (`package.json`).

Dois hosts usam a fábrica hoje (insight do Ariadne `docs/insights/2026-11-27-fabrica-desenho-e-o-ariadne.md`, §2; no Ariadne, ramo `feature/contribuicoes-por-chave`):

| Host | O que roda na fábrica | Versão da fábrica |
|---|---|---|
| Igris | o chat e os agentes de fundo (shadow e agente de banco) | ainda na 0.1.x |
| Ariadne | o chat do Dev Mode e os jobs da Pipeline V2 | 0.2.5 |

**Por que a linha 0.2.x tem campos que o Igris não usa.** Todo CAMPO novo da 0.2.x é opt-in:
sem o campo, o turno é byte a byte o de antes (`mecanicaNoCatalogo`, 0.2.0: "o Igris não muda";
chaves, 0.2.5: "host que não declara chaves não muda"; `CHANGELOG.md`). A 0.2.1 e a 0.2.3 são
**correções que valem para todo host**, sem campo para ligar: a 0.2.1 faz o registro de operações
marcar `ok: false` na função que devolve recusa sem lançar; a 0.2.3 faz o protocolo nativo aceitar
a função do catálogo com manual chamada pelo nome (vira `call_capability`) e muda os textos de
`mensagemDeToolDesconhecida` (`CHANGELOG.md`, 0.2.1 e 0.2.3). A 0.2.4 levou à linha 0.2.x
o cartão sugerido e o uso declarado que nasceram na 0.1.1 (`CHANGELOG.md`, 0.2.4).

**Histórico (cópia de 2026-10-31, `igris@430d2c9`).** Na época da cópia a fábrica servia dois
consumidores do Igris atrás de variável de ambiente — shadows de código `mode:'loop'`
(`IGRIS_SHADOW_FABRICA=1`, `packages/shadows/src/runner/in-process.js:378`) e agentes de banco
`motor:'llm'` (`IGRIS_AGENTE_FABRICA=1`, `packages/powers/src/powers/async-shadows/agents/motor-llm.js:418`),
com o caminho legado vivo ao lado — e, desde 2026-09-19, o executor de chat atrás de
`IGRIS_CHAT_FABRICA=1` (`packages/executor/src/orchestration/fabrica/turno.js`), em primeira versão
reduzida (ver §5, "Estado em 2026-09-19"). As seções abaixo preservam esse texto onde ele ainda
explica o desenho.

Regra completa de `ARCHITECTURE.md` por unidade modular:
[`docs/ok-playbook/patterns/code-design.md §9`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/ok-playbook/patterns/code-design.md).
Spec de origem da fábrica no Igris:
[`docs/superpowers/specs/done/2026-09-10-fabrica-de-orquestradores-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/done/2026-09-10-fabrica-de-orquestradores-design.md);
pendências da execução original:
[`docs/pendencias/2026-09-10-fabrica-de-orquestradores.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/pendencias/2026-09-10-fabrica-de-orquestradores.md).

## 1. As quatro peças, e por que são separadas

```
packages/orchestrator/src/
  index.js           criarOrquestrador() — o conector
  prompt-builder.js  port do Ariadne: acumulação append-only por volatilidade
  capacidades.js     registro no Kairos: piso (always) x semântico
  protocolo/
    index.js         seleciona a estratégia
    envelope.js       json_output — movido de packages/executor
    fence.js          command_fence
    nativo.js         provider_native
```

Cada peça resolve um problema que não depende das outras:

- **`@okds/kairos`** decide QUAIS capacidades importam num turno — piso (sempre) × semântico
  (ranking por relevância). Não sabe nada de prompt final nem de protocolo de tool call.
- **`prompt-builder.js`** decide ONDE cada bloco pousa no prompt e por quanto tempo fica, de forma
  append-only. É **agnóstico de plataforma de propósito** (comentário no topo do arquivo): "não sabe
  o que é Ariadne, projeto, MCP ou capacidade de dados; sabe montar um prompt a partir dos BLOCOS que
  a ponte genos do pacote entrega". Zero dependência de runtime — no original do Ariadne
  (`promptBuilder.ts`, 861 linhas) o único import do Kairos era `import type { Block }`, que
  **desaparece** na conversão para JS (spec §4.4): não sobra nem um `require`. É "o candidato natural
  a virar pacote próprio, sozinho" nas palavras do próprio cabeçalho.
- **`protocolo/`** decide COMO uma chamada é expressa no texto e como o runtime a lê de volta —
  três estratégias (`envelope`, `fence`, `nativo`) atrás de um contrato comum (§6).
- **`genos-orchestrator`** é o loop que executa: `createOrchestrator`, `InMemoryRunStore`,
  `ToolRegistry`.

**`index.js` é A lógica de conexão canônica, não a única possível.** O próprio cabeçalho do arquivo
diz isso: "Ela liga quatro peças que existem sozinhas [...] Ela NÃO sabe o que é shadow, agente de
banco ou Igris: quem sabe é o perfil que a instancia." Um consumidor que não precisa de carregamento
semântico poderia usar só `prompt-builder.js` + uma estratégia de `protocolo/` direto sobre o genos,
sem passar pelo Kairos — as peças não empacotam a decisão de usá-las todas juntas, só a fábrica faz
isso, e faz por conveniência dos dois consumidores de hoje.

## 2. A fronteira

A fábrica cobre exatamente o ciclo de um turno (spec §3.1): `discover` no Kairos → acumular no
prompt → montar system + mensagem → selecionar protocolo → rodar `createOrchestrator` → correlacionar
início/fim de chamada → devolver histórico e estado.

Ela **não** faz, de propósito:

- teto de walltime
- `BudgetExceededError` e contabilidade de tokens/custo
- árvore de cancelamento
- hooks `beforeTool`/`afterTool` dos behaviors
- delivery e notificação
- handoff
- `resolveProvider` (seleção de qual conta/tier atende a chamada)

Essa lista foi levantada linha a linha do `packages/shadows/src/runner/in-process.js` (528 linhas,
spec §3.2) — é tudo o que o runner de shadow faz e a fábrica nunca vê. O ponto de contato único é
`decorarTool`:

```js
decorarTool: (nome, definicao) => definicao
```

A fábrica monta o registry do turno (`registryDoTurno` em `index.js`) e passa **cada** tool por
`decorarTool` antes de entregar ao genos — é o mesmo lugar onde o Ariadne enxerta o `HostContext`
(`toolsDoTurno`, `motor.ts:375`), generalizado. É por aí que budget, behaviors e contabilidade
entram hoje: em `in-process.js`, o embrulho de budget e behaviors já aconteceu **antes** de chamar a
fábrica (ao montar o `runToolRegistry`), e o `decorarTool` passado é identidade de propósito
(`(_nome, def) => def`) — o trabalho pesado já rodou fora. Os outros três canais de saída
(`aoEvento`, `aoChamada`, `aoTexto`) completam a costura: é por `aoEvento` que o
`onEventContabilidade` do shadow soma tokens/custo, por exemplo — sem repassá-lo, a contabilidade
zera em silêncio.

**Por que a fronteira é essa, e não uma mais generosa.** Se qualquer um desses itens subisse para a
fábrica, ela nasceria acoplada ao primeiro consumidor (o shadow), e a extração futura para pacote
próprio (§8) ficaria cara — a spec (§3.2) cita o precedente direto: "repetindo a história do
`prompt-builder.ts` que foi parar dentro do genos por falta de lugar melhor". Uma fábrica que soubesse
de walltime do shadow não teria como servir o agente de banco sem ou generalizar a wrong abstraction
ou bifurcar em `if (tipo === 'shadow')` — exatamente o tipo de acoplamento que motivou extrair a peça
em primeiro lugar.

## 3. Os contratos

### `ConfigDoOrquestrador` (JSDoc em `index.js`)

| Campo | Obrigatório | Default | Papel |
|---|---|---|---|
| `base(ctx)` | sim | — | Seções fixas do system — identidade, protocolo, regras. |
| `capacidades` | sim | — | `CapacidadeDeclarada[]` (abaixo). |
| `contribuicoes` | não | `[]` | Informação de PISO que o agente precisa SABER, não CHAMAR — registradas num provider próprio `informacoes` (`loading: { always: true }`), nunca dentro do provider de uma capacidade com tools ranqueáveis (efeito "hub": ver §4). |
| `refsVolateis(ctx)` | não | `[]` | Refs de contribuição cujo `read(ctx)` muda a cada turno — precisam ser recalculadas, não só reexibidas, quando o discover é pulado por texto trivial. |
| `protocolo` | sim | — | `'envelope' \| 'fence' \| 'nativo'`. |
| `protocoloOpts` | não | `{}` | Só `envelope` consome (`{ headless }`); ignorado pelas outras duas. |
| `provider()` | sim | — | Provider do genos. |
| `decorarTool(nome, def)` | não | identidade | Único gancho do consumidor (§2). |
| `embedder` | não | `null` | Dispensável se `tudoPiso(capacidades)` — sem capacidade semântica, o ranking nunca roda. |
| `maxIteracoes` | não | `12` | |
| `limiteDeTools` | não | `6` | Orçamento GLOBAL de hidratação por turno, em CONTAGEM de tools — não é teto por provider nem de tamanho (ver §4, a pendência do custo de prompt). |
| `aoTexto(texto)` | não | — | Delta de texto do modelo (streaming). |
| `aoEvento(evento)` | não | — | Eventos crus do genos. |
| `aoChamada(c)` | não | — | Início/fim de cada chamada, já correlacionados pela fila FIFO por `toolName` (spec §3.4). No fim, `ok: false` vale para exceção E para recusa devolvida sem lançar (`falhaDoResultado` sobre o retorno, motivo em `erro`, cortado em 300 caracteres); o campo `desfecho` distingue: `'concluiu'`, `'recusa'` (devolvida) ou `'lancou'` (exceção). |
| `refinadores` | não | — | **Substitui `aoDescobrir` desde 2026-09-20** (spec `2026-09-20-decisor-por-anel-refinadores-do-kairos-design.md`, R1). `Partial<Record<'provider'\|'tool'\|'skill'\|'source'\|'conversation', RingRefiner>>` — repassado DIRETO para `createManager({ refiners: config.refinadores })` do kairos 0.833; a fábrica não interpreta o contrato, só transporta o que `@igris/decisions/refinadores` monta (`refinadoresDoChat`). O refino roda DENTRO do `discover()`, sem segundo `prepareTurn`. Sem `refinadores`, saída idêntica à de antes do refino (R1: 0.833 sem `refiners` = 0.832 byte a byte). |
| `refino` | não | `{}` | `{ prazoMs?, prazoGeralMs?, candidateProvidersForRefine?, maxActivate? }` — orçamentos/tetos do refino (R4/R6), repassados a `createManager({ refinerBudgetMs: refino.prazoMs, refinersBudgetMs: refino.prazoGeralMs, tool: { candidateProvidersForRefine }, skills: { maxActivate } })`. Sem efeito se `config.refinadores` estiver ausente. |
| `aoSemear(ids, ctx)` | não | — | Skills a semear na memória de trabalho — duas origens no MESMO turno: `Selecao.semear` das fontes (§5, "Atualização 2026-09-20") e, desde a spec "decisor por anel", skills que o refinador do anel `skill` marcou `full` (`skills.activation: 'host'`, sempre ligado). Devolve `Promise<Array<{id, nome?, corpo?}>|void>` — o corpo de cada skill semeada, que a fábrica injeta como bloco `turn:context` efêmero neste turno. Ligado no chat a `semearNaMemoriaDeTrabalho` (`orchestration/fabrica/turno.js`), que chama `habilidades__hab_carregar` de verdade. **`aoDescobrir`/`prazoDoDecisorMs`/`tetoDoDecisor` foram REMOVIDOS de `ConfigDoOrquestrador`** — passar qualquer um dos três hoje lança `TypeError` (Task 9 da mesma spec). O arquivo `orchestration/fabrica/decisor.js` (`criarDecisorDoChat`) que os usava foi substituído por `orchestration/fabrica/refinadores.js`. |
| `contribuicoes[].chaves` (0.2.5) | não | — (sem o campo a contribuição é **base**: entra sempre) | **O que é:** só em contribuição de piso (`floor: true`). Ela entra no prompt só quando o turno traz uma das chaves; é volátil por definição (dispensa `volatil`), é relida a cada turno — inclusive no turno trivial — e sai do prompt acumulado quando a chave sai do turno (`index.js:110-117`, `CHANGELOG.md` 0.2.5). **Por que existe:** o prompt do Ariadne só crescia — a regra de gráfico, de aviso ou de convite chegava a quem só mexia num cadastro simples (spec do Ariadne `docs/superpowers/specs/2026-11-27-contribuicoes-por-chave-design.md`). Escolher pelo ranking não serve aqui: o host sabe pelo trabalho do turno o que importa, então a escolha é determinística (`chaves.js:1-2`). **Por que mora na fábrica:** o que está no prompt acumulado, e o que sai dele, é decisão do acumulador do prompt (`prompt-builder.js`, append-only), que é desta fábrica. **Opt-in:** o host que não declara chaves não muda. Com chaves, `aoMontar` publica `chaves: { doTurno, entraram, ficaram }` (`index.js:4150`). Atenção: pôr `chaves` numa contribuição que era `volatil: false` a move para a parte volátil do system e muda o prefixo de cache (`CHANGELOG.md` 0.2.5). |
| `chaves(ctx)` (0.2.5) | não | sem a função, o turno tem **todas** as chaves (as de `catalogoDeChaves` ou, sem catálogo, as declaradas nas contribuições) | **O que é:** devolve as chaves do trabalho deste turno, lida a cada `executarTurno` e memoizada pelo objeto `ctx` (`index.js:118-126`, `index.js:739-747`). Se lançar, o turno segue só com a base e o erro vai para `renderErrors`. **Por que existe:** o orquestrador é um por processo; o que muda por pedido chega pelo `ctx`. **Por que o padrão é "todas":** ligar `chaves` nas contribuições nunca muda um host que não passa a função (`index.js:123-124`). **Por que mora na fábrica:** é a fábrica que lê a função a cada `executarTurno`, memoiza por `ctx` e decide, turno a turno, quais contribuições de piso entram no prompt e quais saem do prompt acumulado (`index.js:739-747`, `index.js:111-115`); o host só diz quais são as chaves. |
| `catalogoDeChaves` (0.2.5) | não | — (sem catálogo os nomes não são conferidos) | **O que é:** lista de nomes de chave válidos. Chave de contribuição fora dela é **recusa de montagem**; chave do turno fora dela é ignorada e registrada em `renderErrors` (`CHANGELOG.md` 0.2.5; `chaves.js:19-29`; a chave do turno fora do catálogo é tratada em `index.js:749-754`). **Por que existe:** uma chave que nenhum turno traz nunca bate (`chaves.js:8-12`) — a contribuição ficaria fora do prompt sem erro nenhum. O catálogo faz o erro de nome aparecer na montagem. **Por que mora na fábrica:** quem confere o nome é quem monta o catálogo de contribuições (recusa de montagem, `chaves.js:19-29`) e quem lê as chaves do turno (`index.js:749-754`); conferir no host deixaria cada um reimplementar a regra. |
| `semanticaSemChave` (0.2.5) | não | `false` | **O que é:** contribuição com chave que **não bateu** neste turno e declara `semanticText` vira item do canal de conversa do kairos (ref `chave/<kind>/<origem>.<id>`); ainda pode entrar se a conversa pedir o assunto, pelo ranking semântico (`index.js:129-132`). **Por que existe (inferência; sem registro):** a chave é determinística, então só vale o que o host declarou; este seria o caminho opcional para a conversa trazer uma contribuição cuja chave o trabalho não tinha. O `CHANGELOG.md` 0.2.5 só diz o que o campo faz, não o motivo. Exige `kind` não vazio e ref derivado único (recusa de montagem; ver `REGRAS.md`). **Por que mora na fábrica:** é a fábrica que monta os itens do canal de conversa do kairos e deriva o ref `chave/<kind>/<origem>.<id>` (`index.js:129-132`, `chaves.js:90-96`). |
| `limiaresDeConversa` (0.2.5) | não | defaults do kairos | **O que é:** `{ include, candidate }` — os cortes (`threshold`/`candidateThreshold`) do canal de conversa do kairos neste turno (`index.js:133-134`). É o canal por onde entram as contribuições `floor: false`, os itens de `conversa()` e a `semanticaSemChave` (`index.js:58-65`, `index.js:129-132`). **Por que existe:** deixa o host calibrar o corte desse canal em vez de ficar preso ao default do kairos. A motivação da calibração em si não está registrada neste repositório. **Por que mora na fábrica:** é ela que alimenta esse canal (contribuições `floor: false`, `conversa()` e `semanticaSemChave`) e repassa os cortes ao kairos no turno; o host não chega ao `discover` por outro caminho (`index.js:129-134`). |
| `cartaoSugerido` (0.2.4) | não | `'completo'` | **O que é:** formato do card de capacidade **candidata** (não carregada) na mensagem do turno: `completo` (o card de sempre, todas as funções com descrição); `funcoesSugeridas` (só os nomes das funções que o anel `tool` marcou para o turno, até 5, pela nota — `cartao-sugerido.js:6-8`, `cartao-sugerido.js:27-45`); `nenhum` (sem card, o modelo usa o índice). A legenda de `candidatos` acompanha o formato, salvo se o host passar a sua (`cartao-sugerido.js:57-65`). Card de capacidade já carregada que volta com a cauda fica sempre completo (`CHANGELOG.md` 0.2.4). **Por que existe:** medido no Igris, os cartões sugeridos eram 55–90% da mensagem do turno — 14 a 27 mil caracteres, nunca em cache — e o modelo não usou nenhum deles (spec do Igris `docs/superpowers/specs/2026-11-25-cartao-sugerido-e-uso-declarado-do-jev-design.md`, linha 15; `cartao-sugerido.js:1-4` só traz o "55–90%"). **Por que mora na fábrica:** quem monta o card (`cardsComFuncoes`) e a legenda é o orquestrador. Atenção: com `nenhum` (ou com a legenda de `funcoesSugeridas`) a candidata só é achável pelo índice, e o índice interno lista só `tools.conscious`; o Igris tem índice próprio com todas as capacidades (`CHANGELOG.md` 0.2.4). |
| `idsDeclaradosNoTurno(ctx)` e o uso declarado `_contribuicoes_usadas` (0.2.4) | não | ausente = nenhuma declaração | **O que é:** o modelo declara no campo `_contribuicoes_usadas` do envelope o que usou (habilidade, memória ou função); `idsDeclaradosNoTurno` devolve esses ids, sem filtrar pela oferta, e a fábrica os lê no fecho do turno (`index.js:495-498`, ponto de leitura em `index.js:4584`). Consulta que o **loop do Jev** executou entra na oferta como tipo `funcao`; oferecida **e** declarada pelo modelo, conta como uso e sobe para o contexto fixo (`despejo/comportamento.js:65-88`, `97-101`, `109-114`; `CHANGELOG.md` 0.2.4). Turno cancelado não promove. **Por que existe:** a execução do Jev **não** conta como uso do modelo (`despejo/registro-de-uso.js:9-20`, `op.origem`); sem a declaração, uma função que só o Jev consultou seria tratada como ociosa. **Por que mora na fábrica:** o registro de uso e o fecho do despejo são daqui. Só vale com `despejo.comportamento === true`, fora do `headless` **e** com o host passando `aoPrepararHabilidade` (`index.js:2841-2842`; o schema headless não tem o campo: `index.js:2839-2841`). |
| `despejo` (cauda efêmera e despejo) | não | tudo desligado (`DESPEJO_PADRAO`, `despejo/config.js:2-18`) | **O que é:** objeto com três interruptores e os números da conta. `cauda` (padrão `false`): o que a seleção traz vai para a **mensagem do turno**, e o system só recebe o que o modelo usou. `despejo` (padrão `false`): capacidade do system sem uso sai, em lote, quando a conta do cache compensa. `comportamento` (padrão `false`): seleção pelo comportamento — habilidade e memória valem só no turno até o modelo declarar. Números: `x: 8` (mensagens sem uso até virar descartável; a spec dizia 5, calibrado em 29/10), `m: 2` (mensagens seguidas na cauda sem uso até exigir sinal forte; a spec dizia 3), `n: 5`, `k: 5`, `pausaMin: 20`, `r: 0.1`, `w: 1.0`, `razaoPadrao: 0.25`, `tetoAvisoChars: 1200`, `dezMais: 10`, `sinalForte: { cabeca: 0.4, z: 2.5 }`, `porModelo: {}` (override de `r`/`w`). Valor inválido volta ao padrão com um `console.warn`; nunca lança (`despejo/config.js:1`, `index.js:1405-1409`). **Por que existe:** o system era append-only — capacidade ou manual que entrava não saía mais, usado ou não. Na sessão `c70023ef` do Igris, 9 capacidades viraram 20 e o system foi de 169 mil para 386 mil caracteres; cerca de 161 mil caracteres entraram e nunca foram usados (spec do Igris `docs/superpowers/specs/2026-10-29-cauda-efemera-e-despejo-de-capacidades-design.md`, §1). **Por que mora na fábrica:** o acumulador do prompt e a decisão de cache são daqui. Detalhe do mecanismo: [`CAPACIDADES.md`](./CAPACIDADES.md) §10. Desligado, o turno é byte a byte o de antes (`index.js:17-18`). ⚠️ O campo `despejo` não tem `@property` próprio no JSDoc de `ConfigDoOrquestrador`; o contrato está em `despejo/config.js` e na criação do orquestrador (`index.js:1405-1409`). |
| `prazoDaFonteMs` | não | `800` | **O que é:** prazo de `fonte.selecionar` de **cada** capacidade com fonte, em paralelo (um prazo por fonte, não um total). Fonte que estoura o prazo ou lança entra sem seleção neste turno; `fontes[].degradado` registra `'prazo'` ou `'erro: …'` (`index.js:441-446`). **Por que existe:** uma fonte lenta não pode derrubar nem atrasar o turno inteiro. **Por que mora na fábrica:** é a fábrica que chama `fonte.selecionar` de todas as capacidades em paralelo antes do primeiro `prepareTurn` (`index.js:2860-2870`); o prazo é do passo que ela executa, igual para qualquer host. |
| `separarSystemVolatil` (0.2.2) | não | `false` | **O que é:** o system sai em **duas** mensagens `developer` — `id: 'sys'` (tudo até antes da primeira seção volátil) e `id: 'sys-volatil'` (dali em diante); as duas juntas, com dois LF, dão exatamente os bytes do `system` (`index.js:167-173`, `CHANGELOG.md` 0.2.2). **Por que existe:** para o cache de prompt **entre execuções** — com o system num bloco só, a marca de cache do provider ficava depois de um final que muda a cada job (worktree, tentativa, mensagem), e o prefixo igual dos jobs nunca era reaproveitado. Com a fronteira, o host marca o primeiro bloco (`CHANGELOG.md` 0.2.2). Sem seção volátil, ou com a volátil abrindo o system, sai uma mensagem só. **Por que mora na fábrica:** é ela que monta o system a partir das seções (estáveis e voláteis) e entrega a mensagem ao runtime; só quem monta sabe onde está a fronteira (`index.js:167-173`). |
| `pisoCompletoNoTurnoTrivial` | não | `false` | **O que é:** no turno trivial (`unchanged`), o piso entra com a descrição (`<provider>/instructions`) e o índice de **todas** as tools dos providers `loading.always`, a mesma forma de um turno normal, em vez de só as `pinned` (`index.js:174-177`). **Por que existe:** sem isso o turno seguinte reescreve o começo do bloco de capacidades (`index.js:176-177`). **Por que mora na fábrica:** o bloco de capacidades e a decisão de turno trivial são montados por ela (`index.js:174-177`); o host não tem como mudar a forma desse bloco por fora. |
| `mecanicaNoCatalogo` (0.2.0) | não | `false` | **O que é:** a mecânica de chamada sai do topo do system e passa a viver no bloco de capacidades, escrita pela estratégia de protocolo; no `nativo` o manual sai como `<function ref="…">` e não há seção de protocolo; o registro de operações do turno sai em forma neutra. Só com o layout `agrupado` (outro layout é recusado na montagem) (`index.js:143-145`, `CHANGELOG.md` 0.2.0). **Origem:** porta do Ariadne (`fc2457a8`, `b7bec589`). Desligada, o prompt é byte a byte o de antes. A justificativa do desenho não está registrada neste repositório, só a origem. **Por que mora na fábrica:** o texto de mecânica depende do protocolo escolhido e do layout do bloco de capacidades, e os dois são da fábrica (`index.js:143-145`); por isso a opção é um interruptor da fábrica, não texto do host. |

### `CapacidadeDeclarada` (`capacidades.js`)

```js
{ id, descricao, tools: [...], piso: true, prefixarTools: true }
```

`piso` (default `true`) decide `loading.always` no provider + `pinned` em cada tool — ver §4.
`prefixarTools` (default `true`) decide se o nome exposto ao modelo é `${capId}__${tool}` ou o nome
cru da tool; com **uma única** capacidade (o caso dos dois perfis de hoje) o prefixo não desambigua
nada e os dois perfis o desligam (`prefixarTools: false`) — motivo registrado no comentário da
"Correção 2 (Fase 4, paridade)": sob prefixo, `toolName` vazava prefixado para `result.history`, e
`async-shadows/handlers/delivery.js` (que compara por igualdade estrita contra o nome cru) zerava a
contagem de notificação em silêncio.

### `FonteDeclarada` e `Selecao` (`capacidades.js`, spec [`2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md))

`CapacidadeDeclarada` ganhou um campo opcional `fonte: FonteDeclarada` — hoje só o poder `memoria`
declara (`packages/powers/src/powers/memoria/index.js#fonte`), copiado para a capacidade pelo
adapter `packages/powers/src/fabrica/capacidade.js#capacidadeDoPower`. Contrato:

```js
{
  piso,        // Array<Contribuicao & { floor: true, volatil: boolean, read(ctx) }>  — opcional
  selecionar,  // async (ctx, { vetor1, embedar }) => Selecao                          — opcional
  skills,      // async () => SkillDeclarada[]                                        — opcional
  aoFechar,    // (ctx, { incluidos }) => void                                        — opcional
}
```

- **`piso`** — lista de contribuições `floor: true`, registradas no catálogo do agente pela MESMA
  validação de `config.contribuicoes` (floor booleano, `volatil` obrigatório, formato de `ref`) —
  **não** é uma função chamada por turno; cada item tem seu próprio `read(ctx)`, que lê a seleção
  do turno de um cache por identidade de `ctx`.
- **`selecionar(ctx, sem)`** — uma passada por turno; `sem.embedar` é o embedder compartilhado do
  host (a fonte nunca tem embedder próprio). Devolve `Selecao`: `{ incluidos, candidatos,
  carregar: string[], semear: string[], enriquecer: string|null }`. `carregar` (ids de CAPACIDADE)
  e `semear` (ids de SKILL) são campos separados, promovidos por mecanismos diferentes — ver §5,
  "Atualização 2026-09-20".
- **`skills()`** — catálogo para o anel `skill` do kairos; hoje só `habilidades.fonte.skills()`
  (`packages/powers/src/powers/habilidades/functions/catalogo.js#fonteDeHabilidades`).
- **`aoFechar(ctx, { incluidos })`** — fire-and-forget no fecho do turno; chamado só para fontes
  que responderam dentro do prazo (`config.prazoDaFonteMs`, ver §5).

### `EstrategiaDeProtocolo` (`protocolo/index.js`)

```js
{
  id: 'envelope' | 'fence' | 'nativo',
  toolProtocol: 'json_output' | 'command_fence' | 'provider_native',
  secaoInvariante: () => { nome, conteudo } | null,
  schema: () => object | null,
  forceFinishMessage: string | null,
  extrairTexto: (textoCru: string) => string,
}
```

Ver §6 para o porquê de cada campo e a divisão invariante/forma.

### O que `executarTurno` devolve

```js
{ resultado, texto, payload, operacoes, renderErrors, discover, decisor, embeds, eventosDoKairos,
  fontes, historico, estado, schema, runId, runStore }
```

`fontes` (spec [`2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md)) —
uma entrada por capacidade que declarou `fonte.selecionar`: `{ id, ms, degradado, incluidos,
candidatos, carregar, semear, enriqueceu }`, `[]` quando nenhuma capacidade do turno tem `fonte`.
Mesmo valor entregue a `config.aoMontar`. Detalhe de onde entra na sequência do turno: §5,
"Atualização 2026-09-20", abaixo.

**⚠️ A distinção que já confundiu gente nesta sessão** (comentário explícito no JSDoc de
`executarTurno`, `index.js:272-283`): `entrada.historico` (o que ENTRA) e `retorno.historico` (o que
SAI) são coisas diferentes com o mesmo nome.

- **`entrada.historico`** — mensagens de turnos ANTERIORES, **verbatim**, incluindo `tool_result`
  quando o chamador tiver. Vai para `initialMessages` do genos, entre o system e a mensagem deste
  turno, **sem ser remontado** — é o que um sub-agente persistente (`priorMessages`, ver §5) injeta
  para não perder a conversa anterior.
- **`retorno.historico`** — outra coisa: texto CRU do usuário deste turno + o bloco de operações
  sintetizado (`construtor.blocoDeOperacoes`), na forma que o prompt-builder entende. **Não** contém
  `tool_result` — é a forma "sem-retorno-de-tool" da política de histórico (§5). É o que o PRÓXIMO
  turno deveria mandar de volta como `entrada.historico`, não o que o genos rodou por dentro.

Confundir os dois já custou uma auditoria inteira: o retorno de `executarTurno` também expõe
`runId`/`runStore` — o histórico de MENSAGENS reais do genos (`runStore.load(runId)`), incluindo
`tool_result`. Quando `async-shadows/agents/motor-llm.js` precisou contar `tool_calls` para a
auditoria de custo, usar `saida.historico` (a forma do prompt-builder, sem `tool_result`) teria
zerado a contagem **em silêncio** — a fonte certa é `runStore.load(runId)`, a mesma que
`in-process.js` já usa para o perfil irmão (pendência "async-shadows (auditoria)", 2026-09-10). Regra
geral: "histórico do prompt" (o que o modelo lê no próximo turno) e "histórico de execução"
(evidência do que aconteceu) são coisas diferentes neste sistema, e o nome sozinho não avisa qual é
qual.

## 4. Piso × semântico

A distinção central do Kairos: **piso** é sempre carregado e fora do ranking; **semântico** entra por
relevância, competindo por um orçamento fixo de hidratação (`limiteDeTools`, default 6). Não é
conceito novo no Igris — já existia em forma ad-hoc antes desta fábrica, na entidade
`background_agents`: `tools` é catálogo FECHADO (equivalente a piso) e `carrega` é, nas palavras do
comentário da própria entidade, "um PISO, não um teto — a sessão segue podendo rotear para o resto"
(equivalente a piso + ranking simultâneo). A fábrica dá **uma** implementação para os dois conceitos
que já existiam separados.

**Dois efeitos, dois campos** (`capacidades.js`, verificado na fonte do Kairos):

- `loading.always` no **provider**: sempre carregado E fora do ranking. `rank-providers.ts` pula
  providers `always` de propósito — sem isso, um provider de descrição genérica vira "hub" e vence
  capacidade específica por omissão, não por relevância.
- `pinned` na **tool**: o contrato hidrata sempre que o provider carrega, sem passar por score
  (`resolve/hydrate.ts:116`). É o que entrega o "tudo pré-carregado" que um catálogo fechado quer.

É por isso que **contribuições de piso vivem num provider próprio** (`informacoes`, em
`montarCatalogo`), nunca dentro do provider de uma capacidade que também tem tools semânticas: marcar
esse provider como `always` tiraria a capacidade inteira do ranking para sempre — o mesmo efeito
"hub" acima, só que por engano em vez de por design.

**Armadilha medida, e já corrigida no código:** um catálogo fechado só serve ao seu propósito
(o modelo saber que as tools existem desde o primeiro turno) se o contrato aparecer no prompt mesmo
quando o Kairos pula o `discover` por texto trivial (`prepared.discoverResult.unchanged`) — nesse
caso a ponte do Kairos devolve blocos vazios **de propósito** (comentário do próprio pacote: "o host
reusa a recomendação anterior — permanência é política dele, não nossa"), o que é correto para um
host acumulado e errado para quem depende do primeiro turno. Medido sem essa reconstrução: com
`texto: 'x'` (trivial), o system ficava constante em 1643 chars — **sem contrato nenhum**, tanto para
1 quanto para 5 tools declaradas. Com texto real (não-trivial), o mecanismo funciona e escala: 1 tool
→ system de 1963 chars (2 ocorrências do nome exposto); 5 tools → 2711 chars (10 ocorrências). A
correção mora em `reconstruirBlocosDoTurno` (`index.js`): quando `unchanged` é verdadeiro, ela
reconstrói os contratos de toda tool `pinned` de um provider `always`, incondicionalmente — porque
`tool.contract()` é texto determinístico que não lê `ctx`, refazê-lo em todo turno trivial é
idempotente e fecha exatamente o buraco que motivou a correção.

## 5. Costuras para o porte do executor

**Esta é a seção que [`docs/project-architecture/prompt-assembly-map.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/prompt-assembly-map.md)
referencia.** Ela existe para quem for escrever a próxima spec (a migração do `motor:'igris'`) saber,
sem reler todo o histórico de execução, o que já está pronto e o que só está desenhado.

### Já construído, com quem o exercita hoje (spec §6.1)

| Costura | Quem exercita | Nota |
|---|---|---|
| Hidratação consciente × hidratada | agente de prova semântica (`test/agente-de-prova.test.js`, Fase 6: 12 capacidades declaradas, seleção por relevância) | Provou o caminho semântico ponta a ponta antes de qualquer executor depender dele — os dois perfis de produção o mantêm **desligado** (tudo piso). |
| Variante de schema por sessão | shadow usa `headless` (`SCHEMA_HEADLESS`); o executor usaria `completa` (`SCHEMA_COMPLETA`, com `_fala`/`layout`) | Ambas já existem em `protocolo/envelope-schema.js`. |
| Hook de delta de texto | `aoTexto` — repassa `onMessage` do genos sem engolir | Custo zero: já é a forma nativa do genos. |
| Política de histórico "sem-retorno-de-tool" | os dois perfis de hoje, via `retorno.historico` (§3) | A variante "completo" (com `tool_result`) que o executor provavelmente quer é outro caminho: ver `entrada.historico` abaixo. |
| **`entrada.historico` verbatim (inclui `tool_result`)** | shadows persistentes via `priorMessages` (`in-process.js:442`, `historico: priorMessages`) | **Corrigido depois da spec original:** o parâmetro sempre existiu em `executarTurno`, mas o `runner` de shadow não o repassava — um sub-agente persistente perdia a conversa anterior ao passar pela fábrica. Fiação corrigida (commit `20563f76`); a fábrica em si nunca precisou de mudança. Registrado aqui porque a pendência aberta durante a execução (🚨 "priorMessages é descartado em silêncio pela fábrica") descreve exatamente o sintoma ANTES da correção — quem ler só a pendência sem checar o código sai com a informação desatualizada. |

### Desenhadas, não construídas (spec §6.2)

Só existem como **forma acordada** — nome, assinatura, onde encaixam — para a próxima spec não
precisar redesenhar do zero. Construir sem consumidor apodrece (o precedente citado na spec é a
variante `headless` do schema, que nasceu sem chamador e ficou anos parada):

- **Contribuições de módulo como piso, com `read(ctx)` em tempo de render** — hoje `contribuicoes`
  aceita isso (`config.contribuicoes`, provider `informacoes`), mas nenhum dos dois perfis de
  produção usa: os dois passam tudo como capacidade fechada, não como contribuição de contexto.
  **⚠️ Superado em 2026-09-19** — não é mais verdade para o pacote como um todo: o terceiro
  consumidor (chat do executor, ver bloco "Estado em 2026-09-19" abaixo) usa `contribuicoes`
  como piso via `contribuicoesDaFabrica` (`packages/executor/src/orchestration/fabrica/
  contribuicoes.js`), que traduz o registry de contribuições do executor para o formato que este
  campo espera. Os dois perfis originais (shadow, agente de banco) continuam como estavam — a
  frase seguia certa para eles, só não para o pacote inteiro.
- **Refs voláteis recalculadas por turno** (tela aberta, powers ativos) — o parâmetro
  `refsVolateis(ctx)` existe e `reconstruirBlocosDoTurno` já o consome, mas nenhum perfil de hoje
  declara uma ref volátil real (os dois só têm tools de piso, cujo conteúdo não muda por turno).
  **⚠️ Superado em 2026-09-19** — o perfil do chat não declara `refsVolateis(ctx)` diretamente
  (decisão explícita, ver comentário (b) em `orchestration/fabrica/perfil.js`), mas
  `contribuicoesDaFabrica` marca `volatil: c.tier !== 'fixed'` em cada contribuição de piso, e a
  fábrica já une esse `volatil` com `refsVolateisDeclaradas` (`index.js:582-584`) — o efeito
  prático de "ref volátil real" agora existe em produção, só por um caminho diferente do parâmetro
  legado.
- **Níveis "reduzido/completo" de power** — não tem forma nenhuma ainda no pacote; é decisão que
  caberia em `CapacidadeDeclarada` ou num novo campo de configuração, a definir na spec do executor.

### O que o executor já tem, e o que falta (spec §6.3)

Levantamento da spec: o executor já usa `json_output`, já tem o bloco de operações
(`operations-block.js`, `stitch-operations.js`), já produz `ctx.routing.queryVector`, e já monta
prompt por seções ordenadas. **O que falta é o acumulador** — exatamente a peça central desta
entrega (`prompt-builder.js`, §1).

### Correção viva sobre o custo do carregamento semântico (spec §6.4) — RESOLVIDA no kairos 0.831 (2026-09-19)

A spec original apostava que o custo marginal do ranking semântico por turno tenderia a zero, porque
o vetor da pergunta já calculado pelo Igris (`ctx.routing.queryVector`) poderia ser repassado como
`entrada.embeddingDaPergunta` direto para `DiscoverInput.embedding` do Kairos. Isso ficou **quebrado
até o kairos 0.831**: o campo era aceito e repassado (`src/index.js`, `bridge.prepareTurn({ ...,
embedding: entrada.embeddingDaPergunta })`), mas a ponte do `@okds/kairos` (`genos/bridge.ts`,
dependência externa) nunca lia esse campo — a chamada interna a `manager.discover()` citava só
`text/ctx/state/limits/turn/conversation`, nunca `embedding`. Confirmado então por embedder-espião (o
role `query` era chamado mesmo com o vetor presente) e por mutação (apagar a linha de repasse não
mudava um teste sequer).

**Desde o kairos 0.831.260919** (`@okds/kairos` commit `cd530a5`, série
`2026-09-19-kairos-upstream-e-dois-vetores-na-fabrica`), a ponte honra `embedding`/`embeddings` e
repassa a `manager.discover()` — a query deixa de ser reembedada quando o host manda o vetor. A
fábrica (Task 11 da mesma série, commit `21cf2b88`) passou a embedar a pergunta **uma única vez** por
turno (`executarTurno`) e a repassar o mesmo vetor aos dois `prepareTurn` do turno (inclusive o
segundo, disparado pelo gancho `aoDescobrir` — histórico: removido em 2026-09-20, ver bloco abaixo) via `entrada.vetoresDaPergunta` (vários
vetores; `embeddingDaPergunta`, um vetor, continua aceito como nome antigo — vira
`[embeddingDaPergunta]`). O retorno de `executarTurno` (e o `info` de `aoMontar`) ganhou
`embeds: { quantos, ms, origem }` — `quantos` fica `0` quando o host manda o vetor pronto, contando o
custo real de embedding por turno. **I1 da revisão final (kairos 0.832.260919):** com texto trivial
(`isTrivial`, `@okds/kairos/resolve` — mesma regra que o discover usa para devolver `unchanged` sem
rodar), a fábrica nem tenta embedar — `origem` ganha um quarto valor, `'trivial'`, ao lado de
`'entrada'`/`'fabrica'`/`'nenhum'`.

Os dois lados usam o mesmo modelo e dimensão (`multilingual-e5-small`, 384d — Task 6.1: Igris via
sidecar Python/torch, Kairos via `@huggingface/transformers`/ONNX, mesmos pesos, útil só para ranking
relativo, não para comparar score absoluto entre os dois runtimes) — é por isso que o vetor é
reaproveitável de fato, não só em teoria.

### Estado em 2026-09-19 — o porte existe, atrás de flag

O `motor:'igris'` (executor de chat) ganhou um terceiro consumidor da fábrica, atrás de
`IGRIS_CHAT_FABRICA=1`, com a V1 intocada ao lado. Spec de origem:
[`docs/superpowers/specs/done/2026-09-18-orquestrador-de-chat-sobre-a-fabrica-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/done/2026-09-18-orquestrador-de-chat-sobre-a-fabrica-design.md).
Código: [`packages/executor/src/orchestration/fabrica/`](https://github.com/PatrickCavalcanti/igris/tree/430d2c9/packages/executor/src/orchestration/fabrica/)
(`flag.js`, `sessao.js`, `perfil.js`, `base.js`, `contribuicoes.js`, `legendas.js`, `turno.js`) +
o adapter [`packages/powers/src/fabrica/capacidade.js`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/packages/powers/src/fabrica/capacidade.js). Cada
power migrado vira uma `CapacidadeDeclarada`; hoje só `tarefas` e `google-calendar` mais o piso
(`alwaysLoaded`) — os outros 24 não existem no caminho novo até a lista de
`IGRIS_CHAT_FABRICA_POWERS` virar `*`.

Escopo deliberadamente reduzido nesta primeira entrega — a tabela lista o que a V1 faz hoje e o
caminho novo ainda não (detalhe de cada linha em
[`docs/pendencias/2026-09-19-orquestrador-de-chat-sobre-a-fabrica.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/pendencias/2026-09-19-orquestrador-de-chat-sobre-a-fabrica.md)):

| Já faz na V1 | Caminho novo (`turno.js`) |
|---|---|
| Retry de protocolo + banner de guardrail quando a resposta não fecha envelope válido | Não tem retry; texto vazado (`onProtocolViolation`) vai cru ao usuário como resposta, sem banner |
| `FrameDispatchScheduler` (enfileira despacho, `speak await:true` bloqueia) | Não existe — nenhum bloqueio de despacho por `speak` |
| Auditoria de iterações (`reviewArtifacts.js`) e `endStep` com métricas (tokens, sections, toolsRegistered) | `endStep` nunca é chamado pelo turno — quem fecha é o engine da pipeline por conta própria, sem as métricas |
| `layout` e comandos de painel | Fora de escopo nesta entrega |
| Eventos `llm:start`/`llm:done` | Não emitidos |
| Eventos `operation:*` | Não emitidos |
| Anexos (`ctx.attachmentRefs`) chegando à capacidade | `EntradaDaMontagem.anexos` é uma forma incompatível (`{bloco, imagens?}` vs array de refs); sem tradutor, `orq.executarTurno` nunca recebe anexo |
| Blocos internos do usuário e contribuições `turn-context`/`ephemeral` (`internalInput`, canal semântico do Kairos) | Fora do caminho novo; `contribuicoesDaFabrica` filtra tier `ephemeral` de propósito |
| Tools que não são de power (memória, skills, `load_bundle`) | O caminho novo só tem capacidades de power — essas tools não existem lá |
| `callTool` para powers com `recebeCallTool` (ex.: `roteiros.executar_roteiro`) | Inoperante — o handler roda com `tools: null` (`turno.js`, comentário de `capacidadesDoTurno`) |
| Jev decidindo prefetch executado e sugestão de próxima tool | Ainda fora do caminho novo (J6 da spec `2026-09-19-jev-pelo-gateway-e-decisor-da-fabrica-design.md`) |

> **Histórico:** substituído pelos refinadores em 2026-09-20; passar `aoDescobrir` hoje lança `TypeError` (index.js, recusa no início de `criarOrquestrador`).

**Atualização 2026-09-19 (mesmo dia, spec seguinte): o decisor do chat existe, atrás de flag.** A
linha "Jev decidindo hidratação/prefetch/descoberta" desta tabela, na versão anterior deste
documento, ficou desatualizada no mesmo dia em que foi escrita — spec
[`2026-09-19-jev-pelo-gateway-e-decisor-da-fabrica-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/done/2026-09-19-jev-pelo-gateway-e-decisor-da-fabrica-design.md)
acrescentou o gancho `aoDescobrir` (que era uma linha da tabela de contratos de §3 e hoje não existe mais; ver o histórico acima e a atualização de 2026-09-20) e ligou o Jev como decisor
OPCIONAL da descoberta — atrás de `IGRIS_CHAT_FABRICA_DECISOR` (default ligado;
`packages/executor/src/orchestration/fabrica/flag.js`), independente de `IGRIS_CHAT_FABRICA`
(o caminho novo inteiro) e de `IGRIS_DECISOES` (V1). O que o Jev decide hoje é só a linha que
sobra na tabela acima: quais capacidades candidatas entram e quais funções sem manual vêm com
manual neste turno (J4) — nunca chama tool, nunca tira nada do que o kairos já decidiu (J0). Detalhe
do gancho: [`docs/project-architecture/prompt-assembly-map.md §3.2`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/prompt-assembly-map.md).
Detalhe do decisor em si (perguntas, cortes, tetos, artefato): spec §3.2, J4–J7, e
[`docs/project-architecture/decisions.md §7`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/decisions.md).

**Atualização 2026-09-20 (spec seguinte da mesma série): as fontes entram no turno, antes do
`prepareTurn`.** Spec
[`2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md)
corrige parcialmente a linha "Tools que não são de power (memória, skills, `load_bundle`)" da
tabela acima: o poder `habilidades` (novo, `packages/powers/src/powers/habilidades/`) É uma
capacidade comum no caminho novo — `hab_carregar` e as demais funções existem como qualquer tool
de power migrado. Memória continua fora do kairos (`mem_*` não é tool no caminho novo — a fonte
seleciona por fora, abaixo); `load_bundle` continua sem equivalente.

Sequência acrescentada em `executarTurno` (`packages/orchestrator/src/index.js`, a partir de
~linha 1365), entre o embed 1 e o primeiro `bridge.prepareTurn`, em PARALELO com prazo próprio
(`config.prazoDaFonteMs`, campo novo de `ConfigDoOrquestrador`, default 800 ms — uma fonte que
estoura o prazo ou lança entra sem seleção neste turno, `fontes[].degradado` registra, nunca
derruba o turno):

1. `fonte.piso`/`fonte.selecionar` de cada capacidade com `fonte`, em paralelo.
2. `Selecao.incluidos` vira blocos `turn:context` na MENSAGEM do turno (`blocosDasFontes`).
3. `Selecao.carregar` (ids de CAPACIDADE) promovido pelo MESMO mecanismo de `load_capability`
   (`comProvidersNoTurno`), ANTES do gancho do decisor (`aoDescobrir`, acima).
   > **Histórico:** o gancho `aoDescobrir` citado neste passo foi substituído pelos refinadores em 2026-09-20; passar `aoDescobrir` hoje lança `TypeError` (index.js, recusa no início de `criarOrquestrador`).
4. `Selecao.semear` (ids de SKILL, campo separado de `carregar`) aplicado por
   `config.aoSemear(ids, ctx)` — campo novo de `ConfigDoOrquestrador`, ligado no chat a
   `semearNaMemoriaDeTrabalho` (`packages/executor/src/orchestration/fabrica/turno.js`), que chama
   `habilidades__hab_carregar` de verdade via `criarHandlerDePower`. Erro real num id LANÇA (não é
   `console.warn` silencioso) e vai para `renderErrors` (`ref: 'fontes/semear'`).
5. `Selecao.enriquecer` não vazio de alguma fonte dispara o embed 2: soma o enriquecimento de
   todas as fontes, corta em `TETO_ENRIQUECIMENTO_CHARS` (2000 chars), embeda a pergunta somada ao
   enriquecimento, e `vetores` passa a ser `[vetor1, vetor2]`, repassado aos dois `prepareTurn` do
   turno. Sem `enriquecer` nenhum, só o vetor 1 segue.
6. `fonte.aoFechar(ctx, { incluidos })` no fecho do turno, só para fontes que responderam dentro
   do prazo; fire-and-forget, sem `await` no caminho da resposta.

Detalhe completo da sequência, com a mesma numeração do fluxo de referência (passos 3 e 4):
[`docs/project-architecture/prompt-assembly-map.md §3.3`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/prompt-assembly-map.md)
e [`docs/project-architecture/diagramas/fluxo-do-turno-fabrica.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/diagramas/fluxo-do-turno-fabrica.md).

**Atualização 2026-09-20 (spec seguinte da mesma série: decisor por anel — refinadores do
kairos, kairos 0.833). O gancho `aoDescobrir` (J3, bloco acima) e o segundo `bridge.prepareTurn`
que ele disparava saíram; o refino agora roda DENTRO do próprio `discover()` do kairos, um
`RingRefiner` por anel — ver `config.refinadores`/`config.refino` na tabela de §3 e o detalhe
completo em
[`docs/project-architecture/prompt-assembly-map.md §3.2`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/prompt-assembly-map.md)
e [`docs/project-architecture/decisions.md §7`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/decisions.md).
Três mudanças na sequência de `executarTurno`:

1. **Ondas dentro do `discover`, não mais um gancho fora dele.** `provider`/`skill`/`source`/
   `conversation` em paralelo (onda 1, `Promise.all` sob `refinersBudgetMs`); `tool` depois
   (onda 2, mesmo teto de parede — precisa do catálogo hidratado da onda 1). O host (fábrica)
   não orquestra as ondas: só monta os três `RingRefiner` (`provider`/`tool`/`skill`) via
   `refinadoresDoTurno` (`packages/executor/src/orchestration/fabrica/refinadores.js`) e os
   passa em `config.refinadores`.
2. **`carregar` das fontes pelo ESTADO, antes do (único) `prepareTurn`** (R10) — o passo 3 do
   bloco "Sequência acrescentada" acima (`Selecao.carregar` promovido por
   `comProvidersNoTurno`) já roda antes do primeiro `prepareTurn`; a diferença de R10 é que,
   com o gancho do decisor fora, esse é o ÚNICO ponto de promoção de capacidade por fora do
   refino do kairos — nenhum segundo `prepareTurn` some por causa disso. Sobrevive um segundo
   `prepareTurn` para o caso I3a (skill sugerida por uma fonte sem `habilidades` carregada
   ainda na sessão, `index.js` ~linha 1716) — frequência ainda não medida com uso real — e, hoje,
   também para a promoção do loop do Jev (ver §9, "Quando a descoberta roda").
3. **Skill ativada vira bloco de mensagem, não corpo pré-carregado pelo kairos.** Quando o
   refinador do anel `skill` marca `full` (`skills.activation: 'host'`, R6), a fábrica NÃO deixa
   o kairos renderizar o corpo em `system:stable` — chama `config.aoSemear(ids, ctx)` →
   `habilidades__hab_carregar` de verdade, e o corpo devolvido (`[{id, nome, corpo}]`) vira um
   bloco `turn:context` "Habilidade carregada agora: `<nome>`" na MENSAGEM do turno, efêmero.
   Mesmo canal `aoSemear` que as fontes já usam para `Selecao.semear` (bloco acima) — um id
   pedido pelas duas origens no mesmo turno semeia uma vez só. Com `comportamento` ligado
   (`IGRIS_CHAT_FABRICA_DESPEJO`), a skill da seleção (Jev ou `Selecao.semear`) não passa por
   `aoSemear`: `config.aoPrepararHabilidade(ids, ctx)` devolve o corpo sem escrever, o bloco vira
   "Habilidade sugerida para este pedido: <nome> (id: <id>)" e a saída do turno ganha
   `comportamento.oferecidas`; quem semeia é o host, no fecho, o que o modelo declarou em
   `_contribuicoes_usadas` (`despejo/comportamento.js`; ver `docs/project-architecture/fabrica.md` §6).

O retorno de `executarTurno` (e `aoMontar`) ganha `refino: { msTotal, degradado, porAnel }`
(agregado do `discover.explain[].proposedTier/tier/refiner` e dos eventos `refiner.applied`/
`refiner.fallback` do kairos — `msTotal` = maior `ms` da onda 1 + `ms` de `tool`) ao lado de
`promocoes: { fontes, skills }` (o que de fato promoveu neste turno, fontes e skills juntas).
Sem cliente do gateway (`clienteDeDecisao` nulo em `turno.js`), `refinadoresDoTurno` devolve
`{}`, `config.refinadores` fica ausente e `refino` sai `null` — mesmo shape de antes do refino
existir. Código: `packages/executor/src/orchestration/fabrica/refinadores.js` (fiação),
`packages/decisions/src/refinadores/*.js` (`@igris/decisions`, os três `RingRefiner` concretos e
`criarRefinadorJev`).

**Atualização 2026-10-06/07 (decisor local de seleção).** Em `provider` e `tool` o `RingRefiner` que entra em
`config.refinadores` não é mais, por padrão, o do Jev: é o **refinador local** (`packages/decisions/src/local/refinador-local.js`,
embedding + cabeça treinada), com o Jev em sombra (modo `local+sombra-jev`; `skill` segue `jev+sombra-local`). O orquestrador não
muda nem distingue: recebe funções de anel com o mesmo contrato `RingRefiner` e as repassa ao `createManager`. A escolha do modo, o
índice por anel e as sombras ficam no host (`packages/executor/src/orchestration/fabrica/selecao.js`, criada por sessão em `turno.js`,
que lhe entrega os refinadores do Jev de `refinadores.js`);
`IGRIS_CHAT_FABRICA_DECISOR=0` desliga **os dois** decisores. O parágrafo anterior ("sem cliente do gateway… `refino` sai `null`")
descreve o caminho só com o Jev: com o local, `config.refinadores` também é registrado sem cliente do Jev quando há embedder
(`comRefinadores` em `turno.js`). Contrato, composição, treino e configuração:
[`docs/project-architecture/decisions.md §7.3`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/project-architecture/decisions.md) e a seção "`src/local/` e `treino/`" de
[`packages/decisions/ARCHITECTURE.md`](../decisoes/ARCHITECTURE.md).

## 6. Por que o protocolo é fechado no genos

O `genos-orchestrator` declara `OrchestratorToolProtocol` como união fechada:
`command_fence | provider_native | json_output` (`types.ts:119`). Essa união é do **parser**, não da
configuração — acrescentar um quarto protocolo exige mexer no `orchestrator.ts` do genos (repo
próprio, git externo), nunca é um parâmetro que este pacote pudesse abrir.

O texto que ENSINA cada protocolo, no entanto, mora aqui (`protocolo/*.js`), por decisão explícita de
escopo (spec §2): o genos é dono do parser mas nunca escreveu a instrução positiva, só a corretiva
depois da falha (`orchestrator.ts:1448-1463`). O corte fica solidário ao parser real, e o antídoto
contra a divergência silenciosa é o **teste de ida-e-volta**: renderizar a seção invariante, produzir
uma saída naquele formato, e passar pelo parser real do genos (não um parser de teste) — provado nas
três estratégias (spec §8, "Ida-e-volta do protocolo").

**A armadilha conhecida do `envelope`, e por que ela é estrutural, não um bug de um modelo só.** A
estratégia `envelope` (`json_output`) carrega `args` como STRING contendo JSON, não como objeto —
decisão que já quebrou dois vendors diferentes no mesmo teste (comentário de `envelope-schema.js`,
sessão `c936d250`): OpenAI recusa `object` sem `properties` declaradas sob `strict:true` (erro alto e
visível), Gemini aceita e gera sempre `args: {}` (falha silenciosa — a tool nunca recebe argumento
nenhum). A saída (`args` como string) evita as duas, ao custo de o modelo precisar emitir uma aspa
ESCAPADA seguida de uma aspa CRUA na fronteira de fechamento — e essa fronteira **já quebrou dois
modelos reais no mesmo caractere**: `openai/gpt-5.6-luna` (08/09) e `inception/mercury-2.5` (10/09)
os dois omitiram a aspa crua na mesma posição, um deles degenerando em 438k caracteres de whitespace
antes de o teto de tokens cortar (ver
[`docs/pendencias/2026-09-10-envelope-args-dupla-codificacao.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/pendencias/2026-09-10-envelope-args-dupla-codificacao.md)).
Não é peculiaridade de um modelo — é o preço estrutural de codificar JSON dentro de uma string JSON,
pago por qualquer modelo que emita muito payload em modo escape.

**A rota de eliminação é a estratégia `nativo`, escolhida por conformidade MEDIDA, não por flag
declarado.** A spec (§4.1) é explícita: `capabilities.structuredOutput` mente —
`supportsStructuredOutputsFor` responde `true` para um único endpoint, e llama.cpp aceita o schema e
o ignora em silêncio (provado em 2026-09-08 contra MiniCPM5-2B). A fonte de verdade é a bancada
(`bancada-modelo`, sete checks estruturais) rodada contra o modelo real — não um campo que o provider
declara sobre si mesmo. `nativo` (`provider_native`) elimina a dupla codificação porque cada tool
declara schema próprio e `args` chega como objeto cru no canal nativo de tool calls do provider — zero
string-dentro-de-JSON. Hoje `nativo` está implementada e testada, mas **sem uso em produção**: todos
os adapters de provider do Igris declaram `nativeTools: false`. Ela existe porque implementar a
SEGUNDA estratégia (junto com `fence`) é o que prova que o contrato (`EstrategiaDeProtocolo`) não foi
moldado à primeira — e porque é o destino natural quando um modelo aprovado pela bancada substituir o
envelope.

Outro detalhe estrutural que vale entender antes de mexer no schema do envelope:
`envelope-schema.js` ordena `_fala` antes de `chat` com um underscore deliberado — bancada de
2026-09-03 (`meta/muse-spark-1.3-contributor`, 6 rodadas, 36 blocos com os dois campos) mediu que
**0 de 36** respeitaram a ordem declarada em `properties`; a serialização saiu alfabética, não por
tendência do modelo, mas por como o serializador do provider escreve o objeto. Como `_` (ASCII 95)
ordena antes de qualquer minúscula (97+), `_fala` fica primeiro mesmo sob serialização alfabética —
é defesa estrutural que não depende do modelo obedecer instrução nenhuma.

## 7. O que está aberto

A lista completa, com contexto e ponteiros, é
[`docs/pendencias/2026-09-10-fabrica-de-orquestradores.md`](https://github.com/PatrickCavalcanti/igris/blob/430d2c9/docs/pendencias/2026-09-10-fabrica-de-orquestradores.md)
(~30 entradas) — não repetida aqui. O que muda decisão para quem for **usar** ou **estender** o
pacote:

- 🚨 **A correlação de chamadas por fila FIFO quebra com `execMode: 'promise'`** (tools em
  background). O genos emite `tool.started` mas nunca `tool.completed`/`tool.failed` para uma
  chamada em background — a entrada fica presa em `emAberto` e some sem erro, ou pior, casa com a
  chamada errada se o mesmo `toolName` rodar de novo antes do job de background terminar. **Hoje é
  seguro** porque as chamadas de um turno são estritamente sequenciais nos dois perfis de produção
  (`for ... await executeTool`); vira bloqueio real no dia em que algum perfil declarar
  `execMode: 'promise'`.
- ✅ **`embeddingDaPergunta`/`vetoresDaPergunta` tem efeito desde o kairos 0.831** (2026-09-19) — ver
  §5, "Correção viva sobre o custo do carregamento semântico": a ponte honra o vetor pré-calculado
  (`@okds/kairos` `cd530a5`) e a fábrica (`21cf2b88`) embeda a pergunta uma vez por turno e reaproveita
  o mesmo vetor nos dois `prepareTurn`.
- 🚨 **A paridade do agente de banco (`motor:'llm'`) não foi exercitada com Postgres real** — exige
  uma linha real em `background_agents` e sign-off do dono (fora do que este projeto autoriza sem
  banco). É o último gate formal antes de remover a chave `IGRIS_AGENTE_FABRICA` (que, na data deste
  documento, ainda está ativa ao lado do caminho legado).
- 🚨 **Agente `motor:'llm'` roda sem tracer** — nos dois ramos, desde sempre; não é regressão desta
  fábrica. Requisito do dono, registrado como trabalho novo fora deste plano: todo agente LLM cria o
  próprio tracer, e o orquestrador (que já tem `payload`, `operacoes`, `resultado`, `historico`,
  `renderErrors`, `estado` na mão) o **usa** sem escrever — quem cria e grava é o consumidor, mesmo
  padrão de `decorarTool`.
- **Catálogo fechado sem teto de TAMANHO, só de contagem.** `limiteDeTools` (default 6) é orçamento
  global por turno em número de tools (`resolve/hydrate.ts`), não em tokens. Um perfil com muitas
  tools declaradas como piso põe todos os contratos completos no system em todo turno — funciona hoje
  porque os dois perfis de produção têm poucas tools; vira custo real se algum crescer muito.
- **Duas entradas da pendência descrevem sintomas já corrigidos no código, sem marca `✅` na
  tabela** — vale saber ao ler o arquivo: "catálogo fechado só chega ao prompt com texto não-trivial"
  (fechado por `reconstruirBlocosDoTurno`, ver §4) e "priorMessages descartado em silêncio pela
  fábrica" (fechado pela fiação em `in-process.js:442`, ver §5). Os dois foram corrigidos depois de
  registrados; a tabela de pendências foi atualizada retroativamente no commit `30e08d03`, logo depois de este doc ser escrito porque documenta o histórico
  da execução, não o estado atual — este `ARCHITECTURE.md` é a fonte do estado atual.

## 8. Extração (feita em 2026-10-31)

> **Estado:** a extração foi feita — este pacote é `@okds/agent-factory` 0.1.0, cópia de `igris@430d2c9`
> (ver [`../ORIGEM.md`](../ORIGEM.md)); a ligação do Igris é [`../MIGRACAO-IGRIS.md`](../MIGRACAO-IGRIS.md).
> O texto abaixo é o da época da cópia, com cada ponto marcado.
>
> - **Resolvido:** `nomeExposto` delega a `exposedName` do kairos (`209fe07`); nome do schema do
>   envelope parametrizável (`protocoloOpts.prefixoDoEnvelope`, `a7353d3`); identidade do Igris fora de
>   `decisoes/` (`2c7d258`); peças puras do host em `apoio/` (`8ea5198`); remendos genéricos do Ariadne
>   portados (`c45d15d`, `fac102d`, `c52b2b4`, `af11bb5`); kairos e genos como peers.
> - **Pendente:** terceiro consumidor para provar a fronteira (o Ariadne, depois); costuras "desenhadas,
>   não construídas"; `createGenosProviderForTier` segue em `@igris/shadows`; vocabulário "power" em nomes
>   públicos; `makeRef` do kairos no lugar do template de ref; campos do host no schema do envelope
>   (`_fala`, `layout`, `_intencao`); dois remendos do Ariadne não portados. Lista completa:
>   [`../docs/pendencias/2026-10-31-criacao.md`](../docs/pendencias/2026-10-31-criacao.md).

O pacote nasceu para virar biblioteca própria depois de estabilizar (spec §2: "Spec única, tudo
dentro do Igris. Extração para pacotes próprios depois de estabilizar"). O candidato mais claro é
`prompt-builder.js` sozinho — zero dependência de runtime (§1), único citado explicitamente no
próprio cabeçalho do arquivo como "o candidato natural a virar pacote próprio". Para o pacote inteiro
(`@igris/orchestrator`) sair do monorepo, falta:

- **PENDENTE — Provar a fronteira do §2 sob um terceiro consumidor.** Hoje ela é inferida de dois perfis que
  nasceram do mesmo levantamento (`in-process.js`); um consumidor com formato de budget ou
  cancelamento diferente testaria se `decorarTool` + os três callbacks realmente bastam, ou se falta
  um quarto gancho.
- **PENDENTE — Fechar as costuras "desenhadas, não construídas" do §5** com pelo menos um consumidor real —
  código sem consumidor apodrece (o precedente citado na spec é a variante `headless` do schema,
  que ficou anos parada até esta entrega lhe dar o primeiro chamador).
- **RESOLVIDO (`209fe07`) — Decidir o destino de `nomeExposto`** (`capacidades.js`) — hoje é uma reimplementação da fórmula
  do Kairos (`${providerId}_${key}`), não um import, porque `@okds/kairos/core/names` não expõe
  `exposedName` publicamente. Enquanto a fábrica mora no monorepo isso é uma pendência registrada;
  fora dele, vira uma dependência implícita de uma versão específica do Kairos que precisaria de
  contrato explícito (subpath público, ou vendoring da fórmula com teste de trava — já existe hoje).
- **PENDENTE (fica no Igris, D7) — Resolver a exportação aditiva que vazou para `@igris/shadows`** — `createGenosProviderForTier` e
  a contabilidade de tokens foram exportados de `@igris/shadows` porque `motor-llm.js` (em
  `packages/powers`) precisava de um provider compatível com o genos e o único código que traduz
  `providerTier` para isso mora lá. Quando `@igris/orchestrator` for extraído, essa superfície
  provavelmente deveria migrar para perto dele (o adapter de provider é mais próximo da fábrica do
  que do módulo de shadows) — decisão adiada, registrada na pendência `shadows (superfície)`.
- **FEITO — Genos e Kairos continuam onde estão** (spec §2: "Ficam onde estão. Não são tocados nesta
  entrega") — a extração do orchestrator não implica extrair as duas dependências junto; ele
  continuaria consumindo-as como pacotes externos, exatamente como consome hoje.

## 9. Orquestrador sem conversa (job)

> Nenhuma spec do Igris trata o job como caso de desenho: o fluxo da fábrica nasceu para "mensagem +
> contexto do turno". O Ariadne é o único host com jobs e prova a fronteira só em parte (insight do
> Ariadne `docs/insights/2026-11-27-fabrica-desenho-e-o-ariadne.md`, §3). Esta seção registra o que a
> fábrica faz e o que não faz quando o host roda um **job**: um turno com várias voltas do modelo e
> nenhuma pessoa digitando. Referência de uso: a Pipeline V2 do Ariadne.

**Como o host entrega a tarefa.** Não há mensagem de pessoa. O host passa o texto da tarefa em
`entrada.texto` de `executarTurno` (`README.md`, exemplo mínimo; `index.js:2769-2775`). É esse texto
que o ranking compara com as capacidades e que o kairos usa para decidir.

**Quando a descoberta roda.** O discover roda uma vez, no início do turno: `aoIncluirConversa` é
"chamado uma vez por turno, depois do discover" (`index.js:209-214`), e o refino por anel acontece
dentro desse discover (§5, "Atualização 2026-09-20"). Depois dele pode haver **uma** promoção, que é
um segundo `bridge.prepareTurn` (`promoverNoTurno`, `index.js:2074`), por um destes dois caminhos: a
promoção do I3a — skill sugerida por uma fonte sem a capacidade `habilidades` carregada
(`index.js:3357`; §5) — ou a do loop do Jev (`index.js:3586`, só com `config.loop?.rodar` e turno não
trivial). Quando o loop roda, a promoção do I3a se funde com a dele numa chamada só
(`index.js:3345-3350`). Sem `config.loop` e sem I3a, o `prepareTurn` do turno é um só. A regra de fundo é a
decisão **S7** da série do Igris de 2026-09-19: "sem contribuições automáticas entre iterações do
loop — nem todo modelo lida bem com contexto injetado no meio do turno"
(`docs/superpowers/specs/2026-09-19-serie-contexto-do-turno-sobre-kairos-e-jev-design.md`, §5 "Decisões fixadas",
linha S7). Na prática: depois que o turno começa, **a fábrica não troca o que o modelo vê
entre uma volta e outra por conta própria**.

**O que o agente faz dentro do job.** Num catálogo semântico (num catálogo fechado não há índice nem cartão; ver adiante), carrega o que precisa pelo índice de capacidades e por
`load_capability`, a meta-tool do kairos (`index.js:510`, `index.js:671`). Pedir é do modelo; trazer
sozinho não é da fábrica. Duas consequências para o host:

- **Turno trivial.** O texto da tarefa passa pela regra `isTrivial` do kairos; trivial pula o discover
  e o embedding (`index.js:2769-2775`). O host que sabe que o job não é trivial pode dizer isso em
  `entrada.trivial: false` (`index.js:2769`). Contribuição com `chaves` é relida mesmo no turno
  trivial (`CHANGELOG.md` 0.2.5).
- **Chaves do trabalho.** É o caminho natural do job: o host sabe o que o job vai tocar e entrega isso
  em `chaves(ctx)` (§3), sem depender de ranking.

**Catálogo fechado (tudo piso) funciona, mas paga tudo em todo job.** Com todas as capacidades em
`piso: true` não há ranking, índice nem cartão; tudo chega com contrato desde a primeira volta (§4 e
REGRAS §5). Os dois perfis de produção da época da cópia, `shadow-loop` e `agente-llm`, eram assim
(§5, tabela "Já construído"). O custo é o limite já registrado em §7: o orçamento `limiteDeTools` conta
funções, não tamanho, então um catálogo fechado grande põe todos os contratos no system de todo job. O
`separarSystemVolatil` (§3) existe justamente para o cache entre jobs.

**O que a fábrica NÃO cobre em job — é do host:**

- dividir o trabalho em tarefas;
- despachar subagentes ou rodadas em paralelo (o genos tem `spawnAgent`, o insight do Ariadne §3 o cita);
- juntar os resultados;
- walltime, orçamento, cancelamento, entrega e handoff — a fronteira de sempre (§2), por `decorarTool` e callbacks.

A fábrica cobre **um turno**. O que acontece entre jobs é do host.

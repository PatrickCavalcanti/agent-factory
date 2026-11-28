# Como declarar uma capacidade

> **Copiado de `igris@430d2c9`; o texto ainda descreve o Igris como host de referência.** Links para `docs/`, `packages/executor` e `packages/powers` apontam para o GitHub do Igris no sha de origem; ver [`ORIGEM.md`](../ORIGEM.md).

> Companheiro de [`REGRAS.md`](./REGRAS.md) (as 8 regras de quem monta um
> orquestrador) e de [`ARCHITECTURE.md`](./ARCHITECTURE.md) (as quatro peças).
> Este documento é sobre **uma capacidade**: o que cada campo faz, qual decisão
> ele expressa, e o que já deu errado em cada um.
>
> Pedido do usuário (2026-09-15): *"essa parte da criação, ou no caso da
> adaptação de capacidades, merece toda uma documentação específica para ela."*

---

## 1. O que é uma capacidade

Um agrupamento de funções de um mesmo assunto, e a unidade que o **ranking**
escolhe. Não é uma categoria de organização: é o que entra ou não entra no
prompt de um turno.

```js
{
  id: 'agenda',
  descricao: 'Consulta e marca compromissos na agenda do usuário.',
  piso: true,
  tools: [ /* ToolDeclarada[] */ ],
}
```

`instrucoes` — manual da capacidade, entra só quando ela carrega; `descricao`
continua sendo a linha de índice.

Duas saídas, dois consumidores (`capacidades.js`):

- `montarProviders` → registry do **kairos** (índice, contratos, ranking)
- `toolsExpostas` → registry do **genos** (execução: nome exposto + zod)

**Registro ≠ anúncio.** Toda tool é registrada no genos, sempre. O que o modelo
CONHECE é o que o acumulador pôs no prompt — e é essa diferença que o guarda de
contrato cobra (§6).

---

## 2. `piso` — a decisão que mais importa

| | `piso: true` (default) | `piso: false` |
|---|---|---|
| Provider | `loading.always` — sempre carregado, **fora do ranking** | disputa ranking |
| Quando usar | o papel precisa dela para fazer o mínimo | só importa em contexto específico |
| Exige `semanticText` | não | **sim — recusa de montagem sem ele** |
| Exige embedder | não | **sim — recusa de montagem sem ele** |

**A regra prática:** *função necessária ao papel é fixa.* Se o agente precisa
dela para dar o primeiro passo, deixá-la sob ranking cria um **túnel de
carregamento** — ele gasta uma volta descobrindo que pode agir. Um job que nasce
com propósito único (avaliar um artefato, por exemplo) é o caso extremo: sem as
funções carregadas no turno 1, a volta inteira é desperdício.

⚠️ **Com UMA capacidade semântica só, "semântico" vira "sempre carrega".**
Medido duas vezes nesta base. `rank-providers.js` pula provider `always`, então
um catálogo com uma semântica tem N=1 em `scored`; `zScores` devolve 0 para
todos; `semDispersao` fica verdadeiro; e a saída D6 ("catálogo sem dispersão")
carrega o líder desde que passe do `rawFloor`. Não há comparação relativa para
recusar.

Consequência: **o corte piso × semântico só significa alguma coisa com duas ou
mais semânticas.** Enquanto houver uma, o honesto é declará-la piso.

⚠️ **Com POUCAS capacidades semânticas (N pequeno, tipicamente N=2), o z-score
satura.** `zScores` normaliza pela dispersão do catálogo — com só dois valores
distintos, o desvio padrão populacional é exatamente metade da diferença entre
eles, então o z de cada um é sempre ±1, **não importa a distância real entre os
cossenos**. Medido na bancada (`bancada/cenarios/chat-igris.mjs`, embedder e5,
turno "o que eu tenho na agenda amanhã e quais tarefas estão abertas?"):
`google-calendar` (cosseno 0.8721) virou `full`, `tarefas` (cosseno 0.8675 — a
menos de um ponto percentual de distância) virou `discard` com
`candidates: []`, porque o `zCandidate` default (0.3) barra qualquer z
negativo. O modelo nunca viu o card de `tarefas`, e sem o card não há nome de
função para carregar.

A saída é `ConfigDoOrquestrador.limiares` (`src/index.js`), repassado a
`thresholds.provider` do `createManager` do kairos — abaixar `zCandidate` deixa
o perdedor entrar como card em vez de sumir, sem tocar `rawFloor` (o piso
absoluto continua sendo o único veto de "fora de domínio"). O perfil do chat
(`packages/executor/.../fabrica/perfil.js`, `LIMIARES_CHAT`) usa
`zCandidate: -1.01`, não `-1` exato — a bancada mediu o MESMO par de
capacidades produzindo `z = -1` num turno e `z = -1.0000000000000007` no
seguinte (ruído de ponto flutuante do cálculo do z-score em si), e a
comparação `>=` do kairos é sensível a essa diferença de ~1e-15. A margem de
-0.01 absorve o ruído sem alcançar o território de N>2, onde um competidor que
"quase perdeu" tem z tipicamente bem menos extremo que -1.

**`maxCandidates` (default 8, `DEFAULT_THRESHOLDS.provider` do kairos) segura
o catálogo grande** — `limiares` não o sobrescreve (só `zFull`/`zCandidate`/
`rawFloor` chegam ao override). Com N=27 capacidades semânticas e
`zCandidate: -1.01`, o pior caso por turno é até 5 `full` + 8 `candidate` = 13
cards, nunca o catálogo inteiro — o corte por quantidade é independente do
corte por z-score.

---

## 3. `semanticText` e `awareness` — o documento que o ranking pontua

`semanticText` é **vetorizado e nunca exibido**. Por isso ele fala a língua do
USUÁRIO — como a pessoa pede a coisa —, não a do sistema. A `descricao`, que o
modelo LÊ, continua sendo prosa para humano.

```js
semanticText: 'relatório consolidado fechamento do mês exportar PDF planilha '
  + 'resumo do período quanto foi no total balanço mensal',
awareness: {
  useWhen: [
    'o usuário pede um fechamento ou consolidado de um período',
    'o usuário quer exportar um resumo em arquivo',
  ],
},
```

⚠️ **`skipWhen` ATRAI o que pretende excluir.** Bag-of-words não entende
negação: a palavra escrita ali para tirar um assunto passa a pontuar por ele.
Medido no Ariadne (`capacidades/codigo.ts:37-42`): um `skipWhen` dizendo "os
REGISTROS mostrados na tela" fez `codigo` ganhar de `dados` no léxico
(0.400 × 0.200) numa pergunta sobre registros.

**Para excluir, descreva o caminho CERTO** ("isso vai por pipeline"), nunca
repetindo o vocabulário do vizinho.

### O piso absoluto, que barra antes de qualquer ranking

A estratégia default do kairos usa `rawFloor: 0.8` — piso no cosseno **cru**,
calibrado na escala do e5 (faixa 0.7–0.9). Ele é aplicado em
`rank-providers.js` **antes** do z-score e **não consulta o léxico**: uma
capacidade com `lexical: 0.75` e `vector: 0.46` é descartada por
inelegibilidade.

Consequência prática para quem escreve teste: **o `FakeEmbedder` não carrega
capacidade semântica nenhuma, nunca** — bag-of-words hasheada produz cosseno
estruturalmente abaixo de 0.8. Layout e legenda se iteram com ele; **roteamento
só em e5**.

---

## 4. `fixa` — o mínimo de uma capacidade semântica

Regra do usuário: *"tools mínimas dentro de uma capacidade devem ser fixas,
porque se eles semanticamente aderiram a outra parte daquela capacidade,
possivelmente as básicas ele vai precisar também."*

`fixa` governa **só** `pinned` na tool; `loading.always` do provider continua
saindo de `piso`. Default: herda o `piso` da capacidade.

```js
{
  id: 'relatorios', piso: false, semanticText: '…',
  tools: [
    { name: 'listar', fixa: true,  /* … */ },  // chega com contrato quando a capacidade vem
    { name: 'emitir', /* herda: não-fixa */ }, // hidrata por score próprio
  ],
}
```

⚠️ **Assimetria deliberada.** `fixa: true` em capacidade **semântica** é o caso
de uso. `fixa: false` em capacidade **piso** é permitido pelo tipo e
**perigoso**: o provider é `always`, então o índice anuncia o nome sempre, mas o
contrato só hidrata se o score individual trouxer — o modelo vê o nome e chama
sem o manual. É a anatomia exata do defeito medido no pipeline V2 do Ariadne
(`projeto/tool/ler` chamada com `args: {}`, recusada por campo obrigatório
ausente).

**A seletividade correta é no nível da CAPACIDADE.**

---

## 5. A tool: o que o host escreve e o que a fábrica escreve

```js
{
  name: 'ler',
  description: 'Lê o conteúdo de um arquivo autoral elegível.', // vira linha de ÍNDICE
  inputSchema: { /* JSON Schema */ },                            // vira os ARGUMENTOS
  contract: 'Path tem de vir de `projeto_listar` ou de uma referência já conhecida.',
  schema: z.object({ path: z.string() }),                        // validação na EXECUÇÃO
  effect: 'read',
  handler: async (args, ctx) => { /* … */ },
}
```

**A divisão de responsabilidade:** o host escreve a **prosa**; a fábrica escreve
a **forma**. `contract` é o parágrafo de cima — o que não cabe no schema:
pré-condição, o que o host recusa, para onde ir em vez disto. Os argumentos
entram **sempre**, renderizados de `inputSchema` (`contrato.js`), e o host não
tem como omiti-los:

```
Path tem de vir de `projeto_listar` ou de uma referência já conhecida.
  Args:
    - `path*`: string — Caminho relativo à raiz do projeto.
    - `offset?`: number — Deslocamento em caracteres; omitido lê do início.
```

`*` obrigatório, `?` opcional, o tipo, a descrição do campo. Objeto aninhado e
array de objeto expõem os próprios campos, indentados.

Isso existe porque as duas alternativas foram medidas e as duas são ruins:
despejar o JSON Schema cru (completo e ilegível) ou listar só os nomes
(`Campos obrigatórios: path.` — legível e vazio).

### Nome exposto: uma convenção só

O modelo chama pelo **nome exposto** (`nomeExposto`): `<capacidade>__<tool>`, ou
a key crua se `prefixarTools: false`.

⚠️ **Ao citar uma tool irmã dentro de um `contract`, use o nome exposto.** O
pipeline V2 do Ariadne citava `spec/tool/ler` na prosa enquanto o índice
anunciava `spec__ler` — duas convenções para a mesma função no mesmo prompt. Foi
um modelo reconciliando duas convenções que produziu o `spec.spec_propor`
inventado (pipeline `23bc30a2`).

`load_capability` aceita as três formas (ref completa, nome exposto, key
sozinha — `resolveToolIdent`), então o nome exposto funciona **e** é consistente.

⚠️ **`prefixarTools: false` só é seguro sem colisão de key.** Com `ler` em duas
capacidades, o nome cru é ambíguo e o resolvedor recusa.

---

## 6. As três peças que fazem o candidato funcionar

Uma capacidade semântica não carregada vira **card**. Três peças precisam
concordar, e mudar uma sem as outras quebra o ciclo:

| Peça | Papel | Onde |
|---|---|---|
| **Card com nomes** | dá o NOME da função | `cardsComFuncoes`, `index.js` |
| **Legenda `candidatos`** | diz o que fazer com ele | `LEGENDAS_PADRAO`, `prompt-builder.js` |
| **Guarda de contrato** | recusa se ele pular o passo | `recusaSemManual`, `index.js` |

Já quebrou uma vez: o card ganhou os nomes e a legenda continuou dizendo *"diga
o que quer fazer em vez de inventar um nome de função"* — mandando declarar
intenção com os nomes impressos logo abaixo.

O guarda lê do **acumulado** (`acumulacao.system.capacidades[].funcoes[]` com
`manual` preenchido), não do discover: uma tool cujo manual entrou três turnos
atrás continua no prompt e tem de ser permitida. Ele **não lança** — devolve
texto que o modelo pode agir em cima. E as **meta-tools nunca são guardadas**: a
saída de emergência não pode ser bloqueada por ela mesma.

### 6.1 Decisor externo (`aoDescobrir`)

> **Histórico:** substituído pelos refinadores em 2026-09-20; passar `aoDescobrir` hoje lança `TypeError` (`src/index.js`, recusa no início de `criarOrquestrador`). O texto abaixo descreve o gancho como era e fica por registro; o mecanismo vigente é `config.refinadores` ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §3 e §5).

`config.aoDescobrir` é um gancho OPCIONAL entre o discover do kairos e a
montagem do prompt (chamado uma vez por turno, nunca em `unchanged`). Ele só
**amplia** o que o kairos já decidiu — nunca chama tool, nunca tira nada:
devolve `{ carregar: string[] }` com refs, nomes expostos, keys ou ids de
capacidade, e a fábrica aplica com o MESMO mecanismo do `load_capability` no
meio do turno (`comCarregadasNoTurno` + a política de sessão do kairos + um
SEGUNDO `prepareTurn`). Um id de capacidade expande só para as funções `fixa`
dela (§4) — nunca para o catálogo inteiro; é por isso que `fixa` importa aqui
tanto quanto no piso: só uma tool `pinned` tem o manual GARANTIDO só por o
provider carregar. Para uma função pedida por ref que não é `fixa` e cujo score
não bastava, a fábrica usa o mesmo fallback que já cobre "capacidade carregada
num turno anterior que este discover não rehidratou" — sem ele a função ficaria
carregada mas MUDA, com o nome no índice e sem contrato para chamar. Sem
`config.aoDescobrir`, nada disto roda e o turno é byte a byte o de sempre.

---

## 7. Adaptar, em vez de reescrever

Quando o host já tem vocabulário próprio de capacidade, o caminho é um
**adapter** — função pura que traduz para a forma da fábrica —, não reescrever
as declarações.

Referência real: `src/pipeline-v2/contributions/paraFabrica.ts` (Ariadne),
que traduz `V2Contribution` em contribuição da fábrica. O que ele mostra:

- **Reusar os filtros que já existem** em vez de reimplementar (ele chama
  `rolesFor`/`appliesTo`, os mesmos do renderizador legado) — fidelidade é o
  requisito: o adapter não pode entregar o que o caminho antigo não entregaria,
  nem esconder o que ele entregaria.
- **Honrar a declaração que o host já faz.** O Ariadne já dizia
  `delivery: 'piso' | 'condicional' | 'semantica'`; o adapter não inventou
  vocabulário, só fez a declaração existente finalmente significar algo.
- **Derivar o que a fábrica exige do que o host já tem** — o `ref` de três
  partes saiu de `<origem>/<type>/<id>`, com o `type` que o host já declarava.

---

## 8. A lista de conferência

Antes de dar uma capacidade por pronta:

- [ ] `piso` é uma **decisão**, não o default por inércia? Se é necessária ao
      papel, é piso.
- [ ] Se `piso: false`: tem `semanticText` na língua do usuário? Tem embedder?
      Existe uma **segunda** capacidade semântica para o ranking comparar?
- [ ] `skipWhen` não repete o vocabulário do vizinho?
- [ ] O mínimo dela está `fixa: true` se ela é semântica?
- [ ] O `contract` de cada tool cita tool irmã pelo **nome exposto**?
- [ ] O `inputSchema` tem `description` em cada campo? (é o que vira o manual)
- [ ] Nenhum nome de tool foi para o **prompt base** (regra 5 do `REGRAS.md`) —
      exceto catálogo fechado, onde tudo é piso.
- [ ] Rodou na bancada (`src/fabrica/bancada/`) e olhou o prompt montado?

---

## 9. Fonte: carga determinística

Uma **fonte** é um campo opcional da capacidade (`fonte: FonteDeclarada`, [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3).
O que interessa aqui é `fonte.selecionar`: uma função da própria capacidade que olha o turno e diz,
**por regra e sem ranking**, que outras capacidades têm de estar carregadas.

**Como funciona.**

1. A fábrica chama `fonte.selecionar(ctx, { vetor1, embedar, capacidadesCarregadas })` de cada capacidade
   com fonte, em paralelo, com prazo próprio (`prazoDaFonteMs`, 800 ms; fonte lenta ou que lança entra sem
   seleção e nunca derruba o turno) (`src/index.js:2860-2870`; JSDoc de `prazoDaFonteMs`, `src/index.js:441-446`).
2. A função devolve uma `Selecao`. O campo `carregar` é uma lista de **ids de capacidade**.
3. A fábrica junta os ids conhecidos (id desconhecido não promove e sai em `renderErrors`:
   `src/index.js:2931-2940`) e os põe em `loadedProviders` do **estado do kairos**, antes do primeiro
   `prepareTurn` do turno (`src/index.js:3163-3165`; a chamada está em `src/index.js:3198-3202`). Não há
   segundo `prepareTurn` por causa disso: o id em `loadedProviders` é hidratado (índice e instruções) no mesmo
   `discover()`, como um provider carregado num turno anterior (`src/index.js:3151-3158`).

**O que chega com a capacidade.** Carregar a capacidade traz as funções `fixa` dela — o mínimo, que chega
com manual (§4; `ARCHITECTURE.md` §4: `pinned` hidrata sempre que o provider carrega). O resto das funções
o anel `tool` decide pela nota de cada uma (insight do Ariadne
`docs/insights/2026-11-27-fabrica-desenho-e-o-ariadne.md`, §1, linha "Carga determinística"). Por isso
`fixa` importa tanto aqui quanto no piso.

**Exemplo real (Igris): a capacidade de pesquisa web carrega quando a mensagem tem URL.** A fonte do poder
`pesquisa-web` (`packages/powers/src/powers/pesquisa-web/fonte.js`, função `pedeConsultaWeb`) devolve
`carregar: ['pesquisa-web']` quando a mensagem tem URL, domínio, ou menção a consulta na internet;
"link" sozinho, sem URL, não dispara. **Por que existe:** na sessão `c753f79b` o pedido trazia duas URLs
e `pesquisa-web` ficou fora até de candidata (nota local 0,110, corte 0,15); numa varredura de outubro,
"abre https://… e me fala…" teve a capacidade descartada a 0,086 — o ranking não lê URL como pedido de web.
A decisão do dono foi tornar isso determinístico, sem depender da nota (spec do Igris
`docs/superpowers/specs/2026-10-19-indice-de-capacidades-e-gatilho-web-design.md`, §1 e decisão 2).

**Por que mora na fábrica, e não no host.** O ponto de entrada é o estado do kairos antes do primeiro
`prepareTurn`, e esse estado é da fábrica. Promover depois custaria um segundo `discover()`: era o que o
antigo passo das fontes e o gancho `aoDescobrir` faziam, e a spec de refinadores (R10) removeu
(`src/index.js:3151-3160`; §6.1).

**Quando usar.** Quando o host conhece uma regra que não depende do que o ranking acha. O Igris usa para
URL na mensagem; o chat do Dev Mode do Ariadne usa para `anexos` e `relatorio` (`carregarQuando` traduzido
para `fonte`; insight do Ariadne, §2). Isto decide a **carga** da capacidade. Para o que o modelo vê
**dentro** dela, use `fixa` (§4); para o conteúdo de prompt por característica do trabalho, use as chaves
de contribuição ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §3, `contribuicoes[].chaves`).

### 9.1 Carga por chave (0.3.0)

Isto vale para quem declara `catalogoDeChaves` (as chaves do trabalho, §3 de `ARCHITECTURE.md`) e quer que uma
chave carregue capacidades. Sem `cargaPorChave`, nada muda.

**O que é.** Um mapa `chave → [ids de capacidade]` na config do orquestrador. A cada turno, as capacidades das
chaves do turno entram **carregadas**. O mapa usa a identidade das capacidades (o `id`) e **não** cria campo novo
na capacidade: uma capacidade pode ser carregada por mais de uma chave, e uma chave por mais de uma capacidade, e
a lista fica num lugar só, legível de uma vez.

**Como carrega.** Pelo mesmo mecanismo do `carregar` da fonte (§9): os ids entram na união de
`loadedProviders` do estado do kairos, **antes** do primeiro `prepareTurn` (`src/index.js`, junto de
`promocoesDasFontes`). Não custa um segundo `discover()`. Fica pegajosa como o `carregar`: o que já está no
prompt acumulado continua. No turno trivial a chave é calculada e publicada do mesmo jeito (as chaves não
dependem do texto), mas, como o `carregar` das fontes, a capacidade só ganha manual no primeiro turno com
`discover` de verdade — turno trivial não hidrata nada.

**Por que existe.** O host sabe pelo trabalho o que é útil: numa tela com relatório o olho e o relatório
importam; num pedido com anexos, os anexos. Nada disso deve depender de a frase do usuário casar com o texto
semântico da capacidade. A chave é determinística; o ranking não é.

**Rastro.** `aoMontar` e o retorno de `executarTurno` trazem `cargaPorChave: { [chave]: [ids] }`, o que cada
chave do turno carregou (só com o campo configurado). É o "carregou pela chave X".

**Chaves do turno.** Vêm de `chaves(ctx)`. Sem `chaves`, o turno tem **todas** as chaves do
`catalogoDeChaves` (mesma regra das contribuições por chave) e o mapa inteiro carrega.

**O que a fábrica recusa na montagem (R10, `REGRAS.md`).** Chave fora de `catalogoDeChaves`; id que não é de uma
capacidade declarada; lista vazia ou que não é lista; mapa sem `catalogoDeChaves`. Todas as mensagens vêm juntas
num só erro. O porquê: nome errado nunca bateria com o turno, e a capacidade ficaria sem carregar, sem erro nenhum.

**Exemplo (Ariadne).** `cargaPorChave: { 'tela-mudada': ['olho'], migracao: ['migracao'] }`: um trabalho que
muda tela já tem o olho carregado; um que mexe em cadastro com dados já tem a capacidade de migração.

**Por que mora na fábrica.** O estado do kairos antes do primeiro `prepareTurn` é da fábrica (§9); promover de
fora custaria o segundo `discover()`.

---

## 10. Cauda efêmera, uso e despejo

Isto vale para quem **declara capacidades semânticas** (`piso: false`) e liga `despejo.cauda` e/ou
`despejo.despejo` (os dois desligados por padrão; defaults em `src/despejo/config.js`, tabela em
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §3). Desligado, o turno é byte a byte o de antes (`src/index.js:17-18`).

**O problema.** O system é append-only: capacidade ou manual que entra não sai mais, usado ou não. O Igris
mediu o efeito numa sessão: 9 capacidades viraram 20, o system foi de 169 mil para 386 mil caracteres e
cerca de 161 mil entraram sem nunca ser usadas (spec do Igris
`docs/superpowers/specs/2026-10-29-cauda-efemera-e-despejo-de-capacidades-design.md`, §1).

**O que a fábrica faz.**

- **Cauda efêmera (`despejo.cauda`).** O que a seleção trouxe e o modelo ainda não usou vai para a
  **mensagem do turno** (a cauda), não para o system. O system só recebe o que já estava nele, o piso e o
  promovido (`src/despejo/cauda.js:1-2`, `separarCauda`). A legenda diz ao modelo que as funções da cauda
  podem ser chamadas agora; as que ele usar passam a ficar no contexto fixo e as que não usar saem em breve
  (`LEGENDA_CAUDA_PADRAO`, `src/despejo/cauda.js:7`).
- **Só o que o modelo usou sobe ao system.** Uso = função que o **modelo executou** com sucesso, mais o que
  ele carregou por `load_capability` (`usadasDoTurno`, `src/despejo/costura.js:99-108`). Função recusada não
  conta (`usosDoTurno`, `src/despejo/registro-de-uso.js:8-20`; `CHANGELOG.md` 0.2.1). A execução do Jev não
  conta como uso do modelo; só vira uso se o modelo a **declarar** em `_contribuicoes_usadas` (linha
  `idsDeclaradosNoTurno` em [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3; `src/despejo/comportamento.js:65-88`, `97-101`, `109-114`;
  `CHANGELOG.md` 0.2.4). Habilidade e memória sugeridas valem só no turno e sobem se o modelo as declarar
  (`despejo.comportamento`; `src/despejo/comportamento.js:1-60`).
- **`fixa` e `acompanha` sobem junto.** Com a capacidade no system, as funções `fixa` dela sobem para o
  system, e as `acompanha` de uma função promovida (usada ou carregada) ou fixa sobem com ela. Não é
  transitivo: a acompanhante da acompanhante não sobe. Nunca traz capacidade para o system: a fixa de uma
  capacidade que só está na cauda continua na cauda (`src/despejo/sobe-junto.js:1-8`).
- **Capacidade ociosa sai inteira (`despejo.despejo`).** Capacidade do system sem uso há mais de `x`
  mensagens (padrão 8) vira descartável e sai **em lote**, quando a conta do cache compensa
  (`r × D × H ≥ (w − r) × S`: o ganho de não pagar o texto parado contra o custo de reescrever o prefixo do
  cache) **ou, sem fazer a conta, quando a pausa desde a última chamada ao modelo chega a `pausaMin` minutos (motivo `pausa`; `src/index.js:4051`;
  o cache provavelmente já esfriou) ou não há system anterior (motivo `sem-cache`)** (`src/despejo/conta.js:30-33`;
  `src/despejo/conta.js:1-38`; `src/despejo/registro-de-uso.js:60-79`). **Função não sai sozinha**:
  enquanto a capacidade fica, nenhum manual dela é marcado, só a capacidade inteira ociosa
  (`src/despejo/registro-de-uso.js:60-64`). `sticky: true` e `sessionBehavior.evictAfterIdleTurns: null`
  impedem o despejo; um número em `evictAfterIdleTurns` troca o `x` daquela capacidade
  (`src/index.js:4019-4026`).
- **Piso nunca sai** (`src/despejo/registro-de-uso.js:60-64`; `src/index.js:1410-1411`).
- **O que saiu é avisado, e a volta exige convicção.** O aviso `<descartadas>` lista só o que já foi usado e
  manda carregar de volta com `load_capability` (`src/despejo/aviso.js`). Capacidade descartada, ou que
  passou `m` mensagens (padrão 2) na cauda sem uso, só volta à cauda com **sinal forte** da seleção:
  confiança do refinador ≥ 0,4 ou z ≥ 2,5 (`src/despejo/registro-de-uso.js:99-106`;
  `src/despejo/costura.js:24-35`; `src/despejo/config.js:16`). O que o loop do Jev trouxe neste turno nunca é
  despejado nele (`protecaoDoDespejo`, `src/despejo/costura.js:50-69`).
- **Continuação curta.** A cauda do turno anterior vale por mais um turno quando este é continuação dele
  ("posso enviar?" → "sim"): turno trivial, veto de trivial por continuidade do host, ou pista de contexto
  aplicada (`ehContinuacaoCurta`, `src/despejo/costura.js:78-87`).

**Por que mora na fábrica.** O acumulador do prompt, o estado do kairos e a medição do cache são daqui; a
decisão de "o que sai do system" e "o que o cache perde" usa os três ao mesmo tempo
(`src/index.js:4019-4066`). O host entrega só as medidas do cache (`entrada.medidasDoCache`: modelo, chamadas
por mensagem, razão tokens/caractere, última chamada; `src/index.js:4039-4051`).

**O que isto não faz.** Não tira piso, não tira função isolada e não age com os interruptores desligados. Os
números (`x`, `m`…) foram calibrados numa simulação do Igris em 29/10; a spec original dizia 5 e 3
(`src/despejo/config.js:6-7`). Recalibrar para outro host é trabalho do host.

## 11. Índice de capacidades (0.3.0)

Isto vale para quem **declara capacidades semânticas** (`piso: false`) e liga `indiceDeCapacidades`
(desligado por padrão: sem o campo, o prompt é byte a byte o de antes).

**O problema.** Capacidade semântica só entra no turno se o ranking a escolher. Quando o ranking erra, o
modelo não vê a capacidade, não sabe que ela existe e improvisa com outra função parecida. O erro é
silencioso: nada falha, só sai uma resposta pior.

**O que a fábrica faz.** Gera um bloco `<capability_index>` com uma linha por capacidade fora do piso:
`- <id> — <primeira frase da descricao>. Funções: <nome exposto>, <nome exposto>`
(`src/indice-de-capacidades.js`, `renderizarIndiceDeCapacidades`). Os nomes saem de `nomeExposto`, a mesma
regra que o resto da fábrica usa (§5, "Nome exposto"), e respeitam `prefixarTools: false`. As capacidades saem
ordenadas por id, para o texto não mudar de ordem. O cabeçalho do bloco ensina o modelo a carregar o manual
da função pelo nome antes de chamá-la. Ele muda com `cartaoSugerido` (§ opções em `ARCHITECTURE.md` §3):
com `funcoesSugeridas` diz que os cards trazem as funções sugeridas; com `nenhum` não fala de cards.

**Estabilidade na sessão.** O texto é calculado uma vez, na montagem do catálogo, e vai num bloco
`system:stable`, dentro do prefixo do cache. O cabeçalho `completo` **não muda um byte** — qualquer
alteração quebra o cache de quem já o usa. Capacidade que vira piso no meio da sessão (por exemplo,
depois de semear uma habilidade que a exige) continua listada até a próxima montagem: aceitamos a
duplicação, nunca a perda. Custo medido no Igris: cerca de 8 mil caracteres para 33 capacidades. Com poucas
capacidades o custo é pequeno; com muitas, o índice é o preço de a descoberta não depender do ranking.

**Como o host liga.** `indiceDeCapacidades: true`, ou `{ cabecalho, prioridade }`:

- `cabecalho` substitui o texto do formato (o host que quer escrever o dele).
- `prioridade` é a posição no system. O padrão é `prioridadeDasCapacidades - 0.5` (49.5): logo antes do
  bloco de capacidades, para o índice vir antes dos manuais que ele aponta. A prioridade entra na mesma
  validação de empate dos pisos `system:*` que as contribuições do host: se um host tem outra contribuição em
  49.5 e usa `chaves`, a montagem recusa o empate, em vez de estourar no meio da sessão.

**O que isto não faz.** Não carrega capacidade nem manual — só anuncia. Não lista capacidade de piso
(ela já aparece completa em `<capabilities>`). Não decide o que entra no turno: isso continua sendo do
ranking, da carga por chave (§9.1) e do decisor.

**Por que mora na fábrica.** Era do Igris (spec `2026-10-19`) e ficou fora da extração por depender de
coisas do Igris (`ORIGEM.md` D8). Dois hosts querem o mesmo bloco; o texto precisa casar com `nomeExposto`
e com o formato do cartão, que são desta fábrica.


## 12. Corte de função em capacidade já carregada (0.3.0)

Isto vale para quem declara capacidades semânticas (`piso: false`) e liga `corteDeFuncao`. Desligado, o anel
`tool` é o de antes, byte a byte.

**O problema, medido no Igris.** No anel `tool` o Kairos propõe `full` (manual completo no prompt) para toda
função com nota ≥ 0,15, até 3 por capacidade, e o refinador do host nunca rebaixa essa proposta. Numa
sessão real entraram **197 manuais, e 10 foram chamados**. O system é append-only: manual que entra não
sai, então o custo se acumula (spec do Igris `2026-10-24-corte-de-funcao-em-capacidade-carregada-design.md`).
Os dois números de calibração saíram de 4 sessões reais: com cabeça ≥ 0,4 ou destaque z ≥ 2,5 os 10 manuais
úteis ficaram e 157 dos 187 desnecessários saíram.

**O que a fábrica faz.** Embrulha o refinador do anel `tool` (`config.refinadores.tool`, ou a própria
proposta do Kairos quando o host não tem refinador) e aplica o corte DEPOIS dele. O que não passa vira
`candidate`: continua listado no cartão e carregável sob demanda. O embrulho também responde **antes** do prazo
do Kairos: refinador lento, que lança ou que devolve formato inválido não deixa a proposta passar sem corte
(o corte vale então sobre a proposta, só pelo z, sem promoção), e o marcador `fallback:<motivo>` fica no
registro (`src/corte-de-funcao.js`, `embrulharRefinadorDeTool`).

**Regra 1: capacidade já carregada (`corteDeFuncao.carregada`).** Capacidade que já estava no prompt no
início do turno só ganha manual **novo** de função com sinal forte:

| Sinal | Padrão | O que é |
|---|---|---|
| `cabeca` | 0,4 | nota da cabeça local (`explain[ref].notaCabeca`) do refinador do host |
| `z` | 2,5 | destaque da nota `final` do Kairos dentro da capacidade, em desvios-padrão |
| `minFuncoes` | 4 | abaixo disso o z não conta (poucas funções não dão média) |
| `maxPromovidas` | 3 | teto de `candidate → full` por capacidade e por turno, pela nota da cabeça |
| `excluir` | `[]` | ids de capacidade fora da regra |

Passa intacto: a **1ª carga** da capacidade, função `pinned`, função que já tem manual (`hasManual`) e as
capacidades de `excluir`. Promoção (`candidate → full`) só quando o refinador deu nota da cabeça a alguém; sem
nenhuma nota (fallback, ou nenhum refinador) vale só o z e **não promove**.

**A base é o FIM do turno anterior.** "Já carregada" é o `loadedProviders` do estado que o host devolveu
no fim do turno anterior (`estadoAnterior.kairos.loadedProviders`), mais as capacidades `piso: true`
(`carregadasNoInicioDoTurno`). Nunca o estado que o Kairos recebe no turno, porque este já traz as
capacidades promovidas neste turno pelas fontes (§9), pela carga por chave (§9.1) e pelo I3a: uma capacidade
que só está carregada por causa delas é 1ª carga, e cortá-la deixaria o `carregar` sem efeito
(Igris, revisão do conjunto; `src/index.js`, `corteDoTurno`). O piso entra na base porque o turno trivial
não roda o discover e deixa o `loadedProviders` vazio: sem o piso, a mensagem seguinte tratava a capacidade
fixa como 1ª carga e os manuais dela entravam com nota da cabeça perto de zero (sessão `5a5eda4e` do Igris).

**Regra 2: funções semânticas de capacidade do piso (`corteDeFuncao.semanticasDoPiso`).** Para a capacidade
que tem uma parte no piso e outra por relevância (no Igris, a `memoria`: 5 funções fixas e 11 semânticas). O
host diz quais funções são as semânticas: `{ memoria: ['mem_listar', …] }`. Elas só ficam `full` com
`notaBase` ≥ 0,45 (sem nota do refinador, `final` do Kairos ≥ 0,6), e a promoção `candidate → full` acontece
com nota do refinador acima do corte, até 3 por capacidade. A forma de objeto `{ funcoes, campo, corte,
corteKairos }` troca os números: **0,45 e 0,6 foram calibrados com o embedder do Igris** (nas intenções
positivas a nota ficou em 0,329–0,823, nas negativas até 0,438; as zonas se sobrepõem e 0,45 prefere não
carregar à toa). Outro embedder exige medir de novo. A fábrica não conhece nome de capacidade (o Igris
guardava a lista no código dele). Quem usa as duas regras costuma pôr a capacidade das semânticas do piso em
`carregada.excluir`, para as duas não decidirem a mesma função.

**Configuração.** Objeto, não variável de ambiente (a fábrica não lê `process.env`). `ativo: false`, no topo
ou em `carregada`, só REGISTRA as decisões, sem rebaixar nem promover: é como o host mede antes de ligar.
Valor inválido (cabeça fora de 0..1, z ≤ 0, lista que não é lista) **recusa a montagem** com o caminho do
campo — o Igris avisava e ficava no padrão porque lia variável de ambiente.

**O que sai no rastro.** O retorno de `executarTurno` e o `aoMontar` trazem `corteDeFuncao`, a lista das decisões
do turno. Cada uma: `regra` (`carregada` ou `semanticas-do-piso`), `chamada` (o anel `tool` pode ser
refinado mais de uma vez no turno: discover e loop), `ref`, `eraFull`, `passa`, as notas, `ativo` e `promovida`.
Quando o refinador do host falhou, uma linha `{ chamada, refinador: 'fallback:timeout|erro|invalido' }`. O motivo
também fica no `explain` da função: `(corte-carregada)`, `(corte-carregada:promovida)`,
`(corte-semanticas-do-piso)`.

**O que isto não faz.** Não tira manual que já está no prompt (quem garante "carregou, fica" é o acumulado
do prompt-builder, que só tira manual de função que perdeu a permissão). Não mexe em piso. Não substitui o
refinador do host: o corte vale depois dele. Não entra nos anéis `provider`, `skill`, `source` e `conversation`.

**Por que mora na fábrica.** Era do Igris, acoplado a nomes dele (`memoria`, variáveis `IGRIS_CORTE_*`). A
parte que decide, o refinador embrulhado, a base do fim do turno anterior e o registro por chamada dependem
do estado do kairos e do `prepareTurn`, que são da fábrica; o que muda de host para host (as listas e os
números) é parâmetro.

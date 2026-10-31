# Como declarar uma capacidade

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

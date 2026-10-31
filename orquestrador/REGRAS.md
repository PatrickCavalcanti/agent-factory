# Regras de criação de um orquestrador

> **Copiado de `igris@430d2c9`; o texto ainda descreve o Igris como host de referência.** Links para `docs/`, `packages/executor` e `packages/powers` apontam para o GitHub do Igris no sha de origem; ver [`ORIGEM.md`](../ORIGEM.md).

Quem monta um orquestrador com esta fábrica segue estas regras. Quatro delas a
fábrica cobra sozinha (recusa montar); uma quinta é garantida por default
automático do motor, sem recusa nenhuma; as outras dependem de você.

Elas não são preferência de estilo: cada uma existe porque a ausência dela
quebrou um host de verdade. A referência é o pipeline V2 do Ariadne
(`okdev-monorepo/packages/ariadne/docs/pendencias/2026-09-12-pipeline-v2-catalogo-mudo-e-fila-da-frente.md`).

## O que a fábrica cobra sozinha (recusa montar)

### 1. Capacidade semântica sem embedder — cobrado

`piso: false` significa "disputa ranking", e o ranking precisa de um embedder
para pontuar um documento contra a pergunta. Sem ele, `montarCatalogo` recusa
a montagem — e essa guarda vem ANTES da guarda de `semanticText` abaixo
(`src/index.js`; a ordem é testada em `test/travas.test.js`, "a guarda do
embedder continua vindo ANTES da de semanticText").

### 2. Capacidade semântica declara `semanticText` — cobrado

O ranking pontua um documento de embedding, e sem `semanticText` esse
documento é a `descricao` — texto escrito para o modelo LER, não para casar
com a pergunta do usuário. `montarCatalogo` recusa a montagem e nomeia a(s)
capacidade(s) sem o campo (`src/index.js` — guarda logo depois da checagem de
embedder).

Declare também `awareness.useWhen`. ⚠️ **`skipWhen` atrai o que pretende
excluir** — bag-of-words não entende negação. Descreva o que fica de fora pelo
caminho certo ("isso vai por pipeline"), nunca repetindo o vocabulário do
vizinho (`src/capacidades.js`, typedef `CapacidadeDeclarada`).

### 3. Contribuição de piso declara `floor: true` — cobrado

Contribuição passada por `config.contribuicoes` sem `floor: true` (seja
`false`, seja a chave ausente — o esquecimento é mais provável do que escrever
`floor: false` de propósito) nunca renderiza: `discover()` do kairos só busca
contribuição por `registry.listFloorsByProvider()`, que filtra `c.floor` por
TRUTHINESS (`filter(c => c.floor)`), não por `=== true` — para `false` e para
a chave ausente isso não muda nada, mas `floor: 1` ou `floor: "sim"`
renderizariam lá. A fábrica exige exatamente `true`, mais estrita que o
kairos de propósito: um `floor` truthy que não é `true` cheira a bug de
digitação, não a intenção declarada. Provado por probe antes desta trava
existir: uma contribuição sem `floor: true` montava sem recusa, `read()` era
chamado zero vezes, o conteúdo não aparecia no prompt, e o turno completava
normalmente — não erra, não avisa, não funciona. `montarCatalogo` recusa a
montagem e nomeia o `ref` (`src/index.js`); a guarda vem ANTES da guarda de
`volatil` abaixo, para que uma contribuição sem os dois campos receba a
mensagem certa (sobre `floor`, a causa raiz — não sobre `volatil`, que falaria
de recalcular um conteúdo que nunca chegaria a renderizar de qualquer forma).

### 4. Contribuição de piso declara `volatil` — cobrado

`true` se o `read(ctx)` muda dentro da conversa, `false` se não muda. Declarar
`false` é resposta; silêncio não é — `montarCatalogo` recusa a montagem e
nomeia o `ref` que falta (`src/index.js`). Quando o discover é pulado por texto
trivial, só o volátil é recalculado — o resto é reexibido como estava
(`refsVolateisDeclaradas`, unida com `config.refsVolateis` no ponto de uso).

Os dois lados da promessa têm teste de regressão pelo MECANISMO NOVO
(`refsVolateisDeclaradas`, sem depender de `config.refsVolateis` na config —
ver `test/reconstrucao-unchanged.test.js`): uma contribuição `volatil: true` é
recalculada quando o discover volta `unchanged`; uma `volatil: false` é
reexibida como estava, mesmo que o `read(ctx)` de fato tivesse produzido um
valor novo. Pode confiar nos dois sentidos, não só no de recalcular.

## Outras garantias do motor (não são recusa)

### Legenda do catálogo tem default

Você não precisa passar `legendas`. O motor mescla `LEGENDAS_PADRAO` com o que
você passar **por chave** (`src/prompt-builder.js`) — cada seção (`indice`,
`contratos`, `candidatos`) tem seu próprio fallback, não um `{ ...default,
...seu }` de objeto inteiro. Isto não é uma recusa de montagem: é um default
automático, sempre presente.

⚠️ O fallback é por valor falsy (`config.legendas?.indice || PADRAO.indice`),
não por presença de chave. Consequência deliberada: **não há como suprimir uma
legenda passando string vazia** — `{ indice: '' }` cai de volta no default, não
apaga a seção. Isso foi corrigido depois de um review pegar que um spread por
objeto deixaria exatamente essa configuração voltar a produzir catálogo mudo.
Se você não quer a redação do motor, passe a sua — vazio não é uma opção
válida.

## O que depende de você

### 5. Não nomeie tool no prompt base

O prompt base está sempre presente; a capacidade dela, não. Nomear a função ali
faz o modelo chamá-la nos turnos em que o roteamento não a carregou.

**Isto não é cobrado pela fábrica** — depende do autor do orquestrador, não do
motor. A checagem mecânica ("nenhum nome literal de tool no prompt base") ficou
de fora de propósito: ela precisaria de exceção para **catálogo fechado** —
quando TODAS as capacidades declaram `piso: true` (tudo `pinned`, sempre
presente desde o primeiro turno, sem depender de ranking nenhum;
`perfis/agente-llm.js` é o caso real), nomear a tool no prompt é seguro e
desejado, porque a tool nunca deixa de estar lá. **O que torna isso seguro é
`piso: true`, não `prefixarTools: false`** — este último só decide QUAL NOME é
exposto (o cru ou o prefixado pelo id da capacidade), nunca SE a tool está
carregada. Lido ao pé da letra como "ponha `prefixarTools: false` e pode
nomear tool no prompt", o critério erraria numa capacidade `piso: false`
(disputa ranking, pode não carregar) — que é exatamente o bug do Ariadne. A
checagem mecânica também poderia dar falso positivo nos dois perfis atuais do
Igris — expectativa, não fato verificado aqui: os dois tomam o prompt base de
fora do pacote (`agent.system_prompt` do banco, `systemPrompt` do
`loadPrompt`), e nada visível neste pacote determina se eles nomeiam tool ali.

⚠️ **Teste que valida a compensação consolida a compensação.** A V2 do Ariadne
tem um teste afirmando que cada ref citada no prompt existe de verdade — ele
tranca o vazamento em vez de removê-lo. Antes de escrever teste sobre um nome
literal no prompt, pergunte por que o nome está lá.

### 6. Antes de mover informação para compensar um sintoma, confirme o canal

A regra que atravessa toda a pendência do Ariadne, onde o padrão se repetiu
**seis vezes**: *o conserto de um defeito criou as condições do seguinte, e o
seguinte se parecia com o anterior*. Tool inventada por falta do nome → o nome
foi injetado no prompt → a injeção mascarou a descoberta quebrada.

O evento `fabrica:catalogo-mudo` (item 7) existe para responder essa pergunta
sem investigação.

### 7. Escute `fabrica:catalogo-mudo`

A fábrica emite (`config.aoEvento`, `src/index.js`) quando o ranking rodou,
havia capacidade semântica não carregada, e nenhum candidato foi oferecido.
Ligue no log do host.

⚠️ **Não dispara em todo turno silencioso.** Quando o discover volta
`unchanged` (texto trivial — "ok", "obrigado"), a descoberta é pulada de
propósito e não há candidato nenhum a oferecer; isso é o comportamento
correto, não o defeito. O evento só olha os turnos em que a descoberta de fato
rodou. Quem ligar o evento e testar mandando "ok" vai ver silêncio — é
esperado, não um sinal de que o evento está quebrado.

### 8. Não monte a config à mão — escreva um perfil

Esta é a regra que previne as outras sete, e é a que a V2 do Ariadne não tinha.

Um perfil é uma função pura que traduz o vocabulário do host (um manifesto, uma
linha de banco) na config da fábrica. O host chama `perfilX(entrada)`; ele nunca
escreve a config literal. Referências: `src/perfis/shadow-loop.js` (manifesto) e
`src/perfis/agente-llm.js` (linha de banco).

Quando o host monta a config à mão, o segundo orquestrador é uma cópia do
primeiro com botões faltando — foi assim que a V2 herdou o mecanismo e não
herdou `legendas`, `refsVolateis`, `conversa`, `can` e `rotulo`.

### 9. Pine o mínimo de uma capacidade semântica

Uma capacidade `piso: false` disputa ranking, e quando ela ganha, **as funções
básicas dela precisam já vir com contrato**. Marque-as `fixa: true`
(`ToolDeclarada`).

Regra do usuário, literal: *"tools mínimas dentro de uma capacidade devem ser
fixas, também devem ser pinadas, porque se eles semanticamente aderiram a outra
parte daquela capacidade, possivelmente as básicas ele vai precisar também."*

`fixa` governa só `pinned` na tool; `loading.always` do provider continua saindo
de `piso`. Default: herda o `piso` da capacidade, então quem não declara nada
mantém o comportamento anterior.

⚠️ **A assimetria é deliberada.** `fixa: true` em capacidade SEMÂNTICA é o caso
de uso. `fixa: false` em capacidade PISO é permitido pelo tipo e **perigoso**: o
provider é `always`, o índice anuncia o nome sempre, mas o contrato só hidrata se
o score individual trouxer — o modelo vê o nome e chama sem o manual. É a
anatomia do defeito medido no pipeline V2 do Ariadne (`projeto/tool/ler` com
`args: {}`). **A seletividade correta é no nível da CAPACIDADE.**

Detalhe de campo a campo: [`CAPACIDADES.md`](./CAPACIDADES.md).

---

## Outras garantias do motor, acrescentadas depois

Nenhuma destas é recusa de montagem — são mecanismo, sempre ligado.

### O contrato de tool traz os argumentos, sempre

`tool.contract` do host é o PARÁGRAFO de cima; os argumentos entram sempre,
renderizados de `inputSchema` por `contrato.js` (`- \`campo*\`: tipo — descrição`,
com objeto aninhado indentado). O host não tem como entregar função sem
assinatura — que era o defeito da V2 (`Campos obrigatórios: path.`, sem tipo e
sem significado).

### Legenda do BLOCO de capacidades

Além das três de seção (`indice`/`contratos`/`candidatos`), há a do bloco:
explica que aquilo são funções chamáveis e como carregar as que ainda não têm
manual. Default automático, mesma mescla por chave.

### Guarda de contrato: tool sem manual no prompt é recusada

`recusaSemManual` (`index.js`) troca o handler de qualquer tool de capacidade
cujo manual **não está no prompt acumulado**. Não lança: devolve texto nomeando
`load_capability`, para o modelo se corrigir no mesmo turno.

Três detalhes que são o desenho, não acaso:

- Vive em `registryDoTurno`, **não** em `decorarTool` — aquele é o gancho do
  consumidor. Por dentro, a decoração do host envolve o guarda, enxerga a
  chamada e recebe a recusa como resultado.
- Lê do **acumulado** (`acumulacao.system.capacidades[].funcoes[]` com `manual`),
  não de `discoverResult.tools.hydrate`: uma tool hidratada três turnos atrás
  continua no prompt e tem de ser permitida.
- **Meta-tools nunca são guardadas** — a saída de emergência não pode ser
  bloqueada por ela mesma.

⚠️ **Card, legenda e guarda são um mecanismo só.** O card dá o NOME da função, a
legenda diz o que fazer com ele, o guarda cobra se o passo for pulado. Já quebrou
uma vez: o card ganhou os nomes e a legenda continuou mandando "diga o que quer
fazer em vez de inventar um nome de função" — instruindo a ignorar o que estava
impresso logo abaixo. **Mudou um, confira os três.**

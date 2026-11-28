# Guia do Igris: de `0.1.x` para `0.3.0`

Este guia diz ao Igris o que apagar da cola dele, o que configurar no lugar e o que muda no comportamento ao
subir de `@okds/agent-factory` `0.1.1` para `0.3.0`. O Igris é dono da execução (plano próprio lá); este
documento é o insumo. O que não foi possível confirmar está marcado **(conferir)**.

O guia anterior (`0.1.0`, a primeira troca da fábrica própria pela biblioteca: subpaths, parâmetros
`prefixoDoEnvelope`, `criarProvedorDeCliente`, trava M-1 etc.) já foi executado: o Igris está na `0.1.1`
(`pnpm-workspace.yaml:67` e `:87` do Igris). Ele continua no histórico: `git show 4bfbc9e:MIGRACAO-IGRIS.md`.

Legenda de caminhos: `packages/…` é do Igris, relativo a `E:\Projetos\Igris`; os da fábrica (`orquestrador/`,
`decisoes/`, `apoio/`) são relativos a este repositório. A cola do Igris fica em
`packages/executor/src/orchestration/fabrica/`, abreviada aqui como `fabrica/` quando o contexto é do Igris.

## 0. O que mudou em uma frase

- **Nada muda sem os campos novos.** Host que só sobe a versão roda o mesmo turno da `0.2.5` (a `0.2.x` é opt-in
  por campo, com as exceções da §4).
- A `0.3.0` traz para a fábrica cinco peças que o Igris tinha coladas, mais três que o Ariadne pediu. O Igris
  **apaga** as cinco dele e **configura** os campos da fábrica no lugar.

| Peça | Estava em | Passa a ser |
|---|---|---|
| Índice de capacidades | `fabrica/indice-de-capacidades.js` | campo `indiceDeCapacidades` |
| Corte de função | `fabrica/corte-de-funcao.js` | campo `corteDeFuncao` |
| Refinadores do turno (Jev por anel) | `fabrica/refinadores.js` | subpath `@okds/agent-factory/decisoes/refinadores-do-turno` |
| Seleção local (decisor local por anel) | `fabrica/selecao.js` | subpath `@okds/agent-factory/decisoes/selecao` |
| Formato do cartão sugerido | `fabrica/cartao-sugerido.js` | campo `cartaoSugerido` (a fábrica tem a cópia dela; ver §1.5) |
| Carga por chave, teto do system, registro de casos | não existiam no Igris | campos novos, opt-in (§3) |

## 1. O que o Igris apaga, e o que entra no lugar

### 1.1 Índice de capacidades

**Apagar:** `fabrica/indice-de-capacidades.js` (77 linhas) e o teste `packages/executor/test/fabrica-indice-de-capacidades.test.js`.
**Usos:** `fabrica/turno.js:28` (import) e `fabrica/turno.js:2105` (`contribuicaoDoIndiceDeCapacidades(capacidades)`
dentro de `contribuicoes`).

**No lugar:** tirar a linha de `turno.js:2105` e passar o campo na config do orquestrador (hoje montada em
`fabrica/perfil.js`, por volta de `:336`):

```js
indiceDeCapacidades: { prioridade: PRIORIDADE_DAS_CAPACIDADES - 10 }, // 490, como o Igris tinha (fabrica/indice-de-capacidades.js:13)
```

- **Passe `prioridade`.** O padrão da fábrica é `prioridadeDasCapacidades - 0.5` (`orquestrador/src/index.js`,
  `contribuicaoDoIndice`); com `prioridadeDasCapacidades: 500` (`fabrica/perfil.js:350`) ficaria em 499,5, colado
  nas capacidades, e não em 490. O índice entra na mesma validação de empate de prioridade dos pisos.
- O cabeçalho do índice segue `cartaoSugerido` (§1.5), com os mesmos três textos do Igris
  (`completo`, `funcoesSugeridas`, `nenhum`; a fábrica copiou os bytes).
- A recusa **R9** vale: com `indiceDeCapacidades` ligado e nenhuma capacidade `piso: false` com função, a
  montagem falha. No Igris isso não ocorre (há capacidades semânticas), mas um teste do Igris que monte um catálogo
  só de piso e ligue o campo vai falhar: é a recusa funcionando.

**O que muda no texto (ver §4):** a linha usa só a **1ª frase** da `descricao`; `ref`/`kind`/`volatil` mudam.

### 1.2 Corte de função

**Apagar:** `fabrica/corte-de-funcao.js` (336 linhas) e os testes `fabrica-corte-carregada.test.js` e
`fabrica-corte-memoria.test.js`.
**Usos:** `fabrica/turno.js:90` (import), `:1900` (`carregadasNoInicioDoTurno`, guarda a base por sessão) e
`:2151` (o embrulho manual do refinador do anel `tool`, dentro de `refinadores`).

**No lugar:** a fábrica embrulha sozinha o refinador do anel `tool` (`config.refinadores.tool`) e calcula a base
"já carregada" (`loadedProviders` do fim do turno anterior + piso). Então:

1. Em `turno.js:2146-2151`, o ramo `anel === 'tool'` deixa de embrulhar: devolve o refinador cru como os outros anéis.
2. `turno.js:1900` e o `sessao.turnoAtual.carregadasNoInicio` saem.
3. Na config do orquestrador entra o campo, lido do ambiente **pelo Igris** (§2) e entregue em objeto:

```js
corteDeFuncao: {
  ativo: !desligado(env.IGRIS_CORTE_MEMORIA),            // top-level = regra das semânticas do piso
  semanticasDoPiso: {
    memoria: {
      funcoes: FUNCOES_SEMANTICAS_DO_PISO.memoria,       // fabrica/capacidades-do-piso.js (fica no Igris); cada nome
                                                         // tem de existir em capacidades.memoria.tools (a R11 recusa
                                                         // função inexistente) — as 11 de hoje existem (conferido 2026-11-27)
      campo, corte, corteKairos,                         // IGRIS_CORTE_MEMORIA_CAMPO / _NOTA / _KAIROS; omitir = padrão
    },
  },
  carregada: {
    ativo: !desligado(env.IGRIS_CORTE_CARREGADA),        // `carregada.ativo` = regra da capacidade já carregada
    cabeca, z,                                           // IGRIS_CORTE_CARREGADA_CABECA / _Z; omitir = padrão
    excluir: ['memoria'],                                // EXPLÍCITO, ver abaixo
  },
},
```

- **`excluir: ['memoria']` é obrigatório no Igris.** O Igris tinha `excluir: ['memoria']` gravado
  (`fabrica/corte-de-funcao.js:58`); a fábrica **não exclui nada por padrão** (`CORTE_CARREGADA_PADRAO.excluir = []`,
  `orquestrador/src/corte-de-funcao.js`): ela não conhece nome de capacidade. Sem isto, as duas regras decidiriam a
  mesma função da `memoria`.
- **`semanticasDoPiso.memoria` também é explícito.** A lista de funções vinha de `FUNCOES_SEMANTICAS_DO_PISO` e
  fica no Igris. Os padrões `notaBase`, 0,45 e 0,6 são os mesmos do Igris (calibrados com o embedder dele).
- **A regra `carregada` precisa ser declarada.** No Igris ela estava sempre ligada; na fábrica, `carregada` ausente
  é regra desligada. Passe o objeto acima (ou `true`).
- **`ativo` tem dois níveis, como no Igris:** o de cima só afeta `semanticasDoPiso` (era `IGRIS_CORTE_MEMORIA`); o de
  `carregada` afeta só a regra da capacidade carregada (era `IGRIS_CORTE_CARREGADA`). `ativo: false` só registra.
- **Valor inválido recusa a montagem (R11).** O Igris avisava e ficava no padrão porque lia env. Para manter a
  tolerância, o Igris valida o env ao ler (§2) e **omite** o campo inválido; o que chegar errado na fábrica derruba a
  montagem. A R11 também recusa o campo **vazio** e capacidade/função que não existem em `capacidades`.
- **Corte `0` explícito é aceito** (o Igris aceitava, `fabrica/corte-de-funcao.js:76`: `v >= 0 && v <= 1`).
- **O rastro muda de lugar.** O Igris gravava as decisões em `sessao.turnoAtual.selecaoLocal.corteDeFuncao`
  (`turno.js:2150`) e elas iam ao `fabrica.json`. Agora saem no retorno de `executarTurno` e no `aoMontar`
  (campo `corteDeFuncao`): o Igris copia para o mesmo lugar do artefato, senão o `fabrica.json` perde o campo.

### 1.3 Refinadores do turno (Jev por anel)

**Apagar:** `fabrica/refinadores.js` (459 linhas) e `packages/executor/test/fabrica-refino.test.js`.
**Usos:** `fabrica/turno.js:94` (import), `:1642` (`refinadoresDoTurno({...})`), `:2125` (`refino: configDeRefino()`),
`:2988` (`comTardias`), `fabrica/selecao.js:23` e `:571` (`configDeRefino()` como padrão de parâmetro).

**No lugar:** import de `@okds/agent-factory/decisoes/refinadores-do-turno` (`refinadoresDoTurno`,
`normalizarRefino`, `REFINO_PADRAO`, `comTardias`). A assinatura é a mesma, **mas o objeto de refino deixa de vir do
ambiente por baixo do pano:**

```js
const refino = normalizarRefino(lerJson(env.IGRIS_CHAT_FABRICA_REFINO)); // era configDeRefino(env)
refinadoresDoTurno({ cliente, config: refino, aoChegarTarde, funcoesDe, capacidadesDePiso, conversaDoHost, consultasAnterioresDoHost, aoChamarJev });
criarOrquestrador({ ..., refino });                                      // era refino: configDeRefino()
```

- **Armadilha: passe o MESMO objeto em três lugares.** No Igris, `refinadoresDoTurno` e `selecaoLocal.refinadores`
  tinham `config = configDeRefino()` / `refino = configDeRefino()` como valor padrão de parâmetro, e por isso liam o
  env sozinhos (`fabrica/refinadores.js:389`, `fabrica/selecao.js:571`). Na fábrica o padrão é
  `normalizarRefino()` (sem env, `decisoes/src/refinadores/turno.js:372`, `decisoes/src/local/selecao.js:589`):
  quem não passar o objeto roda com os orçamentos padrão e o override do dono some **sem erro**. Os três pontos:
  `refinadoresDoTurno({ config })`, `sessao.selecaoLocal.refinadores({ refino })` (`turno.js:1650`) e `refino` na
  config do orquestrador (`turno.js:2125`).
- `normalizarRefino` recebe o **objeto** (o `JSON.parse` é do Igris) e nunca lança: valor inválido avisa e fica no padrão.

### 1.4 Seleção local (decisor local)

**Apagar:** `fabrica/selecao.js` (643 linhas) e `packages/executor/test/fabrica-selecao.test.js`.
**Usos:** `fabrica/turno.js:96`, `:1648` (`criarSelecaoLocal`), `:2637` e `:2997` (`serializarSelecao`);
`fabrica/perfil.js:66`, `:87` e `:268` (`configDaSelecao`, `registrarCatalogoSemantico`);
`fabrica/treino-continuo.js:18` (`indiceEmUso`, `invalidarSelecaoLocal`); `packages/executor/src/index.js:19`
(reexporta `invalidarSelecaoLocal`); `packages/executor/test/fabrica-aquecimento.test.js:127`.

**No lugar:** import de `@okds/agent-factory/decisoes/selecao`. Três mudanças de assinatura (sem env, sem Igris):

```js
// turno.js:1648
sessao.selecaoLocal = criarSelecaoLocal({
  dataDir: configIgris.dataDir,
  config: configDaSelecao(lerJson(env.IGRIS_CHAT_FABRICA_SELECAO), { slug, limiaresDoModelo }),
  limiaresDoModelo,   // (slug) => ({ decisorBase: { full, candidate } }); no Igris, `limiaresDoModelo` de '@igris/embeddings/limiares'
  embedder,           // { modelSlug } ou () => embedder; no Igris, getEmbedderDoKairos
});
// perfil.js:87
configDaSelecao(lerJson(env.IGRIS_CHAT_FABRICA_SELECAO)).tetos.kairosTools ?? Number.MAX_SAFE_INTEGER
```

- `configDaSelecao(obj, { slug, limiaresDoModelo })` recebe objeto (era `configDaSelecao(env)`). `undefined` = padrão
  sem aviso; o que não é objeto simples avisa uma vez. `slug` é função (`() => getEmbedderDoKairos()?.modelSlug ?? null`,
  o `slugAtivo` de `fabrica/selecao.js:178`).
- **Armadilha: sem `limiaresDoModelo` os cortes da base voltam ao valor fixo do e5** e a origem do corte vira `fixo`
  (`decisoes/src/local/selecao.js`, `comBaseDoModelo`). No Igris a base vinha da linha do modelo ativo
  (`fabrica/selecao.js:172`); se o Igris esquecer de passar `limiaresDoModelo`, o decisor local passa a cortar com o número
  do e5 em qualquer embedder, sem erro. Confira `cortesOrigem.base` no `fabrica.json`: tem de ser `modelo` (ou `override`).
- O Igris importava `limiaresDoModelo` de `@igris/embeddings/limiares` e `getEmbedderDoKairos` de
  `@igris/semantic-context` dentro de `fabrica/selecao.js:21-22`. Esses dois imports **somem com o arquivo**: o Igris
  os entrega por parâmetro. O slug padrão (`fabrica/selecao.js:178`, `getEmbedderDoKairos()?.modelSlug`) passa a ser o
  `embedder` que o Igris dá.
- As funções de estado por `dataDir` mantêm os nomes (`registrarCatalogoSemantico`, `indiceEmUso`,
  `invalidarSelecaoLocal`, `serializarSelecao`, `registrarDecisao`, `registrarPromovidasNoTurno`); só troca o import.
- `_limparSelecaoParaTestes` e `_memoDeDerivacoesParaTestes` seguem exportadas, só para teste.

### 1.5 Cartão sugerido

**O arquivo `fabrica/cartao-sugerido.js` não pode ser apagado inteiro.** Ele faz duas coisas: (a) a lista de formatos
e o texto do índice, que a fábrica já tem; (b) ler `IGRIS_CHAT_FABRICA_CARTAO` e **decidir o padrão do Igris**,
`funcoesSugeridas` (`fabrica/cartao-sugerido.js:7`). A fábrica tem padrão **`completo`** (`formatoDoCartao`,
`orquestrador/src/cartao-sugerido.js:11`) e **lança** com valor inválido. Sem (b), o Igris voltaria ao cartão
completo em silêncio.

**Reduzir** o arquivo ao leitor de ambiente (as ~10 linhas de `cartaoSugeridoDoAmbiente`, com o padrão
`funcoesSugeridas` e o aviso por valor inválido) e **apagar** o resto. `fabrica/perfil.js:301` e `:336` continuam
passando `cartaoSugerido`. A fábrica não exporta o módulo de cartão em subpath: o Igris mantém a própria lista de
três valores. Com o índice indo para a fábrica (§1.1), o import de `cartao-sugerido.js` em `indice-de-capacidades.js`
some junto com aquele arquivo.

## 2. O que o Igris passa a ler e entregar em objeto

A fábrica não lê `process.env` (`test/pureza.test.js` trava isso). Tudo que o Igris controlava por env continua sendo
**lido pelo Igris**, uma vez, e **entregue em objeto**:

| Env var do Igris | Hoje lida em | Vira | Entregue a |
|---|---|---|---|
| `IGRIS_CORTE_MEMORIA` | `fabrica/corte-de-funcao.js:69` | `corteDeFuncao.ativo` | `criarOrquestrador` |
| `IGRIS_CORTE_MEMORIA_NOTA` / `_CAMPO` / `_KAIROS` | `corte-de-funcao.js:94-96` | `corteDeFuncao.semanticasDoPiso.memoria.{corte,campo,corteKairos}` | idem |
| `IGRIS_CORTE_CARREGADA` | `corte-de-funcao.js:101` | `corteDeFuncao.carregada.ativo` | idem |
| `IGRIS_CORTE_CARREGADA_CABECA` / `_Z` | `corte-de-funcao.js:102-103` | `corteDeFuncao.carregada.{cabeca,z}` | idem |
| `IGRIS_CHAT_FABRICA_REFINO` (JSON) | `fabrica/refinadores.js:199` | `normalizarRefino(obj)` | `refinadoresDoTurno`, `selecaoLocal.refinadores`, `refino` |
| `IGRIS_CHAT_FABRICA_SELECAO` (JSON) | `fabrica/selecao.js` (`configDaSelecao(env)`) | `configDaSelecao(obj, {...})` | `criarSelecaoLocal`, `perfil.js:87` |
| `IGRIS_CHAT_FABRICA_CARTAO` | `fabrica/cartao-sugerido.js` | `cartaoSugerido` | `criarOrquestrador` |

- O Igris faz o `JSON.parse` e a leitura de vírgula decimal (`0,45`) que o `cortesDoAmbiente` fazia. A fábrica só
  recebe número.
- **Tolerância a valor inválido é do Igris.** `normalizarCorte` lança; o Igris, ao montar o objeto, avisa e deixa o
  campo de fora (o mesmo contrato de antes). `normalizarRefino` e `configDaSelecao` já avisam e voltam ao padrão.
- `IGRIS_CHAT_FABRICA_DECISOR` (liga/desliga o decisor) continua do Igris: é o `ativo` que ele passa a
  `selecaoLocal.refinadores({ ativo })` e a condição para montar `refinadores` na config (`turno.js:2054`).
- As outras envs `IGRIS_CHAT_FABRICA_*` (`DESPEJO`, `LOOP`, `TREINO`, `POWERS`, `LIMIARES`, `FILLER`, `CALIBRACAO*`) não
  mudam: nenhuma das cinco peças acima as lia.

## 3. Campos novos que o Igris pode ligar (opt-in, não substituem cola)

Estes não têm cópia no Igris; ligar é decisão do Igris (nenhum é necessário para a troca da §1):

- `tetoDoSystem: { chars }`: aviso quando o system passa do teto (`renderErrors` + `aoEvento({ tipo: 'fabrica:teto-do-system' })`).
  O Igris mediu 386 mil caracteres numa sessão. `chars` precisa ser inteiro maior que 0 (recusa de montagem).
- `aoRegistrarCaso` / `dadosDoCaso`: monta o caso de treino no fecho do turno. O Igris grava hoje em
  `fabrica/treino-continuo.js`; dá para trocar a montagem pela da fábrica e manter a gravação dele.
- `cargaPorChave` + `chaves` + `catalogoDeChaves` (0.3.0 e 0.2.5): o Igris não usa chaves de trabalho hoje.

## 4. O que muda no comportamento

1. **Linha do índice: só a 1ª frase da `descricao`.** O Igris punha a descrição inteira
   (`fabrica/indice-de-capacidades.js:58-59`); a fábrica corta na primeira frase (`orquestrador/src/indice-de-capacidades.js`,
   `renderizarIndiceDeCapacidades`). O bloco do system muda de bytes **uma vez** e o prefixo de cache esfria na
   virada. O índice fica menor (o Igris mediu ~8 mil caracteres para 33 capacidades, spec `2026-10-19`).
2. **A contribuição do índice muda de identidade.** Igris: `ref: 'executor/stable/capability-index'`, `kind: 'context'`,
   `volatil: true` (`fabrica/indice-de-capacidades.js:68-73`). Fábrica: `ref: 'orquestrador/stable/capability-index'`,
   `kind: 'knowledge'`, `volatil: false`. Procure no Igris quem cita `capability-index` (rastro, `refsVolateis`,
   despejo): **(conferir)**. O texto do índice é constante, então reler ou não em turno trivial não muda o que o
   modelo vê; a diferença só aparece com `separarSystemVolatil` ligado (o Igris não liga na `0.1.x`): o índice
   passa a ficar no bloco estável, dentro do prefixo do cache.
3. **Evento do teto usa `.tipo`**, não `.type`: `aoEvento({ tipo: 'fabrica:teto-do-system', turno, tamanho, teto })`
   (a convenção dos diagnósticos da fábrica, ao lado de `fabrica:catalogo-mudo`). `.type` é dos eventos do genos.
4. **`normalizarCorte` lança** em vez de avisar (§1.2). Quem chama é a montagem: erro de config derruba o turno 1,
   não passa em silêncio.
5. **Recusas novas** (só para quem liga o campo): R9 (índice sem capacidade fora do piso), R10 (carga por chave
   inválida, inclusive sem `chaves`), R11 (corte inválido, vazio, capacidade/função inexistente) e `tetoDoSystem`
   inválido. Texto em `orquestrador/REGRAS.md`.
6. **`aoChamada` (`fase: 'fim'`): `ok: false` agora também vale para recusa devolvida sem lançar** (0.2.1). O Igris lê
   `c.ok === false` como "falhou" em `fabrica/turno.js:2235`; recusa devolvida passa a contar como falha lá. O campo
   aditivo `desfecho` (`'concluiu'` | `'recusa'` | `'lancou'`) distingue. **(conferir)** se o card e o registro do
   Igris devem tratar `recusa` como `lancou`.
7. **Função recusada deixa de contar como "usada"** no registro de uso do despejo (0.2.1: `usosDoTurno` ignora
   `!op.ok`) e `consultasDoTurnoDe` (apoio) devolve `ok: false` para consulta recusada. O contexto fixo do despejo
   pode mudar levemente em sessões com recusas.
8. **`mensagemDeToolDesconhecida(toolName, nomesDoCatalogo?)`** (0.2.3) tem texto novo: função do catálogo que ficou sem
   manual manda carregar com `load_capability`; nome com `__` fora do catálogo diz que não existe. O Igris usa
   `isUnknownToolError`/`unknownToolNeutralMessage` próprios (`fabrica/turno.js:2242`): conferir se algum teste
   compara o texto da fábrica **(conferir)**.
9. **`falhaDoResultado` lê mais formas de motivo** (0.2.1: `erro`, `mensagem`, `message`, `motivo`, `code`, retorno
   MCP `isError`); o motivo vai cortado em 300 caracteres para o bloco `<turn_operations>` e o histórico.

O que **não** muda para o Igris: `mecanicaNoCatalogo` (0.2.0), `separarSystemVolatil` (0.2.2), o atalho do catálogo no
protocolo nativo (0.2.3) e a contribuição por chave (0.2.5) são opt-in ou do protocolo `nativo`; o Igris usa
`envelope`. O `cartaoSugerido` e o uso declarado já estão no Igris pela `0.1.1`.

## 5. Versões que o Igris nunca rodou

O Igris está na `0.1.1` (`pnpm-workspace.yaml:67`). A `v0.1.1` é um ramo à parte (`release/0.1.x`) e **não é ancestral
de `main`**, então `git log v0.1.1..HEAD` lista também os 4 commits que a `0.1.1` e a `0.2.4` têm em duplicata
(cherry-picks, com hashes diferentes): `3b7eedf`≡`1365060` (formatos do cartão), `e509601`≡`fa1a2db` (opção
`cartaoSugerido`), `71d9541`≡`83c5dc9` (consulta do Jev declarada), `49fb331`≡`50d6044` (turno cancelado não promove).
Esses o Igris já roda. O resto (`git log v0.1.1..HEAD --oneline`):

| Versão | Data | O que muda | Afeta o Igris? |
|---|---|---|---|
| `0.2.0` | 2026-11-01 | `mecanicaNoCatalogo` (opt-in): mecânica de chamada no bloco de capacidades, só no layout `agrupado`. Porte do Ariadne `fc2457a8`. | Não (desligado) |
| `0.2.1` | 2026-11-03 | Registro de operações marca falha a recusa devolvida sem lançar; `falhaDoResultado` lê mais formas; `aoChamada` ganha `desfecho`; ajuste da linha do kairos no `load_capability` por protocolo. | **Sim**: §4 itens 6, 7 e 9 |
| `0.2.2` | 2026-11-04 | `separarSystemVolatil` (opt-in): system em duas mensagens (`sys` / `sys-volatil`) para o cache entre jobs. | Não (desligado) |
| `0.2.3` | 2026-11-16 | Atalho do catálogo no protocolo nativo; `mensagemDeToolDesconhecida` com 2º argumento e texto novo. | Só o texto (§4 item 8) |
| `0.2.4` | 2026-11-25 | Leva a `0.1.1` (cartão sugerido, uso declarado) à linha `0.2.x`. | Não: já roda pela `0.1.1` |
| `0.2.5` | 2026-11-27 | Contribuição por chave (`chaves`, `catalogoDeChaves`, `semanticaSemChave`, `limiaresDeConversa`). | Não (opt-in) |
| `0.3.0` | 2026-11-27 | Índice, carga por chave, corte de função, fiação do decisor e da seleção local, teto do system, registro de casos. | **Sim**: este guia |

Detalhe de cada versão em `CHANGELOG.md`. Os commits de documentação (`e599c8b`, `042d8ad`, `a505950`) não mudam código.

## 6. Como subir a versão no Igris

1. No `pnpm-workspace.yaml` do Igris há **duas linhas** do `@okds/agent-factory`: a do `catalog:` (`#semver:^0.1.1`,
   `:67`) e a de `overrides:` (commit fixado, `:87`). **O `overrides` vence o catálogo**: subir só o catálogo não tem
   efeito. Troque as duas: catálogo para `#semver:^0.3.0` e o `overrides` pelo commit da tag `v0.3.0`
   (`git rev-parse v0.3.0` neste repositório, depois que a tag existir), com o comentário `# 0.3.0`.
2. Em `0.x` o `^` não atravessa minor: `^0.1.1` não alcança `0.3.0`, daí a troca explícita.
3. `peerDependencies` não mudaram (`@okds/kairos` `>=0.840.261021 <0.842.0`, `genos-orchestrator` `^0.3.12`): o Igris
   (kairos `^0.840.261021`, genos `0.3.14`) já atende.
4. `pnpm install` e conferir uma cópia só de `genos-orchestrator` e de `@okds/kairos`.
5. Aplicar a §1 peça por peça (índice, corte, refinadores, seleção, cartão), **um commit por peça**, com a bancada
   verde entre elas (§7).

## 7. Como conferir na bancada do Igris

**Testes do Igris que deixam de existir** (a cola foi apagada; o teste do mecanismo mudou para cá):

| Teste do Igris (`packages/executor/test/`) | Passa a ser, nesta fábrica |
|---|---|
| `fabrica-indice-de-capacidades.test.js` | `orquestrador/test/indice-de-capacidades.test.js` |
| `fabrica-corte-carregada.test.js` | `orquestrador/test/corte-de-funcao.test.js` |
| `fabrica-corte-memoria.test.js` | `orquestrador/test/corte-de-funcao.test.js` |
| `fabrica-refino.test.js` | `decisoes/test/refinadores-do-turno.test.js` |
| `fabrica-selecao.test.js` | `decisoes/test/selecao.test.js` |

`cortesDoAmbiente(env)` virou `normalizarCorte(obj)`, `configDeRefino(env)` virou `normalizarRefino(obj)` e
`configDaSelecao(env)` virou `configDaSelecao(obj, {...})`: os testes foram portados com objeto no lugar de env, com
`dataDir` temporário.

**Testes que ficam no Igris** e passam a provar a **configuração**, não o mecanismo:

- `fabrica-perfil.test.js`: o objeto entregue à fábrica (campo `indiceDeCapacidades` com `prioridade` 490,
  `corteDeFuncao` com `excluir: ['memoria']` e `semanticasDoPiso.memoria`, `cartaoSugerido` do env). É onde cabe a
  prova de que o env continua mandando.
- `fabrica-turno-selecao-padrao.test.js`: prova o turno completo (`executarTurnoPelaFabrica`) com a seleção local.
  Fica, e não deve mudar de resultado.
- `fabrica-aquecimento*.test.js`: só troca o import de `indiceEmUso`/`_limparSelecaoParaTestes` (`:127`).
- `fabrica-corte-do-envelope.test.js` e os demais `fabrica-*` não tocam as cinco peças.

**Provas de equivalência a rodar, nesta ordem:**

1. **Índice:** gerar o `<capability_index>` antes e depois na mesma sessão e comparar. A diferença esperada é só a
   descrição cortada na 1ª frase (§4 item 1). Posição no system: o índice continua logo antes de `<capabilities>`
   (prioridade 490).
2. **Corte:** num turno com a `memoria` carregada e função semântica de nota baixa, `corteDeFuncao` no retorno traz a
   decisão `regra: 'semanticas-do-piso'`, e a capacidade da `memoria` **não** aparece na regra `carregada`.
   `IGRIS_CORTE_MEMORIA=off` e `IGRIS_CORTE_CARREGADA=off` só registram (`passa` sem rebaixar).
3. **Refino e seleção:** um turno com `IGRIS_CHAT_FABRICA_REFINO` alterando um `prazoMs` mostra o prazo novo no
   `refino` do artefato (prova de que o objeto chegou aos três lugares da §1.3).
4. **Cartão:** sem `IGRIS_CHAT_FABRICA_CARTAO`, o cartão sai `funcoesSugeridas`, não `completo`.
5. Suíte do Igris inteira, contra a mesma baseline de antes da subida.

## 8. Ordem sugerida

Índice → cartão → corte → refinadores → seleção, um commit cada. O corte depende do refinador do anel `tool` estar
estável; refinadores e seleção são a troca mais ampla (`turno.js`, `perfil.js`, `treino-continuo.js` e
`packages/executor/src/index.js`) e vão por último, com a prova 3 da §7.

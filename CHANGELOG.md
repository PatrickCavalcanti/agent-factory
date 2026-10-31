# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/). Versões por tag `vX.Y.Z`,
consumidas por `git+https://github.com./PatrickCavalcanti/agent-factory.git#semver:^X.Y.Z`.

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

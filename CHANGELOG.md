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
- `test/contrato.test.js` (congela os 40 subpaths e os nomes exportados) e `test/pureza.test.js`
  (falha com `@igris/`, `IGRIS_` em código ou import relativo para fora do pacote) (`116b2c6`).
- `README.md`, `ORIGEM.md`, `MIGRACAO-IGRIS.md`, `docs/pendencias/2026-10-31-criacao.md`.

### Alterado

- `nomeExposto` delega a `exposedName` de `@okds/kairos/core/names`; nome prefixado com mais de 64
  caracteres lança já em `nomeExposto` (`209fe07`).
- `refino.test.js` lê a versão do kairos pelo pacote resolvido, não por caminho fixo.
- `@okds/kairos` (`^0.841.261021`) e `genos-orchestrator` (`^0.3.12`) são `peerDependencies`
  (semver, porque o pnpm recusa URL git em peer) e `devDependencies` (URL git); `zod` é dependência.

### Quebras em relação a `@igris/orchestrator` e `@igris/decisions`

- **Nomes de pacote e subpaths:** `@igris/orchestrator[/x]` → `@okds/agent-factory[/x]`;
  `@igris/decisions[/x]` → `@okds/agent-factory/decisoes[/x]`. `@igris/orchestrator/bancada` saiu.
- **Nome do schema do envelope:** o padrão deixa de ser `igris_envelope*` e passa a `envelope*`;
  para os bytes do Igris, `protocoloOpts: { prefixoDoEnvelope: 'igris' }` — inclusive depois dos
  perfis `perfilAgenteLlm`/`perfilShadowLoop`, que não repassam o prefixo. As constantes `SCHEMA_*`
  têm nome neutro; o nome do Igris vem de `schemasDoEnvelope('igris')`.
- **`consumer` obrigatório** em `criarClienteDoGateway` e `criarProvedorDeCliente` (era `'module:executor'`).
- **Fim da leitura de `process.env`** em `criarProvedorDeCliente`: `IGRIS_TEST`, `NODE_ENV`,
  `IGRIS_DECISOES_BANCADA`, `IGRIS_DECISOES_CHAVE` viram `modoBancada`/`chaveDeBancada`, lidos pelo host.
- **`X-Title`** padrão `'agent-factory'` (era `'igris-decisions'`): `xTitle`.
- **`raizPowers` obrigatório** em `extrairCasos`, `pisoIncondicional` e `criarServicoDeTreino`;
  `RAIZ_POWERS_PADRAO` deixou de ser exportado.
- **`embedderDoRoteamento({ resolver })` obrigatório**: some o import dinâmico de `@igris/embeddings`.
- **Cache de embeddings do treino:** `<dataDir>/agent-factory/cache` (era `<dataDir>/igris/cache`);
  `dirCache` devolve o do Igris.
- **Peças de apoio** deixam de ser relativas ao executor (`./conversa.js` → `@okds/agent-factory/apoio/conversa`).
- **Histórico da conversa** (comportamento): o `<turn_operations>` imitado pelo modelo é removido antes
  de costurar o bloco da plataforma; bloco aberto sem fechamento descarta o resto do texto.
- **Tool desconhecida no protocolo nativo** responde com a orientação de `call_capability`.

Ligação do Igris: [`MIGRACAO-IGRIS.md`](./MIGRACAO-IGRIS.md).

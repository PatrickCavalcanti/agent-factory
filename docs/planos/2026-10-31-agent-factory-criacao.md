---
date: 2026-10-31
spec: docs/specs/2026-10-31-agent-factory-design.md
origem: PatrickCavalcanti/igris@430d2c9
repo-dos-commits: PatrickCavalcanti/agent-factory (branch main) — salvo F6.2, que commita no Igris
---

# Plano — criação do `@okds/agent-factory` a partir da cópia do Igris

Fonte da cópia: `IGRIS=/home/user/igris` no sha `430d2c9`. Ariadne:
`/home/user/ariadne-artifact-studio`.

Ambiente (container de nuvem): todo `pnpm install` roda com
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' GIT_CONFIG_VALUE_0='https://github.com./'`
no ambiente do comando — nunca escrito em arquivo do repo.

Linha de base medida antes do plano (cópia crua fora do monorepo): orquestrador
611/613, decisoes 732/734; as 4 falhas são as de D9 da spec + `refino.test.js`
lendo `../node_modules/@okds/kairos/package.json` por caminho fixo.

## Mapa de execução

| Fase | Tasks | Modo | Implementador | Revisão de fase |
|---|---|---|---|---|
| F1 Cópia | F1.1 | sequencial | Sonnet | Sonnet |
| F2 Genericização | F2.1 ∥ F2.2 ∥ F2.3, depois F2.4 | paralela + seq. | Sonnet | Sonnet |
| F3 Apoio | F3.1 | sequencial | Sonnet | Sonnet |
| F4 Ariadne | F4.1 | sequencial | Sonnet | Sonnet |
| F5 Docs e ligação | F5.1 | sequencial | Sonnet | — (entra na final) |
| F6 Entrega | review do conjunto (Opus) → correções → tag `v0.1.0` → F6.2 | controller | — | Opus |

Em fase paralela o implementador NÃO commita; o controller commita por paths.

## F1 — Esqueleto e cópia literal

**F1.1** Montar o repo e copiar.

- `orquestrador/` ← `IGRIS/packages/orchestrator` **sem** `bancada/`,
  `SINCRONIA.md`, `package.json`.
- `decisoes/` ← `IGRIS/packages/decisions` **sem** `eval/`, `package.json`,
  `treino/*.mjs` (as CLIs); fica `treino/lib/`.
- Testes de D9 não vêm: `orquestrador/test/despejo-equivalencia-script.test.js`,
  `decisoes/test/treino-args.test.js`, `decisoes/test/treino-conferencia.test.js`;
  em `decisoes/test/perguntas-agnosticas.test.js` saem só os dois casos que varrem
  `powers/src/powers` (o resto fica).
- `refino.test.js`: ler a versão do kairos pelo pacote resolvido
  (`createRequire`/`import.meta.resolve`), não por caminho fixo.
- `package.json` raiz: `@okds/agent-factory` 0.1.0, `type: module`, `exports`
  pelo mapa da spec §3.1 (orquestrador com os nomes de hoje; decisões com
  prefixo `./decisoes`), `peerDependencies` kairos `^0.841.261021` e genos
  `^0.3.12` (URLs git com `github.com.`), as mesmas em `devDependencies`, `zod`
  `^3.25.76` em `dependencies`, `pnpm.onlyBuiltDependencies` com os dois,
  `engines.node >=22`, script `test` que roda as três pastas de teste.
- `.gitignore` (node_modules, .tmp).
- Nenhuma mudança de comportamento. Comentários que citam caminho do Igris
  ficam (F5 trata docs).

Verificação: `pnpm install && pnpm test` verde; reportar contagem por módulo.

## F2 — Genericização (Fase 0 do insight)

Regra comum: padrão neutro + parâmetro; os testes que hoje afirmam o valor do
Igris continuam, passando o valor do Igris pela config; um teste novo cobre o
padrão neutro. Cada task anota no seu report o parâmetro novo, o padrão e o
valor que o Igris passa (vai para o `MIGRACAO-IGRIS.md`).

**F2.1 (orquestrador, protocolo)** Nome do envelope parametrizável.
`SCHEMA_COMPLETA`/`SCHEMA_HEADLESS`/`SCHEMA_COMPLETA_CONTRIBUICOES` hoje se
chamam `igris_envelope*`. Padrão novo: `envelope`, `envelope_headless`,
`envelope_contribuicoes`; parâmetro de prefixo que chega pela config do
orquestrador (`ConfigDoOrquestrador`) e pela estratégia de protocolo, com o
Igris passando `'igris'`. Critério: com prefixo `'igris'`, os JSON de
referência de `envelope-schema-contribuicoes.test.js` batem byte a byte.
Arquivos: `orquestrador/src/protocolo/**`, `orquestrador/src/index.js` (só a
passagem do parâmetro), testes do protocolo.

**F2.2 (decisões)** Tirar o Igris de `decisoes/src` e `decisoes/treino/lib`:
envs `IGRIS_TEST`/`IGRIS_DECISOES_BANCADA`/`IGRIS_DECISOES_CHAVE` em
`nucleo/provedor.js` → opção explícita (o host lê a env e passa);
`consumer = 'module:executor'` em `cliente-gateway.js` → obrigatório ou padrão
neutro; `X-Title: 'igris-decisions'` em `cliente.js` → parâmetro com padrão
`'agent-factory'`; `treino/lib/embedder.js` `import('@igris/embeddings')` →
embedder injetado; `treino/lib/servico.js` cache em `<dataDir>/igris/cache` →
diretório de cache por parâmetro; referências a `IGRIS_CHAT_FABRICA_TREINO` em
código → configuração recebida. Comentários históricos podem citar o Igris.
`treino/lib/mcp-servidor.js` (regra `mcp-<slug>` do Igris): tornar injetável se
for trivial; senão reportar para pendência. Arquivos: `decisoes/**`.

**F2.3 (orquestrador, capacidades)** `nomeExposto` passa a delegar para
`exposedName` de `@okds/kairos/core/names` (público desde a 0.830); a trava em
`capacidades.test.js` continua. Arquivos: `orquestrador/src/capacidades.js` e
seu teste.

**F2.4 (pacote)** Depois de F2.1–F2.3: `test/contrato.test.js` — importa cada
subpath do `exports` e congela a lista de nomes exportados (snapshot em
arquivo versionado); `test/pureza.test.js` — varre `orquestrador/src`,
`decisoes/src`, `decisoes/treino/lib`, `apoio/src` (se existir) e falha com
`@igris/`, `IGRIS_` em código (fora de comentário) ou import relativo que saia
da raiz do pacote. Ajustar o script `test` para incluir `test/`.

## F3 — Peças de apoio do host

**F3.1** Copiar para `apoio/src/` as peças puras de
`IGRIS/packages/executor/src/orchestration/fabrica/`: `continuidade.js`,
`intencao.js`, `consultas-anteriores.js`, `guarda-de-repeticao.js`,
`chaveDasCapacidades.js`, `conversa.js`, `valores-do-registro.js`,
`pista-contexto.js` — **conferir cada uma**: só desce o que não importa
`@igris/*` (exceto `@igris/decisions`/`@igris/orchestrator`, que viram import
relativo interno) nem `ctx`/I/O do host. `indice-de-capacidades.js` não desce.
Trazer os testes unitários correspondentes de `IGRIS/packages/executor/test/`
que só exercitam a peça (não os de integração com `turno.js`). Adicionar
`./apoio/<peca>` ao `exports` e atualizar o snapshot do contrato.

## F4 — Ariadne

**F4.1** Em `/home/user/ariadne-artifact-studio`, listar o que mudou em
`src/fabrica/` desde a sincronia `d6c1d17f` (22/09) que **não** veio do Igris
(`git log` + `ORIGEM.md` de lá). Para cada mudança: classificar (genérica ×
específica do Ariadne × já resolvida no Igris de outra forma). Portar só as
genéricas cujo defeito existe no código atual da biblioteca, com teste que falha
antes. Report: tabela commit → classificação → portado/pendência.
Escopo fechado: só `orquestrador/` e `decisoes/`.

## F5 — Documentação e ligação

**F5.1**
- `README.md`: o que é, instalação (URL git semver + peers + o porquê da cópia
  única do genos), exemplo mínimo de `criarOrquestrador`, mapa de subpaths.
- `ORIGEM.md`: sha de origem, mapa pasta-a-pasta Igris → aqui, o que ficou de
  fora e por quê (D7, D9), comando para medir deriva.
- `MIGRACAO-IGRIS.md`: entrada no catálogo do `pnpm-workspace.yaml`; tabela
  completa de troca de especificadores (gerar por grep no Igris); cada
  parâmetro novo de F2 com o valor do Igris; testes que ficam no Igris e o que
  muda neles; o que o Igris apaga (`packages/orchestrator` menos `bancada/`,
  `packages/decisions` menos `eval/` e CLIs do treino, peças de apoio);
  onde `bancada/` e as CLIs passam a morar.
- `ARCHITECTURE.md` de cada módulo: links para `../../docs/...` do Igris viram
  links absolutos para o GitHub do Igris no sha de origem.
- `CHANGELOG.md` com a 0.1.0.
- `docs/pendencias/2026-10-31-criacao.md` com o que as fases reportaram.

## F6 — Entrega

1. Review do conjunto (Opus, prompt dirigido) contra a spec §4. Correções → re-review.
2. **F6.2 (Igris, branch `claude/practical-faraday-df39e3`)**: plano de ligação
   `docs/superpowers/plans/2026-10-31-ligar-igris-na-agent-factory.md` (a partir
   do `MIGRACAO-IGRIS.md`), atualizar o insight de origem com o ponteiro e
   registrar pendências do Igris.
3. Tag `v0.1.0` e push.

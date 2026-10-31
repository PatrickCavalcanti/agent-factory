---
date: 2026-10-31
status: em-execucao
origem: PatrickCavalcanti/igris@430d2c9 — docs/insights/2026-10-31-extracao-da-fabrica-para-repo-proprio.md
---

# Spec — `@okds/agent-factory`: a fábrica como biblioteca própria

## 1. Pedido

O dono quer a **fábrica** (o mecanismo que decide, a cada turno, o que entra no
contexto do modelo e monta o prompt) fora do Igris, num repositório próprio,
reutilizável por vários projetos — o Igris primeiro, o Ariadne depois.

Palavras do dono (31/10): criar o projeto a partir da **cópia do Igris inteira**,
com tudo que já é útil; trazer do Ariadne só o que fizer sentido; a integração
com o Ariadne fica para depois. **Objetivo de chegada: este repo pronto para o
Igris remover a fábrica dele e passar a consumir a biblioteca.**

## 2. Decisões (tomadas nesta sessão, no automático autorizado pelo dono)

| # | Decisão | Por quê |
|---|---|---|
| D1 | Nome do pacote: **`@okds/agent-factory`**; repo `PatrickCavalcanti/agent-factory` | O dono criou o repo com esse nome; escopo `@okds/` igual ao kairos. |
| D2 | **Um pacote, dois módulos** (`orquestrador/` e `decisoes/`) com subpaths | Orquestrador e decisores mudam juntos (formato do refinador e do loop passa pela config). Dois repos = duas tags por mudança. |
| D3 | **Cópia sem histórico**, de `igris@430d2c9`, registrada em `ORIGEM.md` | O dono pediu cópia. `git filter-repo` não foi provado executando (dev-process: ferramenta externa se prova executando). O histórico continua consultável no Igris. |
| D4 | **Subpaths preservam os nomes atuais** (`@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades`; `@igris/decisions/local` → `@okds/agent-factory/decisoes/local`) | A ligação no Igris vira troca mecânica de especificador. |
| D5 | kairos e genos são **`peerDependencies`** (e `devDependencies` para os testes); `zod` é `dependency` | O kairos traz genos como dependência própria e há `instanceof` do `ToolRegistry`: o consumidor tem de resolver UMA cópia de cada. |
| D6 | **Genericização com padrão neutro + valor do Igris passado por config** | Tudo que hoje carrega nome do Igris (nome do envelope, envs `IGRIS_*`, consumidor `'module:executor'`, cache em `<dataDir>/igris/`, `X-Title`) vira parâmetro. O padrão é neutro; o `MIGRACAO-IGRIS.md` diz o valor exato que o Igris passa para o comportamento não mudar (byte a byte no schema do envelope). |
| D7 | Fica no Igris: `orchestrator/bancada/`, `decisions/eval/`, CLIs de `decisions/treino/*.mjs`, host `executor/.../fabrica/` (exceto as peças puras de D8), `powers/src/fabrica/`, `memory/src/fonte/`, `embeddings`, `createGenosProviderForTier` (`@igris/shadows`) | Importam o Igris por caminho relativo ou são cola do host. A biblioteca recebe `Embedder`, provider e capacidades por injeção. |
| D8 | Peças puras do host **descem** como módulo `apoio/` (subpath `@okds/agent-factory/apoio/<peca>`), só as sem import do Igris | "Tudo que já é útil". `indice-de-capacidades.js` NÃO desce: depende de `contribuicoes.js`, que importa `@igris/executor-registry`. |
| D9 | Testes que são do Igris ficam no Igris (lista no `MIGRACAO-IGRIS.md`) | `despejo-equivalencia-script` (compara com `scripts/eval/despejo.mjs` do Igris), os dois casos de `perguntas-agnosticas` que varrem `powers/src/powers`, `treino-args`/`treino-conferencia` (testam as CLIs). |
| D10 | Ariadne: avaliar os remendos locais da cópia dele (desde a sincronia de 22/09) e **portar só os genéricos cujo defeito existe também no código do Igris**, com teste; o resto vira pendência | O dono quer o Igris como base e a integração do Ariadne depois. |
| D11 | Versão inicial **0.1.0**, tag `v0.1.0`, consumida por `git+https://github.com./PatrickCavalcanti/agent-factory.git#semver:^0.1.0` | Convenção dos pacotes do dono (sem registry). |

## 3. Forma do repositório

```
agent-factory/
  package.json          @okds/agent-factory — exports, peers, scripts
  orquestrador/         ← igris packages/orchestrator (src/, test/, ARCHITECTURE.md, CAPACIDADES.md, REGRAS.md)
  decisoes/             ← igris packages/decisions (src/, treino/lib/, test/, ARCHITECTURE.md)
  apoio/                ← peças puras de igris packages/executor/src/orchestration/fabrica (src/, test/)
  test/                 testes do pacote: contrato de exports, trava de pureza
  docs/specs/, docs/planos/, docs/pendencias/
  README.md  ORIGEM.md  MIGRACAO-IGRIS.md  CHANGELOG.md
```

Os caminhos relativos internos de cada módulo não mudam (cópia de pasta inteira).

### 3.1 Mapa de subpaths (a API pública)

- Raiz e subpaths do orquestrador, **com os mesmos nomes de hoje**: `.`,
  `./prompt-builder`, `./capacidades`, `./calibracao`, `./cache-exemplos`,
  `./protocolo`, `./protocolo/envelope-schema`, `./perfis/shadow-loop`,
  `./perfis/agente-llm`, `./loop-do-turno`. (`./bancada` sai — D7.)
- Decisores sob `./decisoes`: `./decisoes`, `./decisoes/cliente`,
  `./decisoes/catalogo`, … — todos os subpaths atuais de `@igris/decisions`,
  prefixados.
- Apoio: `./apoio/<peca>`.

## 4. Critérios de aceite

1. `pnpm install` + `pnpm test` verdes no repo novo, sem nada do Igris presente.
2. Nenhum teste da cópia removido sem estar na lista de D9 (contagem: cópia literal
   menos D9 = contagem verde da Fase 1; fases seguintes só somam).
3. Teste de contrato congela a lista de subpaths e os nomes exportados de cada um.
4. Trava de pureza: falha se aparecer `@igris/`, `IGRIS_` ou caminho relativo
   para fora do pacote em `orquestrador/src`, `decisoes/src`, `decisoes/treino/lib`,
   `apoio/src`.
5. Com a config do `MIGRACAO-IGRIS.md`, o schema do envelope sai **byte a byte**
   igual ao de hoje (o teste `envelope-schema-contribuicoes` já tem os JSON de
   referência).
6. `MIGRACAO-IGRIS.md` lista: entrada de catálogo, tabela de troca de imports,
   cada parâmetro novo com o valor que o Igris passa, testes que ficam no Igris,
   e o que o Igris apaga.
7. Tag `v0.1.0` publicada.

## 5. Fora de escopo

- Trocar o Igris para consumir o pacote (plano próprio no Igris, executado na
  máquina do dono — exige `scripts/suite.mjs` com baseline e o install por git
  semver no Windows).
- Integração do Ariadne.
- Mexer em kairos/genos.
- Mudança de comportamento da fábrica além do que D6 e D10 pedem.

## 6. Riscos

- **Deriva até a ligação:** o Igris segue mudando a fábrica. `ORIGEM.md` guarda o
  sha de origem; a ligação começa por `git diff 430d2c9..HEAD -- packages/orchestrator
  packages/decisions <peças de apoio>` e reaplica aqui.
- **Mudança de padrão silenciosa** (D6): mitigada por manter, nos testes, as
  asserções antigas rodando com a config do Igris, e por um teste novo do padrão
  neutro.
- **Install por git no container de nuvem:** o host `github.com.` falha no
  certificado do proxy; contornado só no ambiente do comando
  (`GIT_CONFIG_*` com `url.insteadOf`), nunca no repo.

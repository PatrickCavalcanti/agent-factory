# Migração do Igris para `@okds/agent-factory`

Passo a passo para o Igris apagar a fábrica própria e passar a consumir esta biblioteca. O Igris é
dono da execução (plano próprio lá, `docs/superpowers/plans/2026-10-31-ligar-igris-na-agent-factory.md`);
este documento é o insumo. Tudo que está aqui vem de grep em `igris@430d2c9` (árvore lida em
31/10/2026) e do código desta árvore; o que não foi possível confirmar está marcado **(conferir)**.

Legenda de caminhos: `packages/…` é do Igris; `orquestrador/`, `decisoes/`, `apoio/` são daqui.

## 0. Antes de começar

1. **Subpaths do código que fica no Igris (existem desde a 0.1.0).** O `exports` é fechado (sem
   import profundo); estes 12 arquivos têm subpath próprio (nome do arquivo = nome do subpath):

   | Subpath | Arquivo | Quem usa no Igris |
   |---|---|---|
   | `@okds/agent-factory/decisoes/args` | `decisoes/treino/lib/args.js` | `treino/conferencia.mjs`, `treino/treinar.mjs`, `test/treino-args.test.js` |
   | `@okds/agent-factory/decisoes/conferencia` | `decisoes/treino/lib/conferencia.js` | `treino/conferencia.mjs`, `test/treino-conferencia.test.js` |
   | `@okds/agent-factory/decisoes/conferencia-texto` | `decisoes/treino/lib/conferencia-texto.js` | idem |
   | `@okds/agent-factory/decisoes/linha-sinal` | `decisoes/treino/lib/linha-sinal.js` | `treino/treinar.mjs` |
   | `@okds/agent-factory/decisoes/sombra` | `decisoes/treino/lib/sombra.js` | `treino/sombra.mjs` |
   | `@okds/agent-factory/despejo/config` | `orquestrador/src/despejo/config.js` | `scripts/eval/despejo.mjs` (também sai na raiz) |
   | `@okds/agent-factory/despejo/registro-de-uso` | `orquestrador/src/despejo/registro-de-uso.js` | `scripts/eval/despejo.mjs` |
   | `@okds/agent-factory/despejo/conta` | `orquestrador/src/despejo/conta.js` | idem |
   | `@okds/agent-factory/despejo/despejar` | `orquestrador/src/despejo/despejar.js` | idem |
   | `@okds/agent-factory/despejo/cauda` | `orquestrador/src/despejo/cauda.js` | idem |
   | `@okds/agent-factory/despejo/aviso` | `orquestrador/src/despejo/aviso.js` | idem |
   | `@okds/agent-factory/despejo/costura` | `orquestrador/src/despejo/costura.js` | idem |

   O restante do que o Igris importa já existe nos subpaths atuais (nomes conferidos contra o código:
   todos os identificadores importados nas tabelas abaixo existem no módulo de destino, exceto
   `RAIZ_POWERS_PADRAO`, que saiu de propósito — ver seção 5).
2. **Medir a deriva** do Igris desde a origem (comando em [`ORIGEM.md`](./ORIGEM.md)). Qualquer diff
   precisa ser reaplicado aqui antes de ligar.
3. **Baseline na main do Igris**, antes de abrir a worktree: `node scripts/suite.mjs --baseline`
   (o verde de referência mora em `.suite-baseline.json`, gitignored, por sha). Sem baseline o
   `suite.mjs` responde "indeterminado" e não deixa atribuir falha.
4. **Worktree:** `node scripts/worktree.mjs new ligar-agent-factory --plano docs/superpowers/plans/2026-10-31-ligar-igris-na-agent-factory.md`.
5. Tag `v0.1.0` (ou posterior) publicada neste repositório.

## 1. Catálogo e `package.json`

### `pnpm-workspace.yaml`

```yaml
catalog:
  # …entradas existentes…
  "@okds/agent-factory": "git+https://github.com./PatrickCavalcanti/agent-factory.git#semver:^0.1.0"
  "@okds/kairos": "git+https://github.com./PatrickCavalcanti/kairos.git#semver:^0.841.261021"   # era ^0.840.261021
```

- O ponto em `github.com.` é obrigatório (`scripts/check-git-deps.mjs`, no `preinstall`, recusa sem ele).
- **Subir o kairos de `^0.840` para `^0.841.261021`**: é o piso do peer desta biblioteca
  (`exposedName` público em `@okds/kairos/core/names`). É uma mudança do Igris por si só — rodar a
  suíte só com o bump antes de trocar qualquer import, para separar o que é do kairos do que é da
  ligação **(conferir** o que a 0.841 muda para o Igris)**.
- **Manter o override** `"@okds/kairos>genos-orchestrator"` (commit fixado = o que o lockfile resolve
  para `genos-orchestrator` 0.3.12). Esta biblioteca exige `genos-orchestrator ^0.3.12` e UMA cópia dele.
  Se o kairos 0.841 pedir faixa diferente do genos, refixar o commit do override junto.

### `package.json` por pacote

O peer `@okds/kairos`/`genos-orchestrator` é semver, não URL: **cada pacote que dependa de
`@okds/agent-factory` tem de declarar também `@okds/kairos` e `genos-orchestrator`** (`"catalog:"`).
Quem não declara faz o pnpm tentar resolver o peer por faixa semver — e nenhum registry tem esses
pacotes — ou, pior, instalar uma segunda cópia. Verificar no primeiro install com
`pnpm why genos-orchestrator` e `pnpm why @okds/kairos` (uma versão/commit só em todos os importers)
**(conferir)**.

| `package.json` | Mudança |
|---|---|
| `packages/executor` | remove `"@igris/decisions": "workspace:*"` (L14) e `"@igris/orchestrator": "workspace:*"` (L23); adiciona `"@okds/agent-factory": "catalog:"` e `"@okds/kairos": "catalog:"` (`genos-orchestrator` e `zod` já estão) |
| `packages/powers` | remove `"@igris/orchestrator": "workspace:*"` (L25); adiciona `"@okds/agent-factory": "catalog:"` e `"@okds/kairos": "catalog:"` (genos já está) |
| `packages/shadows` | remove `"@igris/orchestrator": "workspace:*"` (L13); adiciona `@okds/agent-factory` e `@okds/kairos` (genos já está) |
| `packages/api` | `api/test/routes/decisoes.test.js` passa a importar o pacote: `devDependencies` + `@okds/agent-factory`, `@okds/kairos` (genos já está) |
| raiz `package.json` | `scripts/eval/despejo.mjs` importa o pacote: `devDependencies` + `@okds/agent-factory`, `@okds/kairos`, `genos-orchestrator` |
| `packages/orchestrator` (fica magro, seção 8) | `dependencies`: `@okds/agent-factory`, `@okds/kairos`, `genos-orchestrator` (`catalog:`), `zod`; `exports` fica só com `"./bancada": "./bancada/servir.mjs"`; `main` sai |
| `packages/decisions` (fica magro, seção 8) | `dependencies`: `@okds/agent-factory` (`catalog:`), `@igris/providers` (`workspace:*`, já está; `eval/_cliente.mjs` usa); `exports` e `main` saem |
| `pnpm-lock.yaml` | regenerado pelo `pnpm install` (hoje 4 linhas citam `@igris/orchestrator`/`@igris/decisions`) |

Install (Windows, no Igris): `pnpm install` normal; a variável `GIT_CONFIG_*` de ambiente de nuvem não se aplica.

## 2. Ordem das trocas (resumo)

Ver seção 10. Em uma frase: catálogo → install → trocar especificadores (mecânico, sem mudar valor
nenhum) → passar os parâmetros da seção 4 → ajustar os testes que ficam → só então apagar as cópias.

## 3. Tabela de troca de especificadores

Gerada por grep em `igris@430d2c9` (todo `@igris/orchestrator…`, `@igris/decisions…`, import relativo
que alcança `packages/orchestrator/src|bancada`, `packages/decisions/src|treino|eval`, e os imports
relativos das 7 peças de apoio). Regras de tradução:

- `@igris/orchestrator` → `@okds/agent-factory`; `@igris/orchestrator/<x>` → `@okds/agent-factory/<x>`.
- `@igris/decisions` → `@okds/agent-factory/decisoes`; `@igris/decisions/<x>` → `@okds/agent-factory/decisoes/<x>`.
- `./<peça>.js` / `../src/orchestration/fabrica/<peça>.js` (7 peças) → `@okds/agent-factory/apoio/<peça>`.
- `mock.module('@igris/orchestrator', …)` troca igual (a chave tem de ser o mesmo especificador que o
  código importa; mantendo os dois em `@okds/agent-factory` resolvem ao mesmo módulo).
- Os identificadores importados não mudam de nome (conferido).
- Fora desta tabela, comentários e JSDoc que citam `@igris/…` ou `packages/orchestrator/src/…`
  (dezenas em `executor/src/orchestration/fabrica/turno.js`, `perfil.js`, `refinadores.js`, etc.) e
  `import('@igris/orchestrator').CapacidadeDeclarada` em `perfil.js` e `powers/src/fabrica/capacidade.js`
  são só texto/tipo: não quebram nada; atualizar quando convier.

### 3.1 Código de produção do Igris que muda (16 arquivos)

| Arquivo | Linhas: especificador atual → novo |
|---|---|
| `packages/executor/src/executor.js` | L23: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema`<br>L60: `@igris/orchestrator/protocolo` → `@okds/agent-factory/protocolo` |
| `packages/executor/src/index.js` | L22: `@igris/decisions/treino` → `@okds/agent-factory/decisoes/treino` |
| `packages/executor/src/orchestration/decisoes.js` | L5: `@igris/decisions` → `@okds/agent-factory/decisoes`<br>L9: `@igris/decisions/nucleo` → `@okds/agent-factory/decisoes/nucleo` |
| `packages/executor/src/orchestration/fabrica/aquecimento.js` | L19: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/src/orchestration/fabrica/autorizacoes-do-turno.js` | L2: `@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades` |
| `packages/executor/src/orchestration/fabrica/despejo.js` | L2: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/src/orchestration/fabrica/indice-de-capacidades.js` | L9: `@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades` |
| `packages/executor/src/orchestration/fabrica/loop.js` | L6: `@igris/decisions/loop` → `@okds/agent-factory/decisoes/loop`<br>L7: `@igris/decisions/perguntas` → `@okds/agent-factory/decisoes/perguntas`<br>L8: `@igris/decisions` → `@okds/agent-factory/decisoes`<br>L9: `./conversa.js` → `@okds/agent-factory/apoio/conversa` |
| `packages/executor/src/orchestration/fabrica/piso-incondicional.js` | L10: `@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades` |
| `packages/executor/src/orchestration/fabrica/refinadores.js` | L13: `@igris/decisions/refinadores` → `@okds/agent-factory/decisoes/refinadores` |
| `packages/executor/src/orchestration/fabrica/selecao.js` | L19: `@igris/decisions/local` → `@okds/agent-factory/decisoes/local`<br>L20: `@igris/decisions/versoes` → `@okds/agent-factory/decisoes/versoes` |
| `packages/executor/src/orchestration/fabrica/treino-continuo.js` | L9: `@igris/decisions/caso` → `@okds/agent-factory/decisoes/caso`<br>L10: `@igris/decisions/casos` → `@okds/agent-factory/decisoes/casos`<br>L11: `@igris/decisions/registro` → `@okds/agent-factory/decisoes/registro`<br>L12: `@igris/decisions/versoes` → `@okds/agent-factory/decisoes/versoes`<br>L13: `@igris/decisions/lote` → `@okds/agent-factory/decisoes/lote`<br>L14: `@igris/decisions/dominio` → `@okds/agent-factory/decisoes/dominio`<br>L16: `@igris/decisions/trava` → `@okds/agent-factory/decisoes/trava`<br>L17: `@igris/decisions/worker-treino` → `@okds/agent-factory/decisoes/worker-treino` |
| `packages/executor/src/orchestration/fabrica/turno.js` | L20: `@igris/orchestrator` → `@okds/agent-factory`<br>L21: `@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades`<br>L22: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema`<br>L26: `./chaveDasCapacidades.js` → `@okds/agent-factory/apoio/chaveDasCapacidades`<br>L95: `@igris/decisions/casos` → `@okds/agent-factory/decisoes/casos`<br>L99: `./conversa.js` → `@okds/agent-factory/apoio/conversa`<br>L101: `./pista-contexto.js` → `@okds/agent-factory/apoio/pista-contexto`<br>L102: `./continuidade.js` → `@okds/agent-factory/apoio/continuidade`<br>L103: `./valores-do-registro.js` → `@okds/agent-factory/apoio/valores-do-registro`<br>L104: `./intencao.js` → `@okds/agent-factory/apoio/intencao`<br>L108: `./consultas-anteriores.js` → `@okds/agent-factory/apoio/consultas-anteriores` |
| `packages/powers/porte/calibrar.mjs` | L28: `@igris/orchestrator/calibracao` → `@okds/agent-factory/calibracao`<br>L29: `@igris/orchestrator/cache-exemplos` → `@okds/agent-factory/cache-exemplos` |
| `packages/powers/src/powers/async-shadows/agents/motor-llm.js` | L24: `@igris/orchestrator` → `@okds/agent-factory`<br>L25: `@igris/orchestrator/perfis/agente-llm` → `@okds/agent-factory/perfis/agente-llm` |
| `packages/shadows/src/runner/in-process.js` | L3: `@igris/orchestrator` → `@okds/agent-factory`<br>L4: `@igris/orchestrator/perfis/shadow-loop` → `@okds/agent-factory/perfis/shadow-loop` |

Arquivos do Igris que **somem** em vez de mudar: `executor/src/orchestration/fabrica/intencao.js` e
`valores-do-registro.js` (viram `apoio/src/`, e os `import './consultas-anteriores.js'` deles com
eles). `executor/src/orchestration/fabrica/{continuidade,consultas-anteriores,chaveDasCapacidades,conversa,pista-contexto}.js`
também somem.

### 3.2 Testes do Igris que mudam (26 arquivos)

| Arquivo | Linhas: especificador atual → novo |
|---|---|
| `packages/api/test/routes/decisoes.test.js` | L183: `../../../decisions/treino/lib/registro.js` → `@okds/agent-factory/decisoes/registro`<br>L207: `../../../decisions/treino/lib/registro.js` → `@okds/agent-factory/decisoes/registro`<br>L208: `../../../decisions/treino/lib/versoes.js` → `@okds/agent-factory/decisoes/versoes`<br>L209: `../../../decisions/treino/lib/caso.js` → `@okds/agent-factory/decisoes/caso` |
| `packages/executor/test/decisoes.test.js` | L10: `@igris/decisions/nucleo` → `@okds/agent-factory/decisoes/nucleo` |
| `packages/executor/test/envelope-stream-schema-integration.test.js` | L4: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema` |
| `packages/executor/test/fabrica-aquecimento-sessao.test.js` | L117: `@igris/orchestrator` → `@okds/agent-factory`<br>L118: `@igris/orchestrator/prompt-builder` → `@okds/agent-factory/prompt-builder` |
| `packages/executor/test/fabrica-aquecimento.test.js` | L69: `@igris/orchestrator` → `@okds/agent-factory`<br>L70: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/fabrica-autorizacoes.test.js` | L8: `@igris/orchestrator/loop-do-turno` → `@okds/agent-factory/loop-do-turno`<br>L95: `@igris/orchestrator` → `@okds/agent-factory`<br>L96: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/fabrica-continuidade-turno.test.js` | L867: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema`<br>L883: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema` |
| `packages/executor/test/fabrica-contribuicoes.test.js` | L5: `@igris/orchestrator` → `@okds/agent-factory`<br>L9: `@igris/orchestrator/prompt-builder` → `@okds/agent-factory/prompt-builder` |
| `packages/executor/test/fabrica-fala-incremental.test.js` | L44: `@igris/orchestrator` → `@okds/agent-factory`<br>L45: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/fabrica-fala-preenchimento.test.js` | L33: `@igris/orchestrator` → `@okds/agent-factory`<br>L34: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/fabrica-loop.test.js` | L235: `@igris/decisions/loop` → `@okds/agent-factory/decisoes/loop` |
| `packages/executor/test/fabrica-mcp.test.js` | L13: `../src/orchestration/fabrica/chaveDasCapacidades.js` → `@okds/agent-factory/apoio/chaveDasCapacidades` |
| `packages/executor/test/fabrica-perfil.test.js` | L5: `@igris/orchestrator` → `@okds/agent-factory`<br>L265: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/fabrica-piso-incondicional.test.js` | L9: `@igris/decisions/extrair` → `@okds/agent-factory/decisoes/extrair` |
| `packages/executor/test/fabrica-pista-contexto-avaliacao.test.js` | L45: `../src/orchestration/fabrica/pista-contexto.js` → `@okds/agent-factory/apoio/pista-contexto` |
| `packages/executor/test/fabrica-pista-contexto-integracao.test.js` | L61: `../src/orchestration/fabrica/pista-contexto.js` → `@okds/agent-factory/apoio/pista-contexto` |
| `packages/executor/test/fabrica-refino.test.js` | L21: `@igris/decisions/refinadores` → `@okds/agent-factory/decisoes/refinadores` |
| `packages/executor/test/fabrica-roteiro-calltool.test.js` | L10: `@igris/orchestrator` → `@okds/agent-factory`<br>L11: `@igris/orchestrator/prompt-builder` → `@okds/agent-factory/prompt-builder`<br>L12: `@igris/orchestrator/protocolo` → `@okds/agent-factory/protocolo` |
| `packages/executor/test/fabrica-selecao.test.js` | L10: `@igris/decisions/local` → `@okds/agent-factory/decisoes/local`<br>L11: `@igris/decisions/versoes` → `@okds/agent-factory/decisoes/versoes`<br>L12: `@igris/decisions/caso` → `@okds/agent-factory/decisoes/caso`<br>L1522: `@igris/decisions/local` → `@okds/agent-factory/decisoes/local` |
| `packages/executor/test/fabrica-tela-piso.test.js` | L8: `@igris/orchestrator/capacidades` → `@okds/agent-factory/capacidades` |
| `packages/executor/test/fabrica-treino-continuo.test.js` | L8: `@igris/decisions/local` → `@okds/agent-factory/decisoes/local`<br>L9: `@igris/decisions/caso` → `@okds/agent-factory/decisoes/caso`<br>L10: `@igris/decisions/versoes` → `@okds/agent-factory/decisoes/versoes`<br>L11: `@igris/decisions/registro` → `@okds/agent-factory/decisoes/registro`<br>L14: `@igris/decisions/trava` → `@okds/agent-factory/decisoes/trava`<br>L15: `@igris/decisions/casos` → `@okds/agent-factory/decisoes/casos`<br>L878: `@igris/decisions/registro` → `@okds/agent-factory/decisoes/registro` |
| `packages/executor/test/fabrica-turno.test.js` | L41: `@igris/orchestrator` → `@okds/agent-factory`<br>L43: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/executor/test/streaming-envelope-deltas.test.js` | L6: `@igris/orchestrator/protocolo/envelope-schema` → `@okds/agent-factory/protocolo/envelope-schema` |
| `packages/powers/test/async-shadows/motor-llm.test.js` | L7: `@igris/orchestrator/protocolo` → `@okds/agent-factory/protocolo`<br>L8: `@igris/orchestrator/perfis/agente-llm` → `@okds/agent-factory/perfis/agente-llm`<br>L9: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/powers/test/habilidades/semeio-ativada-vencida.test.js` | L8: `@igris/orchestrator` → `@okds/agent-factory` |
| `packages/powers/test/porte/porte-sem-registry-guarda.test.js` | L111: `../../../orchestrator/src/index.js` → `@okds/agent-factory` |

Nota: `packages/powers/test/porte/porte-sem-registry-guarda.test.js` L111 só traz
`"import('../../../orchestrator/src/index.js');"` como **texto** de um caso de teste da guarda
(exemplo de import proibido); não é import real — não trocar.

Além dos imports, três ajustes que não são troca de especificador estão na seção 5 (`RAIZ_POWERS_PADRAO`
em `executor/test/fabrica-piso-incondicional.test.js`; `raizPowers` em `api/test/routes/decisoes.test.js`;
caminho de `perguntas.js` em `decisions/test/perguntas-agnosticas.test.js`).

### 3.3 Código que FICA no Igris e passa a importar o pacote (20 arquivos)

`bancada/`, `eval/`, `treino/*.mjs` e `scripts/eval/despejo.mjs` (D7). Hoje alcançam a fábrica por
caminho relativo; depois, pelo pacote.

| Arquivo | Linhas: especificador atual → novo |
|---|---|
| `packages/decisions/eval/_cliente.mjs` | L22: `../src/cliente-gateway.js` → `@okds/agent-factory/decisoes` (importar `criarClienteDoGateway` da raiz; já é reexportado)<br>L23: `../src/cliente.js` → `@okds/agent-factory/decisoes/cliente` |
| `packages/decisions/eval/args.mjs` | L16: `../src/perguntas.js` → `@okds/agent-factory/decisoes/perguntas` |
| `packages/decisions/eval/cheap.mjs` | L16: `../src/perguntas.js` → `@okds/agent-factory/decisoes/perguntas` |
| `packages/decisions/eval/hidratacao-bracos-2.mjs` | L42: `../src/index.js` → `@okds/agent-factory/decisoes` |
| `packages/decisions/eval/hidratacao-bracos-3.mjs` | L47: `../src/index.js` → `@okds/agent-factory/decisoes` |
| `packages/decisions/eval/hidratacao-bracos.mjs` | L36: `../src/index.js` → `@okds/agent-factory/decisoes`<br>L38: `../src/perguntas.js` → `@okds/agent-factory/decisoes/perguntas` |
| `packages/decisions/eval/hidratacao-producao.mjs` | L47: `../src/index.js` → `@okds/agent-factory/decisoes` |
| `packages/decisions/eval/horizonte.mjs` | L13: `../src/nucleo/index.js` → `@okds/agent-factory/decisoes/nucleo` |
| `packages/decisions/eval/prefetch-args.mjs` | L25: `../src/index.js` → `@okds/agent-factory/decisoes`<br>L27: `../src/perguntas.js` → `@okds/agent-factory/decisoes/perguntas` |
| `packages/decisions/treino/casos.mjs` | L3: `./lib/extrair.js` → `@okds/agent-factory/decisoes/extrair` |
| `packages/decisions/treino/conferencia.mjs` | L8: `./lib/conferencia.js` → `@okds/agent-factory/decisoes/conferencia`<br>L9: `./lib/conferencia-texto.js` → `@okds/agent-factory/decisoes/conferencia-texto`<br>L10: `./lib/args.js` → `@okds/agent-factory/decisoes/args` |
| `packages/decisions/treino/sombra.mjs` | L7: `./lib/casos.js` → `@okds/agent-factory/decisoes/casos`<br>L8: `./lib/sombra.js` → `@okds/agent-factory/decisoes/sombra` |
| `packages/decisions/treino/treinar.mjs` | L11: `./lib/linha-sinal.js` → `@okds/agent-factory/decisoes/linha-sinal`<br>L12: `./lib/args.js` → `@okds/agent-factory/decisoes/args` |
| `packages/orchestrator/bancada/cenarios/decisor.mjs` | L24: `../../src/index.js` → `@okds/agent-factory`<br>L25: `../../../decisions/src/refinadores/index.js` → `@okds/agent-factory/decisoes/refinadores` |
| `packages/orchestrator/bancada/cenarios/loop-ampliada.mjs` | L32: `../../../decisions/src/loop/index.js` → `@okds/agent-factory/decisoes/loop`<br>L34: `../../../decisions/src/perguntas.js` → `@okds/agent-factory/decisoes/perguntas` |
| `packages/orchestrator/bancada/cenarios/loop-replay.mjs` | L19: `../../../decisions/src/loop/index.js` → `@okds/agent-factory/decisoes/loop` |
| `packages/orchestrator/bancada/cenarios/loop.mjs` | L30: `../../../decisions/src/loop/index.js` → `@okds/agent-factory/decisoes/loop` |
| `packages/orchestrator/bancada/cenarios/memoria.mjs` | L15: `../../src/index.js` → `@okds/agent-factory` |
| `packages/orchestrator/bancada/rodar.mjs` | L2: `../src/index.js` → `@okds/agent-factory` |
| `scripts/eval/despejo.mjs` | L22: `../../packages/orchestrator/src/despejo/config.js` → `@okds/agent-factory` (`normalizarDespejo`, `DESPEJO_PADRAO` são reexportados na raiz)<br>L23: `../../packages/orchestrator/src/despejo/registro-de-uso.js` → `@okds/agent-factory/despejo/registro-de-uso`<br>L24: `../../packages/orchestrator/src/despejo/conta.js` → `@okds/agent-factory/despejo/conta`<br>L25: `../../packages/orchestrator/src/despejo/despejar.js` → `@okds/agent-factory/despejo/despejar`<br>L26: `../../packages/orchestrator/src/despejo/cauda.js` → `@okds/agent-factory/despejo/cauda`<br>L27: `../../packages/orchestrator/src/despejo/aviso.js` → `@okds/agent-factory/despejo/aviso`<br>L28: `../../packages/orchestrator/src/despejo/costura.js` → `@okds/agent-factory/despejo/costura`<br>L29: `../../packages/orchestrator/src/loop-do-turno.js` → `@okds/agent-factory/loop-do-turno`<br>L30: `../../packages/orchestrator/src/capacidades.js` → `@okds/agent-factory/capacidades` |

### 3.4 Testes que ficam no Igris e mudam de import (3 arquivos)

| Arquivo | Linhas: especificador atual → novo |
|---|---|
| `packages/decisions/test/treino-args.test.js` | L8: `../treino/lib/args.js` → `@okds/agent-factory/decisoes/args` |
| `packages/decisions/test/treino-conferencia.test.js` | L8: `../treino/lib/conferencia.js` → `@okds/agent-factory/decisoes/conferencia`<br>L9: `../treino/lib/conferencia-texto.js` → `@okds/agent-factory/decisoes/conferencia-texto`<br>L10: `../treino/lib/registro.js` → `@okds/agent-factory/decisoes/registro`<br>L11: `../treino/lib/versoes.js` → `@okds/agent-factory/decisoes/versoes`<br>L12: `../treino/lib/caso.js` → `@okds/agent-factory/decisoes/caso`<br>L355: `../treino/lib/registro.js` → `@okds/agent-factory/decisoes/registro` |
| `packages/orchestrator/test/despejo-equivalencia-script.test.js` | L4: `../src/index.js` → `@okds/agent-factory`<br>L5: `../src/prompt-builder.js` → `@okds/agent-factory/prompt-builder`<br>L6: `../src/protocolo/envelope.js` → `@okds/agent-factory/protocolo` (`estrategiaEnvelope` é reexportado)<br>L7: `../src/despejo/config.js` → `@okds/agent-factory` (`normalizarDespejo`, `DESPEJO_PADRAO` são reexportados na raiz)<br>L8: `../src/capacidades.js` → `@okds/agent-factory/capacidades` |

## 4. Parâmetros novos: o valor que o Igris passa, e onde

Regra de F2: padrão neutro + parâmetro; o Igris passa o valor de antes para o comportamento não mudar.

### 4.1 Prefixo do nome do schema do envelope — `prefixoDoEnvelope: 'igris'`

Sem o prefixo o schema sai `envelope`/`envelope_headless`/`envelope_contribuicoes`; com `'igris'`
sai `igris_envelope*` **byte a byte** como hoje (provado por `envelope-schema-contribuicoes.test.js`).
O nome entra na chave de cache de gramática do vendor: esquecer um ponto muda o nome naquele ponto e
invalida o cache dele. **São cinco pontos**, não um:

| Onde (Igris) | Hoje | Passa a |
|---|---|---|
| `packages/executor/src/orchestration/fabrica/perfil.js` L346 (config do chat) | `protocoloOpts: { headless: false }` | `protocoloOpts: { headless: false, prefixoDoEnvelope: 'igris' }` |
| `packages/executor/src/orchestration/fabrica/turno.js` L1482 | `resolveEnvelopeSchema({ headless: ctx.headless === true, comContribuicoes: comportamentoLigado })` | acrescentar `prefixoDoEnvelope: 'igris'` |
| `packages/executor/src/executor.js` L363 | `resolveEnvelopeSchema({ headless: ctx.headless === true })` | acrescentar `prefixoDoEnvelope: 'igris'` |
| `packages/powers/src/powers/async-shadows/agents/motor-llm.js` L534 | `criarOrquestrador(perfilAgenteLlm({…}))` | ver abaixo |
| `packages/shadows/src/runner/in-process.js` L418 | `criarOrquestrador(perfilShadowLoop({…}))` | ver abaixo |

Os perfis `perfilAgenteLlm` (`orquestrador/src/perfis/agente-llm.js`) e `perfilShadowLoop`
(`shadow-loop.js`) fixam `headless: true` e aceitam a opção **`prefixoDoEnvelope`** na própria
`entrada` (ao lado de `provider`, `decorarTool`, `aoTexto`, `aoEvento`), que vai para
`protocoloOpts.prefixoDoEnvelope`. Sem a opção, o nome é neutro (`envelope_headless`); sem tools,
`perfilShadowLoop` usa protocolo `nativo` (sem schema) e ignora a opção. Nos dois chamadores,
acrescentar `prefixoDoEnvelope: 'igris'` à entrada do perfil:

```js
// packages/shadows/src/runner/in-process.js L418
criarOrquestrador(perfilShadowLoop({ /* …como hoje… */, prefixoDoEnvelope: 'igris' }));
// packages/powers/src/powers/async-shadows/agents/motor-llm.js L534
(deps.perfilAgenteLlm || perfilAgenteLlm)({ /* …como hoje… */, prefixoDoEnvelope: 'igris' });
```

(`motor-llm.test.js` espia o perfil por `deps.perfilAgenteLlm`: o teste pode afirmar a opção na
entrada.) Esses são os dois únicos chamadores dos perfis fora de testes (grep no Igris).
`bancada/cenarios/chat-igris.mjs` L28 repete `protocoloOpts: { headless: false }`: mesmo ajuste (só
fidelidade da bancada).

As constantes `SCHEMA_COMPLETA`/`SCHEMA_HEADLESS` importadas pelos testes
`executor/test/{envelope-stream-schema-integration,streaming-envelope-deltas}.test.js` agora têm nome
neutro; os dois testes só usam `.schema`/identidade (conferido por grep: nenhum afirma `igris_envelope`),
então seguem verdes. Para o nome do Igris: `schemasDoEnvelope('igris').completa`.

### 4.2 Provedor do cliente de decisão — `criarProvedorDeCliente`

Onde: `packages/executor/src/orchestration/decisoes.js` L103 (`PROVEDOR_CLIENTE`).

```js
const PROVEDOR_CLIENTE = criarProvedorDeCliente({
  listarContas: listAccounts,
  fetchImpl: TRANSPORTE,
  timeoutMs: Math.max(TETO_TARDIO_MS, TIMEOUT_MS),
  aquecerDecisao,
  criarProtocoloDoGateway: (conta) => buildProtocol(conta),
  // novos (eram lidos de process.env / literais dentro de nucleo/provedor.js e cliente-gateway.js):
  modoBancada: process.env.IGRIS_TEST === '1' || process.env.NODE_ENV === 'test' || process.env.IGRIS_DECISOES_BANCADA === '1',
  chaveDeBancada: process.env.IGRIS_DECISOES_CHAVE,
  consumer: 'module:executor',
  xTitle: 'igris-decisions',
});
```

- `consumer` agora é **obrigatório** (lança sem ele), em `criarProvedorDeCliente` e em `criarClienteDoGateway`.
- **Mudança de momento da leitura:** o `process.env` era lido a cada `obter()`; agora é lido uma vez,
  quando `decisoes.js` é importado. Conferido: nenhum teste do Igris **seta** `IGRIS_DECISOES_CHAVE`
  depois do import (`executor/test/decisoes.test.js` L741–861 só faz `delete` e restaura;
  `_ambiente-de-teste.js` fixa `''` antes). Se algum dia um teste precisar ligar a bancada, tem de
  construir outro provedor com `modoBancada: true`.
- `eval/_cliente.mjs` já passa `consumer: 'eval:decisions'` ao `criarClienteDoGateway` (L55): sem mudança.
  Nas três chamadas de `criarCliente` (L71, L92, L106) acrescentar `xTitle: 'igris-decisions'` (o
  padrão agora é `'agent-factory'`; `opcoes` ainda pode sobrepor).

### 4.3 Serviço de treino — `raizPowers` e `dirCache`

Onde: `packages/api/src/routes/decisoes.js`, função `criarServicoDeTreinoReal` (L30–40).

```js
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const RAIZ_POWERS = resolve(fileURLToPath(new URL('../../../powers/src/powers', import.meta.url)));
// …
return (deps.criarServicoDeTreino ?? criarServicoDeTreino)({
  // …as opções de hoje…
  raizPowers: RAIZ_POWERS,                              // sem padrão: RAIZ_POWERS_PADRAO saiu do pacote
  dirCache: (dataDir) => join(dataDir, 'igris', 'cache'), // padrão neutro é <dataDir>/agent-factory/cache
});
```

`dirCache` tem de ser o do Igris: `selecao-embeddings.json` é o **mesmo arquivo** que o cache de
semântica da seleção (`fabrica/perfil.js`, `<dataDir>/igris/cache/`); com o padrão neutro o treino
passaria a gravar noutro diretório e o ganho do cache compartilhado some em silêncio.
`raizPowers` (caminho conferido: `api/src/routes` → `../../../` = `packages/`) é repassado ao
`extrairCasos`/`pisoIncondicional` pelo serviço.

### 4.4 Embedder do roteamento (treino) — `embedderDoRoteamento({ resolver })`

O padrão (import dinâmico de `@igris/embeddings`) saiu; `resolver` é obrigatório. **Nenhum chamador
no Igris hoje** (grep em todo o repositório: só `treino/lib/embedder.js` e testes). O treino dentro do
app usa `obterEmbedder: () => getEmbedderDoKairos()` (`api/src/routes/decisoes.js` L35), que não passa
por aqui. Quem vier a chamar (uma CLI de treino): `embedderDoRoteamento({ resolver: getProviderForRole })`
com `getProviderForRole` de `@igris/embeddings`.

### 4.5 Cliente HTTP — `criarCliente({ xTitle })`

Coberto em 4.2 (via provedor e via `eval/_cliente.mjs`).

### 4.6 `nomeExposto` e as peças de apoio

Sem parâmetro. `nomeExposto` agora delega a `exposedName` do kairos (resultado igual; nome prefixado
com mais de 64 caracteres lança já em `nomeExposto`, antes lançava só em `montarProviders`).
As 7 peças de apoio são só troca de import (seção 3).

### 4.7 Opcionais (nada muda se o Igris não passar)

`config.pricingResolver`, `config.provider(ctx)` (a função de hoje ignora o argumento:
`turno.js` L2054), `config.genos` (opções extras ao `createOrchestrator` do genos; as da fábrica vencem).

## 5. Ajustes de teste/script que não são troca de especificador

| Onde | Mudança |
|---|---|
| `packages/executor/test/fabrica-piso-incondicional.test.js` L9, L20 | `RAIZ_POWERS_PADRAO` saiu do pacote. Definir `const RAIZ_POWERS = resolve(fileURLToPath(new URL('../../powers/src/powers', import.meta.url)))` e usar `pisoIncondicional({ raizPowers: RAIZ_POWERS })`. |
| `packages/decisions/treino/casos.mjs` L3, L7 | idem: `extrairCasos({ dataDir: args.data, raizPowers: args.powers \|\| RAIZ_POWERS })` com `RAIZ_POWERS = resolve(fileURLToPath(new URL('../../powers/src/powers', import.meta.url)))` (igual ao que `sombra.mjs` L15 já faz). |
| `packages/api/test/routes/decisoes.test.js` L107, L186, L217 | `criarServicoDeTreino({ obterPiso, obterDataDir, obterEmbedder })` sem `extrair` usa o `extrairCasos` real, que agora lança sem `raizPowers`. Passar `raizPowers` (ou `extrair` de teste) **(conferir** quais chegam à extração)**. |
| `packages/decisions/test/perguntas-agnosticas.test.js` L26 | `PERGUNTAS_PATH` deixa de existir como arquivo local: `fileURLToPath(import.meta.resolve('@okds/agent-factory/decisoes/perguntas'))`. `POWERS_DIR` (L27) fica como está (o teste continua em `packages/decisions/test`). |
| `packages/orchestrator/test/despejo-equivalencia-script.test.js` | só imports (3.4) + os subpaths `despejo/*` de `scripts/eval/despejo.mjs` (seção 0). |

## 6. Testes que ficam no Igris (D9 + F1)

| Teste | Por quê fica | O que muda |
|---|---|---|
| `packages/orchestrator/test/despejo-equivalencia-script.test.js` | compara com `scripts/eval/despejo.mjs` | imports (3.4) |
| `packages/orchestrator/test/bancada.test.js` | testa a `bancada/` | nada nele; a `bancada/` muda (3.3) |
| `packages/decisions/test/treino-args.test.js` | testa as CLIs `treino/*.mjs` | import de `args` (3.4) |
| `packages/decisions/test/treino-conferencia.test.js` | idem | imports (3.4) |
| `packages/decisions/test/perguntas-agnosticas.test.js` | **2 casos** que varrem `powers/src/powers` (o resto do arquivo foi para `decisoes/test/`; recortar o arquivo do Igris para só os 2 casos e o que eles usam é decisão da ligação **(conferir)**) | caminho de `perguntas.js` (seção 5) |

Os testes dos pacotes `orchestrator` e `decisions` do Igris continuam rodando por `node --test test/*.test.js`
(script `test` dos dois `package.json`), então o `suite.mjs` os enxerga como os mesmos dois pacotes.
Os 7 testes de apoio do executor (`fabrica-{continuidade,intencao,consultas-anteriores,chave-capacidades,conversa,valores-do-registro,pista-contexto}.test.js`)
**passam a existir só aqui** (`apoio/test/`): apagar no Igris.

## 7. O que o Igris apaga

| Caminho | Nota |
|---|---|
| `packages/orchestrator/src/` | toda; `orquestrador/src/` |
| `packages/orchestrator/test/` | tudo menos `despejo-equivalencia-script.test.js` e `bancada.test.js` |
| `packages/orchestrator/{ARCHITECTURE,CAPACIDADES,REGRAS}.md` | moram em `orquestrador/` (deixar um ponteiro de 1 linha ou apagar) |
| `packages/orchestrator/SINCRONIA.md` | não veio para cá; destino a decidir (o registro Igris ↔ Ariadne perde o sentido quando o Ariadne também consumir o pacote) |
| `packages/decisions/src/` | toda; `decisoes/src/` |
| `packages/decisions/treino/lib/` | `decisoes/treino/lib/` |
| `packages/decisions/test/` | tudo menos `treino-args`, `treino-conferencia` e `perguntas-agnosticas` (inclui `helpers/fixtures.js`) |
| `packages/decisions/ARCHITECTURE.md` | idem orquestrador |
| `packages/executor/src/orchestration/fabrica/{continuidade,intencao,consultas-anteriores,chaveDasCapacidades,conversa,valores-do-registro,pista-contexto}.js` | `apoio/src/` |
| `packages/executor/test/fabrica-{continuidade,intencao,consultas-anteriores,chave-capacidades,conversa,valores-do-registro,pista-contexto}.test.js` | `apoio/test/` |

**Não apagar:** `fabrica/guarda-de-repeticao.js`, `fabrica/indice-de-capacidades.js` (ficam, D8),
`bancada/`, `eval/`, `treino/*.mjs`, `scripts/eval/despejo.mjs`.

Documentação do Igris que cita os caminhos antigos: 122 arquivos em `docs/`, `CLAUDE.md` e `.claude/`
casam com `@igris/(orchestrator|decisions)` ou `packages/(orchestrator/src|decisions/(src|treino/lib))`;
os vivos são `docs/project-architecture/{_index,decisions,fabrica,prompt-assembly-map,powers,powers-porte-0.501,agents/power,diagramas/fluxo-do-turno-fabrica}.md`.
Os históricos (specs/planos/pendências/insights) ficam como estão. Comando:
`git grep -lE "@igris/(orchestrator|decisions)|packages/(orchestrator/src|decisions/(src|treino/lib))" -- docs CLAUDE.md .claude`.

## 8. Onde passam a morar `bancada/` e as CLIs

Proposta de mínimo atrito (**decisão do dono**, não do pacote): **não mover nada**. `packages/orchestrator/`
fica só com `bancada/`, `test/` (os 2 testes) e um `package.json` magro; `packages/decisions/` fica
com `eval/`, `treino/{casos,conferencia,sombra,treinar}.mjs`, `test/` (os 3 testes) e um `package.json` magro
(seção 1). Os nomes `@igris/orchestrator` e `@igris/decisions` ficam enganosos (já não são a fábrica);
renomear (por exemplo `packages/fabrica-bancada`, `packages/decisoes-treino`) mexe em
`pnpm-workspace.yaml`, nos `package.json` e na ordem de `scripts/suite.mjs` e pode vir depois, sem
pressa. Como importam:

- `bancada/**` e `eval/**`: `import { … } from '@okds/agent-factory'` (e subpaths `decisoes/*`), tabela 3.3.
  Eles continuam alcançando o resto do Igris por caminho relativo (`../../powers/src/fabrica/capacidade.js`,
  `../../../executor/src/orchestration/fabrica/{base,legendas}.js`, `../../../memory/src/fonte/index.js`,
  `../../../executor-registry/src/index.js`) — nada disso muda.
- `treino/*.mjs`: `./lib/<x>.js` vira o subpath `decisoes/<x>` (tabela 3.3). Os que dependem dos
  subpaths `decisoes/{args,conferencia,conferencia-texto,linha-sinal,sombra}` (seção 0): `conferencia.mjs`, `sombra.mjs`, `treinar.mjs`. `casos.mjs` só precisa do
  ajuste de `raizPowers` (seção 5).
- `usoDoCabecalho(import.meta.url)` (de `treino/lib/args.js`) lê o cabeçalho do próprio `.mjs` que o chama:
  continua funcionando com a lib em `node_modules`, porque o argumento é a URL da CLI.

## 9. Mudanças de comportamento ao ligar

Além da troca de especificadores e dos parâmetros (que, com os valores da seção 4, são neutras):

1. **Histórico sem bloco de operações duplicado** (porte do Ariadne `7d5e76e5`): o texto da resposta
   do modelo que traga um `<turn_operations>` imitado tem esse bloco removido antes de a plataforma
   costurar o seu. Bloco **aberto sem fechamento descarta o resto do texto** (pendência: avaliar se é o
   desejado). Afeta o que vai para o histórico, portanto o prefixo do prompt dos turnos seguintes
   (cache de prompt do vendor pode perder acerto uma vez).
2. **Tool desconhecida no protocolo nativo orienta `call_capability`** (`1901880d`): só quando a estratégia
   tem `registraCapacidades === false`; em `envelope`/`fence` a mensagem segue a de antes.
3. **`config.provider` é chamado com o ctx do turno** (`9f3fd177`): a função do Igris ignora o argumento.
4. **kairos 0.840 → 0.841** (seção 1): mudança de dependência, não da biblioteca.
5. **Leitura de env do provedor de decisão passa a uma vez, no import** (4.2).
6. **Nome prefixado >64 caracteres** lança em `nomeExposto` (antes, em `montarProviders`): mesmo erro, mais cedo.
7. Nada mais muda de comportamento por construção: a cópia é literal, a genericização mantém o valor
   do Igris por parâmetro (cada teste que afirmava o valor do Igris continua afirmando, passando-o por config).

## 10. Ordem sugerida e verificação

1. (Pacote) fechar a seção 0.1, taguear.
2. Igris/main: `node scripts/suite.mjs --baseline`; medir deriva.
3. `node scripts/worktree.mjs new ligar-agent-factory --plano …`.
4. Catálogo + `package.json` + override; `pnpm install`; `node scripts/check-git-deps.mjs`;
   `pnpm why genos-orchestrator` e `pnpm why @okds/kairos` → uma cópia só. Rodar a suíte só com o bump
   do kairos (commit próprio).
5. Trocar especificadores (seção 3) **sem apagar nada** — as duas cópias coexistem; commit mecânico.
6. Passar os parâmetros (seção 4) e os ajustes da seção 5; commit.
7. `node scripts/suite.mjs --so executor,powers,shadows,api,orchestrator,decisions`; só então:
8. Apagar o que a seção 7 lista (commit separado, para o diff de review ser só remoção).
9. `node scripts/suite.mjs` completo, comparando com a baseline: **0 regressões**; pacotes
   `orchestrator`/`decisions` continuam verdes (com muito menos testes — esperado: os testes foram
   para cá). O `suite.mjs` compara por pacote, não por teste: a perda de testes não aparece como
   regressão, então a contagem de testes movidos tem de ser conferida à mão (o número de testes aqui:
   `pnpm test` neste repositório).
10. Teste de comportamento real (bancada com relógio) do chat completo e de uma sombra headless: o
    schema que chega ao provider tem de se chamar `igris_envelope` / `igris_envelope_headless`
    (confere os cinco pontos da 4.1).
11. Entrega ≠ merge: perguntar ao dono "merge, ou usar na worktree?".

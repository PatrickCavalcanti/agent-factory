# Origem

`@okds/agent-factory` nasceu como **cópia sem histórico** de `PatrickCavalcanti/igris`
no commit **`430d2c9`** (`docs(insights): passagem da extração da fábrica para repo próprio`,
31/10/2026). O histórico da fábrica continua consultável no Igris (`git log -- packages/orchestrator
packages/decisions`). Spec: [`docs/specs/2026-10-31-agent-factory-design.md`](./docs/specs/2026-10-31-agent-factory-design.md);
plano: [`docs/planos/2026-10-31-agent-factory-criacao.md`](./docs/planos/2026-10-31-agent-factory-criacao.md).

Cópia sem `git filter-repo` de propósito (D3 da spec): a ferramenta não foi provada executando.

## Mapa pasta a pasta

Os caminhos relativos internos de cada módulo não mudaram (cópia de pasta inteira).

| Igris (`430d2c9`) | Aqui | Observação |
|---|---|---|
| `packages/orchestrator/src/` | `orquestrador/src/` | Cópia + genericização (ver lista de commits abaixo). |
| `packages/orchestrator/test/` | `orquestrador/test/` | Menos `despejo-equivalencia-script.test.js` e `bancada.test.js` (ficam no Igris). `refino.test.js` lê a versão do kairos pelo pacote resolvido, não por caminho fixo. |
| `packages/orchestrator/{ARCHITECTURE,CAPACIDADES,REGRAS}.md` | `orquestrador/{ARCHITECTURE,CAPACIDADES,REGRAS}.md` | Links para fora do pacote viram links absolutos no Igris @ `430d2c9`; nota de cabeçalho. |
| `packages/decisions/src/` | `decisoes/src/` | Cópia + `2c7d258` (identidade do Igris vira parâmetro). |
| `packages/decisions/treino/lib/` | `decisoes/treino/lib/` | Idem. |
| `packages/decisions/test/` | `decisoes/test/` | Menos `treino-args.test.js` e `treino-conferencia.test.js`; em `perguntas-agnosticas.test.js` saem só os dois casos que varrem `powers/src/powers`. |
| `packages/decisions/ARCHITECTURE.md` | `decisoes/ARCHITECTURE.md` | Idem orquestrador; envs/consumer atualizados para parâmetros. |
| `packages/executor/src/orchestration/fabrica/{continuidade,intencao,consultas-anteriores,chaveDasCapacidades,conversa,valores-do-registro,pista-contexto}.js` | `apoio/src/` (mesmos nomes) | Peças puras do host (`8ea5198`). `valores-do-registro` importa `../../decisoes/src/loop/valores-rotulados.js` (era `@igris/decisions/loop/valores-rotulados`). |
| `packages/executor/test/fabrica-{continuidade,intencao,consultas-anteriores,chave-capacidades,conversa,valores-do-registro,pista-contexto}.test.js` | `apoio/test/{continuidade,intencao,consultas-anteriores,chave-capacidades,conversa,valores-do-registro,pista-contexto}.test.js` | Passam a existir só aqui. |
| `packages/{orchestrator,decisions}/package.json` | `package.json` (raiz) | Um pacote só; `exports` com os nomes de hoje (decisões sob `./decisoes`); kairos e genos como peers. |

## O que ficou fora, e por quê

| Fica no Igris | Por quê |
|---|---|
| `packages/orchestrator/bancada/` | Importa o Igris por caminho relativo (`powers/src/fabrica`, `executor/.../fabrica`, `memory/src/fonte`, `semantic-routing`…). (D7) |
| `packages/decisions/eval/` | Idem (`@igris/providers`, logs do dono). (D7) |
| `packages/decisions/treino/*.mjs` (CLIs `casos`, `conferencia`, `sombra`, `treinar`) | São o lado do Igris do treino; usam `raizPowers` e logs dele. A biblioteca (`treino/lib/`) veio. (D7) |
| `packages/executor/src/orchestration/fabrica/` (resto: `turno.js`, `loop.js`, `perfil.js`, `selecao.js`, `treino-continuo.js`…) | Cola do host: depende de `ctx`, registry de powers, banco, sessão. (D7) |
| `fabrica/guarda-de-repeticao.js` | Lê env do Igris (limite). Pendência: poderia descer com o limite por parâmetro. |
| `fabrica/indice-de-capacidades.js` | Depende de `contribuicoes.js`, que importa `@igris/executor-registry`. (D8) |
| `packages/powers/src/fabrica/`, `packages/memory/src/fonte/`, `@igris/embeddings`, `createGenosProviderForTier` (`@igris/shadows`) | A biblioteca recebe capacidades, fonte de memória, `Embedder` e provider por injeção. (D7) |
| `packages/orchestrator/SINCRONIA.md` | Registro da sincronia Igris ↔ Ariadne; não faz parte da biblioteca. Destino no Igris: a decidir na ligação. |
| `packages/orchestrator/test/despejo-equivalencia-script.test.js` | Compara com `scripts/eval/despejo.mjs` do Igris. (D9) |
| `packages/orchestrator/test/bancada.test.js` | Testa a `bancada/`. (D9) |
| `packages/decisions/test/treino-args.test.js`, `treino-conferencia.test.js` | Testam as CLIs de `treino/*.mjs`. (D9) |
| 2 casos de `packages/decisions/test/perguntas-agnosticas.test.js` | Varrem `packages/powers/src/powers`. Os demais casos vieram. (D9) |

## Commits deste repositório que divergem da cópia literal

A cópia literal é `313a67a`. Tudo depois dela é divergência intencional:

| Commit | O que mudou |
|---|---|
| `209fe07` | `nomeExposto` delega para `exposedName` de `@okds/kairos/core/names` (nome prefixado >64 caracteres lança já em `nomeExposto`). |
| `a7353d3` | Nome do schema do envelope por prefixo (`protocoloOpts.prefixoDoEnvelope`); padrão neutro `envelope`/`envelope_headless`/`envelope_contribuicoes`; `schemasDoEnvelope(prefixo)`. |
| `2c7d258` | Decisões sem identidade do Igris: `modoBancada`/`chaveDeBancada`/`consumer`/`xTitle`; `embedderDoRoteamento({ resolver })` e `raizPowers` obrigatórios; `dirCache` do treino por parâmetro. |
| `8ea5198` | Módulo `apoio/`. |
| `c45d15d`, `fac102d`, `c52b2b4`, `af11bb5` | Portes do Ariadne (tabela abaixo). |
| `355b9a3` | `config.genos`: opções extras para o `createOrchestrator` do genos. |
| `116b2c6` | `test/contrato.test.js` (congela subpaths e nomes exportados) e `test/pureza.test.js`. |

Além desses, `package.json` (um pacote, `exports`, peers) e o script `test` diferem dos dois
`package.json` de origem desde a cópia (`313a67a`, `8ea5198`, `116b2c6` os tocam).

## Remendos do Ariadne portados

Origem: `/home/user/ariadne-artifact-studio`, `src/fabrica/`, mudanças desde a sincronia `d6c1d17f`
(22/09) que não vieram do Igris.

| Ariadne | Aqui | Resumo |
|---|---|---|
| `26be46a9` | `c45d15d` | `config.pricingResolver` repassado ao genos. |
| `9f3fd177` | `fac102d` | `config.provider(ctx)` recebe o ctx do turno. |
| `1901880d` | `c52b2b4` | Tool de catálogo chamada pelo nome ensina `call_capability` no protocolo nativo (`mensagemDeToolDesconhecida`). |
| `7d5e76e5` | `af11bb5` | `removerBlocosDeOperacoes`: tira o `<turn_operations>` imitado pelo modelo antes de costurar o bloco no histórico (aqui só blocos completos; o Ariadne descartava o resto do texto em bloco aberto). |
| não registrado no commit | `355b9a3` | `config.genos` é generalização nova, não porte. O Ariadne tem `outputMode` dedicado (`3c7af48e`); se a relação é essa, **(conferir)**. |

Não portados (viram pendência): `fc2457a8` (instruções de chamada do protocolo dentro do catálogo) e
`b7bec589` (ref no catálogo nativo; construtor de prompt recebendo a estratégia). Ver
[`docs/pendencias/2026-10-31-criacao.md`](./docs/pendencias/2026-10-31-criacao.md).

## Medir a deriva do Igris desde a origem

O Igris segue mudando a fábrica enquanto a ligação não acontece. Antes de ligar, e a cada rebase de
ligação, listar o que mudou lá desde `430d2c9` nos caminhos que viraram esta biblioteca:

```sh
IGRIS=/caminho/do/igris
F=packages/executor/src/orchestration/fabrica
T=packages/executor/test
git -C "$IGRIS" diff 430d2c9..HEAD --stat -- \
  packages/orchestrator/src packages/orchestrator/test packages/orchestrator/ARCHITECTURE.md \
  packages/orchestrator/CAPACIDADES.md packages/orchestrator/REGRAS.md \
  packages/decisions/src packages/decisions/test packages/decisions/treino/lib packages/decisions/ARCHITECTURE.md \
  $F/continuidade.js $F/intencao.js $F/consultas-anteriores.js $F/chaveDasCapacidades.js \
  $F/conversa.js $F/valores-do-registro.js $F/pista-contexto.js \
  $T/fabrica-continuidade.test.js $T/fabrica-intencao.test.js $T/fabrica-consultas-anteriores.test.js \
  $T/fabrica-chave-capacidades.test.js $T/fabrica-conversa.test.js $T/fabrica-valores-do-registro.test.js \
  $T/fabrica-pista-contexto.test.js
```

Tire o `--stat` para ver o diff inteiro. Saída vazia = nenhuma deriva. Cada mudança que aparecer
tem de ser reaplicada aqui (nos nomes novos: `orchestrator/` → `orquestrador/`, `decisions/` →
`decisoes/`, peças do executor → `apoio/`) antes de a ligação seguir, e o sha de origem acima deve
ser atualizado. Ao fim da ligação o Igris apaga as cópias e este comando deixa de ter sentido.

# @okds/agent-factory

A **fábrica**: o mecanismo que decide, a cada turno, o que entra no contexto do modelo e monta o
prompt. Extraída do Igris (`igris@430d2c9`, ver [`ORIGEM.md`](./ORIGEM.md)) para ser reutilizada por
vários projetos. Um pacote, três módulos:

| Módulo | Pasta | O que faz |
|---|---|---|
| Orquestrador | `orquestrador/` | Declara capacidades (poderes/tools), escolhe o que carregar por turno (piso × semântico, sobre o kairos), monta o prompt, roda o loop do genos com o protocolo de resposta (`envelope`, `fence` ou `nativo`). Ler [`orquestrador/ARCHITECTURE.md`](./orquestrador/ARCHITECTURE.md) e [`orquestrador/REGRAS.md`](./orquestrador/REGRAS.md). |
| Decisores | `decisoes/` | Os decisores que alimentam a seleção: Jev (decisão por modelo), decisor local (cabeça treinada sobre embeddings), loop de decisão, refinadores por anel e o treino (registro de casos, versões, lote). Ler [`decisoes/ARCHITECTURE.md`](./decisoes/ARCHITECTURE.md). |
| Apoio | `apoio/` | Peças puras do host que não dependem do Igris: continuidade entre turnos, leitura da intenção, conversa a partir do histórico, pista de contexto, valores do registro. |

Estado: **0.1.0**, cópia do Igris genericizada. O texto dos documentos copiados ainda descreve o
Igris como host de referência; o que ainda é vocabulário do Igris está em
[`docs/pendencias/2026-10-31-criacao.md`](./docs/pendencias/2026-10-31-criacao.md).

## Instalação

Sem registry: dependência git por semver (tag `vX.Y.Z` no repositório).

```json
{
  "dependencies": {
    "@okds/agent-factory": "git+https://github.com./PatrickCavalcanti/agent-factory.git#semver:^0.1.0"
  }
}
```

**O ponto depois de `github.com` é de propósito** (FQDN absoluto). Sem ele o resolver do pnpm trata
o host como "hospedado" e sonda cada repositório uma vez por site de declaração; qualquer sonda
HTTPS que falhe vira fallback silencioso para SSH e o install morre com
`Permission denied (publickey)`. Mesma regra e mesma justificativa do comentário do catálogo em
`pnpm-workspace.yaml` do Igris (a guarda é `scripts/check-git-deps.mjs` lá). Num projeto que usa
catálogo do pnpm, a linha acima vai no catálogo e o `package.json` declara `"catalog:"`.

### Peers: kairos e genos, UMA cópia de cada

`@okds/kairos` (`^0.841.261021`) e `genos-orchestrator` (`^0.3.12`) são **peerDependencies** —
semver, não URL git, porque o pnpm recusa URL git em peer. O consumidor declara os dois (com a URL
git, como faz para qualquer dependência privada) e `zod` vem junto como dependência normal.

O kairos traz o genos como dependência própria e o bridge dele cria o `ToolRegistry` que a fábrica
entrega ao laço do genos: há `instanceof` entre as duas pontas, então o processo precisa resolver
**uma única cópia** do genos. Se o kairos puxar uma versão do genos diferente da do consumidor, são
duas cópias no mesmo turno e o erro aparece longe da causa. O consumidor fixa a do kairos na mesma
do genos com um override, no formato que o Igris usa (commit que o lockfile resolve para a linha do
catálogo; faixa de versão não basta, o pnpm resolve a faixa de novo para o kairos):

```yaml
# pnpm-workspace.yaml do consumidor
overrides:
  "@okds/kairos>genos-orchestrator": "git+https://github.com./PatrickCavalcanti/genos-orchestrator.git#<commit do lockfile>"
```

Este repositório só usa os dois como `devDependencies` (para rodar os testes) e instala assim:
`pnpm install` com `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf'
GIT_CONFIG_VALUE_0='https://github.com./'` **no ambiente do comando** (só em ambiente de nuvem cujo
proxy não aceita o host com ponto; nunca escrito em arquivo do repositório).

Node `>=22`.

## Exemplo mínimo

Um orquestrador com uma capacidade (`agenda`) e um provider de mentira que responde com um envelope
JSON. Em produção `provider` é uma função que devolve um provider do genos de verdade. O exemplo
foi executado contra esta árvore e imprime `completed envelope_headless`.

```js
import { z } from 'zod';
import { criarOrquestrador } from '@okds/agent-factory';

const provider = () => ({
  name: 'fake', model: 'fake-1',
  capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true,
                  nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
  async generate() {
    return { text: JSON.stringify({ blocos: [{ chat: 'Nada hoje.', comandos: [] }] }), stopReason: 'completed' };
  },
});

const orq = criarOrquestrador({
  base: () => [{ nome: 'identidade', conteudo: '<identidade>Assistente de agenda.</identidade>' }],
  capacidades: [{
    id: 'agenda',
    descricao: 'Consulta a agenda do usuário.',
    tools: [{
      name: 'listar',
      description: 'Lista eventos de um dia.',
      schema: z.object({ dia: z.string() }),
      handler: async ({ dia }) => ({ eventos: [], dia }),
    }],
  }],
  protocolo: 'envelope',
  protocoloOpts: { headless: true },   // + { prefixoDoEnvelope: 'meu-app' } para nomear o schema
  provider,                            // chamado a cada turno com o ctx do turno
  decorarTool: (_nome, definicao) => definicao,
});

const { resultado, schema } = await orq.executarTurno({ texto: 'o que tenho hoje?' });
console.log(resultado.type, schema.name); // completed envelope_headless
```

Pontos que mordem:

- O nome exposto de uma tool é `<capacidade>__<tool>` (`agenda__listar`); é esse nome que o
  modelo chama. Passe pela `nomeExposto` (`@okds/agent-factory/capacidades`) quando precisar dele.
- `decorarTool` é onde o host embrulha cada handler (autorização, rastro, orçamento). Se omitir,
  o padrão é o handler como está.
- `protocoloOpts.prefixoDoEnvelope` define o prefixo do **nome do schema** enviado ao provider
  (`<prefixo>_envelope*`; sem ele, `envelope`, `envelope_headless`, `envelope_contribuicoes`). O nome
  entra na chave de cache de gramática do vendor: escolha uma vez por host.
- `estado` do turno é opcional; passar um `estado` próprio exige a chave `kairos`
  (`initialSessionState()` de `@okds/kairos/session`), senão o primeiro turno com texto não trivial
  quebra no `discover` do kairos.
- As oito regras de quem monta um orquestrador, e o que cada campo de capacidade faz, estão em
  [`orquestrador/REGRAS.md`](./orquestrador/REGRAS.md) e [`orquestrador/CAPACIDADES.md`](./orquestrador/CAPACIDADES.md).

## Subpaths

Gerado de `package.json` (`exports`). Os do orquestrador **preservam os nomes** que tinham em
`@igris/orchestrator`; os de decisões são os de `@igris/decisions` com prefixo `decisoes/`. Fora desta
lista, qualquer caminho é privado (o `exports` bloqueia import profundo).

| Subpath | Arquivo | Exporta (principais) |
|---|---|---|
| `@okds/agent-factory` | `orquestrador/src/index.js` | `criarOrquestrador`; limiares (`limiaresDoConjunto`, `opcoesDeLimiares`), semântica do catálogo (`aquecerCatalogo`, `recalcularCatalogo`, `entregarSemanticaDoCatalogo`), `normalizarDespejo`/`DESPEJO_PADRAO`, `derivarRefino`, `mensagemDeToolDesconhecida`, `AVISO_TETO_DE_ITERACOES` |
| `@okds/agent-factory/prompt-builder` | `orquestrador/src/prompt-builder.js` | construtor de prompt: `criarConstrutorDePrompt`, `systemVazio`, `removerBlocosDeOperacoes`, `NOMES_PADRAO`, `refDaTool` |
| `@okds/agent-factory/capacidades` | `orquestrador/src/capacidades.js` | `montarProviders`, `nomeExposto`, `toolEhFixa`, `toolsExpostas`, `tudoPiso` |
| `@okds/agent-factory/calibracao` | `orquestrador/src/calibracao.js` | `calibrarLimiares`, `PARAMETROS_PADRAO` |
| `@okds/agent-factory/cache-exemplos` | `orquestrador/src/cache-exemplos.js` | `envolverEmbedderComDisco` |
| `@okds/agent-factory/protocolo` | `orquestrador/src/protocolo/index.js` | `estrategiaEnvelope`/`Fence`/`Nativo`, `resolverProtocolo`, `AVISO_PERTO_DO_TETO` |
| `@okds/agent-factory/protocolo/envelope-schema` | `orquestrador/src/protocolo/envelope-schema.js` | `schemasDoEnvelope(prefixo)`, `resolveEnvelopeSchema`, `SCHEMA_*` (nome neutro) |
| `@okds/agent-factory/perfis/shadow-loop` | `orquestrador/src/perfis/shadow-loop.js` | `perfilShadowLoop` |
| `@okds/agent-factory/perfis/agente-llm` | `orquestrador/src/perfis/agente-llm.js` | `perfilAgenteLlm` |
| `@okds/agent-factory/loop-do-turno` | `orquestrador/src/loop-do-turno.js` | `espacoDoLoop`, `capacidadesDoLoop`, `entregaDoLoop`, `refsAcompanhantes`… |
| `@okds/agent-factory/decisoes` | `decisoes/src/index.js` | `decidir`, `aplicarGates`, `criarCliente`, `criarClienteDoGateway`, `aquecer`, `entreAspas`… |
| `@okds/agent-factory/decisoes/cliente` | `decisoes/src/cliente.js` | `criarCliente` (OpenRouter; `xTitle`) |
| `@okds/agent-factory/decisoes/catalogo` | `decisoes/src/catalogo.js` | `montarCriteria`, `descricaoDaTool` |
| `@okds/agent-factory/decisoes/estado` | `decisoes/src/estado.js` | `montarEstado` |
| `@okds/agent-factory/decisoes/gates` | `decisoes/src/gates.js` | `aplicarGates`, `CORTES_PADRAO` |
| `@okds/agent-factory/decisoes/local` | `decisoes/src/local/index.js` | decisor local: cabeça, índice, cortes, refinador local |
| `@okds/agent-factory/decisoes/loop` | `decisoes/src/loop/index.js` | `rodarLoop` e constantes do loop do Jev |
| `@okds/agent-factory/decisoes/loop/valores-rotulados` | `decisoes/src/loop/valores-rotulados.js` | `extrairRotulados`, `mesclarRotulados` |
| `@okds/agent-factory/decisoes/nucleo` | `decisoes/src/nucleo/index.js` | núcleo genérico: `perguntar`, `choice`/`noul`/`score`, `criarProvedorDeCliente` |
| `@okds/agent-factory/decisoes/perguntas` | `decisoes/src/perguntas.js` | textos e critérios das perguntas |
| `@okds/agent-factory/decisoes/treino` | `decisoes/treino/lib/servico.js` | `criarServicoDeTreino`, `ErroDeTreino` |
| `@okds/agent-factory/decisoes/caso` | `decisoes/treino/lib/caso.js` | `montarCaso`, `triar`, `conferir` |
| `@okds/agent-factory/decisoes/registro` | `decisoes/treino/lib/registro.js` | registro de casos e estado do treino |
| `@okds/agent-factory/decisoes/versoes` | `decisoes/treino/lib/versoes.js` | versões das cabeças |
| `@okds/agent-factory/decisoes/lote` | `decisoes/treino/lib/lote.js` | `atualizarPorLote` |
| `@okds/agent-factory/decisoes/trava` | `decisoes/treino/lib/trava.js` | `tentarTravar`, `travado` |
| `@okds/agent-factory/decisoes/worker-treino` | `decisoes/treino/lib/worker-treino.js` | `treinarCabecaNoWorker` |
| `@okds/agent-factory/decisoes/extrair` | `decisoes/treino/lib/extrair.js` | `extrairCasos`, `pisoIncondicional` (exigem `raizPowers`) |
| `@okds/agent-factory/decisoes/casos` | `decisoes/treino/lib/casos.js` | `mapaDeFuncoes`, `casoDaInteracao`… |
| `@okds/agent-factory/decisoes/dominio` | `decisoes/treino/lib/dominio.js` | primitivas de anel e portão |
| `@okds/agent-factory/decisoes/item-do-registro` | `decisoes/treino/lib/item-do-registro.js` | `itemDoRegistro` |
| `@okds/agent-factory/decisoes/refinadores` | `decisoes/src/refinadores/index.js` | `refinadoresDoChat`, `PADRAO_PROVIDER`/`TOOL`/`SKILL` |
| `@okds/agent-factory/decisoes/transporte` | `decisoes/src/transporte.js` | `criarFetchKeepAlive`, `aquecer` |
| `@okds/agent-factory/apoio/continuidade` | `apoio/src/continuidade.js` | `decidirContinuidade`, `classificarResposta`… |
| `@okds/agent-factory/apoio/intencao` | `apoio/src/intencao.js` | `lerIntencao`, `funcoesParaIntencao`, `textoDaIntencao` |
| `@okds/agent-factory/apoio/consultas-anteriores` | `apoio/src/consultas-anteriores.js` | `consultasDoTurnoDe`, `mapaDeFuncoesDoTurno` |
| `@okds/agent-factory/apoio/chaveDasCapacidades` | `apoio/src/chaveDasCapacidades.js` | `chaveDasCapacidades` |
| `@okds/agent-factory/apoio/conversa` | `apoio/src/conversa.js` | `conversaDoHistorico`, `LIMITES_CONVERSA_PADRAO` |
| `@okds/agent-factory/apoio/valores-do-registro` | `apoio/src/valores-do-registro.js` | `valoresDoRegistro`, `produtoresDasCapacidades` |
| `@okds/agent-factory/apoio/pista-contexto` | `apoio/src/pista-contexto.js` | `decidirPistaDeContexto` |

O teste `test/contrato.test.js` congela esta lista e os nomes exportados de cada subpath
(`test/contrato.snapshot.json`); `test/pureza.test.js` falha se aparecer `@igris/`, `IGRIS_` em
código ou import relativo que saia do pacote.

## Testes

```sh
pnpm install   # (no ambiente de nuvem, com o GIT_CONFIG_* acima)
pnpm test      # node --test: orquestrador/test, decisoes/test, apoio/test e test/
```

Por módulo: `node --test orquestrador/test/*.test.js` (idem `decisoes`, `apoio`).

## Mais

- [`ORIGEM.md`](./ORIGEM.md) — de onde veio, o que ficou de fora, como medir a deriva do Igris.
- [`MIGRACAO-IGRIS.md`](./MIGRACAO-IGRIS.md) — passo a passo para o Igris passar a consumir o pacote.
- [`CHANGELOG.md`](./CHANGELOG.md) · [`docs/specs/`](./docs/specs/) · [`docs/planos/`](./docs/planos/) · [`docs/pendencias/`](./docs/pendencias/)

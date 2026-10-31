// Traduz a declaração de capacidade do host para o registro do @okds/kairos.
//
// PISO x SEMÂNTICO é a única distinção que importa aqui, e ela já existia no
// Igris em forma ad-hoc: `background_agents.tools` é catálogo FECHADO e
// `background_agents.carrega` é, nas palavras do comentário da entidade, "um
// PISO, não um teto — a sessão segue podendo rotear para o resto".
//
// Dois efeitos, dois campos (verificados na fonte do kairos):
// - `loading.always` no PROVIDER: sempre carregado E fora do RANKING
//   (rank-providers.ts pula providers `always` — sem isso um provider de
//   descrição genérica vira "hub" e vence capacidade específica).
// - `pinned` na TOOL: o CONTRATO hidrata sempre que o provider carrega, sem
//   passar por score (resolve/hydrate.ts:116). É o que entrega o "tudo
//   pré-carregado" que um catálogo fechado quer.
//
// Duas saídas, dois consumidores — registro ≠ anúncio:
// - `montarProviders` → registry do KAIROS (prompt: índice, contratos, ranking)
// - `toolsExpostas`   → registry do GENOS (execução: nome exposto + zod)
import { defineProvider } from '@okds/kairos/adapters/native';
import { contratoDeArgumentos } from './contrato.js';

/**
 * @typedef {object} ToolDeclarada
 * @property {string} name
 * @property {string} description
 * @property {import('zod').ZodTypeAny} schema zod — validação na EXECUÇÃO (genos)
 * @property {object} [inputSchema] JSON Schema — exibido no CONTRATO (prompt).
 *   Default `{type:'object',properties:{}}`. Quem tem o JSON Schema original
 *   (power.json, toJsonSchemas) passa aqui; quem só tem zod aceita o default.
 * @property {string} [contract] manual da tool. Default: description + args.
 * @property {'read'|'write'|'delete'} [effect]
 * @property {Record<string, (ctx: any) => Promise<Array<{value: any, description?: string}>>>} [opcoesDe]
 *   Loop do Jev (spec 2026-09-22 §5.2): valores salvos por parâmetro (`{ param: provedor }`) —
 *   o Jev os busca com prazo curto na pré-hidratação do turno, para o modelo escolher em vez de
 *   digitar. Vem de `optionsFrom` no parâmetro + `export const options` do power, resolvido em
 *   `capacidadeDoPower` (`packages/powers/src/fabrica/capacidade.js`).
 * @property {string} [semanticText] Doc de embedding da TOOL — nunca exibido, só
 *   vetorizado (`NativeToolSpec.semanticText`, consumido em
 *   `resolve/discover.js:187`). Existe separado de `description` porque os dois
 *   pagam custos diferentes: `description` vira linha de índice e ocupa contexto
 *   em toda tool consciente, então quer ser curta; este só alimenta o índice
 *   vetorial, então pode ser denso — vocabulário do usuário, sinônimos, formas
 *   de perguntar. Omitido, o kairos cai no fallback `title + description`.
 * @property {string[]} [exemplos] Contrato 0.501 (spec do porte, §4.1): pedidos reais/escritos
 *   que a calibração (`calibrarLimiares`) usa para medir os limiares do kairos — NUNCA embedados
 *   como texto da função (isso é `semanticText`, acima).
 * @property {boolean} [fixa] default: herda `piso` da capacidade. Governa
 *   SÓ `pinned` na tool — `loading.always` do provider continua saindo de
 *   `piso`, sem relação com este campo.
 *
 *   Regra do usuário, literal: "tools mínimas dentro de uma capacidade devem
 *   ser fixas, também devem ser pinadas, porque se eles semanticamente
 *   aderiram a outra parte daquela capacidade, possivelmente as básicas ele
 *   vai precisar também." Ou seja: uma capacidade SEMÂNTICA (`piso: false`,
 *   disputa ranking) pode marcar `fixa: true` em algumas tools para garantir
 *   que, quando o ranking trouxer a capacidade, essas já cheguem com
 *   contrato — sem passar por score individual. É semanticamente válido no
 *   kairos: `pinned` só espera o PROVIDER ser carregado (`resolve/hydrate.js
 *   :116`); dentro de um provider não-`always`, ele aguarda o ranking em vez
 *   de pular o provider inteiro.
 *
 *   ⚠️ **Assimetria deliberada.** `fixa: true` numa capacidade SEMÂNTICA é o
 *   caso de uso (garantir o mínimo quando a capacidade é trazida). `fixa:
 *   false` numa capacidade PISO é permitido pelo tipo, mas PERIGOSO: numa
 *   capacidade `piso: true` todo o provider já é `loading.always`, então uma
 *   tool com `fixa: false` ainda tem o ÍNDICE anunciado sempre (a capacidade
 *   está sempre carregada) mas o CONTRATO só hidrata se o ranking/score da
 *   tool individual a trouxer — o modelo pode ver o nome no índice e chamar
 *   sem o manual, a mesma anatomia do defeito medido no pipeline V2 do
 *   Ariadne (`projeto/tool/ler` chamada com `args: {}`, recusada por campo
 *   obrigatório ausente). A seletividade correta é no nível da CAPACIDADE
 *   (`piso: false` na própria capacidade), não misturando `fixa: false`
 *   dentro de uma capacidade piso.
 * @property {(args: any, ctx: any) => any} handler
 * @property {string[]} [requires] Gate de permissão desta TOOL — repassado cru ao
 *   kairos (`resolve/hydrate.js:24`, `if (can(t.requires, ctx))`) e checado a cada
 *   hidratação. `config.can` do host (`index.js`) é quem lê isto; sem `can` declarado,
 *   o default (`() => true`) ignora `requires` e libera tudo.
 */

/**
 * @typedef {object} CapacidadeDeclarada
 * @property {string} id
 * @property {string} [descricao]
 * @property {string} [semanticText] Doc de embedding da CAPACIDADE — o que o
 *   ranking de providers pontua (`resolve/rank-providers.js:42-46`).
 *   **Obrigatório quando `piso: false`** (ver a guarda em `index.js`): sem ele o
 *   ranking julga a capacidade por uma descrição escrita para humano, que é o
 *   defeito medido no pipeline V2 do Ariadne (catálogo mudo).
 * @property {{ useWhen?: string[], skipWhen?: string[] }} [awareness] Entram no
 *   doc de embedding E no score léxico (`core/hash.js:4-5` monta
 *   "Use quando: …" / "Não use quando: …").
 *
 *   ⚠️ **`skipWhen` atrai o que pretende excluir.** Bag-of-words não entende
 *   negação: a palavra escrita aqui para tirar um assunto passa a pontuar por
 *   esse assunto. Medido no Ariadne (`capacidades/codigo.ts:37-42`): um
 *   `skipWhen` dizendo "os REGISTROS mostrados na tela" fez `codigo` ganhar de
 *   `dados` no léxico (0.400 × 0.200) numa pergunta sobre registros. Regra:
 *   descreva o que fica de fora pelo CAMINHO CERTO ("isso vai por pipeline"),
 *   nunca repetindo o vocabulário do vizinho.
 * @property {string} [instrucoes] `Provider.instructions` do kairos — texto que entra no prompt
 *   SÓ quando a capacidade carrega (bloco `<cap>/instructions`). Ausente ou vazio: cai em
 *   `descricao`. Existe separado porque `descricao` é linha de índice/card (curta) e as
 *   instruções de uma capacidade real (o `prompt.md` de um power do Igris) são longas.
 * @property {ToolDeclarada[]} tools
 * @property {FonteDeclarada} [fonte] Contrato de fonte (spec 2 §3.1): `piso` (contribuições
 *   `floor: true` da fonte, somadas às de `config.contribuicoes` no catálogo — Task 5),
 *   `selecionar(ctx, { vetor1, embedar })` (roda a cada turno — Task 6), `skills()`
 *   (registradas no kairos junto do provider desta capacidade, ao lado das `tools` — Task 5),
 *   `aoFechar(ctx, resultado)` (telemetria de fim de turno — Task 6). Tudo opcional; uma
 *   capacidade sem `fonte` se comporta exatamente como antes.
 * @property {boolean} [piso] default true — fora do ranking, contratos pinned
 * @property {boolean} [prefixarTools] default true — nome exposto vira
 *   `${capId}__${tool}`. `false` expõe o nome CRU da tool. O prefixo existe só
 *   para evitar colisão ENTRE capacidades da mesma fábrica — com uma única
 *   capacidade (catálogo fechado, ex.: `perfis/shadow-loop.js`) ele não
 *   desambigua nada. Correção 2 (Fase 4, paridade): sob prefixo, `toolName`
 *   vazava para `result.history` como `<capId>_notificar_do_agente`, e um
 *   consumidor real (`async-shadows/handlers/delivery.js`) comparava contra o
 *   nome cru — o match zerava em silêncio.
 * @property {boolean} [aliasCru] default false — com prefixo, o registry de execução aceita TAMBÉM o nome cru da tool
 *   como sinônimo (o modelo vê o prefixado; texto de prompt que cite o cru continua resolvendo). Nome cru que mais de
 *   uma capacidade declara (ou que colide com um nome exposto) NÃO vira sinônimo: o prefixado segue valendo e o
 *   orquestrador avisa uma vez (`sinonimosCrus`).
 * @property {string[]} [requires] Gate de permissão desta CAPACIDADE (o PROVIDER
 *   inteiro) — repassado cru ao kairos e checado pelo `can` do host a cada discover
 *   (`resolve/discover.js:340` para provider `piso: true`/`always`, `:351` para
 *   já-carregado, `rank-providers.js:40` para o ranking de `piso: false`). Provider
 *   negado nem entra em `conscious` — a tool não aparece no prompt, ponto.
 * @property {number} [prioridade] Posição do bloco `<capability>` desta capacidade DENTRO do
 *   bloco `<capabilities>` (não confundir com `prioridadeDasCapacidades` do prompt-builder,
 *   que é a posição do bloco INTEIRO na faixa estável do system). Default **500** — quem não
 *   declara concorre pelo mesmo número, e a resolução de colisão na INSERÇÃO (ver
 *   `acharOuCriar` em `prompt-builder.js`) empurra o segundo default para 501, o terceiro para
 *   502, e assim por diante: números crescentes fazem "ordenar por prioridade" e "ordem de
 *   chegada" darem o MESMO resultado para quem nunca declarou nada — é o que faz a ordenação
 *   nunca mudar sozinha.
 *
 *   Quem declara um valor EXPLÍCITO menor que os já acumulados entra ANTES deles — é o poder
 *   deliberado de "colocar coisas antes e depois". O custo que sobra: isso insere NO MEIO da
 *   lista (`acumulado.capacidades`), e tudo que dependia da posição anterior das capacidades
 *   abaixo dela muda de lugar no prompt — mesmo tipo de invalidação que uma prioridade explícita
 *   de contribuição (`ver Block.priority`) já paga. Quem declara precisa saber que está pagando
 *   esse preço; não é um acidente do motor.
 */

/**
 * @typedef {object} FonteDeclarada Contrato de fonte (spec 2 §3.1) — o que uma capacidade
 *   declara quando quer trazer conteúdo de fora do catálogo fechado de tools: memória,
 *   habilidades, contexto selecionado por relevância a cada turno. Referência real:
 *   `packages/memory/src/fonte/index.js#criarFonteDeMemoria`.
 * @property {Array<import('@okds/kairos/core/types').Contribution & { volatil: boolean }>} [piso]
 *   Contribuições `floor: true` — entram no catálogo do agente (Task 5) pela MESMA validação
 *   de `config.contribuicoes` (floor booleano, `volatil` obrigatório, formato de `ref`),
 *   somadas às do host num provider único (`informacoes`).
 * @property {(ctx: any, sem: { vetor1: number[]|null, embedar: (texto: string) => Promise<number[]> }) => Promise<Selecao>} [selecionar]
 *   Chamado a cada turno (Task 6) — decide o que da fonte entra NESTE turno.
 * @property {() => Promise<SkillDeclarada[]>} [skills] Habilidades da fonte — registradas no
 *   kairos junto do provider desta capacidade (Task 5), lado a lado das `tools`. Erro aqui não
 *   derruba o catálogo: a fábrica loga e segue sem skills desta fonte.
 * @property {(ctx: any, resultado: object) => void} [aoFechar] Chamado ao fim do turno
 *   (Task 6) — telemetria/hits, nunca deriva o turno (mesma garantia de `aoEvento`/`aoMontar`).
 */

/**
 * @typedef {object} Selecao Retorno de `FonteDeclarada.selecionar` (Task 6).
 * @property {Array<{ref: string, conteudo: string, motivo?: string, score?: number, prioridade?: number}>} incluidos
 * @property {Array<object>} candidatos Quase-entraram / ficaram de fora — telemetria, nunca vai ao prompt.
 * @property {string[]} carregar ids de capacidade a carregar este turno.
 * @property {string[]} semear ids de skill a semear este turno.
 * @property {string|null} enriquecer Texto de enriquecimento da consulta, ou `null`.
 */

/**
 * @typedef {object} SkillDeclarada
 * @property {string} key convenção do kairos (`validateSkillKey`): `[a-z0-9]([a-z0-9-]*[a-z0-9])?`,
 *   até 64 chars — SEM `_` (é a key de TOOL que proíbe `_`, não esta; ainda assim hífen é a
 *   única pontuação aceita).
 * @property {string} descricao
 * @property {string} [semanticText] Doc de embedding da skill — mesma razão de
 *   `ToolDeclarada.semanticText`; omitido, o kairos cai no fallback (título + descrição).
 * @property {() => Promise<string>} corpo Conteúdo completo da skill, sob demanda.
 * @property {string[]} [exemplos] Contrato 0.501 (spec do porte §5.3): pedidos reais/escritos
 *   que a calibração conta em `resumo.exemplosHabilidades` — o anel `skill` ainda não tem
 *   limiar calculado a partir deles nesta spec. `registrarCapacidadesNoManager` (index.js)
 *   guarda o array cru de `fonte.skills()` em `cap.skillsDeclaradas`, e `exemplosDasCapacidades`
 *   (calibracao.js) lê de lá.
 */

/** JSON Schema aberto honesto para quem só declarou zod. */
const SCHEMA_ABERTO = { type: 'object', properties: {} };

/**
 * O manual de uma tool: a PROSA do host + os ARGUMENTOS renderizados pela
 * fábrica.
 *
 * A divisão é deliberada e é a mesma das legendas: o host sabe o que a tool
 * significa; a FÁBRICA sabe a forma do contrato. Antes disto o `tool.contract`
 * do host substituía o manual INTEIRO, e um host que escrevesse prosa sem os
 * argumentos entregava ao modelo um nome de função sem assinatura — foi
 * exatamente o que o pipeline V2 do Ariadne fez (`Campos obrigatórios: path.`,
 * sem tipo e sem significado), e antes disso o default daqui despejava o JSON
 * Schema cru numa linha: completo e ilegível.
 *
 * Agora os argumentos entram SEMPRE, no formato de `contrato.js`, e o host não
 * tem como omiti-los. `tool.contract` vira o parágrafo de cima — o que não cabe
 * no schema: pré-condição, o que o host recusa, para onde ir em vez disto.
 */
function contratoPadrao(tool, inputSchema) {
  const prosa = typeof tool.contract === 'string' && tool.contract.trim()
    ? tool.contract.trim()
    : tool.description;
  return `${prosa}\n${contratoDeArgumentos(inputSchema)}`;
}

/**
 * `agenda` + `listar` → `agenda__listar` — o nome que o modelo chama.
 * `{ prefixar: false }` devolve o nome cru (`toolName`) — ver `prefixarTools`
 * em `CapacidadeDeclarada` acima.
 *
 * O separador é `__`, duplo, e a razão é o LEITOR — não o parser. Com `_`
 * simples o split já era não-ambíguo (o id de capacidade proíbe `_`), mas por
 * uma regra que só quem a leu conhece: para o modelo, `codigo__ler_codigo` não
 * diz onde a capacidade termina, e quando ele reconstrói o nome de memória em
 * vez de copiar, erra a fronteira. `__` mostra a fronteira sem exigir
 * conhecimento nenhum, e é a convenção que ele mais viu nessa posição — o MCP
 * nomeia `mcp__<servidor>__<tool>`.
 *
 * Nível de ORIGEM, se um dia fizer falta, entra no id da capacidade, que
 * aceita hífen: `mcp-playwright__browser_click` ao lado de `codigo__ler_codigo`.
 * Quem decide isso é quem REGISTRA; o kairos só garante a fronteira única.
 *
 * ⚠️ Esta função e `exposedName` do `@okds/kairos` (`src/core/names.ts`) são
 * DUAS definições da mesma convenção e precisam concordar. Divergir não quebra
 * o registro — quebra na CHAMADA, com "tool não registrada" na grafia exata
 * que o prompt anunciou.
 */
export function nomeExposto(capId, toolName, { prefixar = true } = {}) {
  return prefixar ? `${capId}__${toolName}` : toolName;
}

/**
 * Uma tool é "fixa" (pinned) quando ela mesma declara `fixa`, ou — na ausência — por herança do
 * `piso` da própria capacidade (ver JSDoc de `ToolDeclarada.fixa` acima). Único ponto de verdade
 * desta regra: usada tanto para montar `pinned` no provider real (`montarProviders` abaixo)
 * quanto por `calibracao.js` para achar funções não-fixas que precisam de exemplo próprio
 * (revisão do conjunto, 2026-09-24, item 6 — antes desta extração, as duas contas reimplementavam
 * a mesma expressão e podiam divergir por edição em só um dos dois lugares).
 * @param {{ fixa?: boolean }} tool
 * @param {{ piso?: boolean }} capacidade
 * @returns {boolean}
 */
export function toolEhFixa(tool, capacidade) {
  return (tool.fixa ?? (capacidade.piso !== false)) === true;
}

/**
 * @param {CapacidadeDeclarada[]} capacidades
 * @returns {Array<{ provider: object, tools: object[], fonte: FonteDeclarada|null }>} ProviderDefinition[] + fonte
 */
export function montarProviders(capacidades) {
  return capacidades.map((cap) => {
    if (!cap.id) throw new Error('capacidade sem id');
    if (!Array.isArray(cap.tools) || cap.tools.length === 0) {
      throw new Error(`capacidade "${cap.id}" sem tools — não há o que registrar`);
    }
    const piso = cap.piso !== false;
    const definicao = defineProvider({
      id: cap.id,
      name: cap.id,
      description: cap.descricao || `Capacidade ${cap.id}.`,
      // Espalhamento condicional, não `semanticText: cap.semanticText`: o
      // fallback de `semanticDoc` (core/hash.js:3) é por AUSÊNCIA da chave —
      // um `undefined` explícito passa pelo `??` do mesmo jeito, mas a chave
      // presente com `undefined` polui o hash de conteúdo e o `deepEqual` de
      // quem testa.
      ...(cap.semanticText ? { semanticText: cap.semanticText } : {}),
      ...(cap.awareness ? { awareness: cap.awareness } : {}),
      ...(piso ? { loading: { always: true } } : {}),
      ...((cap.instrucoes || cap.descricao) ? { instructions: cap.instrucoes || cap.descricao } : {}),
      ...(cap.requires ? { requires: cap.requires } : {}),
      tools: cap.tools.map((tool) => {
        const inputSchema = tool.inputSchema || SCHEMA_ABERTO;
        return {
          key: tool.name,
          description: tool.description,
          // `NativeToolSpec` tem `semanticText` mas NÃO tem `awareness` — o
          // awareness é do provider (core/types.d.ts:104). Não inventar aqui.
          ...(tool.semanticText ? { semanticText: tool.semanticText } : {}),
          // Kairos 0.836: `examples` da Tool (frases de uso) viram vetores `query` por item quando o
          // host liga `semantica`. Fora do hash do `passage` (o doc não lê `examples`).
          ...(Array.isArray(tool.exemplos) && tool.exemplos.length ? { examples: tool.exemplos } : {}),
          inputSchema,
          effect: tool.effect || 'write',
          ...(tool.requires ? { requires: tool.requires } : {}),
          // Sem `tool.contract ||`: os argumentos entram SEMPRE. Ver o docblock
          // de `contratoPadrao` — a prosa do host vira o parágrafo de cima, não
          // o manual inteiro.
          contract: contratoPadrao(tool, inputSchema),
          // `pinned` sai de `fixa` (por TOOL), não de `piso` (da capacidade)
          // — ver o JSDoc de `ToolDeclarada.fixa`. Default: herda `piso`,
          // retrocompatível com quem nunca declarou `fixa`. `toolEhFixa` acima
          // é a mesma expressão que `calibracao.js` usa (item 6).
          ...(toolEhFixa(tool, cap) ? { pinned: true } : {}),
          handler: tool.handler,
        };
      }),
    });
    // `fonte` não é forma de `defineProvider`/`ProviderDefinition` (o adapter native não
    // conhece o contrato de fonte, spec 2 §3.1) — vai à parte, para `index.js#montarCatalogo`
    // ler sem precisar reler `config.capacidades` (mesmo racional de `prefixarPorCapacidade`).
    return { ...definicao, fonte: cap.fonte ?? null };
  });
}

/**
 * A face de EXECUÇÃO: uma entrada por tool, sob o nome que o modelo chama. Com prefixo e `aliasCru` na capacidade,
 * `cru` traz o nome sem prefixo, que o registry aceita como SINÔNIMO (o prompt.md dos poderes cita o nome cru).
 */
export function toolsExpostas(capacidades) {
  const expostas = [];
  for (const cap of capacidades) {
    const prefixar = cap.prefixarTools !== false;
    for (const tool of cap.tools) {
      expostas.push({
        nome: nomeExposto(cap.id, tool.name, { prefixar }),
        ...(prefixar && cap.aliasCru === true ? { cru: tool.name } : {}),
        description: tool.description,
        schema: tool.schema,
        effect: tool.effect || 'write',
        handler: tool.handler,
      });
    }
  }
  return expostas;
}

/**
 * Sinônimos crus válidos: nome cru → nome exposto, só para tools com `cru` (ver `toolsExpostas`) cujo cru é ÚNICO entre os
 * sinônimos e não colide com nenhum nome exposto. `colisoes` lista os crus recusados, com as capacidades envolvidas.
 * @param {ReturnType<typeof toolsExpostas>} expostas
 * @returns {{ porCru: Map<string,string>, colisoes: Array<{cru:string, nomes:string[]}> }}
 */
export function sinonimosCrus(expostas) {
  const nomesExpostos = new Set(expostas.map((t) => t.nome));
  const porCru = new Map();
  for (const t of expostas) if (t.cru) (porCru.get(t.cru) ?? porCru.set(t.cru, []).get(t.cru)).push(t.nome);
  const validos = new Map(); const colisoes = [];
  for (const [cru, nomes] of porCru) {
    if (nomes.length > 1 || nomesExpostos.has(cru)) colisoes.push({ cru, nomes });
    else validos.set(cru, nomes[0]);
  }
  return { porCru: validos, colisoes };
}

/** Toda capacidade é piso? Então o ranking nunca roda e o embedder é dispensável. */
export function tudoPiso(capacidades) {
  return capacidades.every((c) => c.piso !== false);
}

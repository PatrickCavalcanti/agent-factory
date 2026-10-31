/**
 * Schema do envelope de resposta do executor.
 *
 * Conjunto FECHADO de variantes, escolhido no boot da sessão. Não derive schema de
 * estado de sessão (powers carregados, purposes habilitados): cada variação vira uma
 * gramática nova para o vendor compilar. Duas variantes fixas = duas gramáticas,
 * quentes depois do primeiro uso, compartilhadas por todas as sessões. A terceira
 * (`SCHEMA_COMPLETA_CONTRIBUICOES`, spec de aceite de contribuição §7.4) só é
 * escolhida quando o interruptor `comportamento` pede — desligado, as duas de
 * sempre e nada muda na gramática já compilada pelos vendors.
 *
 * Regras de forma (spec §4.3), todas motivadas por portabilidade em modelo barato:
 * - Array de blocos de forma uniforme. Zero `anyOf`: união discriminada é onde o
 *   suporte de structured output é mais fraco fora dos três grandes vendors.
 * - `strict: true` exige TODO campo em `required`; nulo é expresso no tipo.
 * - A ORDEM dos campos é a ordem de emissão. `_fala` antes de `chat` transforma
 *   "speak vem antes de chat" de regra de prompt em garantia estrutural — MAS
 *   só para os vendors que honram a ordem declarada em `properties`. Bancada
 *   de 2026-09-03 (`meta/muse-spark-1.3-contributor`, 6 rodadas): 36 blocos
 *   com `fala` E `chat`, `chat` veio antes nos 36 — 0 respeitaram a ordem do
 *   schema. Serialização alfabética das chaves, não tendência: determinística.
 *   `deepseek-v4-flash` também inverteu em parte das rodadas. Daí o `_`: em
 *   ASCII `_` (95) ordena antes de qualquer minúscula (97+), então `_fala`
 *   fica alfabeticamente antes de `chat`/`comandos`/`layout` mesmo num
 *   serializador que ignora `properties` e escreve em ordem alfabética — é a
 *   defesa estrutural que NÃO depende de o modelo obedecer instrução. Para os
 *   vendors que honram a ordem declarada, `_fala` primeiro em `properties`
 *   (abaixo) mantém a garantia também por aí. NÃO renomear de volta para
 *   `fala` "por limpeza" — o underscore é a correção, não sujeira.
 */

const FALA = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['text', 'purpose', 'await', 'interruptible'],
  properties: {
    text: { type: 'string' },
    purpose: { type: 'string' },
    await: { type: 'boolean' },
    interruptible: { type: 'boolean' },
  },
};

const COMANDO = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'args'],
  properties: {
    tool: { type: 'string' },
    // STRING, não object — provado por teste real (não teórico), não simplificação
    // gratuita. `args` é forma livre: cada tool tem um shape de argumentos
    // diferente, e o schema do envelope é fechado (um par por sessão, spec §4.3),
    // então não há como declarar `properties` fixas aqui. Um `object` sem
    // `properties` sob `strict:true` tem dois destinos, medidos na sessão c936d250:
    // - OpenAI (via OpenRouter): recusa o schema inteiro no boot — 400 "Invalid
    //   schema for response_format 'igris_envelope': In context=('properties',
    //   'blocos'...)". Falha alta e visível, pelo menos avisa.
    // - Gemini: ACEITA o schema e gera `args: {}` sempre — a gramática não tem
    //   nada declarado dentro de `args` pra emitir. Log real: seis chamadas de
    //   `gcal_listar_eventos`, todas com `args: {}}`, enquanto o modelo escrevia
    //   "Ajustando os parâmetros da consulta" no chat. A tool recebia nada,
    //   devolvia sempre a mesma janela padrão, e o modelo tentava de novo até
    //   desistir com um turno vazio. Falha SILENCIOSA — nenhuma tool com
    //   argumento funcionava.
    // Como string, o schema estrito não vê forma livre nenhuma (passa nos dois
    // vendors) e o runtime faz `JSON.parse(args)` antes de entregar ao
    // `executeTool` do genos, que já valida o conteúdo via Zod — a gramática do
    // JSON Schema não estava comprando nada de validação real aqui mesmo antes.
    // Não "arrumar" de volta para `object` sem reconferir os dois vendors.
    args: { type: 'string' },
    // Sem execMode de propósito: modo de execução é propriedade da TOOL, resolvida
    // pela definição no manifesto do power (powerBundles.js:568-569), não algo que
    // o modelo decide. O genos resolve como `envelope.execMode ?? definition.execMode
    // ?? "sync"` (orchestrator.ts:634) — o ramo "sync" default cobre o comando que
    // nunca declarou nada. Colocar o campo aqui de novo reintroduz, sob strict:true,
    // uma decisão obrigatória em todo comando sobre algo que o modelo não sabe.
  },
};

function bloco({ comFala, comLayout, comIntencao, comContribuicoes }) {
  const properties = {};
  const required = [];
  // `_fala`, não `fala` — ver o comentário no topo do arquivo (bancada
  // 2026-09-03, 36/36 alfabético). Tem que continuar PRIMEIRO em `properties`
  // aqui: é a metade da defesa que ainda vale para os vendors que honram a
  // ordem declarada.
  if (comFala) { properties._fala = FALA; required.push('_fala'); }
  properties.chat = { type: ['string', 'null'] };
  required.push('chat');
  if (comLayout) {
    // STRING (ou null), não object/array — mesmo motivo de `COMANDO.args` acima:
    // `layout` é forma livre (não há um formato único de painel a fechar neste
    // schema) e um `object`/`array` sem `properties`/`items` sob `strict:true` é
    // recusado pela OpenAI e vira sempre `{}` silencioso no Gemini (ver o
    // comentário completo, com o log real da sessão c936d250, em `COMANDO.args`
    // acima). `EnvelopeStream._parseCapturedField` entrega o texto JSON já
    // decodificado (não um re-`JSON.stringify`, que dupla-codificaria) — ver o
    // comentário lá — e `executor.js` continua fazendo `JSON.parse(content)` no
    // handler de `layout` sem mudança.
    properties.layout = { type: ['string', 'null'] };
    required.push('layout');
  }
  properties.comandos = { type: 'array', items: COMANDO };
  required.push('comandos');
  if (comIntencao) {
    // Spec 2026-10-14 §5.1: intenção declarada — as funções que o modelo vai usar se o dono aceitar.
    // STRING com JSON (mesmo motivo de `COMANDO.args`/`layout`). Último em `properties`: para os
    // vendors que honram a ordem, só é escrito depois do que o dono vê; os que ordenam por alfabeto
    // o põem depois de `_fala` — o leitor não depende da posição.
    properties._intencao = { type: ['string', 'null'] };
    required.push('_intencao');
  }
  if (comContribuicoes) {
    // Spec 2026-10-29 §3.2: o modelo declara o que usou do que foi oferecido neste
    // turno. STRING com JSON (mesmo motivo de `_intencao`/`layout`), lista de ids ou
    // null. DEPOIS de `_intencao`, por último: é a última coisa do bloco.
    properties._contribuicoes_usadas = { type: ['string', 'null'] };
    required.push('_contribuicoes_usadas');
  }
  return { type: 'object', additionalProperties: false, required, properties };
}

function envelope(opts) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['blocos'],
    properties: { blocos: { type: 'array', items: bloco(opts) } },
  };
}

/**
 * Nome do schema que vai ao provider (`response_format.json_schema.name`): sem
 * prefixo, `envelope`, `envelope_headless`, `envelope_contribuicoes`; com prefixo,
 * `<prefixo>_envelope*` (o Igris passa `'igris'` e mantém os nomes de sempre).
 * O nome é parte do que o vendor vê — mudar o prefixo muda a chave de cache de
 * gramática, então o host escolhe uma vez e não varia por sessão.
 */
function nomeDoSchema(prefixo, sufixo) {
  const base = prefixo ? `${prefixo}_envelope` : 'envelope';
  return sufixo ? `${base}_${sufixo}` : base;
}

const CACHE_DE_SCHEMAS = new Map();

/**
 * As três variantes fechadas para um prefixo de nome. Memoizada por prefixo: o
 * mesmo prefixo devolve os MESMOS objetos (identidade estável, como as constantes).
 *
 * @param {string} [prefixo] vazio/ausente = nome neutro
 * @returns {{ completa: object, headless: object, completaContribuicoes: object }}
 */
export function schemasDoEnvelope(prefixo) {
  const chave = prefixo || '';
  let conjunto = CACHE_DE_SCHEMAS.get(chave);
  if (!conjunto) {
    conjunto = {
      // Sessão com usuário presente: fala, chat, layout e comandos.
      completa: {
        name: nomeDoSchema(chave, ''),
        schema: envelope({ comFala: true, comLayout: true, comIntencao: true }),
      },
      // Agente em background: ninguém vendo nem ouvindo. Sem fala, sem layout.
      headless: {
        name: nomeDoSchema(chave, 'headless'),
        schema: envelope({ comFala: false, comLayout: false }),
      },
      // Completa + `_contribuicoes_usadas` (aceite de contribuição de comportamento).
      // Só escolhida com `comContribuicoes: true` — o interruptor `comportamento`.
      completaContribuicoes: {
        name: nomeDoSchema(chave, 'contribuicoes'),
        schema: envelope({ comFala: true, comLayout: true, comIntencao: true, comContribuicoes: true }),
      },
    };
    CACHE_DE_SCHEMAS.set(chave, conjunto);
  }
  return conjunto;
}

const NEUTRO = schemasDoEnvelope();

/** Sessão com usuário presente, nome neutro (`envelope`). */
export const SCHEMA_COMPLETA = NEUTRO.completa;

/** Agente em background, nome neutro (`envelope_headless`). */
export const SCHEMA_HEADLESS = NEUTRO.headless;

/** Completa + contribuições, nome neutro (`envelope_contribuicoes`). */
export const SCHEMA_COMPLETA_CONTRIBUICOES = NEUTRO.completaContribuicoes;

/**
 * Resolve a variante no boot da sessão. Acrescentar uma variante nova
 * (ex.: voz desligada) é acrescentar dado aqui, não mexer em arquitetura.
 *
 * `headless` vence `comContribuicoes`: agente de fundo não declara contribuição de
 * comportamento (no fecho do turno de fundo nada é promovido), e um quarto schema
 * seria uma gramática a mais para os vendors compilarem sem ganho.
 *
 * `prefixoDoEnvelope`: prefixo do nome do schema (ver `schemasDoEnvelope`).
 */
export function resolveEnvelopeSchema({ headless = false, comContribuicoes = false, prefixoDoEnvelope } = {}) {
  const s = schemasDoEnvelope(prefixoDoEnvelope);
  if (headless) return s.headless;
  return comContribuicoes ? s.completaContribuicoes : s.completa;
}

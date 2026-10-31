// JSON Schema → o contrato de argumentos que o modelo lê.
//
// PORTADO do Igris (`packages/prompt-compiler/src/compile-bundle.js` +
// `render.js#describeSchemaType`), onde esta forma já roda em produção. Não é
// reinvenção: o formato foi escolhido lá depois de um defeito medido, e o
// comentário original vale repetir porque descreve exatamente o que acontecia
// aqui:
//
//   "Sem isso o contrato chega à LLM como `nova_nota?: object` — o nome do
//    campo e mais nada —, e ela tem que adivinhar a forma a partir da prosa do
//    prompt. Foi o que produziu `args.nova_nota.status nao e permitido` na
//    sessão b8c740e5 (o schema declara os campos; a compilação é que os perdia)."
//
// O que este módulo produz:
//
//   Args:
//     - `path*`: string — Caminho relativo à raiz do projeto.
//     - `limit?`: number — Tamanho máximo do bloco.
//     - `acoes?`: array<object> — Botões que aparecem na notificação.
//       - `id*`: string
//       - `label*`: string
//
// `*` obrigatório, `?` opcional, o TIPO, e a descrição do campo. As três coisas
// que faltavam: o pipeline V2 do Ariadne renderizava
// `Campos obrigatórios: path. Campos opcionais: offset, limit.` — nomes, sem
// tipo e sem significado — e a fábrica, no outro extremo, despejava o JSON
// Schema cru numa linha. Informação completa e ilegível, ou legível e vazia.

const INDENT_CAMPO = '    ';
const PASSO_ANINHADO = '  ';
// Teto de profundidade: schema de tool é JSON estático (não há `$ref` cíclico),
// mas aninhamento patológico inflaria o prompt sem ganho de contrato.
const PROFUNDIDADE_MAXIMA = 4;

/**
 * Descreve o TIPO de um schema em uma palavra legível.
 * `enum` vira a união dos valores; `array` vira `array<tipo do item>`.
 */
export function descreverTipo(schema = {}) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (Object.hasOwn(schema, 'const')) return JSON.stringify(schema.const);
  const tipo = schema.type;
  if (Array.isArray(tipo)) return tipo.join(' | ');
  if (typeof tipo === 'string') {
    if (tipo === 'array') return `array<${descreverTipo(schema.items || {})}>`;
    return tipo;
  }
  // Fallback honesto: tipo ausente vira `any`, nunca `string` — chutar um tipo
  // é o que transforma "o schema não declarou" em "a tool recusa um argumento
  // que ela aceita".
  return 'any';
}

/** Uma linha por campo, recursando em objeto aninhado e em array de objeto. */
function linhasDosCampos(schema, indent, profundidade) {
  const propriedades = schema?.properties;
  if (!propriedades || typeof propriedades !== 'object' || Array.isArray(propriedades)) return [];

  const obrigatorios = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(propriedades).flatMap(([nome, schemaDoCampo]) =>
    linhaDoCampo(nome, schemaDoCampo, obrigatorios.has(nome), indent, profundidade));
}

function linhaDoCampo(nome, schema = {}, obrigatorio = false, indent = INDENT_CAMPO, profundidade = 0) {
  const marcador = obrigatorio ? '*' : '?';
  const tipo = descreverTipo(schema);
  const descricao = typeof schema.description === 'string' && schema.description.trim()
    ? ` — ${schema.description.trim()}`
    : '';

  const linha = `${indent}- \`${nome}${marcador}\`: ${tipo}${descricao}`;
  if (profundidade >= PROFUNDIDADE_MAXIMA) return [linha];

  // `array<object>` descreve a forma do ITEM, não do array.
  const container = schema?.type === 'array' ? schema.items : schema;
  return [linha, ...linhasDosCampos(container, indent + PASSO_ANINHADO, profundidade + 1)];
}

/**
 * O bloco `Args:` de uma tool, a partir do `inputSchema` dela.
 *
 * @param {object} schema JSON Schema dos argumentos
 * @returns {string} bloco pronto para o prompt (já indentado)
 */
export function contratoDeArgumentos(schema = {}) {
  if (!schema || typeof schema !== 'object') return '  Args: sem argumentos.';
  if (schema.type && schema.type !== 'object') return `  Args: ${descreverTipo(schema)}`;

  const linhas = linhasDosCampos(schema, INDENT_CAMPO, 0);
  if (linhas.length === 0) return '  Args: sem argumentos.';

  return ['  Args:', ...linhas].join('\n');
}

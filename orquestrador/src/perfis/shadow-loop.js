// Perfil: manifesto defineShadow -> config da fábrica.
//
// TRADUÇÃO PURA. Sem IO, sem banco, sem budget, sem behaviors — é isso que o
// torna testável com `node --test` e fixture, e é isso que mantém a fronteira
// da spec §3.2. O runtime do shadow entra pelo `decorarTool` que o runner passa.

/** Forma do envelope para um shadow: sem `_fala`, sem `layout`. */
const FORMA_HEADLESS = `<formato_da_resposta>

Seu envelope tem um campo: \`blocos\`, um array. Cada bloco tem exatamente dois
campos, e os dois são obrigatórios:

- \`chat\` — o texto para quem lê, ou \`null\` quando este bloco não diz nada.
- \`comandos\` — array de chamadas; \`[]\` quando não há nenhuma.

\`\`\`json
{"blocos": [{"chat": "Consultando.", "comandos": [{"tool":"nome","args":"{}"}]}]}
\`\`\`

Você roda em background: ninguém está vendo nem ouvindo. Não há fala nem
interface — só \`chat\` e \`comandos\`.

Quando terminar, emita um bloco com o resultado em \`chat\` e \`comandos\` vazio.

</formato_da_resposta>`;

// O id do shadow tem ponto (ex.: `md_notes.writer`) e o Kairos valida o id do
// provider com `^[a-z0-9][a-z0-9-]*$` (kairos/src/core/names.ts) — REJEITA,
// não normaliza. `_` não passa nessa regex, então a sanitização usa `-` e
// minúsculas. Isso muda o nome exposto da tool (nomeExposto = `${capId}__${tool}`):
// `md_notes.writer` vira capId `md-notes-writer`, e a tool `gravar` fica
// exposta como `md-notes-writer__gravar` (não `md_notes_writer_gravar`).
function sanitizarId(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @param {object} entrada
 * @param {object} entrada.manifest manifesto defineShadow já validado
 * @param {string} entrada.systemPrompt texto do prompt já resolvido pelo loadPrompt
 * @param {Array} entrada.tools tools do run, na forma { name, description, schema, handler, effect }
 * @param {() => object} entrada.provider
 * @param {(nome: string, definicao: object) => object} [entrada.decorarTool]
 * @param {(texto: string) => void} [entrada.aoTexto]
 * @param {(evento: object) => void} [entrada.aoEvento]
 * @returns {import('../index.js').ConfigDoOrquestrador}
 */
export function perfilShadowLoop(entrada) {
  const { manifest, systemPrompt, tools } = entrada;
  const semTools = !Array.isArray(tools) || tools.length === 0;

  // Correção 3 (Fase 4, paridade) revertida por decisão de Fase 7: `mode:'loop'`
  // SEM tools é um caso real e deliberado — `redator/agents/compositor.js`
  // (maxTurns:1, sem tools) documenta por quê: "não é 'one-shot' porque esse
  // modo exige `output` (schema Zod) e forçaria a prosa a vir dentro de
  // JSON... Com 1 turno e nenhuma tool, a resposta do modelo É o texto final
  // do run". Há ~11 shadows de teste no mesmo formato. Lançar aqui os
  // condenava a nunca passar pela chave — a fábrica ganha um segundo modo em
  // vez de recusar o caso.
  //
  // `capacidades: []` + `protocolo: 'nativo'` é a escolha de PARIDADE: o
  // legado com zero tools também não ensina protocolo nenhum
  // (`withToolCatalog` devolve o prompt intacto quando não há tools), então o
  // system dele é só o `manifest.prompt`. `nativo` é o único protocolo cuja
  // `secaoInvariante()` é `null` (ver protocolo/nativo.js) — sem seção de
  // formato nenhuma, igual ao legado. `envelope` (mesmo headless) ensinaria um
  // formato que a tool 0 não precisa e que o legado nunca ensinou.
  const base = semTools
    ? () => [{ nome: 'identidade', conteudo: systemPrompt }]
    : () => [
      { nome: 'identidade', conteudo: systemPrompt },
      { nome: 'formato', conteudo: FORMA_HEADLESS },
    ];

  return {
    base,
    // Sem tools, catálogo fechado não tem o que fechar: nenhuma capacidade a
    // registrar (`montarProviders([])` não registra provider nenhum, e
    // `tudoPiso([])` é `true` por vacuidade — nenhum embedder exigido).
    capacidades: semTools ? [] : [{
      id: sanitizarId(manifest.id),
      descricao: manifest.description || `Tools do shadow ${manifest.id}.`,
      tools,
      piso: true,
      // Correção 2 (Fase 4, paridade): com uma capacidade só, o prefixo
      // `${capId}__` não desambigua nada (ele existe para evitar colisão ENTRE
      // capacidades) — só afasta o nome exposto do nome CRU que o caminho
      // legado usa. Sob prefixo, `result.history[].toolName` vazava como
      // `<capId>_notificar_do_agente`, e `async-shadows/handlers/delivery.js`
      // (que compara por igualdade contra o nome cru) zerava a contagem em
      // silêncio. `prefixarTools: false` também é o que dá paridade
      // BYTE-A-BYTE de nome de tool com o caminho legado (que nunca prefixou).
      prefixarTools: false,
    }],
    protocolo: semTools ? 'nativo' : 'envelope',
    ...(semTools ? {} : { protocoloOpts: { headless: true } }),
    provider: entrada.provider,
    decorarTool: entrada.decorarTool,
    maxIteracoes: manifest.maxTurns ?? 12,
    // Catálogo fechado quer TODOS os contratos no prompt — o default 6 da
    // fábrica é teto de hidratação semântica, não faz sentido aqui. Sem
    // tools, `tools.length` é 0 — passar 0 viraria o ORÇAMENTO de hidratação
    // do kairos (resolve/hydrate.js: `slots = max(0, limits.tools -
    // budgetUsed)`, e o veto de orçamento corta até tool PINNED), não "sem
    // teto". Não há capacidade nenhuma para hidratar aqui (`capacidades: []`
    // acima), então o valor nunca chega a ser consultado nesta forma — mas
    // omitir o campo é a escolha honesta: deixa o default (6) da fábrica valer
    // em vez de um 0 que, lido fora de contexto, parece dizer "nenhuma tool
    // pode entrar".
    ...(semTools ? {} : { limiteDeTools: tools.length }),
    aoTexto: entrada.aoTexto,
    aoEvento: entrada.aoEvento,
  };
}

export { FORMA_HEADLESS };

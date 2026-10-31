// Estratégia de protocolo `envelope` — o `json_output` do genos.
//
// Duas metades, e a divisão é o ponto:
//
// - INVARIANTE (aqui): como uma chamada é expressa e como o turno fecha. É
//   solidário ao PARSER do genos (`parseJsonOutputToolCalls`/`toNativeToolCall`,
//   no genos-orchestrator/src/orchestrator.ts) e deveria morar junto dele; mora
//   aqui por decisão de escopo (spec §2), com um teste de ida-e-volta contra o
//   parser real como antídoto. `{"blocos":[...]}` e `comandos` dentro de cada
//   bloco são HARDCODED nesse parser (`Array.isArray(parsed.blocos)`, depois
//   `bloco.comandos`) — não são forma do host, são exigência do parser, e por
//   isso o texto abaixo precisa nomeá-los.
// - FORMA (do perfil): quais OUTROS campos o envelope daquele consumidor tem
//   (ex.: `_fala`, `layout`). O `json_output` não define esses — quem define é
//   o schema do host.
import { resolveEnvelopeSchema } from './envelope-schema.js';
import { AVISO_PERTO_DO_TETO } from './perto-do-teto.js';

/** @typedef {import('./index.js').EstrategiaDeProtocolo} EstrategiaDeProtocolo */

// `args` é string, não objeto, no texto abaixo: cada tool tem um formato de
// argumentos diferente e o schema do envelope é fechado, então não há como
// declarar campos fixos para algo que varia por tool. Motivo completo, com o
// log real dos dois vendors testados (sessão c936d250), em
// `envelope-schema.js` (comentário de `COMANDO.args`).
const INVARIANTE = `<protocolo>

## A resposta é um envelope

Sua resposta é um único objeto JSON, imposto por schema. Nada fora dele: sem
texto solto antes, sem texto solto depois, sem cerca de markdown em volta.
Isso inclui o aviso de que você está começando a trabalhar ("vou conferir…"):
ele vai dentro do envelope, num bloco, nunca como frase solta antes do \`{\` nem
como mensagem separada. Texto fora do envelope é descartado sem chegar ao
usuário.

Um envelope truncado ou malformado não passa em silêncio: o runtime pede a
reemissão completa no turno seguinte.

## Chamadas

O envelope inteiro é \`{"blocos": [...]}\`. Cada bloco pode ter um campo
\`comandos\`: uma lista de ações reais, cada uma com o nome exato da tool em
\`tool\` e os argumentos em \`args\`.

\`args\` é sempre uma **string contendo JSON** — nunca um objeto direto —, com as
aspas internas escapadas (\\"), como qualquer string dentro de JSON. Mesmo sem
argumento: \`"args": "{}"\`, nunca \`"args": {}\`.

- Use exatamente o nome da tool e exatamente os nomes de argumento do contrato
  dela. NUNCA invente tool nem argumento.
- NUNCA afirme que um comando foi concluído antes de o resultado voltar.
- NUNCA duplique um comando no mesmo turno.

Exemplo de um turno que chama uma tool:

{"blocos":[{"chat":"Consultando.","comandos":[{"tool":"nome_da_tool","args":"{\\"campo\\":\\"valor\\"}"}]}]}

## O loop

Cada turno você emite um envelope. Se houver comandos, o runtime executa as
tools, injeta os resultados e chama você de novo — automaticamente, sem o
usuário precisar dizer nada. O loop fecha no turno em que você não emite nenhum
comando.

A ausência de resultado no turno atual NÃO é falha: é o estado normal antes do
próximo turno. Emita junto tudo que é independente, em vez de gastar um turno
por consulta.

## Caracteres acentuados

Escreva-os diretamente, em UTF-8 (ã, ç, é). NÃO use escapes \\uXXXX.

</protocolo>`;

/**
 * Desembrulha o envelope cru (`{"blocos":[...]}`) no texto que o modelo
 * escreveu para o leitor — junta os `chat` NÃO-NULOS de cada bloco (um bloco
 * pode chegar com `chat: null` quando só carrega `comandos`, ver COMANDO
 * acima e `envelope-schema.js`).
 *
 * JSON malformado devolve o texto cru em vez de lançar: isto roda DEPOIS de o
 * turno já ter fechado (o schema estrito do provider é quem garante a forma
 * ANTES disso), então um malformado aqui é sinal de bug em outra camada — e
 * lançar aqui derrubaria um resultado que já terminou, trocando "texto errado"
 * por "turno inteiro perdido".
 * @param {string} textoCru
 * @returns {string}
 */
function extrairTexto(textoCru) {
  let envelope;
  try {
    envelope = JSON.parse(textoCru);
  } catch {
    return textoCru;
  }
  const blocos = Array.isArray(envelope?.blocos) ? envelope.blocos : [];
  return blocos.map((bloco) => bloco?.chat).filter((chat) => chat != null).join('\n\n');
}

/**
 * @param {{ headless?: boolean }} [opts]
 * @returns {EstrategiaDeProtocolo}
 */
export function estrategiaEnvelope({ headless = true } = {}) {
  return {
    id: 'envelope',
    toolProtocol: 'json_output',
    // Registra as capacidades: aqui o registry e so tabela de DESPACHO. Fora de
    // `provider_native` o adapter nao manda `request.tools`, entao registrar nao
    // publica nada — e e por ele que o genos resolve o nome que o modelo
    // escreveu no envelope/fence.
    registraCapacidades: true,
    secaoInvariante: () => ({ nome: 'protocolo', conteudo: INVARIANTE }),
    schema: () => resolveEnvelopeSchema({ headless }),
    forceFinishMessage: `${AVISO_PERTO_DO_TETO} Emita agora o envelope final, sem nenhum item em \`comandos\`.`,
    extrairTexto,
  };
}

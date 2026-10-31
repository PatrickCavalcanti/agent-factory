// Estratégia `command_fence`. Não é o padrão de nada hoje — existe porque
// implementar a SEGUNDA estratégia é o que prova que o contrato não foi moldado
// à primeira, e porque `json_output` depende de o endpoint honrar o schema
// (`supportsStructuredOutputsFor` é true para UM endpoint; llama.cpp aceita e
// ignora). Fence não depende de capacidade nenhuma do provider — depende de o
// modelo obedecer, que é outra coisa e mede-se com a bancada.
//
// A forma abaixo (`{"type": "<tool>", "args": {...}}`, `args` como OBJETO) é
// solidária ao parser real do genos (`parseEnvelope`/`directToolEnvelopeSchema`
// e `execEnvelopeSchema`, em genos-orchestrator/src/stream-processor.ts) — o
// oposto do envelope (`tool` + `args` string): lá o schema do envelope precisa
// ser fechado, aqui não há schema nenhum, é markdown livre.

import { AVISO_PERTO_DO_TETO } from './perto-do-teto.js';

/** @typedef {import('./index.js').EstrategiaDeProtocolo} EstrategiaDeProtocolo */

const INVARIANTE = `<protocolo>

Para executar uma tool, emita um bloco cercado por exatamente três crases com o
tipo \`command\`, contendo APENAS um objeto JSON:

\`\`\`command
{"type":"nome_da_tool","args":{}}
\`\`\`

- Um único objeto JSON por cerca. Para várias tools, use cercas separadas.
- Use exatamente o nome da tool e os nomes de argumento declarados. NUNCA invente.
- Tool sem argumento usa \`"args": {}\`.
- O resultado volta como mensagem. NUNCA afirme conclusão antes do retorno.
- Quando terminar, responda em texto normal, sem cerca — isso encerra o run.

</protocolo>`;

/**
 * Sem parâmetros: ao contrário de `envelope` (`{ headless }`), `fence` não tem
 * variante de forma — se `resolverProtocolo('fence', opts)` for chamado com
 * `opts`, o valor é ignorado.
 * @returns {EstrategiaDeProtocolo}
 */
export function estrategiaFence() {
  return {
    id: 'fence',
    toolProtocol: 'command_fence',
    // Registra as capacidades: aqui o registry e so tabela de DESPACHO. Fora de
    // `provider_native` o adapter nao manda `request.tools`, entao registrar nao
    // publica nada — e e por ele que o genos resolve o nome que o modelo
    // escreveu no envelope/fence.
    registraCapacidades: true,
    secaoInvariante: () => ({ nome: 'protocolo', conteudo: INVARIANTE }),
    schema: () => null,
    forceFinishMessage: `${AVISO_PERTO_DO_TETO} Responda em texto normal, sem nenhuma cerca \`command\`.`,
    // O texto de fechamento do turno já É a prosa (a seção invariante ensina
    // "quando terminar, responda em texto normal, sem cerca") — nada a desembrulhar.
    extrairTexto: (textoCru) => textoCru,
  };
}

// Estratégia `provider_native`. A seção invariante é VAZIA de propósito: quem
// ensina o formato da chamada é o schema da tool que o provider recebe em
// `request.tools`. Não está em uso no Igris (todos os adapters declaram
// `nativeTools: false`); existe para o contrato cobrir o caso em que a seção de
// prompt é nula, que é o mais fácil de quebrar por acidente.

/** @typedef {import('./index.js').EstrategiaDeProtocolo} EstrategiaDeProtocolo */

/**
 * Sem parâmetros: ao contrário de `envelope` (`{ headless }`), `nativo` não tem
 * variante de forma — se `resolverProtocolo('nativo', opts)` for chamado com
 * `opts`, o valor é ignorado.
 * @returns {EstrategiaDeProtocolo}
 */
export function estrategiaNativo() {
  return {
    id: 'nativo',
    toolProtocol: 'provider_native',
    // As capacidades NAO entram no registry do genos — so as tres meta-tools.
    // Aqui o registry e tambem o ANUNCIO: o genos manda
    // `config.tools.toJsonSchemas()` inteiro em `request.tools`
    // (orchestrator.js:434 e :538), entao registrar uma capacidade e publica-la
    // como tool nativa, com schema. Medido: o modelo chamava a funcao direto,
    // porque a lista de tools do provider dizia que dava — e tomava
    // `manual_nao_carregado` do guarda, tres vezes seguidas, antes de descobrir
    // sozinho o `call_capability`. Texto de prompt nao ganha de schema de tool.
    //
    // Com tres entradas fixas, `request.tools` nunca muda: o prefixo do cache
    // (tools -> system -> messages) para de ser invalidado por mudanca de
    // catalogo, que e o motivo estrutural — nao so o comportamental.
    registraCapacidades: false,
    // DEIXOU de ser `null`. Era `null` porque o schema da tool ensinava a
    // chamada; agora a capacidade nao tem schema nativo, so nome no indice do
    // prompt. Sem este texto o modelo le uma lista de funcoes e nao tem como
    // saber por onde executa-las.
    secaoInvariante: () => ({
      nome: 'protocolo',
      conteudo: [
        'As funcoes listadas nas capacidades NAO sao chamaveis diretamente: elas nao',
        'estao entre as tools que voce recebeu. O nome delas e endereco, nao comando.',
        'Para executar qualquer uma, use `call_capability` passando esse nome em `ref`.',
      ].join('\n'),
    }),
    schema: () => null,
    forceFinishMessage: null,
    // Idem `fence`: nada de invariante para desembrulhar — o texto final do
    // turno já é a prosa que o provider devolveu.
    extrairTexto: (textoCru) => textoCru,
  };
}

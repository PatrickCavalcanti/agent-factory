import { estrategiaEnvelope } from './envelope.js';
import { estrategiaFence } from './fence.js';
import { estrategiaNativo } from './nativo.js';

/**
 * @typedef {{ nome: string, conteudo: string }} SecaoBase
 */

/**
 * O contrato que as três estratégias honram.
 *
 * Duas metades de UM protocolo: `secaoInvariante` é o texto que ensina o modelo
 * (vai para o prompt, no nível FIXO, no topo do system) e `toolProtocol` é o que
 * o genos recebe para escolher o parser. Quem consome tem que entregar as duas
 * ao mesmo tempo — ensinar um formato e parsear outro é a falha silenciosa que
 * este contrato existe para tornar impossível.
 *
 * A METADE QUE NÃO ESTÁ AQUI: a *forma* do envelope daquele consumidor (quais
 * campos ele tem). O `json_output` não define `_fala` nem `layout` — quem define
 * é o schema do host. O perfil fornece essa seção e ela vem DEPOIS da invariante.
 *
 * @typedef {object} EstrategiaDeProtocolo
 * @property {'envelope'|'fence'|'nativo'} id
 * @property {'json_output'|'command_fence'|'provider_native'} toolProtocol
 * @property {boolean} registraCapacidades se as tools das capacidades entram no
 *   `ToolRegistry` do genos, além das três meta-tools (`load`/`call`/`search`).
 *   **`false` em `nativo`**, e a razão é que lá o registry é também o ANÚNCIO: o
 *   genos manda `config.tools.toJsonSchemas()` inteiro em `request.tools`, então
 *   registrar uma capacidade é publicá-la como tool nativa com schema — e o
 *   modelo chama o que a lista de tools oferece, não o que o prompt pede (medido).
 *   Fora de `provider_native` o adapter não manda `request.tools`: lá o registry é
 *   só tabela de despacho, registrar não publica nada, e é por ele que o nome
 *   escrito no envelope/fence resolve. Daí `true` nos outros dois.
 * @property {() => SecaoBase|null} secaoInvariante o texto que ensina o formato.
 *   Em `nativo` ensina que as funções das capacidades não são chamáveis direto —
 *   elas não estão entre as tools recebidas, e quem executa é `call_capability`.
 * @property {() => object|null} schema schema de resposta, quando o protocolo é
 *   imposto por gramática. `null` em `fence` e `nativo`.
 * @property {string|null} forceFinishMessage como fechar o turno sem `finishTool`.
 *   `null` em `nativo`.
 * @property {(textoCru: string) => string} extrairTexto desembrulha o texto CRU do
 *   turno final (`resultado.value` do genos) no texto que o modelo escreveu PARA O
 *   LEITOR. Em `envelope` o texto cru é o `{"blocos":[...]}` inteiro — sem isto,
 *   `result.value`/`saida.texto` do consumidor era o envelope JSON, não a prosa
 *   (correção 1, Fase 4 — quebrava `shadows.output-validator` e o compositor do
 *   power `redator`, que documenta "a resposta do modelo É o texto final do run").
 *   Identidade em `fence`/`nativo`: o texto de fechamento do turno já é a prosa.
 */

const FABRICAS = {
  envelope: estrategiaEnvelope,
  fence: estrategiaFence,
  nativo: estrategiaNativo,
};

/**
 * @param {'envelope'|'fence'|'nativo'} id
 * @param {object} [opts] repassado à fábrica da estratégia (ignorado por
 *   `fence` e `nativo` — só `envelope` aceita `{ headless }`)
 * @returns {EstrategiaDeProtocolo}
 */
export function resolverProtocolo(id, opts) {
  const fabrica = FABRICAS[id];
  if (!fabrica) {
    throw new Error(
      `protocolo desconhecido: "${id}". Conhecidos: ${Object.keys(FABRICAS).join(', ')}. `
      + 'Acrescentar um quarto exige mexer no parser do genos-orchestrator, que tem uma união fechada.',
    );
  }
  return fabrica(opts);
}

export { estrategiaEnvelope, estrategiaFence, estrategiaNativo };
export { AVISO_PERTO_DO_TETO } from './perto-do-teto.js';

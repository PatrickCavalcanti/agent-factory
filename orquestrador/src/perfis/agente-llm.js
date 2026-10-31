// Perfil: linha de `background_agents` (motor 'llm') -> config da fábrica.
//
// Mesma tradução pura do shadow-loop. A linha do banco entra como OBJETO — este
// módulo não consulta banco, e é por isso que o teste dele roda sem banco.
//
// `agent.tools` é catálogo FECHADO (tudo piso). Não confundir com
// `agent.carrega`, que é piso do motor 'igris' e fica para a próxima spec.
import { FORMA_HEADLESS } from './shadow-loop.js';

/**
 * @param {object} entrada
 * @param {object} entrada.agent linha de background_agents
 * @param {Array} entrada.tools tools já resolvidas (montarCatalogo do power + as do runtime)
 * @param {() => object} entrada.provider
 * @param {number} [entrada.maxTurns] teto de iterações JÁ COAGIDO (número > 0
 *   truncado). NÃO ler `agent.max_turns` aqui: quem monta o manifesto
 *   (`async-shadows/agents/motor-llm.js:montarManifesto`) já aplica a mesma
 *   regra que o caminho legado usa (`Number(agent.max_turns) > 0 ? Math.trunc(...) : 8`)
 *   para calcular `manifesto.maxTurns` — ler a linha crua aqui seria uma
 *   SEGUNDA fonte da mesma coerção, e as duas divergem no caso mais comum:
 *   `entities/agent.js` normaliza `max_turns` ausente para `null`, e
 *   `null ?? 12` aqui contra `null > 0 ? ... : 8` lá dava 12 turnos na fábrica
 *   contra 8 no legado para TODO agente sem `max_turns` explícito (achado do
 *   review de Fase 5 — 50% mais turnos/tool calls/custo, exatamente a
 *   dimensão que o gate de paridade da Fase 7 mede).
 * @param {(nome: string, definicao: object) => object} [entrada.decorarTool]
 * @param {(texto: string) => void} [entrada.aoTexto]
 * @param {(evento: object) => void} [entrada.aoEvento]
 * @param {string} [entrada.prefixoDoEnvelope] prefixo do nome do schema do envelope
 *   (`<prefixo>_envelope_headless`); sem ele, nome neutro (`envelope_headless`).
 */
export function perfilAgenteLlm(entrada) {
  const { agent, tools } = entrada;
  if (agent.motor !== 'llm') {
    throw new Error(`agente "${agent.name}": perfil de motor 'llm' recebeu motor "${agent.motor}"`);
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`agente "${agent.name}": sem tools — nem as sempre-presentes do runtime chegaram`);
  }
  const identidade = agent.system_prompt
    || `Você é ${agent.nome_proprio || agent.name}. ${agent.descricao || ''}`.trim();

  return {
    base: () => [
      { nome: 'identidade', conteudo: identidade },
      { nome: 'formato', conteudo: FORMA_HEADLESS },
    ],
    capacidades: [{
      id: 'agente',
      descricao: `Tools declaradas por ${agent.name}.`,
      tools,
      piso: true,
      // Correção 2 (Fase 4, paridade — mesmo motivo do shadow-loop): com uma
      // capacidade só, o prefixo `${capId}__` não desambigua nada — só afasta o
      // nome exposto do nome CRU que o caminho legado usa. Entre as tools
      // sempre-presentes está `notificar_do_agente`, e
      // `async-shadows/handlers/delivery.js` filtra o histórico comparando
      // `m?.toolName === 'notificar_do_agente'` por igualdade estrita contra o
      // nome cru. Sob prefixo (`agente__notificar_do_agente`) esse `===` deixa
      // de casar e a contagem de notificação zera sem erro nenhum.
      prefixarTools: false,
    }],
    protocolo: 'envelope',
    protocoloOpts: {
      headless: true,
      ...(entrada.prefixoDoEnvelope ? { prefixoDoEnvelope: entrada.prefixoDoEnvelope } : {}),
    },
    provider: entrada.provider,
    decorarTool: entrada.decorarTool,
    maxIteracoes: entrada.maxTurns ?? 12,
    // Catálogo fechado: todos os contratos no prompt, sem teto de hidratação.
    limiteDeTools: tools.length,
    aoTexto: entrada.aoTexto,
    aoEvento: entrada.aoEvento,
  };
}

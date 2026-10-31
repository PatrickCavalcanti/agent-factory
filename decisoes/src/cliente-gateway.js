// packages/decisions/src/cliente-gateway.js
//
// Cliente do Jev pelo igris-gateway (`POST /v1/decide`) — J1 da spec
// (`2026-09-19-jev-pelo-gateway-e-decisor-da-fabrica-design.md`): o cliente
// OpenRouter direto (`./cliente.js`) sai do runtime; a partir daqui o Jev só
// entra pelo gateway (custo e chaves controlados lá). `./cliente.js` sobrevive
// só na bancada (`eval/`, Task 1.3).
//
// `protocolo` é injetado pelo chamador — hoje `GatewayProtocol` de
// `@igris/providers` (Task 1.1, `decide()`), mas este arquivo não importa
// `@igris/providers` direto: só espera um objeto com `decide({state, questions,
// timeoutMs, _consumer, _slot, _intent})`. Mesmo espírito "puro" de
// `nucleo/provedor.js` — quem monta o protocolo concreto é quem tem acesso à
// conta/token, não o núcleo de decisão.
//
// Mesmo contrato de `criarCliente` (cliente.js): `{ decidir({state, questions})
// -> {answers, usage, modelo, id, ms, cost}, modelo }` — é o que `perguntar()`
// (nucleo/perguntar.js) já consome.
//
// Correção do review da Fase 1 (spec §3.3): `perguntar()` lê `usage.input_tokens`/
// `usage.cost` (formato OpenRouter de `./cliente.js`). O gateway devolve
// `usage.inputTokens`/`usage.outputTokens` (camelCase) e o custo em `cost.credits`
// (créditos do gateway, não USD). `decidir()` normaliza `usage` para incluir também
// as chaves `input_tokens`/`output_tokens`/`cost` que `perguntar()` espera — sem
// descartar as originais do gateway — e mantém `cost` top-level como veio (objeto de
// créditos, não USD; quem exibe deve rotular).

const MODELO_PADRAO = 'gateway:decision'; // antes da 1ª resposta real; depois, o `model` do gateway resolveu no perfil

/**
 * @param {{ protocolo: { decide: Function }, consumer: string, slot?: string, timeoutMs?: number }} opts
 * @returns {{ decidir: (p: {state: object, questions: object}) => Promise<{answers: object, usage: {inputTokens?: number, outputTokens?: number, input_tokens: number, output_tokens: number, cost: number}, modelo: string, id?: string, ms: number, cost?: {credits?: number}}>, modelo: string }}
 */
export function criarClienteDoGateway({ protocolo, consumer, slot = 'decision', timeoutMs = 1500 }) {
  if (!protocolo || typeof protocolo.decide !== 'function') {
    throw new Error('criarClienteDoGateway: protocolo com decide() é obrigatório');
  }
  // `consumer` identifica quem consome o gateway (cota/telemetria do host): sem padrão neutro que faça sentido, é do host.
  if (typeof consumer !== 'string' || !consumer) {
    throw new Error("criarClienteDoGateway: consumer é obrigatório (ex.: 'module:executor' no Igris)");
  }

  async function decidir({ state, questions }) {
    const t0 = performance.now();
    // Sem retry (E8 — mesma decisão do runtime de chat/embed pelo gateway):
    // no caminho quente do turno, retentar somaria latência que o decisor
    // (J0/J5 da spec) não pode gastar — se o gateway falhar, quem chama
    // (`perguntar()`) já degrada sem culpado.
    const r = await protocolo.decide({
      state,
      questions,
      timeoutMs,
      _consumer: consumer,
      _slot: slot,
    });
    const usageDoGateway = r.usage || {};
    return {
      answers: r.answers,
      // `perguntar()` (nucleo/perguntar.js) lê `usage.input_tokens`/`usage.cost` — formato
      // OpenRouter, de `criarCliente` (./cliente.js). O gateway manda `usage.inputTokens`/
      // `usage.outputTokens` (camelCase) e o custo em `cost.credits` (créditos do gateway, NÃO
      // USD como na OpenRouter — quem exibe precisa rotular). Normaliza aqui, na borda, sem
      // perder os campos originais do gateway (mantidos junto, por completude).
      usage: { ...usageDoGateway, input_tokens: usageDoGateway.inputTokens ?? 0, output_tokens: usageDoGateway.outputTokens ?? 0, cost: r.cost?.credits ?? 0 },
      modelo: r.model || MODELO_PADRAO,
      id: r.id,
      ms: Math.round(performance.now() - t0),
      // `cost` top-level mantido como veio do gateway (objeto `{credits, pricingVersion, ...}`),
      // não em USD — diferente do formato OpenRouter que `perguntar()` foi escrito para.
      cost: r.cost,
    };
  }

  return { decidir, modelo: MODELO_PADRAO };
}

// packages/decisions/src/nucleo/provedor.js
//
// N3 (adendo §15 da spec): fábrica PURA do cliente compartilhado do Jev — uma conta, um
// cache, uma conexão quente. Lógica MOVIDA de `obterClientePadrao` e do aquecimento em
// packages/executor/src/orchestration/decisoes.js (P4), sem mudar a semântica — só o
// endereço: cache só de SUCESSO (falha nunca fica cacheada), nova tentativa só depois de
// `INTERVALO_RETRY_MS` (60s), e `marcarFalha:false` (usado pelo aquecimento) não abre essa
// janela de retry para o próximo turno real.
//
// J1/J3 da spec `2026-09-19-jev-pelo-gateway-e-decisor-da-fabrica-design.md`: o Jev passa a
// entrar SÓ pelo igris-gateway (`/v1/decide`) — o cliente OpenRouter direto
// (`criarCliente`/`../cliente.js`) sai deste caminho e sobrevive só na bancada
// (`IGRIS_DECISOES_CHAVE`, documentado abaixo). `obter()` não procura mais conta
// `protocol === 'openrouter'`: procura `protocol === 'gateway'` e monta o cliente do
// gateway a partir dela.
//
// "Pura" no sentido de N3: este arquivo não importa `@igris/providers` (nem qualquer módulo
// fora de `@igris/decisions`) — a leitura de conta (`listarContas`) e a construção do
// protocolo concreto do gateway (`criarProtocoloDoGateway`, ex.: `buildProtocol(conta)` de
// `@igris/providers`) são INJETADAS pelo chamador (hoje, o executor). Sem
// `criarProtocoloDoGateway` injetado, uma conta `gateway` encontrada não vira cliente — mesmo
// resultado de "sem conta": `obter()` devolve `null` (J0/J5: sem Jev, nunca lança). Pela mesma
// razão, a pergunta usada para "aquecer com uma decisão real" (hoje `aquecerDecisao`,
// específica da hidratação — reaproveita `INSTRUCOES_PRONTO`/`CRITERIA_PRONTO` de
// `../perguntas.js`) também é injetada, em vez de importada daqui.
import { criarCliente } from '../cliente.js';
import { criarClienteDoGateway } from '../cliente-gateway.js';

const INTERVALO_RETRY_MS = 60_000;

// Correção do review da Fase 1: aviso de "sem gateway" (linha 70-73, abaixo) repetia a cada
// turno sem conta configurada — ruído no log, não sinal. Módulo (não por instância de
// provedor) porque "uma vez por processo" é o que a mensagem promete: o processo já sabe, não
// precisa repetir. Sem reset entre testes de propósito — é estado do PROCESSO, não de uma
// instância; testes que dependem do aviso silenciam `console.warn` (padrão já usado no arquivo
// de teste para os warns vizinhos).
let avisouSemGatewayNesteProcesso = false;

/**
 * @param {{ listarContas: () => Promise<Array<{protocol?:string, api_key?:string}>>, agora?: () => number, fetchImpl?: Function, timeoutMs?: number, aquecerDecisao?: (cliente: {decidir:Function}) => Promise<boolean>, criarProtocoloDoGateway?: (conta: object) => {decide: Function} }} p
 * @returns {{ obter: (o?: {marcarFalha?: boolean, agora?: Function, listarContas?: Function}) => Promise<{decidir:Function, modelo?:string}|null>, aquecer: (o?: {transporte?: boolean}) => Promise<{transporte: boolean, decisao: boolean}>, _resetParaTeste: () => void }}
 */
export function criarProvedorDeCliente({ listarContas: listarContasPadrao, agora: agoraPadrao = Date.now, fetchImpl, timeoutMs, aquecerDecisao, criarProtocoloDoGateway } = {}) {
  if (typeof listarContasPadrao !== 'function') throw new Error('criarProvedorDeCliente: listarContas é obrigatório');

  // Cache só de sucesso (adendo §14, Task 2, item 4): se a leitura da conta falhar (ex.:
  // banco ainda subindo no boot), a feature não fica morta pelo resto do processo — só marca
  // `ultimaFalhaEm` (quando `marcarFalha` for true) e a próxima tentativa espera o intervalo.
  let cliente; // undefined = nunca tentou/nunca teve sucesso
  let ultimaFalhaEm = 0; // epoch ms (relógio injetável via `agora`, para teste)

  async function obter({ marcarFalha = true, agora = agoraPadrao, listarContas = listarContasPadrao } = {}) {
    if (cliente) return cliente;
    const t = agora();
    if (ultimaFalhaEm && t - ultimaFalhaEm < INTERVALO_RETRY_MS) return null;

    // IGRIS_DECISOES_CHAVE: override só de bancada/teste — cliente direto na OpenRouter, fora
    // do caminho de produção.
    // M-1 (segunda revisão final): a versão anterior liberava a chave quando
    // `NODE_ENV !== 'production'` — mas o Igris (Electron) NUNCA seta `NODE_ENV=production`
    // (usa `app.isPackaged`), então essa trava não valia nada no app empacotado: a chave
    // continuava contornando o gateway em silêncio. Agora é opt-in EXPLÍCITO: só vale com
    // `IGRIS_TEST=1` (suíte com banco), `NODE_ENV=test`, ou `IGRIS_DECISOES_BANCADA=1` (bancada
    // manual/eval fora dessas duas). Sem nenhuma das três, a env é ignorada — nunca uma
    // "garantia em produção", só bancada/teste, opt-in.
    const bancadaOuTeste = process.env.IGRIS_TEST === '1'
      || process.env.NODE_ENV === 'test'
      || process.env.IGRIS_DECISOES_BANCADA === '1';
    const chaveEnv = bancadaOuTeste ? process.env.IGRIS_DECISOES_CHAVE : undefined;
    if (chaveEnv) {
      // E8: runtime sem retry — no caminho quente, retry em 429/529 somaria segundos antes de
      // build-tool-registry; "nice to have" não vale esperar (mesma decisão de sempre).
      cliente = criarCliente({ chave: chaveEnv, tentativas: 1, timeoutMs, fetchImpl });
      return cliente;
    }

    let contas;
    try {
      contas = await listarContas();
    } catch (err) {
      console.warn('[decisions] não consegui ler contas de provider:', err?.message);
      if (marcarFalha) ultimaFalhaEm = t;
      return null;
    }
    // coluna confirmada: `protocol` — a conta do gateway é seeded com `protocol: 'gateway'`
    // (packages/providers/src/seed/gateway-defaults.js). Nunca procura `openrouter` aqui.
    const contaGateway = (contas || []).find((c) => String(c.protocol || '').toLowerCase() === 'gateway');
    if (!contaGateway || typeof criarProtocoloDoGateway !== 'function') {
      if (!avisouSemGatewayNesteProcesso) {
        avisouSemGatewayNesteProcesso = true;
        console.warn('[decisions] sem conta de gateway: Jev desligado');
      }
      if (marcarFalha) ultimaFalhaEm = t;
      return null;
    }

    let protocolo;
    try {
      protocolo = criarProtocoloDoGateway(contaGateway);
    } catch (err) {
      console.warn('[decisions] falha ao montar o protocolo do gateway:', err?.message);
      protocolo = null;
    }
    if (!protocolo) { if (marcarFalha) ultimaFalhaEm = t; return null; }

    cliente = criarClienteDoGateway({ protocolo, timeoutMs });
    return cliente;
  }

  /**
   * Aquecimento (adendo §14, revisado por J1): o `GET` de transporte que existia aqui
   * esquentava especificamente a borda da OpenRouter (`../transporte.js`, URL hardcoded) —
   * sem sentido para o gateway, que tem seu próprio transporte HTTP (fetch nativo, dentro de
   * `GatewayProtocol`). Por isso este `aquecer()` não faz mais GET nenhum: só obtém o cliente
   * (`marcarFalha:false` — aquecimento é best-effort e não pode "gastar" a janela de retry do
   * primeiro turno real, ver comentário no topo de `obter`) e dispara uma decisão mínima real
   * via `aquecerDecisao` (quando injetada), que já paga o custo de handshake do lado do
   * gateway. `transporte` sempre `false` no retorno — não há mais essa etapa.
   * @param {{ transporte?: boolean }} [_opts] - mantido na assinatura por compatibilidade; sem efeito (ver acima)
   * @returns {Promise<{transporte: boolean, decisao: boolean}>}
   */
  async function aquecer(_opts = {}) {
    const clienteAquecido = await obter({ marcarFalha: false });
    const decisao = typeof aquecerDecisao === 'function' ? await aquecerDecisao(clienteAquecido) : false;
    return { transporte: false, decisao };
  }

  /** Só para teste — reseta o cache/janela de retry deste provedor (estado por instância). */
  function _resetParaTeste() {
    cliente = undefined;
    ultimaFalhaEm = 0;
  }

  return { obter, aquecer, _resetParaTeste };
}

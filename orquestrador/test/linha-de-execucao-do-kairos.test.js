import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * O kairos (>= 0.841.261103) termina o retorno de `load_capability` com "Para executar: call_capability, com ref = o
 * nome do cabeçalho (##) e args = os parâmetros." — sem nome real. Isso só vale onde as capacidades NÃO estão
 * registradas (nativo); em envelope/fence o nome direto é a porta e a linha mentiria. O teste usa a linha REAL do kairos.
 */

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };
const LINHA = 'Para executar: call_capability, com ref = o nome do cabeçalho (##) e args = os parâmetros.';
const PROIBICAO = 'Não chame pelo nome direto';
const CAP = [{
  id: 'etapa', descricao: 'Etapa.',
  tools: [{ name: 'ler', description: 'Lê a etapa.', schema: z.object({}), handler: async () => ({}) }],
}];

const CHAMADA = {
  nativo: () => ({ text: '', stopReason: 'tool_calls', toolCalls: [{ id: 't1', toolName: 'load_capability', args: { refs: ['etapa__ler'] } }] }),
  envelope: () => ({ text: JSON.stringify({ blocos: [{ chat: 'x', comandos: [{ tool: 'load_capability', args: JSON.stringify({ refs: ['etapa__ler'] }) }] }] }), stopReason: 'completed' }),
  fence: () => ({ text: '```command\n{"type":"load_capability","args":{"refs":["etapa__ler"]}}\n```', stopReason: 'completed' }),
};
const FIM = {
  nativo: () => ({ text: 'fim', stopReason: 'completed' }),
  envelope: () => ({ text: JSON.stringify({ blocos: [{ chat: 'fim', comandos: [] }] }), stopReason: 'completed' }),
  fence: () => ({ text: 'fim', stopReason: 'completed' }),
};

/** Roda um turno em que o modelo chama `load_capability`; devolve o que o modelo leu na volta seguinte (só o que veio depois da chamada). */
async function manualVistoPeloModelo(protocolo) {
  let n = 0;
  let manual = '';
  const nativo = protocolo === 'nativo';
  const provider = () => ({
    name: 'fake', model: 'f',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: nativo, backgroundRuns: false, preferredToolProtocol: nativo ? 'provider_native' : 'command_fence' },
    async generate(req) {
      n += 1;
      if (n === 1) return CHAMADA[protocolo]();
      manual = req.messages.filter((m) => m.role !== 'system').map((m) => String(m.content)).join('\n');
      return FIM[protocolo]();
    },
  });
  const orq = criarOrquestrador({
    base: () => [], capacidades: CAP, protocolo,
    ...(protocolo === 'envelope' ? { protocoloOpts: { headless: true } } : {}),
    provider, decorarTool: (_n, d) => d,
  });
  const { resultado } = await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  assert.equal(resultado.type, 'completed');
  return manual;
}

const vezes = (texto, trecho) => texto.split(trecho).length - 1;

test('nativo: a linha do kairos fica uma vez e ganha a proibição do nome direto, uma vez', async () => {
  const manual = await manualVistoPeloModelo('nativo');
  assert.match(manual, /## etapa__ler/);
  assert.equal(vezes(manual, LINHA), 1, manual);
  assert.equal(vezes(manual, PROIBICAO), 1, manual);
  assert.ok(manual.includes(`${LINHA} ${PROIBICAO}.`), manual);
});

for (const protocolo of ['envelope', 'fence']) {
  test(`${protocolo}: a linha do kairos sai do retorno (lá o nome direto é a porta)`, async () => {
    const manual = await manualVistoPeloModelo(protocolo);
    assert.match(manual, /## etapa__ler/, `o manual tem que ter chegado: ${manual}`);
    assert.match(manual, /Lê a etapa\./);
    assert.equal(vezes(manual, 'Para executar: call_capability'), 0, manual);
    assert.equal(vezes(manual, PROIBICAO), 0, manual);
  });
}

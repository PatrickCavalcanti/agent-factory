import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * O kairos novo termina o retorno de `load_capability` com "Para executar: call_capability, com ref = o nome do
 * cabeçalho (##) e args = os parâmetros." — sem nome real. Isso só vale onde as capacidades NÃO estão registradas
 * (nativo); em envelope/fence o nome direto é a porta e a linha mentiria. O kairos instalado ainda não emite a linha,
 * então ela é simulada na descrição da tool, que o contrato do manual reproduz em linha própria.
 */

const ESTADO = { system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } };
const LINHA = 'Para executar: call_capability, com ref = o nome do cabeçalho (##) e args = os parâmetros.';
const CAP = [{
  id: 'etapa', descricao: 'Etapa.',
  tools: [{ name: 'ler', description: `Lê a etapa.\n${LINHA}`, schema: z.object({}), handler: async () => ({}) }],
}];

/** Roda um turno em que o modelo chama `load_capability`; devolve o tool_result que o modelo leu na volta seguinte. */
async function manualVistoPeloModelo(protocolo) {
  let n = 0;
  let manual = '';
  const nativo = protocolo === 'nativo';
  const provider = () => ({
    name: 'fake', model: 'f',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: nativo, backgroundRuns: false, preferredToolProtocol: nativo ? 'provider_native' : 'command_fence' },
    async generate(req) {
      n += 1;
      if (n === 1) {
        return nativo
          ? { text: '', stopReason: 'tool_calls', toolCalls: [{ id: 't1', toolName: 'load_capability', args: { refs: ['etapa__ler'] } }] }
          : { text: JSON.stringify({ blocos: [{ chat: 'x', comandos: [{ tool: 'load_capability', args: JSON.stringify({ refs: ['etapa__ler'] }) }] }] }), stopReason: 'completed' };
      }
      manual = req.messages.filter((m) => m.role === 'tool_result' || m.role === 'tool').map((m) => String(m.content)).join('\n');
      return nativo ? { text: 'fim', stopReason: 'completed' } : { text: JSON.stringify({ blocos: [{ chat: 'fim', comandos: [] }] }), stopReason: 'completed' };
    },
  });
  const orq = criarOrquestrador({
    base: () => [], capacidades: CAP, protocolo,
    ...(protocolo === 'envelope' ? { protocoloOpts: { headless: true } } : {}),
    provider, decorarTool: (_n, d) => d,
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO });
  return manual;
}

test('nativo: a linha do kairos fica e ganha "Não chame pelo nome direto."', async () => {
  const manual = await manualVistoPeloModelo('nativo');
  assert.match(manual, /## etapa__ler/);
  assert.ok(manual.includes(`${LINHA} Não chame pelo nome direto.`), manual);
  assert.equal(manual.split('Não chame pelo nome direto').length - 1, 1);
});

test('envelope: a linha do kairos sai do retorno (lá o nome direto é a porta)', async () => {
  const manual = await manualVistoPeloModelo('envelope');
  assert.match(manual, /## etapa__ler/);
  assert.match(manual, /Lê a etapa\./);
  assert.doesNotMatch(manual, /Para executar: call_capability/);
  assert.doesNotMatch(manual, /Não chame pelo nome direto/);
});

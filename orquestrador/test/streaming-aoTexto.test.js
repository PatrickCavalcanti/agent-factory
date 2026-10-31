import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarOrquestrador } from '../src/index.js';

/**
 * Regressão do bug medido no chat da fábrica (`IGRIS_CHAT_FABRICA=1`): a
 * resposta do modelo chegava inteira no fim (1 `agent.output.delta`/`aoTexto`
 * por chamada, tela parada pela duração inteira da geração), porque
 * `criarOrquestrador` não repassava `outputMode` ao `createOrchestrator` do
 * genos — sem ele, o default do genos é `'json'` (`orchestrator.ts:314`), que
 * usa `provider.generate()` (uma entrega só) em vez de `provider.stream()`
 * (deltas por pedaço, ver `orchestrator.ts:490-639`).
 *
 * A V1 (`packages/executor/src/executor.js:787`) já passava
 * `outputMode: 'streaming'` direto ao genos — este teste prova que
 * `criarOrquestrador` repassa `outputMode`. O chat da fábrica pede 'streaming'
 * no perfil (executor/.../fabrica/perfil.js); sem valor, vale o default do
 * genos, para não mudar o caminho de shadows/decisions (os testes de
 * `packages/shadows` espiam `generate()` e quebraram com 'streaming' como padrão).
 *
 * ANTES da correção (outputMode não repassado): `aoTexto` era chamado UMA
 * vez, com o envelope inteiro, e `chamadasGenerate` valia 1 (o genos usava
 * `provider.generate()`).
 */

const ENVELOPE = JSON.stringify({
  blocos: [{ chat: 'Isto chega em pedaços, não de uma vez.', comandos: [] }],
});

// Quebra o envelope em pedaços de tamanho fixo — imita o que um provider real
// de streaming entrega (chunks pequenos, várias chamadas de `onText`).
function emPedacos(texto, tamanho = 7) {
  const pedacos = [];
  for (let i = 0; i < texto.length; i += tamanho) pedacos.push(texto.slice(i, i + tamanho));
  return pedacos;
}

function providerFalsoComStream() {
  const chamadas = { generate: 0, stream: 0 };
  const provider = {
    name: 'fake-stream', model: 'fake-1',
    capabilities: {
      streaming: true, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      chamadas.generate += 1;
      return { text: ENVELOPE, stopReason: 'completed' };
    },
    async *stream() {
      chamadas.stream += 1;
      for (const pedaco of emPedacos(ENVELOPE)) {
        yield { type: 'text', text: pedaco };
      }
      yield { type: 'response.completed', response: { text: ENVELOPE, stopReason: 'completed' } };
    },
  };
  return { provider: () => provider, chamadas };
}

test('outputMode "streaming": aoTexto recebe vários deltas, na ordem, sem duplicar o envelope', async () => {
  const { provider, chamadas } = providerFalsoComStream();
  const deltas = [];

  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider,
    decorarTool: (_nome, definicao) => definicao,
    outputMode: 'streaming',
    aoTexto: (texto) => deltas.push(texto),
  });

  const { resultado } = await orq.executarTurno({ texto: 'o que tenho hoje de compromissos?' });

  assert.equal(resultado.type, 'completed');
  // O cerne do bug: mais de UM delta chegou (streaming de verdade), não um
  // único bloco com o texto inteiro.
  assert.ok(deltas.length > 1, `esperava vários deltas de aoTexto, veio ${deltas.length}`);
  // Concatenar os pedaços, NA ORDEM em que chegaram, reproduz o envelope
  // exatamente — sem duplicar (provaria que só o streaming alimentou
  // aoTexto, não streaming + uma segunda entrega no fim).
  assert.equal(deltas.join(''), ENVELOPE);
  // `provider.stream()` foi o caminho usado — não `generate()`.
  assert.equal(chamadas.stream, 1);
  assert.equal(chamadas.generate, 0);
});

test('sem outputMode vale o default do genos — generate(), um delta só (shadows/decisions não mudam de caminho)', async () => {
  const { provider, chamadas } = providerFalsoComStream();
  const deltas = [];

  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider,
    decorarTool: (_nome, definicao) => definicao,
    aoTexto: (texto) => deltas.push(texto),
  });

  const { resultado } = await orq.executarTurno({ texto: 'o que tenho hoje de compromissos?' });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.generate, 1);
  assert.equal(chamadas.stream, 0);
  assert.equal(deltas.length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Anexos do turno — o canal multimodal chega ao payload.
 *
 * Buraco achado migrando o orquestrador de TELA do Ariadne para a fábrica
 * (plano de 2026-09-17): o `abrirContexto` da V1 devolve
 * `anexos: { bloco, imagens }`, e o construtor da fábrica já sabia montá-los
 * (`EntradaDaMontagem.anexos`, prompt-builder.js) — mas `executarTurno` não
 * repassava o campo. Sem este teste, mandar uma imagem na V2 falharia CALADO:
 * o turno roda, responde, e o modelo simplesmente nunca vê a imagem.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };

function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

function fabrica(aoMontar) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'agenda',
      descricao: 'Consulta a agenda.',
      tools: [{
        name: 'consultar',
        description: 'Consulta itens da agenda.',
        schema: z.object({ q: z.string() }),
        handler: async () => ({ itens: [] }),
      }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (nome, definicao) => definicao,
    aoMontar,
  });
}

const ANEXOS = {
  bloco: '<anexos>\n- captura-da-tela.png (imagem)\n</anexos>',
  imagens: [{ base64: 'iVBORw0KGgo=', mimeType: 'image/png', label: 'captura-da-tela.png' }],
};

test('o bloco de anexos entra na mensagem do turno', async () => {
  let montado = null;
  const o = fabrica(info => { montado = info; });
  await o.executarTurno({
    texto: 'o que tem nesta captura?', estado: ESTADO_INICIAL, anexos: ANEXOS,
  });
  await o.fechar();

  assert.ok(montado, 'aoMontar não foi chamado');
  assert.match(montado.mensagemDoTurno, /captura-da-tela\.png/,
    'o bloco que DESCREVE os anexos não chegou à mensagem do turno');
  // Antes do texto do usuário: é contexto para a pergunta, e o que fecha a
  // mensagem é o que a pessoa escreveu (recência).
  assert.ok(
    montado.mensagemDoTurno.indexOf('captura-da-tela.png')
      < montado.mensagemDoTurno.indexOf('o que tem nesta captura?'),
    'o bloco de anexos precisa vir ANTES do texto do usuário',
  );
});

test('as imagens chegam ao canal multimodal da última mensagem', async () => {
  let montado = null;
  const o = fabrica(info => { montado = info; });
  await o.executarTurno({
    texto: 'o que tem nesta captura?', estado: ESTADO_INICIAL, anexos: ANEXOS,
  });
  await o.fechar();

  const ultima = montado.mensagens.at(-1);
  assert.deepEqual(ultima.images, ANEXOS.imagens,
    'as imagens não viajaram até a mensagem — é a falha silenciosa que este teste existe para pegar');
});

test('sem anexos, a mensagem do turno não ganha canal de imagem', async () => {
  let montado = null;
  const o = fabrica(info => { montado = info; });
  await o.executarTurno({ texto: 'bom dia', estado: ESTADO_INICIAL });
  await o.fechar();

  assert.equal(montado.mensagens.at(-1).images, undefined,
    'turno sem anexo não pode declarar `images` — nem vazio');
});

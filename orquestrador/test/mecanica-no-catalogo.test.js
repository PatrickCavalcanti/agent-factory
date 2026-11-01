import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * `mecanicaNoCatalogo` (portado do Ariadne, `fc2457a8` + `b7bec589`, 2026-10-24).
 *
 * O system do chat do Dev Mode se contradizia: o topo dizia que as funções do
 * catálogo não são chamáveis direto (protocolo nativo) e a legenda do catálogo
 * mandava "chame direto". Com a opção, toda a mecânica de chamada sai do topo
 * do system e vive no bloco de capacidades, escrita pela estratégia; no nativo
 * o manual vira `<function ref="…">` (endereço, não definição de tool); o
 * registro de operações sai em forma neutra. Desligada, nada muda (Igris).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (_nome, definicao) => definicao;
const META_TOOLS = ['load_capability', 'call_capability', 'search_capabilities'];

function providerDeTexto(textos, nativo = false) {
  let i = 0;
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: nativo, backgroundRuns: false,
      preferredToolProtocol: nativo ? 'provider_native' : 'command_fence',
    },
    async generate() { const t = textos[Math.min(i, textos.length - 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
  });
}

const capacidades = (handler = async () => ({ eventos: [] })) => [{
  id: 'agenda',
  descricao: 'Consulta a agenda do usuário.',
  tools: [{ name: 'listar', description: 'Lista eventos.', schema: z.object({ dia: z.string().optional() }), handler }],
}];

function montar(protocolo, extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }],
    capacidades: capacidades(),
    protocolo,
    ...(protocolo === 'envelope' ? { protocoloOpts: { headless: true } } : {}),
    provider: providerDeTexto(['pronto'], protocolo === 'nativo'),
    decorarTool: DECORAR_TOOL_NO_OP,
    mecanicaNoCatalogo: true,
    ...extra,
  });
}

for (const protocolo of ['nativo', 'envelope', 'fence']) {
  test(`com mecanicaNoCatalogo, a mecânica de ${protocolo} vive só no catálogo e respeita o registro`, async () => {
    const orq = montar(protocolo);
    try {
      const { payload } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
      const catalogo = payload.system.match(/<capabilities>[\s\S]*?<\/capabilities>/)?.[0];
      assert.ok(catalogo, 'o catálogo precisa existir');
      const fora = payload.system.replace(catalogo, '');
      for (const nome of [...META_TOOLS, 'agenda__listar', 'turn_operations']) {
        assert.ok(!fora.includes(nome), `${nome} fora do catálogo`);
      }
      assert.ok(!fora.includes('<protocolo>'));
      if (protocolo === 'nativo') {
        assert.doesNotMatch(catalogo, /chame direto|pode chamar direto/i);
        assert.match(catalogo, /<function ref="agenda__listar">/);
        assert.doesNotMatch(catalogo, /<function name=/);
        for (const meta of META_TOOLS) {
          assert.equal(catalogo.split(meta).length - 1, 1, `${meta} deve aparecer uma vez`);
        }
        assert.match(catalogo, /Função já com manual em `<functions>`: execute por `call_capability`.*`ref`.*`args`/);
        assert.match(catalogo, /Função listada sem manual:.*load_capability.*ref/);
      } else {
        assert.match(catalogo, /chame direto pelo nome exato/);
        assert.match(catalogo, /<function name="agenda__listar">/);
        assert.doesNotMatch(catalogo, /<function ref=/);
      }
    } finally { await orq.fechar(); }
  });
}

test('sem mecanicaNoCatalogo, o protocolo continua no topo do system (comportamento de sempre)', async () => {
  const orq = montar('fence', { mecanicaNoCatalogo: false });
  try {
    const { payload } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
    const catalogo = payload.system.match(/<capabilities>[\s\S]*?<\/capabilities>/)?.[0] ?? '';
    const fora = payload.system.replace(catalogo, '');
    assert.ok(fora.includes('load_capability'), 'o texto do protocolo deveria seguir fora do catálogo');
    assert.match(catalogo, /\*\*chame direto\*\*/);
  } finally { await orq.fechar(); }
});

test('com mecanicaNoCatalogo, o histórico leva as operações em forma neutra', async () => {
  const comando = JSON.stringify({ blocos: [{ chat: 'Consultando.', comandos: [{ tool: 'agenda__listar', args: { dia: 'hoje' } }] }] });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });
  const orq = montar('envelope', { provider: providerDeTexto([comando, fecha]) });
  try {
    const { historico, resultado } = await orq.executarTurno({ texto: 'o que tenho hoje?', estado: ESTADO_INICIAL });
    assert.equal(resultado.type, 'completed');
    const ultima = historico.at(-1).content;
    assert.match(ultima, /Operação executada \| referência: agenda__listar \| argumentos: \{dia:"hoje"\} \| resultado: ok/);
    assert.ok(!ultima.includes('agenda__listar {'));
  } finally { await orq.fechar(); }
});

test('mecanicaNoCatalogo recusa layout que não seja o agrupado', () => {
  assert.throws(
    () => montar('fence', { layoutDasCapacidades: 'diario' }),
    /mecanicaNoCatalogo só é suportada no layout 'agrupado'/,
  );
});

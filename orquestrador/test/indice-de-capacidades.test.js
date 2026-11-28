import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import {
  renderizarIndiceDeCapacidades,
  cabecalhoDoIndice,
  contribuicaoDoIndiceDeCapacidades,
} from '../src/indice-de-capacidades.js';

const caps = [
  { id: 'projeto', descricao: 'Lê o projeto. Detalhe.', piso: true, tools: [{ name: 'ler' }] },
  { id: 'olho', descricao: 'Vê a tela pronta. Mais.', piso: false, tools: [{ name: 'ver' }, { name: 'registros' }] },
  { id: 'migracao', descricao: 'Propõe migração de cadastro.', piso: false, tools: [{ name: 'propor' }] },
];

test('índice lista só capacidades fora do piso, com a 1ª frase e os nomes expostos', () => {
  const texto = renderizarIndiceDeCapacidades(caps, { formato: 'funcoesSugeridas' });
  assert.doesNotMatch(texto, /projeto/);
  assert.match(texto, /olho — Vê a tela pronta\. Funções: olho__ver, olho__registros/);
  assert.match(texto, /migracao — Propõe migração de cadastro\. Funções: migracao__propor/);
});

test('sem capacidade fora do piso, índice vazio', () => {
  assert.equal(renderizarIndiceDeCapacidades([caps[0]], { formato: 'completo' }), '');
  assert.equal(renderizarIndiceDeCapacidades(), '');
  assert.equal(renderizarIndiceDeCapacidades([null, { id: 'sem-tools', piso: false }, { id: 'vazia', piso: false, tools: [] }]), '');
});

test('capacidades saem ordenadas por id; prefixarTools false anuncia o nome cru; descrição vazia não gera separador', () => {
  const texto = renderizarIndiceDeCapacidades([
    { id: 'web', piso: false, prefixarTools: false, tools: [{ name: 'web_fetch' }] },
    { id: 'async', piso: false, descricao: '  Executa\n em  fundo...  ', tools: [{ name: 'executar' }] },
    { id: 'mcp-x', piso: false, descricao: '', tools: [{ name: 'a' }] },
  ]);
  assert.ok(texto.startsWith('<capability_index>\n') && texto.endsWith('\n</capability_index>'));
  assert.ok(texto.includes('- web. Funções: web_fetch'));
  assert.ok(texto.includes('- async — Executa em fundo. Funções: async__executar'));
  assert.ok(texto.includes('- mcp-x. Funções: mcp-x__a'));
  assert.ok(texto.indexOf('- async') < texto.indexOf('- mcp-x') && texto.indexOf('- mcp-x') < texto.indexOf('- web'));
});

const UMA = [{ id: 'pesquisa-web', piso: false, descricao: 'Pesquisa.', tools: [{ name: 'web_search' }] }];

test('cabeçalho: completo é o texto estável (bloco de cache); funcoesSugeridas acrescenta uma frase; nenhum não fala de cards', () => {
  const completo = [
    'Índice de todas as capacidades disponíveis que não estão sempre carregadas — uma linha por',
    'capacidade, com o nome exato de cada função. As carregadas aparecem completas em <capabilities>;',
    'as mais prováveis para o pedido chegam como cards no turno. Se o pedido precisa de uma capacidade',
    'deste índice que não está carregada, carregue o manual da função com `load_capability` (nome',
    'exato, como aqui) antes de chamá-la. Prefira a capacidade feita para o pedido a uma função',
    'parecida de outra capacidade.',
  ].join('\n');
  assert.equal(cabecalhoDoIndice('completo'), completo);
  assert.equal(cabecalhoDoIndice(), completo);
  assert.equal(
    renderizarIndiceDeCapacidades(UMA, { formato: 'completo' }),
    ['<capability_index>', completo, '', '- pesquisa-web — Pesquisa. Funções: pesquisa-web__web_search', '</capability_index>'].join('\n'),
  );
  assert.ok(cabecalhoDoIndice('funcoesSugeridas').includes('chegam como cards no turno, com as funções sugeridas. Se o pedido precisa'));
  const nenhum = cabecalhoDoIndice('nenhum');
  assert.ok(!nenhum.includes('cards') && nenhum.includes('load_capability') && nenhum.includes('<capabilities>.'));
});

test('contribuição: piso estável, calculada uma vez, prioridade e cabeçalho por parâmetro', async () => {
  const lista = [{ id: 'mcp-x', piso: false, tools: [{ name: 'a' }] }];
  const c = contribuicaoDoIndiceDeCapacidades(lista, { formato: 'nenhum', prioridade: 49.5, cabecalho: 'CAB' });
  assert.equal(c.ref, 'orquestrador/stable/capability-index');
  assert.equal(c.kind, 'knowledge');
  assert.equal(c.floor, true);
  assert.equal(c.volatil, false);
  assert.equal(c.destination, 'system:stable');
  assert.equal(c.priority, 49.5);
  const primeira = await c.read();
  assert.ok(primeira.includes('CAB') && primeira.includes('- mcp-x. Funções: mcp-x__a'));
  lista[0].tools.push({ name: 'b' });
  assert.equal(await c.read(), primeira);
});

// --- integração: o índice entra no system da fábrica ---------------------------------------------------

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

const tool = (name) => ({ name, description: `Faz ${name}.`, schema: z.object({}), handler: async () => ({}) });
const capacidadesDeVerdade = () => [
  { id: 'projeto', descricao: 'Lê o projeto.', piso: true, tools: [tool('ler')] },
  { id: 'olho', descricao: 'Vê a tela pronta. Mais.', piso: false, semanticText: 'ver a tela pronta, captura, imagem', tools: [tool('ver'), tool('registros')] },
];

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesDeVerdade(),
    embedder: null,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (nome, definicao) => definicao,
    ...extra,
  });
}

const TEXTO = 'quero ver a tela';

test('com `indiceDeCapacidades`, o system traz <capability_index> com as funções fora do piso', async () => {
  const { payload } = await fabrica({ indiceDeCapacidades: true, cartaoSugerido: 'funcoesSugeridas' })
    .executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.match(payload.system, /<capability_index>[\s\S]*olho__ver[\s\S]*<\/capability_index>/);
  assert.ok(payload.system.includes('chegam como cards no turno, com as funções sugeridas.'), 'o formato vem de config.cartaoSugerido');
  assert.ok(!/<capability_index>[\s\S]*- projeto[\s\S]*<\/capability_index>/.test(payload.system), 'capacidade de piso não entra no índice');
});

test('sem `indiceDeCapacidades`, o system não tem <capability_index>', async () => {
  const { payload } = await fabrica().executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(!payload.system.includes('<capability_index>'));
});

test('`indiceDeCapacidades` aceita cabeçalho e prioridade do host', async () => {
  const { payload } = await fabrica({ indiceDeCapacidades: { cabecalho: 'CABECALHO_DO_HOST', prioridade: 10 } })
    .executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(payload.system.includes('CABECALHO_DO_HOST'));
});

test('recusa R9: índice ligado sem nenhuma capacidade fora do piso', async () => {
  const soPiso = [{ id: 'projeto', descricao: 'Lê.', piso: true, tools: [tool('ler')] }];
  await assert.rejects(
    () => fabrica({ capacidades: soPiso, indiceDeCapacidades: true }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /indiceDeCapacidades ligado sem capacidade fora do piso/,
  );
});

test('o índice participa da validação de empate de prioridade dos pisos system', async () => {
  const outra = {
    ref: 'host/regra/x', kind: 'regra', description: 'x', floor: true, volatil: false,
    destination: 'system:stable', priority: 49.5, read: async () => 'X',
  };
  const comChave = { ...outra, ref: 'host/regra/y', priority: 20, chaves: ['a'] };
  delete comChave.volatil;
  await assert.rejects(
    () => fabrica({ indiceDeCapacidades: true, contribuicoes: [outra, comChave] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /mesma prioridade \(49\.5\)/,
  );
});

test('foraDoPisoComFuncao: o critério único do índice e da recusa R9', async () => {
  const { foraDoPisoComFuncao } = await import('../src/indice-de-capacidades.js');
  assert.equal(foraDoPisoComFuncao({ piso: false, tools: [{ name: 'a' }] }), true);
  assert.equal(foraDoPisoComFuncao({ piso: true, tools: [{ name: 'a' }] }), false);
  assert.equal(foraDoPisoComFuncao({ tools: [{ name: 'a' }] }), false, 'piso ausente conta como piso');
  assert.equal(foraDoPisoComFuncao({ piso: false, tools: [] }), false);
  assert.equal(foraDoPisoComFuncao({ piso: false }), false);
  assert.equal(foraDoPisoComFuncao(null), false);
  assert.equal(foraDoPisoComFuncao(undefined), false);
});

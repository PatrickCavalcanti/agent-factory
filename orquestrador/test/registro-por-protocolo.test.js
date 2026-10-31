import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { resolverProtocolo } from '../src/protocolo/index.js';

/**
 * QUEM REGISTRA AS CAPACIDADES É O PROTOCOLO, NÃO O PERFIL.
 *
 * O genos manda o registry INTEIRO para o provider em toda chamada
 * (`orchestrator.js`: `tools: config.tools.toJsonSchemas()`). Em
 * `provider_native` isso significa que registrar uma capacidade é PUBLICÁ-LA
 * como tool nativa, com schema — e o modelo chama o que a lista de tools do
 * provider oferece, não o que o texto do prompt pede.
 *
 * Foi medido em uso real (sessão de 2026-09-18, interação 54d76fd4): depois de
 * `load_capability(["codigo__ler_codigo","codigo__editar_codigo"])`, o modelo
 * chamou `codigo__ler_codigo` DIRETO, tomou `manual_nao_carregado` do guarda,
 * recarregou, chamou direto de novo, tomou a recusa de novo — e só então
 * descobriu sozinho o `call_capability`. Três iterações e ~6,6s dos 21,2s do
 * turno, queimados contra um defeito de desenho: o array `tools[]` prometia
 * uma porta que o guarda fechava.
 *
 * Há também a metade estrutural: `tools` é o PRIMEIRO bloco do prefixo de
 * cache (tools → system → messages). Registry que muda com o catálogo é
 * prefixo que muda — e invalida tudo abaixo.
 *
 * Fora de `provider_native` o adapter não manda `request.tools`: lá o registry
 * é só tabela de despacho, registrar não publica nada, e é por ele que o nome
 * escrito no envelope/fence resolve. Por isso a decisão é do protocolo, e a
 * resposta é DIFERENTE por protocolo — não é "nunca registrar".
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const META_TOOLS = ['load_capability', 'call_capability', 'search_capabilities'];

/**
 * Provider que ESPIA o `request.tools`.
 *
 * É a superfície que importa: não o que o registry tem por dentro, mas o que o
 * provider é informado que existe. É disso que o modelo decide o que chamar.
 */
function providerEspiao(capturado) {
  return () => ({
    name: 'fake',
    model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: true, backgroundRuns: false, preferredToolProtocol: 'provider_native',
    },
    async generate(request) {
      capturado.push((request?.tools ?? []).map((t) => t.name ?? t?.function?.name).filter(Boolean));
      return { text: 'pronto', stopReason: 'completed' };
    },
  });
}

const CAPACIDADES = [{
  id: 'agenda',
  descricao: 'Consulta a agenda do usuário.',
  tools: [{
    name: 'listar',
    description: 'Lista eventos.',
    schema: z.object({}),
    handler: async () => ({ eventos: [] }),
  }],
}];

async function toolsAnunciadas(protocolo) {
  const capturado = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: CAPACIDADES,
    protocolo,
    ...(protocolo === 'envelope' ? { protocoloOpts: { headless: true } } : {}),
    provider: providerEspiao(capturado),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
  await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
  await orq.fechar?.();
  assert.ok(capturado.length, 'o provider não chegou a ser chamado — o cenário não mede nada');
  return capturado[0];
}

test('em `nativo`, o provider recebe SÓ as três meta-tools — nenhuma capacidade', async () => {
  const nomes = await toolsAnunciadas('nativo');

  assert.ok(
    !nomes.includes('agenda__listar'),
    `"agenda__listar" foi anunciada como tool nativa (${nomes.join(', ')}) — o modelo vai chamá-la direto e tomar recusa do guarda`,
  );
  for (const meta of META_TOOLS) {
    assert.ok(nomes.includes(meta), `a meta-tool "${meta}" sumiu do registry — sem ela não há porta nenhuma`);
  }
  assert.equal(
    nomes.length, META_TOOLS.length,
    `o registry de \`nativo\` tem que ser exatamente as três meta-tools; veio: ${nomes.join(', ')}`,
  );
});

test('em `envelope`, a capacidade CONTINUA no registry — lá ele é despacho, não anúncio', async () => {
  const nomes = await toolsAnunciadas('envelope');
  assert.ok(
    nomes.includes('agenda__listar'),
    'a capacidade sumiu do registry do envelope — sem ela o nome escrito no envelope não resolve e o despacho quebra',
  );
});

test('`nativo` ENSINA que a função não é chamável direto (sem isso o modelo lê nomes e não sabe a porta)', () => {
  const { conteudo } = resolverProtocolo('nativo').secaoInvariante();
  assert.match(conteudo, /call_capability/, 'a seção de `nativo` não nomeia a porta de execução');
  assert.match(
    conteudo, /n[ãa]o s[ãa]o cham[áa]veis diretamente/i,
    'a seção não diz que as funções anunciadas não são chamáveis direto — é a frase que evita a chamada nativa',
  );
});

test('o contrato do protocolo declara `registraCapacidades` nos três, e só `nativo` é false', () => {
  assert.equal(resolverProtocolo('nativo').registraCapacidades, false);
  assert.equal(resolverProtocolo('fence').registraCapacidades, true);
  assert.equal(resolverProtocolo('envelope', { headless: true }).registraCapacidades, true);
});

/**
 * A CHAVE DE CACHE TEM DE SER DA CONVERSA, NUNCA DO TURNO.
 *
 * `promptCacheKey` SEGMENTA o cache no provider: com chave nova a cada turno, o
 * turno seguinte procura o prefixo noutra gaveta e não acerta por mais idêntico
 * que ele seja. O campo `conversaId` do contrato nunca foi preenchido por
 * nenhum host, então o fallback `runId` (`randomUUID()` por turno) era o
 * caminho ÚNICO.
 *
 * Medido antes do conserto (sessão d359a6e8): dentro do turno 1 o cache subia
 * de 4247 a 7726 tokens; a primeira chamada do turno 2 vinha `cache=0`, com
 * 7204 tokens reprocessados. O sintoma parecia invalidação por mudança no
 * system — e o system realmente muda —, mas a causa era a chave.
 */
test('promptCacheKey vem da conversa (threadId), não do turno', async () => {
  const chaves = [];
  const provider = () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: true, backgroundRuns: false, preferredToolProtocol: 'provider_native',
    },
    async generate(request) {
      chaves.push(request?.metadata?.promptCacheKey ?? null);
      return { text: 'pronto', stopReason: 'completed' };
    },
  });

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: CAPACIDADES,
    protocolo: 'nativo',
    provider,
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const ctx = { threadId: 'thread-estavel-1' };
  const t1 = await orq.executarTurno({ texto: 'primeira pergunta do usuário', estado: ESTADO_INICIAL, ctx });
  await orq.executarTurno({ texto: 'segunda pergunta, outro assunto', estado: t1.estado, ctx });
  await orq.fechar?.();

  assert.ok(chaves.length >= 2, `o provider foi chamado ${chaves.length}x — o cenário não mede dois turnos`);
  assert.equal(
    chaves[0], 'thread-estavel-1',
    `a chave do turno 1 não veio do threadId: ${chaves[0]}`,
  );
  assert.equal(
    new Set(chaves).size, 1,
    `a chave MUDOU entre turnos (${[...new Set(chaves)].join(' / ')}) — o prefixo do turno anterior vira inalcançável`,
  );
});

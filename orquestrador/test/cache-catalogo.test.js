import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador, aquecerCatalogo, recalcularCatalogo } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Cache de embeddings do catálogo por PROCESSO (`src/cache-catalogo.js`) — o custo medido em
 * `fabrica.json` (1.656–1.924 ms no primeiro turno de CADA sessão nova) estava inteiro em
 * `manager.reindex()` reembedando o MESMO texto semântico das MESMAS capacidades, toda vez que
 * a fábrica criava uma instância nova (uma por sessão). Estes testes provam: (1) a segunda
 * sessão com as mesmas capacidades/embedder não reembeda; (2) mudar texto/embedder invalida só
 * o que mudou; (3) `recalcularCatalogo()` força reembedding manual; (4) `aquecerCatalogo()`
 * aquece o cache sem sessão nenhuma, e uma sessão que chega DURANTE o aquecimento coalesce no
 * MESMO embed em voo em vez de duplicar.
 *
 * O cache (`src/cache-catalogo.js`) chaveia por IDENTIDADE do objeto `embedder` (`WeakMap`), não
 * por `modelSlug` — cada teste abaixo cria um objeto `embedder` NOVO (`embedderComContagem`),
 * então os testes já ficam isolados uns dos outros sem precisar de hook de limpeza nem de
 * `modelSlug` único; o `modelSlug` diferente por teste aqui é só documentação de leitura, não
 * requisito de isolamento.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

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

const capacidade = (id, extra = {}) => ({
  id,
  descricao: `Consulta a capacidade ${id}.`,
  piso: false,
  tools: [{
    name: 'consultar',
    description: `Consulta itens de ${id}.`,
    schema: z.object({ q: z.string() }),
    handler: async () => ({ itens: [] }),
  }],
  ...extra,
});

function vetorFake(texto, dim = 8) {
  const v = new Array(dim).fill(0);
  for (const ch of texto.toLowerCase()) { const i = ch.charCodeAt(0) % dim; v[i] += 1; }
  const norma = Math.hypot(...v) || 1;
  return v.map((x) => x / norma);
}

/** Embedder falso que registra TODA chamada (`{texto, role}`) — para contar quantas vezes o
 *  embedder REAL (por trás do cache) foi de fato invocado por papel. */
function embedderComContagem(chamadas, modelSlug) {
  return {
    modelSlug,
    async embed(texto, role) {
      chamadas.push({ texto, role });
      return vetorFake(texto);
    },
  };
}

function passagens(chamadas) {
  return chamadas.filter((c) => c.role === 'passage').length;
}

function config({ capacidades, embedder }) {
  return {
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades,
    embedder,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  };
}

test('segunda sessão com as mesmas capacidades e embedder não reembeda o catálogo', async () => {
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-cache-v1');
  const capacidades = [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })];

  const orq1 = criarOrquestrador(config({ capacidades, embedder }));
  const t1 = await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(t1.resultado.type, 'completed');
  const n1 = passagens(chamadas);
  assert.ok(n1 > 0, 'a primeira sessão precisa embedar o catálogo pelo menos uma vez');

  const orq2 = criarOrquestrador(config({ capacidades, embedder }));
  const t2 = await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(t2.resultado.type, 'completed');
  assert.equal(passagens(chamadas), n1, 'a segunda sessão (mesmas capacidades/embedder) não deveria reembedar nada');
});

test('mudar o semanticText de uma capacidade reembeda de novo (hash mudou)', async () => {
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-cache-v2');

  const orq1 = criarOrquestrador(config({
    capacidades: [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })],
    embedder,
  }));
  await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  const n1 = passagens(chamadas);
  assert.ok(n1 > 0);

  const orq2 = criarOrquestrador(config({
    capacidades: [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura amanha na capital' })],
    embedder,
  }));
  await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.ok(passagens(chamadas) > n1, 'texto semântico diferente precisa reembedar (hash novo, cache miss)');
});

test('mudar o embedder (modelSlug diferente) reembeda de novo', async () => {
  const chamadas = [];
  const capacidades = [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })];

  const embedder1 = embedderComContagem(chamadas, 'fake-cache-v3a');
  const orq1 = criarOrquestrador(config({ capacidades, embedder: embedder1 }));
  await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  const n1 = passagens(chamadas);
  assert.ok(n1 > 0);

  const embedder2 = embedderComContagem(chamadas, 'fake-cache-v3b');
  const orq2 = criarOrquestrador(config({ capacidades, embedder: embedder2 }));
  await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.ok(passagens(chamadas) > n1, 'embedder diferente (modelSlug novo) precisa reembedar, mesmo texto igual');
});

test('recalcularCatalogo() força reembedding mesmo sem mudar texto/capacidade/embedder', async () => {
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-cache-v4');
  const capacidades = [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })];

  const orq1 = criarOrquestrador(config({ capacidades, embedder }));
  await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  const n1 = passagens(chamadas);
  assert.ok(n1 > 0);

  const orq2 = criarOrquestrador(config({ capacidades, embedder }));
  await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(passagens(chamadas), n1, 'sem recalcular, a segunda sessão não deveria reembedar');

  await recalcularCatalogo();

  const orq3 = criarOrquestrador(config({ capacidades, embedder }));
  await orq3.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.ok(passagens(chamadas) > n1, 'depois de recalcularCatalogo(), a próxima sessão deveria reembedar de novo');
});

test('aquecerCatalogo() aquece o cache — a sessão seguinte não reembeda nada', async () => {
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-cache-v5');
  const capacidades = [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })];

  const resultado = await aquecerCatalogo({ capacidades, embedder });
  assert.deepEqual(resultado, { ok: true });
  const nAquecimento = passagens(chamadas);
  assert.ok(nAquecimento > 0, 'o aquecimento precisa ter embedado o catálogo');

  const orq = criarOrquestrador(config({ capacidades, embedder }));
  const turno = await orq.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(turno.resultado.type, 'completed');
  assert.equal(passagens(chamadas), nAquecimento, 'a sessão depois do aquecimento não deveria reembedar nada');
});

test('aquecerCatalogo() sem embedder não faz nada (degradação, não erro)', async () => {
  const resultado = await aquecerCatalogo({ capacidades: [capacidade('clima')], embedder: null });
  assert.deepEqual(resultado, { ok: false, motivo: 'sem-embedder' });
});

test('sessão chegando DURANTE o aquecimento coalesce — nenhum doc é embedado duas vezes', async () => {
  const chamadas = [];
  let liberar;
  const travar = new Promise((resolve) => { liberar = resolve; });
  const embedderLento = {
    modelSlug: 'fake-cache-v6',
    async embed(texto, role) {
      chamadas.push({ texto, role });
      // Só trava o PASSAGE (catálogo) — a query do turno (se houver) não precisa esperar.
      if (role === 'passage') await travar;
      return vetorFake(texto);
    },
  };
  const capacidades = [capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura' })];

  const promessaAquecimento = aquecerCatalogo({ capacidades, embedder: embedderLento });
  // Um tick para o aquecimento chegar ao primeiro `await embed(...)` e registrar a PROMESSA em
  // voo no cache de processo — sem isto a sessão abaixo poderia vencer a corrida e ser ELA a
  // registrar a promessa (o teste continua válido de qualquer jeito, mas a ordem descrita no
  // report — "aquecimento primeiro" — fica garantida assim).
  await new Promise((resolve) => setImmediate(resolve));

  const orq = criarOrquestrador(config({ capacidades, embedder: embedderLento }));
  const promessaTurno = orq.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });

  liberar();
  const [, turno] = await Promise.all([promessaAquecimento, promessaTurno]);
  assert.equal(turno.resultado.type, 'completed');

  const porTexto = new Map();
  for (const c of chamadas) {
    if (c.role !== 'passage') continue;
    porTexto.set(c.texto, (porTexto.get(c.texto) ?? 0) + 1);
  }
  assert.ok(porTexto.size > 0, 'esperava pelo menos um doc de catálogo embedado');
  for (const [texto, n] of porTexto) {
    assert.equal(n, 1, `"${texto.slice(0, 40)}…" foi embedado ${n} vezes — aquecimento e sessão deveriam coalescer no mesmo embed em voo`);
  }
});

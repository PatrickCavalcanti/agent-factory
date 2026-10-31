// Vetores do catálogo em DISCO (B1.5 do bloco B).
//
// O que estes testes provam, na ordem da tarefa:
//   1. o 1º processo (o aquecimento do boot) embeda e GRAVA o arquivo;
//   2. o "2º processo" — mesmo arquivo, estado de processo zerado — monta o catálogo com 0 embeds;
//   3. mudar o texto de UMA capacidade reembeda só ela (invalidação por `contentHash`);
//   4. o reuso entre sessões do MESMO processo continua 0 (o `WeakMap` de `cache-catalogo.js` não
//      pode ter sido quebrado pela camada nova — os dois wrappers precisam ser o mesmo objeto);
//   mais a prova de que a PERGUNTA do usuário não entra no arquivo (senão ele cresce um vetor por
//   turno, para sempre) e de que `recalcularCatalogo()` continua sendo o escape hatch.
//
// "2º processo" é simulado com um embedder NOVO (mesmo `modelSlug`): o objeto novo abre bucket
// novo no `WeakMap` de `cache-catalogo.js` e wrapper novo em `cacheDoCatalogoEmDisco`, ou seja,
// NADA em memória — exatamente o que sobra depois de um reinício do processo. Os vetores só podem
// vir do arquivo. O teste `processo real` fecha a doubt com um `spawn` de verdade, num `node` novo.
//
// Todos os arquivos vão para `%TEMP%` — nunca para o `dataDir` do Igris (`E:/Projetos/Igris/data`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { criarOrquestrador, aquecerCatalogo, recalcularCatalogo } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

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

function embedderComContagem(chamadas, modelSlug) {
  return {
    modelSlug,
    async embed(texto, role) {
      chamadas.push({ texto, role });
      return vetorFake(texto);
    },
  };
}

const passagens = (chamadas) => chamadas.filter((c) => c.role === 'passage');

/** Diretório temporário ÚNICO por teste, já montado; some com o processo. */
function pastaTemporaria(t) {
  const dir = mkdtempSync(join(tmpdir(), 'igris-catalogo-disco-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'catalogo-embeddings.json');
}

function config({ capacidades, embedder, arquivoCache }) {
  return {
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades,
    embedder,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    catalogoCache: { arquivoCache },
  };
}

const CAPACIDADES = () => [
  capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura ALFA' }),
  capacidade('notas', { semanticText: 'criar listar editar notas DEPLOY ALFA' }),
];

test('1º processo: o aquecimento embeda o catálogo e GRAVA o arquivo em disco', async (t) => {
  const arquivoCache = pastaTemporaria(t);
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-disco-v1');

  assert.equal(existsSync(arquivoCache), false, 'não deve existir arquivo antes do aquecimento');
  const resultado = await aquecerCatalogo({ capacidades: CAPACIDADES(), embedder, catalogoCache: { arquivoCache } });
  assert.deepEqual(resultado, { ok: true });

  const embedados = passagens(chamadas);
  assert.ok(embedados.length > 0, 'o aquecimento precisa ter embedado o catálogo');
  assert.ok(existsSync(arquivoCache), 'o arquivo de cache não foi criado');

  const lido = JSON.parse(readFileSync(arquivoCache, 'utf8'));
  assert.equal(lido.versao, 1);
  // Uma entrada por doc embedado, todas com o MESMO formato de chave do cache de exemplos:
  // `modelSlug` + papel + hash do texto.
  assert.equal(Object.keys(lido.itens).length, embedados.length);
  for (const chave of Object.keys(lido.itens)) assert.match(chave, /^fake-disco-v1#passage#/);
  for (const vetor of Object.values(lido.itens)) assert.equal(vetor.length, 8);
});

test('2º processo: embedder novo, mesmo arquivo — monta o catálogo com 0 embeds', async (t) => {
  const arquivoCache = pastaTemporaria(t);

  const chamadasPrimeiro = [];
  await aquecerCatalogo({
    capacidades: CAPACIDADES(),
    embedder: embedderComContagem(chamadasPrimeiro, 'fake-disco-v2'),
    catalogoCache: { arquivoCache },
  });
  const n1 = passagens(chamadasPrimeiro).length;
  assert.ok(n1 > 0);

  // "Reinício": embedder NOVO (bucket novo no `WeakMap`, wrapper novo, memória vazia) com o MESMO
  // `modelSlug` — que é o que faz a chave do arquivo bater.
  const chamadasSegundo = [];
  const embedder = embedderComContagem(chamadasSegundo, 'fake-disco-v2');

  const orq = criarOrquestrador(config({ capacidades: CAPACIDADES(), embedder, arquivoCache }));
  const turno = await orq.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(turno.resultado.type, 'completed');
  assert.equal(passagens(chamadasSegundo).length, 0, 'os vetores vieram do arquivo — nada foi embedado');
});

test('mudar o texto de UMA capacidade reembeda só ela (o resto vem do arquivo)', async (t) => {
  const arquivoCache = pastaTemporaria(t);

  const chamadasPrimeiro = [];
  const embedder = embedderComContagem(chamadasPrimeiro, 'fake-disco-v3');
  await aquecerCatalogo({ capacidades: CAPACIDADES(), embedder, catalogoCache: { arquivoCache } });
  const antes = passagens(chamadasPrimeiro).length;
  assert.ok(antes > 0);

  // "Reinício": embedder novo, mesma chave de arquivo.
  const chamadasSegundo = [];
  const embedder2 = embedderComContagem(chamadasSegundo, 'fake-disco-v3');

  const orq = criarOrquestrador(config({
    capacidades: [
      capacidade('clima', { semanticText: 'previsao do tempo chuva sol temperatura ALFA' }),
      // Só o texto semântico de `notas` muda; `clima` é byte a byte o mesmo.
      capacidade('notas', { semanticText: 'criar listar editar notas DEPLOY BETA' }),
    ],
    embedder: embedder2,
    arquivoCache,
  }));
  const turno = await orq.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(turno.resultado.type, 'completed');

  const novos = passagens(chamadasSegundo);
  assert.ok(novos.length > 0, 'a capacidade com texto novo precisa reembedar');
  assert.ok(novos.length < antes, `só um doc deveria ter reembedado (${novos.length} de ${antes})`);
  for (const c of novos) {
    assert.ok(!/clima|chuva|sol/.test(c.texto), `reembedou algo de clima: "${c.texto.slice(0, 80)}…"`);
    assert.match(c.texto, /DEPLOY BETA/);
  }
});

test('reuso entre sessões do MESMO processo continua 0 (o WeakMap do cache-catalogo sobreviveu)', async (t) => {
  const arquivoCache = pastaTemporaria(t);
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-disco-v4');
  const capacidades = CAPACIDADES();

  const orq1 = criarOrquestrador(config({ capacidades, embedder, arquivoCache }));
  await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  const n1 = passagens(chamadas).length;
  assert.ok(n1 > 0);

  // 2ª sessão, MESMO processo: o bucket do `WeakMap` (chaveado pelo wrapper) tem de ser o mesmo
  // bucket do 1º turno — se `cacheDoCatalogoEmDisco` devolvesse um objeto novo por sessão, isto
  // reembedaria tudo.
  const orq2 = criarOrquestrador(config({ capacidades, embedder, arquivoCache }));
  await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(passagens(chamadas).length, n1, 'a 2ª sessão do processo não deveria reembedar nada');

  // E o aquecimento, que chega depois, também não.
  const retorno = await aquecerCatalogo({ capacidades, embedder, catalogoCache: { arquivoCache } });
  assert.deepEqual(retorno, { ok: true });
  assert.equal(passagens(chamadas).length, n1, 'o aquecimento tardio não deveria reembedar nada');
});

test('a pergunta do usuário (query) não vai para o arquivo — senão ele cresce um vetor por turno', async (t) => {
  const arquivoCache = pastaTemporaria(t);
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-disco-v5');

  const orq = criarOrquestrador(config({ capacidades: CAPACIDADES(), embedder, arquivoCache }));
  for (const texto of ['qual a previsão?', 'e o fim de semana?', 'minhas notas']) {
    await orq.executarTurno({ texto, estado: ESTADO_INICIAL });
  }
  assert.ok(chamadas.some((c) => c.role === 'query'), 'o turno precisa embeder a pergunta');

  const lido = JSON.parse(readFileSync(arquivoCache, 'utf8'));
  for (const chave of Object.keys(lido.itens)) assert.match(chave, /#passage#/, `entrada indevida no arquivo: ${chave}`);
});

test('recalcularCatalogo() força reembedding mesmo com o arquivo em disco', async (t) => {
  const arquivoCache = pastaTemporaria(t);
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-disco-v6');
  const capacidades = CAPACIDADES();

  await aquecerCatalogo({ capacidades, embedder, catalogoCache: { arquivoCache } });
  const nAquecimento = passagens(chamadas).length;

  const orq1 = criarOrquestrador(config({ capacidades, embedder, arquivoCache }));
  await orq1.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(passagens(chamadas).length, nAquecimento);

  // Escape hatch: se ele limpasse só a memória, o `reindex()` leria os mesmos vetores de volta do
  // arquivo e não escaparia de nada.
  await recalcularCatalogo();
  const orq2 = criarOrquestrador(config({ capacidades, embedder, arquivoCache }));
  await orq2.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.ok(passagens(chamadas).length > nAquecimento, 'depois de recalcularCatalogo() tudo deveria reembedar');
});

test('sem `catalogoCache` nada é gravado — o comportamento de antes continua de pé', async (t) => {
  const arquivoCache = pastaTemporaria(t);
  const chamadas = [];
  const embedder = embedderComContagem(chamadas, 'fake-disco-v7');

  await aquecerCatalogo({ capacidades: CAPACIDADES(), embedder });
  assert.ok(passagens(chamadas).length > 0, 'o aquecimento ainda embeda (só não persiste)');
  assert.equal(existsSync(arquivoCache), false);

  // E o reuso entre sessões no mesmo processo segue valendo.
  const n1 = passagens(chamadas).length;
  const orq = criarOrquestrador(config({ capacidades: CAPACIDADES(), embedder }));
  await orq.executarTurno({ texto: 'qual a previsão de amanhã?', estado: ESTADO_INICIAL });
  assert.equal(passagens(chamadas).length, n1);
});

test('processo real: um `node` novo lê o arquivo gravado pelo `node` anterior (prova fim a fim)', { timeout: 120_000 }, (t) => {
  const arquivoCache = pastaTemporaria(t);
  const entrada = new URL('../src/index.js', import.meta.url).href;
  const codigo = () => `
    import { aquecerCatalogo } from ${JSON.stringify(entrada)};
    const chamadas = [];
    const embedder = { modelSlug: 'fake-processo-real', async embed(t, r) { chamadas.push(r); return new Array(8).fill(0.1); } };
    const cap = (id, sem) => ({ id, descricao: 'd ' + id, piso: false, semanticText: sem,
      tools: [{ name: 'consultar', description: 'c', schema: { type: 'object', properties: {} }, handler: async () => ({}) }] });
    await aquecerCatalogo({ capacidades: [cap('clima', 'chuva ALFA'), cap('notas', 'notas ALFA')], embedder,
      catalogoCache: { arquivoCache: ${JSON.stringify(arquivoCache)} } });
    console.log(JSON.stringify({ passages: chamadas.filter((r) => r === 'passage').length }));
  `;

  const rodar = () => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', codigo()], { encoding: 'utf8' });
    assert.equal(r.status, 0, `processo filho falhou: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split('\n').pop()).passages;
  };

  const primeiro = rodar();
  assert.ok(primeiro > 0, 'o 1º processo precisa embedar');
  assert.ok(existsSync(arquivoCache), 'o 1º processo precisa gravar o arquivo');
  const segundo = rodar();
  assert.equal(segundo, 0, 'o 2º processo (node novo) devia ler tudo do arquivo');
});
// Conferência geral 06/10 (B-I2): com o cache do catálogo impossível de gravar (disco cheio,
// permissão, caminho que é diretório), TODO turno da fábrica morria em `montarCatalogo`
// (`await disco.salvar()`, index.js ~1381). Este teste monta o orquestrador real com
// embedder e provider falsos e o `arquivoCache` apontando para um DIRETÓRIO.
// Comando: cd packages/orchestrator && node --test --test-force-exit --test-isolation=none test/cache-catalogo-falha-gravacao.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { criarOrquestrador, aquecerCatalogo } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

const ESTADO = () => ({
  system: systemVazio(), turno: 0,
  kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] },
});
const provider = () => ({
  name: 'fake', model: 'fake-1',
  capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
  async generate() { return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
});
const cap = (id, semanticText) => ({
  id, descricao: `Consulta ${id}.`, piso: false, semanticText,
  tools: [{ name: 'consultar', description: `Consulta ${id}.`, schema: z.object({ q: z.string() }), handler: async () => ({ itens: [] }) }],
});
const CAPS = () => [cap('clima', 'previsao do tempo chuva sol temperatura'), cap('notas', 'criar listar editar notas')];
function vetor(texto, dim = 8) {
  const v = new Array(dim).fill(0);
  for (const ch of texto.toLowerCase()) v[ch.charCodeAt(0) % dim] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const embedder = (slug) => ({ modelSlug: slug, async embed(t) { return vetor(t); } });
const cfg = (emb, arquivoCache) => ({
  base: () => [{ nome: 'identidade', conteudo: '<identidade>t</identidade>' }],
  capacidades: CAPS(), embedder: emb, protocolo: 'envelope', protocoloOpts: { headless: true },
  provider, decorarTool: (n, d) => d, catalogoCache: { arquivoCache },
});

function silenciarAvisos() {
  const original = console.warn;
  console.warn = () => {};
  return () => { console.warn = original; };
}

test('três turnos seguidos com o cache do catálogo impossível de gravar: nenhum lança', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'cat-falha-')), 'catalogo.json');
  mkdirSync(arquivo, { recursive: true });
  const restaurar = silenciarAvisos();
  try {
    const orq = criarOrquestrador(cfg(embedder('slug-falha-turno'), arquivo));
    for (let i = 1; i <= 3; i += 1) {
      const r = await orq.executarTurno({ texto: `turno ${i}: qual a previsão de amanhã?`, estado: ESTADO() });
      assert.ok(r, `turno ${i} sem resultado`);
    }
  } finally { restaurar(); }
});

test('aquecimento do boot com o cache impossível de gravar não lança', async () => {
  const arquivo = join(mkdtempSync(join(tmpdir(), 'cat-falha-')), 'catalogo.json');
  mkdirSync(arquivo, { recursive: true });
  const restaurar = silenciarAvisos();
  try {
    await aquecerCatalogo({ capacidades: CAPS(), embedder: embedder('slug-falha-aquec'), catalogoCache: { arquivoCache: arquivo } });
  } finally { restaurar(); }
});

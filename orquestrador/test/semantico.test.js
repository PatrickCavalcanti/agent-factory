import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Fase 6, Task 6.2 — liga o caminho SEMÂNTICO (`piso: false`) de ponta a
 * ponta com um embedder de verdade (falso, determinístico — sem baixar
 * modelo). Os testes de `fabrica.test.js`/`reconstrucao-unchanged.test.js`
 * já cobrem piso puro; aqui o que importa é que capacidade semântica não
 * vira piso (não é `always`/`pinned`) e que o turno completa quando o
 * ranking do kairos de fato roda.
 *
 * Veredito da Task 6.1: o slug/dimensão do embedder do Igris
 * (`intfloat/multilingual-e5-small`, 384d, `packages/embeddings/src/catalog.js`)
 * e o do kairos (`Xenova/multilingual-e5-small`, o port ONNX dos MESMOS
 * pesos, `embedder-e5.ts`) continuavam batendo — histórico: desde o Kairos 0.836 ele não tem
 * modelo próprio e o embedder vem sempre do Igris — `embeddingDaPergunta`
 * permanece reaproveitável entre os dois lados. Por isso o repasse em
 * `src/index.js` (`...(entrada.embeddingDaPergunta ? { embedding: ... } : {})`)
 * foi MANTIDO, e o teste 4 abaixo prova que ele é honrado.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

/**
 * Embedder falso e determinístico — a BASE do prompt de dispatch tinha
 * `embed(textos)` recebendo um ARRAY e devolvendo um array de vetores. O
 * contrato real do `@okds/kairos` (`index/embedder.ts`, `Embedder.embed`) é
 * `embed(text: string, role?) => Promise<number[]>` — UM texto, UM vetor
 * (é assim que `discover.ts` chama: `opts.embedder.embed(queryText, 'query')`
 * e `opts.embedder.embed(doc, 'passage')`, sempre singular). A base do
 * prompt quebraria em runtime (`textos.map` num `string`). Corrigido aqui
 * para a assinatura singular — mesmo padrão do fake usado em
 * `reconstrucao-unchanged.test.js` (`embed: async () => [1, 0, 0]`).
 */
function embedderFalso() {
  const dim = 8;
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const v = new Array(dim).fill(0);
      for (const ch of texto.toLowerCase()) { const i = ch.charCodeAt(0) % dim; v[i] += 1; }
      const norma = Math.hypot(...v) || 1;
      return v.map((x) => x / norma);
    },
  };
}

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
  tools: [{
    name: 'consultar',
    description: `Consulta itens de ${id}.`,
    schema: z.object({ q: z.string() }),
    handler: async () => ({ itens: [] }),
  }],
  ...extra,
});

/** Doc de embedding das fixtures semânticas — o ranking precisa de vocabulário
 *  de usuário, não da descrição escrita para o modelo ler. */
const DOC = {
  clima: 'previsao do tempo chuva temperatura sol vai chover amanha na capital',
  agenda: 'compromisso reuniao horario marcar agenda do dia semana que vem',
};

test('com embedder, capacidade semântica (piso: false) não vira piso e o caminho roda, produzindo prompt montado', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{ ...capacidade('clima'), piso: false, semanticText: DOC.clima }],
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, payload } = await orq.executarTurno({
    texto: 'qual a previsão do tempo para amanhã na capital, por favor',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed', 'o turno com capacidade semântica e embedder não pode lançar');
  assert.equal(typeof payload.system, 'string');
  assert.ok(payload.system.length > 0, 'o prompt montado não pode vir vazio');
});

test('piso e semântica convivem na mesma fábrica — o turno completa', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade('agenda'), { ...capacidade('clima'), piso: false, semanticText: DOC.clima }],
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, payload } = await orq.executarTurno({
    texto: 'qual a previsão do tempo para amanhã na capital, por favor',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed', 'piso + semântica na mesma fábrica não pode derrubar o turno');
  // Capacidade PISO é pinned — o contrato dela hidrata sempre, independente
  // do ranking decidir algo sobre a semântica.
  assert.ok(
    payload.system.includes('Args:'),
    'a capacidade piso (agenda) deveria ter o contrato sempre hidratado',
  );
});

test('sem embedder, capacidade semântica lança com mensagem acionável', async () => {
  const orq = criarOrquestrador({
    base: () => [],
    capacidades: [{ ...capacidade('clima'), piso: false, semanticText: DOC.clima }],
    protocolo: 'envelope',
    provider: providerFechado(),
  });

  await assert.rejects(() => orq.executarTurno({ texto: 'x', estado: ESTADO_INICIAL }), /nenhum embedder/);
});

/**
 * RESOLVIDO no kairos 0.831.260919 (Fase 1 da série, bump feito na Task 10 deste plano,
 * `pnpm-workspace.yaml`). O ACHADO original abaixo (mantido por histórico — documentava o
 * comportamento ANTIGO que este teste hoje prova como corrigido) foi registrado em
 * `docs/pendencias/2026-09-10-fabrica-de-orquestradores.md` (marcada resolvida na Task 15
 * deste plano, não aqui):
 *
 * ACHADO original — verificado por mutação (removi a linha e rodei a suíte inteira; nada
 * mudou), não corrigido NAQUELE momento porque era código de FORA deste pacote
 * (`@okds/kairos`, repositório próprio): `entrada.embeddingDaPergunta` era repassado por
 * `executarTurno` a `bridge.prepareTurn({ ..., embedding: entrada.embeddingDaPergunta })` —
 * mas `createGenosBridge(...).prepareTurn` (`@okds/kairos/genos`, `bridge.ts`) não tinha
 * `embedding` na própria assinatura de input e montava a chamada a `manager.discover({...})`
 * citando `text/ctx/state/limits/turn/conversation` — sem `embedding` nenhum. O vetor
 * pré-calculado era aceito e NÃO QUEBRAVA nada, mas era completamente ignorado: o kairos
 * sempre recalculava chamando `embedder.embed(queryText, 'query')` por conta própria.
 *
 * Desde 0.831, `PrepareTurnInput` aceita `embedding`/`embeddings` e repassa ao
 * `manager.discover()` — o vetor pré-calculado agora TEM EFEITO: a query deixa de ser
 * reembedada. A Task 11 deste plano (`feat(fabrica): a consulta e embedada uma vez pelo host
 * e repassada ao kairos nos dois prepareTurn`) passou a reaproveitar esse mesmo vetor nos
 * dois `prepareTurn` do turno.
 */
test('o vetor pré-calculado (embeddingDaPergunta) é aceito e o kairos NÃO recalcula a query — honrado desde 0.831', async () => {
  const embedder = embedderFalso();
  const chamadasPorRole = [];
  const embedderComEspiao = {
    modelSlug: embedder.modelSlug,
    async embed(texto, role) {
      chamadasPorRole.push(role);
      return embedder.embed(texto, role);
    },
  };

  const embeddingDaPergunta = [0.1, 0.2, 0.3, 0.1, 0.05, 0.05, 0.1, 0.1];

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{ ...capacidade('clima'), piso: false, semanticText: DOC.clima }],
    embedder: embedderComEspiao,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado } = await orq.executarTurno({
    texto: 'qual a previsão do tempo para amanhã na capital, por favor',
    estado: ESTADO_INICIAL,
    embeddingDaPergunta,
  });

  assert.equal(resultado.type, 'completed', 'o turno com embeddingDaPergunta pré-calculado precisa rodar');
  // Inversão de sinal (kairos 0.831 — ver docblock acima): antes, `chamadasPorRole` sempre
  // continha 'query' porque o bridge ignorava `embedding` e recalculava por conta própria.
  // Agora o vetor pré-calculado é honrado — nenhuma chamada com role 'query' deveria
  // acontecer. Se esta asserção voltar a falhar, é sinal de REGRESSÃO (o kairos parou de
  // honrar o vetor de novo).
  assert.ok(!chamadasPorRole.includes('query'), 'regrediu: o kairos voltou a recalcular a query mesmo com embeddingDaPergunta pré-calculado');
});

/**
 * Canário de versão — mesmo espírito do teste anterior (honrado "desde 0.831"), mas
 * checando o PISO em vez de um comportamento pontual: a spec 4 da série ("decisor por
 * anel: refinadores do kairos", 2026-09-20) exige `@okds/kairos` >= 0.833.260920
 * (`CHANGELOG.md` do kairos, entrada 0.833 — `createManager({ refiners, refinerBudgetMs,
 * refinersBudgetMs, skills, tool })`, `DiscoverExplainEntry.proposedTier/refiner`, eventos
 * `refiner.applied`/`refiner.fallback`, `applySessionPolicy(..., { skillsActivation })`,
 * `createGenosBridge({ skillsActivation })` — ver `SINCRONIA.md`). Uma fábrica que roda
 * contra um kairos mais velho não quebra na hora — quebra em silêncio, porque os campos
 * novos são todos ADITIVOS (nenhum contrato existente perdeu forma). Este teste existe
 * para transformar esse silêncio em falha explícita.
 *
 * A versão é lida do `package.json` REAL instalado (não do range do
 * `pnpm-workspace.yaml`) — `require.resolve` sobe a partir do subpath
 * `@okds/kairos/resolve/refiners` porque o pnpm resolve a dependência dentro de
 * `node_modules/.pnpm/@okds+kairos@git+...` (hash do lockfile), não num path fixo.
 */
test('canário — @okds/kairos instalado é >= 0.833.260920 e @okds/kairos/resolve/refiners expõe applyRefinement/runRefiner', async () => {
  const require = createRequire(import.meta.url);
  const entrada = require.resolve('@okds/kairos/resolve/refiners');

  let dir = dirname(entrada);
  let pkg;
  for (let i = 0; i < 6 && !pkg; i += 1) {
    const candidato = join(dir, 'package.json');
    if (existsSync(candidato)) {
      const lido = JSON.parse(readFileSync(candidato, 'utf8'));
      if (lido.name === '@okds/kairos') pkg = lido;
    }
    dir = dirname(dir);
  }
  assert.ok(pkg, `não achei o package.json do @okds/kairos subindo a partir de ${entrada}`);

  const minimo = '0.833.260920'.split('.').map(Number);
  const instalada = String(pkg.version).split('.').map(Number);
  let atendeMinimo = false;
  for (let i = 0; i < Math.max(minimo.length, instalada.length); i += 1) {
    const alvo = minimo[i] ?? 0;
    const real = instalada[i] ?? 0;
    if (real !== alvo) { atendeMinimo = real > alvo; break; }
    atendeMinimo = true; // segmentos iguais até aqui — igual ao mínimo também atende
  }
  assert.ok(
    atendeMinimo,
    `@okds/kairos instalado (${pkg.version}) é anterior a 0.833.260920 — refinadores por anel não disponíveis`,
  );

  // Import dinâmico de verdade (não leitura de package.json) — prova que o subpath
  // `./resolve/refiners` do `exports` do kairos resolve e que as funções do host-hook
  // (R1/R6/R7 da spec 4) existem no runtime, não só nos tipos.
  const refiners = await import('@okds/kairos/resolve/refiners');
  assert.equal(typeof refiners.applyRefinement, 'function', '@okds/kairos/resolve/refiners não exporta applyRefinement');
  assert.equal(typeof refiners.runRefiner, 'function', '@okds/kairos/resolve/refiners não exporta runRefiner');
});

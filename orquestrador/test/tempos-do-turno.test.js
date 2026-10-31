import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FakeEmbedder } from '@okds/kairos/index/embedder';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { limparCacheDeEmbeddingsDoProcesso } from '../src/cache-catalogo.js';

/**
 * Mudança 2 (2026-09-23, "medir as fases antes do modelo"): `tempos` no payload de `aoMontar` e
 * no retorno de `executarTurno` — ms de parede por fase deste turno, do início de `executarTurno`
 * até a montagem do payload estar pronta para o modelo. Ver JSDoc de `aoMontar` (`tempos`) em
 * `src/index.js`.
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
  tools: [{
    name: 'consultar',
    description: `Consulta itens de ${id}.`,
    schema: z.object({ q: z.string() }),
    handler: async () => ({ itens: [] }),
  }],
  ...extra,
});

const base = () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }];

function fabrica(overrides) {
  return criarOrquestrador({
    base,
    capacidades: [capacidade('agenda')],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...overrides,
  });
}

const TEXTO_NAO_TRIVIAL = 'preciso consultar a agenda de reuniões desta semana, pode me ajudar';

test('`aoMontar` recebe `tempos` com as fases da spec, e a soma nunca excede `ateOModelo`', async () => {
  const chamadas = [];
  const orq = fabrica({ aoMontar: (info) => chamadas.push(info) });

  const { resultado, tempos } = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1);

  // Mesmo valor em aoMontar e no retorno de executarTurno.
  assert.deepEqual(chamadas[0].tempos, tempos, 'info.tempos (aoMontar) precisa ser o MESMO valor que executarTurno devolve em tempos');

  // Forma: pelo menos as fases pedidas pela spec, todas numéricas.
  assert.equal(typeof tempos.catalogo, 'number');
  assert.equal(typeof tempos.discoverInicial.total, 'number');
  assert.equal(typeof tempos.discoverInicial.refinadores, 'number');
  assert.equal(typeof tempos.fontesMemoria, 'number');
  assert.equal(typeof tempos.loop, 'number');
  assert.equal(typeof tempos.promocao, 'number');
  assert.equal(typeof tempos.prepareTurnAcumulacao, 'number');
  assert.equal(typeof tempos.montagemDoPrompt, 'number');
  assert.equal(typeof tempos.ateOModelo, 'number');
  assert.equal(typeof tempos.outros, 'number');

  // Coerência: a soma das fases nomeadas (+ o resíduo `outros`, que existe exatamente para
  // fechar a conta) bate com `ateOModelo` — nunca pode dar folga escondida.
  const somaFases = tempos.catalogo + tempos.discoverInicial.total + tempos.fontesMemoria
    + tempos.loop + tempos.promocao + tempos.prepareTurnAcumulacao + tempos.montagemDoPrompt;
  assert.equal(somaFases + tempos.outros, tempos.ateOModelo, 'soma das fases + outros tem que bater EXATAMENTE com ateOModelo');

  // Sem loop/promoção configurados neste turno, os dois ficam em zero — não em `NaN`/negativo.
  assert.equal(tempos.loop, 0);
  assert.equal(tempos.promocao, 0);
  assert.ok(tempos.ateOModelo >= 0);
  assert.ok(tempos.discoverInicial.total >= 0);
});

test('turno trivial ("oi") ainda produz `tempos` coerente, com discoverInicial baixo (unchanged)', async () => {
  const chamadas = [];
  const orq = fabrica({ aoMontar: (info) => chamadas.push(info) });

  const { resultado, tempos } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1);
  const somaFases = tempos.catalogo + tempos.discoverInicial.total + tempos.fontesMemoria
    + tempos.loop + tempos.promocao + tempos.prepareTurnAcumulacao + tempos.montagemDoPrompt;
  assert.equal(somaFases + tempos.outros, tempos.ateOModelo);
});

test('segundo turno da mesma sessão: `catalogo` cai para perto de zero (montarCatalogo memoizado)', async () => {
  const orq = fabrica({});
  const t1 = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });
  const t2 = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: t1.estado });

  assert.equal(t2.resultado.type, 'completed');
  // Não é uma trava dura (Date.now() tem granularidade de 1ms e a máquina de CI pode oscilar),
  // só o sinal qualitativo: memoizado é ORDENS de grandeza mais barato que montar do zero.
  assert.ok(t2.tempos.catalogo <= t1.tempos.catalogo, 'segundo turno nao pode custar MAIS que o primeiro para montar o catalogo');
});

// Achado 4 da revisão da Fase 2 (porte dos poderes): `tempos.calibracao` é medido DENTRO de
// `montarCatalogo` (src/index.js: `msCalibracao` cobre só `limiaresDoConjunto`), e `tempos.
// catalogo` é medido do início do turno (`t0Turno`) até `montarCatalogo()` resolver — que inclui
// a calibração MAIS o registro das capacidades e o `manager.reindex()` do catálogo real. Por
// construção `calibracao` é um SUBTRECHO de `catalogo`, nunca pode superá-lo.
test('com calibração ativa e exemplos suficientes, `tempos.calibracao` é subtrecho numérico de `tempos.catalogo`', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const ex = (prefixo) => Array.from({ length: 6 }, (_, i) => `${prefixo} ${i}`);
  const capacidadesCalibradas = [
    { id: 'agenda', descricao: 'agenda', semanticText: 'agenda eventos calendário', piso: false, tools: [{ name: 'gcal_listar', description: 'x', semanticText: 'eventos', exemplos: ex('agenda amanhã reunião'), inputSchema: { type: 'object', properties: {} }, schema: z.object({}), handler: async () => ({ itens: [] }) }] },
    { id: 'tarefas', descricao: 'tarefas', semanticText: 'tarefas listas pendências', piso: false, tools: [{ name: 'task_listar', description: 'x', semanticText: 'tarefas', exemplos: ex('tarefas pendentes lista'), inputSchema: { type: 'object', properties: {} }, schema: z.object({}), handler: async () => ({ itens: [] }) }] },
  ];
  const orq = criarOrquestrador({
    base,
    capacidades: capacidadesCalibradas,
    embedder: new FakeEmbedder(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 },
    calibracao: { ativa: true, parametros: { minExemplos: 3 } },
  });

  const t1 = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: ESTADO_INICIAL });

  assert.equal(t1.resultado.type, 'completed');
  assert.equal(t1.limiares.origem, 'calculado', 'exemplos suficientes (6 por tool, mínimo 3) precisam produzir calibração calculada');
  assert.equal(typeof t1.tempos.calibracao, 'number');
  assert.ok(t1.tempos.calibracao > 0, 'com calibração calculada de verdade, o custo medido não pode ser zero');
  assert.ok(t1.tempos.calibracao <= t1.tempos.catalogo, '`calibracao` é subtrecho de `catalogo` — nunca pode superá-lo');

  // M4 (revisão do conjunto): `montarCatalogo()` memoiza a PROMISE por instância de
  // orquestrador — o 2º turno reusa o MESMO objeto resolvido no 1º turno, `msCalibracao`
  // incluso. Sem a correção, `tempos.calibracao` do 2º turno saía "velho": herdava o valor
  // medido no turno 1 (> 0), maior que `tempos.catalogo` do turno 2 (que É recalculado do zero
  // a cada turno, e cai para perto de zero quando memoizado — ver o teste logo acima). O turno 2
  // não pagou NENHUM custo de calibração (a promise já estava resolvida) — o valor certo é 0.
  const t2 = await orq.executarTurno({ texto: TEXTO_NAO_TRIVIAL, estado: t1.estado });
  assert.equal(t2.resultado.type, 'completed');
  assert.equal(t2.limiares.origem, 'calculado', 'segundo turno reusa o MESMO resultado memoizado — origem não muda');
  // M-a (revisão do conjunto): igualdade estrita com 0 é frágil — `Date.now()` tem granularidade
  // de 1ms e a máquina de CI pode oscilar sob carga (mesma folga usada em
  // calibracao-no-catalogo.test.js, medida lá). O sinal PRINCIPAL de que o turno 2 não recalculou
  // é `t2.limiares.origem` continuar `'calculado'` sem novo custo relevante — não este ms de parede.
  assert.ok(t2.tempos.calibracao <= 2, `segundo turno não recalcula — msCalibracao velho do turno 1 não pode vazar para cá (veio ${t2.tempos.calibracao}ms)`);
  assert.ok(t2.tempos.calibracao <= t2.tempos.catalogo, '`calibracao` continua subtrecho de `catalogo` no turno 2');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * Task 11 (`docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`
 * §3.6, F9/F10, §7) — skills do poder `habilidades` ponta a ponta no kairos: o kairos SÓ SUGERE
 * (anel `skill`, bloco `turn:context`), nunca carrega sozinho; quem carrega de verdade é
 * `hab_carregar` (fora deste turno — chamado pelo host via `aoSemear`, ou pelo modelo via tool de
 * power). Duas provas:
 *
 *   (a) a pergunta casa com a `semanticText` da skill → ela aparece em `discover.skills.suggest`
 *       e no bloco `turn:context` (`payload.mensagemDoTurno`, ref: 'skills/suggest' no bridge do
 *       kairos, `genos/bridge.js` ~L239-258); `discover.skills.activate` e
 *       `estado.kairos.loadedSkills` continuam vazios — sugerir ≠ carregar.
 *   (b) o modelo chama a meta-tool `load_capability` com a REF da skill sugerida (o comentário do
 *       bridge diz "skills usam o mesmo mecanismo de ref que tools") — mas
 *       `runtime/meta-tools.js#loadCapability` só monta `candidatas` a partir de
 *       `manager.registry.listTools()`, nunca de `listSkills()`: a ref não resolve, é rejeitada
 *       em silêncio (o handler devolve só `parts.join('\n\n')`, sem mencionar o `rejected`), o
 *       corpo da skill NUNCA aparece no `tool_result`, e `estado.kairos.loadedSkills` segue vazio
 *       depois do turno. Comportamento confirmado empiricamente rodando o orquestrador de teste
 *       antes de escrever este arquivo (scratchpad, não commitado) — não é dedução da leitura do
 *       dist, é o que o kairos 0.832.260919 realmente faz.
 *
 * Padrão de marcadores (embedderVetorial, PERGUNTA, fonteFake, capacidades, montarOrquestrador)
 * copiado de `test/fontes.test.js`; `turnoChamando`/`FECHA`/`providerDeTexto` copiados de
 * `test/guarda-manual.test.js`. Convenção do pacote: helpers são COPIADOS entre arquivos de
 * teste, nunca importados uns dos outros (nenhum arquivo deste diretório importa de outro
 * `*.test.js`).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR quero planejar a minha semana';
const REF_SKILL = 'habilidades/skill/planejar-semana';
const CORPO_MARCADOR = 'CORPO_UNICO_DA_SKILL_PLANEJAR_SEMANA';

function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() { return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
  });
}

function providerDeTexto(textos) {
  let i = 0;
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() { const t = textos[Math.min(i, textos.length - 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
  });
}

function embedderVetorial(chamadas = []) {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      chamadas.push(texto);
      return texto.includes('PERGUNTA_DO_USUARIO_MARCADOR') ? [1, 0] : [0, 0];
    },
  };
}

/**
 * `corpo()` devolve um marcador ÚNICO, que não aparece em mais nada do turno — é a prova de que
 * o corpo da skill NUNCA entra no prompt/tool_result sem um carregamento de verdade (fora do
 * escopo deste arquivo: quem carrega é `hab_carregar`, coberto em
 * `packages/powers/test/habilidades/carregar.test.js`).
 */
function fonteFake() {
  return {
    piso: [],
    async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
    async skills() {
      return [{
        key: 'planejar-semana',
        descricao: 'Planeja a semana',
        semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana',
        corpo: async () => `# ${CORPO_MARCADOR}`,
      }];
    },
    aoFechar() {},
  };
}

function capacidades(fonte) {
  return [{
    id: 'habilidades',
    descricao: 'Trabalha com as habilidades (skills) em disco.',
    piso: false,
    semanticText: 'skill habilidade procedimento reutilizavel catalogo',
    fonte,
    tools: [{
      name: 'hab_ver',
      description: 'Mostra o corpo de uma habilidade sem carregar.',
      schema: z.object({ id: z.string() }),
      handler: async () => ({ ok: true }),
    }],
  }];
}

function montarOrquestrador({ fonte, provider, chamadasEmbed = [], extra = {} } = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(fonte),
    embedder: embedderVetorial(chamadasEmbed),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: provider ?? providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    ...extra,
  });
}

/** Copiado de `test/guarda-manual.test.js`: monta um turno chamando `tool` a partir do EXEMPLO
 *  CANÔNICO que a própria estratégia envelope ensina, em vez de um fixture à mão. */
function turnoChamando({ tool, args, chat }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = chat;
  return JSON.stringify(exemplo);
}
const FECHA = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

test('(a) kairos SUGERE a skill (anel skill, bloco turn:context) e nunca a carrega sozinho', async () => {
  const fonte = fonteFake();
  const orq = montarOrquestrador({ fonte });
  const { payload, discover, estado } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills, 'discover tem skills');
  assert.ok(
    discover.skills.suggest.includes(REF_SKILL),
    `skill da fonte não apareceu em discover.skills.suggest: ${JSON.stringify(discover.skills)}`,
  );
  assert.deepEqual(discover.skills.activate, [], 'nenhuma skill deveria ser ATIVADA sozinha pelo kairos — só sugerida');

  const explicada = discover.explain.find((x) => x.ring === 'skill' && x.ref === REF_SKILL);
  assert.ok(explicada, `skill não aparece em discover.explain com ring "skill": ${JSON.stringify(discover.explain)}`);

  // Bloco de sugestão na MENSAGEM DO TURNO (turn:context — não system:stable): o kairos sugere,
  // não carrega. O corpo da skill não pode estar em lugar nenhum do prompt deste turno.
  assert.match(payload.mensagemDoTurno, /Skills sugeridas para este turno/);
  assert.match(payload.mensagemDoTurno, new RegExp(REF_SKILL.replace(/\//g, '\\/')));
  assert.doesNotMatch(payload.mensagemDoTurno, new RegExp(CORPO_MARCADOR));
  assert.doesNotMatch(payload.system, new RegExp(CORPO_MARCADOR));

  // `state.loadedSkills` (o que o host round-tripa pro turno seguinte) continua vazio: sugerir
  // não é carregar — quem carrega é `hab_carregar`, nunca o kairos por conta própria.
  assert.deepEqual(estado.kairos.loadedSkills, []);
});

/**
 * I3a (revisão final do conjunto, spec 2) — a skill sugerida (`discover.skills.suggest`, ref
 * `habilidades/skill/planejar-semana`) promove o PROVIDER dono (`habilidades`, `ref.split('/')[0]`)
 * antes da montagem do prompt: sem isso o modelo vê a sugestão mas `habilidades` (dona de
 * `hab_carregar`, a única forma de agir sobre a sugestão) pode ficar de fora de
 * `discover.providers.load` neste turno — sugestão sem caminho de ação.
 */
test('(c) I3a: skill sugerida promove o provider dono — habilidades entra em providers.load e no system', async () => {
  const fonte = fonteFake();
  const orq = montarOrquestrador({ fonte });
  const {
    discover, payload, promocoes,
  } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills.suggest.includes(REF_SKILL));
  assert.ok(
    discover.providers.load.includes('habilidades'),
    `habilidades deveria ter sido promovido pela skill sugerida: ${JSON.stringify(discover.providers)}`,
  );
  assert.match(payload.system, /Trabalha com as habilidades/);
  assert.ok(promocoes, 'executarTurno deveria devolver promocoes');
  assert.deepEqual(promocoes.skills, ['habilidades']);
});

// Recálculo da promoção (`promoverNoTurno`): o `explain` gravado é o do SEGUNDO discover. Antes,
// `applySessionPolicy` registrava em `recentUse` tudo de `providers.load` com o turno ATUAL, e o
// recálculo dava `boost` (recência, turnsAgo 0 = 0.05) a quem só entrou neste turno.
test('(c2) I3a: recálculo da promoção não dá boost de uso recente a quem só entrou neste turno (chat novo)', async () => {
  const orq = montarOrquestrador({ fonte: fonteFake() });
  const { discover, promocoes, estado } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.deepEqual(promocoes.skills, ['habilidades'], 'pré-condição: a promoção rodou (segundo discover)');
  const doProvider = discover.explain.filter((x) => x.ring === 'provider' && x.scores);
  assert.ok(doProvider.length > 0, `explain sem scores de provider: ${JSON.stringify(discover.explain)}`);
  for (const e of doProvider) {
    assert.equal(e.scores.boost ?? 0, 0, `boost falso em ${e.ref}: ${JSON.stringify(e.scores)}`);
  }
  // O estado que sai do turno segue registrando o uso do turno (kairosFechado, não o intermediário).
  assert.ok(
    estado.kairos.recentUse.some((r) => r.ref === 'habilidades' && r.turn === 0),
    `recentUse do estado final perdeu o uso do turno: ${JSON.stringify(estado.kairos.recentUse)}`,
  );
});

// Promoção I3a só com tier final `full`. Com refinador no anel `skill`, candidata (voto 0,31, acima
// do corte de candidata 0,3) continua sugerida mas NÃO promove o poder dono; fica registrada em
// `promocoes.skillsAbaixoDoCorte`. Sem refinador (J0), o teste (c) acima cobre a promoção. `full`
// vira `skills.activate` (semeada pelo host), nunca `suggest` — I3a não a vê (ver refino.test.js k.4).
test('(c3) I3a: skill candidate com voto 0,31 não promove o provider e aparece em skillsAbaixoDoCorte', async () => {
  const orq = montarOrquestrador({
    fonte: fonteFake(),
    extra: {
      refinadores: {
        skill: (input) => ({
          full: [],
          candidates: input.items.map((it) => it.ref),
          explain: Object.fromEntries(input.items.map((it) => [it.ref, { reason: 'jev: noul 0.31', confidence: 0.31 }])),
        }),
      },
    },
  });
  const { discover, promocoes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills.suggest.includes(REF_SKILL), 'continua sugerida');
  assert.deepEqual(promocoes.skills, []);
  assert.ok(!discover.providers.load.includes('habilidades'), 'habilidades não deveria ser promovido por candidata');
  assert.deepEqual(promocoes.skillsAbaixoDoCorte, [{ skill: REF_SKILL, voto: 0.31, tier: 'candidate' }]);
  assert.deepEqual(promocoes.semVoto, []);
});

test('(d) I3a: sem skill sugerida (pergunta não casa o marcador), nada é promovido por este mecanismo', async () => {
  const fonte = fonteFake();
  const orq = montarOrquestrador({ fonte });
  const {
    discover, promocoes,
  } = await orq.executarTurno({ texto: 'qual é a previsão do tempo para amanha na capital', estado: ESTADO_INICIAL });

  assert.deepEqual(discover.skills.suggest, []);
  assert.deepEqual(promocoes.skills, []);
});

test('(b) load_capability com a ref da skill sugerida NÃO carrega o corpo: skill não está em listTools()', async () => {
  const fonte = fonteFake();
  const orq = montarOrquestrador({
    fonte,
    provider: providerDeTexto([
      turnoChamando({ tool: 'load_capability', args: { refs: [REF_SKILL] }, chat: 'Carregando.' }),
      FECHA,
    ]),
  });

  const {
    resultado, operacoes, runId, runStore, estado,
  } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  // `load_capability` é meta-tool e nunca lança por ref desconhecida — só rejeita
  // internamente (`rejected`) e não carrega nada.
  assert.equal(operacoes[0].ok, true, 'load_capability não pode ter lançado');

  const snapshot = await runStore.load(runId);
  const resultadoDaTool = snapshot.history.find((m) => m.role === 'tool_result');
  assert.ok(resultadoDaTool, 'não achei o tool_result da chamada de load_capability');
  assert.doesNotMatch(
    resultadoDaTool.content,
    new RegExp(CORPO_MARCADOR),
    'load_capability não pode ter trazido o corpo da skill — skill não é uma tool para o dispatcher do kairos',
  );

  // Nada foi promovido a "carregado": o turno seguinte não veria a skill como já carregada.
  assert.deepEqual(estado.kairos.loadedSkills, []);
});

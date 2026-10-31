import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador, derivarRefino } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Task 9 (`docs/superpowers/plans/done/2026-09-20-decisor-por-anel-refinadores-do-kairos.md`,
 * spec `docs/superpowers/specs/done/2026-09-20-decisor-por-anel-refinadores-do-kairos-design.md`
 * R1/R5/R6, §3.3) — o gancho `aoDescobrir` (J3, `test/ao-descobrir.test.js`, removido nesta
 * task) saiu: o decisor entre o discover e a montagem do prompt, que rodava DEPOIS do discover
 * do kairos e disparava um SEGUNDO `bridge.prepareTurn` por fora para aplicar o que pediu, foi
 * substituído pelo refino por anel do kairos 0.833 (`config.refinadores`/`config.refino`) — o
 * refinador roda DENTRO do próprio `discover()`, anel por anel, sem turno extra.
 *
 * Fixtures (`providerFechado`, `embedderVetorial`, `fonteFake`, `capacidades`,
 * `montarOrquestrador`) COPIADOS de `test/fontes.test.js` — `fonteFake`/`capacidades`/
 * `montarOrquestrador` estão exportados lá (comentário do arquivo: "o plano cresce os casos
 * deste arquivo... e são o mesmo fixture"), mas importar o MÓDULO de teste re-executaria todos
 * os `test(...)` que ele registra como efeito colateral do import (cada arquivo de
 * `node --test` é isolado; um import cross-file duplicaria a contagem) — a convenção do pacote
 * (`test/skills.test.js`, comentário do topo) é copiar, nunca importar. `PERGUNTA`/
 * `ESTADO_INICIAL` não estão exportados lá (checado por grep) — copiados também, com o mesmo
 * valor.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR o que eu tenho na agenda amanha?';

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

function embedderVetorial(chamadas = []) {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      chamadas.push(texto);
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('ENRIQUECIDO')) return [0, 1];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_TAREFAS')) return [0, 1];
      return [0, 0];
    },
  };
}

/** Mesmo fixture de `fontes.test.js`: piso `sempre` + skill `planejar-semana`, `selecionar()`
 *  sem `carregar` por default — não dispara a promoção de fontes (`promoverNoTurno`), então o
 *  único `prepareTurn`/`discover()` do turno é o de baixo (relevante para os casos (b)/(e) que
 *  provam "rodou uma vez só"). */
function fonteFake(selecao = {}) {
  return {
    fonte: {
      piso: [{
        ref: 'memoria/piso/sempre',
        kind: 'context',
        floor: true,
        volatil: true,
        destination: 'system:stable',
        priority: 1032,
        description: 'Memórias sempre presentes',
        read: async () => '## Memória — sempre\n- **nome:** Patrick',
      }],
      async selecionar() {
        return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null, ...selecao };
      },
      async skills() {
        return [{
          key: 'planejar-semana',
          descricao: 'Planeja a semana',
          semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana',
          corpo: async () => '# Planejar\nPasso 1',
        }];
      },
      aoFechar() {},
    },
  };
}

function capacidades(fonte) {
  return [
    {
      id: 'memoria', descricao: 'Memória do usuário.', piso: true, semanticText: 'memoria lembrancas', fonte,
      tools: [{ name: 'mem_ver', description: 'Vê uma memória.', schema: z.object({}), fixa: true, handler: async () => ({}) }],
    },
    {
      id: 'google-calendar', descricao: 'Agenda.', piso: false, semanticText: 'DOC_SEMANTICO_CALENDAR agenda compromissos',
      tools: [{ name: 'listar', description: 'Lista eventos.', schema: z.object({}), handler: async () => ({ eventos: [] }) }],
    },
    {
      id: 'tarefas', descricao: 'Tarefas.', piso: false, semanticText: 'DOC_SEMANTICO_TAREFAS tarefas pendencias',
      tools: [{ name: 'listar', description: 'Lista tarefas.', schema: z.object({}), handler: async () => ({ tarefas: [] }) }],
    },
  ];
}

/** Fixture do caso (k)/(k.2) — provider `habilidades` NÃO é piso, dono de uma skill que o kairos
 *  só SUGERE (candidate) quando `habilidades` ainda não está carregado, o gatilho de I3a (o
 *  provider dono da skill sugerida é promovido por um segundo `prepareTurn`). Hoisted para o
 *  módulo (antes vivia só dentro do corpo do teste (k)) porque (k.2) precisa do MESMO fixture —
 *  `fixa: true` em `hab_ver` (N1, correção do re-review final): sem isso a tool não é `pinned`
 *  (`capacidades.js`: `tool.fixa ?? piso`, e aqui `piso: false`) e o motor do kairos nunca a
 *  propõe `full` fora do orçamento semântico só por `habilidades` entrar em `loadedProviders` —
 *  (k.2) precisa de uma tool que hidrate SÓ por causa da promoção, para provar que o anel `tool`
 *  sem memoização (N1) a alcança no segundo `discover()`. */
function capacidadesComSkillNaoPiso() {
  return [{
    id: 'habilidades',
    descricao: 'Trabalha com habilidades.',
    piso: false,
    semanticText: 'skill habilidade procedimento',
    fonte: {
      piso: [],
      async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
      async skills() {
        return [{
          key: 'planejar-semana',
          descricao: 'Planeja a semana',
          semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana',
          corpo: async () => '# Planejar\nPasso 1',
        }];
      },
      aoFechar() {},
    },
    tools: [{ name: 'hab_ver', description: 'Mostra.', schema: z.object({}), fixa: true, handler: async () => ({}) }],
  }];
}

/**
 * N1 (correção do re-review final) — reproduz localmente o wrapper de memoização por turno de
 * `packages/executor/src/orchestration/fabrica/refinadores.js#refinadoresDoTurno`. O orquestrador
 * não pode importar `@igris/executor` para reusar o de verdade — é o executor que depende do
 * orquestrador (`packages/executor/package.json` declara `@igris/orchestrator`), nunca o
 * contrário; importar na direção oposta seria dependência invertida. O caso (k.2) abaixo precisa
 * da MESMA regra ponta a ponta (não só a unidade, já coberta em
 * `packages/executor/test/fabrica-refino.test.js`): memoiza `provider`/`skill` por
 * `${anel}\n${texto}` dentro do turno (um `Map` por chamada desta função, nunca reusado entre
 * turnos), e NUNCA `tool` — o universo de tools cresce entre o primeiro e o segundo `prepareTurn`
 * de I3a (o provider promovido entra em `loadedProviders`, o motor propõe `full` para as tools
 * `fixa` dele só na segunda chamada), e memoizar `tool` faria a resposta do primeiro discover
 * (que não citou essas tools) descartá-las por R2 (silêncio = discard).
 * @param {{ provider?: Function, tool?: Function, skill?: Function }} refinadores
 */
function refinadoresMemoizadosDoTurno(refinadores) {
  const ANEIS_MEMOIZAVEIS = new Set(['provider', 'skill']);
  const cache = new Map();
  const memoizados = {};
  for (const anel of Object.keys(refinadores)) {
    if (!ANEIS_MEMOIZAVEIS.has(anel)) {
      memoizados[anel] = refinadores[anel];
      continue;
    }
    memoizados[anel] = (input) => {
      const chave = `${anel}\n${input?.query?.text ?? ''}`;
      if (!cache.has(chave)) cache.set(chave, refinadores[anel](input));
      return cache.get(chave);
    };
  }
  return memoizados;
}

/** `extra` espalha direto na config de `criarOrquestrador` — é assim que `refinadores`/`refino`
 *  chegam sem crescer a assinatura deste helper (mesmo padrão de `fontes.test.js`). */
function montarOrquestrador({ fonte, chamadasEmbed = [], extra = {} } = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(fonte),
    embedder: embedderVetorial(chamadasEmbed),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    ...extra,
  });
}

test('(a) refinador do anel `provider` é chamado UMA vez por turno, com input.ring/items/proposal/query.text corretos', async () => {
  const { fonte } = fonteFake();
  const chamadas = [];
  const espiao = (input) => {
    chamadas.push(input);
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  const orq = montarOrquestrador({ fonte, extra: { refinadores: { provider: espiao } } });

  const { resultado } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadas.length, 1, 'o refinador do anel provider precisa ser chamado exatamente uma vez por turno');
  const input = chamadas[0];
  assert.equal(input.ring, 'provider');
  assert.ok(input.items.length > 0, `input.items precisa vir com a lista ordenada do anel; recebido=${JSON.stringify(input.items)}`);
  assert.ok(input.proposal, 'input.proposal (a proposta do motor) precisa vir presente');
  assert.equal(input.query.text, PERGUNTA, 'input.query.text precisa ser o texto da pergunta deste turno');
});

test('(b) refinador `provider` devolve full:[tarefas]/candidates:[] numa pergunta de agenda: tarefas carrega, google-calendar não, e roda em UM único discover (sem o segundo prepareTurn do extinto aoDescobrir)', async () => {
  const { fonte } = fonteFake();
  let chamadasDoRefinador = 0;
  const refinadorProvider = () => {
    chamadasDoRefinador += 1;
    return { full: ['tarefas'], candidates: [] };
  };
  const orq = montarOrquestrador({ fonte, extra: { refinadores: { provider: refinadorProvider } } });

  const { discover, payload } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.providers.load.includes('tarefas'), `refinador forçou tarefas a full — precisa entrar em providers.load: ${JSON.stringify(discover.providers)}`);
  assert.ok(!discover.providers.load.includes('google-calendar'), 'google-calendar não foi citado pelo refinador — silêncio é discard (R2)');
  assert.match(payload.system, /Tarefas\./, 'a descrição de tarefas precisa entrar no system (provider carregado)');
  assert.doesNotMatch(payload.system, /Agenda\./, 'a descrição de calendário não pode aparecer — google-calendar não carregou');

  const explicada = discover.explain.find((e) => e.ring === 'provider' && e.ref === 'tarefas');
  assert.ok(explicada, `discover.explain precisa ter uma entrada do anel provider para "tarefas": ${JSON.stringify(discover.explain)}`);
  assert.ok(explicada.proposedTier, 'proposedTier precisa vir preenchido quando o anel teve refinador registrado');
  assert.equal(explicada.tier, 'full');

  // Prova de "UM prepareTurn": `refinarAnel` (kairos, resolve/discover.js) roda DENTRO de cada
  // `discover()` — se houvesse um segundo `prepareTurn` (como o extinto gancho `aoDescobrir`
  // disparava por fora), o refinador do anel provider rodaria de novo nele. `fonteFake` aqui não
  // pede `carregar` (default `{}` → `selecao.carregar` vazio), então a promoção de fontes
  // (Task 6) também não dispara um segundo `prepareTurn` — só o refinador confirma isso.
  assert.equal(chamadasDoRefinador, 1, 'o refinador só pode ter rodado uma vez — nenhum segundo discover() neste turno');
});

test('(c) sem `refinadores`: explain não ganha proposedTier/refiner, e o comportamento é idêntico ao caso (a) de fontes.test.js (sem refino)', async () => {
  const { fonte } = fonteFake();
  const orq = montarOrquestrador({ fonte });

  const { payload, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  // Mesmo cenário e mesmas asserções do caso (a) de `test/fontes.test.js` — snapshot de que
  // omitir `refinadores` não muda nada do comportamento pré-refino (R1: "sem refiners, saída
  // idêntica à de 0.832").
  assert.match(payload.system, /Memória — sempre/);
  assert.match(payload.system, /Patrick/);

  for (const entrada of discover.explain) {
    assert.equal(entrada.proposedTier, undefined, `entrada ${entrada.ref} não devia ter proposedTier sem refinador registrado: ${JSON.stringify(entrada)}`);
    assert.equal(entrada.refiner, undefined, `entrada ${entrada.ref} não devia ter refiner sem refinador registrado: ${JSON.stringify(entrada)}`);
  }
});

test('(d) `config.aoDescobrir`/`prazoDoDecisorMs`/`tetoDoDecisor` foram removidos: `criarOrquestrador` lança TypeError apontando para refinadores/refino', () => {
  const { fonte } = fonteFake();

  const chamaComAoDescobrir = () => montarOrquestrador({ fonte, extra: { aoDescobrir: () => ({}) } });
  const chamaComPrazo = () => montarOrquestrador({ fonte, extra: { prazoDoDecisorMs: 100 } });
  const chamaComTeto = () => montarOrquestrador({ fonte, extra: { tetoDoDecisor: 5 } });

  for (const chama of [chamaComAoDescobrir, chamaComPrazo, chamaComTeto]) {
    assert.throws(chama, TypeError, 'config antiga (aoDescobrir/prazoDoDecisorMs/tetoDoDecisor) precisa lançar TypeError');
  }
  assert.throws(
    chamaComAoDescobrir,
    (err) => err instanceof TypeError && /refinadores/.test(err.message) && /refino/.test(err.message),
    'a mensagem do TypeError precisa apontar o host para o substituto (refinadores/refino)',
  );
});

test('(e) `refino.prazoMs` chega ao createManager como `refinerBudgetMs`: refinador lento (100ms) com prazoMs:20 cai em fallback:timeout, e o turno completa', async () => {
  const { fonte } = fonteFake();
  const refinadorLento = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: refinadorLento }, refino: { prazoMs: 20 } },
  });

  const { resultado, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed', 'refinador lento estourando o prazo não pode derrubar o turno');
  const comFallback = discover.explain.find((e) => e.ring === 'provider' && e.refiner?.reason === 'fallback:timeout');
  assert.ok(comFallback, `esperava ao menos uma entrada do anel provider com refiner.reason === 'fallback:timeout'; explain=${JSON.stringify(discover.explain)}`);
});

test('(f) eventosDoKairos inclui refiner.applied do turno, quando o refinador rodou dentro do prazo', async () => {
  const { fonte } = fonteFake();
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: (input) => ({ full: input.proposal.full, candidates: input.proposal.candidates }) } },
  });

  const { eventosDoKairos } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  const aplicado = eventosDoKairos.find((e) => e.type === 'refiner.applied' && e.ring === 'provider');
  assert.ok(aplicado, `esperava um evento refiner.applied do anel provider; eventosDoKairos=${JSON.stringify(eventosDoKairos)}`);
  assert.equal(typeof aplicado.ms, 'number');
  assert.equal(typeof aplicado.changed, 'number');
});

test('(f.2) eventosDoKairos inclui refiner.fallback do turno, quando o refinador estoura o prazo', async () => {
  const { fonte } = fonteFake();
  const refinadorLento = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: refinadorLento }, refino: { prazoMs: 20 } },
  });

  const { eventosDoKairos } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  const fallback = eventosDoKairos.find((e) => e.type === 'refiner.fallback' && e.ring === 'provider');
  assert.ok(fallback, `esperava um evento refiner.fallback do anel provider; eventosDoKairos=${JSON.stringify(eventosDoKairos)}`);
  assert.equal(fallback.reason, 'timeout');
});

/**
 * Task 10 (`docs/superpowers/plans/done/2026-09-20-decisor-por-anel-refinadores-do-kairos.md`,
 * spec R10, §3.3) — a promoção de `carregar` das fontes (antigo bloco "Task 6") deixa de
 * disparar um SEGUNDO `bridge.prepareTurn` por fora: entra no ESTADO passado ao PRIMEIRO
 * `prepareTurn` (`estadoKairosDoTurno`, `src/index.js`), que o kairos já trata como
 * `loadedProviders` (`discover.js`: `providersToHydrate = dedupe([...always, ...full,
 * ...state.loadedProviders])`). O ÚNICO caso que ainda dispara um segundo `prepareTurn` é I3a
 * (provider dono de skill SUGERIDA sem estar carregado — ver caso (k)). E a mesma Task expõe
 * `discover.skills.activate` (skill ATIVADA pelo refinador do anel `skill`, distinta de
 * SUGERIDA): a fábrica semeia via `config.aoSemear` e injeta o corpo na mensagem do turno.
 */

test('(g) carregar da fonte entra pelo estado do PRIMEIRO prepareTurn (R10): tarefas carrega full, promocoes.fontes, e o refinador do anel provider roda uma única vez', async () => {
  const { fonte } = fonteFake({ carregar: ['tarefas'] });
  let chamadasDoRefinador = 0;
  const espiao = (input) => {
    chamadasDoRefinador += 1;
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  let montagens = 0;
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: espiao }, aoMontar: () => { montagens += 1; } },
  });

  const { discover, payload, promocoes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(
    discover.providers.load.includes('tarefas'),
    `tarefas devia entrar em providers.load via o estado injetado antes do primeiro prepareTurn: ${JSON.stringify(discover.providers)}`,
  );
  assert.match(payload.system, /Tarefas\./, 'a descrição de tarefas precisa entrar no system (provider carregado)');
  assert.deepEqual(promocoes.fontes, ['tarefas']);
  assert.equal(montagens, 1, 'aoMontar só pode ser chamado uma vez por turno (um único prepareTurn "de verdade")');
  assert.equal(
    chamadasDoRefinador, 1,
    'R10: o refinador do anel provider só pode rodar uma vez — a promoção de carregar das fontes não dispara mais um segundo discover()',
  );
});

test('(h) a promoção pelo estado é pegajosa: no turno seguinte, sem a fonte pedir carregar de novo, tarefas continua em providers.load', async () => {
  const { fonte } = fonteFake({ carregar: ['tarefas'] });
  const orq = montarOrquestrador({ fonte });

  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(t1.discover.providers.load.includes('tarefas'));

  // Turno 2: a fonte já não pede mais `carregar` — texto NÃO trivial, para o discover rodar de
  // verdade (prova a pegajosidade via `loadedProviders`, não o atalho de `unchanged`).
  fonte.selecionar = async () => ({ incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null });
  const t2 = await orq.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR e amanha?', estado: t1.estado });

  assert.ok(
    t2.discover.providers.load.includes('tarefas'),
    `tarefas deveria continuar carregada via loadedProviders (pegajosa), sem a fonte pedir de novo: ${JSON.stringify(t2.discover.providers)}`,
  );
  assert.deepEqual(
    t2.promocoes.fontes, [],
    'nada NOVO entrou neste turno — tarefas já estava em estadoAnterior.kairos.loadedProviders antes dele',
  );
});

test('(i) refinador do anel `skill` ativa a skill da fonte (full): aoSemear é chamado, o corpo entra na mensagem do turno (não no system), loadedSkills fica vazio, e a ativação não conta como sugestão em promocoes.skills', async () => {
  const { fonte } = fonteFake();
  const semeadas = [];
  const orq = montarOrquestrador({
    fonte,
    extra: {
      refinadores: { skill: (input) => ({ full: ['memoria/skill/planejar-semana'], candidates: [] }) },
      aoSemear: async (ids, ctx) => {
        semeadas.push({ ids, ctx });
        return ids.map((id) => ({ id, nome: `skill:${id}`, corpo: '# Planejar\nPasso 1' }));
      },
    },
  });

  const { payload, estado, promocoes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(semeadas.length, 1, 'aoSemear precisa ter sido chamado exatamente uma vez (só a origem "skill ativada" — a fonte não pediu semear)');
  assert.deepEqual(semeadas[0].ids, ['planejar-semana']);
  assert.ok(semeadas[0].ctx, 'aoSemear recebe o ctx do turno');
  assert.match(payload.mensagemDoTurno, /Habilidade carregada agora/);
  assert.match(payload.mensagemDoTurno, /Passo 1/);
  assert.doesNotMatch(payload.system, /Passo 1/, 'skill ativada não é piso — não pode ir para o system acumulado');
  assert.deepEqual(estado.kairos.loadedSkills, [], 'skills.activation:"host" — o kairos nunca marca sozinho como carregada');
  assert.ok(
    !promocoes.skills.includes('memoria'),
    'skill ATIVADA não é skill SUGERIDA (discover.skills.activate/.suggest são mutuamente exclusivos) — não deve promover por I3a',
  );
});

test('(i2) revisão do conjunto, I1: o aviso de versão da habilidade ativada entra no bloco #ativada, na frente do corpo, na MESMA mensagem do turno', async () => {
  const { fonte } = fonteFake();
  const aviso = '> ⚠️ Habilidade escrita na versão 0.1.0. Desde então o Igris faz melhor:\n> - ler arquivo da habilidade com hab_ver';
  const orq = montarOrquestrador({
    fonte,
    extra: {
      refinadores: { skill: () => ({ full: ['memoria/skill/planejar-semana'], candidates: [] }) },
      aoSemear: async (ids) => ({
        sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: '# Planejar\nPasso 1', aviso })),
        falhas: [],
      }),
    },
  });

  const { payload } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  const esperado = `Habilidade carregada agora: skill:planejar-semana\n\n${aviso}\n\n# Planejar\nPasso 1`;
  assert.ok(
    payload.mensagemDoTurno.includes(esperado),
    `o bloco #ativada não trouxe cabeçalho + aviso + corpo, nessa ordem:\n${payload.mensagemDoTurno}`,
  );
});

test('(j) aoSemear sem retorno útil não produz bloco nem erro; aoSemear lançando entra em renderErrors sem derrubar o turno', async () => {
  const refinadorSkill = (input) => ({ full: ['memoria/skill/planejar-semana'], candidates: [] });

  // sub-caso 1: aoSemear devolve undefined — nada é injetado, sem erro.
  const { fonte: fonte1 } = fonteFake();
  const orq1 = montarOrquestrador({
    fonte: fonte1,
    extra: { refinadores: { skill: refinadorSkill }, aoSemear: async () => undefined },
  });
  const t1 = await orq1.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(t1.resultado.type, 'completed');
  assert.doesNotMatch(t1.payload.mensagemDoTurno, /Habilidade carregada agora/);
  assert.ok(!t1.renderErrors.some((e) => e.ref === 'fontes/semear'));

  // sub-caso 2: aoSemear lança — o turno completa, o erro vai para renderErrors.
  const { fonte: fonte2 } = fonteFake();
  const orq2 = montarOrquestrador({
    fonte: fonte2,
    extra: { refinadores: { skill: refinadorSkill }, aoSemear: async () => { throw new Error('semear ativada falhou'); } },
  });
  const t2 = await orq2.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(t2.resultado.type, 'completed', 'aoSemear lançando na ativação não pode derrubar o turno');
  assert.ok(
    t2.renderErrors.some((e) => e.ref === 'fontes/semear'),
    `renderErrors não trouxe fontes/semear: ${JSON.stringify(t2.renderErrors)}`,
  );

  // sub-caso 3 (F4, correção da revisão final do conjunto): aoSemear devolve o formato NOVO
  // `{ sucessos, falhas }` (o que `semearNaMemoriaDeTrabalho` do chat devolve desde esta
  // correção) — bloco para o sucesso, `renderErrors` (`ref: 'fontes/semear'`) para a falha, sem
  // lançar e sem misturar as duas listas.
  const { fonte: fonte3 } = fonteFake();
  const orq3 = montarOrquestrador({
    fonte: fonte3,
    extra: {
      refinadores: { skill: refinadorSkill },
      aoSemear: async (ids) => ({
        sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: '# Planejar\nPasso 1' })),
        falhas: [{ id: 'skill-que-nao-existe', erro: 'skill_not_found' }],
      }),
    },
  });
  const t3 = await orq3.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(t3.resultado.type, 'completed');
  assert.match(t3.payload.mensagemDoTurno, /Habilidade carregada agora/, 'sucesso de {sucessos,falhas} precisa virar bloco na mensagem do turno');
  assert.match(t3.payload.mensagemDoTurno, /Passo 1/);
  assert.ok(
    t3.renderErrors.some((e) => e.ref === 'fontes/semear' && String(e.error).includes('skill-que-nao-existe')),
    `renderErrors não trouxe a falha de {sucessos,falhas}: ${JSON.stringify(t3.renderErrors)}`,
  );
});

test('(k) skill sugerida (candidate) sem o provider carregado continua promovendo o provider via I3a — o único caso que ainda dispara um segundo prepareTurn', async () => {
  let chamadasDoRefinadorProvider = 0;
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesComSkillNaoPiso(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    refinadores: {
      // F1 (correção da revisão final do conjunto): atraso de 20ms — prova, junto com a
      // asserção de `refino.porAnel.provider.ms` abaixo, que os DOIS `refiner.applied` (um por
      // `prepareTurn` de I3a) são SOMADOS no host (orquestrador), não sobrescritos. A
      // memoização (F1, `packages/executor/.../fabrica/refinadores.js`) é do lado do CHAT —
      // evita a SEGUNDA chamada ao cliente do Jev —, mas aqui o refinador de teste não usa
      // aquele wrapper: cada `prepareTurn` chama esta função de novo, e o kairos mede as duas
      // rodadas de verdade (~20ms cada).
      provider: async (input) => {
        chamadasDoRefinadorProvider += 1;
        await new Promise((resolve) => { setTimeout(resolve, 20); });
        return { full: input.proposal.full, candidates: input.proposal.candidates };
      },
    },
  });

  const { discover, payload, promocoes, refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills.suggest.includes('habilidades/skill/planejar-semana'));
  assert.ok(
    discover.providers.load.includes('habilidades'),
    `I3a precisa ter promovido habilidades: ${JSON.stringify(discover.providers)}`,
  );
  assert.match(payload.system, /Trabalha com habilidades/);
  assert.ok(promocoes.skills.includes('habilidades'), 'promocoes.skills precisa conter o provider promovido por I3a');
  // Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`): sem refinador registrado no anel `skill`
  // (só `provider` acima), o `explain` daquele anel não tem `refiner` — comportamento de antes
  // (J0): promove normalmente, e `semVoto` fica vazio.
  assert.deepEqual(promocoes.semVoto, [], 'sem refinador no anel skill (J0), I3a promove como antes e semVoto fica vazio');
  assert.equal(
    chamadasDoRefinadorProvider, 2,
    'I3a dispara um SEGUNDO prepareTurn — o refinador do anel provider roda de novo nele (único caso que ainda faz isso)',
  );
  // F1: `refino.porAnel.provider.ms` precisa ser a SOMA dos dois `refiner.applied` (um por
  // `prepareTurn`), não o `ms` da última rodada sozinha — com ~20ms de atraso em cada uma, a
  // soma real fica perto de 40ms; `Math.max` (o bug antigo) ficaria perto de 20ms.
  assert.ok(refino, 'refino nao pode ser null com refinador provider registrado');
  const TOLERANCIA_MS = 15;
  assert.ok(
    refino.porAnel.provider.ms >= 40 - TOLERANCIA_MS,
    `refino.porAnel.provider.ms (${refino.porAnel.provider.ms}) deveria somar as DUAS rodadas de I3a (~20ms cada, >= ${40 - TOLERANCIA_MS}ms) — provable de que 'ms' soma, nao sobrescreve`,
  );
});

// Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`, spec "decisor por anel", medição de 21/09): em
// todo turno frio o anel `skill` degradava (timeout do Jev) e o I3a promovia a capacidade dona
// da skill sugerida MESMO sem voto real — pagando um segundo `discover()`/rodada de funções por
// engano. Mesmo fixture do caso (k) (`capacidadesComSkillNaoPiso`, mesmo embedder/limiares), só
// trocando o refinador: agora é o anel `skill` que degrada, não o `provider`.
test('(k.3) skill sugerida com refinador do anel skill DEGRADADO (jev:degradado): I3a nao promove — promocoes.skills vazio, promocoes.semVoto tem o ref, e nao ha um segundo prepareTurn/discover', async () => {
  let chamadasDoRefinadorSkill = 0;
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesComSkillNaoPiso(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    refinadores: {
      skill: (input) => {
        chamadasDoRefinadorSkill += 1;
        return {
          full: input.proposal.full,
          candidates: input.proposal.candidates,
          explain: Object.fromEntries(input.items.map((it) => [it.ref, { reason: 'jev:degradado (timeout)' }])),
        };
      },
    },
  });

  const { discover, promocoes, eventosDoKairos } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills.suggest.includes('habilidades/skill/planejar-semana'), `skill precisa continuar sugerida: ${JSON.stringify(discover.skills)}`);
  assert.deepEqual(promocoes.skills, [], 'sem voto real do Jev no anel skill, I3a nao pode promover a capacidade');
  assert.deepEqual(promocoes.semVoto, ['habilidades/skill/planejar-semana'], 'o ref da skill sugerida precisa ir para semVoto');
  assert.ok(
    !discover.providers.load.includes('habilidades'),
    `habilidades nao pode ter sido carregado sem voto real do Jev: ${JSON.stringify(discover.providers)}`,
  );
  assert.equal(
    chamadasDoRefinadorSkill, 1,
    'sem promocao (semVoto), I3a nao dispara um segundo prepareTurn/discover — o refinador do anel skill roda uma unica vez',
  );
  // Correção do review da Fase 1 (#2): a asserção anterior ("0 refiner.applied para o anel
  // tool") era estruturalmente verdadeira — este cenário nunca registra refinador no anel
  // `tool`, então o filtro sempre dá zero, refino tendo rodado ou não. A prova real de "um
  // único discover" é o anel que ESTE cenário refina (`skill`) ter exatamente um
  // `refiner.applied` — dois discovers dariam dois.
  const refinerAppliedSkill = (eventosDoKairos ?? []).filter((e) => e?.type === 'refiner.applied' && e?.ring === 'skill');
  assert.equal(refinerAppliedSkill.length, 1, 'sem promocao (semVoto), nao ha segundo discover — um unico refiner.applied do anel skill');
});

// (k.4) — acabamento do review final (I3a por lista BRANCA de `confidence`, não mais lista negra
// de `reason`). Mesmo fixture do caso (k)/(k.3). Duas rodadas com o MESMO fixture, só trocando o
// `explain` que o refinador do anel `skill` devolve: (1) `reason: 'jev:sem-resposta'` SEM
// `confidence` — a lista negra antiga já cobria este `reason` por nome; a lista branca nova
// precisa continuar cobrindo (sem depender de reconhecer a string); (2) `reason` qualquer com
// `confidence` numérica — precisa promover, prova de que a lista branca positiva funciona (não
// só a ausência de refiner/J0, já coberto pelo caso (k)).
test('(k.4) I3a por lista branca de confidence: refiner sem confidence numerica vai para semVoto (mesmo com reason novo/nao mapeado); com confidence numerica e tier candidate, nao promove (skillsAbaixoDoCorte)', async () => {
  // Ajuste (promoção I3a só com tier `full`): o refinador deste teste devolvia o `proposal` do
  // motor (tier `candidate`) com confidence 0.9, e isso promovia. Agora candidata com voto
  // numérico NÃO promove (vai para `skillsAbaixoDoCorte`). `full` nunca chega ao I3a: o kairos
  // põe `full` em `skills.activate` (semeada pelo host), não em `skills.suggest`, que é o que o
  // I3a percorre.
  async function rodar(explainPorRef, { comoFull = false } = {}) {
    const orq = criarOrquestrador({
      base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
      capacidades: capacidadesComSkillNaoPiso(),
      embedder: embedderVetorial(),
      protocolo: 'envelope',
      protocoloOpts: { headless: true },
      provider: providerFechado(),
      decorarTool: DECORAR_TOOL_NO_OP,
      limiares: { zCandidate: -1.01, rawFloor: 0 },
      refinadores: {
        skill: (input) => ({
          full: comoFull ? input.items.map((it) => it.ref) : input.proposal.full,
          candidates: comoFull ? [] : input.proposal.candidates,
          explain: Object.fromEntries(input.items.map((it) => [it.ref, explainPorRef])),
        }),
      },
    });
    return orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  }

  const semConfidence = await rodar({ reason: 'jev:sem-resposta' });
  assert.deepEqual(semConfidence.promocoes.skills, [], 'sem confidence numerica, I3a nao promove');
  assert.deepEqual(
    semConfidence.promocoes.semVoto,
    ['habilidades/skill/planejar-semana'],
    'refiner sem confidence numerica (reason jev:sem-resposta) precisa ir para semVoto',
  );

  // Voto numérico mas tier `candidate`: só sugerida, não promove, e fica registrada.
  const comConfidence = await rodar({ reason: 'jev: noul 0.9', confidence: 0.9 });
  assert.deepEqual(comConfidence.promocoes.semVoto, [], 'com confidence numerica, o ref nao pode ir para semVoto');
  assert.deepEqual(comConfidence.promocoes.skills, [], 'candidate (tier != full) nao promove o provider dono');
  assert.deepEqual(comConfidence.promocoes.skillsAbaixoDoCorte, [
    { skill: 'habilidades/skill/planejar-semana', voto: 0.9, tier: 'candidate' },
  ]);

  // Tier `full`: vira `skills.activate` (host semeia), nunca entra em suggest — I3a não promove
  // nem registra abaixo do corte.
  const full = await rodar({ reason: 'jev: noul 0.9', confidence: 0.9 }, { comoFull: true });
  assert.deepEqual(full.promocoes.skillsAbaixoDoCorte, []);
  assert.deepEqual(full.skillsAtivadas, ['habilidades/skill/planejar-semana']);
});

// N1 (correção do re-review final) — mesmo gatilho do caso (k) (I3a: skill sugerida promove o
// provider dono por um segundo `prepareTurn`), agora com os refinadores passados pelo wrapper
// memoizado por turno (`refinadoresMemoizadosDoTurno`, reprodução local de
// `packages/executor/.../fabrica/refinadores.js#refinadoresDoTurno`). Prova ponta a ponta de que
// a exceção do `tool` no wrapper é necessária: `hab_ver` (capacidade `habilidades`, `fixa: true`)
// só entra em `state.loadedProviders`/vira candidato a `pinned` DEPOIS da promoção de I3a — o
// primeiro `discover()` não tem `habilidades` carregado, então o anel `tool` nem recebe o item
// naquela chamada. Se o wrapper memoizasse `tool` (como memoiza `provider`/`skill`), a segunda
// chamada do anel `tool` (já com `hab_ver` no universo) seria descartada e a resposta memoizada
// da primeira (sem `hab_ver`) prevaleceria — por R2 do kairos (silêncio = discard), `hab_ver`
// nunca apareceria em `discover.tools.hydrate`, mesmo sendo `fixa`/`pinned`.
test('(k.2) I3a + wrapper memoizado (N1): tool NUNCA memoiza, e a tool fixa do provider promovido chega em discover.tools.hydrate', async () => {
  let chamadasProvider = 0;
  let chamadasTool = 0;
  const refinadoresBrutos = {
    provider: async (input) => {
      chamadasProvider += 1;
      return { full: input.proposal.full, candidates: input.proposal.candidates };
    },
    tool: async (input) => {
      chamadasTool += 1;
      return { full: input.proposal.full, candidates: input.proposal.candidates };
    },
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesComSkillNaoPiso(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    refinadores: refinadoresMemoizadosDoTurno(refinadoresBrutos),
  });

  const { discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(discover.skills.suggest.includes('habilidades/skill/planejar-semana'));
  assert.ok(
    discover.providers.load.includes('habilidades'),
    `I3a precisa ter promovido habilidades: ${JSON.stringify(discover.providers)}`,
  );
  assert.equal(
    chamadasProvider, 1,
    'provider continua memoizado pelo wrapper: mesmo texto nos dois prepareTurn do turno, uma chamada só ao cliente',
  );
  assert.equal(
    chamadasTool, 2,
    'tool nunca memoiza (N1): o segundo prepareTurn de I3a pergunta de novo, mesmo com o mesmo texto',
  );
  assert.ok(
    discover.tools.hydrate.includes('habilidades/tool/hab_ver'),
    `discover.tools.hydrate precisa conter a tool fixa do provider promovido por I3a — sem isto o segundo discover() a descartaria por R2 (silêncio = discard): ${JSON.stringify(discover.tools)}`,
  );
});

/**
 * Task 11 (`docs/superpowers/plans/done/2026-09-20-decisor-por-anel-refinadores-do-kairos.md`,
 * spec R11/§3.4) — `refino: { msTotal, degradado, porAnel: { <ring>: { enviados, respondidos,
 * ms, degradado, mudancas } } }` no retorno de `executarTurno` (e no `info` de `aoMontar`,
 * checado à parte em `test/ao-montar.test.js`), derivado de `prepared.discoverResult.explain`
 * (`proposedTier`/`tier`/`refiner.{reason,confidence}`) e dos eventos `refiner.applied`/
 * `refiner.fallback` (Task 9) já capturados em `eventosDoKairos`. `enviados`/`respondidos` só
 * contam refinadores do Igris (`reason` prefixado `jev:`) — um refinador de teste que devolve
 * `full`/`candidates` sem `explain` (todos os casos (a)-(k) acima) nunca incrementa nenhum dos
 * dois, mas ainda estampa `proposedTier`/`tier` — por isso os casos abaixo usam `explain`
 * explícito quando querem provar `enviados`/`respondidos`/`mudancas`.
 */

// Q5 (correção do review da Fase 3): `enviados`/`respondidos` são AGNÓSTICOS de host —
// `google-calendar` aqui usa de propósito um `reason` SEM o prefixo `jev:` (a convenção do
// Igris, não do contrato genérico do refinador) para provar que ainda conta: o que importa é
// `refiner` presente com `reason` que não veio de fallback do motor nem do corte por teto, não
// o texto exato que o host escreveu.
test('(l) refinador provider com explain de qualquer host: mudancas com de/para/confianca, enviados/respondidos agnosticos de prefixo, degradado null', async () => {
  const { fonte } = fonteFake();
  const refinadorProvider = () => ({
    full: ['tarefas'],
    candidates: ['google-calendar'],
    explain: {
      tarefas: { reason: 'jev: noul 0.9', confidence: 0.9 },
      'google-calendar': { reason: 'motivo-de-outro-host: 0.2', confidence: 0.2 },
    },
  });
  const orq = montarOrquestrador({ fonte, extra: { refinadores: { provider: refinadorProvider } } });

  const { refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(refino, 'refino não pode ser null quando há refinador registrado');
  const anelProvider = refino.porAnel.provider;
  assert.ok(
    anelProvider.mudancas.some((m) => m.ref === 'tarefas' && m.de === 'discard' && m.para === 'full' && m.confianca === 0.9),
    `mudancas não trouxe tarefas discard->full: ${JSON.stringify(anelProvider.mudancas)}`,
  );
  assert.ok(
    anelProvider.mudancas.some((m) => m.ref === 'google-calendar' && m.de === 'full' && m.para === 'candidate' && m.confianca === 0.2),
    `mudancas não trouxe google-calendar full->candidate: ${JSON.stringify(anelProvider.mudancas)}`,
  );
  assert.equal(
    anelProvider.enviados, 2,
    `enviados precisa contar as duas entradas com refiner presente e reason que nao e fallback:/teto (mesmo a de outro host, sem prefixo jev:): ${JSON.stringify(anelProvider)}`,
  );
  assert.equal(anelProvider.respondidos, 2, `respondidos precisa contar as duas entradas com confidence numérico: ${JSON.stringify(anelProvider)}`);
  assert.equal(typeof anelProvider.ms, 'number');
  assert.ok(anelProvider.ms >= 0);
  assert.equal(anelProvider.degradado, null);
  assert.ok(refino.msTotal >= anelProvider.ms, `msTotal (${refino.msTotal}) precisa ser >= ao ms do único anel (${anelProvider.ms})`);
});

// Q5: prova negativa — `reason: 'teto'` (sintético do motor, cortado só pelo teto duro de
// `full`, sem `explain` próprio do refinador para o ref) e `reason: 'fallback:*'` (o refinador
// nunca respondeu para aquele ref) NÃO contam em `enviados`, mesmo com `refiner` presente.
test('(l.2) reason "teto" (corte do motor) e "fallback:*" (motor sem resposta do refinador) nao contam em enviados', async () => {
  const { fonte } = fonteFake();
  const refinadorProvider = () => ({
    full: ['tarefas'],
    candidates: ['google-calendar'],
    explain: {
      tarefas: { reason: 'teto' },
      'google-calendar': { reason: 'fallback:invalid' },
    },
  });
  const orq = montarOrquestrador({ fonte, extra: { refinadores: { provider: refinadorProvider } } });

  const { refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(refino, 'refino não pode ser null quando há refinador registrado');
  const anelProvider = refino.porAnel.provider;
  assert.equal(anelProvider.enviados, 0, `nem 'teto' nem 'fallback:*' podem contar em enviados: ${JSON.stringify(anelProvider)}`);
  assert.equal(anelProvider.respondidos, 0, 'nenhuma das duas entradas tem confidence numérico');
});

test('(m) refinador provider que estoura o prazo: porAnel.provider.degradado é "timeout", mudancas vazio, respondidos 0', async () => {
  const { fonte } = fonteFake();
  const refinadorLento = async (input) => {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: refinadorLento }, refino: { prazoMs: 20 } },
  });

  const { refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(refino, 'refino não pode ser null — o refinador foi registrado, mesmo caindo em fallback');
  const anelProvider = refino.porAnel.provider;
  assert.equal(anelProvider.degradado, 'timeout', `esperava degradado "timeout": ${JSON.stringify(anelProvider)}`);
  assert.deepEqual(anelProvider.mudancas, [], 'fallback aplica a proposta do motor — não há "mudança" para registrar');
  assert.equal(anelProvider.respondidos, 0, 'o refinador nunca respondeu dentro do prazo — respondidos precisa ser 0');
});

test('(n) sem refinadores registrados: refino é null', async () => {
  const { fonte } = fonteFake();
  const orq = montarOrquestrador({ fonte });

  const { refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(refino, null);
});

// Q2 (correção do review da Fase 3): `tool` roda numa SEGUNDA onda do kairos, DEPOIS de
// `provider`/`skill`/`source`/`conversation` (que rodam juntos, em paralelo, na PRIMEIRA — ver
// `discover.js` do kairos e o JSDoc de `refino` em `ConfigDoOrquestrador`, `src/index.js`). O
// `Math.max` puro entre os anéis (versão anterior deste teste) subestimava o tempo de parede real
// sempre que `tool` tinha refinador registrado — `msTotal` precisa ser a maior `ms` da primeira
// onda MAIS o `ms` de `tool`.
test('(o) três refinadores (provider/tool/skill): porAnel tem as três chaves; msTotal soma a onda 2 (tool) à maior da onda 1 (provider/skill aqui), nao e so o maximo', async () => {
  const { fonte } = fonteFake();
  const atraso = (ms) => async (input) => {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    return { full: input.proposal.full, candidates: input.proposal.candidates };
  };
  const orq = montarOrquestrador({
    fonte,
    extra: { refinadores: { provider: atraso(30), tool: atraso(30), skill: atraso(30) } },
  });

  const t0 = Date.now();
  const { refino } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const paredeMs = Date.now() - t0;

  assert.ok(refino, 'refino não pode ser null com três refinadores registrados');
  assert.deepEqual(
    Object.keys(refino.porAnel).sort(),
    ['provider', 'skill', 'tool'],
    `porAnel precisa ter as três chaves: ${JSON.stringify(refino.porAnel)}`,
  );
  const msDosAneis = Object.values(refino.porAnel).map((a) => a.ms);
  assert.ok(msDosAneis.every((ms) => typeof ms === 'number'), `todos os anéis precisam ter ms numérico: ${JSON.stringify(refino.porAnel)}`);
  // Tolerância para o overhead do próprio orquestrador em cima dos 30ms de cada `setTimeout`
  // (event loop, scheduling do teste) — a prova é que a SOMA das duas ondas está presente, não
  // um número exato.
  const TOLERANCIA_MS = 25;
  assert.ok(
    refino.msTotal >= refino.porAnel.provider.ms + refino.porAnel.tool.ms - TOLERANCIA_MS,
    `msTotal (${refino.msTotal}) deveria ser >= provider.ms + tool.ms - tolerancia (${refino.porAnel.provider.ms} + ${refino.porAnel.tool.ms} - ${TOLERANCIA_MS}); porAnel=${JSON.stringify(refino.porAnel)}`,
  );
  // Prova indireta de que a soma continua sendo um tempo de parede plausível — as duas ondas
  // rodam DENTRO do turno, nunca depois dele, então msTotal não pode exceder o tempo de parede
  // real do `executarTurno` inteiro.
  assert.ok(
    refino.msTotal <= paredeMs,
    `msTotal (${refino.msTotal}) nao pode ser maior que o tempo de parede do turno inteiro (${paredeMs}ms)`,
  );
});

// Reproduz o cenário do caso (o) de `test/fontes.test.js` (piso que falha ao renderizar entra em
// `renderErrors` sem derrubar o turno) trocando o GATILHO do segundo `prepareTurn`: a Task 10
// tirou a promoção de `carregar` das fontes como gatilho (hoje entra no estado do PRIMEIRO
// `prepareTurn`, um único discover) — o único gatilho que sobra é I3a (provider dono de uma
// skill SUGERIDA sem estar carregado, ver caso (k) acima). O piso aqui falha SÓ na SEGUNDA
// leitura (não na primeira) de propósito: se `mesclarRenderErrors` não estivesse mesclando o
// `renderErrors` do segundo `prepareTurn`, o erro da segunda leitura nunca apareceria no
// `renderErrors` final (o da primeira leitura, que sempre teve sucesso, não geraria erro nenhum).
test('(p) I3a dispara um segundo prepareTurn: piso que falha SÓ na segunda leitura ainda cai em renderErrors (mesclarRenderErrors)', async () => {
  let chamadasRead = 0;
  const capacidadesComPisoInstavelESkill = [
    {
      id: 'memoria',
      descricao: 'Memória do usuário.',
      piso: true,
      semanticText: 'memoria lembrancas',
      fonte: {
        piso: [{
          ref: 'memoria/piso/instavel',
          kind: 'context',
          floor: true,
          volatil: true,
          destination: 'system:stable',
          priority: 1032,
          description: 'Piso que falha só na segunda leitura do turno (I3a, segundo prepareTurn)',
          read: async () => {
            chamadasRead += 1;
            if (chamadasRead === 2) throw new Error('falhou na segunda leitura');
            return '## Memória — sempre\n- **nome:** Patrick';
          },
        }],
        async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
        async skills() { return []; },
        aoFechar() {},
      },
      tools: [{ name: 'mem_ver', description: 'Vê uma memória.', schema: z.object({}), fixa: true, handler: async () => ({}) }],
    },
    {
      id: 'habilidades',
      descricao: 'Trabalha com habilidades.',
      piso: false,
      semanticText: 'skill habilidade procedimento',
      fonte: {
        piso: [],
        async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
        async skills() {
          return [{
            key: 'planejar-semana',
            descricao: 'Planeja a semana',
            semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana',
            corpo: async () => '# Planejar\nPasso 1',
          }];
        },
        aoFechar() {},
      },
      tools: [{ name: 'hab_ver', description: 'Mostra.', schema: z.object({}), handler: async () => ({}) }],
    },
  ];

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesComPisoInstavelESkill,
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    // Refinador `skill` devolvendo `candidates` — o gatilho pedido pela task: a skill entra em
    // `discover.skills.suggest` (candidate, não full) pelo caminho do REFINO, não só pela
    // proposta crua do motor.
    refinadores: {
      skill: (input) => ({ full: [], candidates: input.proposal.candidates }),
    },
  });

  const { resultado, discover, renderErrors } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed', 'um piso que lança na segunda leitura não pode derrubar o turno');
  assert.ok(
    discover.skills.suggest.includes('habilidades/skill/planejar-semana'),
    `skill precisa estar sugerida (gatilho do I3a): ${JSON.stringify(discover.skills)}`,
  );
  assert.ok(
    discover.providers.load.includes('habilidades'),
    `I3a precisa ter promovido habilidades — é o que dispara o segundo prepareTurn: ${JSON.stringify(discover.providers)}`,
  );
  assert.equal(chamadasRead, 2, 'o piso precisa ter sido lido duas vezes — uma por prepareTurn deste turno');
  assert.ok(
    renderErrors.some((e) => e.ref === 'memoria/piso/instavel'),
    `renderErrors não trouxe o erro da SEGUNDA leitura do piso (prova de mesclarRenderErrors): ${JSON.stringify(renderErrors)}`,
  );
});

/**
 * N2 (correção do re-review final, kairos 0.834 — bump pendente): `discover.explain[]` ganha
 * entradas SINTÉTICAS quando um refinador cita um ref FORA do anel que estava avaliando —
 * `{ ref, ring, reason: 'refinador citou ref fora do anel', refiner: { reason: 'ignorada' } }`.
 * A versão de `@okds/kairos` instalada nesta worktree ainda é 0.833 (`pnpm-workspace.yaml`
 * declara `^0.833.260920`, `node_modules` traz `0.833.260920`) — não produz essas entradas de
 * verdade, então os testes abaixo chamam `derivarRefino` (extraída de `executarTurno`,
 * `src/index.js`) direto, com um `explain` sintético, em vez de montar um turno inteiro.
 */
test('(q) derivarRefino: entrada com refiner.reason "ignorada" nao conta em enviados/respondidos, vai para porAnel[ring].ignoradas, e nao gera mudanca', () => {
  const explain = [
    { ref: 'tarefas', ring: 'provider', proposedTier: 'discard', tier: 'full', refiner: { reason: 'jev: noul 0.9', confidence: 0.9 } },
    { ref: 'nao-existe', ring: 'provider', reason: 'refinador citou ref fora do anel', refiner: { reason: 'ignorada' } },
  ];
  const eventosDoKairos = [{ type: 'refiner.applied', ring: 'provider', ms: 12, changed: 1 }];

  const refino = derivarRefino(explain, eventosDoKairos);

  assert.ok(refino, 'refino nao pode ser null com explain nao vazio');
  const anelProvider = refino.porAnel.provider;
  assert.equal(anelProvider.enviados, 1, `só a entrada "tarefas" (refiner de verdade) pode contar em enviados: ${JSON.stringify(anelProvider)}`);
  assert.equal(anelProvider.respondidos, 1, `só "tarefas" tem confidence numérico: ${JSON.stringify(anelProvider)}`);
  assert.deepEqual(anelProvider.ignoradas, ['nao-existe'], `"nao-existe" (refiner.reason === 'ignorada') precisa ir para ignoradas: ${JSON.stringify(anelProvider)}`);
  assert.ok(
    !anelProvider.mudancas.some((m) => m.ref === 'nao-existe'),
    `"nao-existe" nao pode gerar mudanca (nao é uma decisão de tier real): ${JSON.stringify(anelProvider.mudancas)}`,
  );
  assert.ok(
    anelProvider.mudancas.some((m) => m.ref === 'tarefas' && m.de === 'discard' && m.para === 'full'),
    `"tarefas" precisa continuar gerando mudanca normalmente: ${JSON.stringify(anelProvider.mudancas)}`,
  );
});

test('(q.2) derivarRefino: anel só com entradas "ignorada" ainda aparece em porAnel (com ignoradas preenchido, enviados/respondidos zerados)', () => {
  const explain = [
    { ref: 'x', ring: 'tool', reason: 'refinador citou ref fora do anel', refiner: { reason: 'ignorada' } },
    { ref: 'y', ring: 'tool', reason: 'refinador citou ref fora do anel', refiner: { reason: 'ignorada' } },
  ];

  const refino = derivarRefino(explain, []);

  assert.ok(refino, 'refino nao pode ser null');
  const anelTool = refino.porAnel.tool;
  assert.deepEqual(anelTool.ignoradas, ['x', 'y']);
  assert.equal(anelTool.enviados, 0);
  assert.equal(anelTool.respondidos, 0);
  assert.deepEqual(anelTool.mudancas, []);
});

test('(q.3) derivarRefino: sem explain (array vazio) e sem eventos devolve null (mesmo comportamento de "sem refinadores registrados")', () => {
  assert.equal(derivarRefino([], []), null);
});

// Task 4 (`2026-09-21-ajustes-de-uso-da-fabrica`) — o cache de respostas do Jev por turno
// (Task 1-3 do mesmo plano, `packages/decisions/src/refinadores/criar-refinador-jev.js`)
// devolve `explain[ref].reason` terminando em `(cache)` para itens respondidos pelo cache, com
// `confidence` numérico. Continuam contando em `respondidos` (têm confidence), mas NÃO em
// `enviados` (não foram, de fato, perguntados ao Jev nesta chamada).
test('(q.4) derivarRefino: entradas com reason "(cache)" contam em respondidos e em doCache, nao em enviados', () => {
  const explain = [
    { ring: 'tool', ref: 'a/tool/x', proposedTier: 'candidate', tier: 'full', refiner: { reason: 'jev: noul 0.80 (cache)', confidence: 0.8 } },
    { ring: 'tool', ref: 'a/tool/y', proposedTier: 'candidate', tier: 'candidate', refiner: { reason: 'jev: noul 0.20', confidence: 0.2 } },
  ];
  const r = derivarRefino(explain, [{ type: 'refiner.applied', ring: 'tool', ms: 3, changed: 1, ignored: [] }]);
  assert.equal(r.porAnel.tool.enviados, 1);
  assert.equal(r.porAnel.tool.respondidos, 2);
  assert.equal(r.porAnel.tool.doCache, 1);
});

// Kairos 0.836: `config.semantica` liga os vetores por item que o kairos entrega aos refinadores
// (`RefineInput.semantica`, `RefineItem.semantica`). DEPENDE da 0.836 instalada — pula (não passa
// em silêncio: o motivo aparece) enquanto a worktree tiver a 0.835.
const kairosInstalado = await (async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  let dir = dirname(fileURLToPath(import.meta.resolve('@okds/kairos/core/hash')));
  for (;;) {
    const arq = join(dir, 'package.json');
    if (existsSync(arq)) {
      const pkg = JSON.parse(readFileSync(arq, 'utf8'));
      if (pkg.name === '@okds/kairos') return pkg.version;
    }
    const acima = dirname(dir);
    if (acima === dir) throw new Error('package.json de @okds/kairos não encontrado');
    dir = acima;
  }
})();
const temSemantica = Number(kairosInstalado.split('.')[1]) >= 836;

test('(semantica) com `semantica` na config o RefineInput e os items trazem `semantica`; sem ela, nada disso (embedder presente nos dois)',
  { skip: temSemantica ? false : `precisa de @okds/kairos >= 0.836 (instalado: ${kairosInstalado})` },
  async () => {
    const { fonte } = fonteFake();
    const passa = (i) => ({ full: i.proposal.full, candidates: i.proposal.candidates });
    const com = { provider: [], tool: [] };
    await montarOrquestrador({ fonte, extra: {
      refinadores: {
        provider: (i) => { com.provider.push(i); return passa(i); },
        tool: (i) => { com.tool.push(i); return passa(i); },
      },
      semantica: { aneis: ['provider', 'tool'] },
    } }).executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
    assert.equal(com.provider.length, 1);
    assert.ok(com.provider[0].semantica, `RefineInput.semantica precisa vir presente: ${JSON.stringify(Object.keys(com.provider[0]))}`);
    const doProvider = com.provider[0].items.filter((it) => it.semantica);
    assert.ok(doProvider.length > 0, 'ao menos um item do anel provider precisa trazer `semantica`');
    assert.ok(doProvider.some((it) => it.semantica.texto || it.semantica.exemplos?.length), 'o item do provider leva `texto` ou `exemplos`');
    // O anel tool só é refinado se o motor propõe tools nesse turno; quando é, os items têm que trazer a semântica.
    for (const entrada of com.tool) {
      assert.ok(entrada.semantica, 'RefineInput.semantica também no anel tool');
      assert.ok(entrada.items.some((it) => it.semantica && (it.semantica.texto || it.semantica.exemplos?.length)), 'item do anel tool leva `texto` ou `exemplos`');
    }

    const sem = { provider: [], tool: [] };
    await montarOrquestrador({ fonte, extra: {
      refinadores: {
        provider: (i) => { sem.provider.push(i); return passa(i); },
        tool: (i) => { sem.tool.push(i); return passa(i); },
      },
    } }).executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
    assert.equal(sem.provider.length, 1);
    assert.ok(!sem.provider[0].semantica, 'sem `semantica` na config, o input segue como antes');
    assert.ok(sem.provider[0].items.every((it) => !it.semantica), 'sem `semantica` na config, nenhum item traz `semantica`');
    for (const entrada of sem.tool) assert.ok(!entrada.semantica && entrada.items.every((it) => !it.semantica));
  });

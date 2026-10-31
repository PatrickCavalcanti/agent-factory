import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Task 5 (`docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`
 * §3.1, §3.4 passos 3-4) — `FonteDeclarada` no contrato de capacidade: o `piso` da fonte entra
 * no catálogo do agente pela MESMA validação de `config.contribuicoes`, e `skills()` é
 * registrada no kairos junto do provider da capacidade (`capacidades.js#montarProviders`,
 * `index.js#montarCatalogo`). `selecionar`/`aoFechar` da fonte (Task 6) NÃO são exercitados
 * aqui — só a montagem do catálogo.
 *
 * Helpers copiados de `test/dois-vetores.test.js` (ESTADO_KAIROS_VAZIO, ESTADO_INICIAL,
 * DECORAR_TOOL_NO_OP, providerFechado(), embedderVetorial()) — `embedderVetorial` ganhou o
 * marcador `ENRIQUECIDO` de propósito, para a Task 6 reusar sem editar este arquivo de novo.
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

/**
 * `fonteFake`/`capacidades`/`montarOrquestrador` ficam exportados: o plano cresce os casos
 * deste arquivo nas Tasks 6-7 (`selecionar`/`aoFechar` de verdade), e são o mesmo fixture.
 *
 * A skill ganha `semanticText` com o MESMO marcador da pergunta (`PERGUNTA_DO_USUARIO_MARCADOR`)
 * de propósito: sem ele, `semanticDoc` (kairos `core/hash.ts`) cairia no fallback
 * título+descrição ("Planeja a semana"), o `embedderVetorial` acima devolveria `[0,0]` (nenhum
 * marcador bate) e a skill nunca passaria `DEFAULT_THRESHOLDS.contribution.candidate` (0.08,
 * kairos `resolve/discover.ts`) — o teste (a) "provaria" o registro por um caminho que uma skill
 * NUNCA registrada também passaria (`discover.skills.suggest` vazio nos dois casos). Com o
 * marcador, cosseno 1.0 garante presença em `discover.skills.suggest` SE E SÓ SE o registro
 * aconteceu de verdade — prova pelo pipeline real do kairos, não um artefato do mock.
 */
export function fonteFake(selecao = {}) {
  const chamadas = [];
  return {
    chamadas,
    fonte: {
      piso: [{
        ref: 'memoria/piso/sempre',
        kind: 'context',
        floor: true,
        volatil: true,
        // `destination` é OPCIONAL na `Contribution` do kairos, mas o default de arbitragem
        // sem ele é `turn:context` (`resolve/destinations.ts:39` — "intended ?? 'turn:context'"),
        // não `system:stable`: sem declarar, o piso ia para a mensagem do turno, não para o
        // system persistido — medido rodando este teste sem o campo. Todo `floor: true` deste
        // pacote que precisa persistir declara `destination` explícito (ver
        // `test/travas.test.js`, `test/reconstrucao-unchanged.test.js`).
        destination: 'system:stable',
        priority: 1032,
        description: 'Memórias sempre presentes',
        read: async () => '## Memória — sempre\n- **nome:** Patrick',
      }],
      async selecionar(ctx, sem) {
        chamadas.push({ vetor1: sem.vetor1, capacidadesCarregadas: sem.capacidadesCarregadas });
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

export function capacidades(fonte) {
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

/** `extra` existe para a Task 6 passar `prazoDaFonteMs` sem editar este helper de novo. */
export function montarOrquestrador({ fonte, chamadasEmbed = [], aoMontar, aoSemear, extra = {} } = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(fonte),
    embedder: embedderVetorial(chamadasEmbed),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    ...(aoMontar ? { aoMontar } : {}),
    ...(aoSemear ? { aoSemear } : {}),
    ...extra,
  });
}

test('(a) catálogo: piso da fonte entra no system e a skill da fonte é registrada no kairos', async () => {
  const { fonte } = fonteFake();
  const orq = montarOrquestrador({ fonte });
  const { payload, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.match(payload.system, /Memória — sempre/);
  assert.match(payload.system, /Patrick/);

  assert.ok(discover.skills, 'discover tem skills');
  assert.ok(
    discover.skills.suggest.includes('memoria/skill/planejar-semana'),
    `skill da fonte não apareceu em discover.skills.suggest: ${JSON.stringify(discover.skills)}`,
  );
  const explicada = discover.explain.find((x) => x.ring === 'skill' && x.ref === 'memoria/skill/planejar-semana');
  assert.ok(explicada, `skill da fonte não aparece em discover.explain com ring "skill": ${JSON.stringify(discover.explain)}`);
});

test('(b) capacidade sem `fonte`: catálogo monta normalmente, sem piso nem skill extra', async () => {
  const orq = montarOrquestrador({ fonte: undefined });
  const { payload, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(!payload.system.includes('Memória — sempre'));
  assert.ok(!discover.skills.suggest.includes('memoria/skill/planejar-semana'));
});

/**
 * Task 6 (`docs/superpowers/specs/2026-09-20-contrato-de-fonte-memoria-e-habilidades-design.md`
 * §3.1, §3.4 passos 3-4) — `executarTurno` passa a chamar `selecionar(ctx, { vetor1, embedar })`
 * de todas as fontes em paralelo com prazo, pôr `incluidos` como blocos `turn:context` na
 * mensagem do turno, promover `carregar` pelo MESMO caminho que o decisor usa, embedar o texto
 * enriquecido como vetor 2, chamar `config.aoSemear` e devolver `fontes` no retorno/`aoMontar`.
 *
 * Letras seguem de (c): o arquivo já tinha (a)/(b) da Task 5 quando este passo zero rodou — o
 * texto do plano descrevia "só o caso (a)", divergência sem efeito na task (só relabeling).
 */

test('(c) incluidos vão à mensagem do turno com motivo; piso continua no system', async () => {
  const { fonte } = fonteFake({ incluidos: [{ ref: 'memoria/memory/preferences.python', conteudo: '### Preferências\n- **python:** prefere scripts curtos', motivo: 'semantica', score: 0.32 }] });
  const orq = montarOrquestrador({ fonte });
  const { payload, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.match(payload.mensagemDoTurno, /prefere scripts curtos/);
  assert.doesNotMatch(payload.system, /prefere scripts curtos/);
  assert.equal(fontes[0].id, 'memoria');
  assert.deepEqual(fontes[0].incluidos.map((i) => [i.ref, i.motivo]), [['memoria/memory/preferences.python', 'semantica']]);
});

test('(c2) valor/carrega do incluido vão ao trace fontes[], nunca ao prompt', async () => {
  const { fonte } = fonteFake({ incluidos: [
    { ref: 'memoria/memory/preferences.ha', conteudo: '### Preferências\n- **ha:** conteudo-do-prompt', motivo: 'semantica', score: 0.26, valor: 'valor-so-no-trace', carrega: ['power/mcp-home-assistant'] },
    { ref: 'memoria/memory/preferences.sem', conteudo: 'x', motivo: 'semantica' },
  ] });
  const orq = montarOrquestrador({ fonte });
  const { payload, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(fontes[0].incluidos[0].valor, 'valor-so-no-trace');
  assert.deepEqual(fontes[0].incluidos[0].carrega, ['power/mcp-home-assistant']);
  assert.equal('valor' in fontes[0].incluidos[1], false);
  assert.equal('carrega' in fontes[0].incluidos[1], false);
  assert.doesNotMatch(payload.mensagemDoTurno, /valor-so-no-trace/);
  assert.doesNotMatch(payload.system, /valor-so-no-trace/);
});

test('(d0) a fonte recebe as capacidades já carregadas: piso no 1º turno; sessão (loadedProviders) no 2º', async () => {
  const { fonte, chamadas } = fonteFake();
  const orq = montarOrquestrador({ fonte });
  await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(chamadas[0].capacidadesCarregadas, ['memoria'], 'só o piso antes de qualquer carga');

  // 2º turno: a sessão já carrega `tarefas` (carregada no 1º) — a fonte precisa enxergá-la.
  const estado2 = { ...ESTADO_INICIAL, turno: 1, kairos: { ...ESTADO_KAIROS_VAZIO, loadedProviders: ['tarefas'] } };
  await orq.executarTurno({ texto: PERGUNTA, estado: estado2 });
  assert.deepEqual([...chamadas[1].capacidadesCarregadas].sort(), ['memoria', 'tarefas']);
});

test('(d) carregar promove a capacidade antes do decisor: tarefas carrega full sem bater no ranking', async () => {
  const { fonte } = fonteFake({ carregar: ['tarefas'] });
  const orq = montarOrquestrador({ fonte });
  const { discover, fontes, payload } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(discover.providers.load.includes('tarefas'));
  assert.deepEqual(fontes[0].carregar, ['tarefas']);
  assert.match(payload.system, /Tarefas\./); // instruções/descrição da capacidade promovida entram
});

test('(e) enriquecer dispara o embed 2 e os dois vetores vão ao kairos', async () => {
  const chamadasEmbed = [];
  const { fonte } = fonteFake({ enriquecer: '- ENRIQUECIDO tarefas pendentes' });
  const orq = montarOrquestrador({ fonte, chamadasEmbed });
  const { embeds, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(embeds.quantos, 2);
  assert.ok(chamadasEmbed.some((t) => t.includes('ENRIQUECIDO')));
  const cal = discover.explain.find((x) => x.ring === 'provider' && x.ref === 'google-calendar');
  assert.equal(cal.scores.vectors.length, 2);
});

test('(f) fonte que estoura o prazo: turno segue, fontes[].degradado', async () => {
  const { fonte } = fonteFake();
  fonte.selecionar = () => new Promise(() => {}); // nunca resolve
  const orq = montarOrquestrador({ fonte, extra: { prazoDaFonteMs: 50 } });
  const { resultado, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.equal(fontes[0].degradado, 'prazo');
});

// Exceção de escopo autorizada (2026-09-20, correção junto da Task 7): antes desta correção,
// `refsVolateisDeclaradas` (`src/index.js#montarCatalogo`) só olhava `config.contribuicoes` —
// o piso de uma FONTE (`c.fonte?.piso`, `pisoDasFontes`) nunca entrava na lista de refs a
// recomputar em turno `unchanged`/trivial, então um piso de fonte `volatil: true` ficava
// CONGELADO no valor do turno 1 para sempre. Mesmo padrão de prova de
// `reconstrucao-unchanged.test.js` (`volatil: true`/turno trivial), aplicado ao piso da FONTE.
test('(h) piso volátil de uma fonte é recalculado em turno trivial (unchanged), não fica congelado', async () => {
  let contador = 0;
  const fonte = {
    piso: [{
      ref: 'memoria/piso/contador',
      kind: 'context',
      floor: true,
      volatil: true,
      destination: 'system:stable',
      priority: 1032,
      description: 'Contador de teste — prova que read() roda de novo em turno trivial',
      read: async () => { contador += 1; return `CONTADOR=${contador}`; },
    }],
    async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
    async skills() { return []; },
    aoFechar() {},
  };
  const orq = montarOrquestrador({ fonte });

  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.match(t1.payload.system, /CONTADOR=1/, 'piso da fonte não apareceu no turno 1');

  // Turno 2: texto TRIVIAL ('x', mesmo marcador de `reconstrucao-unchanged.test.js`) — o
  // discover é pulado (`unchanged`), mas o piso é `volatil: true` e precisa ser RECALCULADO.
  const t2 = await orq.executarTurno({ texto: 'x', estado: t1.estado });
  assert.match(
    t2.payload.system, /CONTADOR=2/,
    'piso da fonte ficou congelado em turno trivial — refsVolateisDeclaradas não incluía pisoDasFontes',
  );
  assert.equal(contador, 2, 'read() da fonte foi chamado nos dois turnos, não só no primeiro');
});

test('(g) semear chama config.aoSemear com os ids de skill; sem callback, registra em fontes[].semear sem lançar', async () => {
  const semeadas = [];
  const { fonte } = fonteFake({ semear: ['briefing'] });
  const orq = montarOrquestrador({ fonte, aoSemear: async (ids) => { semeadas.push(...ids); } });
  const { fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(semeadas, ['briefing']);
  assert.deepEqual(fontes[0].semear, ['briefing']);
  const orq2 = montarOrquestrador({ fonte: fonteFake({ semear: ['briefing'] }).fonte });
  const { fontes: f2 } = await orq2.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(f2[0].semear, ['briefing']);
});

/**
 * Correções do review de qualidade da Fase 2 (2026-09-20) — Q1, Q3, Q4, Q6.
 */

// Q1: fonte degradada por PRAZO não recebe `aoFechar` neste turno — a promise do `selecionar`
// tardio não é cancelada (`Promise.allSettled` só desiste de ESPERAR), então sem esta correção
// `aoFechar` cairia no fallback `lerSelecao(ctx)` (`packages/memory/src/fonte/index.js`) e
// registraria hits de memórias que nunca entraram no prompt deste turno.
test('(i) fonte degradada por prazo: aoFechar NÃO é chamado neste turno', async () => {
  const chamadasAoFechar = [];
  const fonte = {
    piso: [],
    async selecionar() {
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null };
    },
    async skills() { return []; },
    aoFechar(ctx, selecao) { chamadasAoFechar.push({ ctx, selecao }); },
  };
  const orq = montarOrquestrador({ fonte, extra: { prazoDaFonteMs: 30 } });
  const { resultado, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.equal(fontes[0].degradado, 'prazo');

  // Espera o `selecionar` tardio (80ms) terminar de verdade, bem depois do turno (que já
  // resolveu com o prazo de 30ms) — é exatamente essa janela que gravava a seleção tardia.
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  assert.equal(chamadasAoFechar.length, 0, 'aoFechar não deveria ter sido chamado para a fonte degradada por prazo');
});

// Q1, controle: fonte que responde DENTRO do prazo continua recebendo `aoFechar` normalmente.
test('(i-controle) fonte no prazo: aoFechar chamado uma vez com (ctx, selecao)', async () => {
  const chamadasAoFechar = [];
  const fonte = {
    piso: [],
    async selecionar() {
      return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null };
    },
    async skills() { return []; },
    aoFechar(ctx, selecao) { chamadasAoFechar.push({ ctx, selecao }); },
  };
  const orq = montarOrquestrador({ fonte });
  const { resultado, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.equal(fontes[0].degradado, null);
  assert.equal(chamadasAoFechar.length, 1, 'aoFechar deveria ter sido chamado exatamente uma vez');
  assert.ok(chamadasAoFechar[0].ctx, 'aoFechar recebe o ctx do turno');
  assert.deepEqual(
    chamadasAoFechar[0].selecao,
    { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null },
  );
});

// Task 8 (`docs/superpowers/plans/2026-09-21-ajustes-de-uso-da-fabrica.md`, correção): antes
// desta correção o `forEach` de `aoFechar` ficava só no caminho de SUCESSO do `try` de
// `executarTurno` — se o laço agêntico do genos (`orchestrator.start`) lançasse, o `finally` só
// removia o listener de abort e `aoFechar` nunca rodava, perdendo a telemetria/hits daquele
// turno inteiro mesmo quando a fonte tinha respondido dentro do prazo. `provider.generate` lança
// aqui para forçar exatamente esse caminho: o erro sobe do laço, não de `selecionar`/`aoSemear`
// (que já tinham cobertura em (j)/(k) acima, e não passam pelo `try` de `executarTurno`).
test('(p) provider.generate lança: aoFechar roda mesmo assim (uma vez) e o erro continua propagando', async () => {
  const chamadasAoFechar = [];
  const fonte = {
    piso: [],
    async selecionar() {
      return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null };
    },
    async skills() { return []; },
    aoFechar(ctx, selecao) { chamadasAoFechar.push({ ctx, selecao }); },
  };
  const providerQueLanca = () => ({
    name: 'fake-quebrado',
    model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() { throw new Error('provider quebrado de proposito'); },
  });
  const orq = montarOrquestrador({ fonte, extra: { provider: providerQueLanca } });

  await assert.rejects(
    () => orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL }),
    /provider quebrado de proposito/,
  );
  assert.equal(
    chamadasAoFechar.length, 1,
    'aoFechar deveria ter sido chamado exatamente uma vez mesmo com o laço agêntico lançando',
  );
  assert.ok(chamadasAoFechar[0].ctx, 'aoFechar recebe o ctx do turno mesmo no caminho de exceção');
});

// Q6(i): `selecionar` lançando um erro GENÉRICO (não `Error('prazo')`) — o turno completa e
// `fontes[0].degradado` começa com `'erro: '` (o ramo que já existia em `catch`, sem cobertura).
test('(j) selecionar lança erro genérico (não prazo): turno completa, fontes[0].degradado começa com "erro: "', async () => {
  const { fonte } = fonteFake();
  fonte.selecionar = async () => { throw new Error('falhou de proposito'); };
  const orq = montarOrquestrador({ fonte });
  const { resultado, fontes } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.match(fontes[0].degradado, /^erro: /);
  assert.match(fontes[0].degradado, /falhou de proposito/);
});

// Q6(ii): `aoSemear` lançando não derruba o turno — o erro cai em `renderErrors` com
// `ref: 'fontes/semear'` (mesma garantia de `aoEvento`/`aoMontar`).
test('(k) aoSemear lançando: turno completa e renderErrors contém fontes/semear', async () => {
  const { fonte } = fonteFake({ semear: ['briefing'] });
  const orq = montarOrquestrador({ fonte, aoSemear: async () => { throw new Error('semear falhou'); } });
  const { resultado, renderErrors } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.ok(
    renderErrors.some((e) => e.ref === 'fontes/semear'),
    `renderErrors não trouxe fontes/semear: ${JSON.stringify(renderErrors)}`,
  );
});

// Q3: id de capacidade DESCONHECIDA em `carregar` não entra em `discover.providers.load` (não
// promove um provider inexistente), mas continua em `fontes[].carregar` (é o que a fonte pediu)
// e gera uma entrada em `renderErrors` (`ref: 'fontes/carregar'`) para o host perceber.
test('(l) carregar com id de capacidade inexistente: não promove, continua em fontes[].carregar, gera renderErrors', async () => {
  const { fonte } = fonteFake({ carregar: ['nao-existe'] });
  const orq = montarOrquestrador({ fonte });
  const {
    resultado, discover, fontes, renderErrors,
  } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.ok(!discover.providers.load.includes('nao-existe'), 'id desconhecido não deveria promover');
  assert.deepEqual(fontes[0].carregar, ['nao-existe']);
  assert.ok(
    renderErrors.some((e) => e.ref === 'fontes/carregar' && e.error.includes('nao-existe')),
    `renderErrors não trouxe fontes/carregar: ${JSON.stringify(renderErrors)}`,
  );
});

// Q4: `enriquecimentoDasFontes.join('\n')` ganha um teto (2000 chars) antes de virar o embed 2
// — sem ele, o texto embedado cresceria sem limite conforme mais fontes enriquecem.
// M2 (revisão final do conjunto, 2026-09-20): `secoesEfemeras` (prompt-builder.js) NÃO ordena por
// `priority` dentro de uma classe — renderiza na ordem do ARRAY em que `blocosDasFontes` foi
// empilhado. Duas capacidades com fonte (`memoria` e `google-calendar`, reusando o fixture de
// `capacidades()` acima) devolvem `incluidos` com `prioridade` EXPLÍCITA e INVERTIDA em relação à
// ordem de declaração das capacidades: `memoria` (primeira, prioridade 2001) e `google-calendar`
// (segunda, prioridade 2000, MENOR). `Promise.allSettled` preserva a ordem de ENTRADA do array
// (não a de resolução) — sem o `.sort` da correção, a mensagem sairia sempre na ordem de
// declaração (memoria antes), independente da prioridade.
test('(n) M2: blocosDasFontes é ordenado por prioridade, não pela ordem de resolução das fontes', async () => {
  const { fonte: fonteMemoria } = fonteFake({
    incluidos: [{ ref: 'memoria/memory/a', conteudo: 'BLOCO_A_MARCADOR', motivo: 'sempre', prioridade: 2001 }],
  });
  const fonteCalendar = {
    piso: [],
    async selecionar() {
      return {
        incluidos: [{ ref: 'google-calendar/memory/b', conteudo: 'BLOCO_B_MARCADOR', motivo: 'sempre', prioridade: 2000 }],
        candidatos: [],
        carregar: [],
        semear: [],
        enriquecer: null,
      };
    },
    async skills() { return []; },
    aoFechar() {},
  };
  const caps = capacidades(fonteMemoria);
  caps[1] = { ...caps[1], fonte: fonteCalendar }; // google-calendar ganha uma segunda fonte, só para este teste
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: caps,
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
  });
  const { payload } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const posA = payload.mensagemDoTurno.indexOf('BLOCO_A_MARCADOR');
  const posB = payload.mensagemDoTurno.indexOf('BLOCO_B_MARCADOR');
  assert.ok(posA !== -1 && posB !== -1, `os dois marcadores deveriam estar na mensagem do turno: ${payload.mensagemDoTurno}`);
  assert.ok(posB < posA, 'prioridade 2000 (B, google-calendar) deveria vir ANTES de 2001 (A, memoria) na mensagem do turno');
});

// M5 (revisão final do conjunto, 2026-09-20) — atualizado na Task 10 (spec "decisor por anel:
// refinadores do kairos", R10): até a Task 10, a promoção de `carregar` das fontes disparava um
// SEGUNDO `bridge.prepareTurn` (`promoverNoTurno`), e este teste provava que um piso que falha
// SÓ nesse segundo `prepareTurn` ainda cai em `renderErrors` (via `mesclarRenderErrors`). A
// Task 10 tirou esse segundo `prepareTurn`: `carregar` das fontes hoje entra no ESTADO do
// PRIMEIRO `prepareTurn` (`estadoKairosDoTurno`, `src/index.js`) — um único discover, uma única
// leitura do piso. A prova que sobra aqui é mais simples (piso falhando no ÚNICO `prepareTurn`
// ainda vai para `renderErrors`, sem derrubar o turno); a prova de `mesclarRenderErrors` mesclando
// um SEGUNDO `prepareTurn` continua válida, só que hoje o único gatilho é I3a (provider dono de
// skill sugerida sem estar carregado — `test/refino.test.js` caso (k), `test/skills.test.js`
// caso (c)). F5 (correção da revisão final do conjunto): esse cenário — piso FALHANDO
// especificamente na SEGUNDA leitura de I3a — EXISTE, em `test/refino.test.js` caso (p); este
// comentário estava desatualizado (dizia que não havia).
test('(o) piso que falha ao renderizar entra em renderErrors sem derrubar o turno (carregar da fonte promovido pelo estado, um único prepareTurn)', async () => {
  let chamadas = 0;
  const fonte = {
    piso: [{
      ref: 'memoria/piso/instavel',
      kind: 'context',
      floor: true,
      volatil: true,
      destination: 'system:stable',
      priority: 1040,
      description: 'Piso que sempre falha ao renderizar (prova de M5)',
      read: async () => {
        chamadas += 1;
        throw new Error('falhou ao renderizar');
      },
    }],
    async selecionar() { return { incluidos: [], candidatos: [], carregar: ['tarefas'], semear: [], enriquecer: null }; },
    async skills() { return []; },
    aoFechar() {},
  };
  const orq = montarOrquestrador({ fonte });
  const { resultado, renderErrors, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed', 'um piso que lança não pode derrubar o turno');
  assert.ok(
    discover.providers.load.includes('tarefas'),
    `a promoção pelo estado (R10) precisa ter rodado no ÚNICO prepareTurn: ${JSON.stringify(discover.providers)}`,
  );
  assert.equal(chamadas, 1, 'R10: um único prepareTurn — o piso só é lido uma vez');
  assert.ok(
    renderErrors.some((e) => e.ref === 'memoria/piso/instavel'),
    `renderErrors não trouxe o erro do piso: ${JSON.stringify(renderErrors)}`,
  );
});

test('(m) enriquecer de 5000 chars: o texto do embed 2 tem teto de 2000 chars', async () => {
  const chamadasEmbed = [];
  const enriquecido = `ENRIQUECIDO ${'A'.repeat(5000)}`;
  const { fonte } = fonteFake({ enriquecer: enriquecido });
  const orq = montarOrquestrador({ fonte, chamadasEmbed });
  const { resultado, embeds } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.equal(embeds.quantos, 2);
  const textoEmbedado = chamadasEmbed.find((t) => t.includes('ENRIQUECIDO'));
  assert.ok(textoEmbedado, `não achei a chamada de embed do vetor 2: ${JSON.stringify(chamadasEmbed.map((t) => t.length))}`);
  assert.ok(textoEmbedado.endsWith('…'), 'texto truncado deveria terminar com reticências');
  const cabecalho = `${PERGUNTA}\n\n`;
  assert.equal(
    textoEmbedado.length, cabecalho.length + 2000 + 1,
    'teto de 2000 chars + reticências, mais o cabeçalho (pergunta + \\n\\n)',
  );
});

// N2 (re-review final, 2026-09-20): antes desta correção, o snapshot `promocoesFontes` era
// tirado FORA da guarda `!unchanged` (`src/index.js`, bloco I3a) — em turno `unchanged` a fonte
// ainda roda (comentário Task 5/6: "roda mesmo com texto trivial") e `promocoesDasFontes` ganhava
// o id de `carregar`, mas o bloco que de fato promove (`promoverNoTurno`, guardado por
// `!unchanged`) nunca rodava: o retorno dizia `promocoes.fontes: ['tarefas']` sem promoção real.
// `fontes[0].carregar` é uma telemetria separada (o que a fonte PEDIU) e não muda com a correção.
test('(n) N2: turno unchanged não promove o carregar da fonte — promocoes.fontes vazio, fontes[0].carregar preservado', async () => {
  const { fonte } = fonteFake({ carregar: ['tarefas'] });
  const orq = montarOrquestrador({ fonte });

  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(!t1.discover.unchanged, 'turno 1 roda o discover — não é o caso sob teste');
  assert.deepEqual(t1.promocoes.fontes, ['tarefas'], 'turno 1: carregar da fonte É promovido de verdade');

  // Turno 2: texto TRIVIAL ('x', mesmo marcador de `reconstrucao-unchanged.test.js`) — discover
  // pulado (`unchanged`), mas a fonte roda de novo e pede `carregar: ['tarefas']` outra vez.
  const t2 = await orq.executarTurno({ texto: 'x', estado: t1.estado });
  assert.equal(t2.discover.unchanged, true, 'pré-condição do teste: turno 2 precisa cair em unchanged');
  assert.deepEqual(
    t2.promocoes.fontes, [],
    'unchanged nunca roda promoverNoTurno — promocoes.fontes não pode listar um pedido não promovido',
  );
  assert.deepEqual(
    t2.fontes[0].carregar, ['tarefas'],
    'fontes[].carregar continua sendo o que a fonte pediu, promovido ou não',
  );
});

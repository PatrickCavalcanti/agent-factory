import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { criarPonteDoTurno, prepararPistaDeRanking } from '../src/pista-contexto.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * B3.3, fase 2 — a PISTA DE CONTEXTO no RANKING REAL (T2 do plano
 * `docs/superpowers/plans/2026-10-04-fabrica-pista-contexto-ranking.md`).
 *
 * A decisão é do helper puro do executor (T1, `decidirPistaDeContexto`); o orquestrador
 * NÃO decide elegibilidade e NÃO escolhe antecedente — ele valida a decisão, embeda no
 * máximo UM vetor contextual e entrega as `hints` ao `discover` deste turno. Este
 * arquivo prova, em duas camadas:
 *
 *  A) unidade de `prepararPistaDeRanking`/`criarPonteDoTurno` — validação, limites,
 *     motivo de fallback, reuso de vetor, imutabilidade do array recebido;
 *  B) caminho de PRODUTO (`criarOrquestrador` + `createGenosBridge` + `manager.discover`
 *     do kairos instalado, embedder vetorial determinístico, **Jev ausente** e
 *     `loadedProviders: []`): a consulta curta sozinha PERDE o candidato e, com a pista,
 *     o RANKING o recupera — medido pelo `explain`/`proposal` do discover (a ranking e a
 *     proposta), não só pelo `providers.load`.
 *
 * O gancho de observação do ranking dentro do discover é o REFINADOR por anel
 * (`config.refinadores`): ele recebe `{ query: { text, vectors }, items, proposal }`
 * DENTRO do `discover()`, antes de qualquer corte — é ali que se prova que as `hints`
 * chegaram ANTES do ranquear, que o texto original continua intacto e que os vetores
 * enviados são os que a decisão mandou usar. Ele devolve `null` (não muda nada), então a
 * ranking observada é a do motor.
 *
 * Convenção do pacote: fixtures COPIADAS, nunca importadas de outro arquivo de teste.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

/* ------------------------------------------------------------------ *
 * A) unidade
 * ------------------------------------------------------------------ */

/** Embedder determinístico de 4 dimensões que registra as consultas que recebeu. */
function embedderDeProva(dim = 4) {
  const consultas = [];
  return {
    consultas,
    modelSlug: 'pista-contexto-v1',
    async embed(texto, role) {
      if (role === 'query') consultas.push(String(texto));
      const v = new Array(dim).fill(0);
      for (const ch of String(texto).toLowerCase()) { const i = ch.charCodeAt(0) % dim; v[i] += 1; }
      const norma = Math.hypot(...v) || 1;
      return v.map((x) => x / norma);
    },
  };
}

/** Decisão no formato EXATO que o helper de T1 devolve (o orquestrador só valida). */
function decisaoDe(pista, extra = {}) {
  return { aplicar: true, motivo: 'continuidade', regra: 'acao+pronome', pista, mensagensUsadas: 2, chars: pista.length, ...extra };
}

const PISTA = 'Mostre a nota fiscal de março da ACME\nA nota de março tem três itens e vence em 05/03.';

test('unidade: sem decisão, o turno recebe exatamente os vetores que tinha — zero embed', async () => {
  const embedder = embedderDeProva();
  const vetores = [[0.1, 0.2, 0.3, 0.4]];
  const saida = await prepararPistaDeRanking({ texto: 'mostra ela', decisao: undefined, vetores, embedder });

  assert.deepEqual(saida.hints, [], 'sem decisão não há hint');
  assert.equal(saida.vetores, vetores, 'o array recebido volta por referência — nada foi copiado/mutado');
  assert.equal(embedder.consultas.length, 0, 'sem pista não se paga embed');
  assert.deepEqual(saida.diagnostico, {
    solicitada: false, aplicada: false, motivo: null, regra: null, mensagensUsadas: 0, chars: 0,
    embeds: { quantos: 0, ms: 0, erro: null },
  });
});

test('unidade: decisão negativa mantém o motivo do helper e não embeda', async () => {
  const embedder = embedderDeProva();
  const saida = await prepararPistaDeRanking({
    texto: 'abra o navegador',
    decisao: { aplicar: false, motivo: 'pedido-autonomo', regra: null, pista: null, mensagensUsadas: 0, chars: 0 },
    vetores: [[1, 0, 0, 0]],
    embedder,
  });
  assert.deepEqual(saida.hints, []);
  assert.equal(saida.diagnostico.motivo, 'pedido-autonomo', 'o motivo do helper passa intacto — a orquestração não o reescreve');
  assert.equal(saida.diagnostico.solicitada, false, 'pedido novo não é continuidade solicitada');
  assert.equal(embedder.consultas.length, 0, 'inelegível custa zero embed');
});

test('unidade: decisão fora do contrato é recusada antes de qualquer embed', async () => {
  const embedder = embedderDeProva();
  const foras = [
    decisaoDe(PISTA, { chars: PISTA.length + 1 }),            // `chars` não bate com a pista
    decisaoDe('x'.repeat(601)),                                // acima do teto de 600
    decisaoDe(PISTA, { mensagensUsadas: -1 }),                 // contador negativo
    decisaoDe(PISTA, { aplicar: true, motivo: '' }),           // motivo ausente
    decisaoDe(PISTA, { pista: '   ' }),                        // pista vazia
    { ...decisaoDe(PISTA), pista: null },                      // decisão positiva sem pista
    decisaoDe(PISTA, { regra: 7 }),                            // tipo errado no shape
  ];
  for (const decisao of foras) {
    const saida = await prepararPistaDeRanking({ texto: 'mostra ela', decisao, vetores: [[1, 0, 0, 0]], embedder });
    assert.deepEqual(saida.hints, [], `decisão inválida não pode gerar hint: ${JSON.stringify(decisao.motivo)}`);
    assert.equal(saida.diagnostico.aplicada, false);
    assert.deepEqual(saida.diagnostico.motivo, null, 'shape fora do contrato não vira motivo de fallback');
  }
  assert.equal(embedder.consultas.length, 0, 'nenhuma decisão recusada chegou ao embedder');
});

test('unidade: os quatro motivos de fallback da orquestração, sem hint lexical sobrando', async () => {
  const decisao = decisaoDe(PISTA);
  const embedderQuebrado = { ...embedderDeProva(), async embed() { throw new Error('embedder fora do ar'); } };

  const semEmbedder = await prepararPistaDeRanking({ texto: 'mostra ela', decisao, vetores: [[1, 0, 0, 0]], embedder: null });
  assert.equal(semEmbedder.diagnostico.motivo, 'sem-embedder');
  assert.deepEqual(semEmbedder.hints, [], 'sem embedder não entra hint lexical parcial');

  const semOriginal = await prepararPistaDeRanking({ texto: 'mostra ela', decisao, vetores: null, embedder: embedderDeProva() });
  assert.equal(semOriginal.diagnostico.motivo, 'embedding-original-ausente');

  const falhou = await prepararPistaDeRanking({ texto: 'mostra ela', decisao, vetores: [[1, 0, 0, 0]], embedder: embedderQuebrado });
  assert.equal(falhou.diagnostico.motivo, 'embedding-contextual-falhou');
  assert.deepEqual(falhou.hints, []);
  assert.match(falhou.diagnostico.embeds.erro, /fora do ar/, 'o erro fica no diagnóstico');
  assert.equal(falhou.diagnostico.embeds.quantos, 0, 'nenhum embedding foi produzido — a tentativa falhou');

  const cancelado = await prepararPistaDeRanking({
    texto: 'mostra ela', decisao, vetores: [[1, 0, 0, 0]], embedder: embedderDeProva(), signal: AbortSignal.abort(),
  });
  assert.equal(cancelado.diagnostico.motivo, 'cancelado');
  assert.deepEqual(cancelado.hints, [], 'cancelado não aplica pista');
});

test('unidade: cancelado DEPOIS do embed não aplica pista (o embedder aborta durante o await)', async () => {
  // O caso do brief: abortar ANTES da chamada exercita só a primeira checagem
  // (`signal?.aborted` antes do embedder). A checagem que vem DEPOIS do embed
  // contextual é outra, e é load-bearing: sem ela, um cancelamento que chega
  // enquanto o embed roda entrega pista ao discover de um turno já cancelado.
  const decisao = decisaoDe(PISTA);
  const controlador = new AbortController();
  const consultas = [];
  const vetores = [[1, 0, 0, 0]];
  const embedderQueAbortaNoEmbed = {
    modelSlug: 'pista-contexto-v1',
    async embed(texto, role) {
      if (role === 'query') consultas.push(String(texto));
      controlador.abort(); // o cancelamento CHEGA no meio do embed, e o embed resolve mesmo assim
      return [0.25, 0.5, 0.75, 1];
    },
  };

  const saida = await prepararPistaDeRanking({
    texto: 'mostra ela', decisao, vetores, embedder: embedderQueAbortaNoEmbed, signal: controlador.signal,
  });

  assert.equal(controlador.signal.aborted, true, 'o cenário é mesmo o do cancelamento no meio');
  assert.deepEqual(consultas, [`mostra ela ${PISTA}`], 'o embed contextual saiu (o cancelamento foi DEPOIS dele)');
  assert.equal(saida.diagnostico.solicitada, true, 'a pista foi pedida antes do cancelamento');
  assert.equal(saida.diagnostico.aplicada, false, 'cancelado no meio não aplica pista');
  assert.equal(saida.diagnostico.motivo, 'cancelado', 'o motivo é o de cancelamento, não o de continuidade da decisão');
  assert.equal(saida.diagnostico.embeds.quantos, 1, 'o embed foi gasto antes de o cancelamento ser visto');
  assert.deepEqual(saida.hints, [], 'nenhuma hint sobra para o discover de um turno cancelado');
  assert.equal(saida.vetores, vetores, 'os vetores originais voltam intactos — o contextual é descartado junto');
  assert.deepEqual(vetores, [[1, 0, 0, 0]], 'o array do chamador não foi mutado');
});

test('unidade: vetor contextual de dimensão diferente é recusado (o kairos o descartaria)', async () => {
  const embedder = { ...embedderDeProva(), async embed() { return [1, 0]; } };
  const saida = await prepararPistaDeRanking({ texto: 'mostra ela', decisao: decisaoDe(PISTA), vetores: [[1, 0, 0, 0]], embedder });
  assert.equal(saida.diagnostico.motivo, 'embedding-contextual-falhou');
  assert.deepEqual(saida.vetores, [[1, 0, 0, 0]], 'os vetores anteriores ficam intactos');
});

test('unidade: vetores do host/ das fontes são preservados e o contextual entra por acréscimo', async () => {
  const embedder = embedderDeProva();
  const daFonte = [0.5, 0.5, 0, 0];
  const vetores = [[1, 0, 0, 0], daFonte];
  const saida = await prepararPistaDeRanking({ texto: 'mostra ela', decisao: decisaoDe(PISTA), vetores, embedder });

  assert.deepEqual(embedder.consultas, [`mostra ela ${PISTA}`], 'embeda exatamente `${texto} ${pista}`');
  assert.deepEqual(saida.hints, [PISTA], 'a pista entra como UM hint — os quebras internas do par não a dividem');
  assert.equal(saida.vetores.length, 3, 'nenhum vetor anterior foi sobrescrito ou desligado');
  assert.equal(saida.vetores[0], vetores[0], 'o vetor original é o mesmo objeto, na mesma posição');
  assert.equal(saida.vetores[1], daFonte, 'o vetor da fonte é o MESMO objeto');
  assert.deepEqual(vetores, [[1, 0, 0, 0], daFonte], 'o array do chamador não foi mutado');
  assert.equal(saida.diagnostico.aplicada, true);
  assert.equal(saida.diagnostico.embeds.quantos, 1, 'um embed contextual, medido à parte');
});

test('unidade: consulta idêntica já embedada neste run é REUSADA (sem embed novo e sem duplicata)', async () => {
  const embedder = embedderDeProva();
  const jaFeito = await embedder.embed(`mostra ela ${PISTA}`);
  const saida = await prepararPistaDeRanking({
    texto: 'mostra ela',
    decisao: decisaoDe(PISTA),
    vetores: [[0, 1, 0, 0]],
    embedder,
    jaEmbedadas: [{ texto: `mostra ela ${PISTA}`, vetor: jaFeito }],
  });
  assert.equal(embedder.consultas.length, 0, 'consulta idêntica não é embedada de novo');
  assert.equal(saida.diagnostico.embeds.quantos, 0, 'nenhum embed gasto no reuso');
  assert.equal(saida.diagnostico.aplicada, true);
  assert.equal(saida.vetores.length, 2, 'o vetor reusado foi acrescentado uma vez só');
  assert.deepEqual(saida.vetores[1], Array.from(jaFeito));
});

test('unidade: ponte sem hints entrega o input INTACTO ao manager real; com hints, entrega a pista', async () => {
  const recebidos = [];
  const publicados = [];
  const manager = {
    discover: async (input) => { recebidos.push(input); return { providers: { load: ['nota'] } }; },
    options: { skills: { activation: 'host' } },
  };
  const ctx = { marca: 'CTX' };

  const semPista = criarPonteDoTurno({ manager, can: () => true, aoSelecionarProviders: (i) => publicados.push(i) });
  await semPista.manager.discover({ text: 'mostra ela', ctx });
  assert.equal('hints' in recebidos[0], false, 'sem pista o discover real NÃO recebe o campo `hints` — nem vazio');

  const comPista = criarPonteDoTurno({ manager, can: () => true, aoSelecionarProviders: (i) => publicados.push(i), hints: [PISTA] });
  await comPista.manager.discover({ text: 'mostra ela', ctx });
  assert.deepEqual(recebidos[1].hints, [PISTA], 'as hints chegam ao discover real');
  assert.equal(recebidos[1].text, 'mostra ela', 'o `text` continua o original');

  assert.equal(publicados.length, 2);
  assert.equal(publicados[0].ctx, ctx, 'a seleção é publicada com o ctx do input recebido');
  assert.deepEqual(publicados[0].providers, ['nota']);
});

test('unidade: `unchanged` publica o loadedProviders do estado, sem lista vazia', async () => {
  const publicados = [];
  const manager = { discover: async () => ({ unchanged: true, providers: { load: [] } }) };
  const ponte = criarPonteDoTurno({ manager, can: () => true, aoSelecionarProviders: (i) => publicados.push(i), hints: [PISTA] });
  await ponte.manager.discover({ text: 'x', ctx: { m: 1 }, state: { loadedProviders: ['agenda'] } });
  assert.equal(publicados[0].unchanged, true);
  assert.deepEqual(publicados[0].providers, ['agenda'], 'o que continua carregado é o do próprio prepareTurn');
});

/* ------------------------------------------------------------------ *
 * B) caminho de produto
 * ------------------------------------------------------------------ */

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

/** Embedder vetorial DETERMINÍSTICO e DISCRIMINANTE (mesmo molde de `refino.test.js`:
 * vetor por marcador, não similaridade genérica), com `modelSlug` EXCLUSIVO deste arquivo —
 * corpus e textos são próprios, então nenhum cache falso de outro teste entra.
 * `[1,0,0]` = mundo da nota, `[0,1,0]` = mundo do tempo, `[0,0,1]` = neutro (a consulta
 * curta "mostra ela" cai aqui, e é por isso que ela não pontua nada). */
function embedderDeProduto(consultas = []) {
  return {
    modelSlug: 'pista-contexto-produto-v1',
    async embed(texto, role) {
      if (role === 'query') consultas.push(String(texto));
      const t = String(texto).toLowerCase();
      if (t.includes('nota fiscal') || t.includes('acme')) return [1, 0, 0];
      if (t.includes('tempo') || t.includes('chuva')) return [0, 1, 0];
      return [0, 0, 1];
    },
  };
}

/** Piso vetorial que separa o mundo da nota do neutro: sem embedding que pontue, NENHUM
 *  provider é elegível — é o que torna a prova "a consulta curta perde o candidato"
 *  observável, em vez de depende do empate do top-1. */
const LIMIARES_DO_PRODUTO = { zFull: 99, zCandidate: -99, rawFloor: 0.5 };

const DOC_NOTA = 'nota fiscal de março da ACME, emissor, vencimento, valor e itens da nota';
const DOC_TEMPO = 'previsao do tempo, chuva, temperatura, sol e maxima na capital';

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

function capacidadesDeProva(fonte = null) {
  const lista = [
    { ...capacidade('nota-fiscal'), piso: false, semanticText: DOC_NOTA },
    { ...capacidade('meteorologia'), piso: false, semanticText: DOC_TEMPO },
  ];
  if (fonte) {
    lista.push({ ...capacidade('habilidades'), piso: false, semanticText: 'skill habilidade procedimento reutilizavel', fonte });
  }
  return lista;
}

/** Espião do RANKING: roda DENTRO do `discover` (refinador por anel), registra a consulta
 *  (`text` = o que o kairos vai ranquear, `vectors` = o que ele recebeu) e a proposta, e
 *  devolve `null` — não muda tier nem lista. */
function espiaoDeRanking(registros) {
  const espiar = (anel) => (input) => {
    registros.push({
      anel,
      texto: input?.query?.text,
      vetores: (input?.query?.vectors ?? []).map((v) => [...v]),
      ref: input?.items?.[0]?.ref ?? null,
    });
    return null;
  };
  return { provider: espiar('provider'), tool: espiar('tool'), skill: espiar('skill'), source: espiar('source') };
}

function montarOrquestrador({ consultas = [], registros = [], publicados = [], fonte = null, embedder = embedderDeProduto(consultas), espiar = true, extras = {} } = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesDeProva(fonte),
    embedder,
    refinadores: espiar ? espiaoDeRanking(registros) : undefined,
    limiares: LIMIARES_DO_PRODUTO,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    aoSelecionarProviders: (info) => publicados.push({ ctx: info.ctx, providers: [...info.providers], unchanged: info.unchanged }),
    ...extras,
  });
}

/** Fonte mínima que publica uma skill do MUNDO DA NOTA — a skill só é sugerida quando a
 *  consulta bate com ela, então ela também é alvo de ranking (não um presente).
 *  `enriquecer` (string) faz a fonte pedir o SEGUNDO embed do turno (vetor 2, F7). */
function fonteDeSkill(enriquecer = null) {
  return {
    piso: [],
    async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer }; },
    async skills() {
      return [{
        key: 'planejar-semana',
        descricao: 'Planeja a semana',
        semanticText: `${PISTA} planejar a semana`,
        corpo: async () => '# corpo',
      }];
    },
    aoFechar() {},
  };
}

const PERGUNTA = 'mostra ela';
const tierDe = (discover, ref) => discover.explain.find((e) => e.ref === ref)?.tier;

test('produto: a consulta curta sozinha PERDE a capacidade da nota; com a pista ela VENCE o ranking', async () => {
  const consultas = [];
  const registros = [];
  const orq = montarOrquestrador({ consultas, registros });

  const semPista = await orq.executarTurno({ texto: PERGUNTA, ctx: { m: 'BASE' }, estado: ESTADO_INICIAL });
  assert.equal(
    semPista.discover.providers.candidates.includes('nota-fiscal'),
    false,
    `sem pista a nota não pode ser candidata: ${JSON.stringify(semPista.discover.explain.map((e) => [e.ref, e.tier]))}`,
  );
  assert.equal(tierDe(semPista.discover, 'nota-fiscal'), 'discard', 'sem pista o motor descarta a nota');

  const consultasAntes = consultas.length;
  const comPista = await orq.executarTurno({
    texto: PERGUNTA,
    ctx: { m: 'PISTA' },
    estado: ESTADO_INICIAL,
    pistaDeContexto: decisaoDe(PISTA),
  });

  // RANKING e PROPOSTA, não só `providers.load`: a pista tem de mudar o tier da proposta.
  assert.ok(
    ['full', 'candidate'].includes(tierDe(comPista.discover, 'nota-fiscal')),
    `com pista a nota tem de entrar na proposta: ${JSON.stringify(comPista.discover.explain.map((e) => [e.ref, e.tier]))}`,
  );
  assert.ok(
    comPista.discover.providers.candidates.includes('nota-fiscal')
    || comPista.discover.providers.load.includes('nota-fiscal'),
    'e tem de aparecer na seleção',
  );
  assert.ok(
    !comPista.discover.providers.candidates.includes('meteorologia'),
    `a pista é da nota: o tempo não pode ser arrastado junto (${JSON.stringify(comPista.discover.providers.candidates)})`,
  );
  assert.equal(comPista.pistaDeContexto.aplicada, true);
  assert.equal(comPista.pistaDeContexto.solicitada, true);
  assert.equal(comPista.pistaDeContexto.embeds.quantos, 1, 'um embed contextual, e só um');

  // O texto original é o que o kairos ranqueia, com a pista EM SEGUIDA (a mesma
  // concatenação que o kairos faz com `hints:[pista]`), e nada foi reescrito antes.
  const doProvider = registros.filter((r) => r.anel === 'provider');
  assert.ok(doProvider.length > 0, 'o espião do anel provider viu o discover');
  assert.equal(doProvider.at(-1).texto, `${PERGUNTA} ${PISTA}`, 'consulta = texto original + pista, nessa ordem');
  assert.deepEqual(
    consultas.slice(consultasAntes),
    [PERGUNTA, `${PERGUNTA} ${PISTA}`],
    'neste run a fábrica embeda a bruta e UM contextual — nada mais',
  );
  assert.equal(comPista.discover.query, undefined, 'o texto original não é reescrito no retorno');
  assert.equal(registros.every((r) => !String(r.texto).includes('undefined')), true);

  // Vetores: o que o discover recebeu é [bruta, contextual] — os dois vetores que o
  // embedder produziu, nada mais.
  assert.equal(doProvider.at(-1).vetores.length, 2, 'consulta enriquecida com UM vetor contextual');
  const [, contextual] = doProvider.at(-1).vetores;
  const esperado = await embedderDeProduto([]).embed(`${PERGUNTA} ${PISTA}`);
  assert.deepEqual(doProvider.at(-1).vetores[1], esperado, 'o segundo vetor é exatamente o da consulta contextual');
  assert.ok(contextual.every(Number.isFinite));
});

test('produto: tool e skill também recebem a pista (mesmo corpus, mesmo ranking)', async () => {
  const consultas = [];
  const registros = [];
  const orq = montarOrquestrador({ consultas, registros });
  await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });

  const comPista = registros.map((r) => r.texto);
  assert.ok(comPista.length > 0 && comPista.every((t) => t === `${PERGUNTA} ${PISTA}`), 'anéis tool/skill/provider recebem a MESMA consulta enriquecida');

  // Nuvem de tool: com a pista, alguma tool do provider da nota entra na proposta do anel
  // — e SÓ dela. Os DOIS lados são afirmados: sem o afirmativo, o teste passaria mesmo se
  // a pista deixasse de afetar o anel `tool` (fix round 1, A1).
  const orqSem = montarOrquestrador();
  const base = await orqSem.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const agora = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });

  assert.deepEqual(base.discover.tools.hydrate, [], 'sem pista nenhuma tool é hidratada');
  assert.ok(
    agora.discover.tools.hydrate.includes('nota-fiscal/tool/consultar'),
    `com pista a tool da nota é hidratada: ${JSON.stringify(agora.discover.tools.hydrate)}`,
  );
  assert.ok(
    !agora.discover.tools.hydrate.some((ref) => ref.startsWith('meteorologia/')),
    `a pista é da nota: a tool do tempo não pode ser arrastada junto (${JSON.stringify(agora.discover.tools.hydrate)})`,
  );
});

test('produto: a skill do anel `skill` também é recuperada pela pista', async () => {
  const REF_SKILL = 'habilidades/skill/planejar-semana';
  const semPista = montarOrquestrador({ fonte: fonteDeSkill() });
  const base = await semPista.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(base.discover.skills.suggest.includes(REF_SKILL), false, `sem pista a skill não é sugerida: ${JSON.stringify(base.discover.skills)}`);

  const comPista = montarOrquestrador({ fonte: fonteDeSkill() });
  const agora = await comPista.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });
  assert.ok(agora.discover.skills.suggest.includes(REF_SKILL), `com pista a skill é sugerida: ${JSON.stringify(agora.discover.skills)}`);
});

test('produto: vetores do host são preservados e o embed original continua sendo do host', async () => {
  const consultas = [];
  const registros = [];
  const orq = montarOrquestrador({ consultas, registros });
  const vetorDoHost = [0, 1, 0];

  const saida = await orq.executarTurno({
    texto: PERGUNTA,
    estado: ESTADO_INICIAL,
    vetoresDaPergunta: [vetorDoHost],
    pistaDeContexto: decisaoDe(PISTA),
  });

  assert.equal(saida.embeds.origem, 'entrada', 'a fábrica não reembedou a consulta bruta — o vetor do host vale');
  assert.equal(saida.embeds.quantos, 0, 'o total de embeds da fábrica não absorve o contextual');
  assert.equal(saida.pistaDeContexto.embeds.quantos, 1, 'e o contextual continua medido à parte');
  const vetores = registros.at(-1).vetores;
  assert.equal(vetores.length, 2, 'host + contextual');
  assert.deepEqual(vetores[0], vetorDoHost, 'o vetor do host é o MESMO vetor, na frente');
});

test('produto: sem embedder e com embedder quebrado não sobra hint lexical nem vetor novo', async () => {
  // (a) sem embedder
  const consultas = [];
  const registros = [];
  const orqSem = montarOrquestrador({ embedder: null, consultas, registros });
  const semEmbedder = await orqSem.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });
  assert.equal(semEmbedder.pistaDeContexto.motivo, 'sem-embedder');
  assert.equal(semEmbedder.pistaDeContexto.aplicada, false);
  assert.equal(registros.at(-1).texto, PERGUNTA, 'o discover ranqueia a consulta ORIGINAL — nada de hint lexical parcial');

  // (b) embedder que falha só na consulta contextual
  const registros2 = [];
  const quebrado = {
    modelSlug: 'pista-contexto-produto-quebrado-v1',
    async embed(texto, role) {
      if (role === 'query' && String(texto).includes(PISTA)) throw new Error('embedding contextual caiu');
      return embedderDeProduto().embed(texto, role);
    },
  };
  const orqQuebrado = montarOrquestrador({ embedder: quebrado, registros: registros2 });
  const falhou = await orqQuebrado.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });
  assert.equal(falhou.pistaDeContexto.motivo, 'embedding-contextual-falhou');
  assert.match(falhou.pistaDeContexto.embeds.erro, /contextual caiu/);
  assert.equal(registros2.at(-1).texto, PERGUNTA, 'falhou o contextual, o hint lexical também não entra');
  assert.equal(registros2.at(-1).vetores.length, 1, 'e os vetores anteriores seguem intactos');
  assert.equal(falhou.resultado.type, 'completed', 'o turno não quebra por causa da pista');
});

test('produto: cancelamento não aplica pista depois do sinal', async () => {
  const consultas = [];
  const registros = [];
  const orq = montarOrquestrador({ consultas, registros });
  const controlador = new AbortController();
  controlador.abort();

  const saida = await orq.executarTurno({
    texto: PERGUNTA,
    estado: ESTADO_INICIAL,
    abortSignal: controlador.signal,
    pistaDeContexto: decisaoDe(PISTA),
  });
  assert.equal(saida.pistaDeContexto.motivo, 'cancelado');
  assert.equal(saida.pistaDeContexto.aplicada, false);
  assert.ok(
    consultas.every((t) => t !== `${PERGUNTA} ${PISTA}`),
    'nenhum embed contextual é pago depois do sinal',
  );
});

test('produto: a promoção repete a MESMA pista (sem embed novo) e publica a seleção com o ctx do turno', async () => {
  const REF_SKILL = 'habilidades/skill/planejar-semana';
  const consultas = [];
  const publicados = [];
  const registros = [];
  // Refinador SÓ no anel `provider`, e ainda assim sem `espiar` completo: com o espião no
  // anel `skill` (que devolve `null`), I3a trata a sugestão como ausência de voto e NÃO
  // promove — aqui o que se quer provar é a promoção (e a não repetição do embed nela),
  // não o critério de voto. Registrar o `provider` não interfere nisso, e é o que dá
  // para ver a consulta e os vetores de CADA discover do turno (fix round 1, A2).
  const orq = montarOrquestrador({
    consultas, publicados, fonte: fonteDeSkill(), espiar: false,
    extras: { refinadores: { provider: espiaoDeRanking(registros).provider } },
  });

  const ctx = { m: 'PROMO' };
  const saida = await orq.executarTurno({ texto: PERGUNTA, ctx, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });

  assert.ok(saida.discover.skills.suggest.includes(REF_SKILL), `a skill tinha de ser sugerida: ${JSON.stringify(saida.discover.skills)}`);
  assert.deepEqual(saida.promocoes.skills, ['habilidades'], 'a promoção aconteceu');

  const embedsContextuais = consultas.filter((t) => t === `${PERGUNTA} ${PISTA}`);
  assert.equal(embedsContextuais.length, 1, `promoção não repete o embed contextual: ${JSON.stringify(consultas)}`);
  assert.equal(saida.pistaDeContexto.embeds.quantos, 1);

  // O SEGUNDO discover (o da promoção) tem de receber a consulta enriquecida e os MESMOS
  // vetores do primeiro: `promoverNoTurno` recebe a ponte do TURNO por parâmetro, então é
  // isso — e não a construção do texto — que garante a pista na promoção (fix round 1, A2).
  const anel = registros.filter((r) => r.anel === 'provider');
  // O que se prova aqui é o CONTEÚDO dos discovers (a consulta enriquecida e os mesmos
  // vetores no segundo), não a CONTAGEM: fechar em "exatamente dois" quebra por um número
  // se a fase 3 passar a exercitar o loop do Jev promovendo, sem nada de observável mudar.
  assert.ok(anel.length >= 2, `os discovers do turno têm de passar pelo anel provider: ${JSON.stringify(registros.map((r) => r.anel))}`);
  for (const [i, r] of anel.entries()) {
    assert.equal(r.texto, `${PERGUNTA} ${PISTA}`, `o discover #${i + 1} ranqueia a consulta enriquecida`);
    assert.equal(r.vetores.length, 2, `o discover #${i + 1} recebe os DOIS vetores (bruta + contextual)`);
  }
  assert.deepEqual(anel[1].vetores, anel[0].vetores, 'a promoção recebe os MESMOS vetores — nenhum embed novo');

  assert.equal(publicados.length, 2, `a promoção dispara um segundo discover: ${publicados.length}`);
  // A promoção roda num `prepareTurn` com um ctx DERIVADO do turno (`{ ...ctx, __promocao }` —
  // comportamento antigo de `promoverNoTurno`); o que não pode é a seleção ir para o ctx de
  // outro run. Por isso a comparação é pela marca do turno, não pela identidade do objeto.
  assert.equal(publicados[0].ctx, ctx, 'o primeiro discover leva o ctx EXATO do turno');
  for (const p of publicados) assert.equal(p.ctx.m, 'PROMO', 'as duas publicações são do MESMO turno');
  assert.ok(publicados[1].providers.includes('habilidades'), 'a seleção promovida é publicada');
  assert.equal(publicados[1].unchanged, false);
});

test('produto: a pista é preparada DEPOIS do enriquecimento das fontes — os três vetores vão ao discover', async () => {
  const consultas = [];
  const registros = [];
  // Texto de enriquecimento do MUNDO DO TEMPO de propósito: os três vetores do turno caem
  // em mundos distintos (`[0,0,1]`, `[0,1,0]`, `[1,0,0]`), então a ORDEM dos vetores é
  // observável por valor — um contextual e um enriquecido trocados de lugar não passariam.
  const ENRIQUECIDO = '- ENRIQUECIDO chuva prevista na capital';
  const orq = montarOrquestrador({
    consultas, registros, fonte: fonteDeSkill(ENRIQUECIDO), espiar: false,
    extras: { refinadores: { provider: espiaoDeRanking(registros).provider } },
  });

  const saida = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });

  // A ORDEM que o plano exige: vetor 1 → enriquecimento das fontes → vetor CONTEXTUAL.
  // O lado que faz a prova é `embeds.quantos`: com a pista preparada antes do enriquecimento,
  // o portão `vetores?.length === 1` já não passa, o embed 2 NUNCA acontece, e a perda é
  // silenciosa — `fontes[].enriqueceu` continua `true` e o turno completa (fix round 2, I-1).
  assert.equal(saida.fontes[0].enriqueceu, true, 'a fonte pediu enriquecimento neste turno');
  assert.equal(saida.embeds.quantos, 2, `dois embeds no turno (bruta + enriquecida): ${JSON.stringify(consultas)}`);
  assert.equal(saida.pistaDeContexto.embeds.quantos, 1, 'o contextual é o terceiro, contado à parte');
  assert.deepEqual(
    consultas,
    [PERGUNTA, `${PERGUNTA}\n\n${ENRIQUECIDO}`, `${PERGUNTA} ${PISTA}`],
    'consultas embedadas, em ordem: bruta, enriquecida, contextual',
  );

  // O discover recebeu os TRÊS, nessa ordem de significado — e a consulta que ele ranqueia
  // é a contextual. As duas consultas não se substituem: a enriquecida é a da fonte, a
  // contextual é `${texto} ${pista}`; nenhuma delas reescreve `texto`.
  const registro = registros.at(-1);
  assert.equal(registro.texto, `${PERGUNTA} ${PISTA}`, 'o ranking ranqueia a consulta contextual');
  assert.equal(registro.vetores.length, 3, 'bruta + enriquecida + contextual');
  const embed = (t) => embedderDeProduto([]).embed(t);
  assert.deepEqual(registro.vetores[0], await embed(PERGUNTA), 'vetor 1: a consulta bruta');
  assert.deepEqual(registro.vetores[1], await embed(`${PERGUNTA}\n\n${ENRIQUECIDO}`), 'vetor 2: a consulta ENRIQUECIDA da fonte');
  assert.deepEqual(registro.vetores[2], await embed(`${PERGUNTA} ${PISTA}`), 'vetor 3: o contextual da pista');
});

test('produto: dois turnos concorrentes não trocam as hints', async () => {
  const registros = [];
  const orq = montarOrquestrador({ registros });
  const PISTA_CADERNO = 'Abra o navegador e feche as abas\nOs dois últimos recados foram do mercado';
  const ctxA = { m: 'A' };
  const ctxB = { m: 'B' };

  await Promise.all([
    orq.executarTurno({ texto: 'e esse?', ctx: ctxA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) }),
    orq.executarTurno({ texto: 'e essa?', ctx: ctxB, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA_CADERNO) }),
  ]);

  const textos = registros.map((r) => r.texto);
  assert.ok(textos.includes('e esse? ' + PISTA), `o turno A tem a pista DELE: ${JSON.stringify(textos)}`);
  assert.ok(textos.includes('e essa? ' + PISTA_CADERNO), `o turno B tem a pista DELE: ${JSON.stringify(textos)}`);
  assert.equal(textos.filter((t) => t === 'e esse? ' + PISTA_CADERNO).length, 0, 'nenhuma ponte vazou a pista do outro run');
});

test('produto: `aoMontar` recebe o MESMO diagnóstico do retorno, sem o texto da pista', async () => {
  const montados = [];
  const orq = montarOrquestrador({ extras: { aoMontar: (payload) => montados.push(payload) } });
  const saida = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });

  assert.equal(montados.length, 1, 'o turno monta uma vez');
  // `aoMontar` (payload) e o retorno são construídos em DOIS lugares do `executarTurno`
  // — sem esta asserção, zerar a chave num deles passava a suíte inteiro (fix round 1, A3).
  // O contrato é que os DOIS lados vejam o MESMO diagnóstico, não que compartilhem a
  // referência: por isso `deepEqual` (uma cópia `{ ...pista }` continua complying) e não
  // identidade de objeto, que prenderia um detalhe de implementação (fix round 2, A3).
  assert.ok(montados[0].pistaDeContexto, '`aoMontar` recebe o diagnóstico');
  assert.deepEqual(
    montados[0].pistaDeContexto,
    saida.pistaDeContexto,
    '`aoMontar` e o retorno recebem o MESMO diagnóstico',
  );
  assert.equal(montados[0].pistaDeContexto.aplicada, true);
  assert.equal(montados[0].pistaDeContexto.solicitada, true);
  assert.equal(montados[0].pistaDeContexto.embeds.quantos, 1, 'com o embed contextual medido à parte');

  const serializado = JSON.stringify(montados[0].pistaDeContexto);
  assert.equal(serializado.includes('ACME'), false, `o diagnóstico do aoMontar não pode vazar texto: ${serializado}`);
  assert.equal(serializado.includes('05/03'), false, `o diagnóstico do aoMontar não pode vazar texto: ${serializado}`);
});

test('produto: o diagnóstico não carrega o texto da pista', async () => {
  const orq = montarOrquestrador({});
  const saida = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, pistaDeContexto: decisaoDe(PISTA) });
  const serializado = JSON.stringify(saida.pistaDeContexto);
  assert.equal(serializado.includes('ACME'), false, `o diagnóstico não pode vazar texto: ${serializado}`);
  assert.equal(serializado.includes('05/03'), false, `o diagnóstico não pode vazar texto: ${serializado}`);
  assert.equal(typeof saida.pistaDeContexto.chars, 'number');
});
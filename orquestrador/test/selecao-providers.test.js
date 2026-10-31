import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * C3P (2026-10-03, `docs/superpowers/plans/2026-10-02-bloco-b-decisoes.md` §C3P) — a
 * NOTIFICAÇÃO DE SELEÇÃO: `config.aoSelecionarProviders`.
 *
 * O defeito medido: as contribuições do host leem `ctx.poderesPresentes` para saber se
 * o poder está presente no turno, e a fábrica publicava o CATÁLOGO DISPONÍVEL inteiro
 * antes do discover. Poder disponível e NÃO escolhido entrava no prompt e lia dado.
 * `aoMontar` não serve (a ponte Kairos já renderizou) e `discover.decision` também não:
 * o `explain` dele omite `always`, já carregados, refiner e filtro — não é a seleção.
 *
 * O que este arquivo prova, na costura REAL (`criarOrquestrador` + `createGenosBridge`
 * + `manager.discover` do kairos instalado), sem inferir seleção de `explain`:
 *
 *   1. o callback dispara ANTES do primeiro `read(ctx)` da ponte, com `providers` IGUAL
 *      a `discover.providers.load` — e a seleção inclui um provider `always` que NÃO
 *      aparece no `explain` (prova de que a lista não veio de lá);
 *   2. `unchanged` (texto trivial) publica o `state.loadedProviders` do próprio turno;
 *   3. dois turnos CONCORRENTES não trocam o `ctx` — cada `ctx` recebe a seleção do
 *      discover que recebeu aquele `ctx`;
 *   4. a promoção I3a (skill sugerida → provider dono) também passa pelo callback, e a
 *      seleção promovida é publicada ANTES da releitura do turno;
 *   5. host que não declara o callback não quebra nada (o gancho é opcional).
 *
 * Convenção do pacote: helpers são COPIADOS entre arquivos de teste, nunca importados
 * uns dos outros (`test/skills.test.js`).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

const MARCA_LEITURA = 'PROVA_LEITURA';

/** Bag-of-caracteres determinístico, mesmo molde de `test/semantico.test.js`. */
function embedderFalso() {
  const dim = 8;
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const v = new Array(dim).fill(0);
      for (const ch of String(texto).toLowerCase()) { const i = ch.charCodeAt(0) % dim; v[i] += 1; }
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

const DOC = {
  clima: 'previsao do tempo chuva temperatura sol vai chover amanha na capital',
  caderno: 'anotacao recado lista de compras mercado_Should_not_match caderno pessoal',
};

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

/** `agenda` fica PISO (`piso` default `true`) de propósito: provider `always` NUNCA
 *  aparece no `explain` do discover, então ele separa "seleção" de "explain". */
function capacidadesDeProva(fonte = null) {
  const lista = [
    capacidade('agenda'),
    { ...capacidade('clima'), piso: false, semanticText: DOC.clima },
    { ...capacidade('caderno'), piso: false, semanticText: DOC.caderno },
  ];
  // A fonte do teste da promoção só entra quando pedida — a skill que ela declara é
  // `habilidades/skill/...`, então o provider DONO (quem I3a promove) precisa se chamar
  // `habilidades` (o kairos tira o dono do primeiro segmento da ref).
  if (fonte) {
    lista.push({
      ...capacidade('habilidades'),
      piso: false,
      semanticText: 'skill habilidade procedimento reutilizavel catalogo',
      fonte,
    });
  }
  return lista;
}

/** Contribuição de PISO que REGISTRA a ordem dos eventos: o callback da seleção tem de
 *  acontecer antes do primeiro `read(ctx)`. */
function contribuicaoDeEspiao(eventos) {
  return {
    ref: 'informacoes/prova/leitura',
    kind: 'contexto',
    description: 'Prova de ordem entre a seleção e a leitura.',
    floor: true,
    volatil: true,
    destination: 'system:stable',
    priority: 10,
    read: async (ctx) => {
      eventos.push({ tipo: 'read', marca: ctx?.marca ?? null, selecao: ctx?.poderesPresentes ?? null });
      return `${MARCA_LEITURA}=${ctx?.marca}`;
    },
  };
}

function montarOrquestrador({ eventos, publicados, fonte = null, extras = {} }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesDeProva(fonte),
    contribuicoes: [contribuicaoDeEspiao(eventos)],
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    // C3P: a notificação. `ctx` é o do discover — nunca o de criação. O espelho publica
    // no `ctx` exatamente como a fábrica faz (`fabrica/presenca.js#publicarPoderesPresentes`),
    // para o `read(ctx)` da ponte poder ser observado com a presença já em mãos.
    aoSelecionarProviders: (info) => {
      publicados.push({ ctx: info.ctx, providers: info.providers, unchanged: info.unchanged });
      if (info.ctx) info.ctx.poderesPresentes = [...info.providers];
    },
    ...extras,
  });
}

test('C3P: o callback vem ANTES do primeiro read, com a seleção exata — e a seleção não é o explain', async () => {
  const eventos = [];
  const publicados = [];
  const ctx = { marca: 'A' };
  const orq = montarOrquestrador({ eventos, publicados });

  const { discover, payload } = await orq.executarTurno({
    texto: 'qual a previsão do tempo para amanhã na capital, por favor',
    ctx,
    estado: ESTADO_INICIAL,
  });

  assert.equal(publicados.length, 1, `esperado 1 discover no turno, veio ${publicados.length}`);
  const primeiraSelecao = publicados[0];
  assert.equal(primeiraSelecao.ctx, ctx, 'o callback tem de receber o ctx EXATO daquele prepareTurn');
  assert.equal(primeiraSelecao.unchanged, false, 'texto real não é unchanged');
  assert.deepEqual(
    [...primeiraSelecao.providers].sort(),
    [...discover.providers.load].sort(),
    'a lista publicada é a seleção real (providers.load), na mesma forma',
  );
  assert.ok(
    primeiraSelecao.providers.includes('agenda'),
    'o provider `always` está na seleção (o piso é seleção, não ranking)',
  );
  assert.ok(
    !discover.explain.some((e) => e.ref === 'agenda'),
    'o provider `always` NÃO aparece no explain — se a lista viesse do explain, ele faltaria',
  );

  const indices = eventos.map((e) => e.tipo);
  assert.ok(indices.includes('read'), 'a contribuição de piso foi lida');
  assert.ok(payload.system.includes(`${MARCA_LEITURA}=A`), 'a contribuição entrou no prompt do turno');

  // A prova do ponto: no momento do read, o ctx já carregava a seleção.
  const leitura = eventos.find((e) => e.tipo === 'read');
  assert.ok(leitura, 'nenhuma leitura registrada');
  assert.deepEqual(
    [...(leitura.selecao ?? [])].sort(),
    [...primeiraSelecao.providers].sort(),
    'o read viu a presença que o callback publicou — a publicação é ANTERIOR ao render',
  );
});

test('C3P: unchanged (texto trivial) publica o state.loadedProviders do próprio turno, não lista vazia', async () => {
  const eventos = [];
  const publicados = [];
  const ctx = { marca: 'T' };
  const orq = montarOrquestrador({ eventos, publicados });

  const t1 = await orq.executarTurno({
    texto: 'qual a previsão do tempo para amanhã na capital, por favor',
    ctx: { marca: 'T1' },
    estado: ESTADO_INICIAL,
  });
  const carregadosDepoisDoTurno1 = t1.estado.kairos.loadedProviders;
  assert.ok(carregadosDepoisDoTurno1.length > 0, 'o turno 1 tem de carregar algo, senão o teste não prova nada');

  const antesDaLeitura = publicados.length;
  await orq.executarTurno({ texto: 'x', ctx, estado: t1.estado });

  const doTurnoTrivial = publicados.slice(antesDaLeitura);
  assert.equal(doTurnoTrivial.length, 1, 'o discover roda uma vez mesmo em texto trivial (unchanged)');
  assert.equal(doTurnoTrivial[0].unchanged, true, 'texto trivial devolve unchanged');
  assert.equal(doTurnoTrivial[0].ctx, ctx, 'o ctx do turno trivial é o seu próprio');
  assert.deepEqual(
    [...doTurnoTrivial[0].providers].sort(),
    [...carregadosDepoisDoTurno1].sort(),
    'em unchanged, o que continua presente é o loadedProviders do estado — o reuso do motor',
  );
});

test('C3P: dois turnos concorrentes não trocam o ctx — cada um recebe a seleção do seu discover', async () => {
  const eventos = [];
  const publicados = [];
  const orq = montarOrquestrador({ eventos, publicados });

  const ctxClima = { marca: 'CLIMA' };
  const ctxCaderno = { marca: 'CADERNO' };
  const [clima, caderno] = await Promise.all([
    orq.executarTurno({
      texto: 'qual a previsão do tempo chuva na capital amanhã por favor',
      ctx: ctxClima,
      estado: ESTADO_INICIAL,
    }),
    orq.executarTurno({
      texto: 'minha lista de compras do mercado e os recados do caderno pessoal',
      ctx: ctxCaderno,
      estado: ESTADO_INICIAL,
    }),
  ]);

  const doClima = publicados.filter((p) => p.ctx === ctxClima);
  const doCaderno = publicados.filter((p) => p.ctx === ctxCaderno);
  assert.equal(doClima.length, 1, 'o discover do turno do clima publicó uma vez');
  assert.equal(doCaderno.length, 1, 'o discover do turno do caderno publicou uma vez');
  assert.equal(
    publicados.length, 2,
    'nenhum callback recebeu um ctx de terceiro — os dois turnos são de contextos distintos',
  );

  assert.deepEqual(
    [...doClima[0].providers].sort(),
    [...clima.discover.providers.load].sort(),
    'cada turno recebeu a seleção do SEU discover',
  );
  assert.deepEqual(
    [...doCaderno[0].providers].sort(),
    [...caderno.discover.providers.load].sort(),
    'cada turno recebeu a seleção do SEU discover',
  );

  for (const leitura of eventos.filter((e) => e.tipo === 'read')) {
    assert.ok(
      ['CLIMA', 'CADERNO'].includes(leitura.marca),
      `leitura com marca inesperada: ${leitura.marca}`,
    );
  }
});

test('C3P: a promoção I3a também publica — e publica ANTES da releitura do turno', async () => {
  const REF_SKILL = 'habilidades/skill/planejar-semana';
  const fonteFake = {
    piso: [],
    async selecionar() { return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null }; },
    async skills() {
      return [{
        key: 'planejar-semana',
        descricao: 'Planeja a semana',
        semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana',
        corpo: async () => '# corpo',
      }];
    },
    aoFechar() {},
  };
  const eventos = [];
  const publicados = [];
  const orq = montarOrquestrador({
    eventos,
    publicados,
    fonte: fonteFake,
    extras: { limiares: { zCandidate: -1.01, rawFloor: 0 } },
  });

  const ctx = { marca: 'PROMO' };
  const { discover, promocoes } = await orq.executarTurno({
    texto: 'PERGUNTA_DO_USUARIO_MARCADOR quero planejar a minha semana',
    ctx,
    estado: ESTADO_INICIAL,
  });

  assert.ok(discover.skills.suggest.includes(REF_SKILL), 'a skill precisa mesmo ser sugerida (senão não há promoção)');
  assert.deepEqual(promocoes.skills, ['habilidades'], 'a skill sugerida promove o provider dono');

  assert.equal(publicados.length, 2, `a promoção dispara um segundo discover: ${publicados.length} publicações`);
  const [antesDaPromocao, depoisDaPromocao] = publicados;
  assert.equal(antesDaPromocao.ctx, ctx, 'o primeiro discover recebeu o ctx do turno');
  assert.ok(
    !antesDaPromocao.providers.includes('habilidades'),
    `a promoção ainda não tinha acontecido no primeiro discover: ${JSON.stringify(antesDaPromocao.providers)}`,
  );
  assert.ok(
    depoisDaPromocao.providers.includes('habilidades'),
    `a promoção tem de aparecer na seleção publicada: ${JSON.stringify(depoisDaPromocao.providers)}`,
  );

  // A releitura do turno (o `read` do piso volátil) tem de ver a seleção promovida:
  // é o que evita o modelo ler em cima de um prompt sem a capacidade promovida.
  const leituras = eventos.filter((e) => e.tipo === 'read');
  assert.ok(leituras.length >= 1, 'a contribuição de piso foi relida');
  const ultima = leituras.at(-1);
  assert.ok(
    (ultima.selecao ?? []).includes('habilidades'),
    `a releitura aconteceu com presença sem a promoção: ${JSON.stringify(ultima.selecao)}`,
  );
});

test('C3P: com a pista de contexto (B3.3 T2) a notificação continua idêntica — a ponte virou local ao run', async () => {
  // A fachada que publica a seleção foi MOVIDA do catálogo cacheado para dentro de cada
  // `executarTurno` (a ponte do run, `src/pista-contexto.js#criarPonteDoTurno`), porque as
  // `hints` são do pedido e não do processo. Esta é a prova de que a notificação C3P não
  // se perdeu no caminho: com pista, com TWO turnos concorrentes e com `unchanged`, o
  // callback continua chegando antes do render, com o ctx do discover que o recebeu.
  const eventos = [];
  const publicados = [];
  const orq = montarOrquestrador({ eventos, publicados });
  const decisao = {
    aplicar: true, motivo: 'continuidade', regra: 'acao+pronome',
    pista: 'Mostre a nota fiscal de março\nA nota tem três itens.',
    mensagensUsadas: 2, chars: 0,
  };
  decisao.chars = decisao.pista.length;

  const ctxA = { marca: 'A' };
  const ctxB = { marca: 'B' };
  const [a, b] = await Promise.all([
    orq.executarTurno({ texto: 'mostra ela', ctx: ctxA, estado: ESTADO_INICIAL, pistaDeContexto: decisao }),
    orq.executarTurno({ texto: 'qual a previsão do tempo para amanhã na capital, por favor', ctx: ctxB, estado: ESTADO_INICIAL, pistaDeContexto: decisao }),
  ]);

  assert.equal(a.pistaDeContexto.aplicada, true, 'a pista foi aplicada neste turno');
  assert.equal(b.pistaDeContexto.aplicada, true, 'nos DOIS turnos concorrentes');

  for (const [ctx, saida] of [[ctxA, a], [ctxB, b]]) {
    const publicadas = publicados.filter((p) => p.ctx === ctx);
    assert.equal(publicadas.length, 1, `um discover publicado para o ctx ${ctx.marca}`);
    assert.equal(publicadas[0].unchanged, false);
    assert.deepEqual(
      [...publicadas[0].providers].sort(),
      [...saida.discover.providers.load].sort(),
      'a seleção publicada é a do SEU discover, com pista e tudo',
    );
  }

  // `unchanged` continua pelo caminho de `state.loadedProviders`, agora na ponte do run.
  const antes = publicados.length;
  await orq.executarTurno({ texto: 'x', ctx: ctxA, estado: a.estado });
  const doTrivial = publicados.slice(antes);
  assert.equal(doTrivial.length, 1);
  assert.equal(doTrivial[0].unchanged, true);
  assert.deepEqual([...doTrivial[0].providers].sort(), [...a.estado.kairos.loadedProviders].sort());
});

test('C3P: host sem o callback continua funcionando (gancho opcional)', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidadesDeProva(),
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
  assert.equal(resultado.type, 'completed');
  assert.ok(payload.system.length > 0);
});

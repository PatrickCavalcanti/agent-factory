import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * As travas da fábrica: o que o host PRECISA declarar e que, esquecido,
 * produziu o catálogo mudo do pipeline V2 do Ariadne
 * (`okdev-monorepo/packages/ariadne/docs/pendencias/2026-09-12-…`).
 *
 * Cada teste aqui existe porque a ausência dele deixou um host quebrado em
 * produção — não por simetria de cobertura.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

const embedderFalso = { modelSlug: 'fake-test-v1', embed: async () => [1, 0, 0] };

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
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...overrides,
  });
}

test('capacidade semântica sem semanticText recusa a montagem do catálogo, nomeando a capacidade', async () => {
  const orq = fabrica({
    capacidades: [{ ...capacidade('clima'), piso: false }],
    embedder: embedderFalso,
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'vai chover amanhã?', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /semanticText/, 'a mensagem tem de nomear o campo que falta');
      assert.match(err.message, /clima/, 'a mensagem tem de nomear QUAL capacidade — com dez, "alguma" não ajuda');
      return true;
    },
  );
});

test('semanticText vazio é tratado como ausente — template que não preencheu não passa pela trava', async () => {
  const orq = fabrica({
    capacidades: [{ ...capacidade('clima'), piso: false, semanticText: '' }],
    embedder: embedderFalso,
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'vai chover amanhã?', estado: ESTADO_INICIAL }),
    /semanticText/,
    'string vazia é a forma que um template mal preenchido tem — recusar é o mesmo caso de não declarar',
  );
});

test('capacidade semântica COM semanticText monta e o turno completa', async () => {
  const orq = fabrica({
    capacidades: [{
      ...capacidade('clima'),
      piso: false,
      semanticText: 'previsao do tempo chuva temperatura vai chover amanha na capital',
    }],
    embedder: embedderFalso,
  });

  const { resultado } = await orq.executarTurno({ texto: 'vai chover amanhã?', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
});

test('capacidade de PISO não precisa de semanticText — está fora do ranking por definição', async () => {
  const orq = fabrica({ capacidades: [capacidade('agenda')] });
  const { resultado } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed', 'exigir doc de embedding de quem não é ranqueado seria cerimônia');
});

test('a guarda do embedder continua vindo ANTES da de semanticText', async () => {
  // Ordem significativa: `fabrica.test.js:234` declara piso:false sem embedder
  // E sem semanticText. Se a ordem inverter, aquele teste passa a receber a
  // mensagem errada e quebra por motivo que não é o dele.
  const orq = fabrica({ capacidades: [{ ...capacidade('clima'), piso: false }] });
  await assert.rejects(
    () => orq.executarTurno({ texto: 'x', estado: ESTADO_INICIAL }),
    /nenhum embedder/,
  );
});

test('duas capacidades semânticas sem doc aparecem AS DUAS na mensagem — o caso real é catálogo inteiro mudo', async () => {
  const orq = fabrica({
    capacidades: [
      { ...capacidade('clima'), piso: false },
      { ...capacidade('agenda'), piso: false },
    ],
    embedder: embedderFalso,
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /clima/);
      assert.match(err.message, /agenda/, 'listar só a primeira faria o host consertar uma e bater na próxima');
      return true;
    },
  );
});

test('o catálogo não chega mudo: a legenda do BLOCO tem default no motor', async () => {
  const orq = fabrica({ capacidades: [capacidade('agenda')] });
  const { payload } = await orq.executarTurno({ texto: 'marca uma reunião amanhã', estado: ESTADO_INICIAL });

  // A frase procurada mudou em 2026-09-18 junto com o desenho: a explicação do
  // mecanismo saiu das legendas POR CAPACIDADE (que se repetiam uma vez por
  // capacidade carregada) e passou a viver UMA vez, na legenda do bloco. O que
  // o teste protege é o mesmo de antes — o catálogo não pode chegar mudo —, e
  // agora é ali que a mudez apareceria.
  assert.match(
    payload.system,
    /este bloco é o catálogo deste turno/,
    'sem legenda, o modelo recebe uma árvore de tags sem nenhuma linha dizendo o que aquilo é',
  );
  // Mudança 2 (2026-09-18): a legenda ensina a ESTRUTURA (função carregável
  // precisa ser carregada antes de ser chamada) sem nomear a ferramenta que
  // faz isso — quem nomeia é a camada de protocolo, não a fábrica. Ver o par
  // de asserções logo abaixo, que travam a ausência das meta-tools.
  assert.match(
    payload.system,
    /precisam ser CARREGADAS antes de poderem ser chamadas/,
    'a legenda do bloco tem de ensinar que carregar é um passo prévio — é o mecanismo inteiro',
  );
  // ⚠️ A ausência é cobrada NO BLOCO, não no system inteiro. A seção de
  // PROTOCOLO nomeia as meta-tools de propósito, e precisa nomear: fora de
  // `provider_native` o genos não manda `tools` no payload
  // (`buildAnthropicPayload` devolve só model/max_tokens/system/messages), e o
  // texto do system é o ÚNICO canal que diz ao modelo que existe uma função de
  // carregar. Medir no system inteiro confundiria as duas camadas e proibiria
  // justamente quem tem o dever de falar.
  const bloco = payload.system.match(/<capabilities>[\s\S]*?<capability /)?.[0] ?? '';
  assert.ok(bloco, 'o bloco <capabilities> não foi encontrado no system');
  assert.doesNotMatch(
    bloco,
    /load_capability/,
    'a fábrica não conhece o verbo de carregamento — nomear no BLOCO é falar sobre um mecanismo que não é dela',
  );
  assert.doesNotMatch(
    bloco,
    /call_capability/,
    'idem: quem executa uma função é decisão da camada de protocolo, não da fábrica',
  );
});

test('o host sobrescreve a legenda do motor quando tem verbo próprio', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    legendas: { indice: 'LEGENDA DO HOST' },
  });
  const { payload } = await orq.executarTurno({ texto: 'marca uma reunião amanhã', estado: ESTADO_INICIAL });

  assert.match(payload.system, /LEGENDA DO HOST/);
  assert.doesNotMatch(payload.system, /Funções que existem e que você pode chamar/);
});

test('sobrescrever uma legenda não apaga as outras (mescla, não substituição)', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    legendas: { indice: 'LEGENDA DO HOST' },
  });
  const { payload } = await orq.executarTurno({ texto: 'marca uma reunião amanhã', estado: ESTADO_INICIAL });

  assert.match(payload.system, /LEGENDA DO HOST/);
  // Confere contra a legenda do BLOCO: a de `contratos` passou a ser vazia por
  // default (a explicação vive uma vez, no bloco), então ela não serve mais de
  // testemunha de que a mescla aconteceu.
  assert.match(payload.system, /este bloco é o catálogo deste turno/, 'a legenda do bloco não foi tocada pelo host');
});

test('override vazio cai no default — legenda ausente é o defeito, não uma configuração', async () => {
  // Migrado para a legenda do BLOCO em 2026-09-18. É nela que a garantia tem
  // sentido hoje: `indice`/`contratos` têm default VAZIO de propósito (a
  // explicação deixou de ser repetida por capacidade), então zerá-las não é um
  // defeito. Zerar a do bloco é — volta a ser o "catálogo mudo".
  for (const vazio of ['', undefined, null]) {
    const orq = fabrica({
      capacidades: [capacidade('agenda')],
      legendas: { capacidades: vazio },
    });
    const { payload } = await orq.executarTurno({ texto: 'marca uma reunião amanhã', estado: ESTADO_INICIAL });

    assert.match(
      payload.system,
      /este bloco é o catálogo deste turno/,
      `legendas: { capacidades: ${JSON.stringify(vazio)} } apagou o default e deixou o catálogo mudo`,
    );
  }
});

/** Contribuição de piso mínima, no formato que o kairos espera. */
const contribuicaoDePiso = (extra = {}) => ({
  ref: 'informacoes/estado',
  kind: 'note',
  title: 'Estado',
  description: 'Estado corrente.',
  floor: true,
  destination: 'system:stable',
  priority: 10,
  read: async () => 'ESTADO',
  ...extra,
});

test('contribuição de piso sem `volatil` recusa a montagem, nomeando o ref', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [contribuicaoDePiso()],
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /volatil/);
      assert.match(err.message, /informacoes\/estado/, 'a mensagem tem de nomear QUAL contribuição');
      return true;
    },
  );
});

test('`volatil: false` é declaração válida — o silêncio é que é recusado', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [contribuicaoDePiso({ volatil: false })],
  });
  const { resultado } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
});

test('`floor: false` com `ref` de duas partes recusa a montagem, nomeando o ref', async () => {
  // Sob o contrato ANTERIOR, `floor: false` sozinho já bastava para
  // recusar — era o defeito provado por probe: `floor: false` montava sem
  // recusa, `read()` nunca era chamado, e o conteúdo nunca aparecia no
  // prompt, sem erro nem aviso. Agora `floor: false` é uma declaração
  // VÁLIDA (canal semântico, ver os testes logo abaixo) — o que continua
  // proibido é um `ref` fora da convenção de três partes que o canal
  // `conversation` do kairos exige (`<origem>/<kind>/<chave>`): sem isso o
  // kairos rejeitaria o item em silêncio (só um rastro no explain), e o
  // host acreditaria ter entregue conteúdo que nunca chegou ao prompt.
  // `contribuicaoDePiso()` usa `ref: 'informacoes/estado'` — só UM `/`, duas
  // partes — de propósito, para exercitar esta trava.
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [contribuicaoDePiso({ floor: false })],
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /ref/);
      assert.match(err.message, /informacoes\/estado/, 'a mensagem tem de nomear QUAL contribuição');
      return true;
    },
  );
});

test('`floor: false` com `ref` de três partes NÃO é recusada — vira contribuição semântica, entregue ao `prepareTurn` como item de conversa', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [contribuicaoDePiso({ ref: 'informacoes/nota/estado', floor: false })],
  });

  // Texto não-trivial: 'oi' é filtrado por `isTrivial` no kairos (stopword),
  // e um turno `unchanged` pula a avaliação do canal `conversation` por
  // completo — não provaria nada sobre entrega.
  const { resultado, discover } = await orq.executarTurno({
    texto: 'preciso entender o estado atual do projeto antes de continuar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  // `evaluateConversation` (kairos) grava uma entrada em `explain` para
  // TODO item que passou pelo canal `conversation` — incluído, candidato ou
  // descartado. Uma contribuição de PISO nunca produz entrada com
  // `ring: 'conversation'` (ela nem chega a este canal); achar a entrada
  // aqui prova as duas metades do enunciado: não virou piso, e foi
  // entregue ao `prepareTurn`.
  const entrada = discover.explain.find((e) => e.ring === 'conversation' && e.ref === 'informacoes/nota/estado');
  assert.ok(entrada, 'a contribuição semântica não chegou ao canal `conversation` do kairos — não foi entregue');
});

test('`floor: false` com `volatil` declarado é aceito e ignorado — não é exigido nem quebra o host', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    // `volatil` não é campo de `ConversationItem` nenhum — declará-lo aqui
    // não pode fazer a montagem falhar (a trava de `volatil` só se aplica a
    // `floor: true`, ver `montarCatalogo`).
    contribuicoes: [contribuicaoDePiso({ ref: 'informacoes/nota/estado', floor: false, volatil: true })],
  });

  const { resultado } = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
});

test('`read` que lança num item semântico vira `renderErrors`, e o turno completa', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [contribuicaoDePiso({
      ref: 'informacoes/nota/quebrada',
      floor: false,
      read: async () => { throw new Error('falha ao ler a contribuição semântica'); },
    })],
  });

  const { resultado, renderErrors } = await orq.executarTurno({
    texto: 'preciso entender o estado atual do projeto antes de continuar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed', 'um `read` que lança não pode derrubar o turno');
  assert.ok(
    renderErrors.some((e) => e.ref === 'informacoes/nota/quebrada'),
    'o erro de leitura da contribuição semântica não apareceu em renderErrors',
  );
});

test('contribuição sem a chave `floor` (ausente, não `false`) recusa a montagem — o esquecimento mais provável', async () => {
  const semFloor = contribuicaoDePiso({ volatil: false });
  delete semFloor.floor;

  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [semFloor],
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /floor/);
      assert.match(err.message, /informacoes\/estado/);
      return true;
    },
  );
});

test('a guarda de `floor` vem ANTES da de `volatil`: sem os dois, a mensagem é sobre `floor`', async () => {
  // Ordem significativa: se a guarda de `volatil` viesse primeiro, uma
  // contribuição sem `floor` E sem `volatil` receberia a mensagem sobre
  // recalcular um conteúdo que, de fato, nunca chega a renderizar — a
  // mensagem errada para a causa raiz.
  const semNenhum = contribuicaoDePiso();
  delete semNenhum.floor;

  const orq = fabrica({
    capacidades: [capacidade('agenda')],
    contribuicoes: [semNenhum],
  });

  await assert.rejects(
    () => orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL }),
    (err) => {
      assert.match(err.message, /floor/, 'sem floor E sem volatil, a causa raiz é a ausência de `floor`');
      assert.doesNotMatch(err.message, /`volatil`/, 'a mensagem de volatil seria enganosa: o conteúdo nunca renderizaria de qualquer forma');
      return true;
    },
  );
});

// Não há teste "`volatil: true` não vaza para o kairos" aqui: verificado por
// mutação (remover o `.map` do strip em src/index.js e rodar esta suíte) que
// nenhum teste cai — nada no caminho hoje OBSERVA o campo sobrando numa
// Contribution (o kairos instalado não valida shape de contribuição, ver o
// comentário ao lado do strip em src/index.js). Um teste que passa com e sem
// a proteção alega cobertura que não existe; o strip continua certo (é
// higiene de contrato, campo é da fábrica), só não é testável hoje.

/**
 * Embedder falso e determinístico que VARIA por texto — bag-of-WORDS num
 * espaço maior (64d). Um embedder que devolve vetor constante independente
 * do texto (`[0, 0, 1]`) faz consulta e documento colidirem em similaridade
 * 1.0 SEMPRE, e um hash por CARACTERE em poucas dimensões (`test/semantico
 * .test.js`, 8d) colide demais entre dois textos em português comuns — as
 * letras/espaços mais frequentes dominam o vetor e o score de dois textos
 * SEM nenhuma palavra em comum ainda saía alto (~0.9) só por semelhança
 * estatística de idioma. Hashear por PALAVRA e usar mais dimensões separa de
 * verdade textos sem vocabulário em comum — o caso que este teste precisa.
 */
function embedderPalavras() {
  const dim = 64;
  const hash = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % dim; };
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const v = new Array(dim).fill(0);
      for (const palavra of texto.toLowerCase().split(/[^a-zà-ú0-9]+/).filter(Boolean)) {
        v[hash(palavra)] += 1;
      }
      const norma = Math.hypot(...v) || 1;
      return v.map((x) => x / norma);
    },
  };
}

test('ranking que não oferece candidato nenhum emite evento de diagnóstico', async () => {
  const eventos = [];
  const orq = fabrica({
    capacidades: [
      capacidade('agenda'),
      { ...capacidade('clima'), piso: false, semanticText: 'assunto completamente desconexo xyzzy plugh' },
    ],
    embedder: embedderPalavras(),
    aoEvento: (e) => eventos.push(e),
  });

  await orq.executarTurno({ texto: 'marca uma reunião amanhã de manhã', estado: ESTADO_INICIAL });

  const mudo = eventos.find((e) => e.tipo === 'fabrica:catalogo-mudo');
  assert.ok(mudo, 'o turno em que o ranking não ofereceu nada precisa deixar rastro');
  assert.equal(mudo.candidatos, 0);
  assert.deepEqual(mudo.semanticasNaoCarregadas, ['clima'], 'nomear a capacidade que ficou de fora');
});

test('turno em que só há capacidade de piso NÃO emite o diagnóstico', async () => {
  const eventos = [];
  const orq = fabrica({ capacidades: [capacidade('agenda')], aoEvento: (e) => eventos.push(e) });

  // Texto NÃO trivial de propósito: com 'oi' (< 4 chars) o kairos devolve
  // `unchanged: true` e o bloco inteiro do diagnóstico é pulado por OUTRO
  // motivo (o guard de `unchanged`, não a ausência de capacidade semântica)
  // — o teste passaria mesmo com a condição de `semanticasNaoCarregadas`
  // quebrada. Um texto real de verdade exercita o discover normal e prova
  // que "sem capacidade semântica" é o motivo do silêncio.
  await orq.executarTurno({ texto: 'marca uma reunião para amanhã de manhã', estado: ESTADO_INICIAL });

  assert.equal(
    eventos.find((e) => e.tipo === 'fabrica:catalogo-mudo'),
    undefined,
    'sem capacidade semântica não há ranking — candidato vazio é o correto, não um defeito',
  );
});

test('handler de `aoEvento` que lança no catálogo-mudo não derruba o turno', async () => {
  // Mesma montagem do teste de diagnóstico acima (embedder de palavras +
  // capacidade semântica desconexa) — é o caso que FAZ o evento disparar.
  // Um handler de host que lance aqui não pode derrubar `executarTurno`: o
  // evento é diagnóstico, não trava (mesma garantia que `renderErrors` já
  // dá ao pacote).
  const orq = fabrica({
    capacidades: [
      capacidade('agenda'),
      { ...capacidade('clima'), piso: false, semanticText: 'assunto completamente desconexo xyzzy plugh' },
    ],
    embedder: embedderPalavras(),
    aoEvento: (e) => {
      if (e.tipo === 'fabrica:catalogo-mudo') throw new Error('handler de host quebrado');
    },
  });

  const { resultado } = await orq.executarTurno({ texto: 'marca uma reunião amanhã de manhã', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed', 'o turno tem de completar mesmo com o handler quebrado');
});

test('turno trivial não dispara o diagnóstico mesmo com capacidade semântica não carregada — guard de `unchanged`', async () => {
  // Mesma montagem do teste de diagnóstico acima (capacidade semântica que o
  // ranking deixaria de fora), mas com texto TRIVIAL ('ok', < 4 chars): o
  // discover do kairos é pulado por inteiro (`discoverResult.unchanged ===
  // true`, `providers.candidates` e `providers.load` vêm vazios por
  // definição — não é "ranking que não ofereceu nada", é ranking que NÃO
  // RODOU). O bloco de diagnóstico só pode olhar turnos em que a descoberta
  // de fato rodou (`src/index.js`, guard `if (!prepared.discoverResult.unchanged)`);
  // sem o guard, um turno trivial qualquer com alguma capacidade semântica
  // no catálogo dispararia o evento em todo "ok"/"oi" — ruído em vez de sinal.
  const eventos = [];
  const orq = fabrica({
    capacidades: [
      capacidade('agenda'),
      { ...capacidade('clima'), piso: false, semanticText: 'assunto completamente desconexo xyzzy plugh' },
    ],
    embedder: embedderPalavras(),
    aoEvento: (e) => eventos.push(e),
  });

  await orq.executarTurno({ texto: 'ok', estado: ESTADO_INICIAL });

  assert.equal(
    eventos.find((e) => e.tipo === 'fabrica:catalogo-mudo'),
    undefined,
    'turno trivial não pode emitir o diagnóstico — é o guard de `unchanged` que garante o silêncio aqui',
  );
});

/**
 * Callback do host que lança não pode derrubar o turno — mesma garantia do
 * `fabrica:catalogo-mudo` acima, agora para `aoChamada` (início e fim) e para
 * `aoEvento` num evento CRU do genos (não o sintético `fabrica:catalogo-mudo`,
 * que já tem cobertura própria). Precisa de um turno que chame uma tool de
 * verdade — montagem copiada de `turno-rastro.test.js` (`montarComTool`):
 * dois turnos de provider (chama a tool, depois fecha) via o exemplo
 * canônico que a própria estratégia `envelope` ensina no INVARIANTE.
 */
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

const capacidadeComTool = () => ({
  id: 'agenda',
  descricao: 'Consulta a agenda do usuário.',
  tools: [{
    name: 'listar',
    description: 'Lista eventos de um dia.',
    schema: z.object({ dia: z.string() }),
    handler: async () => ({ eventos: [] }),
  }],
});

function turnoDoExemplo({ tool, args, chat }) {
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

function montarComTool(extra = {}) {
  const comComando = turnoDoExemplo({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' });
  const fecha = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });
  return criarOrquestrador({
    base: () => [],
    capacidades: [capacidadeComTool()],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([comComando, fecha]),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...extra,
  });
}

const ENTRADA_COM_TOOL = {
  texto: 'o que tenho hoje?',
  estado: ESTADO_INICIAL,
};

test('aoChamada que lança na fase de início não derruba o turno', async () => {
  const orq = montarComTool({
    aoChamada: (c) => { if (c.fase === 'inicio') throw new Error('handler de host quebrado no início'); },
  });

  const { resultado } = await orq.executarTurno(ENTRADA_COM_TOOL);
  assert.equal(resultado.type, 'completed', 'o turno tem de completar mesmo com aoChamada quebrado na fase de início');
});

test('aoChamada que lança na fase de fim não derruba o turno', async () => {
  // `resultado.type === 'completed'` sozinho NÃO discrimina aqui: o genos tem
  // sua própria rede de segurança em volta do `emit('tool.completed')` — se
  // ela pegar a exceção primeiro, reinterpreta o bug do LOG como se a TOOL
  // tivesse falhado (emite um `tool.failed` fantasma, com o erro do host no
  // lugar do erro da tool) e o turno completa de qualquer forma, mascarado.
  // Isso é PIOR que derrubar o turno — corrompe `operacoes` em silêncio. A
  // prova real de que a proteção evitou a exceção é `operacoes` ficar limpo:
  // uma entrada só, `ok: true`, sem a órfã que a rede de segurança do genos
  // criaria por trás.
  const orq = montarComTool({
    aoChamada: (c) => { if (c.fase === 'fim') throw new Error('handler de host quebrado no fim'); },
  });

  const { resultado, operacoes } = await orq.executarTurno(ENTRADA_COM_TOOL);
  assert.equal(resultado.type, 'completed', 'o turno tem de completar mesmo com aoChamada quebrado na fase de fim');
  assert.equal(operacoes.length, 1, 'a exceção do host não pode virar uma segunda operação (fantasma) em operacoes');
  assert.equal(operacoes[0].ok, true, 'a tool de verdade teve sucesso — o bug é só do observador');
});

test('aoEvento que lança num evento CRU do genos (não o catalogo-mudo) não derruba o turno', async () => {
  const orq = montarComTool({
    aoEvento: (e) => { if (e?.type === 'tool.started') throw new Error('handler de host quebrado no evento cru'); },
  });

  const { resultado } = await orq.executarTurno(ENTRADA_COM_TOOL);
  assert.equal(resultado.type, 'completed', 'o turno tem de completar mesmo com aoEvento quebrado num evento cru do genos');
});

test('aoTexto que lança não derruba o turno', async () => {
  // A quinta chamada protegida por `avisar` (as outras quatro são aoChamada
  // x2 e aoEvento x2, já cobertas acima) — e a única sem teste próprio antes
  // deste: `montarComTool` fecha o turno com um "Pronto." sem comandos, que o
  // genos entrega via `onMessage` (`orchestrator.js`, ramo não-streaming,
  // `parsed.commands.length === 0`) — o mesmo caminho que exercita `aoTexto`
  // em produção. Sem o `avisar` em volta de `onMessage`, o genos re-lança a
  // exceção do host depois de emitir `provider.failed` (`orchestrator.js`,
  // catch em volta de `callProvider`) e `executarTurno` rejeita — confirmado
  // por mutação (trocar para `onMessage: config.aoTexto` faz este teste
  // falhar).
  const orq = montarComTool({
    aoTexto: () => { throw new Error('handler de host quebrado no texto'); },
  });

  const { resultado } = await orq.executarTurno(ENTRADA_COM_TOOL);
  assert.equal(resultado.type, 'completed', 'o turno tem de completar mesmo com aoTexto quebrado');
});

/**
 * Trava 1, a fronteira entre "esqueceu" e "sabe".
 *
 * Achado migrando o orquestrador de TELA do Ariadne (plano 2026-09-17). A
 * trava recusava TODO catálogo semântico sem embedder, com a justificativa de
 * que "o ranking não tem como rodar" — e isso é falso: `rank-providers.js` do
 * kairos pula o piso absoluto quando `queryEmbedding === null`, de propósito,
 * para preservar o fallback léxico (§6.6).
 *
 * O V1 do orquestrador de tela DEPENDE disso em produção: o modelo de embeddings são ~470MB, um
 * container pode falhar em baixá-los, e o host então passa `embedder: null` (desde o Kairos
 * 0.836 o embedder vem SEMPRE do host; o Kairos não tem modelo) e o chat segue ranqueando pelo léxico. Com a trava
 * velha, essa mesma falha de rede derrubaria a V2 no BOOT.
 */
test('trava 1 recusa quando o embedder está AUSENTE e há capacidade semântica', async () => {
  const o = criarOrquestrador({
    base: () => [{ nome: 'x', conteudo: '<x/>' }],
    capacidades: [capacidade('agenda', { piso: false, semanticText: 'marcar reuniao compromisso agenda horario do dia' })],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
  await assert.rejects(
    () => o.executarTurno({ texto: 'preciso marcar uma reunião amanhã de manhã', estado: ESTADO_INICIAL }),
    /nenhum embedder/,
  );
});

test('trava 1 ACEITA `embedder: null` explícito — é o modo degradado do kairos', async () => {
  const o = criarOrquestrador({
    base: () => [{ nome: 'x', conteudo: '<x/>' }],
    capacidades: [capacidade('agenda', { piso: false, semanticText: 'marcar reuniao compromisso agenda horario do dia' })],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    // O host SABE que não tem embedder e quer ranqueamento léxico.
    embedder: null,
  });
  // O que se afirma é só que MONTA — a qualidade do roteamento degradado é
  // assunto do kairos, não desta trava.
  const r = await o.executarTurno({ texto: 'preciso marcar uma reunião amanhã de manhã', estado: ESTADO_INICIAL });
  assert.ok(r, 'o turno tinha de rodar em modo degradado, e não ser recusado na montagem');
  await o.fechar();
});

/**
 * A explicação do mecanismo entra UMA vez, na legenda do bloco.
 *
 * Antes de 2026-09-18 ela era renderizada DENTRO de cada `<capacidade>`
 * (`legendas.indice` e `legendas.contratos`, em `renderizarCapacidade`): com
 * sete capacidades carregadas, o mesmo parágrafo entrava sete vezes. Além do
 * custo em token, repetição ensina o modelo a pular texto repetido — e o que
 * ele aprende a pular inclui a regra que estava ali.
 */
test('a legenda do mecanismo entra UMA vez, por mais capacidades que carreguem', async () => {
  const orq = fabrica({
    capacidades: [capacidade('agenda'), capacidade('notas'), capacidade('tarefas')],
  });
  const { payload } = await orq.executarTurno({
    texto: 'marca uma reunião amanhã e anota o que ficou pendente',
    estado: ESTADO_INICIAL,
  });

  const vezes = (texto, re) => (texto.match(re) ?? []).length;

  assert.equal(
    vezes(payload.system, /este bloco é o catálogo deste turno/g), 1,
    'a legenda do bloco tem de aparecer exatamente uma vez',
  );
  // Mais de uma `<capability>` no prompt e ainda assim uma legenda só: é isto
  // que separa "legenda do bloco" de "legenda por capacidade".
  assert.ok(
    vezes(payload.system, /<capability name=/g) >= 2,
    'o cenário precisa de pelo menos duas capacidades para o teste significar algo',
  );
  // Mudança 2 (2026-09-18): a legenda não nomeia mais `load_capability` — a
  // frase que prova "entra uma vez só" passou a ser a que descreve o PASSO de
  // carregar, não o nome da meta-tool que o faz.
  assert.equal(
    vezes(payload.system, /precisam ser CARREGADAS antes de poderem ser chamadas/g), 1,
    'a explicação do mecanismo não pode se repetir por capacidade',
  );
});

/**
 * A seção de PROTOCOLO nomeia as meta-tools — e tem de nomear.
 *
 * 🚨 Fora de `provider_native` o genos NÃO manda `tools` no payload: o
 * `buildAnthropicPayload` devolve `{ model, max_tokens, system, messages }` e
 * nada mais (conferido em `genos-orchestrator/dist/providers/anthropic.js`).
 * O texto do system é o único canal, e sem este parágrafo um host em
 * `envelope`/`fence` fica sem saber que existe uma função de carregar manual —
 * o catálogo oferece "carregáveis" e nunca diz com o quê.
 *
 * Em `nativo` a seção é `null` e nada disto entra: lá as três chegam como
 * definição nativa de tool, com nome e schema.
 */
test('o protocolo nomeia as meta-tools — é o único canal fora do nativo', async () => {
  const orq = fabrica({ capacidades: [capacidade('agenda')] });
  const { payload } = await orq.executarTurno({ texto: 'marca uma reunião amanhã', estado: ESTADO_INICIAL });

  assert.match(payload.system, /load_capability\(\{ refs \}\)/, 'o protocolo tem de dizer COMO carregar um manual');
  assert.match(payload.system, /call_capability/, 'o protocolo tem de dizer como EXECUTAR uma função');
  assert.match(payload.system, /search_capabilities/, 'o protocolo tem de oferecer a busca como último recurso');
});

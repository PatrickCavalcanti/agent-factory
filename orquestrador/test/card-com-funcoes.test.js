import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * `cardsComFuncoes` (src/index.js): o card de uma capacidade CANDIDATA (semântica,
 * oferecida mas não carregada) ganha os nomes EXPOSTOS das funções dela — sem isso a
 * legenda de candidatos manda "carregue antes de chamar" e o guarda de `registryDoTurno`
 * recusa toda tool sem manual, mas o card sozinho (`buildCard` do kairos) não diz o nome
 * de nenhuma função para o modelo passar a `load_capability`.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

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

/** Copiada de guarda-manual.test.js: monta um turno chamando `tool` a partir do EXEMPLO
 *  CANÔNICO que a própria estratégia ensina. */
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

/**
 * Embedder CONTROLADO por vetor explícito (não histograma de caracteres — ver o porquê
 * medido em `guarda-manual.test.js`). Três documentos ortogonais o bastante para colocar,
 * ao mesmo tempo: uma capacidade LÍDER (`notas`, cosseno 1.0 com a pergunta — vira `full`
 * pela garantia de top-1), uma capacidade CANDIDATA (`lembretes`, cosseno 0.85 — acima do
 * `rawFloor` 0.8, mas com z-score abaixo de `zFull` — fica em `candidate`) e uma capacidade
 * IRRELEVANTE (`arquivos`, cosseno 0 — some do ranking, mas entra no cálculo do z-score e
 * é o que puxa a média para baixo, dando à `lembretes` folga acima de `zCandidate` sem
 * virar líder). Sem a terceira, com só duas competindo a mais fraca sempre cai abaixo da
 * média (z negativo) e é descartada — não sobra candidata nenhuma para testar o card.
 */
function embedderVetorial() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_NOTAS')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_LEMBRETES')) return [0.85, Math.sqrt(1 - 0.85 * 0.85)];
      if (texto.includes('DOC_SEMANTICO_ARQUIVOS')) return [0, 1];
      return [0, 0];
    },
  };
}

function capacidades() {
  return [
    {
      id: 'notas',
      descricao: 'Gerencia notas pessoais.',
      piso: false,
      semanticText: 'DOC_SEMANTICO_NOTAS — capacidade de notas',
      tools: [{
        name: 'gravar',
        description: 'Grava uma nota.',
        schema: z.object({ texto: z.string() }),
        handler: async () => ({ ok: true }),
      }],
    },
    {
      id: 'lembretes',
      descricao: 'Gerencia lembretes recorrentes.',
      piso: false,
      semanticText: 'DOC_SEMANTICO_LEMBRETES — capacidade de lembretes',
      tools: [
        {
          name: 'criar',
          description: 'Cria um lembrete.',
          schema: z.object({ quando: z.string() }),
          handler: async () => ({ ok: true }),
        },
        {
          name: 'listar',
          description: 'Lista os lembretes ativos.',
          schema: z.object({}),
          handler: async () => ({ lembretes: [] }),
        },
      ],
    },
    {
      id: 'arquivos',
      descricao: 'Gerencia arquivos anexados.',
      piso: false,
      semanticText: 'DOC_SEMANTICO_ARQUIVOS — capacidade de arquivos',
      tools: [{
        name: 'listar',
        description: 'Lista arquivos.',
        schema: z.object({}),
        handler: async () => ({ arquivos: [] }),
      }],
    },
  ];
}

/** Pergunta não-trivial (isTrivial exige >= 4 chars e não-stopword) que carrega o
 *  marcador do embedder controlado — ver o docblock de `embedderVetorial`. */
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR preciso organizar minhas coisas pessoais esta semana';

function montarOrquestrador(textosDoProvider) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto(textosDoProvider),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
}

test('capacidade semântica oferecida como CANDIDATA (não carregada) tem, no prompt do turno, o card com os nomes expostos das funções dela', async () => {
  const orq = montarOrquestrador([FECHA]);

  const { payload, discover } = await orq.executarTurno({
    texto: PERGUNTA,
    estado: ESTADO_INICIAL,
  });

  // Ancora que o ranking fez o que o docblock promete: `lembretes` candidata, `notas`
  // carregada de verdade (líder) — sem isso o teste poderia passar por acidente (ex.:
  // `lembretes` virando `full` também, e o card nunca chegando a existir).
  const candidatos = discover.providers?.candidates ?? [];
  assert.ok(candidatos.some((c) => c.id === 'lembretes'), `esperava "lembretes" como candidata; candidatos=${JSON.stringify(candidatos)}`);
  assert.ok(!(discover.providers?.load ?? []).includes('lembretes'), '"lembretes" não deveria ter carregado');
  assert.ok((discover.providers?.load ?? []).includes('notas'), '"notas" deveria ter carregado (líder da garantia de top-1)');

  // O card é EFÊMERO — mora na mensagem do turno, não no system acumulado (ver o
  // docblock de `cardsComFuncoes`: `secoesEfemeras` resolve a classe `card` para
  // `destino: 'turno'`). A seção é `<suggested_capabilities>` (`nomes.candidatos`
  // em prompt-builder.js, renomeada de `capacidades_sugeridas` em 2026-09-18),
  // com um `<capability name="lembretes">` dentro.
  assert.match(payload.mensagemDoTurno, /<suggested_capabilities>/, 'o bloco de candidatos não apareceu na mensagem do turno');

  // ⚠️ A asserção do system mudou em 2026-09-18, e a razão importa. Antes era
  // `doesNotMatch(system, /<suggested_capabilities>/)` — um ATALHO para "o card
  // não vazou". Deixou de servir quando a legenda do bloco `<capabilities>`
  // passou a CITAR a seção ("Função listada numa capacidade de
  // `<suggested_capabilities>`: carregue o manual pelo nome DA FUNÇÃO" — a
  // Mudança 2, no mesmo dia, tirou o nome da meta-tool da frase, mas a
  // citação da SEÇÃO continua). Citar não é vazar: o texto ensina onde olhar,
  // e o card continua só na mensagem do turno.
  //
  // O que se mede agora é o vazamento de verdade — a seção ABERTA no system
  // (o `tag()` a emite em linha própria) e o CONTEÚDO dela, que são os nomes
  // expostos de uma capacidade que não carregou.
  assert.doesNotMatch(payload.system, /^<suggested_capabilities>$/m, 'a seção de candidatos não pode ABRIR no system acumulado');
  assert.doesNotMatch(payload.system, /lembretes_criar|lembretes__listar/, 'nome de função de capacidade NÃO carregada vazou para o system');

  // Os DOIS nomes expostos das funções de `lembretes` aparecem no card.
  assert.match(payload.mensagemDoTurno, /lembretes__criar/, 'o card não anunciou "lembretes__criar"');
  assert.match(payload.mensagemDoTurno, /lembretes__listar/, 'o card não anunciou "lembretes__listar"');
});

test('o nome que aparece no card é o mesmo que o guarda/load_capability aceitam — chamar load_capability com ele resolve, sem "tool não registrada"', async () => {
  const orq = montarOrquestrador([
    turnoChamando({ tool: 'load_capability', args: { refs: ['lembretes__criar'] }, chat: 'Carregando lembretes.' }),
    FECHA,
  ]);

  const { resultado, operacoes, discover, runId, runStore } = await orq.executarTurno({
    texto: PERGUNTA,
    estado: ESTADO_INICIAL,
  });

  assert.ok(
    (discover.providers?.candidates ?? []).some((c) => c.id === 'lembretes'),
    'pré-condição: "lembretes" tem que estar candidata para o teste valer algo',
  );

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].ok, true, 'load_capability com o nome exposto do card não pode falhar');

  const snapshot = await runStore.load(runId);
  const resultadoDaTool = snapshot.history.find((m) => m.role === 'tool_result');
  assert.ok(resultadoDaTool, 'não achei o tool_result da chamada de load_capability');
  assert.doesNotMatch(resultadoDaTool.content, /tool não registrada/, 'o nome do card tem que resolver no dispatcher do kairos');
  assert.doesNotMatch(resultadoDaTool.content, /manual_nao_carregado/, 'load_capability é meta-tool e nunca cai no guarda de manual');
});

/**
 * UM NOME SÓ: o que o prompt anuncia é o que a busca devolve.
 *
 * O prompt anuncia `<function name="agenda__listar">` (nome exposto) e o
 * `search_capabilities` do kairos devolvia `"ref": "agenda/tool/listar"` — a
 * ref interna. Duas grafias da mesma função no mesmo turno, e o modelo usava a
 * que tinha visto por último: medido em uso real, ele chamou `load_capability`
 * ora com uma, ora com a outra, e repetiu a chamada porque não tinha como
 * saber que eram a mesma coisa.
 *
 * Nada QUEBRAVA — o resolvedor aceita as três formas. Custava voltas, que é o
 * recurso mais caro de um turno agêntico.
 */
test('search_capabilities devolve o NOME EXPOSTO, o mesmo que o prompt anuncia', async () => {
  const orq = montarOrquestrador([
    turnoChamando({ tool: 'search_capabilities', args: { query: 'marcar uma reunião' }, chat: 'Buscando.' }),
    FECHA,
  ]);
  const saida = await orq.executarTurno({ texto: 'preciso marcar uma reunião amanhã', estado: ESTADO_INICIAL });

  // ⚠️ O resultado da busca NÃO está no payload inicial — ele volta como
  // mensagem durante o laço. A fonte é o histórico do genos, que a fábrica
  // expõe justamente para isto (`runId` + `runStore` no retorno).
  const snap = await saida.runStore.load(saida.runId);
  await orq.fechar();
  const retorno = (snap?.history ?? [])
    .filter(m => m.toolName === 'search_capabilities')
    .map(m => m.content)
    .join('\n');
  assert.ok(retorno, 'a busca não chegou a rodar — o cenário não exercita o que o teste mede');

  assert.doesNotMatch(
    retorno,
    /"ref"\s*:\s*"[^"]+\/tool\//,
    'a busca devolveu a ref INTERNA — o modelo passa a ver duas grafias da mesma função',
  );
  assert.match(retorno, /"ref"\s*:\s*"[a-z_]+"/, 'a busca devolveu algo que não é o nome exposto');
});

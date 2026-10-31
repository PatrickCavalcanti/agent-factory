import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * Tarefa B — guarda que recusa tool sem contrato: `registryDoTurno` só deixa
 * o handler REAL rodar quando o nome exposto tem manual no prompt ACUMULADO
 * (`acumulacao.system.capacidades[].funcoes[].manual`). Sem isso, o modelo
 * pode ver o nome no índice (ou simplesmente chamá-lo por conta própria) e
 * chamar sem saber os argumentos — a anatomia do defeito medido no pipeline
 * V2 do Ariadne (`projeto/tool/ler` com `args: {}`).
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

/**
 * Copiada de turno-rastro.test.js: monta um turno chamando `tool` a partir do
 * EXEMPLO CANÔNICO que a própria estratégia ensina, em vez de um fixture à
 * mão — prova que o parser aceita o que o PROMPT ensina, não só o que eu
 * escrevi.
 */
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

/** Doc de embedding sem overlap léxico nenhum com a pergunta usada nos testes
 *  (que fala de "agenda"/"reunião") — garante que `notas` não é elegível no
 *  ranking (`rank-providers.js`: sem vetor nem léxico, vira `discard`). */
const DOC_NOTAS = 'anotacoes pessoais lembretes rascunho ideias soltas bloco de notas';

/**
 * Embedder CONTROLADO — um histograma de caracteres (como em `semantico.
 * test.js`) dá vetores quase colineares para qualquer par de frases em
 * português (letras/espaços dominantes se repetem), e mediu-se aqui que isso
 * bastava para o piso absoluto do ranking (`rawFloor`, default 0.8) deixar
 * `notas` passar mesmo sem nenhuma relação real com a pergunta — o F3
 * (garantia de top-1) então promovia o único candidato semântico a `full`.
 * Para o teste provar "capacidade que NÃO carrega", o vocabulário precisa
 * ser ORTOGONAL de propósito: cada frase cai num dos dois eixos, sem meio-
 * termo, e o que não bate com nenhum vira vetor nulo (abaixo do piso).
 */
function embedderControlado() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const t = texto.toLowerCase();
      if (t.includes('agenda') || t.includes('reuni')) return [1, 0];
      if (t.includes('nota') || t.includes('anota')) return [0, 1];
      return [0, 0];
    },
  };
}

test('tool cuja capacidade NÃO carregou: chamada pelo nome exposto devolve recusa, e o handler original não roda', async () => {
  const chamadasReais = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [
      {
        id: 'agenda',
        descricao: 'Consulta a agenda do usuário.',
        tools: [{
          name: 'listar',
          description: 'Lista eventos.',
          schema: z.object({}),
          handler: async () => ({ eventos: [] }),
        }],
      },
      {
        id: 'notas',
        descricao: 'Gerencia notas pessoais.',
        piso: false,
        semanticText: DOC_NOTAS,
        tools: [{
          name: 'gravar',
          description: 'Grava uma nota.',
          schema: z.object({ texto: z.string() }),
          handler: async (args) => { chamadasReais.push(args); return { ok: true }; },
        }],
      },
    ],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'notas__gravar', args: { texto: 'oi' }, chat: 'Gravando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, operacoes, runId, runStore } = await orq.executarTurno({
    texto: 'preciso organizar minha agenda de reuniões desta semana, pode me ajudar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  // O handler REAL nunca rodou — a prova é o espião vazio.
  assert.equal(chamadasReais.length, 0, 'o handler original não pode ter sido chamado');
  // A chamada não lançou (não virou tool.failed): ela devolveu um resultado
  // normal que o modelo lê, então `ok` continua true do ponto de vista do genos.
  assert.equal(operacoes[0].ok, true);

  // O CONTEÚDO do resultado é a recusa — confirma pelo `tool_result` real que
  // o genos injetou de volta na conversa (o que o modelo efetivamente lê).
  const snapshot = await runStore.load(runId);
  const resultadoDaTool = snapshot.history.find((m) => m.role === 'tool_result');
  assert.ok(resultadoDaTool, 'não achei o tool_result da chamada guardada');
  assert.match(resultadoDaTool.content, /manual_nao_carregado/);
  assert.match(resultadoDaTool.content, /load_capability/);
});

test('tool com manual já no prompt: chama normal e o handler roda', async () => {
  const chamadasReais = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'agenda',
      descricao: 'Consulta a agenda do usuário.',
      tools: [{
        name: 'listar',
        description: 'Lista eventos.',
        schema: z.object({ dia: z.string() }),
        handler: async (args) => { chamadasReais.push(args); return { eventos: [] }; },
      }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'agenda__listar', args: { dia: 'hoje' }, chat: 'Consultando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, operacoes } = await orq.executarTurno({
    texto: 'preciso que voce me ajude a organizar minha agenda de amanha por favor',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].ok, true);
  assert.deepEqual(chamadasReais, [{ dia: 'hoje' }], 'o handler original tinha que ter rodado com os args certos');
});

test('meta-tool (load_capability) não é guardada — chama normal mesmo sem nenhuma capacidade carregada', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'notas',
      descricao: 'Gerencia notas pessoais.',
      piso: false,
      semanticText: DOC_NOTAS,
      tools: [{
        name: 'gravar',
        description: 'Grava uma nota.',
        schema: z.object({ texto: z.string() }),
        handler: async () => ({ ok: true }),
      }],
    }],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'load_capability', args: { refs: ['notas/gravar'] }, chat: 'Carregando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, operacoes, runId, runStore } = await orq.executarTurno({
    texto: 'preciso organizar minha agenda de reuniões desta semana, pode me ajudar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 1);
  assert.equal(operacoes[0].ok, true, 'load_capability não pode ter sido barrada pelo guarda das tools de capacidade');

  // Se `load_capability` tivesse caído no guarda das tools de capacidade (por
  // engano, por exemplo indo parar no segundo laço), o tool_result seria a
  // recusa `manual_nao_carregado` em vez do retorno real da meta-tool.
  const snapshot = await runStore.load(runId);
  const resultadoDaTool = snapshot.history.find((m) => m.role === 'tool_result');
  assert.ok(resultadoDaTool, 'não achei o tool_result da chamada de load_capability');
  assert.doesNotMatch(resultadoDaTool.content, /manual_nao_carregado/);
});

/**
 * N-guarda (correção fluxo de bug, sessão fbab5b12/22-09): `load_capability`
 * seguido, NO MESMO TURNO, da chamada direta da função — a chamada direta tem
 * que EXECUTAR (handler real chamado), não recusar de novo. Antes desta
 * correção, `registryDoTurno` fixava `nomesComManual` uma vez, ANTES de o
 * genos rodar, e nunca reconsultava o que `load_capability` trouxe no meio do
 * turno — o par `load_capability`/chamada direta se repetia (medido: 5
 * chamadas, ~30s, sessão fbab5b12 interação 34734295) até o modelo desistir e
 * usar `call_capability` (a meta-tool, nunca guardada) para conseguir
 * executar.
 */
test('load_capability seguido da chamada direta, no MESMO turno: a segunda chamada executa (handler real roda)', async () => {
  const chamadasReais = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'notas',
      descricao: 'Gerencia notas pessoais.',
      piso: false,
      semanticText: DOC_NOTAS,
      tools: [{
        name: 'gravar',
        description: 'Grava uma nota.',
        schema: z.object({ texto: z.string() }),
        handler: async (args) => { chamadasReais.push(args); return { ok: true }; },
      }],
    }],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'load_capability', args: { refs: ['notas__gravar'] }, chat: 'Carregando.' }),
      turnoChamando({ tool: 'notas__gravar', args: { texto: 'oi' }, chat: 'Gravando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, operacoes, runId, runStore } = await orq.executarTurno({
    texto: 'preciso organizar minha agenda de reuniões desta semana, pode me ajudar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(operacoes.length, 2, 'load_capability + a chamada direta');
  assert.equal(operacoes[1].nome, 'notas__gravar');
  assert.equal(operacoes[1].ok, true);
  assert.deepEqual(chamadasReais, [{ texto: 'oi' }], 'o handler real da segunda chamada tinha que ter rodado');

  const snapshot = await runStore.load(runId);
  const resultadosDeTool = snapshot.history.filter((m) => m.role === 'tool_result');
  const resultadoDaGravacao = resultadosDeTool.find((m) => m.toolName === 'notas__gravar');
  assert.ok(resultadoDaGravacao, 'não achei o tool_result de notas__gravar');
  assert.doesNotMatch(resultadoDaGravacao.content, /manual_nao_carregado/, 'a chamada direta não pode ter caído na recusa depois do load_capability');
});

test('sem load_capability antes: a chamada direta continua recusada (não regressão do caso já coberto)', async () => {
  const chamadasReais = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'notas',
      descricao: 'Gerencia notas pessoais.',
      piso: false,
      semanticText: DOC_NOTAS,
      tools: [{
        name: 'gravar',
        description: 'Grava uma nota.',
        schema: z.object({ texto: z.string() }),
        handler: async (args) => { chamadasReais.push(args); return { ok: true }; },
      }],
    }],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'notas__gravar', args: { texto: 'oi' }, chat: 'Gravando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, operacoes } = await orq.executarTurno({
    texto: 'preciso organizar minha agenda de reuniões desta semana, pode me ajudar',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');
  assert.equal(chamadasReais.length, 0, 'sem load_capability, a recusa continua valendo');
  assert.equal(operacoes.length, 1);
});

test('capacidade com prefixarTools:false: o load_capability ensina o nome CRU (o que o registry tem) e a chamada por ele roda no mesmo turno', async () => {
  // Defeito medido (sessão fd97c8ba, interação 8cfec8d2, 2026-10-10): o kairos devolve o manual com o cabeçalho
  // `## <provider>__<key>` (exposedName dele, sempre prefixado); a fábrica registra os poderes pelo nome cru. O modelo
  // chamou `gestao-documentos__arquivo_salvar_anexo`, tomou "Unknown tool … not registered in this run" e só passou por call_capability.
  const chamadasReais = [];
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'gestao-documentos',
      descricao: 'Gerencia notas pessoais.',
      piso: false,
      prefixarTools: false,
      semanticText: DOC_NOTAS,
      tools: [{
        name: 'arquivo_salvar_anexo',
        description: 'Salva um anexo.',
        schema: z.object({ pasta: z.string() }),
        handler: async (args) => { chamadasReais.push(args); return { ok: true }; },
      }],
    }],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'load_capability', args: { refs: ['arquivo_salvar_anexo'] }, chat: 'Carregando.' }),
      turnoChamando({ tool: 'arquivo_salvar_anexo', args: { pasta: 'Projetos/OKApp' }, chat: 'Salvando.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const { resultado, runId, runStore } = await orq.executarTurno({ texto: 'qual o clima em lisboa hoje', estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  const snapshot = await runStore.load(runId);
  const resultados = snapshot.history.filter((m) => m.role === 'tool_result');
  assert.match(resultados[0].content, /## arquivo_salvar_anexo\b/, 'o manual tem que anunciar o nome que o registry tem');
  assert.doesNotMatch(resultados[0].content, /gestao-documentos__arquivo_salvar_anexo/, 'o nome prefixado do kairos não pode chegar ao modelo');
  assert.deepEqual(chamadasReais, [{ pasta: 'Projetos/OKApp' }], 'a função carregada no turno tinha que rodar pelo nome que o manual ensinou');
});

test('aliasCru: capacidade prefixada aceita o nome cru como sinônimo (mesmo handler, nomeDaChamada = o nome chamado); cru repetido não vira sinônimo', async () => {
  const vistos = [];
  const cap = (id, nomeTool) => ({
    id, descricao: `Capacidade ${id}.`, aliasCru: true,
    tools: [{ name: nomeTool, description: 'Faz.', schema: z.object({}), handler: async (_a, ctx) => { vistos.push([id, ctx?.nomeDaChamada]); return { ok: true }; } }],
  });
  const rodar = async (capacidades, chamadas) => {
    const orq = criarOrquestrador({
      base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
      capacidades, protocolo: 'envelope', protocoloOpts: { headless: true },
      provider: providerDeTexto([...chamadas.map((tool) => turnoChamando({ tool, args: {}, chat: 'Fazendo.' })), FECHA]),
      decorarTool: DECORAR_TOOL_NO_OP,
    });
    const r = await orq.executarTurno({ texto: 'faz isso pra mim agora por favor', estado: ESTADO_INICIAL });
    return r;
  };
  await rodar([cap('tarefas', 'task_listar')], ['tarefas__task_listar', 'task_listar']);
  assert.deepEqual(vistos, [['tarefas', 'tarefas__task_listar'], ['tarefas', 'task_listar']]);

  vistos.length = 0;
  const avisos = []; const warn = console.warn; console.warn = (m) => avisos.push(String(m));
  let r;
  try { r = await rodar([cap('a', 'repetida'), cap('b', 'repetida')], ['repetida', 'b__repetida']); } finally { console.warn = warn; }
  assert.deepEqual(vistos, [['b', 'b__repetida']], 'o cru repetido não resolve; o prefixado sim');
  assert.ok(avisos.some((m) => m.includes('"repetida"') && m.includes('a__repetida') && m.includes('b__repetida')), `aviso de colisão: ${avisos.join(' | ')}`);
  assert.equal(r.operacoes[0].ok, false, 'a chamada pelo cru repetido volta como tool desconhecida');
});

test('load_capability de capacidade sem instruções no prompt entrega as instruções dela junto do manual, uma vez por turno', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'quadro', descricao: 'Quadro visual.', instrucoes: 'INSTRUCOES_DO_QUADRO: uma etapa por chamada.', piso: false, semanticText: DOC_NOTAS,
      tools: [
        { name: 'vb_criar', description: 'Cria.', schema: z.object({}), handler: async () => ({ ok: true }) },
        { name: 'vb_atualizar', description: 'Atualiza.', schema: z.object({}), handler: async () => ({ ok: true }) },
      ],
    }],
    embedder: embedderControlado(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto([
      turnoChamando({ tool: 'load_capability', args: { refs: ['vb_criar'] }, chat: 'Carregando.' }),
      turnoChamando({ tool: 'load_capability', args: { refs: ['vb_atualizar'] }, chat: 'Carregando mais.' }),
      FECHA,
    ]),
    decorarTool: DECORAR_TOOL_NO_OP,
  });
  const { runId, runStore } = await orq.executarTurno({ texto: 'qual o clima em lisboa hoje', estado: ESTADO_INICIAL });
  const resultados = (await runStore.load(runId)).history.filter((m) => m.role === 'tool_result');
  assert.match(resultados[0].content, /## Instruções da capacidade quadro\nINSTRUCOES_DO_QUADRO/);
  assert.doesNotMatch(resultados[1].content, /INSTRUCOES_DO_QUADRO/, 'a segunda carga do mesmo turno não repete as instruções');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Task 4.0 — achado da bancada (`bancada/cenarios/chat-igris.mjs`, embedder e5): com N=2
 * capacidades semânticas no catálogo, o z-score de `rank-providers.js` é sempre ±1 (dois
 * valores distintos ⇒ desvio padrão populacional = metade da diferença ⇒ z = ±1 para os dois,
 * não importa a escala real do cosseno). A perdedora (z=-1) fica abaixo do `zCandidate` default
 * (0.3) e nem vira card — o modelo não recebe o nome das funções dela e não tem como carregá-la.
 *
 * `config.limiares` (novo campo aditivo em `ConfigDoOrquestrador`, `src/index.js`) repassa
 * `thresholds.provider` ao `createManager` do kairos. Estes dois testes provam o efeito nos
 * dois lados do corte, com o MESMO catálogo (N=2, uma vence por larga margem, a outra por pouco).
 *
 * `rawFloor: 0` entra nos dois casos de propósito — CAPACIDADES.md §3 documenta que o piso
 * absoluto (`rawFloor`, default 0.8) filtra ANTES do z-score e não consulta o léxico; sem
 * zerá-lo aqui, uma capacidade perdedora com cosseno abaixo de 0.8 seria descartada pelo PISO,
 * não pelo `zCandidate` — o mesmo resultado observável (`discard`, `candidates: []`) por um
 * motivo diferente do que este teste mede. Zerar o piso isola a variável: o que muda entre os
 * dois testes é só `zCandidate`.
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

/**
 * Embedder CONTROLADO por vetor explícito (mesmo padrão de `card-com-funcoes.test.js` —
 * `semantico.test.js` documenta por que o hash bag-of-words NÃO serve aqui: produz cosseno
 * estruturalmente abaixo de 0.8, e o que este teste mede é o corte de z-score, não o piso).
 * `google-calendar` cosseno 1.0 com a pergunta (vence por larga margem); `tarefas` cosseno 0.5
 * (perde, mas nada aqui depende do valor exato — com N=2 o z-score dos dois é sempre ±1).
 */
function embedderVetorial() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_TAREFAS')) return [0.5, Math.sqrt(1 - 0.5 * 0.5)];
      return [0, 0];
    },
  };
}

function capacidades() {
  return [
    {
      id: 'google-calendar',
      descricao: 'Consulta e gerencia eventos da agenda do Google Calendar.',
      piso: false,
      semanticText: 'DOC_SEMANTICO_CALENDAR — agenda compromissos horarios reunioes amanha',
      tools: [
        {
          name: 'listar',
          description: 'Lista eventos da agenda.',
          schema: z.object({}),
          handler: async () => ({ eventos: [] }),
        },
        // Task 12: função NÃO-`fixa`, com descrição pensada para o LÉXICO casar com
        // `PERGUNTA` — o embedder deste arquivo devolve `[0,0]` para qualquer texto de
        // tool (só tem marcador para os DOIS documentos de PROVIDER), então só o léxico
        // decide a hidratação de função aqui (`hybridScore`: vectorWeight 0.7 * 0 +
        // lexicalWeight 0.3 * lexical). Sem essa descrição casando, `discover.tools.hydrate`
        // já vinha vazio mesmo sem NENHUM override de `tool.hydrate` — o teste abaixo
        // provaria "nada hidrata" por vacuidade (nenhuma função jamais hidrataria neste
        // catálogo), não pelo efeito do corte 1.5. Confirmado por script manual
        // (`E:\tmp`, descartado): sem esta tool, `hydrate` fica `[]` mesmo com o corte
        // DEFAULT (0.15).
        {
          name: 'resumir',
          description: 'Resume o que voce tem na agenda amanha e quais tarefas estao abertas.',
          schema: z.object({}),
          handler: async () => ({ resumo: '' }),
        },
      ],
    },
    {
      id: 'tarefas',
      descricao: 'Gerencia tarefas abertas do usuário.',
      piso: false,
      semanticText: 'DOC_SEMANTICO_TAREFAS — lista de tarefas pendentes afazeres abertas',
      tools: [{
        name: 'listar',
        description: 'Lista tarefas abertas.',
        schema: z.object({}),
        handler: async () => ({ tarefas: [] }),
      }],
    },
  ];
}

/** A pergunta do achado da bancada (turno 1 de `chat-igris.mjs`), com o marcador do embedder
 *  controlado grudado na frente — ver o docblock de `embedderVetorial`. */
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR o que eu tenho na agenda amanha e quais tarefas estao abertas?';

function montarOrquestrador(limiares) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...(limiares ? { limiares } : {}),
  });
}

test('sem override de zCandidate (só rawFloor:0 para isolar a variável), a perdedora do ranking N=2 vira discard e candidates fica vazio — reproduz o achado da bancada', async () => {
  const orq = montarOrquestrador({ rawFloor: 0 });

  const { resultado, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.ok(
    (discover.providers?.load ?? []).includes('google-calendar'),
    'google-calendar (líder, z=+1 >= zFull default 0.8) deveria ter carregado full',
  );
  assert.ok(
    !(discover.providers?.load ?? []).includes('tarefas'),
    'tarefas (perdedora, z=-1) não deveria carregar full',
  );
  assert.deepEqual(
    discover.providers?.candidates ?? [],
    [],
    'com zCandidate default (0.3), z=-1 < 0.3 — a perdedora nem vira card: candidates tem que ficar vazio',
  );
});

test('com limiares.zCandidate = -1, a perdedora do ranking N=2 aparece em discover.providers.candidates e o card entra na mensagem do turno', async () => {
  const orq = montarOrquestrador({ zCandidate: -1, rawFloor: 0 });

  const { resultado, discover, payload } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.ok(
    (discover.providers?.load ?? []).includes('google-calendar'),
    'google-calendar continua carregando full independente do zCandidate',
  );
  const candidatos = discover.providers?.candidates ?? [];
  assert.ok(
    candidatos.some((c) => c.id === 'tarefas'),
    `com zCandidate:-1, z=-1 >= -1 — tarefas tinha que aparecer como candidata; candidatos=${JSON.stringify(candidatos)}`,
  );
  assert.match(
    payload.mensagemDoTurno,
    /<suggested_capabilities>/,
    'o bloco de candidatos (com o card de "tarefas") tem que entrar na mensagem do turno',
  );
});

/**
 * Correção 5 da revisão final do conjunto (2026-09-19): os dois testes acima zeram
 * `rawFloor` para isolar a variável `zCandidate` — o que prova o efeito do corte de
 * z-score, mas não prova nada sobre o PISO real (`rawFloor: 0.8`, o valor de
 * `LIMIARES_CHAT` em `packages/executor/src/orchestration/fabrica/perfil.js`). Este
 * teste usa o `rawFloor` REAL com cossenos realistas (>0.8 para as duas capacidades,
 * como o achado de bancada documentado em `perfil.js` — `google-calendar` 0,8721,
 * `tarefas` 0,8675) — prova que a perdedora não é descartada pelo piso ANTES de
 * chegar no corte de z-score que `zCandidate: -1.01` corrige.
 */
function embedderRealista() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];                              // cosseno 1.0
      if (texto.includes('DOC_SEMANTICO_TAREFAS')) return [0.85, Math.sqrt(1 - 0.85 * 0.85)];    // cosseno 0.85
      return [0, 0];
    },
  };
}

test('com rawFloor real (0.8) e cossenos realistas (>0.8 para as duas), zCandidate:-1.01 evita que a perdedora seja descartada pelo piso ou pelo z-score', async () => {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(),
    embedder: embedderRealista(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0.8 },
  });

  const { resultado, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.ok(
    (discover.providers?.load ?? []).includes('google-calendar'),
    'google-calendar (cosseno 1.0) deveria ter carregado full',
  );
  const candidatos = discover.providers?.candidates ?? [];
  const tarefasPassou = (discover.providers?.load ?? []).includes('tarefas') || candidatos.some((c) => c.id === 'tarefas');
  assert.ok(
    tarefasPassou,
    `tarefas (cosseno 0.85, acima do rawFloor real 0.8) nao pode ser descartada nem pelo piso nem pelo zCandidate -1.01; providers=${JSON.stringify(discover.providers)}`,
  );
});

/**
 * Task 12 (`docs/superpowers/plans/done/2026-09-19-kairos-upstream-e-dois-vetores-na-fabrica.md`) —
 * `limiares.tool` chega ao `createManager` (`thresholds.tool`), honrado pelo kairos desde
 * 0.831 (antes era aceito e ignorado — ver comentário removido de `src/index.js`).
 *
 * PASSO ZERO (prova, não suposição): confirmado por script manual (`E:\tmp`, descartado)
 * que, com o catálogo ORIGINAL deste arquivo (só `listar` em cada capacidade, nenhuma
 * `fixa`), `discover.tools.hydrate` já vinha `[]` mesmo SEM nenhum override de
 * `tool.hydrate` — o embedder deste arquivo devolve `[0,0]` para qualquer doc de TOOL (só
 * tem marcador para os dois documentos de PROVIDER), e a descrição original de `listar`
 * ("Lista eventos da agenda.") não tem overlap léxico suficiente com `PERGUNTA` para passar
 * do corte default (`hybridScore`: vectorWeight 0.7 * 0 + lexicalWeight 0.3 * lexical <
 * 0.15). Um teste que afirmasse "hydrate vazio com `tool.hydrate: 1.5`" nesse catálogo
 * provaria vacuidade, não o efeito do override. Por isso `google-calendar` ganhou a tool
 * `resumir` (não-`fixa`), com descrição escrita para casar bastante léxico com `PERGUNTA` —
 * confirmado pelo mesmo script que, SEM override, ela hidrata sozinha; só com `tool.hydrate:
 * 1.5` (acima de qualquer score possível nesta fixture) ela some do `hydrate`.
 */
// M2 (revisão final do conjunto): controle positivo. Sem este teste, o de baixo (`tool.hydrate:
// 1.5` não hidrata `resumir`) vira vácuo se a descrição de `resumir` mudar e deixar de casar
// léxico o bastante para hidratar SEM override — "não hidratou" deixaria de provar o efeito do
// corte, e passaria a provar só que `resumir` nunca hidrata neste catálogo (mesmo risco do
// PASSO ZERO documentado no docblock do teste de baixo, agora coberto pela rodada sem override).
test('controle positivo: SEM override de tool.hydrate, google-calendar/tool/resumir hidrata (prova que o catálogo não é mudo)', async () => {
  const orq = montarOrquestrador({ zCandidate: -1.01, rawFloor: 0 });

  const { resultado, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.ok(discover.providers.load.includes('google-calendar'));
  assert.ok(
    discover.tools.hydrate.includes('google-calendar/tool/resumir'),
    `sem override, resumir deveria hidratar pelo léxico (corte default 0.15); hydrate=${JSON.stringify(discover.tools.hydrate)}`,
  );
});

test('limiares.tool.hydrate alto impede a hidratação semântica; só as funções `fixa` ficam', async () => {
  const fixas = new Set(
    capacidades().flatMap((c) => (c.tools ?? []).filter((t) => t.fixa).map((t) => `${c.id}/tool/${t.name}`)),
  );
  const orq = montarOrquestrador({ zCandidate: -1.01, rawFloor: 0, tool: { hydrate: 1.5 } });

  const { resultado, discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed');
  assert.ok(discover.providers.load.includes('google-calendar'));
  const naoFixasHidratadas = discover.tools.hydrate.filter((ref) => !fixas.has(ref));
  assert.deepEqual(naoFixasHidratadas, [], `com hydrate 1.5 nada semântico devia hidratar: ${naoFixasHidratadas.join(', ')}`);
  assert.ok(
    !discover.tools.hydrate.includes('google-calendar/tool/resumir'),
    'com hydrate 1.5, resumir NAO deveria hidratar (contraste com o controle positivo acima)',
  );
});

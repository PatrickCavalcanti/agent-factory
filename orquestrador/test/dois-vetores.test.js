import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Task 14 (`docs/superpowers/plans/done/2026-09-19-kairos-upstream-e-dois-vetores-na-fabrica.md`,
 * spec §2 F4) — regressão de ponta a ponta na fábrica dos dois vetores fundidos pelo máximo
 * (kairos 0.831, K2). Divergência declarada com a spec §4 (que cita a bancada): a prova aqui é
 * um teste determinístico com embedder controlado (mesmo padrão de `limiares.test.js`), porque a
 * bancada exige embedder real e não roda na suíte. O cenário de bancada fica como pendência
 * (Task 15).
 *
 * Helpers abaixo copiados de `test/limiares.test.js` sem alteração: ESTADO_KAIROS_VAZIO,
 * ESTADO_INICIAL, DECORAR_TOOL_NO_OP, providerFechado(), embedderVetorial(), capacidades(),
 * PERGUNTA.
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

function montarOrquestrador() {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
  });
}

const CRUA = [1, 0];          // "o que tenho na agenda": cos=1.0 com calendar, 0.5 com tarefas
const ENRIQUECIDA = [0.2, 1]; // a mesma pergunta puxada por memórias de tarefas: cos≈0.196 com calendar, ≈0.947 com tarefas

test('só o vetor enriquecido: calendar perde (z=-1) — a contaminação que a fusão evita', async () => {
  const orq = montarOrquestrador();
  const { discover } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, vetoresDaPergunta: [ENRIQUECIDA] });
  assert.ok(!discover.providers.load.includes('google-calendar'));
  assert.ok(discover.providers.load.includes('tarefas'));
});

test('os dois vetores fundidos pelo máximo: calendar volta a carregar full e a fábrica não embedou nada', async () => {
  const orq = montarOrquestrador();
  const { discover, embeds } = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, vetoresDaPergunta: [CRUA, ENRIQUECIDA] });
  assert.ok(discover.providers.load.includes('google-calendar'), 'max(1.0, 0.196)=1.0 vence max(0.5, 0.947)=0.947');
  assert.ok(!discover.providers.load.includes('tarefas'), 'z=-1: candidata, não full');
  assert.equal(embeds.quantos, 0, 'o host mandou os vetores: nenhum embed da pergunta');
  assert.equal(embeds.origem, 'entrada');
  const cal = discover.explain.find((x) => x.ring === 'provider' && x.ref === 'google-calendar');
  assert.deepEqual(cal.scores.vectors.map((v) => Number(v.toFixed(2))), [1, 0.2]);
});

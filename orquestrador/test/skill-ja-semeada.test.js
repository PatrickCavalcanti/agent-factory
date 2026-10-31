import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Dedup de habilidade já semeada (fix 2026-10-29, sessão 5ca73137): o host (`aoSemear`) devolve
 * `jaCarregada: true` quando a skill já estava na memória de trabalho. Dois efeitos:
 *   - skill ATIVADA pelo refinador (`discover.skills.activate`) já semeada NÃO vira bloco
 *     `#ativada` no turn_context (o corpo já entra no system pela memória);
 *   - skill pedida por `Selecao.semear` já semeada é registrada em `fontes[].semearPulado`, e o id
 *     que o host recusa em `fontes[].semearFalhou`.
 * Fixtures copiados de `refino.test.js` (convenção do pacote: copiar, nunca importar teste).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR o que eu tenho na agenda amanha?';
const CORPO = '# Planejar\nPasso 1 CORPO_DA_SKILL';

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

function embedderVetorial() {
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      if (texto.includes('PERGUNTA_DO_USUARIO_MARCADOR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_CALENDAR')) return [1, 0];
      if (texto.includes('DOC_SEMANTICO_TAREFAS')) return [0, 1];
      return [0, 0];
    },
  };
}

function fonteFake(selecao = {}) {
  return {
    piso: [{
      ref: 'memoria/piso/sempre', kind: 'context', floor: true, volatil: true, destination: 'system:stable',
      priority: 1032, description: 'Memórias sempre presentes', read: async () => '## Memória — sempre\n- **nome:** Patrick',
    }],
    async selecionar() {
      return { incluidos: [], candidatos: [], carregar: [], semear: [], enriquecer: null, ...selecao };
    },
    async skills() {
      return [{ key: 'planejar-semana', descricao: 'Planeja a semana', semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana', corpo: async () => CORPO }];
    },
    aoFechar() {},
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
  ];
}

function montar({ selecao, aoSemear, ativar = true }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(fonteFake(selecao)),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (_nome, definicao) => definicao,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    ...(ativar ? { refinadores: { skill: () => ({ full: ['memoria/skill/planejar-semana'], candidates: [] }) } } : {}),
    aoSemear,
  });
}

test('(a) ativação de habilidade JÁ semeada: sem bloco #ativada, registrada em skillsJaSemeadas', async () => {
  const pedidos = [];
  const orq = montar({
    aoSemear: async (ids) => {
      pedidos.push(ids);
      return { sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO, jaCarregada: true })), falhas: [] };
    },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(t.resultado.type, 'completed');
  assert.doesNotMatch(t.payload.mensagemDoTurno, /Habilidade carregada agora/, 'skill já semeada não pode repetir o corpo no turn_context');
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t.skillsAtivadas, ['memoria/skill/planejar-semana'], 'a ativação continua registrada');
  assert.deepEqual(t.skillsJaSemeadas, ['memoria/skill/planejar-semana']);
  assert.equal(pedidos.length, 1, 'a ativação chama o host uma vez (no-op do lado dele); não há segunda chamada');
});

test('(b) ativação de habilidade NOVA: bloco #ativada como sempre, skillsJaSemeadas vazio', async () => {
  const orq = montar({
    aoSemear: async (ids) => ({ sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO })), falhas: [] }),
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:planejar-semana/);
  assert.match(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t.skillsAtivadas, ['memoria/skill/planejar-semana']);
  assert.deepEqual(t.skillsJaSemeadas, []);
});

test('(c) semear das fontes de habilidade já semeada: no-op registrado em fontes[].semearPulado', async () => {
  const orq = montar({
    ativar: false,
    selecao: { semear: ['ja-esta', 'nova'] },
    aoSemear: async (ids) => ({
      sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO, ...(id === 'ja-esta' ? { jaCarregada: true } : {}) })),
      falhas: [],
    }),
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const memoria = t.fontes.find((f) => f.id === 'memoria');

  assert.deepEqual(memoria.semear, ['ja-esta', 'nova'], 'o que a fonte pediu continua listado');
  assert.deepEqual(memoria.semearPulado, ['ja-esta']);
  assert.equal(memoria.semearFalhou, undefined);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/, 'semear de fonte nunca injeta corpo no turno');
});

test('(c2) semear sem nenhuma já semeada: sem campo semearPulado (artefato não ganha ruído)', async () => {
  const orq = montar({
    ativar: false,
    selecao: { semear: ['nova'] },
    aoSemear: async (ids) => ({ sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO })), falhas: [] }),
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(!('semearPulado' in t.fontes.find((f) => f.id === 'memoria')));
});

test('(d) semear de id que o host não acha: registrado em fontes[].semearFalhou com o código, e em renderErrors', async () => {
  const orq = montar({
    ativar: false,
    selecao: { semear: ['lancar-iteracoes-cidade-empreendedora', 'nova'] },
    aoSemear: async () => ({
      sucessos: [{ id: 'nova', nome: 'skill:nova', corpo: CORPO }],
      falhas: [{ id: 'lancar-iteracoes-cidade-empreendedora', erro: { code: 'skill_not_found', message: "Skill 'lancar-iteracoes-cidade-empreendedora' não encontrada." } }],
    }),
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const memoria = t.fontes.find((f) => f.id === 'memoria');

  assert.deepEqual(memoria.semearFalhou, [{ id: 'lancar-iteracoes-cidade-empreendedora', codigo: 'skill_not_found' }]);
  assert.ok(t.renderErrors.some((e) => e.ref === 'fontes/semear' && e.error.includes('lancar-iteracoes-cidade-empreendedora')));
});

test('(e) skillsComCorpo: só a ref cujo bloco #ativada entrou; semeio falho e já semeada ficam de fora', async () => {
  // nova: bloco entra; falhou: host recusa (memoria_com_edicoes); a ativada única do fake é planejar-semana.
  const nova = montar({
    aoSemear: async (ids) => ({ sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO })), falhas: [] }),
  });
  const tNova = await nova.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(tNova.skillsComCorpo, ['memoria/skill/planejar-semana']);
  assert.match(tNova.payload.mensagemDoTurno, /Habilidade carregada agora/);

  const falho = montar({
    aoSemear: async (ids) => ({
      sucessos: [],
      falhas: ids.map((id) => ({ id, erro: { code: 'memoria_com_edicoes', message: 'tem edições' } })),
    }),
  });
  const tFalho = await falho.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(tFalho.skillsAtivadas, ['memoria/skill/planejar-semana'], 'foi ativada');
  assert.deepEqual(tFalho.skillsComCorpo, [], 'mas o semeio falhou: nenhum bloco entrou');
  assert.deepEqual(tFalho.skillsJaSemeadas, []);
  assert.doesNotMatch(tFalho.payload.mensagemDoTurno, /Habilidade carregada agora/);

  const jaSemeada = montar({
    aoSemear: async (ids) => ({ sucessos: ids.map((id) => ({ id, nome: `skill:${id}`, corpo: CORPO, jaCarregada: true })), falhas: [] }),
  });
  const tJa = await jaSemeada.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(tJa.skillsComCorpo, []);
  assert.deepEqual(tJa.skillsJaSemeadas, ['memoria/skill/planejar-semana']);
});

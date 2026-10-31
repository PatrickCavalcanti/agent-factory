import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Aceite de contribuição, Task 3.1 (spec 2026-10-29 aceite §3.1, §6.2): com `despejo.comportamento` ligado, a memória que a
 * fonte `memoria` inclui no turno entra em `comportamento.oferecidas` (`tipo: 'memoria'`, id = o `ref` do bloco = o `source`
 * do `<info>` que o modelo lê). A que o host já promoveu (`entrada.memoriasPromovidas`) não volta ao turno nem à oferta.
 * Memória não herda (a herança curta é só de habilidade). Desligado: byte a byte o de hoje.
 * Fixtures copiados de `comportamento-habilidade-do-turno.test.js` (convenção do pacote: copiar, nunca importar teste).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR o que eu tenho na agenda amanha?';

const REF_A = 'memoria/memory/preferences.tipo_reuniao';
const REF_B = 'memoria/memory/preferences.horario';
const MEMORIA_A = { ref: REF_A, conteudo: '### Preferências\n- **tipo_reuniao:** MEMORIA_A_MARCADOR', motivo: 'semantica', score: 0.4 };
const MEMORIA_B = { ref: REF_B, conteudo: '### Preferências\n- **horario:** MEMORIA_B_MARCADOR', motivo: 'semantica', score: 0.3 };

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
    async skills() { return []; },
    aoFechar() {},
  };
}

function capacidades(selecao) {
  return [{
    id: 'memoria', descricao: 'Memória do usuário.', piso: true, semanticText: 'memoria lembrancas', fonte: fonteFake(selecao),
    tools: [{ name: 'mem_ver', description: 'Vê uma memória.', schema: z.object({}), fixa: true, handler: async () => ({}) }],
  }];
}

function montar({ comportamento, aoPrepararHabilidade, selecao }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(selecao),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (_nome, definicao) => definicao,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    refinadores: { skill: () => ({ full: [], candidates: [] }) },
    ...(comportamento === undefined ? {} : { despejo: { comportamento } }),
    aoSemear: async () => ({ sucessos: [], falhas: [] }),
    ...(aoPrepararHabilidade ? { aoPrepararHabilidade } : {}),
  });
}

function hostFalso() {
  const host = { preparos: [] };
  host.aoPrepararHabilidade = async (ids) => { host.preparos.push(ids); return { sucessos: [], falhas: [] }; };
  return host;
}

test('3.1 ligado: memória incluída pela fonte entra em oferecidas com tipo memoria e id = ref do bloco', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoPrepararHabilidade: host.aoPrepararHabilidade, selecao: { incluidos: [MEMORIA_A, MEMORIA_B] } });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.match(t.payload.mensagemDoTurno, /MEMORIA_A_MARCADOR/);
  assert.match(t.payload.mensagemDoTurno, /MEMORIA_B_MARCADOR/);
  // O id que o modelo copia é o `source` do `<info>`: o mesmo ref do bloco.
  assert.match(t.payload.mensagemDoTurno, new RegExp(`<info source="${REF_A}">`));
  assert.deepEqual(t.comportamento.oferecidas, [
    { tipo: 'memoria', id: REF_A, ref: REF_A },
    { tipo: 'memoria', id: REF_B, ref: REF_B },
  ]);
  assert.ok(!('memoriasJaPromovidas' in t.comportamento), 'sem promovida, a chave não aparece');
});

test('3.1 ligado: memória já promovida não volta ao turno nem à oferta; a não promovida continua', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoPrepararHabilidade: host.aoPrepararHabilidade, selecao: { incluidos: [MEMORIA_A, MEMORIA_B] } });
  const t = await orq.executarTurno({ texto: PERGUNTA, memoriasPromovidas: [REF_A, 'memoria/memory/preferences.que_a_selecao_nao_trouxe'], estado: ESTADO_INICIAL });

  assert.doesNotMatch(t.payload.mensagemDoTurno, /MEMORIA_A_MARCADOR/, 'promovida: já está no system pela memória de trabalho');
  assert.doesNotMatch(t.payload.mensagemDoTurno, new RegExp(REF_A));
  assert.match(t.payload.mensagemDoTurno, /MEMORIA_B_MARCADOR/, 'não promovida continua podendo ser oferecida');
  assert.deepEqual(t.comportamento.oferecidas, [{ tipo: 'memoria', id: REF_B, ref: REF_B }]);
  assert.deepEqual(t.comportamento.memoriasJaPromovidas, [REF_A], 'só o que a seleção trouxe e saiu; a promovida que ela não trouxe nem aparece');
  // O trace da fonte segue sendo o que ela selecionou.
  assert.deepEqual(t.fontes.find((f) => f.id === 'memoria').incluidos.map((i) => i.ref), [REF_A, REF_B]);
});

test('3.1 ligado: memória não herda — fora de comportamentoAnterior, nunca vai ao host e não volta na continuação curta', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoPrepararHabilidade: host.aoPrepararHabilidade, selecao: { incluidos: [MEMORIA_A] } });
  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(t1.estado.despejo.comportamentoAnterior, [], 'só habilidade entra na herança');
  assert.ok(!JSON.stringify(t1.estado.despejo).includes(REF_A));

  // Turno seguinte, continuação curta, e a seleção NÃO traz a memória: ela não reaparece nem o host é chamado.
  const orqB = montar({ comportamento: true, aoPrepararHabilidade: host.aoPrepararHabilidade, selecao: { incluidos: [] } });
  host.preparos.length = 0;
  const t2 = await orqB.executarTurno({ texto: 'sim', trivial: true, estado: t1.estado });
  assert.deepEqual(host.preparos, [], 'memória não é passada a aoPrepararHabilidade');
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /MEMORIA_A_MARCADOR/);
  assert.deepEqual(t2.comportamento.oferecidas, []);
  assert.deepEqual(t2.comportamento.herdadas, []);
});

test('3.1 desligado: memoriasPromovidas é ignorado e a saída/estado são os de hoje', async () => {
  const semPromovidas = await montar({ selecao: { incluidos: [MEMORIA_A, MEMORIA_B] } })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  for (const comportamento of [undefined, false]) {
    const host = hostFalso();
    const t = await montar({ comportamento, aoPrepararHabilidade: host.aoPrepararHabilidade, selecao: { incluidos: [MEMORIA_A, MEMORIA_B] } })
      .executarTurno({ texto: PERGUNTA, memoriasPromovidas: [REF_A], estado: ESTADO_INICIAL });

    assert.match(t.payload.mensagemDoTurno, /MEMORIA_A_MARCADOR/, 'desligado: a promovida não sai (a chave nem é lida)');
    assert.equal(t.payload.mensagemDoTurno, semPromovidas.payload.mensagemDoTurno);
    assert.deepEqual(t.estado, semPromovidas.estado);
    assert.ok(!('comportamento' in t), 'a saída não ganha a chave');
    assert.deepEqual(host.preparos, []);
  }
});

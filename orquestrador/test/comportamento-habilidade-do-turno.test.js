import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Aceite de contribuição, Task 2.1 (spec 2026-10-29 aceite §3, §7.3): com `despejo.comportamento` ligado, a habilidade
 * que o Jev ativa (`discover.skills.activate`) vale SÓ no turno — o host a PREPARA (`aoPrepararHabilidade`, sem escrever
 * na memória de trabalho), o orquestrador monta o bloco com o id no cabeçalho e a registra em
 * `comportamento.oferecidas`. `requires` e já semeada seguem para o `aoSemear`, como hoje. Desligado: o caminho de sempre.
 * Fixtures copiados de `skill-ja-semeada.test.js` (convenção do pacote: copiar, nunca importar teste).
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const PERGUNTA = 'PERGUNTA_DO_USUARIO_MARCADOR o que eu tenho na agenda amanha?';
const CORPO = '# Planejar\nPasso 1 CORPO_DA_SKILL';
const CORPO_SCRIPT = '# Rodar script\nPasso 1 CORPO_COM_SCRIPT';

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
      return [
        { key: 'planejar-semana', descricao: 'Planeja a semana', semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR planejar a semana', corpo: async () => CORPO },
        { key: 'rodar-script', descricao: 'Roda um script', semanticText: 'PERGUNTA_DO_USUARIO_MARCADOR rodar script', corpo: async () => CORPO_SCRIPT },
      ];
    },
    aoFechar() {},
  };
}

function capacidades(selecao) {
  return [
    {
      id: 'memoria', descricao: 'Memória do usuário.', piso: true, semanticText: 'memoria lembrancas', fonte: fonteFake(selecao),
      tools: [{ name: 'mem_ver', description: 'Vê uma memória.', schema: z.object({}), fixa: true, handler: async () => ({}) }],
    },
    {
      id: 'google-calendar', descricao: 'Agenda.', piso: false, semanticText: 'DOC_SEMANTICO_CALENDAR agenda compromissos',
      tools: [{ name: 'listar', description: 'Lista eventos.', schema: z.object({}), handler: async () => ({ eventos: [] }) }],
    },
  ];
}

const REF_PLANEJAR = 'memoria/skill/planejar-semana';
const REF_SCRIPT = 'memoria/skill/rodar-script';

function montar({ comportamento, aoSemear, aoPrepararHabilidade, ativadas = [REF_PLANEJAR], selecao }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: capacidades(selecao),
    embedder: embedderVetorial(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: (_nome, definicao) => definicao,
    limiares: { zCandidate: -1.01, rawFloor: 0 },
    refinadores: { skill: () => ({ full: ativadas, candidates: [] }) },
    ...(comportamento === undefined ? {} : { despejo: { comportamento } }),
    aoSemear,
    ...(aoPrepararHabilidade ? { aoPrepararHabilidade } : {}),
  });
}

/** Host falso: `memoriaDeTrabalho` só muda se `aoSemear` for chamado (é a escrita que o aceite tira do turno). */
function hostFalso({ requires = [], jaCarregadas = [], falham = [] } = {}) {
  const host = { semeios: [], preparos: [], memoriaDeTrabalho: [] };
  host.aoSemear = async (ids) => {
    host.semeios.push(ids);
    const sucessos = [];
    for (const id of ids) {
      const jaCarregada = jaCarregadas.includes(id) || host.memoriaDeTrabalho.includes(id);
      if (!jaCarregada) host.memoriaDeTrabalho.push(id);
      sucessos.push({ id, nome: `skill:${id}`, corpo: id === 'rodar-script' ? CORPO_SCRIPT : CORPO, ...(jaCarregada ? { jaCarregada: true } : {}) });
    }
    return { sucessos, falhas: [] };
  };
  host.aoPrepararHabilidade = async (ids) => {
    host.preparos.push(ids);
    const sucessos = [];
    const falhas = [];
    for (const id of ids) {
      if (falham.includes(id)) { falhas.push({ id, erro: { code: 'skill_not_found', message: `Skill '${id}' não encontrada.` } }); continue; }
      sucessos.push({
        id, nome: `skill:${id}`, corpo: id === 'rodar-script' ? CORPO_SCRIPT : CORPO,
        requires: requires.includes(id),
        ...(jaCarregadas.includes(id) || host.memoriaDeTrabalho.includes(id) ? { jaCarregada: true } : {}),
      });
    }
    return { sucessos, falhas };
  };
  return host;
}

test('ligado: habilidade nova vale só no turno — bloco com o id no cabeçalho, memória de trabalho intacta, id em oferecidas', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.equal(t.resultado.type, 'completed');
  assert.deepEqual(host.preparos, [['planejar-semana']]);
  // Mutação: se o orquestrador chamasse `aoSemear` de novo, a habilidade entraria na memória de trabalho e este teste cai.
  assert.deepEqual(host.semeios, [], 'ligado: o orquestrador NÃO semeia a habilidade ativada');
  assert.deepEqual(host.memoriaDeTrabalho, [], 'memória de trabalho intacta');

  assert.match(t.payload.mensagemDoTurno, /Habilidade sugerida para este pedido: planejar-semana \(id: planejar-semana\)/);
  assert.match(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /Habilidade carregada agora/, 'não está carregada: o texto não pode dizer isso');

  assert.deepEqual(t.comportamento, { oferecidas: [{ tipo: 'habilidade', id: 'planejar-semana', ref: REF_PLANEJAR, nome: 'planejar-semana', origem: 'jev' }], herdadas: [], herdadasDescartadas: [] });
  assert.deepEqual(t.skillsAtivadas, [REF_PLANEJAR]);
  assert.deepEqual(t.skillsComCorpo, [REF_PLANEJAR]);
  assert.deepEqual(t.skillsJaSemeadas, []);
});

test('ligado: o aviso da habilidade vem entre o cabeçalho e o corpo', async () => {
  const host = hostFalso();
  const preparar = async (ids) => {
    const r = await host.aoPrepararHabilidade(ids);
    return { ...r, sucessos: r.sucessos.map((s) => ({ ...s, aviso: 'AVISO_DE_VERSAO' })) };
  };
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: preparar });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.match(t.payload.mensagemDoTurno, /\(id: planejar-semana\)\n\nAVISO_DE_VERSAO\n\n# Planejar/);
});

test('ligado + requires: semeia como hoje (bloco "carregada agora"), fora de oferecidas', async () => {
  const host = hostFalso({ requires: ['rodar-script'] });
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [REF_SCRIPT],
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.deepEqual(host.semeios, [['rodar-script']], 'habilidade com script semeia direto (spec §7.3)');
  assert.deepEqual(host.memoriaDeTrabalho, ['rodar-script']);
  assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:rodar-script/);
  assert.match(t.payload.mensagemDoTurno, /CORPO_COM_SCRIPT/);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /Habilidade sugerida para este pedido/);
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] }, 'o que já foi semeado não é oferta para declarar');
  assert.deepEqual(t.skillsComCorpo, [REF_SCRIPT]);
});

test('ligado + já semeada: como hoje (dedup) — sem bloco, em skillsJaSemeadas, fora de oferecidas', async () => {
  const host = hostFalso({ jaCarregadas: ['planejar-semana'] });
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.deepEqual(host.semeios, [['planejar-semana']], 'o no-op de sempre (higiene) continua passando pelo aoSemear');
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /Habilidade (sugerida|carregada)/);
  assert.deepEqual(t.skillsJaSemeadas, [REF_PLANEJAR]);
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
});

test('ligado, duas habilidades: a nova vale só no turno, a de script semeia', async () => {
  const host = hostFalso({ requires: ['rodar-script'] });
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [REF_PLANEJAR, REF_SCRIPT],
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.deepEqual(host.preparos, [['planejar-semana', 'rodar-script']]);
  assert.deepEqual(host.semeios, [['rodar-script']]);
  assert.deepEqual(host.memoriaDeTrabalho, ['rodar-script']);
  assert.match(t.payload.mensagemDoTurno, /Habilidade sugerida para este pedido: planejar-semana \(id: planejar-semana\)/);
  assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:rodar-script/);
  assert.deepEqual(t.comportamento.oferecidas.map((o) => o.id), ['planejar-semana']);
});

test('ligado: falha ao preparar vira renderErrors, sem bloco e sem semear', async () => {
  const host = hostFalso({ falham: ['planejar-semana'] });
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.ok(t.renderErrors.some((e) => e.ref === 'fontes/semear' && e.error.includes('planejar-semana')));
  assert.deepEqual(host.semeios, []);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
});

test('ligado: erro lançado pelo host ao preparar não derruba o turno', async () => {
  const host = hostFalso();
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: async () => { throw new Error('host fora do ar'); },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.equal(t.resultado.type, 'completed');
  assert.ok(t.renderErrors.some((e) => e.ref === 'fontes/semear' && e.error.includes('host fora do ar')));
});

test('ligado mas ctx headless: o caminho de sempre (o schema headless não tem o campo, ninguém declararia)', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL, ctx: { headless: true } });
  assert.deepEqual(host.preparos, []);
  assert.deepEqual(host.semeios, [['planejar-semana']]);
  assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:planejar-semana/);
  assert.ok(!('comportamento' in t));
});

test('ligado sem o callback do host: o caminho de sempre', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.semeios, [['planejar-semana']]);
  assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:planejar-semana/);
  assert.ok(!('comportamento' in t));
});

test('desligado: byte a byte o de hoje — mensagem do turno, estado e saída, com ou sem o callback no host', async () => {
  const semCallback = hostFalso();
  const tSem = await montar({ aoSemear: semCallback.aoSemear }).executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  for (const comportamento of [undefined, false]) {
    const host = hostFalso();
    const t = await montar({ comportamento, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
      .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

    assert.deepEqual(host.preparos, [], 'desligado: aoPrepararHabilidade nunca é chamado');
    assert.deepEqual(host.semeios, [['planejar-semana']]);
    assert.deepEqual(host.memoriaDeTrabalho, ['planejar-semana']);
    assert.equal(t.payload.mensagemDoTurno, tSem.payload.mensagemDoTurno);
    assert.match(t.payload.mensagemDoTurno, /Habilidade carregada agora: skill:planejar-semana\n\n# Planejar\nPasso 1 CORPO_DA_SKILL/);
    assert.deepEqual(t.estado, tSem.estado);
    assert.ok(!('comportamento' in t), 'a saída não ganha a chave');
    assert.deepEqual(t.skillsComCorpo, tSem.skillsComCorpo);
    assert.deepEqual(t.skillsJaSemeadas, tSem.skillsJaSemeadas);
  }
});

// ---- Task 2.2: `carrega: skill/<id>` de memória (`Selecao.semear` da fonte) vale só no turno ----

test('2.2 ligado: semear da fonte prepara em vez de semear — bloco com o id, memória intacta, id em oferecidas', async () => {
  const host = hostFalso();
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });

  assert.deepEqual(host.preparos, [['planejar-semana']]);
  assert.deepEqual(host.semeios, [], 'ligado: o semear das fontes não chama aoSemear para habilidade nova');
  assert.deepEqual(host.memoriaDeTrabalho, []);
  assert.match(t.payload.mensagemDoTurno, /Habilidade sugerida para este pedido: planejar-semana \(id: planejar-semana\)/);
  assert.match(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t.comportamento, { oferecidas: [{ tipo: 'habilidade', id: 'planejar-semana', ref: REF_PLANEJAR, nome: 'planejar-semana', origem: 'memoria' }], herdadas: [], herdadasDescartadas: [] });
  assert.deepEqual(t.fontes.find((f) => f.id === 'memoria').semear, ['planejar-semana'], 'o que a fonte pediu continua listado');
});

test('2.2 ligado + requires: semeia como hoje, sem bloco e fora de oferecidas', async () => {
  const host = hostFalso({ requires: ['rodar-script'] });
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [], selecao: { semear: ['rodar-script'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.semeios, [['rodar-script']]);
  assert.deepEqual(host.memoriaDeTrabalho, ['rodar-script']);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_COM_SCRIPT/, 'semear de fonte nunca injeta corpo no turno, como hoje');
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
});

test('2.2 ligado + já semeada: no-op registrado em semearPulado, sem bloco', async () => {
  const host = hostFalso({ jaCarregadas: ['planejar-semana'] });
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.semeios, [['planejar-semana']]);
  assert.deepEqual(t.fontes.find((f) => f.id === 'memoria').semearPulado, ['planejar-semana']);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
});

test('2.2 ligado: id que o host não acha vira semearFalhou e renderErrors, sem bloco', async () => {
  const host = hostFalso({ falham: ['planejar-semana'] });
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(t.fontes.find((f) => f.id === 'memoria').semearFalhou, [{ id: 'planejar-semana', codigo: 'skill_not_found' }]);
  assert.ok(t.renderErrors.some((e) => e.ref === 'fontes/semear' && e.error.includes('planejar-semana')));
  assert.deepEqual(t.comportamento, { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
});

test('2.2 ligado: o mesmo id pedido pela fonte e pelo Jev prepara uma vez só e gera um bloco só', async () => {
  const host = hostFalso();
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [REF_PLANEJAR], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.preparos, [['planejar-semana']], 'o Jev não prepara de novo o id que a fonte já pediu');
  assert.deepEqual(host.semeios, []);
  assert.equal((t.payload.mensagemDoTurno.match(/CORPO_DA_SKILL/g) ?? []).length, 1);
  assert.deepEqual(t.comportamento.oferecidas.map((o) => o.id), ['planejar-semana']);
  assert.equal(t.comportamento.oferecidas[0].ref, REF_PLANEJAR);
});

test('2.2 fonte e Jev com ids diferentes: dois blocos, duas ofertas', async () => {
  const host = hostFalso();
  const orq = montar({
    comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [REF_SCRIPT], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.preparos, [['planejar-semana'], ['rodar-script']]);
  assert.deepEqual(host.semeios, []);
  assert.match(t.payload.mensagemDoTurno, /\(id: planejar-semana\)/);
  assert.match(t.payload.mensagemDoTurno, /\(id: rodar-script\)/);
  assert.deepEqual(t.comportamento.oferecidas.map((o) => o.id).sort(), ['planejar-semana', 'rodar-script']);
});

test('2.2 desligado: o semear das fontes chama aoSemear como hoje, sem preparar e sem bloco', async () => {
  const host = hostFalso();
  const orq = montar({
    aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [], selecao: { semear: ['planejar-semana'] },
  });
  const t = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(host.preparos, []);
  assert.deepEqual(host.semeios, [['planejar-semana']]);
  assert.deepEqual(host.memoriaDeTrabalho, ['planejar-semana']);
  assert.doesNotMatch(t.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.ok(!('comportamento' in t));
});

// ---- Task 2.3: herança curta (spec §3.3) ----

test('2.3 herança: oferecida e não declarada volta UMA vez na continuação curta; some no turno seguinte', async () => {
  const host = hostFalso();
  const orqA = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t1 = await orqA.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.deepEqual(t1.estado.despejo.comportamentoAnterior, [{ id: 'planejar-semana', ref: REF_PLANEJAR }], 'o estado guarda só id e ref, não o corpo');
  assert.ok(!JSON.stringify(t1.estado.despejo).includes('CORPO_DA_SKILL'));

  const orqB = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] });
  host.preparos.length = 0;
  const t2 = await orqB.executarTurno({ texto: 'sim', trivial: true, estado: t1.estado });
  assert.deepEqual(host.preparos, [['planejar-semana']], 'o host prepara de novo (corpo fresco do disco)');
  assert.match(t2.payload.mensagemDoTurno, /(id: planejar-semana)/);
  assert.match(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t2.comportamento.herdadas, ['planejar-semana']);
  assert.deepEqual(t2.comportamento.oferecidas, [{ tipo: 'habilidade', id: 'planejar-semana', ref: REF_PLANEJAR, herdada: true, nome: 'planejar-semana', origem: 'herdada' }], 'herdada também pode ser declarada');
  assert.deepEqual(host.semeios, []);
  assert.deepEqual(t2.estado.despejo.comportamentoAnterior, [], 'a herdada não se herda de novo (vale uma vez)');

  host.preparos.length = 0;
  const t3 = await orqB.executarTurno({ texto: 'ok', trivial: true, estado: t2.estado });
  assert.deepEqual(host.preparos, []);
  assert.doesNotMatch(t3.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t3.comportamento.oferecidas, []);
});

test('2.3 herança: continuação por veto de continuidade do host (trivial=false com motivoTrivial) também vale', async () => {
  const host = hostFalso();
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const orqB = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] });
  const t2 = await orqB.executarTurno({ texto: 'pode mandar', trivial: false, motivoTrivial: 'continuidade', estado: t1.estado });
  assert.deepEqual(t2.comportamento.herdadas, ['planejar-semana']);
});

test('2.3 herança: fora de continuação curta a oferta anterior não volta', async () => {
  const host = hostFalso();
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const orqB = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] });
  host.preparos.length = 0;
  const t2 = await orqB.executarTurno({ texto: 'outro assunto bem diferente e longo o bastante para não ser trivial', trivial: false, estado: t1.estado });
  assert.deepEqual(host.preparos, []);
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL/);
  assert.deepEqual(t2.comportamento.herdadas, []);
  assert.deepEqual(t2.estado.despejo.comportamentoAnterior, []);
});

test('2.3 herança: habilidade que o host já semeou (declarada) não é herdada — a dedup jaCarregada decide', async () => {
  const host = hostFalso();
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  host.memoriaDeTrabalho.push('planejar-semana'); // o fecho do turno a semeou: o modelo declarou
  const orqB = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] });
  const t2 = await orqB.executarTurno({ texto: 'sim', trivial: true, estado: t1.estado });
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL/, 'já está no system pela memória de trabalho: não repete no turno');
  assert.deepEqual(t2.comportamento.herdadas, []);
  assert.deepEqual(t2.comportamento.herdadasDescartadas, [{ id: 'planejar-semana', motivo: 'ja-na-memoria' }]);
  assert.deepEqual(t2.renderErrors, [], 'descartar herança não é erro do turno');
});

test('2.3 herança: o Jev reativando o mesmo id no turno seguinte vale como oferta fresca, sem duplicar', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const t2 = await orq.executarTurno({ texto: PERGUNTA, trivial: false, motivoTrivial: 'continuidade', estado: t1.estado });
  assert.equal((t2.payload.mensagemDoTurno.match(/CORPO_DA_SKILL/g) ?? []).length, 1);
  assert.deepEqual(t2.comportamento.herdadas, []);
  assert.deepEqual(t2.comportamento.oferecidas.map((o) => o.herdada ?? false), [false]);
});

test('2.3 desligado: o estado não ganha comportamentoAnterior', async () => {
  const host = hostFalso();
  const t1 = await montar({ aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(!('despejo' in t1.estado));
});

// ---- Correção 1 da Fase 2: declarada e NÃO fixada no fecho -> volta uma vez, com nota ----

const FALHA_NO_FECHO = [{ id: 'planejar-semana', ref: REF_PLANEJAR, motivo: 'memória de trabalho cheia' }];
const comFalhaNoFecho = (estado, falhas = FALHA_NO_FECHO) => ({ ...estado, despejo: { ...estado.despejo, comportamentoFalhasNoFecho: falhas } });

test('2.4 não fixada no fecho: volta como bloco MESMO sem continuação curta, com <nao_fixadas>, e não se encadeia', async () => {
  const host = hostFalso();
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  assert.ok(!('comportamentoFalhasNoFecho' in t1.estado.despejo), 'sem falha no fecho, o estado não ganha a chave');

  const orqB = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] });
  host.preparos.length = 0;
  // Pedido longo e não trivial: a herança curta NÃO pegaria; a reoferta da falha pega.
  const t2 = await orqB.executarTurno({
    texto: 'outro assunto bem diferente e longo o bastante para não ser trivial', trivial: false,
    estado: comFalhaNoFecho(t1.estado),
  });
  assert.deepEqual(host.preparos, [['planejar-semana']]);
  assert.match(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL/, 'a habilidade volta como bloco do turno');
  assert.match(t2.payload.mensagemDoTurno, /<nao_fixadas>\nplanejar-semana —.*\(memória de trabalho cheia\)\. Ela vale neste pedido. Declarar de novo tenta fixar outra vez; enquanto o motivo continuar .*pode falhar de novo.\n<\/nao_fixadas>/);
  assert.ok(t2.payload.mensagemDoTurno.indexOf('<nao_fixadas>') < t2.payload.mensagemDoTurno.indexOf('outro assunto bem diferente'), 'a nota vem antes do pedido');
  assert.deepEqual(t2.comportamento.naoFixadasReofertadas, [{ id: 'planejar-semana', motivo: 'memória de trabalho cheia' }]);
  assert.deepEqual(t2.comportamento.oferecidas, [{ tipo: 'habilidade', id: 'planejar-semana', ref: REF_PLANEJAR, herdada: true, nome: 'planejar-semana', origem: 'reofertada' }], 'pode ser declarada de novo');
  assert.ok(!('comportamentoFalhasNoFecho' in t2.estado.despejo), 'consumida: o estado novo não a carrega');
  assert.deepEqual(t2.estado.despejo.comportamentoAnterior, [], 'não se encadeia pela herança curta também');
  assert.deepEqual(host.semeios, []);

  host.preparos.length = 0;
  const t3 = await orqB.executarTurno({ texto: 'ok', trivial: true, estado: t2.estado });
  assert.deepEqual(host.preparos, []);
  assert.doesNotMatch(t3.payload.mensagemDoTurno, /CORPO_DA_SKILL|<nao_fixadas>/);
  assert.ok(!('naoFixadasReofertadas' in t3.comportamento));
});

test('2.4 não fixada no fecho: o Jev reofertou o mesmo id no turno — o bloco sai uma vez só e a nota vem mesmo assim', async () => {
  const host = hostFalso();
  const orq = montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade });
  const t1 = await orq.executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const t2 = await orq.executarTurno({ texto: PERGUNTA, trivial: false, estado: comFalhaNoFecho(t1.estado) });
  assert.equal((t2.payload.mensagemDoTurno.match(/CORPO_DA_SKILL/g) ?? []).length, 1);
  assert.match(t2.payload.mensagemDoTurno, /<nao_fixadas>\nplanejar-semana — você declarou/);
  assert.deepEqual(t2.comportamento.oferecidas.map((o) => o.herdada ?? false), [false], 'oferta fresca do Jev');
  assert.deepEqual(t2.comportamento.naoFixadasReofertadas.map((n) => n.id), ['planejar-semana']);
});

test('2.4 não fixada no fecho: já na memória de trabalho no turno seguinte -> sem bloco e sem nota', async () => {
  const host = hostFalso({ jaCarregadas: ['planejar-semana'] });
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] })
    .executarTurno({ texto: 'oi', estado: ESTADO_INICIAL });
  const t2 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] })
    .executarTurno({ texto: 'outro assunto bem diferente e longo o bastante para não ser trivial', trivial: false, estado: comFalhaNoFecho(t1.estado) });
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL|<nao_fixadas>/);
  assert.deepEqual(t2.comportamento.herdadasDescartadas, [{ id: 'planejar-semana', motivo: 'ja-na-memoria' }]);
  assert.ok(!('naoFixadasReofertadas' in t2.comportamento));
});

test('2.4 desligado: sem reoferta e sem nota; a chave que sobrou de uma sessão que estava ligada sai do estado', async () => {
  const host = hostFalso();
  const t1 = await montar({ comportamento: true, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade })
    .executarTurno({ texto: PERGUNTA, estado: ESTADO_INICIAL });
  const sujo = { ...comFalhaNoFecho(t1.estado), despejo: { ...comFalhaNoFecho(t1.estado).despejo, comportamentoAnterior: [] } };
  host.preparos.length = 0;
  const t2 = await montar({ comportamento: false, aoSemear: host.aoSemear, aoPrepararHabilidade: host.aoPrepararHabilidade, ativadas: [] })
    .executarTurno({ texto: 'outro assunto bem diferente e longo o bastante para não ser trivial', trivial: false, estado: sujo });
  assert.deepEqual(host.preparos, []);
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /CORPO_DA_SKILL|<nao_fixadas>/);
  assert.ok(!('comportamento' in t2));
  assert.ok(!('comportamentoFalhasNoFecho' in (t2.estado.despejo ?? {})));
  assert.ok(!('comportamentoAnterior' in (t2.estado.despejo ?? {})));
});

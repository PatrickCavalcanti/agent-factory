import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Contribuição de piso por CHAVE (`contribuicoes[].chaves`, `config.chaves`, `config.catalogoDeChaves`):
 * entra no prompt só quando o turno traz uma das chaves dela. Sem `chaves`, é base. Host que não declara
 * chave não muda de comportamento.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;
const TEXTO = 'qual a agenda de hoje por favor, preciso organizar o dia';

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

const capacidade = {
  id: 'agenda',
  descricao: 'Consulta a agenda.',
  tools: [{ name: 'listar', description: 'Lista itens.', schema: z.object({ dia: z.string() }), handler: async () => ({ itens: [] }) }],
};

const piso = (ref, texto, extra = {}) => ({
  ref, kind: 'regra', description: `Regra ${ref}.`, floor: true, volatil: false,
  destination: 'system:stable', priority: 10, read: async () => texto, ...extra,
});

const BASE = piso('informacoes/regra/base', 'TEXTO_BASE');
// Sem `volatil`: com `chaves` ele é dispensado (a contribuição é volátil por definição).
const GRAFICO = (({ volatil: _volatil, ...resto }) => resto)(piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', { chaves: ['grafico'], priority: 20 }));

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidade],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    ...extra,
  });
}

test('a contribuição com chave só entra quando o turno traz a chave — mesmo orquestrador, turnos seguidos', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], chaves: (ctx) => ctx.chaves });

  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(t1.payload.system.includes('TEXTO_BASE'), 'a base entra sempre');
  assert.ok(!t1.payload.system.includes('TEXTO_GRAFICO'), 'sem a chave, a contribuição não entra');

  const t2 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.ok(t2.payload.system.includes('TEXTO_BASE'));
  assert.ok(t2.payload.system.includes('TEXTO_GRAFICO'), 'com a chave, a contribuição entra');

  // A chave some: o texto que já estava acumulado sai do prompt.
  const t3 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: t2.estado });
  assert.ok(t3.payload.system.includes('TEXTO_BASE'));
  assert.ok(!t3.payload.system.includes('TEXTO_GRAFICO'), 'a chave saiu do turno: o texto acumulado sai junto');
});

test('turno trivial (discover pulado) também relê a contribuição com chave', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], chaves: (ctx) => ctx.chaves });

  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(!t1.payload.system.includes('TEXTO_GRAFICO'));

  const t2 = await orq.executarTurno({ texto: 'x', ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.ok(t2.discover.unchanged, 'o turno 2 tem de ser trivial (discover pulado) para provar a reconstrução');
  assert.ok(t2.payload.system.includes('TEXTO_GRAFICO'), 'a chave chegou num turno trivial: tem de entrar');

  const t3 = await orq.executarTurno({ texto: 'x', ctx: { chaves: [] }, estado: t2.estado });
  assert.ok(t3.discover.unchanged, 'o turno 3 tem de ser trivial (discover pulado)');
  assert.ok(!t3.payload.system.includes('TEXTO_GRAFICO'), 'a chave saiu num turno trivial: tem de sair');
  assert.ok(t3.payload.system.includes('TEXTO_BASE'));
});

test('sem `config.chaves`, o turno tem todas as chaves: as contribuições com chave entram (host que não passa `chaves` não muda)', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO] });
  const { payload } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(payload.system.includes('TEXTO_BASE'));
  assert.ok(payload.system.includes('TEXTO_GRAFICO'));
});

test('chave fora de `catalogoDeChaves` recusa a montagem', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], catalogoDeChaves: ['painel'] });
  await assert.rejects(
    () => orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    (erro) => /fora do catálogo/.test(erro.message) && erro.message.includes('informacoes/regra/grafico'),
  );
});

test('`chaves` em contribuição semântica ou vazia recusa a montagem', async () => {
  const semantica = { ref: 'informacoes/regra/sem', kind: 'regra', description: 'x', floor: false, destination: 'turn:context', read: async () => 'S', chaves: ['grafico'] };
  await assert.rejects(
    () => fabrica({ contribuicoes: [semantica] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /só vale em contribuição de piso/,
  );
  await assert.rejects(
    () => fabrica({ contribuicoes: [piso('informacoes/regra/vazia', 'V', { chaves: [] })] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /`chaves` vazia/,
  );
});

test('`aoMontar` traz `chaves: { doTurno, entraram, ficaram }`', async () => {
  const infos = [];
  const orq = fabrica({
    contribuicoes: [BASE, GRAFICO],
    chaves: (ctx) => ctx.chaves,
    aoMontar: (info) => infos.push(info),
  });
  const t1 = await orq.executarTurno({ texto: TEXTO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.deepEqual(infos[0].chaves, {
    doTurno: [],
    entraram: [],
    ficaram: ['informacoes/regra/grafico'],
  });
  await orq.executarTurno({ texto: TEXTO, ctx: { chaves: ['grafico'] }, estado: t1.estado });
  assert.deepEqual(infos[1].chaves, {
    doTurno: ['grafico'],
    entraram: ['informacoes/regra/grafico'],
    ficaram: [],
  });
});

test('host sem `chaves` em nenhuma contribuição e sem `config.chaves`: `aoMontar` sem a chave `chaves`', async () => {
  const infos = [];
  const { payload } = await fabrica({ contribuicoes: [BASE], aoMontar: (i) => infos.push(i) })
    .executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(payload.system.includes('TEXTO_BASE'));
  assert.ok(!('chaves' in infos[0]), 'sem contribuição com chave, o payload do aoMontar não ganha campo novo');
});

test('contribuição COM `chaves` e sem `config.chaves` monta o mesmo prompt que a mesma contribuição sem o campo `chaves`', async () => {
  const campos = (info) => ({
    mensagens: info.mensagens, secoes: info.secoes, system: info.system,
    mensagemDoTurno: info.mensagemDoTurno, entraram: info.entraram, sairam: info.sairam,
  });
  const rodar = async (grafico) => {
    const infos = [];
    const orq = fabrica({ contribuicoes: [BASE, grafico], aoMontar: (i) => infos.push(i) });
    const t1 = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
    const t2 = await orq.executarTurno({ texto: 'x', estado: t1.estado });
    return { t1, t2, infos };
  };
  const { volatil: _v, chaves: _c, ...semChaves } = GRAFICO;
  // O gêmeo é `volatil: true`: contribuição por chave é volátil por definição (mesma posição no system).
  const comChaves = await rodar(GRAFICO);
  const gemeo = await rodar({ ...semChaves, volatil: true });
  assert.equal(comChaves.t1.payload.system, gemeo.t1.payload.system);
  assert.equal(comChaves.t2.payload.system, gemeo.t2.payload.system);
  assert.deepEqual(campos(comChaves.infos[0]), campos(gemeo.infos[0]));
  assert.deepEqual(campos(comChaves.infos[1]), campos(gemeo.infos[1]));
});

// --- semanticaSemChave / limiaresDeConversa --------------------------------------------------------

const TEXTO_SEM_RELACAO = 'preciso entender o estado atual do projeto antes de continuar o trabalho';
const GRAFICO_SEMANTICO = piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', {
  chaves: ['grafico'], priority: 20, semanticText: 'gráfico, indicador, dashboard',
});
const refsDeConversa = (discover) => discover.explain.filter((e) => e.ring === 'conversation').map((e) => e.ref);

test('semanticaSemChave: a contribuição que não bateu vira item de conversa `chave/<kind>/<origem>.<id>` com o texto dela', async () => {
  const itens = [];
  const orq = fabrica({
    contribuicoes: [BASE, GRAFICO_SEMANTICO],
    chaves: (ctx) => ctx.chaves,
    semanticaSemChave: true,
    limiaresDeConversa: { include: 0, candidate: 0 },
    aoIncluirConversa: (ctx, refs) => itens.push(refs),
  });
  const { discover, payload } = await orq.executarTurno({ texto: TEXTO_SEM_RELACAO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(refsDeConversa(discover).includes('chave/regra/informacoes.grafico'), 'o item semântico não chegou ao kairos');
  assert.deepEqual(itens[0], ['chave/regra/informacoes.grafico']);
  assert.ok(payload.system.includes('TEXTO_GRAFICO') || payload.mensagemDoTurno.includes('TEXTO_GRAFICO'),
    'o texto da contribuição tem de chegar ao prompt pelo canal semântico');
});

test('semanticaSemChave: com a chave no turno, o item semântico NÃO é emitido (a contribuição entra como piso)', async () => {
  const orq = fabrica({
    contribuicoes: [BASE, GRAFICO_SEMANTICO],
    chaves: (ctx) => ctx.chaves,
    semanticaSemChave: true,
  });
  const { discover, payload } = await orq.executarTurno({ texto: TEXTO_SEM_RELACAO, ctx: { chaves: ['grafico'] }, estado: ESTADO_INICIAL });
  assert.ok(!refsDeConversa(discover).includes('chave/regra/informacoes.grafico'));
  assert.ok(payload.system.includes('TEXTO_GRAFICO'));
});

test('semanticaSemChave: sem `semanticText` na contribuição, nada é emitido; desligado (padrão), também não', async () => {
  const semTexto = piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', { chaves: ['grafico'], priority: 20 });
  const a = await fabrica({ contribuicoes: [BASE, semTexto], chaves: (ctx) => ctx.chaves, semanticaSemChave: true })
    .executarTurno({ texto: TEXTO_SEM_RELACAO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(!refsDeConversa(a.discover).some((r) => r.startsWith('chave/')));

  const b = await fabrica({ contribuicoes: [BASE, GRAFICO_SEMANTICO], chaves: (ctx) => ctx.chaves })
    .executarTurno({ texto: TEXTO_SEM_RELACAO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
  assert.ok(!refsDeConversa(b.discover).some((r) => r.startsWith('chave/')));
});

test('limiaresDeConversa chega ao kairos como os cortes de conversa do turno', async () => {
  const comum = {
    contribuicoes: [BASE, GRAFICO_SEMANTICO], chaves: (ctx) => ctx.chaves, semanticaSemChave: true,
  };
  const incluidas = async (extra) => {
    const refs = [];
    await fabrica({ ...comum, ...extra, aoIncluirConversa: (ctx, r) => refs.push(...r) })
      .executarTurno({ texto: TEXTO_SEM_RELACAO, ctx: { chaves: [] }, estado: ESTADO_INICIAL });
    return refs;
  };
  assert.deepEqual(await incluidas({}), [], 'com os cortes padrão, o texto sem relação não puxa o item');
  assert.deepEqual(await incluidas({ limiaresDeConversa: { include: 0, candidate: 0 } }), ['chave/regra/informacoes.grafico']);
});

// --- prioridade (colisão recusada na montagem) --------------------------------------------------------

const montar = (contribuicoes, extra = {}) =>
  fabrica({ contribuicoes, chaves: () => [], ...extra }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });

test('prioridade: duas de piso no mesmo nível com a mesma `priority` recusam a montagem no PRIMEIRO turno, sem a chave entrar', async () => {
  const b20 = piso('informacoes/regra/base', 'TEXTO_BASE', { priority: 20 });
  const g20 = piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', { priority: 20, chaves: ['grafico'] });
  await assert.rejects(() => montar([b20, g20]), (e) => /mesma prioridade \(20\)/.test(e.message)
    && e.message.includes('informacoes/regra/base') && e.message.includes('informacoes/regra/grafico'));
});

test('prioridade: contribuição com `chaves` sem `priority`, ou na posição do bloco de capacidades (50), recusa a montagem', async () => {
  const semPrioridade = piso('informacoes/regra/grafico', 'G', { chaves: ['grafico'], priority: undefined });
  await assert.rejects(() => montar([BASE, semPrioridade]), /precisa declarar `priority`/);
  const em50 = piso('informacoes/regra/grafico', 'G', { chaves: ['grafico'], priority: 50 });
  await assert.rejects(() => montar([BASE, em50]), /é a do bloco de capacidades/);
  // A posição do bloco de capacidades é configurável: com ela em 70, 50 passa e 70 não.
  await montar([BASE, em50], { prioridadeDasCapacidades: 70 });
  const em70 = piso('informacoes/regra/grafico', 'G', { chaves: ['grafico'], priority: 70 });
  await assert.rejects(() => montar([BASE, em70], { prioridadeDasCapacidades: 70 }), /é a do bloco de capacidades/);
});

test('prioridade: decimal distinta (51.01, 51.02) é aceita; destinos `turn:` não disputam posição', async () => {
  const a = piso('informacoes/regra/base', 'TEXTO_BASE', { priority: 51.01 });
  const b = piso('informacoes/regra/grafico', 'TEXTO_GRAFICO', { priority: 51.02, chaves: ['grafico'] });
  const { payload } = await montar([a, b], { chaves: () => ['grafico'] });
  assert.ok(payload.system.includes('TEXTO_BASE') && payload.system.includes('TEXTO_GRAFICO'));
  const noTurno = piso('informacoes/regra/turno', 'TEXTO_TURNO', { destination: 'turn:context', priority: 10 });
  await montar([BASE, noTurno, GRAFICO]);
});

test('prioridade: host sem nenhuma contribuição com `chaves` não ganha validação nova (o empate segue sendo do acumular)', async () => {
  const a = piso('informacoes/regra/a', 'A', { priority: 20 });
  const b = piso('informacoes/regra/b', 'B', { priority: 20 });
  await assert.rejects(() => fabrica({ contribuicoes: [a, b] }).executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL }),
    /duas contribuições "estaveis" com a mesma prioridade/);
});

// --- ref semântico: origem no último segmento, unicidade e kind ----------------------------------------

test('ref semântico leva a origem (`chave/<kind>/<origem>.<id>`): `o1/regra/x` e `o2/regra/x` não colidem', async () => {
  const x1 = piso('o1/regra/x', 'X1', { chaves: ['a'], priority: 20, semanticText: 'x um' });
  const x2 = piso('o2/regra/x', 'X2', { chaves: ['a'], priority: 30, semanticText: 'x dois' });
  const { discover } = await fabrica({
    contribuicoes: [BASE, x1, x2], chaves: () => [], semanticaSemChave: true, limiaresDeConversa: { include: 0, candidate: 0 },
  }).executarTurno({ texto: TEXTO_SEM_RELACAO, estado: ESTADO_INICIAL });
  const refs = refsDeConversa(discover);
  assert.ok(refs.includes('chave/regra/o1.x') && refs.includes('chave/regra/o2.x'), `refs: ${refs}`);
});

test('ref semântico: derivado repetido ou `kind` vazio/ausente recusa a montagem (só com `semanticaSemChave`)', async () => {
  const dup1 = piso('o1/regra/x', 'X1', { chaves: ['a'], priority: 20, semanticText: 'x' });
  const dup2 = piso('o1/outro/regra/x', 'X2', { chaves: ['a'], priority: 30, semanticText: 'x' });
  const opcoes = { chaves: () => [], semanticaSemChave: true };
  await assert.rejects(() => montar([BASE, dup1, dup2], opcoes), /colide com "o1\/regra\/x"/);
  const semKind = piso('o1/regra/y', 'Y', { chaves: ['a'], priority: 20, semanticText: 'y', kind: '' });
  await assert.rejects(() => montar([BASE, semKind], opcoes), /`kind` precisa ser string não vazia/);
  const kindNaoString = piso('o1/regra/y', 'Y', { chaves: ['a'], priority: 20, semanticText: 'y', kind: undefined });
  await assert.rejects(() => montar([BASE, kindNaoString], opcoes), /`kind` precisa ser string não vazia/);
  // Sem `semanticaSemChave` nada disso é conferido.
  await montar([BASE, dup1, dup2], { chaves: () => [] });
  // Colisão com um ref de contribuição semântica (`floor: false`) também.
  const sem = { ref: 'chave/regra/o1.x', kind: 'regra', floor: false, read: async () => 'S' };
  await assert.rejects(() => montar([BASE, dup1, sem], opcoes), /colide com "chave\/regra\/o1.x"/);
});

// --- `config.chaves` instável ---------------------------------------------------------------------------

test('`config.chaves` que lança: o turno completa só com a base e o erro sai em `renderErrors`', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], chaves: () => { throw new Error('boom'); } });
  const { payload, renderErrors, resultado } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(resultado.type, 'completed');
  assert.ok(payload.system.includes('TEXTO_BASE'));
  assert.ok(!payload.system.includes('TEXTO_GRAFICO'));
  assert.ok(renderErrors.some((e) => /config\.chaves falhou/.test(e.error) && /boom/.test(e.error)), JSON.stringify(renderErrors));
});

test('`config.chaves` é chamada UMA vez por turno (memoizada): `ficaram` e o `read` do piso nunca discordam', async () => {
  let chamadas = 0;
  const infos = [];
  // Instável de propósito: a 1ª resposta traz a chave, as seguintes não.
  const orq = fabrica({
    contribuicoes: [BASE, GRAFICO],
    chaves: () => { chamadas += 1; return chamadas === 1 ? ['grafico'] : []; },
    aoMontar: (i) => infos.push(i),
  });
  const { payload } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.equal(chamadas, 1, 'config.chaves tem de ser chamada uma vez por turno');
  assert.deepEqual(infos[0].chaves.entraram, ['informacoes/regra/grafico']);
  assert.ok(payload.system.includes('TEXTO_GRAFICO'), 'o read decidiu com as mesmas chaves que o aoMontar publicou');
});

test('`config.chaves` devolvendo chave fora de `catalogoDeChaves`: ignorada e registrada em `renderErrors`', async () => {
  const orq = fabrica({ contribuicoes: [BASE, GRAFICO], catalogoDeChaves: ['grafico'], chaves: () => ['xpto'] });
  const { payload, renderErrors } = await orq.executarTurno({ texto: TEXTO, estado: ESTADO_INICIAL });
  assert.ok(!payload.system.includes('TEXTO_GRAFICO'));
  assert.ok(renderErrors.some((e) => /fora de catalogoDeChaves/.test(e.error) && /xpto/.test(e.error)), JSON.stringify(renderErrors));
});

test('`volatil` é dispensado quando há `chaves` (volátil por definição); sem `chaves`, segue obrigatório', async () => {
  assert.ok(!('volatil' in GRAFICO));
  await montar([BASE, GRAFICO]);
  const { volatil: _v, ...semVolatil } = piso('informacoes/regra/outra', 'O', { priority: 30 });
  await assert.rejects(() => montar([BASE, semVolatil]), /contribuição de piso sem `volatil`/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';

/**
 * Cobre a correção do BUG 1 (catálogo fechado some quando o texto do turno é
 * trivial — `bridge.prepareTurn` devolve blocos vazios DE PROPÓSITO nesse
 * caso) e a entrada de `contribuicoes` (informação de PISO, não capacidade)
 * na fábrica. Ver `src/index.js#reconstruirBlocosDoTurno` para o desenho.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

/** Provider fake que sempre "fecha" o turno sem chamar tool nenhuma — o que
 *  importa nestes testes é o PROMPT montado, não o loop do genos. */
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

const capacidadePiso = (id = 'agenda') => ({
  id,
  descricao: `Consulta a capacidade ${id}.`,
  tools: [{
    name: 'listar',
    description: `Lista itens de ${id}.`,
    schema: z.object({ dia: z.string() }),
    handler: async () => ({ itens: [] }),
  }],
});

const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };

test('texto trivial não perde o catálogo: o contrato da tool piso aparece com "x" tanto quanto com texto real', async () => {
  const base = {
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    decorarTool: DECORAR_TOOL_NO_OP,
  };

  const orqTrivial = criarOrquestrador({ ...base, provider: providerFechado() });
  const trivial = await orqTrivial.executarTurno({ texto: 'x', estado: ESTADO_INICIAL });

  const orqReal = criarOrquestrador({ ...base, provider: providerFechado() });
  const real = await orqReal.executarTurno({
    texto: 'preciso que voce me ajude a organizar minha agenda de amanha por favor',
    estado: ESTADO_INICIAL,
  });

  assert.ok(trivial.payload.system.includes('Args:'), 'texto trivial perdeu o contrato da tool piso');
  assert.ok(real.payload.system.includes('Args:'), 'controle (texto real) deveria ter o contrato');
  assert.equal(trivial.renderErrors.length, 0);
});

test('contribuição de piso chega ao prompt e muda quando o ctx muda, mesmo em texto trivial', async () => {
  const contribuicao = {
    ref: 'informacoes/contexto/estado',
    kind: 'contexto',
    description: 'Estado atual da sessão.',
    floor: true,
    // O read(ctx) muda a cada turno (`ESTADO_ATUAL=${ctx.valor}`) e o teste
    // abaixo verifica exatamente isso: turno 2 (texto trivial, ctx mudou)
    // precisa mostrar o valor NOVO, não o congelado do turno 1.
    volatil: true,
    destination: 'system:stable',
    priority: 10,
    read: async (ctx) => `ESTADO_ATUAL=${ctx.valor}`,
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    contribuicoes: [contribuicao],
    refsVolateis: () => ['informacoes/contexto/estado'],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const t1 = await orq.executarTurno({ texto: 'qual a agenda de hoje por favor', ctx: { valor: 'A' }, estado: ESTADO_INICIAL });
  assert.ok(t1.payload.system.includes('ESTADO_ATUAL=A'), 'contribuição de piso não chegou ao prompt no turno 1');

  // Turno 2: texto TRIVIAL (discover é pulado) e ctx MUDOU — a reconstrução
  // precisa reler `contribuicao.read(ctx)`, não reexibir o valor congelado.
  const t2 = await orq.executarTurno({ texto: 'x', ctx: { valor: 'B' }, estado: t1.estado });
  assert.ok(t2.payload.system.includes('ESTADO_ATUAL=B'), 'a contribuição não foi RECALCULADA com o novo ctx');
  assert.ok(!t2.payload.system.includes('ESTADO_ATUAL=A'), 'o valor antigo deveria ter sido SUBSTITUÍDO, não duplicado');
});

test('contribuição de piso é recalculada pelo MECANISMO NOVO (`volatil: true`), sem depender de `refsVolateis`', async () => {
  // Espelho do teste acima, com uma diferença deliberada: NÃO passa
  // `refsVolateis` na config. O teste irmão passa `refsVolateis: () =>
  // ['informacoes/contexto/estado']` e por isso continua verde mesmo se
  // `refsVolateisDeclaradas` (a lista que lê `contribuicoes[].volatil ===
  // true` em src/index.js) for anulada por mutação — ele atravessa o
  // caminho legado (`config.refsVolateis`), não o mecanismo novo. Este
  // teste só passa se a leitura de `volatil: true` na PRÓPRIA contribuição
  // estiver funcionando.
  const contribuicao = {
    ref: 'informacoes/contexto/estado',
    kind: 'contexto',
    description: 'Estado atual da sessão.',
    floor: true,
    volatil: true,
    destination: 'system:stable',
    priority: 10,
    read: async (ctx) => `ESTADO_ATUAL=${ctx.valor}`,
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    contribuicoes: [contribuicao],
    // Nenhum `refsVolateis` aqui — de propósito (ver comentário acima).
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const t1 = await orq.executarTurno({ texto: 'qual a agenda de hoje por favor', ctx: { valor: 'A' }, estado: ESTADO_INICIAL });
  assert.ok(t1.payload.system.includes('ESTADO_ATUAL=A'), 'contribuição de piso não chegou ao prompt no turno 1');

  // Turno 2: texto TRIVIAL (discover é pulado) e ctx MUDOU — a reconstrução
  // precisa reler `contribuicao.read(ctx)` usando só `refsVolateisDeclaradas`.
  const t2 = await orq.executarTurno({ texto: 'x', ctx: { valor: 'B' }, estado: t1.estado });
  assert.ok(
    t2.payload.system.includes('ESTADO_ATUAL=B'),
    'a contribuição não foi RECALCULADA com o novo ctx pelo mecanismo `volatil: true` — sem '
    + '`refsVolateis` na config, só `refsVolateisDeclaradas` pode ter feito isso',
  );
  assert.ok(!t2.payload.system.includes('ESTADO_ATUAL=A'), 'o valor antigo deveria ter sido SUBSTITUÍDO, não duplicado');
});

test('`volatil: false` congela: texto trivial com ctx mudado não recalcula a contribuição', async () => {
  const contribuicao = {
    ref: 'informacoes/contexto/estado',
    kind: 'contexto',
    description: 'Estado atual da sessão.',
    floor: true,
    // Espelho do teste `volatil: true` acima, com a declaração oposta: o
    // `read(ctx)` até muda por turno, mas `volatil: false` promete que a
    // contribuição NÃO é recalculada quando o discover é pulado.
    volatil: false,
    destination: 'system:stable',
    priority: 10,
    read: async (ctx) => `ESTADO_ATUAL=${ctx.valor}`,
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    contribuicoes: [contribuicao],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const t1 = await orq.executarTurno({ texto: 'qual a agenda de hoje por favor', ctx: { valor: 'A' }, estado: ESTADO_INICIAL });
  assert.ok(t1.payload.system.includes('ESTADO_ATUAL=A'), 'contribuição de piso não chegou ao prompt no turno 1');

  // Turno 2: texto TRIVIAL (discover é pulado) e ctx MUDOU — mas a
  // contribuição é `volatil: false`, então NÃO deve ser recalculada.
  const t2 = await orq.executarTurno({ texto: 'x', ctx: { valor: 'B' }, estado: t1.estado });
  assert.ok(
    t2.payload.system.includes('ESTADO_ATUAL=A'),
    '`volatil: false` promete que a contribuição não é recalculada — se o valor novo aparecer, '
    + 'a declaração não está sendo respeitada e `true`/`false` dá no mesmo',
  );
  assert.ok(!t2.payload.system.includes('ESTADO_ATUAL=B'), 'o valor novo não deveria ter substituído o congelado');
});

test('contribuição de piso não disputa ranking com capacidade semântica: entra sempre, mesmo com embedder e texto variando', async () => {
  // Embedder falso: o valor do vetor não importa para este teste — o que
  // importa é que uma capacidade PISO:FALSE (que exige embedder para rankear)
  // convive com a contribuição sem que a arbitragem de ranking a afete.
  const embedderFalso = { modelSlug: 'fake-test-v1', embed: async () => [1, 0, 0] };

  const contribuicao = {
    ref: 'informacoes/contexto/estado',
    kind: 'contexto',
    description: 'Estado fixo da sessão.',
    floor: true,
    // read() é uma constante, sem dependência de ctx — não muda por turno.
    // Este teste não exercita o caminho trivial/unchanged (as perguntas são
    // frases completas), então não é o teste que prova a reconstrução; é o
    // par NÃO-volátil que a distinção do arquivo precisa ter.
    volatil: false,
    destination: 'system:stable',
    priority: 10,
    read: async () => 'PISO_SEMPRE_PRESENTE',
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{ ...capacidadePiso('clima'), piso: false, semanticText: 'previsao do tempo chuva temperatura vai chover amanha' }],
    contribuicoes: [contribuicao],
    embedder: embedderFalso,
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  const perguntas = [
    'me conta uma piada qualquer, nada a ver com o resto',
    'qual a previsao do tempo para amanha na capital',
  ];
  for (const texto of perguntas) {
    // eslint-disable-next-line no-await-in-loop
    const { payload } = await orq.executarTurno({ texto, estado: ESTADO_INICIAL });
    assert.ok(payload.system.includes('PISO_SEMPRE_PRESENTE'), `piso sumiu para o texto "${texto}"`);
  }
});

test('render que falha na reconstrução não derruba o turno: o erro sai em renderErrors', async () => {
  const contribuicaoQuebrada = {
    ref: 'informacoes/contexto/quebrada',
    kind: 'contexto',
    description: 'Contribuição cujo read() lança.',
    floor: true,
    // O teste força o caminho de reconstrução (texto trivial) e espera que o
    // render seja TENTADO ali (e falhe) — é `refsVolateis` abaixo que já
    // exige isso; `volatil: true` é a mesma exigência no ponto novo.
    volatil: true,
    destination: 'system:stable',
    priority: 20,
    read: async () => { throw new Error('falha de leitura proposital'); },
  };

  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    contribuicoes: [contribuicaoQuebrada],
    refsVolateis: () => ['informacoes/contexto/quebrada'],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
  });

  // texto trivial: força o caminho de RECONSTRUÇÃO, onde a contribuição
  // quebrada é uma das specs que `assemble()` tenta renderizar.
  const { resultado, renderErrors, payload } = await orq.executarTurno({ texto: 'x', estado: ESTADO_INICIAL });

  assert.equal(resultado.type, 'completed', 'o turno não pode ser derrubado por um render que falha');
  assert.ok(renderErrors.some((e) => e.ref === 'informacoes/contexto/quebrada'), 'o erro da contribuição quebrada não apareceu em renderErrors');
  assert.ok(!payload.system.includes('informacoes/contexto/quebrada'), 'uma contribuição que falhou ao renderizar não pode aparecer no prompt');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { montarProviders, toolsExpostas, sinonimosCrus, tudoPiso, nomeExposto, toolEhFixa } from '../src/capacidades.js';
import { exposedName } from '@okds/kairos/core/names';

const cap = (id, extra = {}) => ({
  id,
  descricao: `A capacidade ${id}.`,
  tools: [{ name: 'fazer', description: 'Faz algo.', schema: z.object({}), handler: async () => null }],
  ...extra,
});

test('capacidade piso registra loading.always e tools pinned', () => {
  const [p] = montarProviders([cap('agenda')]);
  assert.deepEqual(p.provider.loading, { always: true });
  assert.equal(p.tools[0].pinned, true);
});

test('capacidade semântica não é always nem pinned', () => {
  const [p] = montarProviders([cap('notas', { piso: false })]);
  assert.equal(p.provider.loading, undefined);
  assert.ok(!p.tools[0].pinned);
});

test('fixa: true numa tool de capacidade semântica sai com pinned — sem tocar loading.always', () => {
  const [p] = montarProviders([{
    id: 'notas',
    descricao: 'A capacidade notas.',
    piso: false,
    tools: [
      { name: 'minima', description: 'Função mínima.', schema: z.object({}), fixa: true, handler: async () => null },
      { name: 'avancada', description: 'Função avançada.', schema: z.object({}), handler: async () => null },
    ],
  }]);
  assert.equal(p.provider.loading, undefined, 'fixa por tool não pode virar loading.always no provider');
  const minima = p.tools.find((t) => t.key === 'minima');
  const avancada = p.tools.find((t) => t.key === 'avancada');
  assert.equal(minima.pinned, true);
  assert.ok(!avancada.pinned, 'tool sem fixa numa capacidade semântica continua sem pinned');
});

test('omitir fixa mantém o comportamento de hoje nas duas direções (herda piso)', () => {
  const [pisoProvider] = montarProviders([cap('agenda')]);
  assert.equal(pisoProvider.tools[0].pinned, true, 'capacidade piso sem fixa declarado continua pinned');

  const [semanticoProvider] = montarProviders([cap('notas', { piso: false })]);
  assert.ok(!semanticoProvider.tools[0].pinned, 'capacidade semântica sem fixa declarado continua sem pinned');
});

// Revisão do conjunto (2026-09-24, item 6): `toolEhFixa` é o único ponto de verdade da regra
// (extraído de `montarProviders` para ser reusado por `calibracao.js`) — trava direta da tabela
// verdade, inclusive as duas combinações `undefined`/`undefined` que os testes de `montarProviders`
// acima só cobriam indiretamente (via ausência da chave no fixture `cap()`).
test('toolEhFixa: tabela verdade de fixa x piso, inclusive os dois undefined', () => {
  assert.equal(toolEhFixa({}, {}), true, 'tool.fixa undefined + capacidade.piso undefined herda piso-default (true)');
  assert.equal(toolEhFixa({ fixa: undefined }, { piso: undefined }), true, 'explicitamente undefined nos dois — mesmo caso, mesma herança');
  assert.equal(toolEhFixa({}, { piso: false }), false, 'sem fixa própria, herda piso:false da capacidade');
  assert.equal(toolEhFixa({}, { piso: true }), true, 'sem fixa própria, herda piso:true da capacidade');
  assert.equal(toolEhFixa({ fixa: true }, { piso: false }), true, 'fixa:true na tool vence piso:false da capacidade');
  assert.equal(toolEhFixa({ fixa: false }, { piso: true }), false, 'fixa:false na tool vence piso:true da capacidade (nunca herda um `true` que a tool recusou)');
});

test('indexLine é derivada pelo kairos e o contrato default traz os argumentos por campo', async () => {
  const [p] = montarProviders([cap('agenda')]);
  assert.equal(p.tools[0].indexLine, 'fazer — Faz algo.');
  const contrato = await p.tools[0].contract();
  assert.ok(contrato.includes('Args:'));
});

test('toolsExpostas produz o nome que o modelo chama', () => {
  const [t] = toolsExpostas([cap('agenda')]);
  assert.equal(t.nome, 'agenda__fazer');
  assert.equal(t.nome, nomeExposto('agenda', 'fazer'));
  assert.equal(typeof t.handler, 'function');
});

test('capacidade sem tools lança', () => {
  assert.throws(() => montarProviders([{ id: 'vazia', tools: [] }]), /sem tools/);
});

test('tudoPiso distingue os dois casos', () => {
  assert.equal(tudoPiso([cap('a'), cap('b')]), true);
  assert.equal(tudoPiso([cap('a'), cap('b', { piso: false })]), false);
});

/**
 * TRAVA A — `nomeExposto` (aqui) e uma REIMPLEMENTACAO de `exposedName` do
 * kairos, nao um import: a fabrica precisa do nome exposto para MONTAR o
 * prompt, antes de qualquer provider existir, e precisa do `{ prefixar }`, que
 * e conceito so nosso. Duas definicoes da mesma convencao, portanto.
 *
 * O risco nao e teorico. `defineProvider` (adapters/native.ts) CHAMA
 * `exposedName(provider.id, ts.key)` no ato de autoria, e e esse nome que o
 * genos registra e executa. Se a formula de la divergir da nossa, o prompt
 * anuncia `<function name="agenda__listar">` e a chamada morre com "tool nao
 * registrada" — sem erro no registro, sem erro no typecheck: so o turno
 * queimado. Foi exatamente esse o risco quando o separador virou `__`.
 *
 * Desde `@okds/kairos@0.830.260918` existe caminho publico
 * (`@okds/kairos/core/names`), entao esta trava COMPARA com a funcao real em
 * vez de copiar a formula. Antes ela fixava o resultado esperado a mao — o que
 * e quase o mesmo que nao ter trava: uma copia da formula nao pega a
 * divergencia que ela existe para pegar.
 */
test('nomeExposto e byte a byte o exposedName do kairos (funcao real, nao copia da formula)', () => {
  for (const [id, key] of [
    ['agenda', 'listar'],
    ['md_notes', 'gravar_nota'],          // key com `_` interno: o separador tem de ficar visivel
    ['mcp-playwright', 'browser_click'],  // nivel de origem por hifen no id da capacidade
    ['a', 'b'],
  ]) {
    assert.equal(
      nomeExposto(id, key),
      exposedName(id, key),
      `nomeExposto e exposedName divergiram em ("${id}", "${key}") — o prompt anuncia um nome e o genos executa outro`,
    );
  }
});

/**
 * `{ prefixar: false }` e conceito SO da fabrica — o kairos nao tem nocao de
 * "capacidade unica, prefixo nao desambigua nada". Fica fora da comparacao de
 * proposito, e travado aqui para nao virar prefixo por acidente.
 */
test('prefixar:false devolve a key crua, sem separador nenhum', () => {
  assert.equal(nomeExposto('agenda', 'listar', { prefixar: false }), 'listar');
});

/**
 * TRAVA B — `montarProviders` (kairos/prompt) e `toolsExpostas` (genos/
 * execução) partem da MESMA `CapacidadeDeclarada[]`, mas cada uma aplica o
 * default `tool.effect || 'write'` de forma INDEPENDENTE (duas linhas de
 * código separadas em capacidades.js). Nada impede que só uma das duas mude
 * no futuro — este teste compara as duas SAÍDAS lado a lado, tool a tool,
 * pelo nome exposto (não por índice de array: a ordem de `montarProviders`
 * agrupa por capacidade/provider, a de `toolsExpostas` é uma lista achatada —
 * comparar por índice acopla a ordem interna das duas funções sem necessidade
 * e faria o teste quebrar por um refactor inofensivo).
 */
test('effect e description batem entre montarProviders (kairos) e toolsExpostas (genos) para a MESMA declaração', () => {
  const capacidades = [{
    id: 'agenda',
    descricao: 'A capacidade agenda.',
    tools: [
      { name: 'listar', description: 'Lista eventos.', schema: z.object({}), handler: async () => null },
      { name: 'apagar', description: 'Apaga um evento.', schema: z.object({}), effect: 'delete', handler: async () => null },
    ],
  }];

  const providers = montarProviders(capacidades);
  const expostas = toolsExpostas(capacidades);

  let comparados = 0;
  for (const { provider, tools } of providers) {
    for (const t of tools) {
      const nome = nomeExposto(provider.id, t.key);
      const exposta = expostas.find((e) => e.nome === nome);
      assert.ok(exposta, `toolsExpostas não tem entrada para ${nome}`);
      assert.equal(exposta.effect, t.effect, `effect diverge para ${nome}: kairos=${t.effect} genos=${exposta.effect}`);
      assert.equal(exposta.description, t.description, `description diverge para ${nome}`);
      comparados += 1;
    }
  }
  assert.equal(comparados, 2, 'a comparação não cobriu as duas tools declaradas');

  // A tool sem `effect` explícito precisa ter caído no MESMO default nos dois
  // lados — sem isto, um `effect` explícito único (delete) poderia mascarar
  // uma divergência no default (write).
  const listarExposta = expostas.find((e) => e.nome === 'agenda__listar');
  assert.equal(listarExposta.effect, 'write');
  const apagarExposta = expostas.find((e) => e.nome === 'agenda__apagar');
  assert.equal(apagarExposta.effect, 'delete');
});

test('semanticText e awareness da capacidade chegam ao provider do kairos', () => {
  const [{ provider }] = montarProviders([{
    id: 'clima',
    descricao: 'Consulta o clima.',
    piso: false,
    semanticText: 'previsao do tempo chuva temperatura vai chover amanha',
    awareness: {
      useWhen: ['saber se vai chover'],
      skipWhen: ['registrar uma nota — isso vai por notas'],
    },
    tools: [{
      name: 'consultar',
      description: 'Consulta a previsão.',
      semanticText: 'previsao para amanha na capital',
      schema: z.object({ q: z.string() }),
      handler: async () => ({}),
    }],
  }]);

  assert.equal(provider.semanticText, 'previsao do tempo chuva temperatura vai chover amanha');
  assert.deepEqual(provider.awareness, {
    useWhen: ['saber se vai chover'],
    skipWhen: ['registrar uma nota — isso vai por notas'],
  });
});

test('semanticText da TOOL chega à tool do kairos, e a tool não ganha awareness', () => {
  const [{ tools }] = montarProviders([{
    id: 'clima',
    descricao: 'Consulta o clima.',
    tools: [{
      name: 'consultar',
      description: 'Consulta a previsão.',
      semanticText: 'previsao para amanha na capital',
      schema: z.object({ q: z.string() }),
      handler: async () => ({}),
    }],
  }]);

  assert.equal(tools[0].semanticText, 'previsao para amanha na capital');
  assert.equal(tools[0].awareness, undefined, 'awareness é do provider, não da tool (NativeToolSpec não tem o campo)');
});

test('sem semanticText nem awareness, o provider não ganha as chaves — o kairos cai no fallback dele', () => {
  const [{ provider }] = montarProviders([cap('notas')]);
  assert.ok(!('semanticText' in provider), 'chave ausente, não `undefined`: o fallback de semanticDoc é por ausência');
  assert.ok(!('awareness' in provider));
});

// Kairos 0.836: `examples` de Tool e Skill chegam ao registro (viram vetores `query` por item
// quando o host liga `semantica`). Ausente/vazio => a chave nem existe (hash e deepEqual intactos).
test('exemplos da tool viram `examples` no registro do kairos; sem exemplos, sem a chave', async () => {
  const caps = [cap('notas', {
    piso: false,
    tools: [
      { name: 'com', description: 'Com exemplos.', schema: z.object({}), exemplos: ['anota isso', 'cria uma nota'], handler: async () => null },
      { name: 'vazia', description: 'Lista vazia.', schema: z.object({}), exemplos: [], handler: async () => null },
      { name: 'sem', description: 'Sem exemplos.', schema: z.object({}), handler: async () => null },
    ],
  })];
  const [p] = montarProviders(caps);
  assert.deepEqual(p.tools.find((t) => t.key === 'com').examples, ['anota isso', 'cria uma nota']);
  assert.ok(!p.tools.find((t) => t.key === 'vazia').examples?.length);
  assert.ok(!p.tools.find((t) => t.key === 'sem').examples?.length);

  // Ponta a ponta no registry.
  const { createManager } = await import('@okds/kairos/resolve');
  const { registrarCapacidadesNoManager } = await import('../src/index.js');
  const manager = createManager({ embedder: null, can: () => true, skills: { activation: 'none' } });
  await registrarCapacidadesNoManager(manager, caps);
  const tool = manager.registry.listTools('notas').find((t) => t.key === 'com');
  assert.deepEqual(tool.examples, ['anota isso', 'cria uma nota']);
});

test('exemplos da skill viram `examples` no registro do kairos', async () => {
  const fonte = { async skills() { return [
    { key: 'com', descricao: 'Com', corpo: async () => 'c', exemplos: ['planeja minha semana'] },
    { key: 'sem', descricao: 'Sem', corpo: async () => 's' },
  ]; } };
  const caps = [cap('hab', { piso: false, fonte })];
  const { createManager } = await import('@okds/kairos/resolve');
  const { registrarCapacidadesNoManager } = await import('../src/index.js');
  const manager = createManager({ embedder: null, can: () => true, skills: { activation: 'none' } });
  await registrarCapacidadesNoManager(manager, caps);
  const skills = manager.registry.listSkills('hab');
  assert.deepEqual(skills.find((s) => s.key === 'com').examples, ['planeja minha semana']);
  assert.ok(!skills.find((s) => s.key === 'sem').examples?.length);
});

test('sinonimosCrus detecta colisão de nomes crus quando aliasCru: true', () => {
  const caps = [
    { id: 'mcp-a', aliasCru: true, tools: [{ name: 'buscar', schema: z.object({}) }] },
    { id: 'mcp-b', aliasCru: true, tools: [{ name: 'buscar', schema: z.object({}) }] },
  ];
  const expostas = toolsExpostas(caps);
  const { porCru, colisoes } = sinonimosCrus(expostas);
  assert.equal(porCru.size, 0);
  assert.equal(colisoes.length, 1);
  assert.equal(colisoes[0].cru, 'buscar');
  assert.deepEqual(colisoes[0].nomes, ['mcp-a__buscar', 'mcp-b__buscar']);
});

test('criarOrquestrador não avisa colisão crua quando todos forem servidores MCP genéricos', async () => {
  const { criarOrquestrador } = await import('../src/index.js');
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    criarOrquestrador({
      base: () => [],
      protocolo: 'envelope',
      provider: () => ({ capabilities: {}, generate: async () => ({}) }),
      embedder: null,
      can: () => true,
      capacidades: [
        { id: 'mcp-crm', aliasCru: true, mcp: { generico: true }, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
        { id: 'mcp-erp', aliasCru: true, mcp: { generico: true }, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
      ],
    });
    assert.equal(warnings.some((w) => w.includes('buscar')), false, 'não deve emitir aviso para MCP genérico');

    // Mas avisa se ao menos uma não for MCP
    criarOrquestrador({
      base: () => [],
      protocolo: 'envelope',
      provider: () => ({ capabilities: {}, generate: async () => ({}) }),
      embedder: null,
      can: () => true,
      capacidades: [
        { id: 'agenda', aliasCru: true, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
        { id: 'mcp-erp', aliasCru: true, mcp: { generico: true }, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
      ],
    });
    assert.equal(warnings.some((w) => w.includes('buscar')), true, 'deve emitir aviso quando houver colisão com não-MCP');

    // Também avisa se capacidade tem prefixo mcp- mas não declara mcp.generico === true
    warnings.length = 0;
    criarOrquestrador({
      base: () => [],
      protocolo: 'envelope',
      provider: () => ({ capabilities: {}, generate: async () => ({}) }),
      embedder: null,
      can: () => true,
      capacidades: [
        { id: 'mcp-crm', aliasCru: true, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
        { id: 'mcp-erp', aliasCru: true, mcp: { generico: true }, tools: [{ name: 'buscar', schema: z.object({}), description: 'b' }] },
      ],
    });
    assert.equal(warnings.some((w) => w.includes('buscar')), true, 'deve emitir aviso quando mcp- não tem mcp.generico === true');
  } finally {
    console.warn = origWarn;
  }
});


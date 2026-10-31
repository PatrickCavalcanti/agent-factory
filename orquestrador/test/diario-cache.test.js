import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarConstrutorDePrompt, systemVazio } from '../src/prompt-builder.js';
import { criarOrquestrador } from '../src/index.js';

// Invariantes da estabilização do cache (spec 2026-10-15-estabilizacao-do-cache-do-prompt-design.md):
// I1 prefixo do turno N-1 preservado até o fim do bloco de capacidades; I2 hidratar/carregar só
// acrescenta; I3 cauda trocando não mexe no que vem antes; I4 piso do turno trivial = piso de turno
// normal; I5 o que é chamável não muda com o layout; I6 entrada escrita não muda.

const config = (layout) => ({
  base: () => [{ nome: 'identidade', conteudo: '<identidade>Sou um agente.</identidade>' }],
  layoutDasCapacidades: layout,
  prioridadeDasCapacidades: 500,
});

const bloco = (ref, content, destination = 'turn:context', priority = 1) => ({ ref, label: ref, content, destination, priority });
const idx = (providerId, key, linha) => ({ ref: `${providerId}/tool/${key}#index`, providerId, nome: `${providerId}__${key}`, conteudo: linha });

/** Roteiro do uso real: piso no turno 1; manual de capacidade ANTIGA no 2 + capacidade nova; mais um manual antigo no 3. */
function roteiro() {
  return [
    {
      system: [bloco('memoria/instructions', 'Guarda e consulta memórias.', 'system:stable', 0),
        bloco('executor/stable/sessao', 'sessão S', 'system:stable', 301),
        bloco('memoria/piso/indice', 'índice v1', 'system:stable', 1032)],
      turno: [bloco('memoria/tool/salvar', 'Manual de salvar. Args: *valor')],
      indice: [idx('memoria', 'salvar', 'salva'), idx('memoria', 'ver', 'mostra uma'), idx('memoria', 'listar', 'lista todas')],
      conscientes: ['memoria/tool/salvar', 'memoria/tool/ver', 'memoria/tool/listar'],
      providersCarregados: ['memoria'],
    },
    {
      system: [bloco('agenda/instructions', 'Consulta a agenda.', 'system:stable', 0),
        bloco('executor/stable/sessao', 'sessão S', 'system:stable', 301),
        bloco('memoria/piso/indice', 'índice v2 (mudou)', 'system:stable', 1032)],
      turno: [bloco('memoria/tool/ver', 'Manual de ver. Args: *chave'), bloco('agenda/tool/eventos', 'Manual de eventos. Args: *dia')],
      indice: [idx('agenda', 'eventos', 'lista eventos'), idx('agenda', 'criar', 'cria evento')],
      conscientes: ['memoria/tool/salvar', 'memoria/tool/ver', 'memoria/tool/listar', 'agenda/tool/eventos', 'agenda/tool/criar'],
      providersCarregados: ['agenda'],
    },
    {
      system: [bloco('executor/stable/sessao', 'sessão S', 'system:stable', 301),
        bloco('memoria/piso/indice', 'índice v3', 'system:stable', 1032)],
      turno: [bloco('memoria/tool/listar', 'Manual de listar.')],
      indice: [],
      conscientes: ['memoria/tool/salvar', 'memoria/tool/ver', 'memoria/tool/listar', 'agenda/tool/eventos', 'agenda/tool/criar'],
      providersCarregados: [],
    },
  ];
}

function rodar(layout) {
  const c = criarConstrutorDePrompt(config(layout));
  let system = systemVazio();
  const saidas = [];
  for (const passo of roteiro()) {
    const r = c.acumular({ anterior: system, ...passo });
    system = r.system;
    const p = c.montar({ contexto: {}, texto: 'oi', system, efemeros: r.efemeros, historico: [] });
    const comManual = new Set(system.capacidades.flatMap(cap => cap.funcoes.filter(f => f.manual).map(f => f.nome)));
    saidas.push({ system: p.system, comManual, diario: system.diario });
  }
  return saidas;
}

const fimDasCapacidades = (s) => s.indexOf('</capabilities>');

test('I1/I2: no diário, cada turno preserva byte a byte o system anterior até o fim do bloco de capacidades', () => {
  const t = rodar('diario');
  for (let n = 1; n < t.length; n += 1) {
    const corte = fimDasCapacidades(t[n - 1].system);
    assert.ok(corte > 0);
    assert.equal(t[n].system.slice(0, corte), t[n - 1].system.slice(0, corte), `turno ${n + 1} reescreveu o prefixo`);
  }
});

test('controle: no layout agrupado o mesmo roteiro reescreve o meio do bloco (o teste acima discrimina)', () => {
  const t = rodar('agrupado');
  const corte = fimDasCapacidades(t[0].system);
  assert.notEqual(t[1].system.slice(0, corte), t[0].system.slice(0, corte));
});

test('I6: entrada escrita não muda e as novas vão ao fim, em ordem de chegada', () => {
  const t = rodar('diario');
  const tipos = t[2].diario.map(e => `${e.tipo}:${e.capId}${e.tipo === 'manual' ? `/${e.nome}` : ''}`);
  assert.deepEqual(tipos, [
    'capacidade:memoria', 'manual:memoria/memoria__salvar',
    'capacidade:agenda', 'manual:memoria/memoria__ver', 'manual:agenda/agenda__eventos',
    'manual:memoria/memoria__listar',
  ]);
  assert.deepEqual(t[2].diario.slice(0, 2), t[0].diario, 'as entradas do turno 1 continuam idênticas no turno 3');
  // O cartão continua listando a função depois que o manual dela chegou (nada se move).
  assert.match(t[2].system, /<capability name="memoria">[\s\S]*- memoria__ver — mostra uma[\s\S]*<\/capability>/);
  assert.match(t[2].system, /<function name="memoria__ver" capability="memoria">/);
});

test('I3: a cauda (contribuição depois do bloco) muda sem tocar o que vem antes; a estável de sessão fica antes', () => {
  const t = rodar('diario');
  const s = t[1].system;
  assert.ok(s.indexOf('sessão S') < s.indexOf('<capabilities>'), 'prioridade 301 < 500: antes do bloco');
  assert.ok(s.indexOf('índice v2') > fimDasCapacidades(s), 'prioridade 1032 > 500: depois do bloco');
});

test('I5: o conjunto de funções chamáveis é o mesmo nos dois layouts — e TODA chamável tem o manual no TEXTO', () => {
  const d = rodar('diario');
  const a = rodar('agrupado');
  for (let n = 0; n < d.length; n += 1) {
    assert.deepEqual([...d[n].comManual].sort(), [...a[n].comManual].sort());
    for (const nome of d[n].comManual) {
      assert.ok(d[n].system.includes(`<function name="${nome}"`), `turno ${n + 1}: ${nome} é chamável mas o manual não está no texto (diário)`);
    }
  }
});

test('turno que falha depois do acumular não apaga manual do turno seguinte (estado anterior intacto)', () => {
  const c = criarConstrutorDePrompt(config('diario'));
  const [p1, p2] = roteiro();
  const s1 = c.acumular({ anterior: systemVazio(), ...p1 }).system;
  // Turno 2 roda o acumular e FALHA depois: o resultado é descartado, o host reaproveita `s1`.
  c.acumular({ anterior: s1, ...roteiro()[1] });
  assert.equal(s1.capacidades.find(x => x.id === 'memoria').funcoes.find(f => f.nome === 'memoria__ver').manual, undefined,
    'o acumular descartado vazou o manual para o estado anterior');
  const r = c.acumular({ anterior: s1, ...p2 });
  const sistema = c.montar({ contexto: {}, texto: 'oi', system: r.system, efemeros: [], historico: [] }).system;
  assert.ok(sistema.includes('<function name="memoria__ver" capability="memoria">'), 'manual de memoria__ver sumiu do texto');
});

test('permissão perdida e recuperada não duplica linha nem manual no diário', () => {
  const c = criarConstrutorDePrompt(config('diario'));
  const ler = idx('d', 'ler', 'lê'); const apagar = idx('d', 'apagar', 'apaga');
  const r1 = c.acumular({ anterior: systemVazio(), system: [], turno: [bloco('d/tool/apagar', 'Manual de apagar.')], indice: [ler, apagar], conscientes: ['d/tool/ler', 'd/tool/apagar'], providersCarregados: ['d'] });
  const r2 = c.acumular({ anterior: r1.system, system: [], turno: [], indice: [ler], conscientes: ['d/tool/ler'], providersCarregados: ['d'] });
  const r3 = c.acumular({ anterior: r2.system, system: [], turno: [bloco('d/tool/apagar', 'Manual de apagar.')], indice: [ler, apagar], conscientes: ['d/tool/ler', 'd/tool/apagar'], providersCarregados: ['d'] });
  const s = c.montar({ contexto: {}, texto: 'x', system: r3.system, efemeros: [], historico: [] }).system;
  assert.equal(s.match(/- d__apagar — /g)?.length, 1, 'linha duplicada');
  assert.equal(s.match(/<function name="d__apagar"/g)?.length, 1, 'manual duplicado');
});

test('extra: descrição que chega depois do cartão vira <capability_extra> no fim, sem reescrever o cartão', () => {
  const c = criarConstrutorDePrompt(config('diario'));
  const r1 = c.acumular({ anterior: systemVazio(), system: [], turno: [], indice: [idx('tela', 'mostrar', 'mostra')], conscientes: ['tela/tool/mostrar'], providersCarregados: ['tela'] });
  const p1 = c.montar({ contexto: {}, texto: 'x', system: r1.system, efemeros: [], historico: [] }).system;
  const r2 = c.acumular({ anterior: r1.system, system: [bloco('tela/instructions', 'Mostra coisas na tela.', 'system:stable', 0)], turno: [], indice: [idx('tela', 'fechar', 'fecha')], conscientes: ['tela/tool/mostrar', 'tela/tool/fechar'], providersCarregados: ['tela'] });
  const p2 = c.montar({ contexto: {}, texto: 'x', system: r2.system, efemeros: [], historico: [] }).system;
  const corte = fimDasCapacidades(p1);
  assert.equal(p2.slice(0, corte), p1.slice(0, corte));
  assert.match(p2, /<capability_extra name="tela">\nMostra coisas na tela\.[\s\S]*- tela__fechar — fecha/);
});

test('perda de permissão: a linha e o manual da função somem do diário (única reescrita aceita)', () => {
  const c = criarConstrutorDePrompt(config('diario'));
  const r1 = c.acumular({ anterior: systemVazio(), system: [], turno: [bloco('dados/tool/apagar', 'Manual de apagar.')], indice: [idx('dados', 'ler', 'lê'), idx('dados', 'apagar', 'apaga')], conscientes: ['dados/tool/ler', 'dados/tool/apagar'], providersCarregados: ['dados'] });
  const r2 = c.acumular({ anterior: r1.system, system: [], turno: [], indice: [idx('dados', 'ler', 'lê')], conscientes: ['dados/tool/ler'], providersCarregados: ['dados'] });
  const p2 = c.montar({ contexto: {}, texto: 'x', system: r2.system, efemeros: [], historico: [] }).system;
  assert.doesNotMatch(p2, /dados__apagar/);
  assert.match(p2, /- dados__ler — lê/);
});

test('estado sem diário (sessão anterior ao layout) ganha um diário inicial sem perder nada', () => {
  const agrupado = criarConstrutorDePrompt(config('agrupado'));
  const r1 = agrupado.acumular({ anterior: systemVazio(), ...roteiro()[0] });
  const semDiario = { ...r1.system };
  delete semDiario.diario;
  const diario = criarConstrutorDePrompt(config('diario'));
  const r2 = diario.acumular({ anterior: semDiario, ...roteiro()[1] });
  const tipos = r2.system.diario.map(e => e.tipo);
  assert.equal(tipos[0], 'capacidade');
  assert.ok(r2.system.diario.some(e => e.tipo === 'manual' && e.nome === 'memoria__salvar'));
});

test('layout inválido é recusado', () => {
  assert.throws(() => criarConstrutorDePrompt({ ...config('outro') }), /layoutDasCapacidades inválido/);
});

// -- D2: piso completo no turno trivial -----------------------------------------------------------

const ESTADO_INICIAL = () => ({ system: systemVazio(), turno: 0, kairos: { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] } });
function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
    async generate() { return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' }; },
  });
}
const capacidadePiso = () => ({
  id: 'memoria',
  descricao: 'Memória do usuário.',
  instrucoes: 'REGRAS DA MEMÓRIA: use para lembrar preferências.',
  tools: [
    { name: 'salvar', description: 'Salva uma memória.', schema: z.object({ valor: z.string() }), handler: async () => ({}) },
    { name: 'ver', description: 'Mostra uma memória.', schema: z.object({ chave: z.string() }), handler: async () => ({}), fixa: false },
  ],
});

async function doisTurnos(pisoCompleto, layout = 'diario') {
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [capacidadePiso()],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    decorarTool: (nome, d) => d,
    provider: providerFechado(),
    layoutDasCapacidades: layout,
    prioridadeDasCapacidades: 500,
    pisoCompletoNoTurnoTrivial: pisoCompleto,
  });
  const t1 = await orq.executarTurno({ texto: 'oi', estado: ESTADO_INICIAL() });
  const t2 = await orq.executarTurno({ texto: 'preciso lembrar das minhas preferencias de reuniao por favor', estado: t1.estado });
  return { t1: t1.payload.system, t2: t2.payload.system };
}

test('I4: com piso completo, o turno trivial já traz descrição e índice inteiro, e o turno 2 preserva o prefixo', async () => {
  const { t1, t2 } = await doisTurnos(true);
  assert.match(t1, /REGRAS DA MEMÓRIA/, 'descrição do piso no turno trivial');
  assert.match(t1, /memoria__ver — /, 'função não fixa listada no índice do turno trivial');
  const corte = fimDasCapacidades(t1);
  assert.equal(t2.slice(0, corte), t1.slice(0, corte), 'turno 2 reescreveu o piso do turno trivial');
  // Discrimina de verdade (revisão, achado 3): sem o piso completo a descrição chegaria no turno 2
  // como complemento no fim; com ele, o turno 2 não precisa de complemento nenhum para o piso.
  assert.doesNotMatch(t2, /<capability_extra name="memoria">/);
});

test('controle de I4: sem piso completo, o turno trivial não traz a descrição e o turno 2 precisa de complemento', async () => {
  const { t1, t2 } = await doisTurnos(false);
  assert.doesNotMatch(t1, /REGRAS DA MEMÓRIA/);
  assert.match(t2, /<capability_extra name="memoria">/);
});

// -- Layout `lista-fixa` (decisão do dono, 2026-10-15; spec §7) ----------------------------------
// Capacidade como bloco fechado: lista FIXA de todas as funções + manuais das carregadas logo abaixo,
// dentro da capacidade. Carregar perde o cache dali para baixo (aceito); o resto acima fica igual.

/** Trecho de uma capacidade no system (do `<capability name="id">` ao `</capability>` dela). */
function blocoDa(system, id) {
  const ini = system.indexOf(`<capability name="${id}">`);
  if (ini < 0) return null;
  const fim = system.indexOf('</capability>', ini) + '</capability>'.length;
  return { ini, fim, texto: system.slice(ini, fim) };
}

function rodarListaFixa(prioridadeDeclarada) {
  const c = criarConstrutorDePrompt(config('lista-fixa'));
  let system = systemVazio();
  const saidas = [];
  for (const passo of roteiro()) {
    const r = c.acumular({ anterior: system, ...passo, ...(prioridadeDeclarada ? { prioridadeDeclarada } : {}) });
    system = r.system;
    const p = c.montar({ contexto: {}, texto: 'oi', system, efemeros: r.efemeros, historico: [] });
    const comManual = new Set(system.capacidades.flatMap(cap => cap.funcoes.filter(f => f.manual).map(f => f.nome)));
    saidas.push({ system: p.system, comManual });
  }
  return saidas;
}

test('lista-fixa: carregar manual em capacidade antiga preserva tudo até o fim do grupo de manuais dela', () => {
  const t = rodarListaFixa();
  // Turno 2 carrega memoria__ver (memoria já existia): a inserção é logo antes do `</capability>` da memoria.
  const b1 = blocoDa(t[0].system, 'memoria');
  const corte = b1.fim - '</capability>'.length;
  assert.equal(t[1].system.slice(0, corte), t[0].system.slice(0, corte));
});

test('lista-fixa: a lista de funções não muda quando a função carrega; o manual fica dentro da capacidade', () => {
  const t = rodarListaFixa();
  const lista = (s) => blocoDa(s, 'memoria').texto.match(/<functions>[\s\S]*?<\/functions>/)[0];
  assert.equal(lista(t[2].system), lista(t[0].system), 'lista de funções mudou');
  const mem = blocoDa(t[2].system, 'memoria').texto;
  for (const nome of ['memoria__salvar', 'memoria__ver', 'memoria__listar']) {
    assert.ok(mem.includes(`<function name="${nome}">`), `${nome} fora do bloco da memoria`);
  }
  assert.match(mem, /Carregadas — manual completo, chame direto:/);
  // Ordem de carga dentro da capacidade: salvar (t1) → ver (t2) → listar (t3).
  assert.ok(mem.indexOf('memoria__salvar">') < mem.indexOf('memoria__ver">'));
  assert.ok(mem.indexOf('memoria__ver">') < mem.indexOf('memoria__listar">'));
});

test('lista-fixa: capacidade nova entra no fim do bloco; as de cima ficam iguais', () => {
  const t = rodarListaFixa();
  // Turno 2 também mexe na memoria (manual novo); compara só a parte da agenda: entrou depois da memoria.
  assert.ok(blocoDa(t[1].system, 'agenda').ini > blocoDa(t[1].system, 'memoria').fim);
});

test('lista-fixa: toda função chamável tem o manual no texto, dentro da própria capacidade (I5)', () => {
  const t = rodarListaFixa();
  for (const s of t) {
    for (const nome of s.comManual) {
      const cap = nome.split('__')[0];
      assert.ok(blocoDa(s.system, cap).texto.includes(`<function name="${nome}">`), `${nome} sem manual no bloco de ${cap}`);
    }
  }
});

test('lista-fixa: ordem das capacidades segue a prioridade declarada (piso por volatilidade)', () => {
  const t = rodarListaFixa(new Map([['agenda', 101], ['memoria', 107]]));
  // A agenda só chega no turno 2: com prioridade menor, renderiza acima da memoria a partir dali.
  assert.ok(blocoDa(t[1].system, 'agenda').ini < blocoDa(t[1].system, 'memoria').ini);
});

test('lista-fixa: só uma capacidade nova entrando preserva o system até o fim da última capacidade anterior', () => {
  const c = criarConstrutorDePrompt(config('lista-fixa'));
  const r1 = c.acumular({ anterior: systemVazio(), ...roteiro()[0] });
  const p1 = c.montar({ contexto: {}, texto: 'x', system: r1.system, efemeros: [], historico: [] }).system;
  const r2 = c.acumular({ anterior: r1.system, system: [bloco('agenda/instructions', 'Consulta a agenda.', 'system:stable', 0)], turno: [], indice: [idx('agenda', 'eventos', 'lista eventos')], conscientes: ['memoria/tool/salvar', 'memoria/tool/ver', 'memoria/tool/listar', 'agenda/tool/eventos'], providersCarregados: ['agenda'] });
  const p2 = c.montar({ contexto: {}, texto: 'x', system: r2.system, efemeros: [], historico: [] }).system;
  const corte = p1.lastIndexOf('</capability>') + '</capability>'.length;
  assert.equal(p2.slice(0, corte), p1.slice(0, corte));
  assert.ok(p2.indexOf('<capability name="agenda">') > corte);
});

test('I4 no lista-fixa: piso completo no trivial — o turno 2 não reescreve nada até o fim do bloco de capacidades', async () => {
  const { t1, t2 } = await doisTurnos(true, 'lista-fixa');
  assert.match(t1, /REGRAS DA MEMÓRIA/);
  assert.match(t1, /memoria__ver — /);
  const corte = fimDasCapacidades(t1);
  assert.equal(t2.slice(0, corte), t1.slice(0, corte));
  const sem = await doisTurnos(false, 'lista-fixa');
  assert.notEqual(sem.t2.slice(0, fimDasCapacidades(sem.t1)), sem.t1.slice(0, fimDasCapacidades(sem.t1)), 'controle: sem piso completo o turno 2 reescreve o piso');
});

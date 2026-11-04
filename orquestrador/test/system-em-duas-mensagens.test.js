import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConstrutorDePrompt, systemVazio } from '../src/prompt-builder.js';

/**
 * Cache entre execuções: com `separarSystemVolatil` o system sai em DUAS mensagens `developer`,
 * cortadas antes da primeira seção volátil. Testes no nível do prompt-builder puro (como `prefixo.test.js`).
 */

const base = () => [{ nome: 'identidade', conteudo: '<identidade>Sou um agente.</identidade>' }];

function bloco(ref, content, destination, priority) {
  return { ref, label: ref, content, destination, priority };
}

const indice = [{ ref: 'agenda/tool/listar#index', providerId: 'agenda', nome: 'agenda__listar', conteudo: 'agenda__listar — lista eventos' }];

/** Estável 10 (registro), capacidades (50), piso 60 estável de fato, pisos 61 e 62 voláteis. */
function acumulado(construtor, { volatil61 = 'worktree: tentativa 1', volatil62 = 'mensagem: ola' } = {}) {
  return construtor.acumular({
    anterior: systemVazio(),
    system: [
      bloco('registro/piso/regras', 'regras fixas do papel', 'system:stable', 10),
      bloco('papel/piso/projeto', 'dados que nao mudam no job', 'system:stable', 60),
      bloco('papel/piso/worktree', volatil61, 'system:stable', 61),
      bloco('papel/piso/mensagem', volatil62, 'system:stable', 62),
    ],
    turno: [bloco('agenda/tool/listar', 'Lista eventos. args: {dia}', 'turn:context', 1)],
    indice,
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  }).system;
}

const volateis = ['papel/piso/worktree', 'papel/piso/mensagem'];
const entrada = (system, extra = {}) => ({ contexto: {}, texto: 'oi', system, efemeros: [], historico: [], ...extra });

test('opção ligada: duas mensagens developer, cortadas na primeira seção de piso volátil', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const p = c.montar(entrada(acumulado(c), { refsVolateis: volateis }));

  const devs = p.mensagens.filter((m) => m.role === 'developer');
  assert.equal(devs.length, 2);
  assert.deepEqual(p.mensagens.slice(0, 2).map((m) => m.id), ['sys', 'sys-volatil']);
  assert.equal(p.mensagens[2].id, 'usr');

  const [estavel, volatil] = devs.map((m) => m.content);
  assert.ok(estavel.includes('regras fixas do papel'));
  assert.ok(estavel.includes('<capability name="agenda">'), 'o bloco de capacidades fica na parte estável');
  assert.ok(estavel.includes('dados que nao mudam no job'), 'piso não volátil antes do primeiro volátil fica no estável');
  assert.ok(!estavel.includes('worktree: tentativa 1'));
  assert.ok(volatil.startsWith('<info source="papel/piso/worktree">'), 'a parte volátil abre na primeira seção volátil');
  assert.ok(volatil.includes('mensagem: ola'), 'tudo depois do corte é volátil, mesmo o que não foi declarado');
});

test('a junção das duas mensagens dá exatamente os bytes de system; secoes seguem inteiras', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const system = acumulado(c);
  const p = c.montar(entrada(system, { refsVolateis: volateis }));
  const devs = p.mensagens.filter((m) => m.role === 'developer');
  assert.equal(devs.map((m) => m.content).join('\n\n'), p.system);

  const desligada = criarConstrutorDePrompt({ base }).montar(entrada(system, { refsVolateis: volateis }));
  assert.equal(p.system, desligada.system, 'o system inteiro não muda com a opção');
  assert.deepEqual(p.secoes, desligada.secoes, 'as seções do rastro não mudam com a opção');
});

test('mudar só a parte volátil não muda a primeira mensagem (o prefixo reaproveitável)', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const a = c.montar(entrada(acumulado(c, { volatil61: 'worktree: tentativa 1', volatil62: 'msg A' }), { refsVolateis: volateis }));
  const b = c.montar(entrada(acumulado(c, { volatil61: 'worktree: tentativa 3 branch x', volatil62: 'msg B' }), { refsVolateis: volateis }));
  assert.equal(a.mensagens[0].content, b.mensagens[0].content);
  assert.notEqual(a.mensagens[1].content, b.mensagens[1].content);
});

test('opção desligada: uma mensagem só, idêntica à de sempre', () => {
  const c = criarConstrutorDePrompt({ base });
  const p = c.montar(entrada(acumulado(c), { refsVolateis: volateis }));
  assert.deepEqual(p.mensagens.map((m) => m.id), ['sys', 'usr']);
  assert.equal(p.mensagens[0].content, p.system);
});

test('opção ligada sem nada volátil: uma mensagem só', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const semRefs = c.montar(entrada(acumulado(c)));
  assert.deepEqual(semRefs.mensagens.map((m) => m.id), ['sys', 'usr']);
  const refsDeOutroLugar = c.montar(entrada(acumulado(c), { refsVolateis: ['nao/existe/aqui'] }));
  assert.deepEqual(refsDeOutroLugar.mensagens.map((m) => m.id), ['sys', 'usr']);
  assert.equal(refsDeOutroLugar.mensagens[0].content, refsDeOutroLugar.system);
});

test('volátil abrindo o system (nada estável antes dela): uma mensagem só', () => {
  const c = criarConstrutorDePrompt({ base: () => [], separarSystemVolatil: true });
  const system = c.acumular({
    anterior: systemVazio(),
    system: [bloco('papel/piso/worktree', 'w', 'system:stable', 1)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  }).system;
  const p = c.montar(entrada(system, { refsVolateis: ['papel/piso/worktree'] }));
  assert.deepEqual(p.mensagens.map((m) => m.id), ['sys', 'usr']);
});

test('o nível dinâmico é volátil por definição e abre a parte volátil', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const system = c.acumular({
    anterior: systemVazio(),
    system: [
      bloco('registro/piso/regras', 'regras fixas do papel', 'system:stable', 10),
      bloco('tela/aberta', 'tela X', 'system:dynamic', 1),
    ],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  }).system;
  const p = c.montar(entrada(system));
  const devs = p.mensagens.filter((m) => m.role === 'developer');
  assert.equal(devs.length, 2);
  assert.ok(devs[1].content.includes('tela X') && !devs[0].content.includes('tela X'));
  assert.equal(devs.map((m) => m.content).join('\n\n'), p.system);
});

test('o histórico e o turno seguem depois das duas mensagens de sistema, na mesma ordem', () => {
  const c = criarConstrutorDePrompt({ base, separarSystemVolatil: true });
  const historico = [{ id: 'h1', role: 'user', content: 'antes' }, { id: 'h2', role: 'assistant', content: 'resposta' }];
  const p = c.montar(entrada(acumulado(c), { refsVolateis: volateis, historico }));
  assert.deepEqual(p.mensagens.map((m) => m.id), ['sys', 'sys-volatil', 'h1', 'h2', 'usr']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConstrutorDePrompt, systemVazio } from '../src/prompt-builder.js';

/**
 * Mudança 1 (2026-09-18): prioridade de capacidade resolvida NA INSERÇÃO.
 *
 * Testes no nível do `prompt-builder` puro (como `prefixo.test.js`), não da
 * fábrica inteira — a mecânica em questão (default 500, colisão empurra para o
 * próximo inteiro livre, persistência entre turnos) é do `acumular`, e testar
 * aqui evita o custo de montar `criarOrquestrador` + kairos só para observar
 * um número.
 */

const config = {
  base: () => [{ nome: 'identidade', conteudo: '<identidade>Sou um agente.</identidade>' }],
};

/** Linha de índice no formato que a ponte do kairos entrega. */
function indiceDe(providerId, tool) {
  return {
    ref: `${providerId}/tool/${tool}#index`,
    providerId,
    nome: `${providerId}_${tool}`,
    conteudo: `${providerId}_${tool} — linha de índice`,
  };
}

test('duas capacidades com o default entram em 500 e 501, e a ordem no prompt é a de chegada', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [],
    // Nenhuma das duas declara prioridade — as duas disputam o mesmo default.
    indice: [indiceDe('agenda', 'listar'), indiceDe('notas', 'buscar')],
    conscientes: ['agenda/tool/listar', 'notas/tool/buscar'],
    providersCarregados: ['agenda', 'notas'],
  });

  const agenda = t1.system.capacidades.find((c) => c.id === 'agenda');
  const notas = t1.system.capacidades.find((c) => c.id === 'notas');
  assert.equal(agenda.prioridade, 500, 'a primeira capacidade a chegar reclama o default 500');
  assert.equal(notas.prioridade, 501, 'a segunda default colide com 500 na inserção e recebe o próximo inteiro livre');

  const p1 = construtor.montar({ contexto: {}, texto: 'x', system: t1.system, efemeros: [], historico: [] });
  const posAgenda = p1.system.indexOf('<capability name="agenda">');
  const posNotas = p1.system.indexOf('<capability name="notas">');
  assert.ok(posAgenda >= 0 && posNotas >= 0, 'as duas capacidades têm que estar no prompt');
  assert.ok(
    posAgenda < posNotas,
    'com números crescentes por colisão, ordenar por prioridade dá o MESMO resultado que a ordem de chegada',
  );
});

test('a prioridade atribuída sobrevive ao próximo turno — a primeira capacidade continua em 500', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [],
    indice: [indiceDe('agenda', 'listar')],
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  assert.equal(t1.system.capacidades.find((c) => c.id === 'agenda').prioridade, 500);

  // Segundo turno: o host reenvia o índice de `agenda` (contrato de
  // `EntradaDaAcumulacao.indice` — o índice INTEIRO, não só o novo) e uma
  // capacidade nova chega. Se a prioridade fosse recalculada aqui, `agenda`
  // continuaria em 500 por coincidência — o que prova persistência de
  // verdade é a AUSÊNCIA de `prioridadeDeclarada` neste turno: não há como o
  // builder redescobrir 500 do nada, só reaproveitar o que já estava lá.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [],
    indice: [indiceDe('agenda', 'listar'), indiceDe('notas', 'buscar')],
    conscientes: ['agenda/tool/listar', 'notas/tool/buscar'],
    providersCarregados: ['agenda', 'notas'],
  });

  assert.equal(
    t2.system.capacidades.find((c) => c.id === 'agenda').prioridade, 500,
    'a prioridade não é recalculada para quem já existe — persiste por referência, não por default',
  );
  assert.equal(t2.system.capacidades.find((c) => c.id === 'notas').prioridade, 501);
});

test('prioridade explícita menor põe a capacidade ANTES de uma já acumulada', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [],
    indice: [indiceDe('agenda', 'listar')],
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  assert.equal(t1.system.capacidades.find((c) => c.id === 'agenda').prioridade, 500);

  // `notas` chega DEPOIS (no fim da lista, append puro), mas com prioridade
  // declarada 10 — abaixo do default de `agenda`. É o poder deliberado de
  // "colocar coisas antes e depois", e o custo que o comentário de
  // `CapacidadeDeclarada.prioridade` nomeia: insere no MEIO do render.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [],
    indice: [indiceDe('agenda', 'listar'), indiceDe('notas', 'buscar')],
    conscientes: ['agenda/tool/listar', 'notas/tool/buscar'],
    providersCarregados: ['agenda', 'notas'],
    prioridadeDeclarada: new Map([['notas', 10]]),
  });

  const notas = t2.system.capacidades.find((c) => c.id === 'notas');
  assert.equal(notas.prioridade, 10, 'a prioridade declarada é honrada quando não colide com nenhuma já acumulada');

  const p2 = construtor.montar({ contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [] });
  const posAgenda = p2.system.indexOf('<capability name="agenda">');
  const posNotas = p2.system.indexOf('<capability name="notas">');
  assert.ok(
    posNotas < posAgenda,
    'notas (prioridade 10) entra ANTES de agenda (500) no render, mesmo tendo chegado depois no append',
  );
});

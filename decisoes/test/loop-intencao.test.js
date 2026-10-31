import test from 'node:test';
import assert from 'node:assert/strict';
import { rodarLoop } from '../src/loop/rodar-loop.js';

function jevRoteirizado(roteiro) {
  const chamadas = [];
  return { chamadas, async decidir({ state, questions }) {
    chamadas.push({ state, questions });
    const r = roteiro[chamadas.length - 1] ?? { acao: 'pronto' };
    const answers = { acao: { choice: r.acao, confidence: r.conf ?? 0.9, probabilities: { [r.acao]: r.conf ?? 0.9 } }, mais: { choice: r.mais ?? 'nao', confidence: 0.9 } };
    if (r.intencao !== undefined) answers.intencao_vale = { noul: r.intencao };
    for (const [k, v] of Object.entries(r.args ?? {})) answers[`arg_${r.acao}_${k}`] = { choice: String(v), confidence: 0.9 };
    return { answers, meta: { ms: 1 } };
  } };
}
const fn = (nome, params = [], capacidade = 'conhecimento') => ({ nome, descricao: nome, capacidade, params: async () => params });

const intencao = [
  { funcao: 'conhecimento__kb_no_ler', capacidade: 'conhecimento', effect: 'read', args: { base: 'principal' } },
  { funcao: 'conhecimento__kb_no_gravar', capacidade: 'conhecimento', effect: 'write' },
];

test('intenção aceita: leitura declarada roda de novo com o argumento declarado como opção', async () => {
  const executados = [];
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_no_ler', intencao: 0.85, args: { base: 'principal' } }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'ok', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('conhecimento__kb_no_ler', [{ nome: 'base', obrigatoria: false, opcoes: [] }])], candidatas: [] },
    cliente, executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, [['conhecimento__kb_no_ler', { base: 'principal' }]]);
  assert.deepEqual(r.intencao, { vale: true, confianca: 0.85 });
  const q = cliente.chamadas[0].questions;
  assert.ok(q.intencao_vale);
  assert.ok(q.arg_conhecimento__kb_no_ler_base.criteria.principal);
});

test('intenção recusada no passo 1: ação com argumento só da intenção não executa e volta ao modelo', async () => {
  const executados = [];
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_no_ler', intencao: 0.2, args: { base: 'principal' } }]);
  const r = await rodarLoop({
    pergunta: 'não, coloca em outro lugar', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('conhecimento__kb_no_ler', [{ nome: 'base', obrigatoria: false, opcoes: [] }])], candidatas: [] },
    cliente, executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, []);
  assert.deepEqual(r.intencao, { vale: false, confianca: 0.2 });
  assert.deepEqual(r.paraOModelo, [{ nome: 'conhecimento__kb_no_ler', capacidade: 'conhecimento' }]);
});

test('intenção recusada no passo 1: ação com argumento de outra fonte executa normalmente', async () => {
  const executados = [];
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_no_ler', intencao: 0.2, args: { base: 'outra' } }]);
  await rodarLoop({
    pergunta: 'não, use a base outra', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('conhecimento__kb_no_ler', [{ nome: 'base', obrigatoria: false, opcoes: [{ valor: 'outra', fonte: 'provedor' }] }])], candidatas: [] },
    cliente, executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, [['conhecimento__kb_no_ler', { base: 'outra' }]]);
});

test('§5.3 item 4: a intenção está no state do passo 1 (e só nele)', async () => {
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_no_ler', intencao: 0.85, mais: 'sim' }, { acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'ok', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('conhecimento__kb_no_ler'), fn('conhecimento__kb_no_listar')], candidatas: [] },
    cliente, executar: async () => ({ ok: true }),
  });
  assert.deepEqual(cliente.chamadas[0].state.intencaoAnterior, [
    { funcao: 'conhecimento__kb_no_ler', args: { base: 'principal' } },
    { funcao: 'conhecimento__kb_no_gravar' },
  ]);
  assert.ok(cliente.chamadas.length >= 2, 'pré-condição: houve um segundo passo');
  assert.equal('intencaoAnterior' in cliente.chamadas[1].state, false);
});

test('intenção recusada: marca vale:false e não pergunta de novo', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto', intencao: 0.2 }]);
  const r = await rodarLoop({
    pergunta: 'não, coloca em outro lugar', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('conhecimento__kb_no_ler')], candidatas: [] },
    cliente, executar: async () => ({ ok: true }),
  });
  assert.deepEqual(r.intencao, { vale: false, confianca: 0.2 });
});

test('leitura declarada fora do espaço vem por carregar', async () => {
  const carregadas = [];
  const cliente = jevRoteirizado([{ acao: 'pronto', intencao: 0.9 }]);
  await rodarLoop({
    pergunta: 'ok', intencaoAnterior: intencao,
    espaco: { funcoes: [fn('tarefas__task_listar', [], 'tarefas')], candidatas: [] },
    cliente, executar: async () => ({ ok: true }),
    carregar: async (cap) => { carregadas.push(cap); return [fn('conhecimento__kb_no_ler')]; },
  });
  assert.deepEqual(carregadas, ['conhecimento']);
  assert.ok(Object.keys(cliente.chamadas[0].questions.acao.criteria).includes('conhecimento__kb_no_ler'));
});

test('sem intencaoAnterior o retorno não tem intencao', async () => {
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] }, cliente: jevRoteirizado([{ acao: 'pronto' }]), executar: async () => ({}) });
  assert.equal(r.intencao, undefined);
});

const kbLer = () => fn('conhecimento__kb_ler', [{ nome: 'conteudo_id', obrigatoria: true, opcoes: [], tipo: 'conhecimento/kb_conteudo' }]);

test('id rotulado do host vira opção: kb_ler pergunta o argumento e executa com o id escolhido', async () => {
  const executados = [];
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_ler', args: { conteudo_id: 'u1' } }, { acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'abre o relatório',
    valoresRotulados: { 'conhecimento/kb_conteudo': [{ valor: 'u1', rotulo: 'Relatório Japorã' }] },
    espaco: { funcoes: [kbLer()], candidatas: [] },
    cliente, executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  const q = cliente.chamadas[0].questions;
  assert.ok(q.arg_conhecimento__kb_ler_conteudo_id, 'a pergunta do argumento existe (não caiu em soOModeloPreenche)');
  assert.deepEqual(executados, [['conhecimento__kb_ler', { conteudo_id: 'u1' }]]);
});

test('id de resultado do passo anterior (produz) vira opção no passo seguinte', async () => {
  const buscar = { ...fn('conhecimento__kb_buscar'), produz: [{ tipo: 'conhecimento/kb_conteudo', id: 'resultados[].conteudo_id', rotulo: 'resultados[].documento' }] };
  const cliente = jevRoteirizado([{ acao: 'conhecimento__kb_buscar', mais: 'sim' }, { acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'acha e abre o edital',
    espaco: { funcoes: [buscar, kbLer()], candidatas: [] },
    cliente,
    executar: async (f) => (f.nome === 'conhecimento__kb_buscar' ? { resultados: [{ conteudo_id: 'u9', documento: 'Edital' }] } : { ok: true }),
  });
  assert.ok(cliente.chamadas.length >= 2, 'pré-condição: houve um segundo passo');
  const q2 = cliente.chamadas[1].questions;
  assert.ok(q2.arg_conhecimento__kb_ler_conteudo_id?.criteria?.u9, 'a opção u9 aparece no passo 2');
});

// Revisão do conjunto, I5: resposta LONGA depois da intenção — o host marca `prioridade: false`; a leitura declarada
// segue no espaço e o Jev ainda julga `intencao_vale`, mas ela não fura a ordem/K do passo 1.
test('prioridade:false — a leitura declarada não fura a ordem do passo 1, mas intencao_vale existe', async () => {
  // Cada função tem um parâmetro com opção: a pergunta de argumento só existe para quem entrou no K do passo.
  const funcoes = ['a', 'b', 'c', 'conhecimento__kb_no_ler'].map((n) => fn(n, [{ nome: 'base', obrigatoria: false, opcoes: [{ valor: 'x' }] }]));
  const rodar = async (marca) => {
    const cliente = jevRoteirizado([{ acao: 'pronto', intencao: 0.9 }]);
    await rodarLoop({
      pergunta: 'pedido novo com assunto próprio', k: 3,
      intencaoAnterior: intencao.map((i) => ({ ...i, ...marca })),
      espaco: { funcoes, candidatas: [] }, cliente, executar: async () => ({ ok: true }),
    });
    return cliente.chamadas[0].questions;
  };
  const prioritaria = await rodar({});
  assert.ok('arg_conhecimento__kb_no_ler_base' in prioritaria, 'pré-condição: sem marca ela entra no K do passo 1');
  const semPrioridade = await rodar({ prioridade: false });
  assert.equal('arg_conhecimento__kb_no_ler_base' in semPrioridade, false, 'com prioridade:false ela fica fora do K do passo 1');
  assert.ok('arg_a_base' in semPrioridade, 'o K segue a ordem do espaço');
  assert.ok(semPrioridade.intencao_vale, 'o Jev ainda julga a intenção');
});

test('prioridade:false — leitura declarada fora do espaço ainda é carregada (a intenção continua valendo se o Jev a aceitar)', async () => {
  const carregadas = [];
  const cliente = jevRoteirizado([{ acao: 'pronto', intencao: 0.9 }]);
  const r = await rodarLoop({
    pergunta: 'pedido novo', intencaoAnterior: intencao.map((i) => ({ ...i, prioridade: false })),
    espaco: { funcoes: [fn('tarefas__task_listar', [], 'tarefas')], candidatas: [] },
    cliente, executar: async () => ({ ok: true }),
    carregar: async (cap) => { carregadas.push(cap); return [fn('conhecimento__kb_no_ler')]; },
  });
  assert.deepEqual(carregadas, ['conhecimento']);
  assert.deepEqual(r.intencao, { vale: true, confianca: 0.9 });
});

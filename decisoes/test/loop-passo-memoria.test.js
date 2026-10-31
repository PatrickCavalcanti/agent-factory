import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perguntasDoPasso } from '../src/loop/passo.js';

const funcoes = [{ nome: 'task_listar', descricao: 'Lista tarefas' }];
const base = { funcoes, candidatas: [], comArgs: [], rastro: [] };

test('sem memórias, a instrução de acao é a de antes', () => {
  const q = perguntasDoPasso(base);
  assert.ok(!/memórias/i.test(q.acao.instruction ?? q.acao.pergunta ?? JSON.stringify(q.acao)));
});

test('com memórias, a instrução manda usar a chamada indicada, só entre as opções', () => {
  const texto = JSON.stringify(perguntasDoPasso({ ...base, temMemorias: true }).acao);
  assert.match(texto, /memórias/i);
  assert.match(texto, /indica a chamada/i);
  assert.match(texto, /nunca inventa|só.*opções/i);
});

test('com memórias, as perguntas de argumento também mandam usar o valor que a memória indica, só entre as opções', () => {
  const comArgs = [{ nome: 'ler', params: [{ nome: 'area', obrigatoria: true, opcoes: [{ valor: 'sala' }, { valor: 'escritório' }] }] }];
  const base = { funcoes: [{ nome: 'ler', descricao: 'ler' }], candidatas: [], comArgs, rastro: [] };
  const com = JSON.stringify(perguntasDoPasso({ ...base, temMemorias: true }).arg_ler_area);
  const sem = JSON.stringify(perguntasDoPasso(base).arg_ler_area);
  assert.match(com, /contexto.*memória.*indica o valor/i);
  assert.match(com, /entre as opções/i);
  assert.doesNotMatch(sem, /contexto/);
});

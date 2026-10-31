import test from 'node:test';
import assert from 'node:assert/strict';
import { extrairRotulados, mesclarRotulados, comOpcoesRotuladas, TETO_POR_TIPO } from '../src/loop/valores-rotulados.js';

const produzBusca = [{ tipo: 'conhecimento/kb_conteudo', id: 'resultados[].conteudo_id', rotulo: 'resultados[].documento' }];

test('extrairRotulados: lista, objeto e JSON em string', () => {
  const r = extrairRotulados({ resultados: [{ conteudo_id: 'u1', documento: 'Relatório Japorã' }, { conteudo_id: 'u2' }] }, produzBusca);
  assert.deepEqual(r, { 'conhecimento/kb_conteudo': [{ valor: 'u1', rotulo: 'Relatório Japorã' }] });
  const nota = extrairRotulados('{"ok":true,"nota":{"id":"n1","titulo":"Reunião Aki"}}', [{ tipo: 'md-notes/nota', id: 'nota.id', rotulo: 'nota.titulo' }]);
  assert.deepEqual(nota, { 'md-notes/nota': [{ valor: 'n1', rotulo: 'Reunião Aki' }] });
  assert.deepEqual(extrairRotulados('texto que não é json', produzBusca), {});
  assert.deepEqual(extrairRotulados({ nota: { id: null, titulo: 'x' } }, [{ tipo: 't', id: 'nota.id', rotulo: 'nota.titulo' }]), {});
});

test('mesclarRotulados: mais recente primeiro, sem repetir, teto por tipo', () => {
  const antigo = { t: [{ valor: 'a', rotulo: 'A' }, { valor: 'b', rotulo: 'B' }] };
  const novo = { t: [{ valor: 'b', rotulo: 'B2' }, { valor: 'c', rotulo: 'C' }] };
  assert.deepEqual(mesclarRotulados(novo, antigo).t.map((v) => v.valor), ['b', 'c', 'a']);
  const muitos = { t: Array.from({ length: TETO_POR_TIPO + 3 }, (_, i) => ({ valor: `v${i}`, rotulo: `R${i}` })) };
  assert.equal(mesclarRotulados(muitos).t.length, TETO_POR_TIPO);
});

test('comOpcoesRotuladas: param com tipo ganha opções com descrição = rótulo', () => {
  const params = [{ nome: 'id', obrigatoria: false, opcoes: [], tipo: 'md-notes/nota' }, { nome: 'modo', obrigatoria: false, opcoes: [{ valor: 'painel' }] }];
  const r = comOpcoesRotuladas(params, { 'md-notes/nota': [{ valor: 'n1', rotulo: 'Reunião Aki' }] });
  assert.deepEqual(r[0].opcoes, [{ valor: 'n1', descricao: 'Reunião Aki', fonte: 'resultado-anterior' }]);
  assert.equal(r[1], params[1]);
});

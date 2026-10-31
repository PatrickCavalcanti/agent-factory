import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarCriteria, descricaoDaTool, RESPOND, TETO_OPCOES } from '../src/catalogo.js';

const t = { name: 'gcal_listar_eventos', power: 'google-calendar', desc: 'Lista eventos da agenda. Aceita período e filtros.' };

test('nível nome: só o power', () => { assert.equal(descricaoDaTool(t, 'nome'), 'tool do power google-calendar'); });
test('nível curta: primeira frase + power', () => { assert.equal(descricaoDaTool(t, 'curta'), 'Lista eventos da agenda. (power: google-calendar)'); });
test('nível completa: descrição inteira + power', () => { assert.match(descricaoDaTool(t, 'completa'), /Aceita período e filtros\. \(power: google-calendar\)$/); });
test('desc vazia: fallback vale em qualquer nível, não só "nome"', () => { assert.equal(descricaoDaTool({ name: 'x', power: 'p', desc: '' }, 'curta'), 'tool do power p'); });

test('criteria começa com respond_to_user e respeita o teto', () => {
  const muitas = Array.from({ length: 300 }, (_, i) => ({ name: `t${i}`, power: `p${i % 7}`, desc: `d${i}` }));
  const c = montarCriteria(muitas, { nivel: 'curta' });
  const chaves = Object.keys(c);
  assert.equal(chaves[0], RESPOND);
  assert.equal(chaves.length, TETO_OPCOES + 1);
});

test('corte pelo teto tira primeiro os powers de menor prioridade', () => {
  const tools = [...Array.from({ length: 200 }, (_, i) => ({ name: `a${i}`, power: 'ativo', desc: 'x' })), ...Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, power: 'candidato', desc: 'x' }))];
  const c = montarCriteria(tools, { nivel: 'nome', prioridadeDePower: { ativo: 0, candidato: 1 } });
  assert.ok('a199' in c);
  assert.ok(!('c99' in c));
  assert.equal(Object.keys(c).length, TETO_OPCOES + 1);
});

test('nomes duplicados: o primeiro vence', () => {
  const c = montarCriteria([{ name: 'x', power: 'p', desc: '1' }, { name: 'x', power: 'q', desc: '2' }], { nivel: 'nome' });
  assert.equal(c.x, 'tool do power p');
});

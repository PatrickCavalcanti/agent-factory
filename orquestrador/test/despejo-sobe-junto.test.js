import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refsQueSobemJunto } from '../src/despejo/sobe-junto.js';

// Spec 2026-10-29 §4.2 ("sobe junto"): fixa e acompanha sobem com a capacidade que JÁ está no system.
const tool = (name, extra = {}) => ({ name, ...extra });
const CAPS = [
  { id: 'okapp', piso: false, tools: [tool('obter', { fixa: true }), tool('salvar', { fixa: false, acompanha: ['validar'] }), tool('validar', { fixa: false, acompanha: ['limpar'] }), tool('limpar', { fixa: false })] },
  { id: 'gcal', piso: false, tools: [tool('ver', { fixa: true, acompanha: ['status'] }), tool('status', { fixa: false }), tool('criar', { fixa: false, view: { exibir: 'auto' } })] },
  { id: 'memoria', tools: [tool('ver'), tool('gravar', { acompanha: ['ver'] })] }, // piso (default)
];

test('fixa: capacidade no system leva as fixas dela; capacidade que não está, não', () => {
  const r = refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['okapp']) });
  assert.deepEqual(r.fixas, ['okapp/tool/obter']);
  assert.deepEqual(r.refs, ['okapp/tool/obter']);
  assert.deepEqual(refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set() }).refs, [], 'sem capacidade no system, nada sobe (mutação: ignorar noSystem)');
});

test('acompanha da fixa sobe junto; acompanha de função usada sobe junto; não é transitivo', () => {
  const daFixa = refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['gcal']) });
  assert.deepEqual(daFixa.refs, ['gcal/tool/ver', 'gcal/tool/status']);
  const daUsada = refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['okapp']), usadas: ['okapp/tool/salvar'] });
  assert.deepEqual(daUsada.acompanhantes, ['okapp/tool/validar']);
  assert.ok(!daUsada.refs.includes('okapp/tool/limpar'), 'a acompanhante da acompanhante não sobe');
  // Quem usa `validar` de fato leva a acompanhante dela: o uso é o que promove.
  assert.deepEqual(refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['okapp']), usadas: ['okapp/tool/validar'] }).acompanhantes, ['okapp/tool/limpar']);
});

test('só a lista `acompanha`: função com view.exibir auto não sobe por conta própria', () => {
  const r = refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['gcal']) });
  assert.ok(!r.refs.includes('gcal/tool/criar'));
});

test('uso de função de capacidade que não está no system não faz subir nada; piso fica de fora', () => {
  // okapp não está no system: o uso de okapp/salvar não traz `validar`; só vem o que é de gcal (fixa + acompanhante da fixa).
  assert.deepEqual(refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['gcal']), usadas: ['okapp/tool/salvar'] }).refs, ['gcal/tool/ver', 'gcal/tool/status']);
  assert.deepEqual(refsQueSobemJunto({ capacidades: CAPS, noSystem: new Set(['memoria']), usadas: ['memoria/tool/gravar'] }).refs, [], 'o piso já tem tudo no system');
});

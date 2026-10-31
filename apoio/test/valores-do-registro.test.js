import test from 'node:test';
import assert from 'node:assert/strict';
import { valoresDoRegistro, produtoresDasCapacidades, JANELA_TURNOS } from '../src/valores-do-registro.js';

const produtores = new Map([['md-notes__note_escrever', [{ tipo: 'md-notes/nota', id: 'nota.id', rotulo: 'nota.titulo' }]]]);

test('lê os resultados das interações do assistente, mais recente primeiro', () => {
  const mensagens = [
    { role: 'user', content: 'cria a nota' }, { role: 'assistant', content: 'ok', interactionId: 'i1' },
    { role: 'user', content: 'outra' }, { role: 'assistant', content: 'ok', interactionId: 'i2' },
  ];
  const chamadas = {
    i1: [{ name: 'md-notes__note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"n1","titulo":"Antiga"}}' } }],
    i2: [{ name: 'md-notes__note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"n2","titulo":"Nova"}}' } }],
  };
  const { valores: r, descartados } = valoresDoRegistro({ mensagens, lerChamadas: (id) => chamadas[id] ?? [], produtores });
  assert.deepEqual(r['md-notes/nota'].map((v) => v.valor), ['n2', 'n1']);
  assert.equal(descartados, 0);
});

test('ignora erro, JSON inválido, função sem produz e respeita a janela', () => {
  const mensagens = Array.from({ length: JANELA_TURNOS + 2 }, (_, i) => ({ role: 'assistant', content: 'x', interactionId: `i${i}` }));
  const lerChamadas = (id) => (id === 'i0' ? [{ name: 'md-notes__note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"velho","titulo":"V"}}' } }]
    : [{ name: 'md-notes__note_escrever', status: 'erro', result: null }, { name: 'outra', status: 'ok', result: { texto: '{}' } }, { name: 'md-notes__note_escrever', status: 'ok', result: { texto: '{quebrado' } }]);
  const { valores: r, descartados } = valoresDoRegistro({ mensagens, lerChamadas, produtores });
  assert.equal(r['md-notes/nota'], undefined, 'i0 está fora da janela; o resto não rende');
  assert.equal(descartados, JANELA_TURNOS, 'M7: o JSON quebrado de cada interação da janela é contado');
});

test('chamada com status de erro do registro real ("erro") não rende, mesmo com resultado válido', () => {
  const mensagens = [{ role: 'assistant', content: 'x', interactionId: 'i1' }];
  const lerChamadas = () => [{ name: 'md-notes__note_escrever', status: 'erro', result: { texto: '{"nota":{"id":"n9","titulo":"X"}}' } }];
  assert.deepEqual(valoresDoRegistro({ mensagens, lerChamadas, produtores }), { valores: {}, descartados: 0 });
});

test('leitor que lança não derruba o turno; sem produtores nem lê o registro', () => {
  const mensagens = [{ role: 'assistant', content: 'x', interactionId: 'i1' }];
  assert.deepEqual(valoresDoRegistro({ mensagens, lerChamadas: () => { throw new Error('disco'); }, produtores }), { valores: {}, descartados: 0 });
  let leu = false;
  assert.deepEqual(valoresDoRegistro({ mensagens, lerChamadas: () => { leu = true; return []; }, produtores: new Map() }), { valores: {}, descartados: 0 });
  assert.equal(leu, false);
});

test('produtoresDasCapacidades: nome exposto honra prefixarTools e ignora tool sem produz', () => {
  const produz = [{ tipo: 't', id: 'a', rotulo: 'b' }];
  const mapa = produtoresDasCapacidades([
    { id: 'md-notes', tools: [{ name: 'note_escrever', produz }, { name: 'note_ler' }] },
    { id: 'tarefas', prefixarTools: false, tools: [{ name: 'tarefa_criar', produz }] },
  ]);
  // Chaves: nome exposto e ref `cap/tool/fn` (sem `aliasCru`, sem sinônimo cru).
  assert.deepEqual([...mapa.keys()].sort(), ['md-notes/tool/note_escrever', 'md-notes__note_escrever', 'tarefas/tool/tarefa_criar', 'tarefa_criar'].sort());
});

// Revisão do conjunto, I3: a chamada registrada pelo nome cru ou pela ref (`call_capability`) também rende ids.
test('produtoresDasCapacidades: nome cru (aliasCru) e ref cap/tool/fn apontam para o mesmo produz; cru ambíguo não entra', () => {
  const produz = [{ tipo: 'md-notes/nota', id: 'nota.id', rotulo: 'nota.titulo' }];
  const caps = [
    { id: 'md-notes', aliasCru: true, tools: [{ name: 'note_escrever', produz }] },
    { id: 'a', aliasCru: true, tools: [{ name: 'ler', produz }] },
    { id: 'b', aliasCru: true, tools: [{ name: 'ler', produz }] },
  ];
  const mapa = produtoresDasCapacidades(caps);
  assert.equal(mapa.get('note_escrever'), produz);
  assert.equal(mapa.get('md-notes/tool/note_escrever'), produz);
  assert.equal(mapa.get('md-notes__note_escrever'), produz);
  assert.equal(mapa.has('ler'), false);
  const mensagens = [{ role: 'assistant', content: 'ok', interactionId: 'i1' }];
  const chamadas = [
    { name: 'note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"n1","titulo":"Crua"}}' } },
    { name: 'md-notes/tool/note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"n2","titulo":"Ref"}}' } },
  ];
  const { valores } = valoresDoRegistro({ mensagens, lerChamadas: () => chamadas, produtores: mapa });
  assert.deepEqual(valores['md-notes/nota'].map((v) => v.valor).sort(), ['n1', 'n2']);
});

// Revisão do conjunto, M7: texto que não faz parse é pulado, mas contado.
test('valoresDoRegistro: resultado de função com produz que não faz parse é contado em descartados', () => {
  const mensagens = [{ role: 'assistant', content: 'x', interactionId: 'i1' }];
  const lerChamadas = () => [
    { name: 'md-notes__note_escrever', status: 'ok', result: { texto: 'texto solto, não é JSON' } },
    { name: 'md-notes__note_escrever', status: 'ok', result: { texto: '{"nota":{"id":"n1","titulo":"Boa"}}' } },
    { name: 'outra', status: 'ok', result: { texto: 'também solto, mas a função não tem produz' } },
  ];
  const r = valoresDoRegistro({ mensagens, lerChamadas, produtores });
  assert.equal(r.descartados, 1);
  assert.deepEqual(r.valores['md-notes/nota'].map((v) => v.valor), ['n1']);
});

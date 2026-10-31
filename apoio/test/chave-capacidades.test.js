// I2 (revisão do conjunto): a chave de recriação do orquestrador da sessão inclui a versão do manifesto
// dos powers que sintetizam o seu (`okapp@<versão>`). Pura, sem banco.
//   node --test --test-force-exit packages/executor/test/fabrica-chave-capacidades.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chaveDasCapacidades } from '../src/chaveDasCapacidades.js';

test('sem hook de versão, a chave é só os ids ordenados (como antes)', () => {
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({})), 'a,b');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => undefined), 'a,b');
});

test('a versão do manifesto do okapp entra na chave e a faz mudar com os mesmos ids', () => {
  let versao = 1;
  const reg = (id) => (id === 'okapp' ? { versaoDoManifesto: () => versao } : { versaoDoManifesto: null });
  const k1 = chaveDasCapacidades(['okapp', 'memoria'], reg);
  assert.equal(k1, 'memoria,okapp,okapp@1');
  assert.equal(chaveDasCapacidades(['okapp', 'memoria'], reg), k1); // estável sem recálculo
  versao = 2;
  assert.notEqual(chaveDasCapacidades(['okapp', 'memoria'], reg), k1);
});

test('hook que lança não derruba o turno', () => {
  assert.equal(chaveDasCapacidades(['okapp'], () => ({ versaoDoManifesto: () => { throw new Error('x'); } })), 'okapp');
});

test('extras.mcp: a versão do registro MCP entra na chave (mcp@N) e a faz mudar; ausente não muda nada', () => {
  assert.equal(chaveDasCapacidades(['a'], () => ({})), 'a');
  assert.equal(chaveDasCapacidades(['a'], () => ({}), {}), 'a');
  assert.equal(chaveDasCapacidades(['a'], () => ({}), { mcp: undefined }), 'a');
  const k1 = chaveDasCapacidades(['mcp-crm', 'a'], () => ({}), { mcp: 1 });
  assert.equal(k1, 'a,mcp-crm,mcp@1');
  assert.equal(chaveDasCapacidades(['mcp-crm', 'a'], () => ({}), { mcp: 1 }), k1);
  assert.notEqual(chaveDasCapacidades(['mcp-crm', 'a'], () => ({}), { mcp: 2 }), k1);
  // convive com a versão do okapp
  const reg = (id) => (id === 'okapp' ? { versaoDoManifesto: () => 3 } : undefined);
  assert.equal(chaveDasCapacidades(['okapp'], reg, { mcp: 0 }), 'okapp,mcp@0,okapp@3');
});

test('extras.modo entra como modo@<id>; ausente/null não muda a chave', () => {
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { modo: null }), 'a,b');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { modo: 'marketing' }), 'a,b,modo@marketing');
  assert.notEqual(
    chaveDasCapacidades(['a'], () => ({}), { modo: 'marketing' }),
    chaveDasCapacidades(['a'], () => ({}), { modo: 'vendas' }),
  );
});

// Correção 3 (E1): habilidade nova/gravada no meio da conversa não muda ids nem okapp@versão; a versão do
// catálogo de habilidades é o que recria o orquestrador da sessão no turno seguinte.
test('extras.habilidades entra como habilidades@<versão>; ausente/null não muda a chave, valores diferentes mudam', () => {
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({})), 'a,b');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: null }), 'a,b');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: undefined }), 'a,b');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: '' }), 'a,b');
  const k1 = chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: 'aaaaaaaaaaaa' });
  assert.equal(k1, 'a,b,habilidades@aaaaaaaaaaaa');
  assert.equal(chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: 'aaaaaaaaaaaa' }), k1);
  assert.notEqual(chaveDasCapacidades(['b', 'a'], () => ({}), { habilidades: 'bbbbbbbbbbbb' }), k1);
  // convive com as outras versões
  const reg = (id) => (id === 'okapp' ? { versaoDoManifesto: () => 3 } : undefined);
  assert.equal(
    chaveDasCapacidades(['okapp'], reg, { mcp: 0, modo: 'marketing', habilidades: 'aaaaaaaaaaaa' }),
    'okapp,habilidades@aaaaaaaaaaaa,mcp@0,modo@marketing,okapp@3',
  );
});

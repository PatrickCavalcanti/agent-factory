// Spec 2026-10-14 §7.3: a costura executor → orquestrador → ponte → discover REAL do kairos.
// Um manager falso que aceita `trivial` não prova nada — aqui o kairos instalado (0.839+) decide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManager } from '@okds/kairos/resolve';
import { criarPonteDoTurno } from '../src/pista-contexto.js';

async function managerReal() {
  const m = createManager({ embedder: null, can: () => true });
  m.registry.registerProvider(
    { id: 'conhecimento', name: 'conhecimento', description: 'base de conhecimento nós documentos estrutura', kind: 'native' },
    {
      tools: [{
        ref: 'conhecimento/tool/kb_no_gravar', kind: 'tool', providerId: 'conhecimento', key: 'kb_no_gravar',
        description: 'cria nó', indexLine: 'kb_no_gravar — cria nó', contract: async () => '## kb_no_gravar',
        inputSchema: { type: 'object' }, effect: 'write', invoke: {}, read: async () => '',
      }],
    },
  );
  await m.reindex();
  return m;
}
const estado = () => ({ loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] });

test('kairos real: "ok" com trivial:false pela ponte não volta unchanged', async () => {
  const { manager } = criarPonteDoTurno({ manager: await managerReal(), can: () => true, trivial: false, hints: ['Aprova essa estrutura de nós?'] });
  const out = await manager.discover({ text: 'ok', ctx: {}, state: estado(), limits: { tools: 3 } });
  assert.notEqual(out.unchanged, true);
});

test('kairos real: "ok" sem trivial continua unchanged', async () => {
  const { manager } = criarPonteDoTurno({ manager: await managerReal(), can: () => true });
  const out = await manager.discover({ text: 'ok', ctx: {}, state: estado(), limits: { tools: 3 } });
  assert.equal(out.unchanged, true);
});

test('kairos real: trivial:true vence texto longo', async () => {
  const { manager } = criarPonteDoTurno({ manager: await managerReal(), can: () => true, trivial: true });
  const out = await manager.discover({ text: 'cria um nó novo na base de conhecimento', ctx: {}, state: estado(), limits: { tools: 3 } });
  assert.equal(out.unchanged, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { conferirTetoDoSystem, validarTetoDoSystem } from '../src/teto-do-system.js';

test('abaixo do teto: nada', () => {
  assert.equal(conferirTetoDoSystem('x'.repeat(10), { chars: 100 }), null);
  assert.equal(conferirTetoDoSystem('x'.repeat(100), { chars: 100 }), null, 'no teto exato ainda cabe');
});

test('acima do teto: aviso com tamanho e teto', () => {
  assert.deepEqual(conferirTetoDoSystem('x'.repeat(150), { chars: 100 }), {
    ref: 'teto-do-system', error: 'system com 150 caracteres acima do teto de 100',
  });
});

test('teto ausente ou inválido não confere nada', () => {
  assert.equal(conferirTetoDoSystem('x'.repeat(150), undefined), null);
  assert.equal(conferirTetoDoSystem('x'.repeat(150), {}), null);
  assert.equal(conferirTetoDoSystem('x'.repeat(150), { chars: 0 }), null);
  assert.equal(conferirTetoDoSystem('x'.repeat(150), { chars: Number.NaN }), null);
});

test('validarTetoDoSystem: ausente passa; presente exige `chars` inteiro > 0', () => {
  assert.deepEqual(validarTetoDoSystem(undefined), []);
  assert.deepEqual(validarTetoDoSystem(null), []);
  assert.deepEqual(validarTetoDoSystem({ chars: 1 }), []);
  assert.deepEqual(validarTetoDoSystem({ chars: 120000 }), []);
  for (const ruim of [{}, { chars: 0 }, { chars: -5 }, { chars: 1.5 }, { chars: '100' }, { chars: Number.NaN }, { chars: Infinity }, 100, 'x']) {
    const erros = validarTetoDoSystem(ruim);
    assert.equal(erros.length, 1, JSON.stringify(ruim));
    assert.match(erros[0], /tetoDoSystem.*chars.*inteiro maior que 0/);
  }
});

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };

function fabrica(extra = {}) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de teste.</identidade>' }],
    capacidades: [{
      id: 'notas', descricao: 'Notas.', piso: true,
      tools: [{ name: 'listar', description: 'Lista.', schema: z.object({}), handler: async () => ({}) }],
    }],
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: () => ({
      name: 'fake', model: 'fake-1',
      capabilities: {
        streaming: false, usage: false, cancellation: false, structuredOutput: true,
        nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
      },
      async generate() {
        return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
      },
    }),
    decorarTool: (nome, definicao) => definicao,
    ...extra,
  });
}

test('acima do teto: `renderErrors` e `aoEvento` avisam e o turno completa (aviso, não recusa)', async () => {
  const eventos = [];
  const infos = [];
  const turno = await fabrica({
    tetoDoSystem: { chars: 10 },
    aoEvento: (e) => eventos.push(e),
    aoMontar: (i) => infos.push(i),
  }).executarTurno({ texto: 'qualquer coisa para fazer hoje', estado: ESTADO_INICIAL });
  assert.equal(turno.resultado.type, 'completed');
  const tamanho = turno.payload.system.length;
  const erro = turno.renderErrors.find((e) => e.ref === 'teto-do-system');
  assert.ok(erro, JSON.stringify(turno.renderErrors));
  assert.equal(erro.error, `system com ${tamanho} caracteres acima do teto de 10`);
  const evento = eventos.find((e) => e.tipo === 'fabrica:teto-do-system');
  assert.deepEqual(evento, { tipo: 'fabrica:teto-do-system', turno: 0, tamanho, teto: 10 });
  assert.ok(infos[0].renderErrors.some((e) => e.ref === 'teto-do-system'), 'o aoMontar já vê o aviso');
});

test('abaixo do teto, ou sem `tetoDoSystem`: nenhum aviso', async () => {
  const eventos = [];
  const a = await fabrica({ tetoDoSystem: { chars: 10_000_000 }, aoEvento: (e) => eventos.push(e) })
    .executarTurno({ texto: 'qualquer coisa para fazer hoje', estado: ESTADO_INICIAL });
  const b = await fabrica().executarTurno({ texto: 'qualquer coisa para fazer hoje', estado: ESTADO_INICIAL });
  for (const t of [a, b]) assert.ok(!t.renderErrors.some((e) => e.ref === 'teto-do-system'));
  assert.ok(!eventos.some((e) => e.tipo === 'fabrica:teto-do-system'));
});

test('`aoEvento` que lança não derruba o turno nem some com o aviso em `renderErrors`', async () => {
  const turno = await fabrica({ tetoDoSystem: { chars: 10 }, aoEvento: () => { throw new Error('handler quebrado'); } })
    .executarTurno({ texto: 'qualquer coisa para fazer hoje', estado: ESTADO_INICIAL });
  assert.equal(turno.resultado.type, 'completed');
  assert.ok(turno.renderErrors.some((e) => e.ref === 'teto-do-system'));
});

test('`tetoDoSystem` inválido recusa a montagem (antes desligava o teto em silêncio)', async () => {
  for (const ruim of [{}, { chars: 0 }, { chars: '100000' }, { chars: 1.5 }]) {
    await assert.rejects(
      () => fabrica({ tetoDoSystem: ruim }).executarTurno({ texto: 'qualquer coisa para fazer hoje', estado: ESTADO_INICIAL }),
      /tetoDoSystem inválido/,
      JSON.stringify(ruim),
    );
  }
});

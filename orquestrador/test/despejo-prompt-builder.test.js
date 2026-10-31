import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConstrutorDePrompt, systemVazio, classificar, refDaTool } from '../src/prompt-builder.js';

const config = {
  base: () => [{ nome: 'identidade', conteudo: '<identidade>Sou um agente.</identidade>' }],
};

test('classificar e refDaTool exportados', () => {
  assert.equal(classificar('a/tool/b'), 'contrato');
  assert.equal(refDaTool('a/tool/b#index'), 'a/tool/b');
});

test('montar: extrasDoTurno entram depois dos efêmeros e antes do pedido; renderizarSystem = system do montar', () => {
  const c = criarConstrutorDePrompt(config);
  const p = c.montar({
    contexto: {},
    texto: 'PEDIDO',
    system: systemVazio(),
    efemeros: [],
    historico: [],
    extrasDoTurno: [{ nome: 'manuais_do_turno', conteudo: '<manuais_do_turno>X</manuais_do_turno>' }],
  });
  assert.ok(p.mensagemDoTurno.indexOf('<manuais_do_turno>X') < p.mensagemDoTurno.indexOf('PEDIDO'));
  assert.ok(p.secoes.some((s) => s.nome === 'manuais_do_turno' && s.destino === 'turno'));
  assert.equal(c.renderizarSystem({}, systemVazio()), p.system);
});

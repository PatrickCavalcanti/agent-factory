import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarEstado } from '../src/estado.js';

test('forma mínima', () => {
  const s = montarEstado({ pedido: 'oi' });
  assert.equal(s.pedido_do_usuario, 'oi');
  assert.deepEqual(s.conversa_anterior, []);
  assert.deepEqual(s.acoes_ja_executadas, []);
});

test('conversa anterior: só user/assistant, últimas 6, clip 300', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(500) + i }));
  const s = montarEstado({ pedido: 'p', mensagens: [...msgs, { role: 'user', content: 'p' }] });
  assert.equal(s.conversa_anterior.length, 6);
  assert.ok(s.conversa_anterior[0].texto.length <= 301);
  assert.equal(s.conversa_anterior[5].quem, 'assistente');
});

test('a última mensagem do usuário (o pedido) não entra na conversa anterior', () => {
  const s = montarEstado({ pedido: 'p', mensagens: [{ role: 'user', content: 'a' }, { role: 'user', content: 'p' }] });
  assert.deepEqual(s.conversa_anterior.map((m) => m.texto), ['a']);
});

test('teto de chars corta na ordem: blocos dos powers, conversa, resultados', () => {
  const grande = 'y'.repeat(5000);
  const s = montarEstado({ pedido: 'p', blocosDosPowers: { a: grande, b: grande }, mensagens: [{ role: 'user', content: grande }, { role: 'user', content: 'p' }], acoesDoTurno: [{ passo: 1, tool: 't', args: '{}', status: 'completed', resultado: grande }] }, { tetoChars: 6000 });
  const total = JSON.stringify(s).length;
  assert.ok(total <= 6000, `estado com ${total} chars`);
  assert.ok(s._cortes.length > 0);
});

test('regras e memória de trabalho entram nomeadas', () => {
  const s = montarEstado({ pedido: 'p', regrasDosPowers: { okapp: 'R' }, memoriaDeTrabalho: ['m1'] });
  assert.equal(s.regras_dos_powers_ativos.okapp, 'R');
  assert.deepEqual(s.memoria_de_trabalho, ['m1']);
});

test('regra de power grande (sem blocos de power) recebe clip e entra no corte por teto', () => {
  const grande = 'r'.repeat(10000);
  const s = montarEstado({ pedido: 'p', regrasDosPowers: { p: grande } }, { tetoChars: 600 });
  const total = JSON.stringify(s).length;
  assert.ok(total <= 600, `estado com ${total} chars`);
  assert.ok(s._cortes.includes('regras_dos_powers_ativos'), `_cortes foi ${JSON.stringify(s._cortes)}`);
});

test('teto apertado sem blocos de power nem conversa: quem corta é o corte de resultados', () => {
  const grande = 'z'.repeat(20000);
  const s = montarEstado({ pedido: 'p', mensagens: [{ role: 'user', content: 'p' }], acoesDoTurno: [{ passo: 1, tool: 't', args: '{}', status: 'completed', resultado: grande }] }, { tetoChars: 700 });
  const total = JSON.stringify(s).length;
  assert.ok(total <= 700, `estado com ${total} chars`);
  assert.ok(s._cortes.includes('acoes_ja_executadas'), `_cortes foi ${JSON.stringify(s._cortes)}`);
});

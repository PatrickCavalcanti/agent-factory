// packages/executor/test/fabrica-conversa.test.js
//
// `conversaDoHistorico` (`packages/executor/src/orchestration/fabrica/conversa.js`, 2026-09-23):
// helper único usado pelo loop e pelos refinadores do chat (`turno.js`) para extrair, do
// histórico BRUTO (`ctx.processedMessages`, formato real — ver `prepareIncomingAttachments.js`:
// `{ role, content }`, `content` já é o texto que o usuário viu, sem envelope nem bloco de
// operações), a conversa que vai no `state` do Jev.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversaDoHistorico, LIMITES_CONVERSA_PADRAO } from '../src/conversa.js';

test('formato: extrai { papel, texto } de user/assistant, mais antiga primeiro, preservando a ordem', () => {
  const mensagens = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'Oi, Patrick.' },
    { role: 'user', content: 'que dia é hoje?' },
    { role: 'assistant', content: '(data de hoje)' },
  ];
  assert.deepEqual(conversaDoHistorico(mensagens), [
    { papel: 'usuario', texto: 'oi' },
    { papel: 'assistente', texto: 'Oi, Patrick.' },
    { papel: 'usuario', texto: 'que dia é hoje?' },
    { papel: 'assistente', texto: '(data de hoje)' },
  ]);
});

test('descarta mensagens sem role user/assistant (tool call/resultado) e sem texto', () => {
  const mensagens = [
    { role: 'user', content: 'oi' },
    { role: 'tool', content: '{"resultado":"..."}' },
    { role: 'assistant', content: '' },
    { role: 'assistant' },
    { role: 'assistant', content: '   ' },
    { role: 'assistant', content: 'ok' },
  ];
  assert.deepEqual(conversaDoHistorico(mensagens), [
    { papel: 'usuario', texto: 'oi' },
    { papel: 'assistente', texto: 'ok' },
  ]);
});

test('extração do texto do assistente: `content` (formato real guardado) tem prioridade sobre `_fala.text`', () => {
  const mensagens = [
    { role: 'assistant', content: 'o que foi mostrado na tela', _fala: { text: 'o que foi falado' } },
  ];
  assert.deepEqual(conversaDoHistorico(mensagens), [{ papel: 'assistente', texto: 'o que foi mostrado na tela' }]);
});

test('extração do texto do assistente: sem `content`, cai para `_fala.text` (fallback defensivo)', () => {
  const mensagens = [{ role: 'assistant', _fala: { text: 'só foi falado' } }];
  assert.deepEqual(conversaDoHistorico(mensagens), [{ papel: 'assistente', texto: 'só foi falado' }]);
});

test('corte por quantidade: fica só com as maxMensagens MAIS RECENTES', () => {
  const mensagens = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` }));
  const r = conversaDoHistorico(mensagens, { maxMensagens: 4, maxChars: 10000 });
  assert.deepEqual(r.map((it) => it.texto), ['msg6', 'msg7', 'msg8', 'msg9']);
});

test('corte por tamanho: remove do INÍCIO (mais antiga) até caber em maxChars', () => {
  const mensagens = [
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'c'.repeat(100) },
  ];
  const r = conversaDoHistorico(mensagens, { maxMensagens: 10, maxChars: 150 });
  assert.deepEqual(r.map((it) => it.texto[0]), ['c']);
});

test('sem mensagens (sessão nova) devolve array vazio, nunca lança', () => {
  assert.deepEqual(conversaDoHistorico([]), []);
  assert.deepEqual(conversaDoHistorico(null), []);
  assert.deepEqual(conversaDoHistorico(undefined), []);
});

test('LIMITES_CONVERSA_PADRAO: defaults sensatos (6 mensagens / 3000 chars) usados quando nenhum limite é passado', () => {
  assert.deepEqual(LIMITES_CONVERSA_PADRAO, { maxMensagens: 6, maxChars: 3000 });
  const mensagens = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` }));
  assert.equal(conversaDoHistorico(mensagens).length, 6);
});

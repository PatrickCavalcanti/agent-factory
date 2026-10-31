import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entregaDoLoop } from '../src/loop-do-turno.js';

test('entregaDoLoop com itens autorizados (sucesso, falha confirmada, efeitoDesconhecido) e não autorizado', () => {
  const autorizadas = new Map([
    ['autorizada_a1', { toolName: 'mcp-ha__turnon', args: { entity_id: 'light.sala' } }],
    ['autorizada_a2', { toolName: 'mcp-ha__turnoff', args: { entity_id: 'light.quarto' } }],
    ['autorizada_a3', { toolName: 'mcp-ha__toggle', args: { entity_id: 'light.garagem' } }],
  ]);

  const rastro = [
    { passo: 1, fn: 'autorizada_a1', args: {}, confianca: 0.95, resultado: '{"ok":true}' },
    { passo: 2, fn: 'autorizada_a2', args: {}, confianca: 0.95, erro: 'conexão recusada' },
    { passo: 3, fn: 'autorizada_a3', args: {}, confianca: 0.95, erro: 'prazo da execução', efeitoDesconhecido: true },
    { passo: 4, fn: 'task_listar', args: { status: 'open' }, confianca: 0.9, resultado: '[]' },
  ];

  const { bloco, destinos } = entregaDoLoop({ estado: 'pronto', rastro }, { autorizadas });

  // 3 textos distintos para autorizadas, todos com [AÇÃO AUTORIZADA]
  assert.match(bloco, /- \[AÇÃO AUTORIZADA\] mcp-ha__turnon \{"entity_id":"light\.sala"\} — confiança 0\.95/);
  assert.match(bloco, /- \[AÇÃO AUTORIZADA\] mcp-ha__turnoff \{"entity_id":"light\.quarto"\} — FALHOU \(confirmado\): conexão recusada/);
  assert.match(bloco, /- \[AÇÃO AUTORIZADA\] mcp-ha__toggle \{"entity_id":"light\.garagem"\} — EFEITO DESCONHECIDO: a execução foi disparada e não confirmou dentro do prazo; ela PODE ter sido executada\. NÃO repita esta chamada; confira o estado antes \(uma consulta de leitura\) ou pergunte ao dono\./);

  // o texto "EFEITO DESCONHECIDO" contém "NÃO repita"
  assert.match(bloco, /EFEITO DESCONHECIDO.*NÃO repita/);

  // item não autorizado não leva o prefixo [AÇÃO AUTORIZADA]
  assert.match(bloco, /- task_listar \{"status":"open"\} — confiança 0\.90/);
  assert.doesNotMatch(bloco, /\[AÇÃO AUTORIZADA\] task_listar/);

  // destinos conta erros (1 falha confirmada + 1 efeitoDesconhecido = 2)
  assert.equal(destinos.erro, 2);
});

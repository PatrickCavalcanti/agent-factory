// Leituras do MODELO entram em `consultasAnteriores` (dono, 10/10), filtradas pelo effect e com o nome exposto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultasDoTurnoDe, mapaDeFuncoesDoTurno } from '../src/consultas-anteriores.js';

const CAPS = [
  { id: 'gestao-documentos', prefixarTools: true, aliasCru: true, tools: [{ name: 'arquivo_buscar', effect: 'read' }, { name: 'arquivo_salvar_anexo', effect: 'write' }] },
  { id: 'tarefas', prefixarTools: true, aliasCru: true, tools: [{ name: 'task_listar', effect: 'read' }] },
  { id: 'attachments', prefixarTools: false, tools: [{ name: 'attachment_read', effect: 'read' }] },
];

test('leituras do modelo entram pelo nome exposto (das três formas); escrita, meta-tool e desconhecida ficam fora; Jev entra como sempre', () => {
  const ops = [
    { nome: 'gestao-documentos__arquivo_buscar', args: { query: 'desenho infantil zumbi' }, ok: true },
    { nome: 'task_listar', args: { status: 'pending' } }, // sinônimo cru
    { nome: 'gestao-documentos/tool/arquivo_buscar', args: { query: 'outro' }, ok: false }, // via call_capability
    { nome: 'gestao-documentos__arquivo_salvar_anexo', args: { pasta: 'x' } }, // escrita
    { nome: 'load_capability', args: { refs: ['x'] } }, // meta-tool
    { nome: 'inexistente', args: {} },
    { nome: 'attachment_read', args: { arquivo: 'externo:anexos/a' } }, // cru, sem prefixo
    { nome: 'google-calendar__gcal_listar_eventos', args: { periodo: 'amanha' }, origem: 'jev' },
  ];
  assert.deepEqual(consultasDoTurnoDe(ops, mapaDeFuncoesDoTurno(CAPS)), [
    { funcao: 'gestao-documentos__arquivo_buscar', args: { query: 'desenho infantil zumbi' }, ok: true },
    { funcao: 'tarefas__task_listar', args: { status: 'pending' }, ok: true },
    { funcao: 'gestao-documentos__arquivo_buscar', args: { query: 'outro' }, ok: false },
    { funcao: 'attachment_read', args: { arquivo: 'externo:anexos/a' }, ok: true },
    { funcao: 'google-calendar__gcal_listar_eventos', args: { periodo: 'amanha' }, ok: true },
  ]);
});

test('sinônimo cru repetido entre capacidades é ambíguo e não resolve', () => {
  const mapa = mapaDeFuncoesDoTurno([
    { id: 'a', aliasCru: true, tools: [{ name: 'ler', effect: 'read' }] },
    { id: 'b', aliasCru: true, tools: [{ name: 'ler', effect: 'read' }] },
  ]);
  assert.equal(mapa.get('ler'), undefined);
  assert.equal(mapa.get('a__ler')?.exposto, 'a__ler');
});

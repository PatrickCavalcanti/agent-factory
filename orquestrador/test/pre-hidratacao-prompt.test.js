import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConstrutorDePrompt, systemVazio } from '../src/prompt-builder.js';

const construtor = criarConstrutorDePrompt({ base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }] });
const acumulado = construtor.acumular({ anterior: systemVazio(), system: [], turno: [], indice: [], conscientes: [], providersCarregados: [] });

test('preHidratacao entra na mensagem do turno, logo antes do texto do usuário', () => {
  const p = construtor.montar({
    contexto: {}, texto: 'o que tenho amanhã?', system: acumulado.system, efemeros: [], historico: [],
    preHidratacao: '<pre_hidratacao>x</pre_hidratacao>',
  });
  const usr = p.mensagens.at(-1);
  assert.equal(usr.role, 'user');
  assert.ok(usr.content.endsWith('<pre_hidratacao>x</pre_hidratacao>\n\no que tenho amanhã?'));
  assert.ok(p.secoes.some((s) => s.nome === 'pre_hidratacao' && s.destino === 'turno'));
});

test('sem preHidratacao a mensagem não muda', () => {
  const p = construtor.montar({ contexto: {}, texto: 'oi', system: acumulado.system, efemeros: [], historico: [] });
  assert.equal(p.mensagens.at(-1).content, 'oi');
  assert.ok(!p.secoes.some((s) => s.nome === 'pre_hidratacao'));
});

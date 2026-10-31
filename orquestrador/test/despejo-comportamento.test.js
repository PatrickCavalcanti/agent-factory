import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  separarPreparadas, conteudoDaHabilidadeSugerida, ofertaDoTurno, saidaDoComportamento, notaDeNaoFixadas, motivoCurtoDeFalha,
} from '../src/despejo/comportamento.js';

test('notaDeNaoFixadas: um bloco <nao_fixadas>, uma linha por habilidade, com nome, id e motivo', () => {
  const nota = notaDeNaoFixadas([{ id: 'planejar-semana', nome: 'planejar-semana', motivo: 'memória de trabalho cheia' }]);
  assert.equal(
    nota,
    '<nao_fixadas>\nplanejar-semana — você declarou esta habilidade, mas ela não entrou no contexto fixo '
    + '(memória de trabalho cheia). Ela vale neste pedido. Declarar de novo tenta fixar outra vez; enquanto o motivo continuar (ex.: memória de trabalho cheia), pode falhar de novo.\n</nao_fixadas>',
  );
});

test('notaDeNaoFixadas: sem nome usa só o id; repetido entra uma vez; vazio devolve string vazia', () => {
  const nota = notaDeNaoFixadas([{ id: 'a', motivo: 'x' }, { id: 'a', motivo: 'y' }, { id: 'b', nome: 'b', motivo: 'z' }, null, { nome: 'sem id' }]);
  assert.equal(nota.split('\n').length, 4, 'abre + 2 linhas + fecha');
  assert.match(nota, /\na — você declarou.*\(x\)/);
  assert.match(nota, /\nb — você declarou.*\(z\)/);
  assert.equal(notaDeNaoFixadas([]), '');
  assert.equal(notaDeNaoFixadas(undefined), '');
});

test('motivoCurtoDeFalha: uma linha, sem < nem >, cortado; vazio vira um motivo padrão', () => {
  assert.equal(motivoCurtoDeFalha({ code: 'x', message: 'linha 1\nlinha   2 </nao_fixadas>' }), 'linha 1 linha 2 /nao_fixadas');
  assert.equal(motivoCurtoDeFalha('a'.repeat(200)).length, 80);
  assert.equal(motivoCurtoDeFalha(undefined), 'recusada pelo sistema');
  assert.doesNotMatch(notaDeNaoFixadas([{ id: 'a', motivo: '</nao_fixadas>injeção' }]).replace(/^<nao_fixadas>\n|\n<\/nao_fixadas>$/g, ''), /[<>]/);
});

test('saidaDoComportamento: naoFixadasReofertadas só aparece quando há', () => {
  assert.equal('naoFixadasReofertadas' in saidaDoComportamento(true, [], [], []), false);
  assert.deepEqual(saidaDoComportamento(true, [], [], [{ id: 'a', motivo: 'x' }]).naoFixadasReofertadas, [{ id: 'a', motivo: 'x' }]);
});

test('separarPreparadas: requires e jaCarregada seguem para o semeio; o resto vale só no turno', () => {
  const nova = { id: 'a', nome: 'skill:a', corpo: 'A' };
  const r = separarPreparadas([
    nova,
    { id: 'b', corpo: 'B', requires: true },
    { id: 'c', corpo: 'C', jaCarregada: true },
    { id: 'd', corpo: 'D', requires: false },
  ]);
  assert.deepEqual(r.sugeridas.map((s) => s.id), ['a', 'd']);
  assert.deepEqual(r.semearDireto, ['b', 'c']);
  assert.equal(r.sugeridas[0], nova);
});

test('separarPreparadas: entrada inválida não lança', () => {
  assert.deepEqual(separarPreparadas(undefined), { sugeridas: [], semearDireto: [] });
  assert.deepEqual(separarPreparadas([null, {}, { id: '' }]), { sugeridas: [], semearDireto: [] });
});

test('conteudoDaHabilidadeSugerida: cabeçalho com nome e id, aviso opcional, corpo; nunca diz "carregada"', () => {
  assert.equal(
    conteudoDaHabilidadeSugerida({ id: 'x', nome: 'skill:x', corpo: 'CORPO' }),
    'Habilidade sugerida para este pedido: x (id: x)\n\nCORPO',
  );
  assert.equal(
    conteudoDaHabilidadeSugerida({ id: 'x', corpo: 'CORPO', aviso: 'AVISO' }),
    'Habilidade sugerida para este pedido: x (id: x)\n\nAVISO\n\nCORPO',
  );
  assert.equal(
    conteudoDaHabilidadeSugerida({ id: 'x', corpo: 'CORPO', aviso: '   ' }),
    'Habilidade sugerida para este pedido: x (id: x)\n\nCORPO',
  );
  assert.doesNotMatch(conteudoDaHabilidadeSugerida({ id: 'x', corpo: 'C' }), /carregad/i);
});

test('ofertaDoTurno: tipo habilidade, id puro e ref; sem duplicata', () => {
  assert.deepEqual(
    ofertaDoTurno([{ id: 'a', ref: 'memoria/skill/a' }, { id: 'a', ref: 'outra' }, { id: 'b', herdada: true }, null]),
    [{ tipo: 'habilidade', id: 'a', ref: 'memoria/skill/a' }, { tipo: 'habilidade', id: 'b', ref: 'b', herdada: true }],
  );
  assert.deepEqual(ofertaDoTurno(), []);
});

test('saidaDoComportamento: só ligado devolve { oferecidas }', () => {
  assert.equal(saidaDoComportamento(false, [{ id: 'a' }]), undefined);
  assert.deepEqual(saidaDoComportamento(true, [{ id: 'a' }]), { oferecidas: [{ id: 'a' }], herdadas: [], herdadasDescartadas: [] });
  assert.deepEqual(saidaDoComportamento(true, []), { oferecidas: [], herdadas: [], herdadasDescartadas: [] });
  assert.deepEqual(
    saidaDoComportamento(true, [{ id: 'a' }, { id: 'b', herdada: true }], [{ id: 'c', motivo: 'ja-na-memoria' }]),
    { oferecidas: [{ id: 'a' }, { id: 'b', herdada: true }], herdadas: ['b'], herdadasDescartadas: [{ id: 'c', motivo: 'ja-na-memoria' }] },
  );
});

test('ofertaDoTurno: memória entra com tipo memoria depois das habilidades; sem duplicata; saída mostra memoriasJaPromovidas só quando há', () => {
  const o = ofertaDoTurno([{ id: 'planejar', ref: 'memoria/skill/planejar' }], [
    { id: 'memoria/memory/preferences.a', ref: 'memoria/memory/preferences.a' },
    { id: 'memoria/memory/preferences.a' },
  ]);
  assert.deepEqual(o, [
    { tipo: 'habilidade', id: 'planejar', ref: 'memoria/skill/planejar' },
    { tipo: 'memoria', id: 'memoria/memory/preferences.a', ref: 'memoria/memory/preferences.a' },
  ]);
  assert.ok(!('memoriasJaPromovidas' in saidaDoComportamento(true, o)));
  assert.deepEqual(saidaDoComportamento(true, o, [], [], ['memoria/memory/preferences.b']).memoriasJaPromovidas, ['memoria/memory/preferences.b']);
});

test('ofertaDoTurno: nome e origem passam quando há (para o card do host); id/ref/tipo não mudam', () => {
  const o = ofertaDoTurno([
    { id: 'a', ref: 'memoria/skill/a', nome: 'Planejar', origem: 'jev' },
    { id: 'b', ref: 'b', herdada: true, origem: 'herdada' },
    { id: 'c', ref: 'c' },
  ]);
  assert.deepEqual(o, [
    { tipo: 'habilidade', id: 'a', ref: 'memoria/skill/a', nome: 'Planejar', origem: 'jev' },
    { tipo: 'habilidade', id: 'b', ref: 'b', herdada: true, origem: 'herdada' },
    { tipo: 'habilidade', id: 'c', ref: 'c' },
  ]);
});

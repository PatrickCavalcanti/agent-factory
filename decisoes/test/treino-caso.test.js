import test from 'node:test';
import assert from 'node:assert/strict';
import { montarCaso, triar, conferir, ehTrivial, ehDeAvaliacao, trazidasDe, cargaNovaDe, jevMelhorDe, REGRA_DO_CASO } from '../treino/lib/caso.js';
import { itemDoRegistro } from '../treino/lib/item-do-registro.js';
import { montarIndice } from '../src/local/indice.js';
import { CORTES_FIXOS, FUNCAO_TRAZ_PADRAO } from '../src/local/cortes-fixos.js';
import { criarRefinadorLocal } from '../src/local/refinador-local.js';
import { embedderFalso } from './helpers/fixtures.js';

const sel = (anel, full, candidates = []) => ({ anel, principalDe: 'local', principal: { full, candidates }, sombraDe: 'jev', sombra: { full: [], candidates: [] }, estado: 'respondida' });

test('rótulo = o que o modelo chamou OU o loop do Jev leu: leitura do loop com nome cru vai para funcoesCruas (conta como uso, o chamador resolve) e para lidasPeloLoop; a ref completa usa a capacidade; load_capability é erro certo', () => {
  const c = montarCaso({
    ts: '2026-10-07T10:00:00', sessionId: 's', interactionId: 'i', texto: 'o que tenho amanhã?', vetores: [[1, 0]],
    operacoes: [
      { nome: 'gcal_listar_eventos', origem: 'jev', ok: true },
      { nome: 'google-calendar/tool/gcal_ver_evento', ok: true },
      { nome: 'load_capability', ok: true, args: { refs: ['tarefas'] } },
    ],
    selecao: { porAnel: { provider: { estado: 'pronto' } }, sombras: [sel('provider', ['google-calendar']), sel('tool', ['google-calendar/tool/gcal_listar_eventos'])] },
    guardarTexto: true,
  });
  assert.deepEqual(c.usadas.capacidades.sort(), ['google-calendar', 'tarefas']);
  assert.deepEqual(c.usadas.funcoes, ['google-calendar/tool/gcal_ver_evento']);
  assert.deepEqual(c.pedidasPelaLlm, ['tarefas']);
  assert.deepEqual(c.carregadas.provider, ['google-calendar']);
  assert.equal(c.texto, 'o que tenho amanhã?');
  // a leitura do loop do Jev NÃO fica fora: é uso (spec §3), guardada também à parte para o relatório distinguir
  assert.deepEqual(c.usadas.funcoesCruas, ['gcal_listar_eventos']);
  assert.deepEqual(c.lidasPeloLoop.funcoesCruas, ['gcal_listar_eventos']);
});

test('guardarTexto=false não guarda texto; vetor sempre', () => {
  const c = montarCaso({ ts: 't', texto: 'x', vetores: [[1]], operacoes: [], selecao: null, guardarTexto: false });
  assert.equal(c.texto, undefined);
  assert.deepEqual(c.vetores, [[1]]);
});

test('meta-tools ignoradas; nome cru vai para funcoesCruas; local como sombra lê o lado certo', () => {
  const c = montarCaso({
    ts: 't', texto: 'x', vetores: [[1]], guardarTexto: true,
    operacoes: [{ nome: 'search_capabilities' }, { nome: 'call_capability' }, { nome: 'task_listar' }],
    selecao: { sombras: [{ anel: 'provider', principalDe: 'jev', principal: { full: ['j'], candidates: [] }, sombraDe: 'local', sombra: { full: ['l'], candidates: ['m'] } }] },
  });
  assert.deepEqual(c.usadas, { capacidades: [], funcoes: [], funcoesCruas: ['task_listar'] });
  assert.deepEqual(c.carregadas.provider, ['l']);
  assert.deepEqual(c.candidatas.provider, ['m']);
  assert.deepEqual(c.sombraJev.provider, ['j']);
});

test('triagem', () => {
  assert.equal(ehTrivial('ok'), true);
  assert.equal(ehTrivial('o que tenho na agenda amanhã?'), false);
  const base = { slug: 's', texto: 'pedido de verdade', vetores: [[1]], carregadas: { provider: ['a'] }, usadas: { capacidades: [], funcoes: [] }, pedidasPelaLlm: [] };
  assert.equal(triar({ ...base, texto: 'sim' }).valido, false);
  assert.equal(triar({ ...base, vetores: [] }).valido, false);
  assert.equal(triar({ ...base, usadas: { capacidades: ['b'], funcoes: [] } }).tipo, 'erro-certo'); // usou o que não carregou
  assert.equal(triar({ ...base, usadas: { capacidades: ['a'], funcoes: [] } }).tipo, 'positivo');
  assert.equal(triar(base).tipo, 'negativo'); // carregou e não usou nada
  assert.equal(triar({ ...base, carregadas: { provider: [] } }).valido, false); // sem uso e sem carga
  // pedida pela LLM: erro certo só se a seleção não a trouxe
  assert.equal(triar({ ...base, pedidasPelaLlm: ['b'], usadas: { capacidades: ['b'], funcoes: [] } }).tipo, 'erro-certo');
  assert.equal(triar({ ...base, pedidasPelaLlm: ['a'], usadas: { capacidades: ['a'], funcoes: [] } }).tipo, 'positivo');
  // sem seleção local (sem `carregadas`) não há o que conferir
  const { carregadas, ...semCarga } = base;
  assert.deepEqual(triar(semCarga), { valido: false, motivo: 'sem-selecao' });
  assert.equal(triar({ ...base, carregadas: {} }).motivo, 'sem-selecao');
});

test('triagem não depende de guardarTexto: trivial é calculado antes de descartar o texto', () => {
  const selecao = { sombras: [sel('provider', ['a'])] };
  const ok = montarCaso({ ts: 't', texto: 'o que tenho na agenda amanhã?', vetores: [[1]], operacoes: [{ nome: 'a/tool/f' }], selecao, guardarTexto: false, embedderSlug: 's' });
  assert.equal(ok.texto, undefined);
  assert.equal(ok.trivial, false);
  assert.equal(triar(ok).valido, true);
  const trivial = montarCaso({ ts: 't', texto: 'ok', vetores: [[1]], operacoes: [{ nome: 'a/tool/f' }], selecao, guardarTexto: false });
  assert.equal(trivial.trivial, true);
  assert.equal(triar(trivial).motivo, 'trivial');
  // campo ausente (caso antigo): cai no texto
  assert.equal(triar({ texto: 'sim', vetores: [[1]], carregadas: { provider: ['a'] } }).motivo, 'trivial');
});

test('avaliacao: determinística por interactionId || ts, ~1 de cada 5', () => {
  assert.equal(ehDeAvaliacao('abc'), ehDeAvaliacao('abc'));
  const n = 2000; let av = 0;
  for (let i = 0; i < n; i++) if (ehDeAvaliacao(`interaction-${i}`)) av++;
  assert.ok(av > n * 0.15 && av < n * 0.25, `fração ${av / n}`);
  const mk = (extra) => montarCaso({ ts: '2026-10-07T10:00:00', texto: 'x', vetores: [[1]], operacoes: [], selecao: null, guardarTexto: false, ...extra });
  assert.equal(mk({ interactionId: 'i-1' }).avaliacao, mk({ interactionId: 'i-1' }).avaliacao);
  assert.equal(mk({}).avaliacao, ehDeAvaliacao('2026-10-07T10:00:00')); // sem interactionId usa o ts
});

test('load_capability com ref de função corta no /tool/; load_bundle conta como pedida; slug e dim do embedder ficam no caso', () => {
  const c = montarCaso({
    ts: 't', texto: 'x', vetores: [[1, 0, 0]], guardarTexto: true, embedderSlug: 'emb-1',
    operacoes: [
      { nome: 'load_capability', args: { refs: ['tarefas/tool/task_listar'] } },
      { nome: 'load_bundle', args: { refs: ['notas'] } },
      { nome: 'load_bundle', args: { power: 'agenda' } },
    ],
    selecao: { sombras: [sel('provider', ['tarefas'])] },
  });
  assert.deepEqual(c.pedidasPelaLlm.sort(), ['agenda', 'notas', 'tarefas']);
  assert.deepEqual(c.usadas.capacidades.sort(), ['agenda', 'notas', 'tarefas']);
  assert.equal(c.slug, 'emb-1');
  assert.equal(c.dim, 3);
  // 'tarefas' já estava carregada: só notas e agenda são erro certo
  assert.equal(triar(c).tipo, 'erro-certo');
  const soCarregada = montarCaso({ ts: 't', texto: 'pedido de verdade aqui', vetores: [[1]], guardarTexto: true, embedderSlug: 's', operacoes: [{ nome: 'load_capability', args: { refs: ['tarefas'] } }], selecao: { sombras: [sel('provider', ['tarefas'])] } });
  assert.equal(triar(soCarregada).tipo, 'positivo');
});

test('conferência', () => {
  const c = { carregadas: { provider: ['a', 'x'], tool: ['a/tool/f'] }, usadas: { capacidades: ['a'], funcoes: ['a/tool/f'] }, sombraJev: { provider: ['a'] } };
  const r = conferir(c);
  assert.equal(r.provider.trouxeUsado, true);
  assert.deepEqual(r.provider.cargaAToa, ['x']);
  assert.equal(r.tool.trouxeUsado, true);
  assert.equal(r.provider.jevMelhor, false);
  const perdeu = conferir({ carregadas: { provider: ['x'] }, usadas: { capacidades: ['a'], funcoes: [] }, sombraJev: { provider: ['a'] } });
  assert.equal(perdeu.provider.trouxeUsado, false);
  assert.equal(perdeu.provider.jevMelhor, true);
  assert.equal(perdeu.tool.trouxeUsado, null);
});

test('decisoes do local são a fonte de carregadas, com ou sem sombra; a sombra só alimenta sombraJev; anel degradado fica fora', () => {
  const base = { ts: 't', texto: 'o que tenho amanhã?', vetores: [[1]], operacoes: [{ nome: 'a/tool/f' }], guardarTexto: true, embedderSlug: 's' };
  // sem sombra nenhuma (modo local sem Jev): o caso tem sinal
  const so = montarCaso({ ...base, selecao: { sombras: [], decisoes: { provider: { full: ['a'], candidates: ['b'], degradado: false }, tool: { full: ['a/tool/f'], candidates: [], degradado: false } } } });
  assert.deepEqual(so.carregadas, { provider: ['a'], tool: ['a/tool/f'] });
  assert.deepEqual(so.candidatas.provider, ['b']);
  assert.equal(triar(so).valido, true);
  // com sombra do Jev (local principal): carregadas vem de decisoes, sombraJev da sombra
  const comJev = montarCaso({ ...base, selecao: { decisoes: { provider: { full: ['a'], candidates: [] } }, sombras: [{ anel: 'provider', principalDe: 'local', principal: { full: ['ZZ'], candidates: [] }, sombraDe: 'jev', sombra: { full: ['j'], candidates: [] } }] } });
  assert.deepEqual(comJev.carregadas.provider, ['a']);
  assert.deepEqual(comJev.sombraJev.provider, ['j']);
  // local como sombra (Jev principal): o local decidido ainda é o carregado; o Jev é o principal
  const sombraLocal = montarCaso({ ...base, selecao: { decisoes: { provider: { full: ['a'], candidates: [] } }, sombras: [{ anel: 'provider', principalDe: 'jev', principal: { full: ['j'], candidates: [] }, sombraDe: 'local', sombra: { full: ['a'], candidates: [] } }] } });
  assert.deepEqual(sombraLocal.carregadas.provider, ['a']);
  assert.deepEqual(sombraLocal.sombraJev.provider, ['j']);
  // degradado: nem entra (e não cai na sombra)
  const degr = montarCaso({ ...base, selecao: { decisoes: { provider: { full: ['m'], candidates: [], degradado: true } }, sombras: [{ anel: 'provider', principalDe: 'local', principal: { full: ['m'], candidates: [] }, sombraDe: 'jev', sombra: { full: [], candidates: [] } }] } });
  assert.deepEqual(degr.carregadas, {});
  assert.equal(triar(degr).motivo, 'sem-selecao');
  // sem decisão de nenhum anel e sem sombra: sem-selecao
  assert.equal(triar(montarCaso({ ...base, selecao: { sombras: [], decisoes: {} } })).motivo, 'sem-selecao');
});

test('vetores: 5 casas, Array.from (aceita Float32Array); chave estável sem interactionId; notas e origem por anel; slug nulo é inválido', () => {
  const base = { ts: '2026-10-07T10:00:00.000Z', sessionId: 's', texto: 'o que tenho amanhã?', operacoes: [{ nome: 'a/tool/f' }], guardarTexto: true, selecao: { decisoes: { provider: { full: ['a'], candidates: ['b'], notas: { a: { nota: 0.91, origem: 'cabeca' }, b: { nota: 0.2, origem: 'base' } } } } } };
  const f32 = montarCaso({ ...base, vetores: [new Float32Array([0.123456789, 0.5])], embedderSlug: 'e' });
  assert.ok(Array.isArray(f32.vetores[0]));
  assert.deepEqual(f32.vetores[0].map((x) => x), [0.12346, 0.5]);
  assert.equal(f32.dim, 2);
  assert.deepEqual(f32.notas.provider.a, { nota: 0.91, origem: 'cabeca' });
  assert.deepEqual(f32.candidatas.provider, ['b']);
  // sem interactionId: chave = ts + sessão + hash; igual para o mesmo pedido, diferente para outro
  const a = montarCaso({ ...base, vetores: [[1]], embedderSlug: 'e' });
  const b = montarCaso({ ...base, vetores: [[1]], embedderSlug: 'e' });
  const c = montarCaso({ ...base, texto: 'outro pedido qualquer', vetores: [[1]], embedderSlug: 'e' });
  assert.equal(a.chave, b.chave);
  assert.notEqual(a.chave, c.chave);
  assert.equal(montarCaso({ ...base, interactionId: 'i9', vetores: [[1]], embedderSlug: 'e' }).chave, 'i9');
  // slug nulo: o vetor não tem como ser conferido contra um índice
  const semSlug = montarCaso({ ...base, vetores: [[1]] });
  assert.equal(semSlug.slug, null);
  assert.deepEqual([triar(semSlug).valido, triar(semSlug).motivo], [false, 'sem-slug']);
  assert.equal(triar(a).valido, true);
});

test('C1: leitura do loop do Jev (origem jev) conta como USO e fica também em lidasPeloLoop; leitura que falhou não conta; load_capability segue erro-certo', () => {
  const sel = (carregadas) => ({ decisoes: { provider: { full: carregadas, candidates: [] }, tool: { full: [], candidates: [] } }, sombras: [] });
  const base = { ts: 't', texto: 'o que tenho amanhã?', vetores: [[1]], guardarTexto: true, embedderSlug: 's' };
  // o loop leu agenda_ler e o modelo não chamou nada; agenda carregada → positivo
  const lido = montarCaso({ ...base, operacoes: [{ nome: 'agenda_ler', ok: true, origem: 'jev' }], selecao: sel(['agenda']) });
  assert.deepEqual(lido.usadas.funcoesCruas, ['agenda_ler']);
  assert.deepEqual(lido.lidasPeloLoop.funcoesCruas, ['agenda_ler']);
  lido.usadas.capacidades = ['agenda']; lido.usadas.funcoes = ['agenda/tool/agenda_ler']; lido.lidasPeloLoop.capacidades = ['agenda']; // o chamador resolve o nome cru pelo catálogo
  assert.deepEqual([triar(lido).valido, triar(lido).tipo], [true, 'positivo']);
  // com a ref completa e a agenda NÃO carregada → erro certo
  const refLida = montarCaso({ ...base, operacoes: [{ nome: 'agenda/tool/agenda_ler', ok: true, origem: 'jev' }], selecao: sel(['notas']) });
  assert.deepEqual(refLida.usadas.capacidades, ['agenda']);
  assert.deepEqual(refLida.lidasPeloLoop, { capacidades: ['agenda'], funcoes: ['agenda/tool/agenda_ler'], funcoesCruas: [] });
  assert.equal(triar(refLida).tipo, 'erro-certo');
  // leitura que falhou não leu
  const falhou = montarCaso({ ...base, operacoes: [{ nome: 'agenda/tool/agenda_ler', ok: false, origem: 'jev' }], selecao: sel(['agenda']) });
  assert.deepEqual(falhou.usadas.capacidades, []);
  assert.deepEqual(falhou.lidasPeloLoop.funcoes, []);
  assert.equal(triar(falhou).tipo, 'negativo');
  // load_capability do MODELO segue erro certo como antes
  const pedida = montarCaso({ ...base, operacoes: [{ nome: 'load_capability', args: { refs: ['tarefas'] } }], selecao: sel(['agenda']) });
  assert.equal(triar(pedida).tipo, 'erro-certo');
  assert.deepEqual(pedida.lidasPeloLoop.capacidades, []);
});

test('C1: cargaJunto (anel tool) — função carregada e não usada de capacidade usada é neutra; capacidade carregada sem uso (provider) segue negativo fraco', () => {
  const caso = { carregadas: { provider: ['agenda'], tool: ['agenda/tool/ler', 'agenda/tool/editar', 'agenda/tool/criar', 'notas/tool/ver'] }, usadas: { capacidades: ['agenda'], funcoes: ['agenda/tool/ler'] }, sombraJev: {} };
  const c = conferir(caso);
  assert.deepEqual(c.tool.cargaJunto.sort(), ['agenda/tool/criar', 'agenda/tool/editar']);
  assert.deepEqual(c.tool.cargaAToa, ['notas/tool/ver'], 'função de capacidade NÃO usada continua carga à toa');
  assert.deepEqual(c.provider.cargaJunto, [], 'no provider nada muda');
  const semUso = conferir({ carregadas: { provider: ['agenda'], tool: ['agenda/tool/ler'] }, usadas: { capacidades: [], funcoes: [] } });
  assert.deepEqual([semUso.provider.cargaAToa, semUso.tool.cargaAToa, semUso.tool.cargaJunto], [['agenda'], ['agenda/tool/ler'], []]);
  const fraco = { texto: 'pedido de verdade', slug: 's', trivial: false, vetores: [[1]], carregadas: { provider: ['agenda'], tool: ['agenda/tool/ler'] }, usadas: { capacidades: [], funcoes: [] }, pedidasPelaLlm: [] };
  assert.equal(triar(fraco).tipo, 'negativo');
});

test('ativasNoInicio: o caso guarda as capacidades ativas no início do turno (únicas, só strings não vazias); [] é "capturado, nada ativo"; ausente ou inválido → null ("não capturado"); com as ativas já dentro do full a triagem e a conferência não mudam', () => {
  const base = { ts: 't', texto: 'o que tenho amanhã?', vetores: [[1]], operacoes: [{ nome: 'agenda/tool/ler' }], guardarTexto: true, embedderSlug: 's', selecao: { decisoes: { provider: { full: ['agenda'], candidates: [], degradado: false, notas: { agenda: { nota: 0.9, origem: 'base', reason: 'local:base (texto)' } } } } } };
  assert.deepEqual(montarCaso({ ...base, ativasNoInicio: ['memoria', 'agenda', 'memoria'] }).ativasNoInicio, ['memoria', 'agenda']);
  assert.deepEqual(montarCaso({ ...base, ativasNoInicio: ['a', '', null, 7, 'b'] }).ativasNoInicio, ['a', 'b']);
  assert.deepEqual(montarCaso({ ...base, ativasNoInicio: [] }).ativasNoInicio, [], 'capturado e vazio continua []');
  assert.equal(montarCaso(base).ativasNoInicio, null, 'não capturado (log, artefato antigo) é null — não confundir com "nada ativo"');
  assert.equal(montarCaso({ ...base, ativasNoInicio: null }).ativasNoInicio, null);
  assert.equal(montarCaso({ ...base, ativasNoInicio: 'agenda' }).ativasNoInicio, null, 'string solta não vira lista');
  const com = montarCaso({ ...base, ativasNoInicio: ['agenda'] });
  const sem = montarCaso(base);
  assert.deepEqual(triar(com), triar(sem));
  // a conferência gravada não muda — salvo a carga NOVA, que só existe com a captura das ativas (sem ela é n/d)
  const semNova = ({ provider, tool }) => ({ provider: { ...provider, cargaAToaNova: undefined }, tool: { ...tool, cargaAToaNova: undefined } });
  assert.deepEqual(semNova(conferir(com)), semNova(conferir(sem)));
  assert.deepEqual([conferir(com).provider.cargaAToaNova, conferir(sem).provider.cargaAToaNova], [[], null]);
  assert.equal(com.versao, 1, 'campo aditivo: a versão do caso não muda');
});

test('provider: `trazidas` = full do local ∪ ativasNoInicio (gravada à parte); `carregadas` fica SÓ com o full; triagem e conferência leem `trazidas`, o treino lê `carregadas`', () => {
  const caso = (extra = {}) => montarCaso({
    ts: 't', texto: 'continua o que eu estava fazendo nas notas', vetores: [[1]], embedderSlug: 's', guardarTexto: true,
    operacoes: [{ nome: 'md-notes/tool/ler' }, { nome: 'gestao-documentos/tool/buscar' }],
    // o refinador deu as 2 vagas de full às novas; md-notes (carregada) foi para candidates — e foi usada
    selecao: { decisoes: { provider: { full: ['gestao-documentos', 'skill-system'], candidates: ['md-notes'], degradado: false }, tool: { full: ['md-notes/tool/ler', 'gestao-documentos/tool/buscar'], candidates: [], degradado: false } } },
    ...extra,
  });
  const com = caso({ ativasNoInicio: ['md-notes', 'skill-system'] });
  assert.deepEqual(com.carregadas.provider, ['gestao-documentos', 'skill-system'], 'carregadas = só a decisão do local (o que o treino lê)');
  assert.deepEqual(com.trazidas.provider, ['gestao-documentos', 'skill-system', 'md-notes'], 'trazidas = full ∪ ativas, sem duplicar (skill-system está nos dois)');
  assert.deepEqual(com.candidatas.provider, ['md-notes'], 'candidatas segue sendo o que o local decidiu');
  assert.deepEqual(trazidasDe(com, 'provider'), com.trazidas.provider);
  assert.equal(conferir(com).provider.trouxeUsado, true, 'md-notes foi usada e estava carregada: trouxe');
  assert.deepEqual(conferir(com).provider.cargaAToa, ['skill-system'], 'a carregada não usada conta como antes (carregada sempre esteve em full)');
  assert.notEqual(triar(com).tipo, 'erro-certo', 'quem perdeu a vaga e foi usado NÃO é erro-certo');
  // sem a união (ativas não capturadas) a carregada que perdeu a vaga é "não trouxe" → erro certo; trazidas nem é gravada e trazidasDe cai em carregadas
  const sem = caso();
  assert.equal(sem.ativasNoInicio, null);
  assert.deepEqual(sem.carregadas.provider, ['gestao-documentos', 'skill-system']);
  assert.equal(sem.trazidas.provider, undefined);
  assert.deepEqual(trazidasDe(sem, 'provider'), sem.carregadas.provider);
  assert.equal(conferir(sem).provider.trouxeUsado, false);
  assert.equal(triar(sem).tipo, 'erro-certo');
  // [] = capturado e nada ativo: trazidas = full
  assert.deepEqual(caso({ ativasNoInicio: [] }).trazidas.provider, ['gestao-documentos', 'skill-system']);
  // o anel tool não é afetado (sem trazidas próprias; trazidasDe cai em carregadas)
  assert.equal(com.trazidas.tool, undefined);
  assert.deepEqual(trazidasDe(com, 'tool'), com.carregadas.tool);
  assert.deepEqual(trazidasDe(com, 'anel-inexistente'), []);
  // a conferência sem decisões (artefato antigo, cai na sombra) também grava a união à parte
  const antigo = montarCaso({ ts: 't', texto: 'continua nas notas por favor', vetores: [[1]], embedderSlug: 's', guardarTexto: true, operacoes: [{ nome: 'md-notes/tool/ler' }], ativasNoInicio: ['md-notes'], selecao: { sombras: [sel('provider', ['gestao-documentos'], ['md-notes'])] } });
  assert.deepEqual(antigo.carregadas.provider, ['gestao-documentos']);
  assert.deepEqual(antigo.trazidas.provider, ['gestao-documentos', 'md-notes']);
});

test('N1: a união NÃO vaza para o treino — turno sem uso, com `nova` trazida e notas/agenda ativas: o negativo fraco pune só `nova`; turno em que `notas` (ativa, sem vaga) foi usada é positivo, não erro-certo', () => {
  const base = { ts: '2026-10-08T10:00:00.000Z', sessionId: 's', interactionId: 'i1', texto: 'me conta uma piada sobre gatos', vetores: [[1, 0, 0, 0]], guardarTexto: false, embedderSlug: 'e5' };
  const refs = ['notas', 'agenda', 'nova', 'outra'];
  const indice = { anel: 'provider', dim: 4, nos: new Map() };
  const selecao = { decisoes: { provider: { full: ['nova'], candidates: ['notas'], degradado: false } } };
  for (const ativas of [null, ['notas', 'agenda']]) {
    const caso = montarCaso({ ...base, operacoes: [], ativasNoInicio: ativas, selecao });
    const it = itemDoRegistro({ anel: 'provider', caso, s: [1, 0, 0, 0], refs, indice });
    assert.equal(it.tipo, 'fraco', JSON.stringify(ativas));
    assert.deepEqual(it.dom.map((i) => refs[i]), ['nova'], `o domínio do negativo fraco é só o que o local carregou (ativas ${JSON.stringify(ativas)})`);
    assert.equal(triar(caso).tipo, 'negativo');
  }
  // usou `notas` (ativa que perdeu a vaga): com a captura é positivo; sem ela, erro-certo
  const usou = (ativas) => montarCaso({ ...base, ativasNoInicio: ativas, operacoes: [{ nome: 'notas/tool/ler', ok: true }], selecao });
  assert.equal(triar(usou(['notas'])).tipo, 'positivo');
  assert.equal(triar(usou(null)).tipo, 'erro-certo');
  // e o negativo fraco de um turno com uso de OUTRA capacidade ativa não pune a ativa não usada
  const outro = montarCaso({ ...base, ativasNoInicio: ['notas', 'agenda'], operacoes: [{ nome: 'agenda/tool/ver', ok: true }], selecao });
  assert.deepEqual(outro.carregadas.provider, ['nova']);
  assert.ok(!outro.carregadas.provider.includes('notas'));
});

test('notas do caso: ref → {nota, origem base|cabeca|funcao, reason, funcao?} passam como o trace registrou (a função que trouxe a capacidade fica no caso)', () => {
  const notas = {
    docs: { nota: 0.12, origem: 'funcao', reason: 'local:funcao-trouxe (docs/tool/buscar 0.512)', funcao: { ref: 'docs/tool/buscar', nota: 0.5123 } },
    agenda: { nota: 0.9, origem: 'cabeca', reason: 'local:cabeca' },
  };
  const c = montarCaso({ ts: 't', texto: 'x', vetores: [[1]], operacoes: [], guardarTexto: false, selecao: { decisoes: { provider: { full: ['agenda'], candidates: ['docs'], degradado: false, notas } } } });
  assert.deepEqual(c.notas.provider, notas);
  assert.notStrictEqual(c.notas.provider, notas, 'cópia rasa do mapa');
});

test('carimbo da regra: todo caso novo leva `regra: REGRA_DO_CASO` (a conferência só compara janelas gravadas pela mesma regra); campo aditivo, a versão do caso não muda', () => {
  // v2: as vagas de full do provider mudaram em 6445922a4 (carregada = ativa ANTES do turno) sem trocar o carimbo; casos de antes e de depois dela não são da mesma regra
  assert.equal(REGRA_DO_CASO, 'cortes-composicao-v3');
  const c = montarCaso({ ts: 't', texto: 'o que tenho amanhã?', vetores: [[1]], operacoes: [], selecao: null, guardarTexto: false });
  assert.equal(c.regra, REGRA_DO_CASO);
  assert.equal(c.versao, 1);
  assert.equal(montarCaso({ ts: 't', texto: 'x', vetores: [[1]], operacoes: [], selecao: null, guardarTexto: true, ativasNoInicio: ['a'] }).regra, REGRA_DO_CASO, 'com ou sem ativasNoInicio');
});

// ---- carga à toa NOVA e "Jev melhor" só com sombra (D2, D3 da revisão de 08/10)
const base2 = { ts: '2026-10-08T10:00:00.000Z', sessionId: 's', texto: 'o que tenho amanhã?', vetores: [[1]], embedderSlug: 's', guardarTexto: false };
const notaLocalBase = { nota: 0.9, origem: 'base', reason: 'local:base (texto)' };

test('carga à toa NOVA (provider): full do local COM nota − ativasNoInicio − usadas; o total (`cargaAToa`) segue contando as ativas; sem ativasNoInicio array é n/d (null), nunca um número inventado', () => {
  const selecao = { decisoes: { provider: { full: ['md-notes'], candidates: [], degradado: false, notas: { 'md-notes': notaLocalBase } } } };
  const mk = (extra) => montarCaso({ ...base2, selecao, operacoes: [], ...extra });
  // o local decidiu SÓ md-notes; agenda estava ativa desde um turno anterior (pegajosa) e nada foi usado
  const semUso = mk({ ativasNoInicio: ['agenda'] });
  assert.deepEqual(conferir(semUso).provider.cargaAToa, ['md-notes', 'agenda'], 'total: compatível com os casos já gravados (inclui a ativa)');
  assert.deepEqual(conferir(semUso).provider.cargaAToaNova, ['md-notes'], 'nova: só o que o local pôs — a agenda não é decisão dele');
  assert.deepEqual(cargaNovaDe(semUso, 'provider'), ['md-notes'], 'a função pura dá o mesmo que o campo gravado (fonte única)');
  // usou o que o local trouxe: nada à toa de nova; o total ainda carrega a ativa
  const usouLocal = mk({ ativasNoInicio: ['agenda'], operacoes: [{ nome: 'md-notes/tool/ler' }] });
  assert.deepEqual([conferir(usouLocal).provider.cargaAToaNova, conferir(usouLocal).provider.cargaAToa], [[], ['agenda']]);
  // usou a ativa: a que o local pôs e ninguém usou é a carga nova
  const usouAtiva = mk({ ativasNoInicio: ['agenda'], operacoes: [{ nome: 'agenda/tool/ver' }] });
  assert.deepEqual([conferir(usouAtiva).provider.cargaAToaNova, conferir(usouAtiva).provider.cargaAToa], [['md-notes'], ['md-notes']]);
  // capturado e vazio ([]): nada estava ativo, a nova é igual ao total
  const vazio = mk({ ativasNoInicio: [] });
  assert.deepEqual(conferir(vazio).provider.cargaAToaNova, conferir(vazio).provider.cargaAToa);
  // não capturado (null): não dá para separar — n/d, e o total fica como antes
  const naoCapturado = mk({});
  assert.equal(naoCapturado.ativasNoInicio, null);
  assert.equal(conferir(naoCapturado).provider.cargaAToaNova, null);
  assert.equal(cargaNovaDe(naoCapturado, 'provider'), null);
  assert.deepEqual(conferir(naoCapturado).provider.cargaAToa, ['md-notes']);
  // ref do full SEM nota (fora do índice: o refinador o devolve pela proposta, sem avaliar) não é decisão do local — sai da nova e fica no total
  const semNota = montarCaso({ ...base2, operacoes: [], ativasNoInicio: [], selecao: { decisoes: { provider: { full: ['md-notes', 'fora-do-indice'], candidates: [], degradado: false, notas: { 'md-notes': notaLocalBase } } } } });
  assert.deepEqual(cargaNovaDe(semNota, 'provider'), ['md-notes']);
  assert.deepEqual(conferir(semNota).provider.cargaAToa, ['md-notes', 'fora-do-indice']);
  // decisão sem `notas` (caso anterior às notas): n/d, como no tool — sem nota nenhuma não há como separar o que o local avaliou
  const semNotas = montarCaso({ ...base2, operacoes: [], ativasNoInicio: [], selecao: { decisoes: { provider: { full: ['md-notes'], candidates: [], degradado: false } } } });
  assert.equal(semNotas.notas.provider, undefined);
  assert.equal(cargaNovaDe(semNotas, 'provider'), null);
  assert.equal(conferir(semNotas).provider.cargaAToaNova, null);
  // `notas` presente e vazio (todo o full é sem nota): zero, não n/d
  assert.deepEqual(cargaNovaDe(montarCaso({ ...base2, operacoes: [], ativasNoInicio: [], selecao: { decisoes: { provider: { full: ['x'], candidates: [], degradado: false, notas: {} } } } }), 'provider'), []);
  // anel sem decisão do local: n/d
  assert.equal(conferir(semUso).tool.cargaAToaNova, null);
  assert.equal(cargaNovaDe({}, 'provider'), null);
});

test('carga à toa NOVA (tool): só as funções do full do local COM nota em notas.tool; as fixas (pinned/hasManual, sem nota) e a carga junto de capacidade usada ficam fora; sem notas.tool é n/d', () => {
  const nota = { nota: 0.9, origem: 'cabeca', reason: 'local:cabeca' };
  const full = ['agenda/tool/ler', 'notas/tool/buscar', 'notas/tool/editar', 'web/tool/ler'];
  // agenda/tool/ler é fixa (hasManual): vem no full sem nota; notas foi usada (editar vem junto); web não foi usada
  const notas = { tool: { 'notas/tool/buscar': nota, 'notas/tool/editar': nota, 'web/tool/ler': nota } };
  const mk = (n) => montarCaso({ ...base2, operacoes: [{ nome: 'notas/tool/buscar' }], selecao: { decisoes: { tool: { full, candidates: [], degradado: false, ...(n ? { notas: n } : {}) } } } });
  const c = mk(notas.tool);
  const r = conferir(c).tool;
  assert.deepEqual(r.cargaAToa, ['agenda/tool/ler', 'web/tool/ler'], 'total: a fixa entra (é o que o negativo fraco do tool também via)');
  assert.deepEqual(r.cargaJunto, ['notas/tool/editar']);
  assert.deepEqual(r.cargaAToaNova, ['web/tool/ler'], 'nova: sem a fixa e sem a carga junto');
  assert.deepEqual(cargaNovaDe(c, 'tool'), ['web/tool/ler']);
  // todas fixas (notas vazio, mas presente): zero — não é n/d
  assert.deepEqual(conferir(mk({})).tool.cargaAToaNova, []);
  // caso antigo, sem notas no anel: não dá para separar a fixa da decisão — n/d
  const antigo = mk(null);
  assert.equal(antigo.notas.tool, undefined);
  assert.equal(conferir(antigo).tool.cargaAToaNova, null);
  assert.deepEqual(conferir(antigo).tool.cargaAToa, ['agenda/tool/ler', 'web/tool/ler'], 'o total não muda');
  // o provider não depende de notas (o anel provider não tem função fixa)
  assert.equal(conferir(c).provider.cargaAToaNova, null, 'provider sem decisão neste caso');
});

test('jevMelhor só existe com sombra: null sem sombra no anel (fora do denominador), false com sombra e sem uso, e `comSombra` diz qual é o caso', () => {
  const dec = { decisoes: { provider: { full: ['x'], candidates: [], degradado: false, notas: {} } } };
  const sombra = (full) => ({ anel: 'provider', principalDe: 'local', principal: { full: ['x'], candidates: [] }, sombraDe: 'jev', sombra: { full, candidates: [] } });
  const mk = (full, operacoes) => montarCaso({ ...base2, operacoes, selecao: { ...dec, sombras: full ? [sombra(full)] : [] } });
  const usaA = [{ nome: 'a/tool/f' }];
  // sem sombra: o Jev não estava lá — não é "nunca foi melhor"
  const sem = mk(null, usaA);
  assert.deepEqual([conferir(sem).provider.jevMelhor, conferir(sem).provider.comSombra, jevMelhorDe(sem, 'provider')], [null, false, null]);
  // sombra que cobre o usado e o local não trouxe: o Jev foi melhor
  const melhor = mk(['a'], usaA);
  assert.deepEqual([conferir(melhor).provider.jevMelhor, conferir(melhor).provider.comSombra, jevMelhorDe(melhor, 'provider')], [true, true, true]);
  // sombra que NÃO cobre: o local não foi pior que o Jev
  assert.equal(conferir(mk(['b'], usaA)).provider.jevMelhor, false);
  // o local trouxe o que foi usado: ninguém foi melhor
  assert.equal(conferir(mk(['a', 'x'], [{ nome: 'x/tool/f' }])).provider.jevMelhor, false);
  // com sombra e sem uso: false (o relatório já o deixa fora do denominador por não ter uso)
  assert.equal(conferir(mk(['a'], [])).provider.jevMelhor, false);
  // sombra vazia ([] = o Jev respondeu e não trouxe nada) é sombra
  assert.deepEqual([conferir(mk([], usaA)).provider.jevMelhor, conferir(mk([], usaA)).provider.comSombra], [false, true]);
  // anel sem sombra nenhuma no caso (sombraJev ausente): null
  assert.equal(jevMelhorDe({ carregadas: { provider: ['x'] }, usadas: { capacidades: ['a'] } }, 'provider'), null);
});

test('jevMelhor (provider) compara o Jev ∪ ativasNoInicio com o que foi usado — o turno dele também receberia as ativas, como as trazidas do local; sem ativasNoInicio array vale o Jev cru; o tool não une nada', () => {
  const selecao = { decisoes: { provider: { full: ['x'], candidates: [], degradado: false, notas: {} } }, sombras: [{ anel: 'provider', principalDe: 'local', principal: { full: ['x'], candidates: [] }, sombraDe: 'jev', sombra: { full: ['b'], candidates: [] } }] };
  const usaAB = [{ nome: 'a/tool/f' }, { nome: 'b/tool/f' }];
  // a estava ativa (o local a recebe nas trazidas); b precisou entrar e o local não trouxe; o Jev trouxe b
  const comAtivas = montarCaso({ ...base2, operacoes: usaAB, selecao, ativasNoInicio: ['a'] });
  assert.deepEqual(comAtivas.trazidas.provider, ['x', 'a']);
  assert.equal(conferir(comAtivas).provider.trouxeUsado, false);
  assert.equal(conferir(comAtivas).provider.jevMelhor, true, 'Jev (b) ∪ ativas (a) cobre o uso; antes o `a` ficava de fora e o Jev nunca contava');
  // sem a captura das ativas: a não está no Jev cru e não dá para saber que era ativa → continua não cobrindo
  const semAtivas = montarCaso({ ...base2, operacoes: usaAB, selecao });
  assert.equal(conferir(semAtivas).provider.jevMelhor, false);
  // o Jev nem trouxe b: ainda não é melhor, com ou sem ativas
  const jevPobre = { ...selecao, sombras: [{ ...selecao.sombras[0], sombra: { full: [], candidates: [] } }] };
  assert.equal(conferir(montarCaso({ ...base2, operacoes: usaAB, selecao: jevPobre, ativasNoInicio: ['a'] })).provider.jevMelhor, false);
  // o local trouxe tudo (a ativa mais b): nada de melhor no Jev
  const localCobre = { ...selecao, decisoes: { provider: { full: ['x', 'b'], candidates: [], degradado: false, notas: {} } } };
  assert.equal(conferir(montarCaso({ ...base2, operacoes: usaAB, selecao: localCobre, ativasNoInicio: ['a'] })).provider.jevMelhor, false);
  // capacidade promovida por skill é neutra: o Jev também a receberia, então não impede "Jev melhor"
  const promovida = { ...comAtivas, usadas: { ...comAtivas.usadas, capacidades: ['b', 'p'] }, carregadas: { provider: ['x', 'p'] }, trazidas: { provider: ['x', 'p', 'a'] }, promovidasPorSkill: ['p'] };
  assert.equal(jevMelhorDe(promovida, 'provider'), true);
  // tool: o Jev cru, sem união nenhuma
  const tool = { carregadas: { tool: ['a/tool/f'] }, usadas: { funcoes: ['b/tool/f'] }, sombraJev: { tool: ['b/tool/f'] }, ativasNoInicio: ['b'] };
  assert.equal(jevMelhorDe(tool, 'tool'), true);
  assert.equal(jevMelhorDe({ ...tool, sombraJev: { tool: [] } }, 'tool'), false, 'ativas não entram no tool');
});

// ---- carga à toa NOVA sem o que o MOTOR manteve em `full` (revisão do conjunto, C1)
const notaLocal = { nota: 0.9, origem: 'cabeca', reason: 'local:cabeca' };
const notaMotor = { nota: 0.1, origem: 'base', reason: 'local:base (texto)', doMotor: true }; // full só porque o kairos propôs: a nota ficou abaixo do corte

test('carga à toa NOVA (tool): ref com nota.doMotor sai da carga nova (e só da nova: o total segue contando); o que o local trouxe pela nota e ninguém usou fica', () => {
  const full = ['agenda/tool/ler', 'memoria/tool/ler', 'memoria/tool/gravar', 'web/tool/ler'];
  // agenda/tool/ler é fixa (sem nota); memoria/* o kairos manteve (doMotor); web/tool/ler o local trouxe pela nota e ninguém usou
  const notas = { 'memoria/tool/ler': notaMotor, 'memoria/tool/gravar': notaMotor, 'web/tool/ler': notaLocal };
  const c = montarCaso({ ...base2, operacoes: [], selecao: { decisoes: { tool: { full, candidates: [], degradado: false, notas } } } });
  assert.equal(c.regra, REGRA_DO_CASO);
  assert.deepEqual(c.notas.tool['memoria/tool/ler'], notaMotor, 'a marca atravessa o montarCaso');
  assert.deepEqual(cargaNovaDe(c, 'tool'), ['web/tool/ler']);
  const r = conferir(c).tool;
  assert.deepEqual(r.cargaAToaNova, ['web/tool/ler']);
  assert.deepEqual(r.cargaAToa, full, 'o total não muda: compatível com os casos já gravados');
  // `doMotor` que não é o literal true não vale (o refinador só grava true)
  const falso = montarCaso({ ...base2, operacoes: [], selecao: { decisoes: { tool: { full: ['x/tool/a'], candidates: [], degradado: false, notas: { 'x/tool/a': { ...notaLocal, doMotor: 'sim' } } } } } });
  assert.deepEqual(cargaNovaDe(falso, 'tool'), ['x/tool/a']);
  // usada continua saindo, com ou sem a marca; capacidade usada também (carga junto)
  const usou = montarCaso({ ...base2, operacoes: [{ nome: 'web/tool/ler' }], selecao: { decisoes: { tool: { full, candidates: [], degradado: false, notas } } } });
  assert.deepEqual(cargaNovaDe(usou, 'tool'), []);
});

test('carga à toa NOVA (tool): caso sem o carimbo atual (v1 ou sem carimbo) não separa o que o motor manteve → null (n/d), nunca um número; o provider não depende do carimbo', () => {
  const notas = { 'memoria/tool/ler': notaMotor, 'web/tool/ler': notaLocal };
  const selecao = { decisoes: { tool: { full: ['memoria/tool/ler', 'web/tool/ler'], candidates: [], degradado: false, notas }, provider: { full: ['md-notes', 'agenda'], candidates: [], degradado: false, notas: { 'md-notes': notaLocal, agenda: { ...notaMotor } } } } };
  const atual = montarCaso({ ...base2, operacoes: [], selecao, ativasNoInicio: [] });
  assert.deepEqual([cargaNovaDe(atual, 'tool'), cargaNovaDe(atual, 'provider')], [['web/tool/ler'], ['md-notes']], 'provider: a capacidade com doMotor (carregada que nunca cai) também sai');
  for (const regra of ['cortes-composicao-v1', undefined, null, '']) {
    const antigo = { ...atual, regra };
    if (regra === undefined) delete antigo.regra;
    assert.equal(cargaNovaDe(antigo, 'tool'), null, `tool com regra ${JSON.stringify(regra)}`);
    assert.equal(conferir(antigo).tool.cargaAToaNova, null);
    assert.deepEqual(conferir(antigo).tool.cargaAToa, ['memoria/tool/ler', 'web/tool/ler'], 'o total não depende do carimbo');
    assert.deepEqual(cargaNovaDe(antigo, 'provider'), ['md-notes'], 'provider igual: não usa o carimbo');
  }
});

// Ponta a ponta do refinador ao caso (prova da revisão do conjunto, C1): memoria (capacidade do turno: piso / já ativa) tem as funções que o
// kairos propõe `full` com nota abaixo do corte; agenda é o que o local traz pela nota. As `notas` são montadas como `registrarDecisao` (selecao.js,
// executor) as grava — o teste dela, no executor, cobre o real, inclusive o caminho do refinador de verdade até `cargaNovaDe`.
async function decidirTool(cortes, propostaAgenda = 'candidate') {
  const caps = [
    { id: 'agenda', semanticText: 'agenda', tools: [{ name: 'listar', semanticText: 'agenda' }] },
    { id: 'memoria', semanticText: 'nota', tools: [{ name: 'ler', semanticText: 'nota' }, { name: 'gravar', semanticText: 'nota busca' }] },
    { id: 'busca', semanticText: 'busca', tools: [{ name: 'web', semanticText: 'busca' }] },
  ];
  const emb = embedderFalso();
  const ind = await montarIndice({ anel: 'tool', capacidades: caps, embedder: emb });
  assert.equal(ind.ok, true);
  const refinar = criarRefinadorLocal({ anel: 'tool', obterEstado: () => ({ indice: ind, cortes, cabeca: null, funcaoTraz: { ...FUNCAO_TRAZ_PADRAO }, minCasosCapacidade: 0 }) });
  const items = [
    { ref: 'agenda/tool/listar', position: 0, scores: {}, proposedTier: propostaAgenda, meta: {} },
    { ref: 'memoria/tool/ler', position: 1, scores: {}, proposedTier: 'full', meta: {} },
    { ref: 'memoria/tool/gravar', position: 2, scores: {}, proposedTier: 'full', meta: {} },
  ];
  const r = await refinar({
    ring: 'tool', query: { text: 'agenda', vectors: [await emb.embed('agenda')] }, items,
    proposal: { full: ['memoria/tool/ler', 'memoria/tool/gravar', ...(propostaAgenda === 'full' ? ['agenda/tool/listar'] : [])], candidates: propostaAgenda === 'candidate' ? ['agenda/tool/listar'] : [] },
    caps: { hard: { maxFull: 4, maxCandidates: 8 } }, state: { loadedProviders: ['memoria', 'agenda'] }, ctx: {}, budgetMs: 600,
  });
  const notas = {};
  for (const ref of [...r.full, ...r.candidates]) {
    const e = r.explain?.[ref];
    if (e && Number.isFinite(e.confidence)) notas[ref] = { nota: Math.round(e.confidence * 1e4) / 1e4, origem: 'base', reason: String(e.reason ?? '').slice(0, 80), ...(e.doMotor === true ? { doMotor: true } : {}) };
  }
  const caso = montarCaso({
    ts: '2026-10-08T12:00:00.000Z', interactionId: 'x', texto: 'agenda de amanhã', vetores: [[1, 0, 0, 0]], operacoes: [{ nome: 'busca/tool/web' }],
    selecao: { decisoes: { tool: { full: r.full, candidates: r.candidates, degradado: false, notas } } }, guardarTexto: false, ativasNoInicio: ['memoria', 'agenda'],
  });
  return { r, caso };
}

test('prova da revisão (C1): função que o kairos propõe full com nota abaixo do corte fica FORA da carga nova, e subir o corte não a move; a trazida pela nota e não usada fica DENTRO e sai com o corte alto', async () => {
  const padrao = await decidirTool({ cabeca: { ...CORTES_FIXOS.cabeca }, base: { ...CORTES_FIXOS.base }, promocao: CORTES_FIXOS.promocao });
  // corte acima de qualquer nota possível (o refinador não valida a faixa; só para mostrar o limite): nada entra pela nota
  const alto = await decidirTool({ cabeca: { full: 1.01, candidate: 1.005 }, base: { full: 1.01, candidate: 1.005 }, promocao: 1.01 });
  for (const [nome, { r, caso }] of Object.entries({ padrao, alto })) {
    assert.ok(r.full.includes('memoria/tool/ler') && r.full.includes('memoria/tool/gravar'), `${nome}: o local mantém o full do kairos ("tool nunca rebaixa")`);
    assert.equal(caso.notas.tool['memoria/tool/ler'].doMotor, true, `${nome}: e a marca vai à nota`);
    assert.equal(caso.notas.tool['memoria/tool/gravar'].doMotor, true, nome);
    const nova = cargaNovaDe(caso, 'tool');
    assert.ok(!nova.includes('memoria/tool/ler') && !nova.includes('memoria/tool/gravar'), `${nome}: as do kairos NÃO contam como carga nova`);
    assert.deepEqual(conferir(caso).tool.cargaAToaNova, nova);
  }
  // o local trouxe agenda/listar pela nota e ninguém a usou: é a carga nova (item a item, a única que o corte move — aqui há vaga sobrando no teto)
  assert.deepEqual(cargaNovaDe(padrao.caso, 'tool'), ['agenda/tool/listar']);
  assert.equal('doMotor' in padrao.caso.notas.tool['agenda/tool/listar'], false);
  assert.ok(!alto.r.full.includes('agenda/tool/listar'), 'o corte alto tira o que o local trouxe pela nota');
  assert.deepEqual(cargaNovaDe(alto.caso, 'tool'), [], 'item a item, a carga nova acompanha o corte — antes dependia de itens que o corte não move');
  // o total não foi tocado: continua contando as funções que o kairos manteve (a conferência as separa, não as apaga)
  assert.deepEqual(conferir(padrao.caso).tool.cargaAToa.sort(), ['agenda/tool/listar', 'memoria/tool/gravar', 'memoria/tool/ler']);
  // o mesmo caso gravado antes da marca (carimbo antigo): n/d
  assert.equal(cargaNovaDe({ ...padrao.caso, regra: 'cortes-composicao-v1' }, 'tool'), null);
});

test('carga à toa NOVA (tool) só tem o que o local trouxe pela nota: função com proposta full do kairos e nota ACIMA do corte (0,80 ≥ 0,35) leva doMotor e fica fora da nova — com o corte padrão e com o corte acima de tudo, o mesmo resultado (sem troca de rótulo)', async () => {
  const cortesPadrao = { cabeca: { ...CORTES_FIXOS.cabeca }, base: { ...CORTES_FIXOS.base }, promocao: CORTES_FIXOS.promocao };
  const cortesAltos = { cabeca: { full: 1.01, candidate: 1.005 }, base: { full: 1.01, candidate: 1.005 }, promocao: 1.01 };
  const padrao = await decidirTool(cortesPadrao, 'full');
  const alto = await decidirTool(cortesAltos, 'full');
  const agenda = 'agenda/tool/listar';
  assert.ok(padrao.caso.notas.tool[agenda].nota >= CORTES_FIXOS.base.full, 'pré-condição: no corte padrão a nota do local também aprova a função');
  for (const [nome, { r, caso }] of Object.entries({ padrao, alto })) {
    assert.ok(r.full.includes(agenda), `${nome}: o tool não rebaixa a proposta full`);
    assert.equal(caso.notas.tool[agenda].doMotor, true, `${nome}: a marca vale com qualquer nota — o full dela não depende do corte`);
    assert.deepEqual(cargaNovaDe(caso, 'tool'), [], `${nome}: fora da carga nova (e as de memoria também)`);
  }
  // a mesma função, mas SÓ o local a traz (o kairos propunha candidate): conta no corte padrão e sai com o corte alto — item a item, é isto que o corte move
  const soLocal = await decidirTool(cortesPadrao, 'candidate');
  assert.deepEqual(cargaNovaDe(soLocal.caso, 'tool'), [agenda]);
  assert.deepEqual(cargaNovaDe((await decidirTool(cortesAltos, 'candidate')).caso, 'tool'), []);
});

test('load_capability com nome exposto cap__fn conta pela capacidade (nomes prefixados, 10/10)', () => {
  const c = montarCaso({
    ts: 't', texto: 'abre o site', vetores: [[1, 0, 0]], guardarTexto: true,
    operacoes: [{ nome: 'load_capability', args: { refs: ['navegador__abrir_navegador', 'navegador__navegar', 'mcp-justwatch__mcp_justwatch_search_content'] } }],
    selecao: { sombras: [sel('provider', [])] },
  });
  assert.deepEqual(c.pedidasPelaLlm.sort(), ['mcp-justwatch', 'navegador']);
  assert.deepEqual(c.usadas.capacidades.sort(), ['mcp-justwatch', 'navegador']);
});

test('montarCaso: mcp_chamar_tool com servidor conta como mcp-<servidor>', () => {
  const c = montarCaso({
    ts: 't', texto: 'liga o ar', vetores: [[1, 0, 0]], guardarTexto: true,
    operacoes: [{ nome: 'mcp_chamar_tool', args: { servidor: 'home_assistant', tool: 'intent__HassTurnOn' }, ok: true }],
    selecao: { sombras: [sel('provider', [])] },
  });
  assert.ok(c.usadas.capacidades.includes('mcp-home-assistant'));
  assert.ok(!c.usadas.capacidades.includes('mcp'));
  assert.deepEqual(c.usadas.funcoesCruas, []);
  assert.deepEqual(c.usadas.funcoes, []);
});

test('montarCaso: nome exposto mcp__mcp_chamar_tool com servidor conta só mcp-<servidor>', () => {
  const c = montarCaso({
    ts: 't', texto: 'liga o ar', vetores: [[1, 0, 0]], guardarTexto: true,
    operacoes: [{ nome: 'mcp__mcp_chamar_tool', args: { servidor: 'justwatch', tool: 'busca' }, ok: true }],
    selecao: { sombras: [sel('provider', [])] },
  });
  assert.deepEqual(c.usadas.capacidades, ['mcp-justwatch']);
  assert.deepEqual(c.usadas.funcoes, []);
  assert.deepEqual(c.usadas.funcoesCruas, []);
});

test('montarCaso: operação do Jev com servidor conta só a capacidade (uso e lidasPeloLoop)', () => {
  const c = montarCaso({
    ts: 't', texto: 'liga o ar', vetores: [[1, 0, 0]], guardarTexto: true,
    operacoes: [{ origem: 'jev', nome: 'mcp_chamar_tool', args: { servidor: 'home_assistant', tool: 'x' }, ok: true }],
    selecao: { sombras: [sel('provider', [])] },
  });
  assert.deepEqual(c.usadas.capacidades, ['mcp-home-assistant']);
  assert.deepEqual(c.usadas.funcoes, []);
  assert.deepEqual(c.usadas.funcoesCruas, []);
  assert.deepEqual(c.lidasPeloLoop.capacidades, ['mcp-home-assistant']);
  assert.deepEqual(c.lidasPeloLoop.funcoes, []);
});

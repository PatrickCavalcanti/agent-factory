import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gravarCaso, lerCasos, marcarValido, zerarContador, lerEstado, arquivoDoRegistro, retratoDoContador, rotacionarRegistro, registrarFalhaDoAnel, estadoDoAnel, chaveDoCaso, lerCasosAsync, marcarAdiadaDoAnel, reconciliarEstado } from '../treino/lib/registro.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'reg-'));
const caso = (n, extra = {}) => ({ ts: `2026-10-07T10:00:${String(n).padStart(2, '0')}`, n, ...extra });

test('grava em casos.jsonl e respeita o limite (5 mais recentes, em ordem); a rotação é separada e assíncrona', async () => {
  const dir = tmp();
  let pedida = false;
  for (let n = 1; n <= 8; n++) { const r = gravarCaso(dir, caso(n), { tamanho: 5 }); assert.equal(r.ok, true); if (r.rotacionar) pedida = true; }
  assert.equal(pedida, true, 'passou de tamanho*1.2: gravarCaso pede a rotação mas não a faz');
  assert.ok(readFileSync(arquivoDoRegistro(dir), 'utf8').trim().split('\n').length > 6, 'o turno não reescreve o arquivo');
  assert.deepEqual(lerCasos(dir).map((c) => c.n), [4, 5, 6, 7, 8], 'a leitura já respeita o limite antes da rotação');
  const r = await rotacionarRegistro(dir, 5);
  assert.equal(r.ok, true);
  assert.deepEqual(readFileSync(arquivoDoRegistro(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l).n), [4, 5, 6, 7, 8]);
  assert.equal(lerEstado(dir).linhas, 5);
});

test('rotação com volume: 1500 linhas com vetor, mantém as 1000 últimas; o que entra DURANTE a cópia não se perde; estado não depende dela', async () => {
  const dir = tmp();
  const vetor = Array.from({ length: 256 }, (_, i) => i / 1000);
  for (let n = 1; n <= 1500; n++) gravarCaso(dir, { ts: `2026-10-07T10:00:00.${String(n).padStart(4, '0')}`, n, vetores: [vetor], triagem: { valido: true } }, { tamanho: 1000 });
  assert.equal(lerEstado(dir).validosDesdeUltima, 1500);
  const p = rotacionarRegistro(dir, 1000);
  // gravações enquanto a cópia assíncrona corre
  gravarCaso(dir, { ts: '2026-10-07T10:00:01.0001', n: 1501, vetores: [vetor], triagem: { valido: true } }, { tamanho: 1000 });
  gravarCaso(dir, { ts: '2026-10-07T10:00:01.0002', n: 1502, vetores: [vetor], triagem: { valido: true } }, { tamanho: 1000 });
  const r = await p;
  assert.equal(r.ok, true, r.erro);
  const ns = readFileSync(arquivoDoRegistro(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l).n);
  assert.equal(ns[0], 501);
  assert.deepEqual(ns.slice(-2), [1501, 1502]);
  assert.equal(ns.length, 1002);
  assert.equal(lerEstado(dir).linhas, 1002);
  assert.equal(lerEstado(dir).validosDesdeUltima, 1502, 'o contador não é tocado pela rotação');
  assert.equal((await rotacionarRegistro(dir, 1000)).ok, true);
  assert.equal(readFileSync(arquivoDoRegistro(dir), 'utf8').trim().split('\n').length, 1000);
});

test('contador e cursor são POR ANEL: zerar só os anéis que treinaram; backoff exponencial com teto, persistido', () => {
  const dir = tmp();
  for (let n = 1; n <= 4; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  assert.deepEqual([estadoDoAnel(dir, 'provider').validos, estadoDoAnel(dir, 'tool').validos], [4, 4]);
  const retrato = retratoDoContador(dir);
  assert.deepEqual(retrato.aneis, { provider: 4, tool: 4 });
  gravarCaso(dir, caso(5, { triagem: { valido: true } })); // chega durante a atualização
  zerarContador(dir, { versao: 2, consumidos: retrato, aneis: ['provider'] });
  const e = lerEstado(dir);
  assert.equal(e.aneis.provider.validos, 1);
  assert.equal(e.aneis.provider.cursor, caso(4).ts);
  assert.equal(e.aneis.tool.validos, 5, 'o anel que falhou/adiou mantém contador');
  assert.equal(e.aneis.tool.cursor, null, 'e cursor');
  const passos = []; // backoff: 10, 20, 40 ... teto 400
  for (let i = 0; i < 8; i++) { registrarFalhaDoAnel(dir, 'tool', { base: 10, teto: 400 }); const a = estadoDoAnel(dir, 'tool'); passos.push(a.tentativaEm - a.validos); }
  assert.deepEqual(passos, [10, 20, 40, 80, 160, 320, 400, 400]);
  zerarContador(dir, { consumidos: retratoDoContador(dir), aneis: ['tool'] });
  assert.deepEqual([estadoDoAnel(dir, 'tool').falhas, estadoDoAnel(dir, 'tool').tentativaEm], [0, 0], 'sucesso zera o backoff');
});

test('estado antigo (sem aneis) migra do contador e do cursor globais', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'estado.json'), JSON.stringify({ validosDesdeUltima: 7, ultimaAtualizacao: '2026-10-07T09:00:00.000Z', linhas: 7 }));
  assert.equal(estadoDoAnel(dir, 'provider').validos, 7);
  assert.equal(estadoDoAnel(dir, 'tool').cursor, '2026-10-07T09:00:00.000Z');
});

test('chaveDoCaso: interactionId, chave gravada, ou ts + sessão + hash (estável, distingue textos)', () => {
  assert.equal(chaveDoCaso({ interactionId: 'i1' }), 'i1');
  assert.equal(chaveDoCaso({ chave: 'k', interactionId: 'i1' }), 'k');
  const a = { ts: 't', sessionId: 's', texto: 'um pedido' };
  assert.equal(chaveDoCaso(a), chaveDoCaso({ ...a }));
  assert.notEqual(chaveDoCaso(a), chaveDoCaso({ ...a, texto: 'outro pedido' }));
  assert.notEqual(chaveDoCaso({ ts: 't', vetores: [[1, 2]] }), chaveDoCaso({ ts: 't', vetores: [[1, 3]] }));
});

test('lerCasos com validos pula o parse das linhas inválidas e leve não traz vetor nem texto', () => {
  const dir = tmp();
  for (let n = 1; n <= 20; n++) gravarCaso(dir, caso(n, { vetores: [[n]], texto: 'p', triagem: { valido: n % 5 === 0 } }));
  const parse = JSON.parse; let chamadas = 0;
  JSON.parse = (...a) => { chamadas++; return parse(...a); };
  let r;
  try { r = lerCasos(dir, { validos: true, leve: true }); } finally { JSON.parse = parse; }
  assert.deepEqual(r.map((c) => c.n), [5, 10, 15, 20]);
  assert.ok(chamadas <= 5, `parseou ${chamadas}`); // 4 válidas + o estado.json
  assert.equal(r[0].vetores, undefined);
  assert.equal(r[0].texto, undefined);
  // com desde, as inválidas também não são parseadas e o corte por ts continua valendo
  assert.deepEqual(lerCasos(dir, { validos: true, desde: caso(10).ts }).map((c) => c.n), [15, 20]);
});

test('contador: marcarValido incrementa, zerarContador zera e guarda versão; estado ausente/corrompido = padrão', () => {
  const dir = tmp();
  assert.equal(lerEstado(dir).validosDesdeUltima, 0);
  marcarValido(dir); marcarValido(dir);
  assert.equal(lerEstado(dir).validosDesdeUltima, 2);
  zerarContador(dir, { versao: 3, quando: '2026-10-07T12:00:00' });
  const e = lerEstado(dir);
  assert.equal(e.validosDesdeUltima, 0);
  assert.equal(e.ultimaAtualizacao, '2026-10-07T12:00:00');
  assert.equal(e.versao, 3);
  writeFileSync(join(dir, 'estado.json'), '{corrompido');
  assert.equal(lerEstado(dir).validosDesdeUltima, 0);
});

test('janela: desde filtra os posteriores ao ts; validos filtra pela triagem; linha corrompida é ignorada', () => {
  const dir = tmp();
  gravarCaso(dir, caso(1, { triagem: { valido: true } }));
  gravarCaso(dir, caso(2, { triagem: { valido: false } }));
  gravarCaso(dir, caso(3, { triagem: { valido: true } }));
  writeFileSync(arquivoDoRegistro(dir), `${readFileSync(arquivoDoRegistro(dir), 'utf8')}lixo{\n`);
  assert.deepEqual(lerCasos(dir, { desde: caso(1).ts }).map((c) => c.n), [2, 3]);
  assert.deepEqual(lerCasos(dir, { validos: true }).map((c) => c.n), [1, 3]);
  assert.deepEqual(lerCasos(dir, { ultimos: 1 }).map((c) => c.n), [3]);
});

test('nunca lança por I/O: diretório impossível devolve {ok:false}; leitura de dir inexistente devolve vazio', () => {
  const dir = tmp();
  const arqComoDir = join(dir, 'arquivo');
  writeFileSync(arqComoDir, 'x');
  const r = gravarCaso(join(arqComoDir, 'sub'), caso(1));
  assert.equal(r.ok, false);
  assert.ok(r.erro);
  assert.equal(marcarValido(join(arqComoDir, 'sub')).ok, false);
  assert.deepEqual(lerCasos(join(dir, 'nao-existe')), []);
});

test('gravarCaso com válido incrementa o contador na mesma gravação do estado (triagem.valido ou opção explícita)', () => {
  const dir = tmp();
  gravarCaso(dir, caso(1, { triagem: { valido: true } }));
  gravarCaso(dir, caso(2, { triagem: { valido: false } }));
  gravarCaso(dir, caso(3), { valido: true });
  gravarCaso(dir, caso(4, { triagem: { valido: true } }), { valido: false });
  const e = lerEstado(dir);
  assert.equal(e.validosDesdeUltima, 2);
  assert.equal(e.linhas, 4);
});

test('lerCasos com desde lê do fim e para no primeiro ts <= desde (não parseia o arquivo inteiro)', () => {
  const dir = tmp();
  for (let n = 1; n <= 300; n++) gravarCaso(dir, { ts: `2026-10-07T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`, n });
  const parse = JSON.parse; let chamadas = 0;
  JSON.parse = (...a) => { chamadas++; return parse(...a); };
  let achados;
  try { achados = lerCasos(dir, { desde: '2026-10-07T10:04:57' }); } finally { JSON.parse = parse; }
  assert.deepEqual(achados.map((c) => c.n), [298, 299, 300]);
  assert.ok(chamadas <= 5, `parseou ${chamadas} linhas`);
});

test('leitura da cauda atravessa vários blocos de 64KB e texto multibyte sem corromper', () => {
  const dir = tmp();
  const texto = 'ação não é emoção '.repeat(40);
  for (let n = 1; n <= 400; n++) gravarCaso(dir, { ts: `2026-10-07T10:00:00.${String(n).padStart(4, '0')}`, n, texto });
  assert.ok(readFileSync(arquivoDoRegistro(dir)).length > 3 * 64 * 1024);
  const todos = lerCasos(dir);
  assert.equal(todos.length, 400);
  assert.deepEqual(todos.map((c) => c.n), Array.from({ length: 400 }, (_, i) => i + 1));
  assert.ok(todos.every((c) => c.texto === texto));
  assert.deepEqual(lerCasos(dir, { desde: '2026-10-07T10:00:00.0390' }).length, 10);
});

test('contador sem perda: zerar subtrai os consumidos, grava o ts do último consumido e mantém o que chegou durante', () => {
  const dir = tmp();
  for (let n = 1; n <= 3; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  const retrato = retratoDoContador(dir);
  assert.equal(retrato.n, 3);
  assert.equal(retrato.ts, caso(3).ts);
  assert.equal(retrato.ids.length, 1);
  // chegam casos DURANTE a atualização
  gravarCaso(dir, caso(4, { triagem: { valido: true } }));
  gravarCaso(dir, caso(5, { triagem: { valido: false } }));
  zerarContador(dir, { versao: 2, consumidos: retrato });
  const e = lerEstado(dir);
  assert.equal(e.validosDesdeUltima, 1);
  assert.equal(e.ultimaAtualizacao, caso(3).ts); // não "agora"
  assert.equal(e.versao, 2);
  // o próximo lote só pega os posteriores ao último consumido
  assert.deepEqual(lerCasos(dir, { desde: e.ultimaAtualizacao, validos: true }).map((c) => c.n), [4]);
  // consumidos maiores que o contador não deixam negativo
  zerarContador(dir, { consumidos: { n: 99, ts: caso(5).ts } });
  assert.equal(lerEstado(dir).validosDesdeUltima, 0);
});

test('M4: estado.json que falha DEPOIS do append: o caso está gravado, devolve estadoFalhou e reconciliarEstado refaz linhas e contador a partir do registro', async () => {
  const dir = tmp();
  gravarCaso(dir, caso(1, { triagem: { valido: true } }));
  mkdirSync(join(dir, 'estado.json.tmp')); // escrever o tmp do estado falha
  const r = gravarCaso(dir, caso(2, { triagem: { valido: true } }));
  const r2 = gravarCaso(dir, caso(3, { triagem: { valido: false } }));
  assert.deepEqual([r.ok, !!r.estadoFalhou, r2.ok, !!r2.estadoFalhou], [true, true, true, true]);
  assert.equal(lerCasos(dir).length, 3);
  assert.equal(lerEstado(dir).linhas, 1, 'o estado ficou para trás');
  rmSync(join(dir, 'estado.json.tmp'), { recursive: true });
  const r3 = gravarCaso(dir, caso(4, { triagem: { valido: true } }));
  assert.equal(r3.estadoFalhou, undefined);
  const rec = await reconciliarEstado(dir);
  assert.deepEqual([rec.ok, rec.ajustado], [true, true]);
  const e = lerEstado(dir);
  assert.deepEqual([e.linhas, e.validosDesdeUltima, e.aneis.provider.validos, e.aneis.tool.validos], [4, 3, 3, 3]);
  assert.deepEqual(await reconciliarEstado(dir), { ok: true, ajustado: false }, 'sem divergência não escreve');
});

test('reconciliarEstado conta os válidos DEPOIS do cursor de cada anel (cursor perdido de um, presente no outro)', async () => {
  const dir = tmp();
  for (let n = 1; n <= 5; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  writeFileSync(join(dir, 'estado.json'), JSON.stringify({ linhas: 2, tamanho: 20000, aneis: { provider: { validos: 9, cursor: caso(3).ts, ids: [] }, tool: { validos: 9, cursor: null, ids: [] } } }));
  await reconciliarEstado(dir);
  const e = lerEstado(dir);
  assert.deepEqual([e.linhas, e.aneis.provider.validos, e.aneis.tool.validos], [5, 2, 5]);
});

test('lerCasosAsync = lerCasos (mesmo resultado) e devolve o controle ao event loop durante a leitura', async () => {
  const dir = tmp();
  for (let n = 1; n <= 300; n++) gravarCaso(dir, caso(n % 60, { n, vetores: [Array.from({ length: 64 }, (_, i) => i / 100)], triagem: { valido: n % 3 === 0 } }));
  const igual = await lerCasosAsync(dir, { validos: true, leve: true, lote: 10 });
  assert.deepEqual(igual.map((c) => c.n), lerCasos(dir, { validos: true, leve: true }).map((c) => c.n));
  let ticks = 0; const t = setInterval(() => ticks++, 0);
  await lerCasosAsync(dir, { validos: true, lote: 10 });
  clearInterval(t);
  assert.ok(ticks > 0, 'o event loop rodou durante a leitura');
});

test('marcarAdiadaDoAnel grava e limpa o motivo no estado, sem tocar no resto', () => {
  const dir = tmp();
  gravarCaso(dir, caso(1, { triagem: { valido: true } }));
  marcarAdiadaDoAnel(dir, 'provider', 'sem-base');
  assert.deepEqual([estadoDoAnel(dir, 'provider').adiada, estadoDoAnel(dir, 'provider').validos, estadoDoAnel(dir, 'tool').adiada], ['sem-base', 1, null]);
  marcarAdiadaDoAnel(dir, 'provider', null);
  assert.equal(estadoDoAnel(dir, 'provider').adiada, null);
});

test('I3/M1: reconciliarEstado não restaura cursor antigo — se o estado mudou durante a recontagem, descarta e refaz', async () => {
  const dir = tmp();
  for (let n = 1; n <= 5; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  writeFileSync(join(dir, 'estado.json'), JSON.stringify({ linhas: 1, tamanho: 20000, aneis: { provider: { validos: 9, cursor: null, ids: [] }, tool: { validos: 9, cursor: null, ids: [] } } }));
  let vezes = 0;
  const r = await reconciliarEstado(dir, { aposContar: async () => {
    if (vezes++) return;
    // no meio da recontagem uma rodada consome os 3 primeiros do provider (zerarContador, o mesmo que ela faz)
    zerarContador(dir, { versao: 2, consumidos: { n: 3, ts: caso(3).ts, ids: [], aneis: { provider: 3 } }, aneis: ['provider'] });
  } });
  assert.equal(r.ok, true, r.erro);
  assert.ok(vezes >= 2, 'a primeira passada foi descartada e refeita');
  const e = lerEstado(dir);
  assert.equal(e.aneis.provider.cursor, caso(3).ts, 'o cursor novo NÃO foi sobrescrito pelo antigo');
  assert.deepEqual([e.linhas, e.aneis.provider.validos, e.aneis.tool.validos], [5, 2, 5], 'e o contador foi recontado depois do cursor novo');
});

test('M1: arquivo que cresce durante a recontagem também descarta a passada (conferência síncrona do tamanho antes de escrever)', async () => {
  const dir = tmp();
  for (let n = 1; n <= 3; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  writeFileSync(join(dir, 'estado.json'), JSON.stringify({ linhas: 1, tamanho: 20000 }));
  let vezes = 0;
  const r = await reconciliarEstado(dir, { aposContar: async () => { if (vezes++ === 0) appendFileSync(arquivoDoRegistro(dir), `${JSON.stringify(caso(4, { triagem: { valido: true } }))}\n`); } });
  assert.equal(r.ok, true, r.erro);
  assert.equal(lerEstado(dir).linhas, 4, 'contou também o que entrou durante a primeira passada');
});

test('D5: marcarAdiadaDoAnel guarda `avaliacao` {n, minimo} junto do adiamento e a limpa com ele (ou ao trocar de motivo)', () => {
  const dir = tmp();
  gravarCaso(dir, caso(1, { triagem: { valido: true } }));
  assert.equal(estadoDoAnel(dir, 'provider').avaliacao, null, 'sem adiamento por avaliação: null (contrato lido pela conferência)');
  marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes-avaliacao', { tentativaEm: 6, avaliacao: { n: 2, minimo: 30 } });
  let e = estadoDoAnel(dir, 'provider');
  assert.deepEqual([e.adiada, e.tentativaEm, e.avaliacao], ['poucos-recentes-avaliacao', 6, { n: 2, minimo: 30 }]);
  assert.equal(estadoDoAnel(dir, 'tool').avaliacao, null, 'o outro anel não é tocado');
  // a contagem mudou com o mesmo motivo e a mesma tentativaEm: grava de novo (não é "igual")
  assert.equal(marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes-avaliacao', { tentativaEm: 6, avaliacao: { n: 3, minimo: 30 } }).igual, undefined);
  assert.deepEqual(estadoDoAnel(dir, 'provider').avaliacao, { n: 3, minimo: 30 });
  // idêntico: não reescreve
  assert.equal(marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes-avaliacao', { tentativaEm: 6, avaliacao: { n: 3, minimo: 30 } }).igual, true);
  // n desconhecido (null) é guardado como está: o texto da conferência decide o que dizer
  marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes', { tentativaEm: 6, avaliacao: { n: null, minimo: 30 } });
  assert.deepEqual(estadoDoAnel(dir, 'provider').avaliacao, { n: null, minimo: 30 });
  // trocar para outro motivo (sem-base) ou limpar (null) leva `avaliacao` junto
  marcarAdiadaDoAnel(dir, 'provider', 'sem-base');
  assert.equal(estadoDoAnel(dir, 'provider').avaliacao, null);
  marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes-avaliacao', { tentativaEm: 6, avaliacao: { n: 2, minimo: 30 } });
  marcarAdiadaDoAnel(dir, 'provider', null);
  e = estadoDoAnel(dir, 'provider');
  assert.deepEqual([e.adiada, e.avaliacao], [null, null]);
  // estado antigo (sem o campo) lê como null
  writeFileSync(join(dir, 'estado.json'), JSON.stringify({ aneis: { provider: { validos: 1, cursor: null, ids: [], adiada: 'sem-base' } } }));
  assert.equal(estadoDoAnel(dir, 'provider').avaliacao, null);
});

test('D5: zerarContador de um anel que avançou limpa `avaliacao` junto com `adiada`', () => {
  const dir = tmp();
  for (let n = 1; n <= 3; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  marcarAdiadaDoAnel(dir, 'provider', 'poucos-recentes-avaliacao', { tentativaEm: 9, avaliacao: { n: 1, minimo: 30 } });
  marcarAdiadaDoAnel(dir, 'tool', 'poucos-recentes-avaliacao', { tentativaEm: 9, avaliacao: { n: 1, minimo: 30 } });
  zerarContador(dir, { versao: 2, consumidos: retratoDoContador(dir), aneis: ['provider'] });
  assert.deepEqual([estadoDoAnel(dir, 'provider').adiada, estadoDoAnel(dir, 'provider').avaliacao], [null, null]);
  assert.deepEqual(estadoDoAnel(dir, 'tool').avaliacao, { n: 1, minimo: 30 }, 'quem não avançou mantém o adiamento');
});

test('D1: zerarContador com `porAnel` consome só os incluídos no anel (desconta n, cursor e ids dele); os outros seguem o `consumidos` global; o global vira o MAIOR contador entre os anéis', () => {
  const dir = tmp();
  for (let n = 1; n <= 10; n++) gravarCaso(dir, caso(n, { triagem: { valido: true }, interactionId: `i${n}` }));
  const retrato = retratoDoContador(dir);
  assert.deepEqual([retrato.n, retrato.aneis.provider, retrato.aneis.tool], [10, 10, 10]);
  // o provider levou só os 4 primeiros; o tool seguiu o consumo total do retrato
  zerarContador(dir, { versao: 2, consumidos: retrato, aneis: ['provider', 'tool'], porAnel: { provider: { n: 4, ts: caso(4).ts, ids: ['i4'] } } });
  let e = lerEstado(dir);
  assert.deepEqual([e.aneis.provider.validos, e.aneis.provider.cursor, e.aneis.provider.ids], [6, caso(4).ts, ['i4']]);
  assert.deepEqual([e.aneis.tool.validos, e.aneis.tool.cursor, e.aneis.tool.ids], [0, caso(10).ts, ['i10']]);
  assert.equal(e.validosDesdeUltima, 6, 'o global é o maior contador entre os anéis (o que ainda falta para o mais atrasado)');
  assert.equal(e.versao, 2);
  // o que chegou depois do retrato continua contado, em cima do que sobrou
  gravarCaso(dir, caso(11, { triagem: { valido: true }, interactionId: 'i11' }));
  assert.deepEqual([lerEstado(dir).aneis.provider.validos, lerEstado(dir).aneis.tool.validos, lerEstado(dir).validosDesdeUltima], [7, 1, 7]);
  // o resto do provider drena na rodada seguinte (sem `porAnel` para ele = consumo total do retrato dele)
  const r2 = retratoDoContador(dir);
  zerarContador(dir, { versao: 3, consumidos: r2, aneis: ['provider'], porAnel: {} });
  e = lerEstado(dir);
  assert.deepEqual([e.aneis.provider.validos, e.aneis.provider.cursor, e.aneis.tool.validos], [0, caso(11).ts, 1]);
  assert.equal(e.validosDesdeUltima, 1);
  // `n` maior que o contador não deixa negativo
  zerarContador(dir, { consumidos: retratoDoContador(dir), aneis: ['tool'], porAnel: { tool: { n: 99, ts: caso(11).ts, ids: ['i11'] } } });
  assert.equal(lerEstado(dir).aneis.tool.validos, 0);
});

test('D1: sem `porAnel` o contrato do `consumidos` global não muda (o treino completo do servico.js): o global desconta o retrato inteiro', () => {
  const dir = tmp();
  for (let n = 1; n <= 3; n++) gravarCaso(dir, caso(n, { triagem: { valido: true } }));
  zerarContador(dir, { versao: 1, consumidos: retratoDoContador(dir), aneis: ['provider'] });
  const e = lerEstado(dir);
  assert.deepEqual([e.validosDesdeUltima, e.aneis.provider.validos, e.aneis.tool.validos], [0, 0, 3]);
});

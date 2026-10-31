import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';
import { resolverProtocolo } from '../src/protocolo/index.js';

test('estrategiaEnvelope declara json_output e a variante headless', () => {
  const e = estrategiaEnvelope({ headless: true });
  assert.equal(e.id, 'envelope');
  assert.equal(e.toolProtocol, 'json_output');
  assert.equal(e.schema().name, 'envelope_headless');
});

test('estrategiaEnvelope com prefixoDoEnvelope prefixa o nome do schema', () => {
  assert.equal(estrategiaEnvelope({ headless: true, prefixoDoEnvelope: 'igris' }).schema().name, 'igris_envelope_headless');
  assert.equal(estrategiaEnvelope({ headless: false, prefixoDoEnvelope: 'igris' }).schema().name, 'igris_envelope');
  assert.equal(resolverProtocolo('envelope', { headless: true, prefixoDoEnvelope: 'x' }).schema().name, 'x_envelope_headless');
});

test('a seção invariante NÃO menciona campos de forma do host', () => {
  // `blocos` e `comandos` NÃO entram aqui: são exigência do PARSER do genos
  // (`parseJsonOutputToolCalls` faz `Array.isArray(parsed.blocos)` e depois lê
  // `bloco.comandos`), não forma do host — o texto tem que nomeá-los. `_fala`,
  // `layout` e `load_bundle` são os campos de forma de verdade: o schema do
  // Igris os define, o parser do genos não os conhece.
  const { conteudo } = estrategiaEnvelope().secaoInvariante();
  for (const campo of ['_fala', 'layout', 'load_bundle']) {
    assert.ok(!conteudo.includes(campo), `invariante vazou o campo de forma "${campo}"`);
  }
});

test('a seção invariante ensina args como string JSON', () => {
  const { conteudo } = estrategiaEnvelope().secaoInvariante();
  assert.ok(conteudo.includes('"args": "{}"'));

  // Direcional: `.includes('"args": "{}"')` sozinho continua verdadeiro se a
  // frase for invertida para "Mesmo sem argumento: `"args": {}`, nunca
  // `"args": "{}"`." — as duas substrings continuam presentes, só trocam de
  // papel. Capturar a sentença inteira e checar QUAL lado é o afirmado (antes
  // de "nunca") e qual é o negado (depois) é o que sobrevive à troca de ordem.
  const exemploInline = /Mesmo sem\s+argumento: `"args": (.+?)`, nunca `"args": (.+?)`\./.exec(conteudo);
  assert.ok(exemploInline, 'a sentença "Mesmo sem argumento" não foi encontrada como esperado');
  assert.equal(exemploInline[1], '"{}"', 'a forma AFIRMADA em "Mesmo sem argumento" não é a string vazia');
  assert.equal(exemploInline[2], '{}', 'a forma NEGADA em "Mesmo sem argumento" não é o objeto vazio');

  // Mesma lógica para a regra geral (frase separada, antes do exemplo inline):
  // "`args` é sempre uma string contendo JSON — nunca um objeto direto". Uma
  // inversão ("é sempre um objeto — nunca uma string") não muda quais palavras
  // aparecem no texto, só a ordem/lado — por isso o regex captura os dois lados
  // e cada um é checado contra o termo esperado.
  const regra = /`args` é sempre (.+?) — nunca (.+?) —,/.exec(conteudo);
  assert.ok(regra, 'a regra geral de `args` não foi encontrada como esperado');
  assert.match(regra[1], /string/i, 'o lado AFIRMADO da regra geral de `args` não fala de string');
  assert.match(regra[2], /objeto/i, 'o lado NEGADO da regra geral de `args` não fala de objeto');
});

const TOOL_PROTOCOL_ESPERADO = {
  envelope: 'json_output',
  fence: 'command_fence',
  nativo: 'provider_native',
};

test('as três estratégias honram a mesma forma de contrato', () => {
  for (const id of ['envelope', 'fence', 'nativo']) {
    const e = resolverProtocolo(id);
    assert.equal(e.id, id);
    assert.equal(typeof e.toolProtocol, 'string');
    // Valor exato, não só "é string": `toolProtocol` é o campo que o genos usa
    // pra ESCOLHER o parser (json_output local vs command_fence no texto vs
    // provider_native no schema da tool). Trocar o valor de uma estratégia pela
    // de outra não muda o tipo — só muda qual parser roda contra um texto que
    // ensina outro formato, e é exatamente essa divergência que o round-trip
    // (protocolo-parser.test.js) prova em tempo de execução para envelope e
    // fence; aqui é a garantia estrutural, barata, que cobre as três de uma vez.
    assert.equal(
      e.toolProtocol,
      TOOL_PROTOCOL_ESPERADO[id],
      `toolProtocol de "${id}" deveria ser "${TOOL_PROTOCOL_ESPERADO[id]}"`,
    );
    assert.equal(typeof e.secaoInvariante, 'function');
    assert.equal(typeof e.schema, 'function');
    assert.equal(typeof e.extrairTexto, 'function', `extrairTexto de "${id}" não é função`);
    const secao = e.secaoInvariante();
    assert.ok(secao === null || (typeof secao.nome === 'string' && typeof secao.conteudo === 'string'));

    // `forceFinishMessage` é a saída de emergência perto de maxIterations: o
    // genos só injeta o aviso de limite de turnos quando `config.finishTool ||
    // config.forceFinishMessage` é truthy (orchestrator.ts, executeLoop). Uma
    // mutação que anula esse campo em silêncio remove essa saída sem quebrar
    // nenhum outro teste estrutural — por isso a forma tem que ser afirmada
    // aqui, e não só "é string ou null" solto.
    assert.ok(
      e.forceFinishMessage === null || (typeof e.forceFinishMessage === 'string' && e.forceFinishMessage.length > 0),
      `forceFinishMessage de "${id}" não é string não-vazia nem null`,
    );
    if (id === 'envelope' || id === 'fence') {
      assert.ok(
        typeof e.forceFinishMessage === 'string' && e.forceFinishMessage.length > 0,
        `forceFinishMessage de "${id}" deveria ser string não-vazia (é a saída de emergência do loop)`,
      );
    }
  }
});

test('protocolo desconhecido lança com a lista dos conhecidos', () => {
  assert.throws(() => resolverProtocolo('xml'), /Conhecidos: envelope, fence, nativo/);
});

// Correção 1 (Fase 4, paridade): `resultado.value` do genos, em `envelope`, é
// o `{"blocos":[...]}` inteiro — não o texto que o modelo escreveu para o
// leitor. `extrairTexto` é quem desembrulha, e cada estratégia tem uma regra
// própria (junção dos `chat` em envelope; identidade nas outras duas).
test('extrairTexto: envelope junta os `chat` não-nulos dos blocos', () => {
  const { extrairTexto } = estrategiaEnvelope();
  const cru = JSON.stringify({
    blocos: [
      { chat: 'primeira parte', comandos: [] },
      { chat: null, comandos: [{ tool: 'x', args: '{}' }] },
      { chat: 'segunda parte', comandos: [] },
    ],
  });
  assert.equal(extrairTexto(cru), 'primeira parte\n\nsegunda parte');
});

test('extrairTexto: envelope malformado degrada para o texto cru em vez de lançar', () => {
  const { extrairTexto } = estrategiaEnvelope();
  assert.equal(extrairTexto('isto não é JSON'), 'isto não é JSON');
});

test('extrairTexto: fence e nativo devolvem o texto como veio (o texto de fechamento já é prosa)', () => {
  for (const id of ['fence', 'nativo']) {
    const { extrairTexto } = resolverProtocolo(id);
    assert.equal(extrairTexto('texto de fechamento do turno'), 'texto de fechamento do turno');
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * Cauda efêmera na costura do orquestrador (spec 2026-10-29 §4, plano Task 2.2).
 *
 * Harness copiado de `hidratacao-entre-turnos.test.js`: provider falso que devolve textos em
 * sequência, capacidades de mentira, dois turnos seguidos com o `estado` de um passando ao outro.
 * Regra do harness: o turno 1 seleciona `whatsapp` pelo RANKING (texto idêntico ao `semanticText`),
 * e o turno 2 fala de outro assunto — o que aparecer de `whatsapp` no turno 2 persistiu ou foi
 * promovido, não veio do ranking de novo.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };

function providerDeTexto(textos) {
  let i = 0;
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() { const t = textos[Math.min(i, textos.length - 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
  });
}

function turnoChamando({ tool, args, chat = 'Chamando.' }) {
  const { conteudo } = estrategiaEnvelope({ headless: true }).secaoInvariante();
  const m = conteudo.match(/\{"blocos":\[\{"chat":"[^"]*","comandos":\[.+\]\}\]\}/);
  assert.ok(m, 'o INVARIANTE do envelope perdeu o exemplo canônico');
  const exemplo = JSON.parse(m[0]);
  const comando = exemplo.blocos[0].comandos[0];
  comando.tool = tool;
  comando.args = JSON.stringify(args);
  exemplo.blocos[0].chat = chat;
  return JSON.stringify(exemplo);
}

const FECHA = JSON.stringify({ blocos: [{ chat: 'Pronto.', comandos: [] }] });

/** Embedder por palavras (copiado de hidratacao-entre-turnos): casa por token exato. */
function embedderPalavras() {
  const dim = 64;
  const hash = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % dim; };
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const v = new Array(dim).fill(0);
      for (const palavra of texto.toLowerCase().split(/[^a-zà-ú0-9]+/).filter(Boolean)) v[hash(palavra)] += 1;
      const norma = Math.hypot(...v) || 1;
      return v.map((x) => x / norma);
    },
  };
}

const ferramenta = (name, { semanticText, chamadas, ...extra } = {}) => ({
  name,
  description: `Faz ${name}.`,
  ...(semanticText ? { semanticText } : {}),
  schema: z.object({ q: z.string().optional() }),
  inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'o que fazer' } } },
  handler: async () => { chamadas?.push(name); return { ok: true }; },
  ...extra,
});

const AGENDA = { id: 'agenda', descricao: 'Cuida de agenda.', semanticText: 'agenda reuniao compromisso horario marcar', tools: [ferramenta('agir')] };

const TEXTO_WHATSAPP = 'whatsapp mensagem enviar contato zap conversa';
const TEXTO_OUTRO_ASSUNTO = 'preciso marcar uma reunião com o time amanhã de manhã';

function montar({ textos, despejo, capacidades, chamadas }) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }],
    capacidades: capacidades ?? [
      AGENDA,
      {
        id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false,
        semanticText: TEXTO_WHATSAPP,
        tools: [ferramenta('enviar', { chamadas })],
      },
    ],
    embedder: embedderPalavras(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto(textos),
    decorarTool: (n, d) => d,
    ...(despejo !== undefined ? { despejo } : {}),
  });
}

async function doisTurnos({ textos, despejo, capacidades, chamadas, texto1 = TEXTO_WHATSAPP, texto2 = TEXTO_OUTRO_ASSUNTO }) {
  const o = montar({ textos, despejo, capacidades, chamadas });
  const t1 = await o.executarTurno({ texto: texto1, estado: ESTADO_INICIAL });
  const t2 = await o.executarTurno({ texto: texto2, estado: t1.estado, historico: t1.historico });
  await o.fechar();
  return { t1, t2 };
}

const USA_WHATSAPP = [turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } }), FECHA];
const MANUAL_WHATSAPP = /<function name="whatsapp__enviar">/;

test('1. desligado = hoje: config.despejo ausente ou com tudo desligado não muda nada', async () => {
  const ausente = await doisTurnos({ textos: USA_WHATSAPP });
  const desligado = await doisTurnos({ textos: USA_WHATSAPP, despejo: { cauda: false, despejo: false } });

  // O comportamento de hoje: o que o ranking trouxe vai para o system, no turno e nos seguintes.
  assert.match(ausente.t1.payload.system, MANUAL_WHATSAPP);
  assert.match(ausente.t2.payload.system, MANUAL_WHATSAPP);
  assert.doesNotMatch(ausente.t1.payload.mensagemDoTurno, /<manuais_do_turno>/);

  for (const t of ['t1', 't2']) {
    assert.equal(desligado[t].payload.system, ausente[t].payload.system, `${t}: system mudou com o interruptor explícito desligado`);
    assert.equal(desligado[t].payload.mensagemDoTurno, ausente[t].payload.mensagemDoTurno, `${t}: mensagem do turno mudou`);
    assert.deepEqual(desligado[t].estado.kairos, ausente[t].estado.kairos, `${t}: estado do kairos mudou`);
    assert.equal(ausente[t].despejo, null, `${t}: saída.despejo tem de ser null desligado`);
    // O formato do estado é o de antes: nada de chave nova quando está desligado.
    assert.deepEqual(Object.keys(ausente[t].estado), ['system', 'turno', 'kairos']);
  }
});

test('2. cauda ligada: a seleção não entra no system; vai na mensagem do turno', async () => {
  const { t1 } = await doisTurnos({ textos: USA_WHATSAPP, despejo: { cauda: true } });

  assert.doesNotMatch(t1.payload.system, MANUAL_WHATSAPP, 'o manual da seleção não pode entrar no system');
  assert.doesNotMatch(t1.payload.system, /<capability name="whatsapp">/);
  assert.match(t1.payload.mensagemDoTurno, /<manuais_do_turno>/);
  const cauda = t1.payload.mensagemDoTurno.match(/<manuais_do_turno>[\s\S]*<\/manuais_do_turno>/)?.[0] ?? '';
  assert.match(cauda, MANUAL_WHATSAPP, 'o manual tem de estar na cauda');
  assert.ok(t1.payload.secoes.some((s) => s.nome === 'manuais_do_turno' && s.destino === 'turno'));
  assert.deepEqual(t1.despejo.cauda, ['whatsapp']);
  assert.deepEqual(t1.despejo.caudaFuncoes, ['whatsapp/tool/enviar']);
});

test('3. gate: a função da cauda executa no mesmo turno', async () => {
  const chamadas = [];
  const { t1 } = await doisTurnos({ textos: USA_WHATSAPP, despejo: { cauda: true }, chamadas });

  assert.deepEqual(chamadas, ['enviar'], 'o handler real tem de rodar — sem o gate a chamada voltaria manual_nao_carregado');
  assert.equal(t1.operacoes.length, 1);
  assert.equal(t1.operacoes[0].nome, 'whatsapp__enviar');
  assert.deepEqual(t1.despejo.recusadas, []);
  assert.deepEqual(t1.despejo.promovidas, ['whatsapp/tool/enviar']);
});

test('4. promoção: o que o modelo usou entra no system no turno seguinte', async () => {
  const { t1, t2 } = await doisTurnos({ textos: USA_WHATSAPP, despejo: { cauda: true } });

  assert.ok(t1.estado.kairos.loadedProviders.includes('whatsapp'));
  assert.ok(t1.estado.kairos.hydratedTools.includes('whatsapp/tool/enviar'));
  assert.match(t2.payload.system, MANUAL_WHATSAPP, 'o manual usado tinha de ter sido promovido ao system');
  assert.match(t2.payload.system, /<capability name="whatsapp">/);
  assert.deepEqual(t2.despejo.cauda, [], 'promovido não volta na cauda');
  assert.ok(t2.estado.kairos.loadedProviders.includes('whatsapp'));
});

test('5. sem uso some: a seleção que o modelo ignorou não fica nem no system nem no estado', async () => {
  const { t1, t2 } = await doisTurnos({ textos: [FECHA], despejo: { cauda: true } });

  assert.deepEqual(t1.despejo.cauda, ['whatsapp'], 'o turno 1 trouxe whatsapp na cauda');
  assert.deepEqual(t1.despejo.promovidas, []);
  assert.ok(!t1.estado.kairos.loadedProviders.includes('whatsapp'), 'whatsapp ficou só na cauda: não é carregada');
  assert.ok(!t1.estado.kairos.hydratedTools.some((r) => r.startsWith('whatsapp/')));

  assert.doesNotMatch(t2.payload.system, /whatsapp/, 'nada de whatsapp no system do turno 2');
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /whatsapp/, 'nem na cauda do turno 2');
  assert.deepEqual(t2.despejo.cauda, []);
  assert.ok(!t2.estado.kairos.loadedProviders.includes('whatsapp'));
});

test('6. capacidade já no system com manual novo na cauda: continua carregada; só o manual novo sai do estado', async () => {
  const okapp = {
    id: 'okapp', descricao: 'Cuida de okapp.', piso: false,
    semanticText: 'okapp registro projeto salvar gravar novo',
    tools: [
      ferramenta('ler', { semanticText: 'consultar ler', fixa: true }),
      ferramenta('salvar', { semanticText: 'salvar gravar novo', fixa: false }),
    ],
  };
  // Turno 1: o modelo carrega `ler` por load_capability (pedido do modelo conta como uso) e a usa.
  // Turno 2: a seleção traz `salvar` (ranking), que o modelo ignora.
  const { t1, t2 } = await doisTurnos({
    textos: [
      turnoChamando({ tool: 'load_capability', args: { refs: ['okapp__ler'] } }),
      turnoChamando({ tool: 'okapp__ler', args: { q: 'a' } }),
      FECHA,
    ],
    despejo: { cauda: true },
    capacidades: [AGENDA, okapp],
    texto1: TEXTO_OUTRO_ASSUNTO,
    texto2: 'okapp registro projeto salvar gravar novo',
  });

  assert.ok(t1.estado.kairos.loadedProviders.includes('okapp'), 'load_capability do modelo promove a capacidade');
  assert.ok(t1.estado.kairos.hydratedTools.includes('okapp/tool/ler'));

  assert.match(t2.payload.system, /<function name="okapp__ler">/, 'ler foi promovida e está no system');
  assert.doesNotMatch(t2.payload.system, /<function name="okapp__salvar">/, 'salvar só na cauda');
  const cauda = t2.payload.mensagemDoTurno.match(/<manuais_do_turno>[\s\S]*<\/manuais_do_turno>/)?.[0] ?? '';
  assert.match(cauda, /<function name="okapp__salvar">/);
  assert.deepEqual(t2.despejo.caudaFuncoes, ['okapp/tool/salvar']);

  assert.ok(t2.estado.kairos.loadedProviders.includes('okapp'), 'a capacidade está no system: continua carregada');
  assert.ok(t2.estado.kairos.hydratedTools.includes('okapp/tool/ler'));
  assert.ok(!t2.estado.kairos.hydratedTools.includes('okapp/tool/salvar'), 'só o manual novo sai de hydratedTools');
});

// ---------------------------------------------------------------------------------------------------------------
// Task 2.3 — despejo em lote pela conta do cache + aviso de descartadas
// ---------------------------------------------------------------------------------------------------------------

/** N turnos seguidos no mesmo orquestrador; cada turno recebe o `estado` e o `historico` do anterior. */
async function turnos({ textos, despejo, capacidades, chamadas, entradas }) {
  const o = montar({ textos, despejo, capacidades, chamadas });
  const saidas = [];
  let estado = ESTADO_INICIAL;
  let historico = [];
  for (const entrada of entradas) {
    const t = await o.executarTurno({ estado, historico, ...entrada });
    saidas.push(t);
    estado = t.estado;
    historico = t.historico;
  }
  await o.fechar();
  return saidas;
}

// A conta só enxerga "pausa" quando o host informa a última chamada ao provider (`medidasDoCache`, Task 3.2).
const COM_PAUSA = { ultimaChamadaEm: Date.now() - 60_000 };
const PEDIDO_1 = { texto: TEXTO_WHATSAPP };
const OUTRO = (n = 0) => ({ texto: n === 0 ? TEXTO_OUTRO_ASSUNTO : `${TEXTO_OUTRO_ASSUNTO} ${'agenda '.repeat(n)}`.trim(), medidasDoCache: COM_PAUSA });
const FECHAS = (n) => Array.from({ length: n }, () => FECHA);

test('7. despejo: usou no turno 1, parou; no turno 3 sai do system, com aviso, e a conta confere', async () => {
  const [t1, t2, t3] = await turnos({
    textos: [...USA_WHATSAPP, ...FECHAS(3)],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO()],
  });

  // Turnos 1 e 2: nada marcado (1 mensagem sem uso não passa de X=1). O system do `montar` é o que a conta mediria.
  assert.match(t2.payload.system, MANUAL_WHATSAPP, 'turno 2: ainda no system');
  assert.equal(t2.despejo.descartaveis, null);
  assert.doesNotMatch(t2.payload.mensagemDoTurno, /<descartadas>/);
  for (const t of [t1, t2]) assert.equal(t.despejo.systemConfere, true, 'a conta e o montar usam o mesmo contexto: o render é o enviado');

  // Turno 3: 2 − 0 > 1 → descartável; pausa 0 = cache já perdido → dispara.
  assert.doesNotMatch(t3.payload.system, /whatsapp/, 'saiu do system');
  assert.match(t3.payload.mensagemDoTurno, /<descartadas>[\s\S]*whatsapp__enviar[\s\S]*<\/descartadas>/);
  assert.equal(t3.despejo.conta.disparou, true);
  assert.equal(t3.despejo.conta.motivo, 'pausa');
  assert.deepEqual(t3.despejo.descartaveis.capacidades, ['whatsapp']);
  assert.deepEqual(t3.despejo.descartadas, ['whatsapp']);
  assert.equal(t3.despejo.aviso, true);
  assert.equal(t3.despejo.systemConfere, true, 'depois de despejar, o system medido continua sendo o enviado');
  assert.ok(!t3.estado.kairos.loadedProviders.includes('whatsapp'), 'o Kairos acompanha o que saiu');
  assert.ok(!t3.estado.kairos.hydratedTools.some((r) => r.startsWith('whatsapp/')));
  assert.ok(!t3.estado.system.capacidades.some((c) => c.id === 'whatsapp'), 'o estado devolvido já não leva a capacidade');
});

test('8. a conta não compensa: system mantido, sem aviso', async () => {
  const [, , t3] = await turnos({
    textos: [...USA_WHATSAPP, ...FECHAS(3)],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 100000, n: 1 },
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO()],
  });
  assert.equal(t3.despejo.conta.disparou, false);
  assert.equal(t3.despejo.conta.motivo, 'nao-compensa');
  assert.match(t3.payload.system, MANUAL_WHATSAPP, 'o system mantém o que ficou sem uso quando despejar custa mais');
  assert.doesNotMatch(t3.payload.mensagemDoTurno, /<descartadas>/);
  assert.deepEqual(t3.despejo.descartadas, []);
  assert.equal(t3.despejo.systemConfere, true);
});

test('9. volta com load_capability: executa no mesmo turno, manual no system no seguinte, aviso some', async () => {
  const chamadas = [];
  const [, , t3, t4, t5] = await turnos({
    textos: [
      ...USA_WHATSAPP, FECHA, FECHA, // turnos 1 a 3
      turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }),
      turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'de novo' } }),
      FECHA, FECHA,
    ],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    chamadas,
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(), OUTRO(1), OUTRO(2)],
  });

  assert.doesNotMatch(t3.payload.system, /whatsapp/);
  // Turno 4: a capacidade está descartada (aviso presente) e o modelo a traz de volta.
  assert.match(t4.payload.mensagemDoTurno, /<descartadas>[\s\S]*whatsapp__enviar/);
  assert.deepEqual(chamadas, ['enviar', 'enviar'], 'a função executou no turno 4: load_capability destrava o guarda');
  assert.deepEqual(t4.despejo.recusadas, []);
  assert.ok(t4.estado.kairos.loadedProviders.includes('whatsapp'), 'o que o modelo carregou volta ao estado');
  // Turno 5: manual no system, aviso apagado (a volta limpa o registro de descartadas).
  assert.match(t5.payload.system, MANUAL_WHATSAPP);
  assert.doesNotMatch(t5.payload.mensagemDoTurno, /<descartadas>/);
  assert.deepEqual(t5.despejo.descartadas, []);
});

test('10. load_capability conta como uso: o item só vira descartável X mensagens depois daquele turno', async () => {
  // O modelo carrega `whatsapp__enviar` no turno 1 e não chama. X = 2: com o uso gravado no turno 1 (mensagem 0),
  // o item fica descartável na mensagem 3 (3 − 0 > 2), não antes. Sem gravar o `ultimoUso`, contaria da entrada no
  // system (turno 2, mensagem 1) e só ficaria descartável na mensagem 4 — o turno 4 deste teste.
  const [, t2, t3, t4] = await turnos({
    textos: [turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }), ...FECHAS(4)],
    despejo: { cauda: true, despejo: true, x: 2, pausaMin: 0 },
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(), OUTRO()],
  });
  for (const t of [t2, t3]) {
    assert.match(t.payload.system, MANUAL_WHATSAPP, 'ainda no system: o pedido do modelo reiniciou a contagem');
    assert.equal(t.despejo.descartaveis, null);
  }
  assert.deepEqual(t4.despejo.descartaveis.capacidades, ['whatsapp'], 'mensagem 3: 3 − 0 > 2');
  assert.doesNotMatch(t4.payload.system, /whatsapp/);
});

test('11. despejado e recarregado no MESMO turno: o uso do turno vence o despejo no estado', async () => {
  // O despejo roda antes do modelo; no turno 3 o item sai do system, o modelo o carrega e usa. Se o estado do
  // Kairos ainda tirasse o item, o turno 4 voltaria sem o manual que o modelo acabou de usar.
  const chamadas = [];
  const [, , t3, t4] = await turnos({
    textos: [
      ...USA_WHATSAPP, FECHA, // turnos 1 e 2
      turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }),
      turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'agora' } }),
      FECHA, FECHA,
    ],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    chamadas,
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(), OUTRO(1)],
  });
  assert.equal(t3.despejo.conta.disparou, true, 'o despejo aconteceu no turno 3');
  assert.doesNotMatch(t3.payload.system, /whatsapp/, 'e o modelo começou o turno sem o manual');
  assert.deepEqual(chamadas, ['enviar', 'enviar']);
  assert.ok(t3.estado.kairos.loadedProviders.includes('whatsapp'), 'usado no turno: continua carregado');
  assert.ok(t3.estado.kairos.hydratedTools.includes('whatsapp/tool/enviar'));
  assert.deepEqual(t3.despejo.descartadas, ['whatsapp'], 'o aviso do turno 3 foi o que o modelo viu');
  assert.match(t4.payload.system, MANUAL_WHATSAPP);
  assert.deepEqual(t4.despejo.descartadas, [], 'a volta limpa o registro');
});

// ---------------------------------------------------------------------------------------------------------------
// Task 2.4 — revisão do que assume "selecionado = no system"
// ---------------------------------------------------------------------------------------------------------------

/** Capacidade de enchimento: dá ao ranking candidatos suficientes (4 no total) para o z-score da selecionada passar de 1,5. */
const enchimento = (id, semanticText) => ({ id, descricao: `Cuida de ${id}.`, piso: false, semanticText, tools: [ferramenta(`fazer_${id}`)] });
const COM_ENCHIMENTO = [
  enchimento('relatorios', 'relatorio consolidado fechamento mes exportar resumo'),
  enchimento('notas', 'anotacoes pessoais lembretes rascunho ideias'),
  enchimento('contatos', 'telefones enderecos pessoas cadastro clientes'),
];
const whatsappCom = (chamadas, extra = {}) => ({
  id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false, semanticText: TEXTO_WHATSAPP,
  tools: [ferramenta('enviar', { chamadas })], ...extra,
});
const SINAL_FORTE = { sinalForte: { z: 1.5 } };

test('12. despejo protege o que a seleção traz de volta COM sinal forte neste mesmo turno (capacidade)', async () => {
  const rodar = (despejoExtra) => turnos({
    textos: [...USA_WHATSAPP, ...FECHAS(3)],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0, ...despejoExtra },
    capacidades: [AGENDA, whatsappCom([]), ...COM_ENCHIMENTO],
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), { texto: TEXTO_WHATSAPP, medidasDoCache: COM_PAUSA }],
  });

  // Controle: sem sinal forte (régua impossível), o turno 3 despeja mesmo a seleção tendo trazido whatsapp de volta.
  const [, , semSinal] = await rodar({ sinalForte: { z: 99 } });
  assert.equal(semSinal.despejo.conta?.disparou, true, 'controle: despejou');
  assert.doesNotMatch(semSinal.payload.system, MANUAL_WHATSAPP);

  const [, , comSinal] = await rodar(SINAL_FORTE);
  assert.match(comSinal.payload.system, MANUAL_WHATSAPP, 'a seleção trouxe whatsapp com convicção: o manual fica');
  assert.equal(comSinal.despejo.descartaveis, null, 'nada marcado');
  assert.deepEqual(comSinal.despejo.descartadas, []);
  assert.ok(comSinal.estado.kairos.loadedProviders.includes('whatsapp'));
});

test('12b. R4: função parada não sai sozinha dentro de capacidade que fica — nem sem sinal forte', async () => {
  const okapp = {
    id: 'okapp', descricao: 'Cuida de okapp.', piso: false,
    semanticText: 'okapp registro projeto salvar gravar novo',
    tools: [
      ferramenta('ler', { semanticText: 'consultar ler', fixa: true }),
      // Manual longo: despejar um manual curto troca por uma linha de índice MAIOR e a conta (D <= 0) não dispara.
      ferramenta('salvar', { semanticText: 'salvar gravar novo', fixa: false, contract: `Manual de salvar. ${'Detalhe do argumento e dos casos de borda. '.repeat(20)}` }),
    ],
  };
  const TEXTO_OKAPP = 'okapp registro projeto salvar gravar novo';
  const rodar = (despejoExtra, textoDoTurno3) => turnos({
    textos: [
      turnoChamando({ tool: 'okapp__salvar', args: { q: 'a' } }), turnoChamando({ tool: 'okapp__ler', args: { q: 'a' } }), FECHA, // turno 1
      turnoChamando({ tool: 'okapp__ler', args: { q: 'b' } }), FECHA, // turno 2: só `ler` é usada, `salvar` fica parada
      FECHA,
    ],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0, ...despejoExtra },
    capacidades: [AGENDA, okapp, ...COM_ENCHIMENTO],
    entradas: [{ texto: TEXTO_OKAPP, medidasDoCache: COM_PAUSA }, OUTRO(), { texto: textoDoTurno3, medidasDoCache: COM_PAUSA }],
  });
  const MANUAL_SALVAR = /<function name="okapp__salvar">/;

  // R4 (spec §5.1): `salvar` está parada há 2 mensagens (2 − 0 > 1), mas `ler` foi usada no turno 2, então a capacidade
  // fica — e nenhum manual dela sai sozinho. Antes do R4, a régua de sinal forte impossível (z = 99) deixava `salvar`
  // sair e o sinal forte a protegia; agora nem precisa de sinal. (Mutação: voltar a marcar função avulsa em
  // `descartaveis` faz `funcoes` ficar com `okapp/tool/salvar` e o manual sumir do system.)
  const [, , solta] = await rodar({ sinalForte: { z: 99 } }, TEXTO_OKAPP);
  assert.equal(solta.despejo.descartaveis, null, 'nada marcado: a capacidade teve uso e função não sai sozinha');
  assert.match(solta.payload.system, MANUAL_SALVAR);
  assert.match(solta.payload.system, /<function name="okapp__ler">/);

  const [, , trazida] = await rodar(SINAL_FORTE, TEXTO_OKAPP);
  assert.match(trazida.payload.system, MANUAL_SALVAR);
});

test('13. sessionBehavior.evictAfterIdleTurns: null = nunca despejar; número = o X daquela capacidade', async () => {
  const rodar = (sessionBehavior, n) => turnos({
    textos: [...USA_WHATSAPP, ...FECHAS(n)],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    capacidades: [AGENDA, whatsappCom([], sessionBehavior ? { sessionBehavior } : {})],
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, ...Array.from({ length: n - 1 }, () => OUTRO())],
  });

  const nunca = await rodar({ sticky: false, evictAfterIdleTurns: null }, 5);
  for (const t of nunca) assert.equal(t.despejo.descartaveis, null, 'null: nada vira descartável');
  assert.match(nunca[4].payload.system, MANUAL_WHATSAPP);

  // Controle: ausente cai no X global (1) e o turno 3 despeja.
  const global = await rodar(undefined, 3);
  assert.deepEqual(global[2].despejo.descartaveis.capacidades, ['whatsapp']);

  // Número próprio (3) vale no lugar do global: turnos 3 (2 − 0) e 4 (3 − 0) ainda não; turno 5 (4 − 0 > 3) sim.
  const tres = await rodar({ sticky: false, evictAfterIdleTurns: 3 }, 5);
  for (const t of tres.slice(0, 4)) assert.equal(t.despejo.descartaveis, null);
  assert.deepEqual(tres[4].despejo.descartaveis.capacidades, ['whatsapp']);
});

test('14. recência do Kairos: quem saiu sem uso perde recentUse e lastUsedTurn; quem foi usado fica', async () => {
  // Sem uso: o discover renovou a recência de whatsapp no turno 1, mas o modelo a ignorou.
  const [semUso] = await turnos({ textos: [FECHA], despejo: { cauda: true }, entradas: [PEDIDO_1] });
  assert.ok(!semUso.estado.kairos.recentUse.some((u) => u.ref === 'whatsapp'), 'o ranking não pode seguir reforçando o que foi ignorado');
  assert.ok(!('whatsapp' in semUso.estado.kairos.lastUsedTurn));
  assert.ok(semUso.estado.kairos.recentUse.some((u) => u.ref === 'agenda'), 'o piso mantém a recência');

  // Com uso: continua.
  const [usou] = await turnos({ textos: USA_WHATSAPP, despejo: { cauda: true }, entradas: [PEDIDO_1] });
  assert.ok(usou.estado.kairos.recentUse.some((u) => u.ref === 'whatsapp'));
  assert.equal(usou.estado.kairos.lastUsedTurn.whatsapp, 0);

  // Despejada: perde a recência junto.
  const [, , t3] = await turnos({
    textos: [...USA_WHATSAPP, ...FECHAS(3)],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO()],
  });
  assert.equal(t3.despejo.conta.disparou, true);
  assert.ok(!t3.estado.kairos.recentUse.some((u) => u.ref === 'whatsapp'));
  assert.ok(!('whatsapp' in t3.estado.kairos.lastUsedTurn));
});

test('15. sinônimo cru (aliasCru): promove ao usar pelo nome cru; a recusa pelo nome cru não conta como uso', async () => {
  const chamadas = [];
  const tl = (name, semanticText) => ferramenta(name, { semanticText, chamadas });
  const whatsapp = {
    id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false, aliasCru: true, semanticText: TEXTO_WHATSAPP,
    // `enviar` hidrata com o pedido; `listar` fica só no índice (sem manual) e o guarda a recusa.
    tools: [tl('enviar', TEXTO_WHATSAPP), tl('listar', 'inventario estoque produtos prateleira')],
  };
  const [t1, t2] = await turnos({
    textos: [
      turnoChamando({ tool: 'listar', args: {} }), // cru, sem manual -> recusada
      turnoChamando({ tool: 'enviar', args: { q: 'oi' } }), // cru, manual na cauda -> executa
      FECHA, FECHA,
    ],
    despejo: { cauda: true },
    capacidades: [AGENDA, whatsapp, ...COM_ENCHIMENTO],
    entradas: [PEDIDO_1, OUTRO()],
  });
  assert.deepEqual(chamadas, ['enviar'], 'o cru com manual na cauda executa; o cru sem manual é recusado');
  assert.ok(t1.despejo.recusadas.includes('listar'), `a recusa fica registrada pelo nome com que foi chamada: ${JSON.stringify(t1.despejo.recusadas)}`);
  assert.deepEqual(t1.despejo.promovidas, ['whatsapp/tool/enviar'], 'só o que executou promove, também pelo nome cru');
  assert.match(t2.payload.system, MANUAL_WHATSAPP);
  assert.ok(!/<function name="whatsapp__listar">/.test(t2.payload.system), 'a recusada não foi promovida');
});

test('16. instruções da capacidade que já estão na cauda não são entregues de novo pelo load_capability', async () => {
  const INSTRUCOES = 'INSTRUCOES-UNICAS-DO-ZAP: sempre confirme o destinatário.';
  const pedidos = [];
  let i = 0;
  const textos = [turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }), FECHA];
  const provider = () => ({
    name: 'fake', model: 'fake-1',
    capabilities: { streaming: false, usage: false, cancellation: false, structuredOutput: true, nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence' },
    async generate(request) { pedidos.push(JSON.stringify(request)); const t = textos[Math.min(i, textos.length - 1)]; i += 1; return { text: t, stopReason: 'completed' }; },
  });
  const o = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }],
    capacidades: [AGENDA, whatsappCom([], { instrucoes: INSTRUCOES })],
    embedder: embedderPalavras(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider, decorarTool: (n, d) => d,
    despejo: { cauda: true },
  });
  await o.executarTurno({ texto: TEXTO_WHATSAPP, estado: ESTADO_INICIAL });
  await o.fechar();
  assert.ok(pedidos.length >= 2, 'o modelo foi chamado de novo depois do load_capability');
  const naSegundaChamada = pedidos[1].split('INSTRUCOES-UNICAS-DO-ZAP').length - 1;
  assert.equal(naSegundaChamada, 1, 'as instruções aparecem uma vez (na cauda); o retorno do load_capability não as repete');
});

// ---------------------------------------------------------------------------------------------------------------
// Task 2.5 — cauda não usada vale por mais um turno em continuação curta
// ---------------------------------------------------------------------------------------------------------------

const SIM = { texto: 'sim' };
const ENVIA_NO_SIM = [FECHA, turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } }), FECHA, FECHA];

test('17a. "posso enviar?" -> "sim" (turno trivial): a cauda não usada vale mais um turno, executa e promove', async () => {
  const chamadas = [];
  const [t1, t2, t3] = await turnos({
    textos: ENVIA_NO_SIM,
    despejo: { cauda: true },
    chamadas,
    entradas: [PEDIDO_1, SIM, OUTRO()],
  });

  assert.deepEqual(t1.despejo.cauda, ['whatsapp'], 'turno 1: o manual veio na cauda e o modelo só perguntou');
  assert.equal(t2.despejo.continuacaoCurta, true, '"sim" é trivial');
  assert.deepEqual(t2.despejo.herdadas, ['whatsapp/tool/enviar']);
  assert.match(t2.payload.mensagemDoTurno, /<manuais_do_turno>[\s\S]*<function name="whatsapp__enviar">/, 'a cauda velha está na mensagem do "sim"');
  assert.deepEqual(chamadas, ['enviar'], 'o gate deixou executar: sem a herança vinha manual_nao_carregado');
  assert.deepEqual(t2.despejo.recusadas, []);
  assert.deepEqual(t2.despejo.promovidas, ['whatsapp/tool/enviar']);
  assert.ok(t2.estado.kairos.loadedProviders.includes('whatsapp'), 'usada: promove ao estado do Kairos');
  assert.ok(t2.estado.kairos.hydratedTools.includes('whatsapp/tool/enviar'));
  assert.match(t3.payload.system, MANUAL_WHATSAPP, 'e no turno seguinte o manual está no system');
  assert.deepEqual(t3.despejo.herdadas, []);
});

test('17b. host vetou o trivial por continuidade (pergunta+curta): mesma herança', async () => {
  const chamadas = [];
  const [, t2] = await turnos({
    textos: ENVIA_NO_SIM,
    despejo: { cauda: true },
    chamadas,
    entradas: [PEDIDO_1, { texto: 'sim', trivial: false, motivoTrivial: 'pergunta+curta' }],
  });
  assert.equal(t2.despejo.continuacaoCurta, true);
  assert.deepEqual(t2.despejo.herdadas, ['whatsapp/tool/enviar']);
  assert.deepEqual(chamadas, ['enviar']);
});

test('17c. herdada e NÃO usada: não é herdada de novo, não vai ao Kairos e não pune duas vezes', async () => {
  const [t1, t2, t3] = await turnos({
    textos: [FECHA],
    despejo: { cauda: true },
    entradas: [PEDIDO_1, SIM, SIM],
  });
  assert.equal(t1.estado.despejo.caudaSemUso.whatsapp, 1);
  assert.deepEqual(t2.despejo.herdadas, ['whatsapp/tool/enviar'], 'o primeiro "sim" ainda recebe');
  assert.ok(!t2.estado.kairos.loadedProviders.includes('whatsapp'), 'herdada sem uso continua fora do Kairos');
  assert.ok(!t2.estado.kairos.hydratedTools.some((r) => r.startsWith('whatsapp/')));
  assert.equal(t2.estado.despejo.caudaSemUso.whatsapp, 1, 'a herdada não conta como mais um turno sem uso');
  assert.deepEqual(t2.estado.despejo.caudaAnterior, [], 'vale por UM turno: nada sobra para o seguinte');
  assert.deepEqual(t3.despejo.herdadas, [], 'o segundo "sim" não recebe a cauda velha');
  assert.doesNotMatch(t3.payload.mensagemDoTurno, /whatsapp/);
});

test('17d. com um turno normal sem relação no meio, o "sim" do 3º turno não traz a cauda velha', async () => {
  const chamadas = [];
  const [, t2, t3] = await turnos({
    textos: [FECHA, FECHA, turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } }), FECHA],
    despejo: { cauda: true },
    chamadas,
    entradas: [PEDIDO_1, OUTRO(), SIM],
  });
  assert.equal(t2.despejo.continuacaoCurta, false, 'turno normal: não é continuação curta');
  assert.deepEqual(t2.despejo.herdadas, []);
  assert.deepEqual(t2.estado.despejo.caudaAnterior, [], 'o turno 2 não tinha cauda própria: nada para herdar');
  assert.deepEqual(t3.despejo.herdadas, []);
  assert.doesNotMatch(t3.payload.mensagemDoTurno, /whatsapp/);
  assert.deepEqual(chamadas, [], 'o gate não abriu para o manual velho');
  assert.deepEqual(t3.despejo.recusadas, ['whatsapp__enviar']);
});

test('17e. desligado = hoje: o mesmo cenário do "sim" é byte a byte igual com o interruptor ausente ou desligado', async () => {
  const rodar = (despejo) => turnos({ textos: ENVIA_NO_SIM, despejo, entradas: [PEDIDO_1, SIM, OUTRO()] });
  const ausente = await rodar(undefined);
  const desligado = await rodar({ cauda: false, despejo: false });
  for (let i = 0; i < 3; i += 1) {
    assert.equal(desligado[i].payload.system, ausente[i].payload.system, `turno ${i + 1}: system`);
    assert.equal(desligado[i].payload.mensagemDoTurno, ausente[i].payload.mensagemDoTurno, `turno ${i + 1}: mensagem do turno`);
    assert.deepEqual(desligado[i].estado, ausente[i].estado, `turno ${i + 1}: estado`);
    assert.equal(ausente[i].despejo, null);
    assert.deepEqual(Object.keys(ausente[i].estado), ['system', 'turno', 'kairos']);
  }
  // E hoje o "sim" executa (o system já tinha o manual).
  assert.deepEqual(ausente[1].operacoes.map((o) => o.nome), ['whatsapp__enviar']);
});

// ---------------------------------------------------------------------------------------------------------------
// Fase 2, correção 1 — corte por sinal forte também sai do estado do Kairos
// ---------------------------------------------------------------------------------------------------------------

test('18. cortada por falta de sinal forte: nada de whatsapp no system nem no Kairos no turno seguinte', async () => {
  // Três caudas seguidas sem uso (M = 3) exigem sinal forte no 4º turno; a régua impossível (z = 99) faz a seleção do
  // turno 4 ser fraca e o `separarCauda` cortar whatsapp. O discover já tinha posto o provider e o manual no estado.
  const [, , , t4, t5] = await turnos({
    textos: [FECHA],
    despejo: { cauda: true, m: 3, sinalForte: { z: 99 } },
    entradas: [PEDIDO_1, PEDIDO_1, PEDIDO_1, PEDIDO_1, OUTRO()],
  });
  assert.deepEqual(t4.despejo.cortadasPorSinal, ['whatsapp'], 'o corte aconteceu no turno 4');
  assert.deepEqual(t4.despejo.cauda, []);
  assert.doesNotMatch(t4.payload.mensagemDoTurno, /whatsapp__enviar/);

  assert.ok(!t4.estado.kairos.loadedProviders.includes('whatsapp'), 'cortada: não fica carregada no Kairos');
  assert.ok(!t4.estado.kairos.hydratedTools.some((r) => r.startsWith('whatsapp/')));
  assert.ok(!t4.estado.kairos.recentUse.some((u) => u.ref === 'whatsapp'));
  assert.ok(!('whatsapp' in t4.estado.kairos.lastUsedTurn));

  assert.doesNotMatch(t5.payload.system, /whatsapp/, 'sem uso nem load_capability o manual não entra no system');
  assert.doesNotMatch(t5.payload.mensagemDoTurno, /whatsapp/);
  assert.ok(!t5.estado.kairos.loadedProviders.includes('whatsapp'));
});

test('18b. cortada por sinal mas o modelo a carregou por load_capability no mesmo turno: continua carregada', async () => {
  const [, , , t4, t5] = await turnos({
    textos: [
      FECHA, FECHA, FECHA, // turnos 1 a 3
      turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }),
      turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } }),
      FECHA, FECHA,
    ],
    despejo: { cauda: true, m: 3, sinalForte: { z: 99 } },
    entradas: [PEDIDO_1, PEDIDO_1, PEDIDO_1, PEDIDO_1, OUTRO()],
  });
  assert.deepEqual(t4.despejo.cortadasPorSinal, ['whatsapp']);
  assert.ok(t4.estado.kairos.loadedProviders.includes('whatsapp'), 'o pedido do modelo vence o corte');
  assert.match(t5.payload.system, MANUAL_WHATSAPP);
});

// ---------------------------------------------------------------------------------------------------------------
// Revisão do conjunto, correção 1 — I1 (promoção pelo registro de uso) e I2 (sinal forte persiste)
// ---------------------------------------------------------------------------------------------------------------

test('19. I1: função que chegou à cauda pelo loop (acompanhante) e foi usada é promovida — não depende de tools.hydrate', async () => {
  const chamadas = [];
  const whatsapp = {
    id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false, semanticText: TEXTO_WHATSAPP,
    // `enviar` hidrata com o pedido; `exibir` é a acompanhante: chega ao prompt por `contratosDoLoop`, não por `hydrate`.
    tools: [
      ferramenta('enviar', { semanticText: TEXTO_WHATSAPP, chamadas, acompanha: ['exibir'] }),
      ferramenta('exibir', { chamadas }),
    ],
  };
  const [t1, t2] = await turnos({
    textos: [turnoChamando({ tool: 'whatsapp__exibir', args: { q: 'x' } }), FECHA, turnoChamando({ tool: 'whatsapp__exibir', args: { q: 'y' } }), FECHA],
    despejo: { cauda: true },
    capacidades: [AGENDA, whatsapp],
    entradas: [PEDIDO_1, OUTRO()],
  });
  assert.ok(t1.despejo.caudaFuncoes.includes('whatsapp/tool/exibir'), 'pré-condição: exibir veio na cauda');
  assert.deepEqual(t1.despejo.promovidas, ['whatsapp/tool/exibir']);
  assert.ok(!(t1.discover.tools.hydrate ?? []).includes('whatsapp/tool/exibir'), 'pré-condição: o discover não a hidratou');
  assert.ok(t1.estado.kairos.hydratedTools.includes('whatsapp/tool/exibir'), 'o registro de uso é a fonte: promovida entra em hydratedTools');
  assert.ok(t1.estado.kairos.loadedProviders.includes('whatsapp'));
  assert.match(t2.payload.system, /<function name="whatsapp__exibir">/, 'no turno seguinte o manual está no system');
  assert.deepEqual(chamadas, ['exibir', 'exibir'], 'e executa de novo, sem recusa');
  assert.deepEqual(t2.despejo.recusadas, []);
});

test('20. I1: paraOModelo do Jev usado pelo modelo é promovido', async () => {
  const embedder = {
    modelSlug: 'fake-test-v1',
    async embed(texto) { return texto.includes('PERGUNTA_DO_USUARIO_MARCADOR') || texto.includes('DOC_SEMANTICO_CALENDAR') ? [1, 0] : [0, 0]; },
  };
  const chamadas = [];
  let rodadas = 0;
  const rodar = async ({ espaco }) => {
    rodadas += 1;
    const fn = espaco.funcoes.find((f) => f.nome === 'ver_evento');
    // Só no turno 1 o Jev escolhe a função e a deixa para o modelo; no turno 2 ele não opina.
    return { estado: 'pronto', motivo: 'precisa de argumento do modelo', paraOModelo: rodadas === 1 ? [{ nome: fn.nome, capacidade: fn.capacidade }] : [], rastro: [], carregadas: [], passos: [], ms: 1 };
  };
  const o = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>A.</identidade>' }],
    capacidades: [{
      id: 'agenda', descricao: 'Agenda.', piso: false, prefixarTools: false, semanticText: 'DOC_SEMANTICO_CALENDAR agenda',
      tools: [
        { name: 'listar_eventos', description: 'Lista.', effect: 'read', fixa: true, schema: z.object({}).passthrough(), handler: async () => ({ ok: true }) },
        { name: 'ver_evento', description: 'Vê um evento.', effect: 'read', schema: z.object({}).passthrough(), handler: async () => { chamadas.push('ver_evento'); return { ok: true }; } },
      ],
    }],
    embedder, protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTexto([turnoChamando({ tool: 'ver_evento', args: {} }), FECHA, turnoChamando({ tool: 'ver_evento', args: {} }), FECHA]),
    decorarTool: (n, d) => d, refinadores: { provider: (input) => ({ full: input.proposal.full, candidates: input.proposal.candidates }) },
    loop: { rodar, paramsDe: () => [] },
    despejo: { cauda: true },
  });
  const t1 = await o.executarTurno({ texto: 'PERGUNTA_DO_USUARIO_MARCADOR agenda amanhã', estado: ESTADO_INICIAL });
  const t2 = await o.executarTurno({ texto: 'qualquer outro assunto sem relação alguma', estado: t1.estado, historico: t1.historico });
  await o.fechar();
  assert.deepEqual(t1.loop.paraOModelo, [{ nome: 'ver_evento', capacidade: 'agenda' }], 'pré-condição: veio do Jev');
  assert.ok(!(t1.discover.tools.hydrate ?? []).includes('agenda/tool/ver_evento'));
  assert.deepEqual(t1.despejo.promovidas, ['agenda/tool/ver_evento']);
  assert.ok(t1.estado.kairos.hydratedTools.includes('agenda/tool/ver_evento'));
  assert.match(t2.payload.system, /<function name="ver_evento">/);
  assert.deepEqual(chamadas, ['ver_evento', 'ver_evento']);
});

test('21. I2: a exigência de sinal forte persiste depois do corte, até o modelo usar ou carregar', async () => {
  const cenario = (textos, extra = {}) => turnos({
    textos,
    despejo: { cauda: true, m: 2, sinalForte: { z: 99 } },
    entradas: Array.from({ length: 8 }, () => PEDIDO_1),
    ...extra,
  });
  // 8 seleções fracas sem uso: dois turnos na cauda, e depois do corte nunca mais.
  const t = await cenario([FECHA]);
  assert.deepEqual(t.slice(0, 2).map((x) => x.despejo.cauda), [['whatsapp'], ['whatsapp']]);
  for (const x of t.slice(2)) {
    assert.deepEqual(x.despejo.cortadasPorSinal, ['whatsapp'], 'cortada em todos os turnos seguintes');
    assert.deepEqual(x.despejo.cauda, [], 'nunca mais na cauda sem sinal forte');
  }
  assert.ok(t[7].estado.despejo.exigeSinal?.whatsapp, 'a marca está no estado');

  // Com sinal forte ela volta (é a regra), mas a exigência só cai com uso ou carregamento.
  const forte = await turnos({
    textos: [FECHA],
    despejo: { cauda: true, m: 2, ...SINAL_FORTE },
    capacidades: [AGENDA, whatsappCom([]), ...COM_ENCHIMENTO],
    entradas: Array.from({ length: 3 }, () => PEDIDO_1),
  });
  assert.deepEqual(forte[2].despejo.cauda, ['whatsapp'], 'sinal forte real: continua entrando');

  // Carregada por load_capability no turno 4 -> a exigência cai.
  const carregou = await cenario([
    FECHA, FECHA, FECHA,
    turnoChamando({ tool: 'load_capability', args: { refs: ['whatsapp__enviar'] } }), FECHA,
  ]);
  assert.deepEqual(carregou[3].despejo.cortadasPorSinal, ['whatsapp']);
  assert.ok(carregou[3].estado.kairos.loadedProviders.includes('whatsapp'), 'o pedido do modelo vence o corte');
  assert.ok(!carregou[3].estado.despejo.exigeSinal?.whatsapp, 'usada/carregada: a exigência cai');
});

// ---------------------------------------------------------------------------------------------------------------
// R4 (função não sai sozinha) e "sobe junto" (fixa e acompanha) — spec 2026-10-29 §4.2, §5.1
// ---------------------------------------------------------------------------------------------------------------

const TEXTO_OKAPP = 'okapp registro projeto salvar gravar novo';
const MANUAL_OBTER = /<function name="okapp__obter">/;
const MANUAL_SALVAR_OKAPP = /<function name="okapp__salvar">/;
// Manual longo: despejar um manual curto troca por uma linha de índice MAIOR e a conta (D <= 0) não dispara.
const MANUAL_LONGO = (nome) => `Manual de ${nome}. ${'Detalhe do argumento e dos casos de borda. '.repeat(20)}`;
const okappComFixa = () => ({
  id: 'okapp', descricao: 'Cuida de okapp.', piso: false, semanticText: TEXTO_OKAPP,
  tools: [
    // `obter` é fixa e NÃO bate o ranking: só chega ao turno porque o provider carrega (pinned).
    ferramenta('obter', { semanticText: 'consultar buscar dado', fixa: true, contract: MANUAL_LONGO('obter') }),
    ferramenta('salvar', { semanticText: 'salvar gravar novo', fixa: false, contract: MANUAL_LONGO('salvar') }),
  ],
});
const caudaDe = (t) => t.payload.mensagemDoTurno.match(/<manuais_do_turno>[\s\S]*<\/manuais_do_turno>/)?.[0] ?? '';
const USA_SALVAR = turnoChamando({ tool: 'okapp__salvar', args: { q: 'a' } });

test('22. sobe junto (fixa): usou a semântica no turno 1 -> no turno 2 a fixa está no SYSTEM (não na cauda) e nunca é despejada enquanto a capacidade fica', async () => {
  // x = 1: a fixa `obter` nunca é usada; a capacidade fica porque a semântica é usada em todo turno até o 4.
  const t = await turnos({
    textos: [USA_SALVAR, FECHA, USA_SALVAR, FECHA, USA_SALVAR, FECHA, USA_SALVAR, FECHA, FECHA],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    capacidades: [AGENDA, okappComFixa(), ...COM_ENCHIMENTO],
    entradas: [{ texto: TEXTO_OKAPP, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(1), OUTRO(2), OUTRO(3)],
  });
  // Turno 1: a capacidade ainda não está no system; a fixa fica na cauda com o resto.
  assert.ok(t[0].despejo.caudaFuncoes.includes('okapp/tool/obter'), 'pré-condição: a fixa veio na cauda do turno 1');
  assert.deepEqual(t[0].despejo.promovidas, ['okapp/tool/salvar'], 'pré-condição: só a semântica foi usada');
  assert.doesNotMatch(t[0].payload.system, MANUAL_OBTER);
  // Turnos 2 a 5: a fixa sobe com a capacidade — manual no system, fora da cauda, e nenhuma função marcada.
  for (const [i, x] of t.slice(1).entries()) {
    assert.match(x.payload.system, MANUAL_OBTER, `turno ${i + 2}: a fixa tem de estar no system`);
    assert.match(x.payload.system, MANUAL_SALVAR_OKAPP);
    assert.doesNotMatch(caudaDe(x), MANUAL_OBTER, `turno ${i + 2}: a fixa não pode voltar na cauda`);
    assert.equal(x.despejo.descartaveis, null, `turno ${i + 2}: a capacidade está em uso, nada é marcado`);
    assert.deepEqual(x.despejo.descartadas, []);
  }
  assert.ok(t[1].estado.kairos.hydratedTools.includes('okapp/tool/obter'), 'Kairos igual ao system: a fixa foi promovida junto');
  assert.ok(t[4].estado.despejo.itens['okapp/tool/obter'], 'a fixa segue registrada no system no fim');
  // Mutação: `refsQueSobemJunto` devolver `refs: []` (sem o sobe junto) faz a fixa ficar na cauda do turno 2 — falha acima.
});

test('23. sobe junto (acompanha): função usada com `acompanha: [b]` -> no turno 2 `b` está no system; `b` não é despejada sozinha e a acompanhante de `b` não sobe', async () => {
  const docs = {
    id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false, semanticText: TEXTO_WHATSAPP,
    tools: [
      ferramenta('enviar', { semanticText: TEXTO_WHATSAPP, acompanha: ['exibir'] }),
      // `exibir` é a acompanhante de `enviar`; `abrir` é acompanhante de `exibir` (segundo grau: não sobe).
      ferramenta('exibir', { contract: MANUAL_LONGO('exibir'), acompanha: ['abrir'] }),
      ferramenta('abrir', { contract: MANUAL_LONGO('abrir') }),
    ],
  };
  const USA_ENVIAR = turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } });
  const t = await turnos({
    textos: [USA_ENVIAR, FECHA, USA_ENVIAR, FECHA, USA_ENVIAR, FECHA, USA_ENVIAR, FECHA, FECHA],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    capacidades: [AGENDA, docs, ...COM_ENCHIMENTO],
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(1), OUTRO(2), OUTRO(3)],
  });
  assert.deepEqual(t[0].despejo.promovidas, ['whatsapp/tool/enviar'], 'pré-condição: só `enviar` foi usada');
  assert.ok(t[0].despejo.caudaFuncoes.includes('whatsapp/tool/exibir'), 'pré-condição: a acompanhante veio na cauda');
  for (const [i, x] of t.slice(1).entries()) {
    assert.match(x.payload.system, /<function name="whatsapp__exibir">/, `turno ${i + 2}: a acompanhante tem de estar no system`);
    assert.doesNotMatch(x.payload.system, /<function name="whatsapp__abrir">/, `turno ${i + 2}: não é transitivo`);
    assert.equal(x.despejo.descartaveis, null, `turno ${i + 2}: a acompanhante não é despejada sozinha`);
  }
  assert.ok(t[1].estado.kairos.hydratedTools.includes('whatsapp/tool/exibir'));
  assert.ok(!t[1].estado.kairos.hydratedTools.includes('whatsapp/tool/abrir'));
  // Mutação: sem o sobe junto, `exibir` não foi usada e não é promovida -> some do system no turno 2.
});

test('24. R4: capacidade em uso com função parada há mais de X mensagens -> a função NÃO sai; capacidade inteira ociosa -> sai', async () => {
  const okapp = {
    id: 'okapp', descricao: 'Cuida de okapp.', piso: false, semanticText: TEXTO_OKAPP,
    tools: [
      ferramenta('ler', { semanticText: 'consultar ler', fixa: true, contract: MANUAL_LONGO('ler') }),
      ferramenta('salvar', { semanticText: 'salvar gravar novo', fixa: false, contract: MANUAL_LONGO('salvar') }),
    ],
  };
  const USA_LER = turnoChamando({ tool: 'okapp__ler', args: { q: 'a' } });
  const t = await turnos({
    textos: [
      USA_SALVAR, USA_LER, FECHA, // turno 1 (mensagem 0): usa as duas
      USA_LER, FECHA, // turno 2 (1): só `ler`
      USA_LER, FECHA, // turno 3 (2): só `ler`
      FECHA, FECHA, // turnos 4 e 5: ninguém usa
    ],
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0 },
    capacidades: [AGENDA, okapp, ...COM_ENCHIMENTO],
    entradas: [{ texto: TEXTO_OKAPP, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(1), OUTRO(2), OUTRO(3)],
  });
  // Turno 4 (mensagem 3): `salvar` parada desde a mensagem 0 (3 − 0 > 1), mas a capacidade foi usada na 2 (3 − 2 = 1): fica inteira.
  assert.equal(t[3].despejo.descartaveis, null, 'nenhuma função é marcada sozinha (a regra antiga marcava `salvar`)');
  assert.match(t[3].payload.system, MANUAL_SALVAR_OKAPP, 'o manual parado fica enquanto a capacidade fica');
  assert.match(t[3].payload.system, /<function name="okapp__ler">/);
  // Turno 5 (mensagem 4): a capacidade inteira está ociosa (4 − 2 > 1) -> sai, com tudo dela.
  assert.deepEqual(t[4].despejo.descartaveis, { capacidades: ['okapp'], funcoes: [] });
  assert.equal(t[4].despejo.conta.disparou, true);
  assert.doesNotMatch(t[4].payload.system, /okapp/);
  // Mutação: `descartaveis` voltar a marcar função parada faz o turno 4 devolver `funcoes: ['okapp/tool/salvar']`.
});

test('25. sobe junto não promove capacidade: a fixa de capacidade que ainda NÃO entrou no system continua na cauda', async () => {
  // O modelo ignora a seleção nos dois turnos: a capacidade nunca entra no system, e a fixa não a leva para lá.
  const t = await turnos({
    textos: [FECHA],
    despejo: { cauda: true },
    capacidades: [AGENDA, okappComFixa()],
    entradas: [{ texto: TEXTO_OKAPP }, { texto: TEXTO_OKAPP }, { texto: TEXTO_OUTRO_ASSUNTO }],
  });
  for (const [i, x] of t.slice(0, 2).entries()) {
    assert.doesNotMatch(x.payload.system, /okapp/, `turno ${i + 1}: nada de okapp no system`);
    assert.match(caudaDe(x), MANUAL_OBTER, `turno ${i + 1}: a fixa fica na cauda`);
    assert.ok(x.despejo.caudaFuncoes.includes('okapp/tool/obter'));
    assert.ok(!x.estado.kairos.loadedProviders.includes('okapp'), `turno ${i + 1}: a fixa não carrega a capacidade`);
    assert.ok(!x.estado.kairos.hydratedTools.some((r) => r.startsWith('okapp/')), `turno ${i + 1}: nem entra em hydratedTools`);
    assert.deepEqual(x.despejo.promovidas, []);
  }
  assert.doesNotMatch(t[2].payload.system, /okapp/);
  assert.doesNotMatch(t[2].payload.mensagemDoTurno, /okapp/, 'sem a seleção, nem na cauda');
  // Mutação: tratar toda capacidade como "no system" em `refsQueSobemJunto` (ou tirar `carregados.has` do `separarCauda`)
  // põe `obter` no system do turno 1 — falha acima.
});

// ---------------------------------------------------------------------------------------------------------------
// R4 — o que protege uma capacidade do despejo é o que o LOOP DO JEV fez neste turno, não o pino da fixa
// ---------------------------------------------------------------------------------------------------------------

// Capacidade com uma `fixa` (que o Kairos hidrata em todo turno em que a capacidade está na seleção) e uma função
// que acompanha a fixa — por `view.exibir: 'auto'` ou por `acompanha` declarado. Antes da correção, `hidratadas` (pinned)
// entrava em `refsAcompanhantes` e a acompanhante virava "do loop neste turno": a capacidade nunca era despejada.
const okappComAcompanhante = (variante) => ({
  id: 'okapp', descricao: 'Cuida de okapp.', piso: false, semanticText: TEXTO_OKAPP,
  tools: [
    ferramenta('obter', { semanticText: 'consultar buscar dado', fixa: true, contract: MANUAL_LONGO('obter'), ...(variante === 'acompanha' ? { acompanha: ['abrir'] } : {}) }),
    // `effect: 'read'`: o espaço do loop só oferece ao Jev funções de leitura.
    ferramenta('salvar', { semanticText: 'salvar gravar novo', fixa: false, effect: 'read', contract: MANUAL_LONGO('salvar') }),
    variante === 'acompanha'
      ? ferramenta('abrir', { contract: MANUAL_LONGO('abrir') })
      : ferramenta('exibir', { contract: MANUAL_LONGO('exibir'), view: { exibir: 'auto' } }),
  ],
});

/** T1 usa `salvar`; T2 fala de outra coisa; T3 traz a capacidade de volta SEM sinal forte (régua impossível), x = 1. */
async function ociosaComFixa({ variante, loopNoT3 }) {
  let rodadas = 0;
  const rodar = async ({ espaco }) => {
    rodadas += 1;
    const fn = rodadas === 3 && loopNoT3 ? espaco.funcoes.find((f) => f.capacidade === 'okapp' && f.tool.name === 'salvar') : null;
    return { estado: 'pronto', motivo: 'x', paraOModelo: fn ? [{ nome: fn.nome, capacidade: fn.capacidade }] : [], rastro: [], carregadas: [], passos: [], ms: 1 };
  };
  const o = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }],
    capacidades: [AGENDA, okappComAcompanhante(variante), ...COM_ENCHIMENTO],
    embedder: embedderPalavras(), protocolo: 'envelope', protocoloOpts: { headless: true },
    provider: providerDeTexto([USA_SALVAR, FECHA, FECHA, FECHA]),
    decorarTool: (n, d) => d,
    // O anel provider só põe a capacidade no espaço do loop (`tier: 'full'`) quando o refinador a promove.
    refinadores: { provider: (input) => ({ full: [...new Set([...input.proposal.full, ...(input.proposal.candidates.includes('okapp') ? ['okapp'] : [])])], candidates: input.proposal.candidates }) },
    loop: { rodar, paramsDe: () => [] },
    despejo: { cauda: true, despejo: true, x: 1, pausaMin: 0, sinalForte: { z: 99 } },
  });
  const saidas = [];
  let estado = ESTADO_INICIAL;
  let historico = [];
  for (const entrada of [{ texto: TEXTO_OKAPP, medidasDoCache: COM_PAUSA }, OUTRO(), { texto: TEXTO_OKAPP, medidasDoCache: COM_PAUSA }]) {
    const t = await o.executarTurno({ estado, historico, ...entrada });
    saidas.push(t);
    estado = t.estado;
    historico = t.historico;
  }
  await o.fechar();
  return saidas;
}

for (const variante of ['view', 'acompanha']) {
  test(`26. pino da fixa não protege: capacidade ociosa com fixa + ${variante === 'view' ? 'view.exibir auto' : 'acompanha'} sai inteira, mesmo a seleção trazendo a fixa pinada`, async () => {
    const [t1, , t3] = await ociosaComFixa({ variante, loopNoT3: false });
    assert.match(t1.payload.mensagemDoTurno + t1.payload.system, MANUAL_SALVAR_OKAPP, 'pré-condição: a capacidade foi usada no turno 1');
    // Pré-condição do defeito: a fixa está no hydrate do turno 3 (é o que antes virava "do loop") e nada do Jev rodou nela.
    assert.ok((t3.discover.tools.hydrate ?? []).includes('okapp/tool/obter'), 'pré-condição: a fixa veio pinada no hydrate do turno 3');
    assert.deepEqual(t3.loop?.paraOModelo ?? [], []);
    assert.deepEqual(t3.despejo.descartaveis, { capacidades: ['okapp'], funcoes: [] });
    assert.equal(t3.despejo.conta.disparou, true);
    assert.deepEqual(t3.despejo.descartadas, ['okapp']);
    assert.doesNotMatch(t3.payload.system, /<capability name="okapp">|<function name="okapp__/, 'saiu inteira do system');
    // Mutação: `doLoopNesteTurno` voltar a usar `refsAcompanhantesDoTurno` (que parte de `tools.hydrate`) protege `okapp`
    // por causa da acompanhante da fixa -> `descartaveis` fica null e o system mantém a capacidade.
  });

  test(`26b. controle (${variante}): o Jev escolhe uma função dela neste turno -> a capacidade NÃO é despejada`, async () => {
    const [, , t3] = await ociosaComFixa({ variante, loopNoT3: true });
    assert.equal(t3.loop?.paraOModelo?.[0]?.capacidade, 'okapp', 'pré-condição: o Jev escolheu uma função de okapp');
    assert.equal(t3.despejo.descartaveis, null, 'o que o loop trouxe agora está em uso: nada é marcado');
    assert.deepEqual(t3.despejo.descartadas, []);
    assert.match(t3.payload.system, MANUAL_SALVAR_OKAPP);
  });
}

test('23b. sobe junto (acompanha), sem uso depois: `b` chega ao system no turno 2 e FICA enquanto a capacidade fica (R4), mesmo que o discover não a hidrate', async () => {
  // Diferença para o teste 23: lá o modelo usa `enviar` em TODO turno, e cada fecho refaz o "sobe junto" — o que esconde o
  // caso de a acompanhante não ser reposta. Aqui `enviar` é usada só no turno 1; os turnos 2 a 4 são pedidos sem relação.
  const docs = {
    id: 'whatsapp', descricao: 'Cuida de whatsapp.', piso: false, semanticText: TEXTO_WHATSAPP,
    tools: [
      ferramenta('enviar', { semanticText: TEXTO_WHATSAPP, acompanha: ['exibir'] }),
      ferramenta('exibir', { contract: MANUAL_LONGO('exibir') }),
    ],
  };
  const MANUAL_EXIBIR = /<function name="whatsapp__exibir">/;
  const t = await turnos({
    textos: [turnoChamando({ tool: 'whatsapp__enviar', args: { q: 'oi' } }), FECHA, FECHA, FECHA, FECHA],
    despejo: { cauda: true, despejo: true, x: 8, pausaMin: 0 },
    capacidades: [AGENDA, docs, ...COM_ENCHIMENTO],
    entradas: [{ ...PEDIDO_1, medidasDoCache: COM_PAUSA }, OUTRO(), OUTRO(1), OUTRO(2)],
  });
  assert.deepEqual(t[0].despejo.promovidas, ['whatsapp/tool/enviar'], 'pré-condição: só `enviar` foi usada');
  assert.deepEqual(t[0].despejo.sobeJunto, ['whatsapp/tool/exibir'], 'o fecho do turno 1 sobe a acompanhante junto');
  assert.ok(t[0].estado.kairos.hydratedTools.includes('whatsapp/tool/exibir'), 'e ela entra no Kairos');
  for (const i of [1, 2, 3]) {
    assert.ok(!t[i].discover.tools.hydrate.includes('whatsapp/tool/exibir'), `turno ${i + 1}: o discover NÃO hidrata a acompanhante`);
    assert.match(t[i].payload.system, MANUAL_EXIBIR, `turno ${i + 1}: o manual da acompanhante está no system`);
    assert.match(t[i].payload.system, /<function name="whatsapp__enviar">/);
    assert.doesNotMatch(caudaDe(t[i]), MANUAL_EXIBIR, `turno ${i + 1}: e não volta na cauda`);
    assert.equal(t[i].despejo.descartaveis, null, `turno ${i + 1}: a capacidade fica, nada é marcado`);
    assert.ok(t[i].estado.system.capacidades.find((c) => c.id === 'whatsapp')?.funcoes.some((f) => f.ref === 'whatsapp/tool/exibir' && f.manual), `turno ${i + 1}: o estado devolvido guarda o manual`);
    assert.ok(t[i].estado.despejo.itens['whatsapp/tool/exibir'], `turno ${i + 1}: registrada no system`);
  }
  // O Kairos, por outro lado, solta o `hydratedTools` de uma capacidade que o discover selecionou de novo e não hidratou a
  // função (kairos `session/policy.js`, B2: `replaceForLoadedProviders`): vale para a acompanhante e também para `enviar`.
  // O manual não depende disso — o system é acumulado (`acumular({ anterior })`), não relido do Kairos.
  assert.ok(!t[1].estado.kairos.hydratedTools.includes('whatsapp/tool/exibir'), 'registro: o Kairos já a largou no turno 2');
  assert.ok(t[3].estado.kairos.loadedProviders.includes('whatsapp'), 'a capacidade segue carregada');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { FakeEmbedder } from '@okds/kairos/index/embedder';
import { criarOrquestrador, aquecerCatalogo } from '../src/index.js';
import { limparCacheDeEmbeddingsDoProcesso } from '../src/cache-catalogo.js';

// Divergência mecânica do texto do plano: `tool.schema` (zod) é obrigatório para o registro no
// genos (`ToolRegistry`) — sem ele, `executarTurno` falha com "Cannot read properties of
// undefined (reading '_def')" ao tentar montar o schema nativo da tool. `inputSchema` (JSON
// Schema, exibido no contrato) e `schema` (zod, validação na execução) são coisas diferentes —
// ver JSDoc de `ToolDeclarada` em `capacidades.js`.
function capacidades(nExemplosPorTool) {
  const ex = (base) => Array.from({ length: nExemplosPorTool }, (_, i) => `${base} ${i}`);
  return [
    { id: 'agenda', descricao: 'agenda', semanticText: 'agenda eventos calendário', piso: false, tools: [{ name: 'gcal_listar', description: 'x', semanticText: 'eventos', exemplos: ex('agenda amanhã reunião'), inputSchema: { type: 'object', properties: {} }, schema: z.object({}), handler: () => ({}) }] },
    { id: 'tarefas', descricao: 'tarefas', semanticText: 'tarefas listas pendências', piso: false, tools: [{ name: 'task_listar', description: 'x', semanticText: 'tarefas', exemplos: ex('tarefas pendentes lista'), inputSchema: { type: 'object', properties: {} }, schema: z.object({}), handler: () => ({}) }] },
  ];
}

// M-f (revisão do conjunto, item 7): `capacidades()` acima tem só 2 providers `piso: false` —
// abaixo de MIN_PROVIDERS_PARA_Z (3, `calibracao.js`), então o grupo z do cálculo cai sempre no
// padrão; só o grupo tool (independente) calcula, e isso já bastava para `origem === 'calculado'`
// no teste abaixo (trivial, não exercitava o z de verdade). Terceiro provider força os 3 no
// ranking.
function capacidadesComTerceiroProvider(nExemplosPorTool) {
  const ex = (base) => Array.from({ length: nExemplosPorTool }, (_, i) => `${base} ${i}`);
  return [
    ...capacidades(nExemplosPorTool),
    { id: 'habilidades', descricao: 'habilidades', semanticText: 'habilidades skills conhecimento do agente', piso: false, tools: [{ name: 'hab_listar', description: 'x', semanticText: 'habilidades', exemplos: ex('quais habilidades você tem'), inputSchema: { type: 'object', properties: {} }, schema: z.object({}), handler: () => ({}) }] },
  ];
}

test('com exemplos suficientes o turno registra limiares calculados', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const orq = criarOrquestrador({ base: () => [], capacidades: capacidadesComTerceiroProvider(12), embedder: new FakeEmbedder(), protocolo: 'envelope', protocoloOpts: { headless: true }, limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, calibracao: { ativa: true, parametros: { minExemplos: 20 } }, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
  const saida = await orq.executarTurno({ texto: 'oi' });
  assert.equal(saida.limiares.origem, 'calculado');
  assert.equal(typeof saida.limiares.valores.zFull, 'number');
  assert.equal(saida.limiares.resumo.zOrigem, 'calculado', 'com 3 providers no ranking o grupo z precisa calcular de verdade');
  assert.notEqual(saida.limiares.valores.zFull, 0.8, 'zFull calculado não pode coincidir com o padrão recebido');
});

test('override fixa o limiar e registra a origem', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const orq = criarOrquestrador({ base: () => [], capacidades: capacidades(12), embedder: new FakeEmbedder(), protocolo: 'envelope', protocoloOpts: { headless: true }, limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, calibracao: { ativa: true, override: { zFull: 1.23 } }, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
  const saida = await orq.executarTurno({ texto: 'oi' });
  assert.equal(saida.limiares.valores.zFull, 1.23);
  assert.equal(saida.limiares.origem, 'override');
});

// Achado 2 da revisão da Fase 2: `aquecerCatalogo` (chamado no boot, achado 2) precisa aquecer
// TAMBÉM o cálculo dos limiares (não só o índice vetorial do catálogo) — `limiaresDoConjunto`
// (fatorada em src/index.js) é a MESMA função/MESMA chave de `limiaresEmCache` que `montarCatalogo`
// usa, então o boot e o primeiro turno real disputam a MESMA promessa memoizada.
test('aquecerCatalogo pré-calcula os limiares — o primeiro turno real não recalcula', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const caps = capacidades(12);
  const embedderBase = new FakeEmbedder();
  let chamadas = 0;
  // Embedder contador — envolve o FakeEmbedder determinístico só para contar `.embed()`, sem
  // mudar o vetor produzido (mesmo `modelSlug`, para bater a mesma chave de cache).
  const embedder = { modelSlug: embedderBase.modelSlug, embed: (...args) => { chamadas += 1; return embedderBase.embed(...args); } };
  const limiares = { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 };
  const calibracao = { ativa: true, parametros: { minExemplos: 20 } };

  const aquecimento = await aquecerCatalogo({ capacidades: caps, embedder, limiares, calibracao });
  assert.equal(aquecimento.ok, true);
  const chamadasDoAquecimento = chamadas;
  // Sinal de que a calibração DE FATO rodou no aquecimento (dezenas de discover() por exemplo).
  assert.ok(chamadasDoAquecimento > 10, `esperava dezenas de chamadas de embed no aquecimento (calibração real), veio ${chamadasDoAquecimento}`);

  const orq = criarOrquestrador({ base: () => [], capacidades: caps, embedder, protocolo: 'envelope', protocoloOpts: { headless: true }, limiares, calibracao, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
  const saida = await orq.executarTurno({ texto: 'preciso ver minhas tarefas pendentes na lista' });
  assert.equal(saida.limiares.origem, 'calculado');
  // M-a (revisão do conjunto): igualdade estrita com 0 é frágil — `Date.now()` tem granularidade
  // de 1ms e a máquina de CI pode oscilar sob carga (mesma folga do irmão ~:113, medida lá). O
  // sinal PRINCIPAL de que o cálculo veio do cache é a contagem de embeds do turno (abaixo), não
  // este ms de parede — por isso a trava aqui é uma faixa pequena, não igualdade estrita.
  assert.ok(saida.tempos.calibracao <= 2, `msCalibracao do turno precisa ficar perto de 0 — o cálculo já veio do cache do aquecimento, não rodou de novo (veio ${saida.tempos.calibracao}ms)`);

  const chamadasDoTurno = chamadas - chamadasDoAquecimento;
  // O turno ainda embeda a PRÓPRIA pergunta do usuário (poucas chamadas) — mas não pode repetir
  // as dezenas de embeds que a calibração fez no aquecimento.
  assert.ok(chamadasDoTurno < chamadasDoAquecimento, `turno pós-aquecimento precisa custar BEM menos embeds que o aquecimento (${chamadasDoTurno} vs ${chamadasDoAquecimento})`);
});

// M5 (revisão do conjunto, item 4): `exemplosDasCapacidades` inclui os exemplos de HABILIDADE
// (`cap.skillsDeclaradas`, só populado como efeito colateral de `registrarCapacidadesNoManager`)
// na chave de `limiaresEmCache`. Antes desta correção, `montarCatalogo` calculava os limiares
// ANTES de registrar as capacidades (`skillsDeclaradas` ainda `undefined`) enquanto
// `aquecerCatalogo` registrava primeiro — a chave calculada no boot (com skill) e a calculada no
// primeiro turno real (sem skill, registro ainda por vir) divergiam sempre que alguma capacidade
// tivesse `fonte.skills()` com exemplo, e o aquecimento do boot nunca "pegava". Fixture com uma
// capacidade que declara `fonte.skills()` — reproduz exatamente essa divergência.
function capacidadesComHabilidade(nExemplosPorTool) {
  const ex = (base) => Array.from({ length: nExemplosPorTool }, (_, i) => `${base} ${i}`);
  const caps = capacidades(nExemplosPorTool);
  caps[0].fonte = { skills: async () => [{ key: 'doc', descricao: 'gera um documento', exemplos: ex('gera um documento word'), corpo: 'corpo da skill' }] };
  return caps;
}

test('aquecerCatalogo com skill de exemplo — o primeiro turno real reusa a MESMA chave de cache (registro antes do cálculo, nos dois lados)', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const embedderBase = new FakeEmbedder();
  let chamadas = 0;
  const embedder = { modelSlug: embedderBase.modelSlug, embed: (...args) => { chamadas += 1; return embedderBase.embed(...args); } };
  const limiares = { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 };
  const calibracao = { ativa: true, parametros: { minExemplos: 20 } };

  // Duas instâncias FRESCAS de capacidades (objetos DIFERENTES) — o cenário real: boot e sessão
  // não compartilham a mesma referência de `config.capacidades`, só o mesmo CONTEÚDO declarado.
  const aquecimento = await aquecerCatalogo({ capacidades: capacidadesComHabilidade(12), embedder, limiares, calibracao });
  assert.equal(aquecimento.ok, true);
  const chamadasDoAquecimento = chamadas;
  assert.ok(chamadasDoAquecimento > 10, `esperava dezenas de chamadas de embed no aquecimento, veio ${chamadasDoAquecimento}`);

  const orq = criarOrquestrador({ base: () => [], capacidades: capacidadesComHabilidade(12), embedder, protocolo: 'envelope', protocoloOpts: { headless: true }, limiares, calibracao, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
  const saida = await orq.executarTurno({ texto: 'preciso ver minhas tarefas pendentes na lista' });
  assert.equal(saida.limiares.origem, 'calculado');
  // Sinal PRINCIPAL (o que o item 4 pede — "0 chamadas ao embedder para exemplos"): a chave
  // bateu, então o turno não reembeda NADA da calibração — só a própria pergunta do usuário (1
  // chamada). `tempos.calibracao` (ms de parede) é sinal SECUNDÁRIO — deveria ser 0 numa
  // chamada de cache puro, mas `Date.now()` tem granularidade de 1ms e a máquina de CI pode
  // oscilar sob carga (medido: 1ms ocasional rodando a suíte inteira em paralelo); por isso a
  // trava aqui é uma faixa pequena, não igualdade estrita.
  const chamadasDoTurno = chamadas - chamadasDoAquecimento;
  assert.ok(chamadasDoTurno <= 2, `turno pós-aquecimento não pode reembedar exemplos de calibração — esperava ~1 chamada (a pergunta do usuário), veio ${chamadasDoTurno}`);
  assert.ok(saida.tempos.calibracao <= 2, `msCalibracao do turno precisa ficar perto de 0 — a chave de cache do boot precisa bater com a do turno (veio ${saida.tempos.calibracao}ms)`);
});

// Achado 3 da revisão da Fase 2: calibração é best-effort — uma falha no meio do cálculo (rede/E5
// fora do ar) não pode derrubar o turno. `limiaresDoConjunto` (src/index.js) agora envolve o
// cálculo em try/catch, cai para o `padrao` e avisa uma vez via `console.warn`.
test('embedder que falha no meio da calibração: o turno completa com limiares.origem "padrao"', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const embedderBase = new FakeEmbedder();
  let chamada = 0;
  // Falha só na PRIMEIRA chamada (o reindex do manager descartável de `calibrarLimiares`) —
  // suficiente para `calibrarLimiares` rejeitar; as chamadas seguintes (o catálogo REAL da
  // sessão) usam o embedder normalmente, então o resto do turno não é afetado.
  const embedder = {
    modelSlug: embedderBase.modelSlug,
    embed: (...args) => {
      chamada += 1;
      if (chamada === 1) return Promise.reject(new Error('embedder fora do ar (simulado)'));
      return embedderBase.embed(...args);
    },
  };
  const avisos = [];
  const warnOriginal = console.warn;
  console.warn = (...args) => { avisos.push(args.join(' ')); };
  let saida;
  try {
    const orq = criarOrquestrador({ base: () => [], capacidades: capacidades(12), embedder, protocolo: 'envelope', protocoloOpts: { headless: true }, limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, calibracao: { ativa: true, parametros: { minExemplos: 20 } }, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
    saida = await orq.executarTurno({ texto: 'preciso ver minhas tarefas pendentes na lista' });
  } finally {
    console.warn = warnOriginal;
  }
  assert.equal(saida.resultado.type, 'completed', 'o turno precisa completar mesmo com a calibração falhando');
  assert.equal(saida.limiares.origem, 'padrao');
  assert.equal(avisos.length, 1, 'console.warn precisa avisar exatamente uma vez');
  assert.match(avisos[0], /calibração de limiares falhou/);
  // M3 (revisão do conjunto): o `motivo` do fallback precisa chegar ao `limiares` que o turno
  // devolve — antes desta correção, `limiaresDoConjunto` calculava `infoLimiares.motivo` (ramo
  // de erro) mas os dois pontos de retorno do turno (`aoMontar`/retorno de `executarTurno`)
  // montavam `{ valores, origem, resumo }` sem repassar o campo.
  assert.match(saida.limiares.motivo, /erro: embedder fora do ar \(simulado\)/);
});

// M3 (revisão do conjunto): o OUTRO ramo que produz `motivo` — "poucos exemplos" — sai de
// `calibrarLimiares` (não do catch de `limiaresDoConjunto`) e passava pelo MESMO ponto cego:
// `limiaresDoConjunto` só copiava `r.limiares`/`r.origem`/`r.resumo` de `calibrarLimiares`,
// nunca `r.motivo`.
test('poucos exemplos: o turno completa com limiares.origem "padrao" e o motivo chega ao artefato do turno', async () => {
  limparCacheDeEmbeddingsDoProcesso();
  const orq = criarOrquestrador({ base: () => [], capacidades: capacidades(1), embedder: new FakeEmbedder(), protocolo: 'envelope', protocoloOpts: { headless: true }, limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, calibracao: { ativa: true, parametros: { minExemplos: 20 } }, provider: () => ({ name: 'p', model: 'm', capabilities: {}, async generate() { return { text: '{"blocos":[{"chat":"ok","comandos":[]}]}', stopReason: 'completed' }; } }) });
  const saida = await orq.executarTurno({ texto: 'oi' });
  assert.equal(saida.limiares.origem, 'padrao');
  assert.match(saida.limiares.motivo, /exemplos 2 < 20/);
});

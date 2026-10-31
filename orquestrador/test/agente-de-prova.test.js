import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { perfilShadowLoop } from '../src/perfis/shadow-loop.js';
import { perfilAgenteLlm } from '../src/perfis/agente-llm.js';

/**
 * Fase 6, Task 6.3 — "o agente de prova": um agente com MAIS capacidades
 * declaradas do que caberia junto, onde a RELEVÂNCIA decide quais entram.
 * É a prova de que o carregamento semântico existe de verdade, não só que
 * ele não lança — a razão de a Fase 6 existir (o problema do executor:
 * prompt grande demais, e parte do que sai precisa voltar sob condição).
 *
 * O teste passou de primeira? NÃO — na primeira tentativa (descrições
 * homogêneas do tipo "Capacidade de X: ajuda com tarefas de X...") o
 * ranking do kairos convergia para exatamente 3 vencedoras `full` com a
 * query usada, e `limiteDeTools=3` nunca era o fator limitante — a asserção
 * `contratos <= limiteDeTools` passaria mesmo com a fábrica quebrada (ex.:
 * `limiteDeTools` não repassado ao `prepareTurn`), porque não havia
 * candidato extra para o orçamento cortar. Diagnóstico por leitura de
 * `resolve/rank-providers.ts` (`DEFAULT_THRESHOLDS.provider.maxFulls = 5`)
 * + `resolve/hydrate.ts` (`slots = limits.tools - budgetUsed`): o CENÁRIO
 * precisa produzir mais de `limiteDeTools` vencedoras "full" para o
 * orçamento ser, de fato, quem decide. Causa (2) do aviso do prompt de
 * dispatch — o kairos discrimina direito, o cenário que não tensionava o
 * teto. Corrigido o CENÁRIO (descrições de tamanho misto — curtas e longas
 * — que produzem mais dispersão de score, medido empiricamente rodando a
 * fábrica de verdade fora da suíte antes de fixar o fixture): a mesma query
 * agora produz 5 capacidades "full" (o teto de providers do kairos), das
 * quais só `limiteDeTools=3` ganham o CONTRATO completo. Medido com
 * `limiteDeTools` em 1/2/3/100 antes de fixar o teste: o número de
 * contratos hidratados acompanhou EXATAMENTE o limite (1/2/3/3) enquanto o
 * número de capacidades "full" (que ganham o bloco `<capacidade>` com
 * `instructions`, independente do orçamento de tools) ficou fixo em 5 —
 * ou seja, o teto de PROVIDER (kairos) e o teto de TOOL (nosso
 * `limiteDeTools`) são dois cortes distintos, e este teste tensiona o
 * segundo.
 */

const ESTADO_KAIROS_VAZIO = { loadedProviders: [], consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] };
const ESTADO_INICIAL = { system: systemVazio(), turno: 0, kairos: ESTADO_KAIROS_VAZIO };
const DECORAR_TOOL_NO_OP = (nome, definicao) => definicao;

/** Mesmo embedder falso de `semantico.test.js` — ver lá o porquê da
 *  assinatura singular (`embed(texto)`, não `embed(textos[])`). */
function embedderFalso() {
  const dim = 8;
  return {
    modelSlug: 'fake-test-v1',
    async embed(texto) {
      const v = new Array(dim).fill(0);
      for (const ch of texto.toLowerCase()) { const i = ch.charCodeAt(0) % dim; v[i] += 1; }
      const norma = Math.hypot(...v) || 1;
      return v.map((x) => x / norma);
    },
  };
}

function providerFechado() {
  return () => ({
    name: 'fake', model: 'fake-1',
    capabilities: {
      streaming: false, usage: false, cancellation: false, structuredOutput: true,
      nativeTools: false, backgroundRuns: false, preferredToolProtocol: 'command_fence',
    },
    async generate() {
      return { text: JSON.stringify({ blocos: [{ chat: 'ok', comandos: [] }] }), stopReason: 'completed' };
    },
  });
}

const TEMAS = ['agenda', 'clima', 'financas', 'receitas', 'viagens', 'esportes', 'musica', 'filmes', 'saude', 'estudo', 'jardinagem', 'carros'];

/** Descrição de tamanho MISTO (curta/longa alternada) — é o que produz
 *  dispersão de score suficiente, com o embedder falso, para MAIS de
 *  `limiteDeTools` capacidades baterem o teto `zFull` do kairos ao mesmo
 *  tempo (ver comentário do arquivo). Uma descrição uniforme por tema NÃO
 *  tensiona o orçamento — todas as candidatas empatam perto do mesmo score
 *  e o kairos já corta pra poucas antes do orçamento de tools entrar em
 *  jogo. */
function descricao(tema, indice) {
  return indice % 2 === 0
    ? `Sobre ${tema}.`
    : `Uma capacidade bem completa e detalhada sobre o assunto de ${tema}, cobrindo diversos aspectos do dia a dia relacionados a ${tema} para o usuário.`;
}

function dozeCapacidadesSemanticas() {
  return TEMAS.map((tema, indice) => ({
    id: tema,
    descricao: descricao(tema, indice),
    piso: false,
    // A trava de `index.js` exige doc de embedding em capacidade semântica.
    // Aqui ele é derivado do tema de propósito: o que este teste mede é a
    // DISPERSÃO de score entre doze capacidades, e um doc escrito à mão por
    // tema mudaria o ranking que ele afere.
    semanticText: `${tema} ${tema} assunto de ${tema} perguntas sobre ${tema}`,
    tools: [{
      name: 'consultar',
      description: `Consulta informações de ${tema}.`,
      schema: z.object({ q: z.string() }),
      handler: async () => ({ ok: true }),
    }],
  }));
}

test('doze capacidades semânticas, limiteDeTools baixo: o prompt do turno NÃO carrega as doze — a relevância decide quantas entram', async () => {
  const limiteDeTools = 3;
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de prova.</identidade>' }],
    capacidades: dozeCapacidadesSemanticas(),
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiteDeTools,
  });

  const { resultado, payload } = await orq.executarTurno({
    texto: 'me fala sobre um assunto qualquer do dia a dia',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');

  // Um bloco `Args:` por contrato hidratado. (Antes era a contagem de
  // `Argumentos (JSON Schema)`, o formato anterior do contrato — trocado quando
  // a fábrica passou a renderizar os argumentos campo a campo, `src/contrato.js`.)
  const contratosCompletos = (payload.system.match(/^ {2}Args:/gm) || []).length;

  // A afirmação do plano ("não carrega as doze") — trivialmente verdadeira
  // aqui, mas vale registrar o número junto do teto real.
  assert.ok(contratosCompletos < 12, `esperava menos que 12 contratos completos, veio ${contratosCompletos}`);
  // A afirmação FORTE: o número de contratos hidratados nunca passa do
  // orçamento configurado — é o que distingue "o kairos cortou por conta
  // própria" (aconteceria de qualquer forma) de "o LIMITE que eu configurei
  // é honrado" (só verdadeiro se `limiteDeTools` chega ao `prepareTurn`).
  assert.ok(
    contratosCompletos <= limiteDeTools,
    `limiteDeTools=${limiteDeTools} não foi respeitado: ${contratosCompletos} contratos completos`,
  );
  // Não vacuamente zero — alguma coisa tem que ter sido selecionada, senão a
  // asserção acima passaria também com o ranking quebrado (ex.: embedder
  // nunca chamado, tudo descartado).
  assert.ok(contratosCompletos > 0, 'nada foi selecionado — o ranking não pode estar zerando tudo');
});

/**
 * Reusa o mesmo cenário (5 capacidades "full", `limiteDeTools=3`) porque é o
 * único fixture da suíte que produz de verdade uma tool CONSCIENTE mas sem
 * contrato hidratado — exatamente o estado "carregável" da Mudança 2
 * (2026-09-18, `renderizarCapacidade` em prompt-builder.js). Duas coisas só
 * são observáveis num prompt de VERDADE, montado por `criarOrquestrador`, não
 * num `acumular()` isolado:
 *
 * 1. Regra 2 da Mudança 2 — função com manual não pode reaparecer na lista de
 *    carregáveis (a duplicação que a mudança existe para eliminar).
 * 2. A armadilha do prefixo do kairos — `linhasDeIndice` (index.js) tem que
 *    tirar o `${key} — ` que `tool.indexLine` já embute, senão a linha
 *    carregável duplica o nome (`- clima__consultar — consultar — Consulta…`).
 */
test('capacidade FULL com tool sem contrato: aparece só como carregável, sem repetir o nome nem duplicar entre os dois grupos', async () => {
  // `limiteDeTools=1` (mais apertado que o teste-mãe, que usa 3): medido que
  // com 3 o número de capacidades "full" e o de contratos hidratados EMPATAM
  // neste cenário (3 e 3) — nenhuma sobra carregável, e a pré-condição abaixo
  // falharia vacuamente. Com 1, sobram full sem contrato de verdade.
  const limiteDeTools = 1;
  const orq = criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente de prova.</identidade>' }],
    capacidades: dozeCapacidadesSemanticas(),
    embedder: embedderFalso(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerFechado(),
    decorarTool: DECORAR_TOOL_NO_OP,
    limiteDeTools,
  });

  const { resultado, payload } = await orq.executarTurno({
    texto: 'me fala sobre um assunto qualquer do dia a dia',
    estado: ESTADO_INICIAL,
  });

  assert.equal(resultado.type, 'completed');

  // Pré-condição: tem que sobrar carregável, senão as asserções abaixo
  // passariam vacuamente (nenhum grupo "Carregáveis" para checar).
  const linhasCarregaveis = payload.system.match(/^- \w+_consultar — .+$/gm) ?? [];
  assert.ok(
    linhasCarregaveis.length > 0,
    'o cenário precisa deixar pelo menos uma tool consciente sem contrato para o teste significar algo',
  );

  // Armadilha do prefixo: sem o strip em `linhasDeIndice`, a linha viria
  // `- clima__consultar — consultar — Consulta informações de clima.` — o
  // nome curto da tool (`consultar`) repetido entre os dois travessões.
  for (const linha of linhasCarregaveis) {
    assert.doesNotMatch(
      linha, /^- \w+ — consultar — /,
      `linha carregável duplicou o nome cru da tool: "${linha}"`,
    );
  }

  // Regra 2: nome exposto com manual hidratado (`<function name="...">`) não
  // pode reaparecer como linha "- nome — ..." de carregável.
  const nomesComManual = [...payload.system.matchAll(/<function name="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(nomesComManual.length > 0, 'pré-condição: pelo menos uma tool tem que ter hidratado');
  for (const nome of nomesComManual) {
    assert.ok(
      !payload.system.includes(`- ${nome} — `),
      `"${nome}" tem manual E aparece como carregável — a duplicação que a Mudança 2 elimina`,
    );
  }
});

test('default atual: os dois perfis de produção (shadow-loop, agente-llm) marcam piso: true — mudar isso é decisão do dono, não efeito colateral', () => {
  // `perfil-shadow.test.js`/`perfil-agente.test.js` já travam isso
  // individualmente (linha `assert.equal(c.capacidades[0].piso, true)`);
  // este teste os junta explicitamente sob o guarda-chuva da Fase 6, porque
  // é o mutante #4 da prova de mutação desta task.
  const manifest = { id: 'md_notes.writer', description: 'Escreve notas.', maxTurns: 6 };
  const toolsShadow = [{ name: 'gravar', description: 'Grava.', schema: z.object({}), handler: async () => null }];
  const cShadow = perfilShadowLoop({ manifest, systemPrompt: 'x', tools: toolsShadow, provider: () => ({}) });
  assert.equal(cShadow.capacidades[0].piso, true, 'perfilShadowLoop deixou de marcar piso: true — decisão do dono, não deveria ser silenciosa');

  const agent = {
    name: 'monitor', nome_proprio: 'Arthur', descricao: 'Vigia.', mode: 'llm', motor: 'llm',
    system_prompt: 'Você é o Arthur.', tools: ['ha_estado'], carrega: [], max_turns: 4,
  };
  const toolsAgente = [{ name: 'ha_estado', description: 'Lê.', schema: z.object({}), handler: async () => null }];
  const cAgente = perfilAgenteLlm({ agent, tools: toolsAgente, provider: () => ({}), maxTurns: 4 });
  assert.equal(cAgente.capacidades[0].piso, true, 'perfilAgenteLlm deixou de marcar piso: true — decisão do dono, não deveria ser silenciosa');
});

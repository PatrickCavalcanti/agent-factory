import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { criarOrquestrador } from '../src/index.js';
import { systemVazio } from '../src/prompt-builder.js';
import { estrategiaEnvelope } from '../src/protocolo/envelope.js';

/**
 * 🚨 Capacidade carregada NO MEIO de um turno tem de voltar hidratada no turno
 * SEGUINTE.
 *
 * O defeito que este teste tranca foi medido em uso real: o usuário pedia uma
 * alteração de tela, o modelo carregava `codigo` por `load_capability`, usava, e
 * na mensagem seguinte a capacidade não estava mais no prompt — ele tinha de
 * descobrir e carregar tudo de novo, a cada turno.
 *
 * A causa tinha DUAS metades, e consertar só uma não adiantava:
 *
 * 1. `applySessionPolicy` (`kairos/session/policy.js`) monta `hydratedTools` a
 *    partir de `discoverOut.tools.hydrate` — a decisão do DISCOVER, tirada no
 *    INÍCIO do turno. O que a meta-tool trouxe depois ficava de fora.
 * 2. E `loadedProviders` sai de `discoverOut.providers.load`. Marcar só a tool
 *    como hidratada deixava-a num provider que a sessão nunca considerou
 *    carregado — e ela sumia junto com ele.
 *
 * Por isso a fábrica injeta as duas coisas, e por isso o `applySessionPolicy`
 * roda DEPOIS do laço do modelo: antes dele não há o que capturar.
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

function turnoChamando({ tool, args, chat }) {
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

/** Embedder por palavras (copiado de travas.test.js): casa por token exato e
 *  produz cosseno alto o bastante para passar o `rawFloor` do kairos. */
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

const capacidade = (id, extra = {}) => ({
  id,
  descricao: `Cuida de ${id}.`,
  tools: [{
    name: 'agir',
    description: `Age sobre ${id}.`,
    schema: z.object({ q: z.string().optional() }),
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'o que fazer' } } },
    handler: async () => ({ ok: true }),
  }],
  ...extra,
});

function montar(textos) {
  return criarOrquestrador({
    base: () => [{ nome: 'identidade', conteudo: '<identidade>Agente.</identidade>' }],
    // ⚠️ `relatorios` é SEMÂNTICA: se fosse piso (`loading.always`) estaria no
    // prompt de todo turno e o teste passaria sem o conserto — foi o que
    // aconteceu na primeira escrita deste arquivo.
    capacidades: [
      capacidade('agenda', { semanticText: 'agenda reuniao compromisso horario marcar' }),
      capacidade('relatorios', {
        piso: false,
        semanticText: 'relatorio consolidado fechamento do mes exportar resumo do periodo',
      }),
    ],
    embedder: embedderPalavras(),
    protocolo: 'envelope',
    protocoloOpts: { headless: true },
    provider: providerDeTexto(textos),
    decorarTool: (n, d) => d,
  });
}

// ⛔ FALHA HOJE, e fica marcado em vez de apagado: é o defeito ainda ABERTO.
//
// O estado de sessão JÁ registra o provider (o segundo teste deste arquivo
// prova), mas isso não basta para o bloco voltar ao prompt. A acumulação que
// monta `<capabilities>` roda ANTES do laço do modelo e se alimenta de
// `discoverResult.tools.conscious` — uma capacidade que só foi carregada no
// meio do turno nunca chega a ter bloco criado, e no turno seguinte não há o
// que "persistir".
//
// ⚠️ Uma medição anterior sugeriu que estava resolvido. Era falso positivo: a
// pergunta do turno 1 daquela medição ('leia o codigo da tela Produtos') levava
// a capacidade pelo RANKING, então ela entrava no system pelo caminho normal e
// persistia sozinha. Este teste usa uma capacidade que só entra por
// `load_capability`, que é o caso real.
test('capacidade carregada por load_capability volta hidratada no turno seguinte', async () => {
  const o = montar([
    turnoChamando({ tool: 'load_capability', args: { refs: ['relatorios__agir'] }, chat: 'Carregando.' }),
    FECHA,
  ]);

  const t1 = await o.executarTurno({ texto: 'preciso de um relatório do mês', estado: ESTADO_INICIAL });

  // O turno 2 usa uma pergunta que NÃO fala de relatório: se a capacidade
  // aparecer, é porque persistiu — não porque o ranking a trouxe de novo.
  const t2 = await o.executarTurno({
    // ⚠️ NÃO pode ser texto trivial ('ok', 'bom dia'): o discover é PULADO
    // nesses, o turno reconstrói o system anterior e o teste passaria a medir
    // outra coisa. Precisa ser não-trivial e sobre OUTRO assunto — assim o
    // ranking leva `agenda`, e `relatorios` só aparece se tiver persistido.
    texto: 'preciso marcar uma reunião com o time amanhã de manhã',
    estado: t1.estado,
    historico: t1.historico,
  });
  await o.fechar();

  assert.match(
    t2.payload.system,
    /<capability name="relatorios">/,
    'a capacidade carregada no turno 1 sumiu do system do turno 2 — o modelo teria de carregar tudo de novo a cada mensagem',
  );
  // E volta COM o manual: hidratada, não só anunciada no índice.
  const bloco = t2.payload.system.match(/<capability name="relatorios">[\s\S]*?<\/capability>/)?.[0] ?? '';
  assert.match(bloco, /<function name="/, 'voltou sem manual — seria carregável de novo, que é o desperdício que isto evita');
});

test('o estado de sessão registra o provider carregado no meio do turno', async () => {
  const o = montar([
    turnoChamando({ tool: 'load_capability', args: { refs: ['relatorios__agir'] }, chat: 'Carregando.' }),
    FECHA,
  ]);
  const t1 = await o.executarTurno({ texto: 'preciso de um relatório do mês', estado: ESTADO_INICIAL });
  await o.fechar();

  // `loadedProviders` é o que faz a capacidade sobreviver: sem o provider ali,
  // `replaceForLoadedProviders` descarta as tools dele no turno seguinte.
  assert.ok(
    t1.estado.kairos.loadedProviders.includes('relatorios'),
    `"relatorios" não entrou em loadedProviders: ${JSON.stringify(t1.estado.kairos.loadedProviders)}`,
  );
});

// Dono, 10/10 (sessão 68607343): num turno de CONFIRMAÇÃO ("sim") o discover não roda — antes só o piso era
// reconstruído e o que o turno anterior carregou por `load_capability` sumia; o modelo recarregava tudo.
test('turno trivial ("sim") mantém a capacidade carregada no turno anterior por load_capability, com o manual', async () => {
  const o = montar([
    turnoChamando({ tool: 'load_capability', args: { refs: ['relatorios__agir'] }, chat: 'Carregando.' }),
    FECHA,
    FECHA,
  ]);
  const t1 = await o.executarTurno({ texto: 'preciso de um relatório do mês', estado: ESTADO_INICIAL });
  const t2 = await o.executarTurno({ texto: 'sim', estado: t1.estado, historico: t1.historico });
  await o.fechar();
  const bloco = t2.payload.system.match(/<capability name="relatorios">[\s\S]*?<\/capability>/)?.[0] ?? '';
  assert.ok(bloco, 'a capacidade do turno anterior sumiu no turno de confirmação');
  assert.match(bloco, /<function name="relatorios__agir">/, 'o nome da função tem que ser o exposto (o que o modelo chama e o guarda reconhece), não a linha de índice');
});

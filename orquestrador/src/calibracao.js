// Limiares do kairos calculados a partir dos exemplos dos poderes ativos (spec do porte, §5).
// FUNÇÃO ÚNICA: o runtime (`montarCatalogo`) e o calibrador de linha de comando chamam esta
// mesma função com o mesmo embedder — não existe versão "de bancada" do cálculo.
// Usa o `discover` do próprio kairos para que as escalas (z-score de provider, score de tool)
// sejam exatamente as que o runtime compara.
import { createManager } from '@okds/kairos/resolve';
import { registrarCapacidadesNoManager } from './index.js';
import { toolEhFixa } from './capacidades.js';

export const PARAMETROS_PADRAO = Object.freeze({ minExemplos: 20, percentilCarregar: 0.10, percentilCandidato: 0.02, percentilTool: 0.10 });

// Revisão do conjunto (2026-09-24, item 1 + correção do controller — "irmão"): o z-score de
// provider (`rank-providers.ts#zScores`) é a dispersão do score final ENTRE OS PROVIDERS QUE
// DISPUTAM O RANKING neste turno — `rank-providers.ts:87` pula todo provider `loading.always`
// (`piso !== false` aqui) ANTES de pontuar, então só capacidades `piso: false` entram na
// dispersão. Com menos de 3 competindo, `zScores` degenera (2 sempre dá ±1 — só duas posições
// possíveis na reta; 1 sempre dá 0) e o percentil de z deixa de ser sinal, vira ruído. Note que
// isto é sobre QUEM DISPUTA O RANKING, não sobre quem tem `exemplos`: um provider `piso: false`
// sem exemplo próprio ainda entra no denominador da dispersão de TODO exemplo alheio (é ele quem
// teria que perder pontos para o exemplo do outro provider "vencer").
export const MIN_PROVIDERS_PARA_Z = 3;

export function percentil(valores, p) {
  const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * (v.length - 1))))];
}

export function exemplosDasCapacidades(capacidades) {
  const saida = [];
  for (const cap of capacidades ?? []) {
    // Spec 2026-10-01 M1: servidor MCP genérico (`calibravel: false`) não entra nos limiares
    // calculados — muda de usuário para usuário, e seus exemplos distorceriam a dispersão do conjunto.
    if (cap.calibravel === false) continue;
    for (const t of cap.tools ?? []) {
      for (const texto of t.exemplos ?? []) saida.push({ texto, capacidade: cap.id, funcao: t.name });
    }
    // Task 10 (spec do porte §5.3): exemplos das habilidades da fonte — registrados por
    // `registrarCapacidadesNoManager` em `cap.skillsDeclaradas` (o retorno de `fonte.skills()`).
    // Não entram na estatística do anel de providers/tools (não têm `funcao` de tool) — só
    // contam para `resumo.exemplosHabilidades` em `calibrarLimiares` (o anel `skill` ainda não
    // tem limiar calculado nesta spec).
    for (const s of cap.skillsDeclaradas ?? []) {
      for (const texto of s.exemplos ?? []) saida.push({ texto, capacidade: cap.id, habilidade: s.key });
    }
  }
  return saida;
}

const scoreDoProvider = (e) => e?.scores?.z;
const scoreDaTool = (e) => e?.scores?.final;
const nomeDaTool = (ref) => String(ref).split('/tool/')[1];
const estadoVazio = (loaded = []) => ({ loadedProviders: loaded, consciousTools: [], hydratedTools: [], loadedSkills: [], recentUse: [] });

export async function calibrarLimiares({ capacidades, embedder, padrao, parametros = {} }) {
  const par = { ...PARAMETROS_PADRAO, ...parametros };
  const todosExemplos = exemplosDasCapacidades(capacidades);
  // Exemplos de habilidade (sem `funcao`) não entram no cálculo de limiar de provider/tool —
  // só na estatística à parte (`resumo.exemplosHabilidades`, abaixo).
  const exemplos = todosExemplos.filter((e) => e.funcao !== undefined);
  const exemplosHabilidades = todosExemplos.length - exemplos.length;
  if (!embedder || exemplos.length < par.minExemplos) {
    return { limiares: { ...padrao }, origem: 'padrao', motivo: !embedder ? 'sem-embedder' : `exemplos ${exemplos.length} < ${par.minExemplos}`, resumo: { exemplos: exemplos.length, exemplosHabilidades }, porExemplo: [], conflitos: [] };
  }
  // Spec 2026-10-01 M1 + revisão do conjunto (I2): o manager DE CALIBRAÇÃO só conhece as capacidades
  // `calibravel !== false`. Registrar o genérico aqui o poria na dispersão do z (o kairos pontua todo
  // provider registrado), deslocando os limiares calculados dos poderes conforme o usuário cadastra
  // servidores. O genérico continua disputando o roteamento de EXECUÇÃO: esse é outro manager, o do turno
  // (`montarCatalogo`/`registrarCapacidadesNoManager` com o conjunto inteiro), não este.
  const daConta = capacidades.filter((c) => c.calibravel !== false);
  const manager = createManager({
    embedder, can: () => true, skills: { activation: 'none' },
    thresholds: { provider: { zFull: 99, zCandidate: -99, rawFloor: -1, maxFulls: 999, maxCandidates: 999 }, tool: { hydrate: -1, topKPerProvider: 999 } },
    // Achado crítico da revisão da Fase 2: sem refinador de anel, o kairos instalado
    // (dist/resolve/discover.js ~l.916-920) devolve o `explain` do anel `tool` como
    // `{ ref, ring, reason, strategy }` — SEM `scores`. `scoreDaTool` (abaixo) fica sempre
    // `undefined`, `hydrate` nunca entra em `limiares` (percentil de puro-`undefined` é `null`) e
    // `toolsOrdenadas`/`posicaoTool`/`melhorTool` saem na ORDEM DE REGISTRO dos providers, não por
    // score (confirmado por reprodução: com 2 capacidades/2 tools, `posicaoTool` batia sempre por
    // coincidência de ordem, não de relevância). Registrar QUALQUER refinador de `tool` muda
    // `discover()` para o ramo `rt.usou === true` (~l.903-914), que estampa `scores: it.scores`
    // (vindo de `toolItems`, por sua vez de `hydrateProvider().catalog`, que sempre tem
    // `scores.final`) em cada item do anel — mesmo um refinador identidade que só ecoa a proposta
    // do motor. Não precisamos subir `tool.candidateProvidersForRefine`: a chamada `b` abaixo já
    // passa `state: estadoVazio(todosProviders)`, ou seja `loadedProviders` já é TODO o conjunto,
    // e `providersToHydrate` (que já inclui `state.loadedProviders`) já cobre todos os providers —
    // a extensão por `candidateProvidersForRefine` só importaria se providers ficassem de fora do
    // estado, o que não é o caso aqui.
    refiners: {
      tool: (input) => ({ full: input.proposal.full, candidates: input.proposal.candidates }),
    },
  });
  await registrarCapacidadesNoManager(manager, daConta);
  await manager.reindex();
  const todosProviders = daConta.map((c) => c.id);
  // Item 1 (revisão do conjunto) — duas condições INDEPENDENTES para os dois grupos de campos
  // que este cálculo produz, cada uma com seu próprio fallback para `padrao`:
  //
  // (a) zFull/zCandidate: só quando `providersNoRanking` (capacidades `piso: false` — as únicas
  //     que disputam o anel `provider`, ver `MIN_PROVIDERS_PARA_Z` acima) tiver pelo menos 3.
  //     NÃO depende de quem tem `exemplos` — um provider sem exemplo próprio ainda compete no
  //     ranking de todo exemplo dos outros, e portanto ainda entra na dispersão do z.
  // Spec 2026-10-01 M1: capacidade `calibravel === false` (servidor MCP genérico) fica FORA do manager de
  // calibração e desta conta — não é entrada de `providersNoRanking` (z) nem de `funcoesSemExemplos`
  // (hydrate): muda de usuário para usuário e não deve deslocar, bloquear nem liberar o cálculo dos
  // limiares dos poderes.
  const capacidadesSemanticas = daConta.filter((c) => c.piso === false);
  const providersNoRanking = capacidadesSemanticas.length;
  const zCalculavel = providersNoRanking >= MIN_PROVIDERS_PARA_Z;
  // (b) tool.hydrate: só quando TODA função NÃO-fixa (não `pinned` — compete no anel `tool` por
  //     score, em vez de hidratar sempre com o provider), de qualquer `effect` (leitura ou
  //     escrita), tiver ela própria pelo menos um exemplo. Cobertura por PROVIDER não basta: o
  //     lote 1 deu exemplo só às funções de leitura, e o `hydrate` calculado sobre elas (0,595)
  //     deixaria de fora 8 de 52 pedidos reais de escrita (task_editar, gcal_editar_evento…),
  //     cuja pontuação nunca foi medida. Enquanto houver função não-fixa sem exemplo, o hydrate
  //     fica no padrão. `funcoesSemExemplos` lista `capacidade/funcao` de quem falta.
  const funcoesSemExemplos = daConta.flatMap((c) =>
    (c.tools ?? []).filter((t) => !toolEhFixa(t, c) && !(t.exemplos?.length)).map((t) => `${c.id}/${t.name}`));
  const toolCalculavel = funcoesSemExemplos.length === 0;
  // Porte lote 1 / T1: capacidade `piso !== false` (`loading.always`) NÃO disputa o anel
  // `provider` — o kairos a pula antes de pontuar (`rank-providers.ts:87`). Para o exemplo dela
  // `zEsperado` sai sempre `undefined` e "acertou o poder" não se aplica (o poder já está
  // carregado por definição). Esses exemplos ficam FORA da medida de poder (`zCertos`,
  // `zErradosMax`, `acertoCapacidade`, parte "poder" de `conflitos`) e DENTRO da medida de função
  // (`hydrate`, `funcaoNoTopo`, parte "função" de `conflitos`) — a função dela disputa o anel
  // `tool` normalmente.
  const capsNoRanking = new Set(capacidadesSemanticas.map((c) => c.id));
  // Função `fixa` (pinned) hidrata sempre que o provider carrega, sem passar pelo corte
  // `tool.hydrate` — o score dela não diz nada sobre esse corte. Só função NÃO fixa (inclusive em
  // capacidade de piso, onde `capacidadeDoPower` grava `fixa` por função) entra no percentil do
  // `hydrate`. `funcaoNoTopo` e os conflitos de função seguem sobre todos os exemplos.
  const capPorId = new Map(daConta.map((c) => [c.id, c]));
  const funcaoEhFixa = (ex) => {
    const c = capPorId.get(ex.capacidade);
    const t = c?.tools?.find((x) => x.name === ex.funcao);
    return c && t ? toolEhFixa(t, c) : false;
  };
  const porExemplo = [];
  for (const ex of exemplos) {
    const disputaRanking = capsNoRanking.has(ex.capacidade);
    const a = await manager.discover({ text: ex.texto, ctx: {}, state: estadoVazio(), limits: { tools: 999 } });
    const b = await manager.discover({ text: ex.texto, ctx: {}, state: estadoVazio(todosProviders), limits: { tools: 999 } });
    const prov = (a.explain ?? []).filter((e) => e.ring === 'provider');
    const tools = (b.explain ?? []).filter((e) => e.ring === 'tool');
    const zEsperado = scoreDoProvider(prov.find((e) => e.ref === ex.capacidade));
    const outros = prov.filter((e) => e.ref !== ex.capacidade).map((e) => ({ ref: e.ref, z: scoreDoProvider(e) }));
    // Exemplo de piso não disputa o poder: sem "melhor outro" (senão o calibrador de linha de
    // comando leria um conflito só de função como perda de poder).
    const melhorOutro = disputaRanking ? outros.reduce((m, o) => (typeof o.z === 'number' && (!m || o.z > m.z) ? o : m), null) : null;
    const toolEsperada = tools.find((e) => nomeDaTool(e.ref) === ex.funcao);
    const toolsOrdenadas = [...tools].sort((x, y) => (scoreDaTool(y) ?? -9) - (scoreDaTool(x) ?? -9));
    porExemplo.push({
      ...ex,
      disputaRanking, funcaoFixa: funcaoEhFixa(ex), zEsperado, melhorOutro,
      // Piso: `true` por vacuidade (poder sempre carregado, nada a disputar) — assim consumidores
      // que compõem `acertouCapacidade && posicaoTool === 0` (retrato do calibrar.mjs) medem só a
      // função. A medida de poder ignora estes exemplos via `disputaRanking`.
      acertouCapacidade: disputaRanking ? typeof zEsperado === 'number' && (!melhorOutro || zEsperado >= melhorOutro.z) : true,
      scoreToolEsperada: scoreDaTool(toolEsperada),
      posicaoTool: toolsOrdenadas.findIndex((e) => nomeDaTool(e.ref) === ex.funcao),
      melhorTool: toolsOrdenadas[0] ? { funcao: nomeDaTool(toolsOrdenadas[0].ref), score: scoreDaTool(toolsOrdenadas[0]) } : null,
    });
  }
  const doRanking = porExemplo.filter((p) => p.disputaRanking);
  const zCertos = doRanking.map((p) => p.zEsperado);
  const zErradosMax = doRanking.map((p) => p.melhorOutro?.z);
  const zFull = zCalculavel ? percentil(zCertos, par.percentilCarregar) : null;
  const zCandidate = zCalculavel ? percentil(zCertos, par.percentilCandidato) : null;
  const doHydrate = porExemplo.filter((p) => !p.funcaoFixa);
  const hydrate = toolCalculavel ? percentil(doHydrate.map((p) => p.scoreToolEsperada), par.percentilTool) : null;
  const limiares = {
    ...padrao,
    ...(zFull !== null ? { zFull } : {}),
    ...(zCandidate !== null ? { zCandidate: Math.min(zCandidate, zFull ?? zCandidate) } : {}),
    ...(hydrate !== null ? { tool: { ...(padrao.tool ?? {}), hydrate } } : {}),
  };
  const conflitos = porExemplo
    .filter((p) => (p.disputaRanking && !p.acertouCapacidade) || (p.melhorTool && p.melhorTool.funcao !== p.funcao && p.posicaoTool !== 0))
    .map((p) => ({ texto: p.texto, esperado: { capacidade: p.capacidade, funcao: p.funcao, z: p.zEsperado, scoreTool: p.scoreToolEsperada }, veio: { capacidade: p.melhorOutro?.ref, z: p.melhorOutro?.z, funcao: p.melhorTool?.funcao, scoreTool: p.melhorTool?.score } }));
  const n = porExemplo.length;
  const resumo = {
    exemplos: n,
    exemplosHabilidades,
    // Quantos exemplos entram na medida de poder (capacidade `piso: false`); `acertoCapacidade`
    // divide por ele — `null` (não NaN) quando nenhum exemplo disputa o ranking.
    exemplosNoRanking: doRanking.length,
    // Quantos exemplos entram no percentil do `tool.hydrate` (função NÃO fixa).
    exemplosNoHydrate: doHydrate.length,
    acertoCapacidade: doRanking.length ? doRanking.filter((p) => p.acertouCapacidade).length / doRanking.length : null,
    funcaoNoTopo: porExemplo.filter((p) => p.posicaoTool === 0).length / n,
    zCertos: { p02: percentil(zCertos, 0.02), p10: percentil(zCertos, 0.10), p50: percentil(zCertos, 0.5) },
    zErradosMax: { p50: percentil(zErradosMax, 0.5), p90: percentil(zErradosMax, 0.9) },
    sobreposicao: zFull !== null && percentil(zErradosMax, 0.9) !== null && zFull <= percentil(zErradosMax, 0.9),
    // Item 1 (revisão do conjunto): registro granular do porquê de CADA grupo — o `origem` no
    // topo é só um resumo grosso ('calculado' se PELO MENOS um dos dois grupos calculou; ver
    // baixo), quem quer o detalhe (tracer, calibrador de linha de comando) lê estes campos.
    zOrigem: zCalculavel ? 'calculado' : 'padrao',
    providersNoRanking,
    ...(zCalculavel ? {} : { zMotivo: `providers no ranking (${providersNoRanking}) < ${MIN_PROVIDERS_PARA_Z} — z-score degenerado` }),
    toolOrigem: toolCalculavel ? 'calculado' : 'padrao',
    ...(toolCalculavel ? {} : {
      // Trunca nas 10 primeiras (o total vai em `funcoesSemExemplosTotal` e no motivo).
      funcoesSemExemplos: funcoesSemExemplos.slice(0, 10),
      funcoesSemExemplosTotal: funcoesSemExemplos.length,
      toolMotivo: `${funcoesSemExemplos.length} funções não fixas sem exemplo, ex.: ${funcoesSemExemplos.slice(0, 3).join(', ')}`,
    }),
  };
  // Top-level `origem`: 'calculado' quando PELO MENOS um dos dois grupos (z ou tool) saiu do
  // cálculo real — 'padrao' só quando NENHUM dos dois calculou (equivalente ao comportamento de
  // antes desta revisão, quando havia um único grupo). O motivo granular de cada um mora em
  // `resumo.zOrigem`/`resumo.toolOrigem` (+ `zMotivo`/`toolMotivo`) — este campo nunca tenta
  // resumir os dois motivos numa string só.
  const origem = (zCalculavel || toolCalculavel) ? 'calculado' : 'padrao';
  return { limiares, origem, parametros: par, resumo, porExemplo, conflitos };
}

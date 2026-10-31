// Treino + portão POR ANEL (spec 2026-10-07 §5; antes, por capacidade). Índice re-montado a partir do RETRATO que a fábrica
// grava (mesmos textos → mesmo hash → a cabeça vale em produção). Casos antigos treinam; recentes julgam.
// Fidelidade com a produção: o índice de treino passa por calibrarCortes + semRoubados, como em
// executor/src/orchestration/fabrica/selecao.js — os centroides P do treino são os que a cabeça verá lá.
import { capacidadeDoRef, alvosDoCaso, recall3, dominioDoCaso, avaliarPortaoAnel, FONTES_AVALIACAO, novoFunil, novoPareado, contarPareado, MIN_CANDIDATOS_RECALL } from './dominio.js';
import { itemDoRegistro, limitarFracos } from './item-do-registro.js';
import { montarIndice, consultaCentrada, pontuarNo, treinarCabeca, pontuarCabeca, serializarCabeca, cabecaFinita, calibrarCortes, semRoubados, percentil, REGRA_DO_INDICE } from '../../src/local/index.js';

const DATA_ISO = /^\d{4}-\d{2}-\d{2}/;

export function dividirPorData(casos, diasRecentes = 14) {
  const ord = casos.filter((c) => DATA_ISO.test(String(c.ts))).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!ord.length) return { treino: [], recentes: [] };
  const fim = new Date(String(ord.at(-1).ts).slice(0, 10));
  const corte = new Date(fim.getTime() - diasRecentes * 86400000).toISOString().slice(0, 10);
  return { treino: ord.filter((c) => String(c.ts).slice(0, 10) <= corte), recentes: ord.filter((c) => String(c.ts).slice(0, 10) > corte) };
}

/** Casos processados entre cessões do laço: dominioDoCaso e o recall rodam na thread da API (o treino em si vai ao worker). */
export const CEDER_A_CADA_CASOS = 50;
const ceder = () => new Promise((r) => setImmediate(r));

const MIN_POSITIVOS_CORTES = 20;
// Primitivas de domínio/alvo/recall moram em dominio.js (compartilhadas com o lote e o caso do registro); reexportadas aqui.
export { MIN_CANDIDATOS_RECALL, capacidadeDoRef, alvosDoCaso, recall3, dominioDoCaso, avaliarPortaoAnel } from './dominio.js';

/** O que o caminho do LOG não tem e o registro tem: o treino completo com logs é mais pobre nisso (documentado no resumo). */
export const LIMITACOES_DO_LOG = Object.freeze([
  'itens do log não trazem `carregadas`: sem negativo fraco nem carga junto (só os itens do registro têm)',
  'itens do log não trazem o piso do turno: só o piso incondicional é excluído (o condicional só vale para itens do registro)',
  'itens do log cruzam capacidade × nome de função para achar o alvo no anel tool',
  'turno do log sem uso, ou que usou só o piso, treina como "nada" com peso 1 (o registro o trata como negativo fraco ou sem-sinal)',
  'o serviço só passa ao treino os casos VÁLIDOS do registro: o log de uma interação que o registro julgou trivial ou sem-sinal ENTRA (o registro não a bloqueia)',
]);

/**
 * Treina a cabeça do anel e a julga nos casos recentes (os de avaliação do registro + os últimos `diasRecentes` dias).
 *
 * - `embedderPedidos` (opcional): embedder só dos pedidos dos casos (cache próprio, longe do cache compartilhado de produção); default = `embedder`.
 * - `emUso` = a versão em uso VÁLIDA do anel (o serviço lê do disco; `null` se não há, é de outro embedder, ou é v1 fora do provider):
 *   `{cabeca (pesos), d, versao, anelAprovado, metricasAnel}`. Se `d` ≠ dimensão do índice remontado, vira `null` com um aviso. Serve
 *   para o veredito: a cabeça em uso é RECALCULADA nos mesmos casos da nova (só os de avaliação: log da janela + registro com
 *   `avaliacao: true`; o registro de treino da janela fica fora da régua porque o lote treinou a versão em uso nele). O número que ela
 *   gravou é só diagnóstico (outra amostra).
 * - Sem veredito ou rejeição: `{ok:true, mantida:true, motivo, resumo}` SEM `arquivo`/`reposicao` — `poucos-recentes` (n < `minAvaliacao`) com
 *   versão em uso válida, ou `piorou-frente-a-atual` (nova < atual − `tolerancia` nos mesmos casos). Quem chama não grava nada e a em
 *   uso continua. `poucos-recentes` SEM versão em uso e `nao-ganhou` gravam com o anel na base (`anelAprovado: false`).
 * - Alvo da AVALIAÇÃO. Anel tool: a função usada, DENTRO do domínio do 2º estágio (`dominioDoCaso`: usadas + 5 distratoras). Anel provider:
 *   se o caso traz `ativasNoInicio` (array), só conta o que PRECISOU ENTRAR (usadas − ativas no início); se é `null`/ausente (caso de
 *   log, ou turno em que a seleção não registrou), todas as usadas. Caso sem alvo depois do filtro não entra na métrica. O treino
 *   (positivos) não muda: o filtro vale só para a avaliação.
 * - `resumo.diagnostico`: `n`/`minAvaliacao`, o funil da avaliação por origem (`log`, `registro-avaliacao`, `registro-treino`: brutos =
 *   semDominio + semAlvo + jaAtivos + poucosCandidatos + julgados), a versão em uso recalculada (`emUso`) e a contagem pareada
 *   cabeça × base por caso (`pareado`).
 * - `cortesSugeridos` (relatório, nunca usado em produção): p10 das notas da CABEÇA nos positivos recentes e p98 nos negativos do
 *   domínio. Mede OUTRA coisa que o `cortesSugeridos` do índice (`calibrarCortes`: exemplo × exemplo, na base). Os cortes
 *   de produto são fixos (`cortes-fixos.js`); os dois relatórios servem para o dono comparar com eles. Positivos/negativos aqui usam
 *   TODAS as usadas do caso (inclusive as ativas no início): a nota de quem foi usado é o que o corte precisa separar.
 * - Os arquivos gravados são v2 (`serializarCabeca`): `anelAprovado`, `metricasAnel {base, cabeca, n}` (R@3 médio por caso), `metricas` e
 *   `nTreinoPorCapacidade` por capacidade (informativas; o `nTreino` alimenta a proteção D5 do refinador).
 */
export async function treinarAnel({ anel, retrato, casos, embedder, embedderPedidos = embedder, minAvaliacao = 30, margem = 0, tolerancia = 0.02, emUso = null, diasRecentes = 14, epocas = 30, treinarCabecaFn = async (a) => treinarCabeca(a), casosRegistro = [], tamanhoReposicao = 2000, excluir = [] }) {
  if (!retrato || retrato.anel !== anel) return { ok: false, motivo: 'sem-retrato do anel (rode a fábrica uma vez)' };
  if (retrato.slug !== embedder.modelSlug) return { ok: false, motivo: `retrato de outro provider (${retrato.slug} ≠ ${embedder.modelSlug})` };
  const bruto = await montarIndiceDoRetrato(anel, retrato.nos || [], embedder);
  if (!bruto.ok) return { ok: false, motivo: bruto.motivo };
  // spec 2026-10-07 D4: o hash do catálogo deixou de travar a cabeça (carregarCabeca não confere mais). Se o
  // re-montado divergir do retrato, o treino segue e o resumo avisa (`hashDiferente`).
  const hashDiferente = bruto.hash !== retrato.hash;
  // A versão em uso só serve de régua se é do MESMO espaço do índice remontado: outra dimensão = a produção também a ignora.
  let avisoEmUso = null;
  const dimEmUso = emUso ? (emUso.d ?? emUso.cabeca?.d) : null;
  if (emUso && Number.isInteger(dimEmUso) && dimEmUso !== bruto.dim) {
    avisoEmUso = `versão em uso ignorada: dimensão ${dimEmUso} ≠ ${bruto.dim} do índice`;
    console.warn(`[treino] ${anel}: ${avisoEmUso}`);
    emUso = null;
  }
  const cal = await calibrarCortes(bruto);
  const indice = semRoubados(bruto, cal.roubados);
  // `excluir` = refs que o local nunca decide (provider: capacidades de piso; tool: só as funções FIXAS delas): nunca são rótulo, candidato nem domínio (coerente com o lote).
  const fora = new Set(excluir);
  const refs = [...indice.nos.keys()].filter((r) => !fora.has(r));
  const P = refs.map((r) => indice.nos.get(r).centroide);
  const comVetor = []; let pulados = 0; let incertos = 0;
  // PRECEDÊNCIA: o caso do REGISTRO vence o do log quando os dois são da mesma interação (o registro tem vetor, carregadas, piso
  // do turno e a flag de avaliação; o log não). O log entra só para as interações ausentes do registro — e um caso de avaliação do
  // registro nunca treina pela versão de log (salvo descarte por vetor — e aí ele também não avalia nada). Quem bloqueia o log é o registro que foi JULGADO (virou item, ou saiu por incerto,
  // sem-sinal ou sem-domínio); descarte por vetor (embedder diferente sem texto, `s` nulo, embed que falhou) não bloqueia: ali o
  // registro não chegou a opinar. O laço do log roda DEPOIS do registro, por isso.
  const bloqueiaLog = new Set();
  // Casos do registro do app (treino contínuo): já trazem o vetor do pedido, o rótulo por ref e o piso do turno. Ganham do log
  // da mesma interação (acima; igualdade do interactionId: o id do log `AAAAMMDD-HHMMSS_<interactionId>` inteiro ou o sufixo).
  let embedderDiferente = 0; let reembedados = 0;
  const avaliacaoDoRegistro = [];
  for (const r of casosRegistro) {
    // Caso gravado com outro embedder (slug ou dimensão): o vetor não vale neste índice. Com texto, é re-embedado com o
    // embedder ATUAL (spec §5); sem texto, descartado.
    let vetor = r.vetores?.[0];
    if ((r.slug != null && r.slug !== retrato.slug) || (r.dim != null && r.dim !== indice.dim)) {
      if (typeof r.texto === 'string' && r.texto.trim()) {
        try { vetor = await embedderPedidos.embed(r.texto, 'query'); reembedados++; } catch { pulados++; continue; }
      } else { embedderDiferente++; continue; }
    }
    const s = consultaCentrada(indice, [vetor])[0];
    if (!s) { pulados++; continue; }
    // Mesma conversão do lote (item-do-registro.js): rótulo exato, piso do caso fora, carga junto fora do domínio, incerto pulado,
    // negativo fraco com domínio = carregado e não usado e meio peso.
    const it = itemDoRegistro({ anel, caso: r, s, refs, indice, foraIndice: fora });
    if (r.interactionId) bloqueiaLog.add(String(r.interactionId)); // o registro opinou (item, incerto, sem-sinal ou sem-domínio)
    if (it.tipo === 'incerto') { incertos++; continue; }
    if (it.tipo !== 'positivo' && it.tipo !== 'fraco') continue;
    const item = { ts: r.ts, s, v: vetor, rotulos: it.rotulos, dom: it.dom, neutras: it.neutras, peso: it.peso, fraco: it.tipo === 'fraco', capacidades: [], funcoes: [], descartadas: [], origem: 'registro', fonte: r.avaliacao === true ? 'registro-avaliacao' : 'registro-treino', ativasNoInicio: Array.isArray(r.ativasNoInicio) ? r.ativasNoInicio : null };
    // Casos de avaliação do registro (`avaliacao`) nunca treinam: vão só para os recentes, que julgam (só positivos têm alvo).
    if (r.avaliacao === true) { if (item.fraco) continue; avaliacaoDoRegistro.push(item); } else comVetor.push(item);
  }
  // ---- LOG (interações ausentes do registro) ----
  // Capacidades que o índice do anel conhece, e as que o `fora` (piso incondicional) tirou de propósito.
  const capsDoIndice = new Set(refs.map((r) => capacidadeDoRef(anel, r)));
  const capsEmFora = new Set([...fora].map((r) => capacidadeDoRef(anel, r)));
  const casosLog = casos.filter((c) => { const id = String(c.id ?? ''); return !(id && (bloqueiaLog.has(id) || bloqueiaLog.has(id.slice(id.indexOf('_') + 1)))); });
  const logSubstituidos = casos.length - casosLog.length;
  for (const c of casosLog) {
    // Caso incerto: a LLM chamou só funções que não existem mais — no catálogo atual (`descartadas`) OU capacidade que sumiu do
    // índice (power removido, MCP desconectado: `fantasmas`). O rótulo "nenhuma capacidade" seria falso. Mesma regra do registro
    // (item-do-registro.js): descartada = não está nos refs do índice nem em `fora` (o piso incondicional é descarte legítimo).
    const fantasmas = (c.capacidades || []).filter((k) => !capsDoIndice.has(k) && !capsEmFora.has(k));
    if (c.incerto === true || (((c.descartadas?.length ?? 0) + fantasmas.length) > 0 && !(c.capacidades || []).some((k) => capsDoIndice.has(k)))) { incertos++; continue; }
    // O treino usa só o vetor do pedido; em produção a consulta pode ter também a pista da B3.3.
    let v;
    try { v = await embedderPedidos.embed(c.pedido, 'query'); } catch { pulados++; continue; }
    const s = consultaCentrada(indice, [v])[0];
    if (s) comVetor.push({ ...c, s, v, fonte: 'log' }); else pulados++;
  }
  const { treino: treinoBruto, recentes: recentesDatados } = dividirPorData(comVetor, diasRecentes);
  const recentesBruto = [...recentesDatados, ...avaliacaoDoRegistro];
  if (!treinoBruto.length || !recentesBruto.length) return { ok: false, motivo: 'casos insuficientes para dividir por data' };
  const comDominio = async (lista) => {
    const saida = [];
    for (let i = 0; i < lista.length; i++) {
      if (i > 0 && i % CEDER_A_CADA_CASOS === 0) await ceder();
      const dom = lista[i].dom ?? dominioDoCaso(anel, lista[i], refs, indice);
      if (dom?.length) saida.push({ c: lista[i], dom });
    }
    return saida;
  };
  // alvos: o registro traz as refs exatas (`rotulos`); o log traz capacidade + nome de função (cruzamento do `alvosDoCaso`)
  const alvosDe = (c) => (c.rotulos ? c.rotulos.filter((r) => refs.includes(r)) : alvosDoCaso(anel, c, refs));
  const treinoTodos = await comDominio(treinoBruto); const recentes = await comDominio(recentesBruto);
  // negativos fracos do registro: no máximo metade do lote (os positivos contam os do log também), amostra determinística
  const treinoPositivos = treinoTodos.filter((x) => !x.c.fraco);
  const treinoFracos = limitarFracos(treinoPositivos, treinoTodos.filter((x) => x.c.fraco), 0);
  const treino = [...treinoPositivos, ...treinoFracos];
  const semDominio = treinoBruto.length - treinoTodos.length + recentesBruto.length - recentes.length;
  if (!treino.length) return { ok: false, motivo: 'casos insuficientes para dividir por data' };
  const casosTreino = treino.map(({ c }) => ({ s: c.s, pos: new Set(alvosDe(c).map((a) => refs.indexOf(a))), peso: c.peso ?? 1 }));
  const argsTreino = { casos: casosTreino, P, epocas };
  argsTreino.candidatosPorCaso = treino.map((x) => x.dom);
  // Fail-closed: treino que diverge (NaN/Infinity nos pesos) nunca chega ao portão nem vira arquivo.
  let cabeca;
  try { ({ cabeca } = await treinarCabecaFn(argsTreino)); } // no app: worker_thread (CPU por segundos)
  catch (e) {
    const msg = String(e?.message ?? e);
    if (/treino-divergiu/.test(msg)) return { ok: false, motivo: msg.slice(msg.indexOf('treino-divergiu')).replace('treino-divergiu:', 'treino-divergiu —') };
    throw e;
  }
  if (!cabeca || !cabecaFinita(cabeca)) return { ok: false, motivo: 'treino-divergiu — pesos não finitos (NaN/Infinity)' };
  const porCapacidade = {};
  for (const ref of refs) {
    const cap = capacidadeDoRef(anel, ref);
    porCapacidade[cap] ??= { nTreino: 0, base: 0, cabeca: 0, nRecentes: 0 };
  }
  for (const { c } of treino) for (const cap of new Set(alvosDe(c).map((r) => capacidadeDoRef(anel, r)))) porCapacidade[cap].nTreino++;
  const notasPos = []; const notasNeg = [];
  // Alvo da AVALIAÇÃO: no provider, com `ativasNoInicio` capturado, só o que precisou entrar (a ref do provider é a própria capacidade).
  const alvosDaAvaliacao = (c, alvos) => (anel === 'provider' && Array.isArray(c.ativasNoInicio) ? alvos.filter((a) => !c.ativasNoInicio.includes(a)) : alvos);
  // Funil da avaliação por origem: brutos = semDominio + semAlvo + jaAtivos + poucosCandidatos + julgados.
  const funil = novoFunil();
  const fonteDe = (c) => (FONTES_AVALIACAO.includes(c.fonte) ? c.fonte : 'log');
  for (const c of recentesBruto) funil[fonteDe(c)].brutos++;
  const comDom = new Set(recentes.map((x) => x.c));
  for (const c of recentesBruto) if (!comDom.has(c)) funil[fonteDe(c)].semDominio++;
  const pareado = novoPareado();
  let somaBase = 0; let somaCab = 0; let nAv = 0;
  // Régua da versão em uso: os MESMOS casos de avaliação (fora o registro de treino da janela), nova × atual recalculada.
  let somaAtualCmp = 0; let somaNovaCmp = 0; let somaBaseCmp = 0; let nCmp = 0;
  let visto = 0;
  for (const { c, dom } of recentes) {
    if (++visto % CEDER_A_CADA_CASOS === 0) await ceder();
    const fonte = fonteDe(c); const fn = funil[fonte];
    const alvosTodos = alvosDe(c);
    if (!alvosTodos.length) { fn.semAlvo++; continue; }
    const candidatos = dom.map((i) => refs[i]);
    if (anel === 'tool' && candidatos.length < MIN_CANDIDATOS_RECALL) { fn.poucosCandidatos++; continue; }
    const base = new Map(candidatos.map((r) => [r, pontuarNo(indice, [c.s], r)?.nota ?? -Infinity]));
    const cab = new Map(candidatos.map((r) => [r, pontuarCabeca(cabeca, c.s, indice.nos.get(r).centroide)]));
    for (const r of candidatos) (alvosTodos.includes(r) ? notasPos : notasNeg).push(cab.get(r));
    const alvos = alvosDaAvaliacao(c, alvosTodos);
    if (!alvos.length) { fn.jaAtivos++; continue; } // tudo o que foi usado já estava ativo no início: não há decisão do local a julgar
    const rBase = recall3(base, alvos, candidatos); const rCab = recall3(cab, alvos, candidatos);
    somaBase += rBase; somaCab += rCab; nAv++; fn.julgados++;
    contarPareado(pareado, rCab, rBase);
    if (emUso?.cabeca && fonte !== 'registro-treino') {
      const atual = new Map(candidatos.map((r) => [r, pontuarCabeca(emUso.cabeca, c.s, indice.nos.get(r).centroide)]));
      somaAtualCmp += recall3(atual, alvos, candidatos); somaNovaCmp += rCab; somaBaseCmp += rBase; nCmp++;
    }
    for (const cap of new Set(alvos.map((r) => capacidadeDoRef(anel, r)))) {
      const alvosCap = alvos.filter((r) => capacidadeDoRef(anel, r) === cap);
      const m = porCapacidade[cap];
      m.base += recall3(base, alvosCap, candidatos); m.cabeca += recall3(cab, alvosCap, candidatos); m.nRecentes++;
    }
  }
  for (const m of Object.values(porCapacidade)) if (m.nRecentes) { m.base /= m.nRecentes; m.cabeca /= m.nRecentes; }
  if (![...notasPos, ...notasNeg].every(Number.isFinite)) return { ok: false, motivo: 'treino-divergiu — notas da cabeça não finitas nos recentes' };
  // Relatório (não vira corte): poucos positivos recentes NÃO falham mais o treino — só deixam `cortesSugeridos` nulo.
  let cortesSugeridos = null;
  if (notasPos.length >= MIN_POSITIVOS_CORTES) {
    const full = percentil(notasPos, 0.1);
    cortesSugeridos = { full, candidate: Math.min(percentil(notasNeg, 0.98) ?? full, full) };
  }
  const metricasAnel = { base: nAv ? somaBase / nAv : null, cabeca: nAv ? somaCab / nAv : null, n: nAv };
  const r3Atual = nCmp ? somaAtualCmp / nCmp : null; const r3NovaCmp = nCmp ? somaNovaCmp / nCmp : null; const r3BaseCmp = nCmp ? somaBaseCmp / nCmp : null;
  // Comparar com a versão em uso é um veredito como qualquer outro: precisa de `minAvaliacao` casos COMPARADOS (só os de avaliação; o
  // registro de treino da janela conta para o `n` de cabeça × base, não aqui). Com menos, não há veredito de `piorou`: segue só o portão
  // contra a base (e `poucos-recentes`, se for o caso, já usa o `n` total).
  const comparacaoSuficiente = nCmp >= minAvaliacao;
  // Versão em uso SEM avaliação gravada (v1: `metricasAnel` nulo, o `anelAprovado` dela é derivado das `aprovadas` antigas): ninguém
  // verificou que ela vence a base. Se nos mesmos casos ela perde da base, não serve de régua — a nova é julgada só contra a base
  // (grava aprovada, ou com o anel na base). Mantê-la só para "não piorar" seria preservar uma cabeça pior que não ter cabeça.
  const emUsoPerdeDaBase = Boolean(emUso) && !emUso.metricasAnel && comparacaoSuficiente && r3Atual + 1e-9 < r3BaseCmp;
  const emUsoDoPortao = emUso && !emUsoPerdeDaBase ? { r3Atual: comparacaoSuficiente ? r3Atual : null, r3Nova: comparacaoSuficiente ? r3NovaCmp : null } : null;
  const portao = avaliarPortaoAnel({ r3Cabeca: metricasAnel.cabeca ?? 0, r3Base: metricasAnel.base ?? 0, nAvaliacao: nAv, minAvaliacao, margem, tolerancia, emUso: emUsoDoPortao });
  const diagnostico = {
    n: nAv, minAvaliacao, funil, pareado,
    emUso: emUso
      ? { versao: emUso.versao ?? null, r3Recalculado: r3Atual, r3Gravado: emUso.metricasAnel?.cabeca ?? null, r3Nova: r3NovaCmp, r3BaseNosMesmos: r3BaseCmp, comparou: nCmp, comparacaoSuficiente, ...(emUsoPerdeDaBase ? { descartada: 'perde-da-base' } : {}) }
      : (avisoEmUso ? { ignorada: avisoEmUso } : null),
  };
  const resumoBase = { capacidades: Object.keys(porCapacidade).length, treino: treino.length, negativosFracos: treinoFracos.length, recentes: recentes.length, incertos, pulados, semDominio, doRegistro: comVetor.filter((c) => c.origem === 'registro').length + avaliacaoDoRegistro.length, embedderDiferente, reembedados, logSubstituidosPeloRegistro: logSubstituidos, limitacoes: LIMITACOES_DO_LOG, ...(hashDiferente ? { hashDiferente: true } : {}) };
  if (portao.acao === 'mantida') {
    // Rejeição / sem veredito: nada é gravado e a versão em uso continua. `anelAprovado` = o estado dela; `metricasAnel` = as da candidata rejeitada.
    return { ok: true, mantida: true, motivo: portao.motivo, resumo: { anelAprovado: emUso.anelAprovado === true, portao: portao.motivo, mantida: true, metricasAnel, diagnostico, ...resumoBase } };
  }
  const { anelAprovado, motivo } = portao;
  const nTreinoPorCapacidade = Object.fromEntries(Object.entries(porCapacidade).map(([k, m]) => [k, m.nTreino]));
  const arquivo = serializarCabeca(cabeca, { anel, slug: retrato.slug, hash: retrato.hash, anelAprovado, metricasAnel, metricas: porCapacidade, nTreinoPorCapacidade, cortesSugeridos });
  arquivo.portao = motivo;
  // Reposição da base: amostra (espaçada, determinística) dos casos de treino já centrados, SEM texto — a atualização por lote a reusa.
  // Vetor CRU (não centrado), 5 casas: a média do índice muda a cada catálogo e a reposição é centrada no uso.
  const passo = Math.max(1, treinoPositivos.length / Math.max(1, tamanhoReposicao)); // só positivos: negativo fraco não vai para a base
  const reposicao = []; for (let i = 0; i < treinoPositivos.length && reposicao.length < tamanhoReposicao; i += passo) { const { c } = treinoPositivos[Math.floor(i)]; reposicao.push({ v: c.v.map((x) => Math.round(x * 1e5) / 1e5), rotulos: alvosDe(c), ...(c.neutras?.length ? { neutras: c.neutras } : {}) }); }
  // Calibração MANTIDA (runtime só aplica; spec do dono 2026-10-08): o serviço grava `indice/<anel>-roubados.json` só quando esta versão é adotada.
  const calibracao = {
    anel, hash: bruto.hash, slug: bruto.slug, regra: REGRA_DO_INDICE, roubados: cal.roubados, resumo: cal.resumo,
    cortesSugeridos: cal.full === null ? null : { origem: cal.origem, full: cal.full, candidate: cal.candidate },
  };
  return { ok: true, arquivo, reposicao, calibracao, resumo: { anelAprovado, portao: motivo, metricasAnel, diagnostico, ...resumoBase } };
}

/** Capacidade sintética por nó que faz `nosDoAnel` devolver exatamente os textos do retrato (mesma ordem). */
export async function montarIndiceDoRetrato(anel, nos, embedder) {
  const porCap = new Map();
  for (const n of nos) {
    const texto = n.textos.find((t) => t.tipo === 'texto')?.texto;
    const exemplos = n.textos.filter((t) => t.tipo === 'exemplo').map((t) => t.texto);
    if (anel === 'provider') { porCap.set(n.ref, { id: n.ref, semanticText: texto, tools: [{ name: '_', exemplos }] }); continue; }
    const i = String(n.ref).indexOf('/tool/');
    const cap = String(n.ref).slice(0, i); const nome = String(n.ref).slice(i + '/tool/'.length);
    const c = porCap.get(cap) ?? { id: cap, tools: [] };
    c.tools.push({ name: nome, semanticText: texto, exemplos });
    porCap.set(cap, c);
  }
  return montarIndice({ anel, capacidades: [...porCap.values()], embedder });
}

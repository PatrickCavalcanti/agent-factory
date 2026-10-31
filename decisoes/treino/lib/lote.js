// Atualização por lote (spec 2026-10-07): parte dos pesos ATUAIS, treina com os casos novos (SÓ os de treino) + uma
// amostra da base (reposição, para não esquecer o que já aprendeu), confere que não piorou nos casos de AVALIAÇÃO
// (`caso.avaliacao`, nunca vistos no treino), refaz o portão POR ANEL contra a base sem treino (`avaliarPortaoAnel`, o mesmo do
// treino completo) e recalcula o relatório `cortesSugeridos` quando há positivos suficientes. Sem I/O: quem grava a versão e a
// reposição é o chamador. O treino em si é injetável (no app roda num worker_thread).
import { consultaCentrada, pontuarNo, treinarCabeca, pontuarCabeca, serializarCabeca, cabecaFinita, percentil } from '../../src/local/index.js';
import { capacidadeDoRef, dominioDoCaso, recall3, avaliarPortaoAnel, novoFunil, novoPareado, contarPareado } from './dominio.js';
import { CEDER_A_CADA_CASOS, MIN_CANDIDATOS_RECALL } from './treino.js';
import { itemDoRegistro, limitarFracos, amostrar, aleatorio, formatoDoDominio, domSemNeutras, PESO_NEGATIVO_FRACO } from './item-do-registro.js';

export { PESO_NEGATIVO_FRACO };
const ceder = () => new Promise((r) => setImmediate(r));
const arredondar = (v) => v.map((x) => Math.round(x * 1e5) / 1e5);

/**
 * @param {object} o
 * - `atual`: a versão em uso, `{ cabeca, versao?, anelAprovado, metricasAnel, nTreinoPorCapacidade? }`. Os pesos partem dela e são
 *   RECALCULADOS nos mesmos casos de avaliação da nova (a régua do portão); `anelAprovado`/`metricasAnel`/`versao` só entram no
 *   diagnóstico; `nTreinoPorCapacidade` (opcional) é o acumulado que a versão nova continua somando (a proteção D5 do refinador lê o
 *   total histórico, não o do lote).
 * - `casosNovos`: válidos desde a última atualização (o lote usa só os SEM `avaliacao`).
 * - `recentes`: válidos recentes (o lote usa só os COM `avaliacao: true`).
 * - `reposicao`: `[{ v:number[] (CRU, não centrado), rotulos:string[] }]` do anel; `slugReposicao` = embedder que a gerou.
 * - casos/reposição de outro embedder (slug ou dim ≠ índice) são descartados e contados em `embedderDiferente`.
 * - Alvo da avaliação, como no treino completo: no anel provider, um caso com `ativasNoInicio` (array) só conta o que PRECISOU
 *   ENTRAR (usadas − ativas no início); sem o campo (`null`/ausente), todas as usadas; caso sem alvo depois do filtro não é julgado.
 * - Portão (`avaliarPortaoAnel`, o mesmo do treino completo), com a versão em uso sempre válida aqui (o lote só roda com base).
 *   ADIAMENTO (`ok:false, adiada:true, motivo`; decidido ANTES de treinar, nada gravado, os casos NÃO são consumidos): sem nenhum caso a
 *   julgar depois dos filtros finos (`sem-recentes`) ou com menos de `minAvaliacao` (`poucos-recentes`).
 *   REJEIÇÃO legítima (`ok:false, rejeicao:true, mantida:true`; nada é gravado, os casos são consumidos): nova pior que a em uso nos mesmos
 *   casos (`piorou-frente-a-atual`: `r3Nova < r3Atual − tolerancia`). `nao-ganhou` da base grava com o anel na base. Uma versão em uso sem
 *   avaliação gravada (v1: `metricasAnel` nulo) que perde da base nos mesmos casos não serve de régua (`emUso.descartada: 'perde-da-base'`).
 * - `cortesSugeridos` do arquivo = p10/p98 das notas da cabeça nova nos casos de avaliação (relatório; mede outra coisa que o do
 *   índice), `null` com menos de `minPositivosCortes` positivos.
 * - `resumo.diagnostico`: `n`/`minAvaliacao`, funil da avaliação, `emUso` (a em uso recalculada × a nova nos mesmos casos) e o pareado.
 * @returns {Promise<{ok:true, arquivo:object, reposicao:object[], slugReposicao:string, resumo:object}|{ok:false, adiada?:true, rejeicao?:true, mantida?:true, motivo:string, resumo?:object}>}
 */
export async function atualizarPorLote({
  anel, indice, atual, casosNovos = [], reposicao = [], slugReposicao = null, recentes = [],
  epocas = 30, lr = 0.1, amostraReposicao = 200, tamanhoReposicao = 2000, seed = 0, minAvaliacao = 30, minPositivosCortes = 20, margem = 0, tolerancia = 0.02,
  treinarCabecaFn = async (a) => treinarCabeca(a), excluir = [],
}) {
  const fora = new Set(excluir);
  const refs = [...indice.nos.keys()].filter((r) => !fora.has(r));
  const noIndice = new Set(refs);
  const P = refs.map((r) => indice.nos.get(r).centroide);
  let refsDescartadas = 0; let embedderDiferente = 0; let incertos = 0;

  // Embedder: caso gravado com outro modelo (slug) ou dimensão não vale neste índice.
  const doEmbedder = (c) => {
    const ok = (c.slug == null || c.slug === indice.slug) && (c.dim == null || c.dim === indice.dim);
    if (!ok) embedderDiferente++;
    return ok;
  };
  const vetorDe = (c) => consultaCentrada(indice, [c.vetores?.[0]])[0];
  const novos = casosNovos.filter((c) => !c.avaliacao).filter(doEmbedder);
  const avaliacao = recentes.filter((c) => c.avaliacao === true).filter(doEmbedder);
  let repo = [];
  if (slugReposicao != null && slugReposicao !== indice.slug) embedderDiferente += reposicao.length;
  else repo = reposicao.filter((r) => { const ok = Array.isArray(r?.v) && r.v.length === indice.dim; if (!ok) embedderDiferente++; return ok; });

  // Avaliação (nunca vista no treino): base, atual e nova no mesmo domínio de candidatos da produção.
  // `alvos` = tudo o que foi usado (positivos das notas do relatório); `alvosAv` = o que o R@3 julga: no provider, com
  // `ativasNoInicio` capturado, só o que PRECISOU ENTRAR (a ref do provider é a própria capacidade).
  const funil = novoFunil(); const fv = funil['registro-avaliacao'];
  fv.brutos = avaliacao.length;
  const avaliaveis = []; let visto = 0;
  for (const r of avaliacao) {
    if (++visto % CEDER_A_CADA_CASOS === 0) await ceder();
    const s = vetorDe(r);
    if (!s) { fv.semDominio++; continue; }
    const it = itemDoRegistro({ anel, caso: r, s, refs, indice, foraIndice: fora });
    if (it.tipo === 'incerto') { incertos++; fv.semAlvo++; continue; }
    if (it.tipo === 'sem-dominio') { fv.semDominio++; continue; }
    if (it.tipo !== 'positivo') { fv.semAlvo++; continue; }
    const candidatos = it.dom.map((i) => refs[i]);
    if (anel === 'tool' && candidatos.length < MIN_CANDIDATOS_RECALL) { fv.poucosCandidatos++; continue; }
    const alvosAv = anel === 'provider' && Array.isArray(r.ativasNoInicio) ? it.rotulos.filter((a) => !r.ativasNoInicio.includes(a)) : it.rotulos;
    if (!alvosAv.length) fv.jaAtivos++; else fv.julgados++;
    avaliaveis.push({ s, alvos: it.rotulos, alvosAv, candidatos });
  }
  const nJulgaveis = fv.julgados;
  const resumoParcial = { casosNovos: novos.length, avaliacao: avaliacao.length, refsDescartadas, embedderDiferente, incertos };
  const diagnosticoParcial = { n: nJulgaveis, minAvaliacao, funil, pareado: novoPareado(), emUso: { versao: atual.versao ?? null, r3Recalculado: null, r3Gravado: atual.metricasAnel?.cabeca ?? null, r3Nova: null, comparou: 0 } };
  // Sem nenhum caso a julgar (`sem-recentes`) ou com menos de `minAvaliacao` (`poucos-recentes`) não há veredito — e isso não depende da
  // cabeça nova: decide ANTES de gastar o treino. É ADIAMENTO, não rejeição: `{ok:false, adiada:true}`, nada é gravado e o chamador NÃO
  // consome os casos (eles voltam quando o registro tiver casos de avaliação suficientes depois dos filtros finos).
  const semVeredito = !nJulgaveis || avaliarPortaoAnel({ r3Cabeca: 0, r3Base: 0, nAvaliacao: nJulgaveis, minAvaliacao, emUso: { r3Atual: null, r3Nova: null } }).acao === 'mantida';
  if (semVeredito) return { ok: false, adiada: true, motivo: nJulgaveis ? 'poucos-recentes' : 'sem-recentes', resumo: { ...resumoParcial, diagnostico: diagnosticoParcial } };

  // Casos de treino: novos (vetor da consulta centrado) + amostra da reposição (centrada com a média do índice ATUAL).
  // Cada caso novo vira item pela MESMA função do treino completo (item-do-registro.js): rótulo exato, piso do caso fora,
  // carga junto fora do domínio, caso incerto pulado, negativo fraco com domínio = carregado e não usado e meio peso.
  const positivos = []; const fracos = []; const paraReservatorio = [];
  const novosPorCapacidade = {}; // positivos NOVOS por capacidade (a reposição não conta): soma no acumulado da versão em uso
  let visto2 = 0;
  for (const c of novos) {
    if (++visto2 % CEDER_A_CADA_CASOS === 0) await ceder();
    const s = vetorDe(c);
    if (!s) continue;
    const it = itemDoRegistro({ anel, caso: c, s, refs, indice, foraIndice: fora });
    refsDescartadas += it.descartadas;
    if (it.tipo === 'incerto') { incertos++; continue; }
    if (it.tipo === 'positivo') {
      positivos.push({ s, rotulos: it.rotulos, dom: it.dom, peso: 1 });
      for (const cap of new Set(it.rotulos.map((x) => capacidadeDoRef(anel, x)))) novosPorCapacidade[cap] = (novosPorCapacidade[cap] ?? 0) + 1;
      paraReservatorio.push({ v: arredondar(c.vetores[0]), rotulos: it.rotulos, ...(it.neutras?.length ? { neutras: it.neutras } : {}) }); // negativo fraco não vai para a base
    } else if (it.tipo === 'fraco') fracos.push({ s, rotulos: [], dom: it.dom, peso: it.peso });
  }
  const repoValida = [];
  for (const r of repo) {
    if (++visto2 % CEDER_A_CADA_CASOS === 0) await ceder();
    const s = consultaCentrada(indice, [r.v])[0];
    if (!s) { embedderDiferente++; continue; }
    const rotulos = (r.rotulos || []).filter((x) => noIndice.has(x));
    refsDescartadas += (r.rotulos || []).length - rotulos.length;
    repoValida.push({ v: r.v, s, rotulos, ...(Array.isArray(r.neutras) && r.neutras.length ? { neutras: r.neutras } : {}) });
  }
  for (const r of amostrar(repoValida, amostraReposicao, seed)) { // reposição sem rótulo (sem `carregadas`) não pune nada
    if (!r.rotulos.length) continue;
    const dom = domSemNeutras(dominioDoCaso(anel, formatoDoDominio(anel, r.s, r.rotulos), refs, indice), refs, r.neutras);
    if (dom?.length) positivos.push({ s: r.s, rotulos: r.rotulos, dom, peso: 1 });
  }
  const fracosTotal = fracos.length;
  const fracosUsados = limitarFracos(positivos, fracos, seed); // no máx. metade do lote
  const treino = [...positivos, ...fracosUsados].filter((c) => c.dom?.length);
  if (!treino.length) return { ok: false, rejeicao: true, motivo: 'sem-casos-de-treino', resumo: { ...resumoParcial, refsDescartadas } };
  const casosTreino = treino.map((c) => ({ s: c.s, pos: new Set(c.rotulos.map((a) => refs.indexOf(a))), peso: c.peso, dom: c.dom }));
  const argsTreino = { casos: casosTreino.map(({ s, pos, peso }) => ({ s, pos, peso })), P, epocas, lr, seed, posto: atual.cabeca.posto, inicial: atual.cabeca };
  argsTreino.candidatosPorCaso = casosTreino.map((x) => x.dom);

  // Treino a partir dos pesos atuais; divergência falha fechado.
  let nova;
  try { ({ cabeca: nova } = await treinarCabecaFn(argsTreino)); } catch (e) {
    const msg = String(e?.message ?? e);
    return { ok: false, motivo: /tempo-esgotado/.test(msg) ? 'tempo-esgotado' : /treino-divergiu/.test(msg) ? msg.slice(msg.indexOf('treino-divergiu')).replace('treino-divergiu:', 'treino-divergiu —') : `erro: ${msg}`, resumo: { ...resumoParcial, refsDescartadas } };
  }
  if (!nova || !cabecaFinita(nova)) return { ok: false, motivo: 'treino-divergiu — pesos não finitos (NaN/Infinity)', resumo: { ...resumoParcial, refsDescartadas } };

  const porCapacidade = {};
  for (const ref of refs) porCapacidade[capacidadeDoRef(anel, ref)] ??= { nTreino: 0, base: 0, cabeca: 0, atual: 0, nRecentes: 0 };
  for (const c of treino) for (const cap of new Set(c.rotulos.map((r) => capacidadeDoRef(anel, r)))) porCapacidade[cap].nTreino++;
  const notasPos = []; const notasNeg = [];
  const pareado = novoPareado();
  let somaBase = 0; let somaNova = 0; let somaAtual = 0; let nAv = 0;
  let vistoAv = 0;
  for (const { s, alvos, alvosAv, candidatos } of avaliaveis) {
    if (++vistoAv % CEDER_A_CADA_CASOS === 0) await ceder();
    const base = new Map(candidatos.map((x) => [x, pontuarNo(indice, [s], x)?.nota ?? -Infinity]));
    const cNova = new Map(candidatos.map((x) => [x, pontuarCabeca(nova, s, indice.nos.get(x).centroide)]));
    const cAtual = new Map(candidatos.map((x) => [x, pontuarCabeca(atual.cabeca, s, indice.nos.get(x).centroide)]));
    for (const x of candidatos) (alvos.includes(x) ? notasPos : notasNeg).push(cNova.get(x));
    if (!alvosAv.length) continue; // tudo o que foi usado já estava ativo no início: não há decisão do local a julgar
    const rBase = recall3(base, alvosAv, candidatos); const rNova = recall3(cNova, alvosAv, candidatos);
    somaBase += rBase; somaNova += rNova; somaAtual += recall3(cAtual, alvosAv, candidatos); nAv++;
    contarPareado(pareado, rNova, rBase);
    for (const cap of new Set(alvosAv.map((x) => capacidadeDoRef(anel, x)))) {
      const alvosCap = alvosAv.filter((x) => capacidadeDoRef(anel, x) === cap);
      const m = porCapacidade[cap];
      m.base += recall3(base, alvosCap, candidatos); m.cabeca += recall3(cNova, alvosCap, candidatos); m.atual += recall3(cAtual, alvosCap, candidatos); m.nRecentes++;
    }
  }
  for (const m of Object.values(porCapacidade)) if (m.nRecentes) { m.base /= m.nRecentes; m.cabeca /= m.nRecentes; m.atual /= m.nRecentes; }
  const recallBase = somaBase / nAv; const recallNova = somaNova / nAv; const recallAtual = somaAtual / nAv;
  const diagnostico = { n: nAv, minAvaliacao, funil, pareado, emUso: { versao: atual.versao ?? null, r3Recalculado: recallAtual, r3Gravado: atual.metricasAnel?.cabeca ?? null, r3Nova: recallNova, r3BaseNosMesmos: recallBase, comparou: nAv, comparacaoSuficiente: nAv >= minAvaliacao } };
  const resumoBase = { casosNovos: novos.length, negativosFracos: fracosTotal, negativosFracosUsados: fracosUsados.length, incertos, reposicao: Math.min(repoValida.length, amostraReposicao), treino: treino.length, avaliacao: nAv, refsDescartadas, embedderDiferente, recallBase, recallNova, recallAtual };
  if (![...notasPos, ...notasNeg].every(Number.isFinite)) return { ok: false, motivo: 'treino-divergiu — notas da cabeça não finitas nos recentes', resumo: resumoBase };

  // Portão POR ANEL (o mesmo do treino completo): R@3 da cabeça nova × base sobre todas as capacidades, nos casos de avaliação. A versão
  // em uso é RECALCULADA nos mesmos casos (`recallAtual`): piorar além da tolerância é rejeição (`mantida`), não grava nada.
  // Versão em uso SEM avaliação gravada (v1: `metricasAnel` nulo, o `anelAprovado` dela é derivado das `aprovadas` antigas) que, nos mesmos
  // casos, PERDE da base não serve de régua (mesma regra do treino completo): a nova é julgada só contra a base — manter a v1 só para "não
  // piorar" preservaria uma cabeça pior que não ter cabeça. Exige `minAvaliacao` casos comparados (aqui nAv; o pré-cheque já garante).
  const emUsoPerdeDaBase = !atual.metricasAnel && nAv >= minAvaliacao && recallAtual + 1e-9 < recallBase;
  if (emUsoPerdeDaBase) diagnostico.emUso.descartada = 'perde-da-base';
  const portao = avaliarPortaoAnel({ r3Cabeca: recallNova, r3Base: recallBase, nAvaliacao: nAv, minAvaliacao, margem, tolerancia, emUso: emUsoPerdeDaBase ? null : { r3Atual: recallAtual, r3Nova: recallNova } });
  const metricasAnel = { base: recallBase, cabeca: recallNova, n: nAv };
  if (portao.acao === 'mantida') return { ok: false, rejeicao: true, mantida: true, motivo: portao.motivo, resumo: { ...resumoBase, portao: portao.motivo, metricasAnel, diagnostico } };
  const { anelAprovado, motivo } = portao;

  // Relatório de cortes (não vira corte de produto): só com positivos suficientes; senão `null`.
  let cortesSugeridos = null;
  if (notasPos.length >= minPositivosCortes) {
    const full = percentil(notasPos, 0.1);
    cortesSugeridos = { full, candidate: Math.min(percentil(notasNeg, 0.98) ?? full, full) };
  }

  // Casos de treino por capacidade, ACUMULADOS: o da versão em uso + os positivos novos deste lote (a proteção D5 lê o histórico).
  const anteriores = atual.nTreinoPorCapacidade && typeof atual.nTreinoPorCapacidade === 'object' ? atual.nTreinoPorCapacidade : {};
  const nTreinoPorCapacidade = Object.fromEntries(Object.keys(porCapacidade).map((cap) => [cap, (Number.isFinite(anteriores[cap]) ? anteriores[cap] : 0) + (novosPorCapacidade[cap] ?? 0)]));

  // Reposição atualizada (amostragem em reservatório): os casos novos de treino entram sem passar de `tamanhoReposicao`.
  const r = aleatorio(seed + 13);
  const reservatorio = repoValida.map(({ v, rotulos, neutras }) => ({ v: arredondar(v), rotulos, ...(neutras ? { neutras } : {}) }));
  let vistos = reservatorio.length;
  for (const item of paraReservatorio) {
    vistos++;
    if (reservatorio.length < tamanhoReposicao) reservatorio.push(item);
    else { const j = Math.floor(r() * vistos); if (j < tamanhoReposicao) reservatorio[j] = item; }
  }

  const metricas = Object.fromEntries(Object.entries(porCapacidade).map(([k, m]) => [k, { base: m.base, nova: m.cabeca, atual: m.atual, nRecentes: m.nRecentes, nTreino: m.nTreino }]));
  const arquivo = serializarCabeca(nova, { anel, slug: indice.slug, hash: indice.hash, anelAprovado, metricasAnel, metricas, nTreinoPorCapacidade, cortesSugeridos });
  arquivo.portao = motivo;
  return { ok: true, arquivo, reposicao: reservatorio, slugReposicao: indice.slug, resumo: { ...resumoBase, anelAprovado, portao: motivo, metricasAnel, diagnostico, capacidades: Object.keys(porCapacidade).length } };
}

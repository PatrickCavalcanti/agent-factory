// Treino dentro do app (spec 2026-10-06 §7, Task 13): casos → retrato → embed (thread principal) →
// treinarCabeca num worker_thread → cabeça em data/decisoes/cabecas → invalida o cache da seleção local.
// Uma execução por vez (409), compartilhada com a atualização por lote (trava.js). Em sucesso grava uma VERSÃO
// (cabecas/<anel>/v<n>.json + atual.json) e a reposição da base (decisoes/base/<anel>-reposicao.json, sem texto).
// Fontes de caso: logs (extrair) + registro do treino contínuo (decisoes/registro/casos.jsonl). Tudo injetável para teste; os padrões são os de produção.
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { comCacheEmDisco } from './embedder.js';
import { treinarAnel } from './treino.js';
import { PORTAO_PADRAO } from './dominio.js';
import { carregarCabeca } from '../../src/local/index.js';
import { extrairCasos } from './extrair.js';
import { treinarCabecaNoWorker } from './worker-treino.js';
import { tentarTravar, travado, quemTravou } from './trava.js';
import { gravarVersao, versaoAtual, caminhoAtual, gravarReposicao, registrarHistorico } from './versoes.js';
import { lerCasosAsync, zerarContador, retratoDoContador } from './registro.js';
import { conferenciaDoDataDir, ANEIS_CONFERENCIA } from './conferencia.js';

/** Nós do retrato do anel (0 se não há retrato legível): o "catálogo presente" do treino. */
function catalogoDoAnel(dataDir, anel) {
  try { return (JSON.parse(readFileSync(join(dataDir, 'decisoes', 'indice', `${anel}.json`), 'utf8')).nos || []).length; } catch { return 0; }
}

/** Grava `indice/<anel>-roubados.json` (a calibração mantida) de forma atômica: tmp + rename. */
function gravarCalibracao(dataDir, anel, calibracao) {
  try {
    const dir = join(dataDir, 'decisoes', 'indice');
    mkdirSync(dir, { recursive: true });
    const arquivo = join(dir, `${anel}-roubados.json`);
    const tmp = `${arquivo}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(calibracao));
    renameSync(tmp, arquivo);
    return { ok: true };
  } catch (e) { return { ok: false, erro: e?.message ?? String(e) }; }
}

export const ANEIS_TREINAVEIS = Object.freeze(['provider', 'tool']);

export class ErroDeTreino extends Error {
  constructor(status, mensagem, motivo = null) { super(mensagem); this.name = 'ErroDeTreino'; this.status = status; if (motivo) this.motivo = motivo; }
}

// `undefined` = ausente (vale o padrão). `null` (o que `JSON.stringify(NaN)` produz), NaN, string, fora de [min, max] ou não inteiro = 400.
const numero = (v, padrao, nome, { min = 0, max = Infinity, inteiro = false } = {}) => {
  if (v === undefined) return padrao;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (inteiro && !Number.isInteger(v))) throw new ErroDeTreino(400, `${nome} inválido`);
  return v;
};

/** Opções do portão por capacidade que deixaram de existir com o portão por anel: 400 em vez de ignorar em silêncio. */
const OPCOES_REMOVIDAS = Object.freeze(['min', 'minRecentes']);

/** Cache de embeddings: padrão neutro `<dataDir>/agent-factory/cache` (o Igris passa `(d) => join(d, 'igris', 'cache')`). */
const dirCachePadrao = (dataDir) => join(dataDir, 'agent-factory', 'cache');

/**
 * Valida o body opcional da rota. `portao` = `{margem, minAvaliacao}` da config (`IGRIS_CHAT_FABRICA_TREINO.portao`): são os
 * padrões; o body pode sobrepor `margem` ([-1, 1]), `minAvaliacao` e `dias` numa chamada. `min`/`minRecentes` (portão por capacidade)
 * foram removidos: respondem 400, como NaN/`null`/fora da faixa. Outras chaves desconhecidas continuam ignoradas.
 */
export function lerOpcoes(body, portao = PORTAO_PADRAO) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  for (const k of OPCOES_REMOVIDAS) if (Object.hasOwn(b, k)) throw new ErroDeTreino(400, `\`${k}\` não existe mais (o portão agora é por anel): use minAvaliacao`);
  let aneis = b.aneis ?? [...ANEIS_TREINAVEIS];
  if (!Array.isArray(aneis) || !aneis.length || aneis.some((a) => !ANEIS_TREINAVEIS.includes(a))) throw new ErroDeTreino(400, `aneis deve ser subconjunto de ${ANEIS_TREINAVEIS.join(', ')}`);
  aneis = [...new Set(aneis)];
  return {
    aneis,
    minAvaliacao: numero(b.minAvaliacao, portao.minAvaliacao, 'minAvaliacao', { min: 1, inteiro: true }),
    margem: numero(b.margem, portao.margem, 'margem', { min: -1, max: 1 }),
    dias: numero(b.dias, 14, 'dias', { min: 1, inteiro: true }),
  };
}

/**
 * A versão em uso VÁLIDA do anel (`atual.json`/legado) para o portão, ou `null`: sem versão, ilegível, de outro embedder, ou v1 FORA do
 * `provider` (a produção a ignora — `selecao.js` — porque "irmão não rouba" mudou os centróides dos anéis tool/skill; como régua ela
 * mediria uma cabeça que ninguém usa). Devolve os pesos (`cabeca`) para o treino completo RECALCULAR a versão em uso nos mesmos casos
 * da nova. A dimensão vem da própria versão (`d`): o serviço ainda não montou o índice, quem confere `d` com a dimensão do índice
 * remontado é o `treinarAnel`.
 */
function emUsoDoAnel(dirDecisoes, anel, slug) {
  try {
    const arquivo = caminhoAtual(dirDecisoes, anel);
    if (!arquivo) return null;
    const d = JSON.parse(readFileSync(arquivo, 'utf8'))?.d;
    const c = carregarCabeca({ arquivo, slug, dim: d });
    if (!c.ok) return null;
    if (c.versaoDoArquivo === 1 && anel !== 'provider') return null;
    return { cabeca: c.cabeca, d, versao: versaoAtual(dirDecisoes, anel), anelAprovado: c.anelAprovado, metricasAnel: c.metricasAnel };
  } catch { return null; }
}

/**
 * @param {{ raizPowers?:string, dirCache?:string|((dataDir:string)=>string), obterDataDir:()=>string, obterEmbedder:()=>object|null, invalidar?:(dataDir:string, anel:string)=>void,
 *           extrair?:Function, treinarCabecaFn?:Function, portao?:{margem:number, minAvaliacao:number, toleranciaVersao:number}, agora?:()=>Date }} deps
 *   `portao` = o `IGRIS_CHAT_FABRICA_TREINO.portao` já validado (a rota o lê de `configDoTreino()`); sem ele, o padrão.
 *   `agora` = o relógio do treino: o `quando` do histórico, o `agora` do extrator (o `ehFuturo` dele) e o carimbo do contador/cursor. Em modo bancada o
 *   `Date` global é simulado (`@igris/config/relogio`) e o treino tem de usar a hora REAL: a rota passa `agoraReal`. Padrão: `() => new Date()`.
 */
export function criarServicoDeTreino({ obterDataDir, obterEmbedder, invalidar = () => {}, extrair = extrairCasos, treinarCabecaFn = treinarCabecaNoWorker, obterPiso, portao = PORTAO_PADRAO, agora = () => new Date(), raizPowers, dirCache = dirCachePadrao }) {
  // `obterPiso` é OBRIGATÓRIO: o piso vem do host (derivado de `capacidadeDoPower` + `toolEhFixa`), nunca de um padrão silencioso.
  if (typeof obterPiso !== 'function') throw new TypeError('criarServicoDeTreino: `obterPiso` é obrigatório (função que devolve {ids, fixas, powers?})');
  return {
    get ocupado() { return travado(); },
    /** Relatório de conferência do registro (`GET /api/decisoes/conferencia`): só leitura, sem texto de pedido. */
    async conferencia(query) {
      const q = query && typeof query === 'object' ? query : {};
      const desde = q.desde === undefined || q.desde === '' ? null : q.desde;
      const anel = q.anel === undefined || q.anel === '' ? null : q.anel;
      if (desde !== null && !(typeof desde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desde))) throw new ErroDeTreino(400, 'desde deve ser AAAA-MM-DD');
      if (anel !== null && !ANEIS_CONFERENCIA.includes(anel)) throw new ErroDeTreino(400, `anel deve ser um de ${ANEIS_CONFERENCIA.join(', ')}`);
      const r = await conferenciaDoDataDir(obterDataDir(), { desde, anel });
      if (!r.ok) throw new ErroDeTreino(503, r.motivo);
      const { ok, ...resumo } = r;
      return resumo;
    },
    async treinar(body) {
      const opcoes = lerOpcoes(body, portao);
      const embedderCru = obterEmbedder();
      if (!embedderCru) throw new ErroDeTreino(503, 'FALTA: embedder de roteamento indisponível (canal semântico desligado ou ainda não inicializado)');
      const liberar = tentarTravar('treino-completo');
      if (!liberar) throw new ErroDeTreino(409, `já existe um treino em andamento (${quemTravou()})`);
      try {
        const dataDir = obterDataDir();
        const dirDecisoes = join(dataDir, 'decisoes');
        const dirRegistro = join(dirDecisoes, 'registro');
        const piso = obterPiso() ?? { ids: [], fixas: [] }; // piso INCONDICIONAL (alwaysLoaded): sai do índice inteiro; o piso condicional de cada turno vem em `caso.piso`
        // FALHA FECHADA: piso vazio com catálogo presente e o registry de powers VAZIO (`powers` 0 ou desconhecido) é o registry ainda
        // não carregado — treinar assim poria a memória e as funções fixas nos rótulos. Recusa (503). Registry cheio e sem nenhum power
        // de piso é configuração: segue com o piso vazio (o host já avisou "nenhum power de piso configurado").
        if (!piso.ids?.length && !piso.fixas?.length && !(piso.powers > 0) && opcoes.aneis.some((a) => catalogoDoAnel(dataDir, a) > 0)) {
          throw new ErroDeTreino(503, 'FALTA: sem-piso — o registry de powers ainda não carregou, tente de novo (o piso incondicional veio vazio com o catálogo presente)', 'sem-piso');
        }
        // Retrato no INÍCIO: o que for gravado durante o treino não é consumido por ele e continua contado.
        const consumidos = retratoDoContador(dirRegistro);
        const casosRegistro = await lerCasosAsync(dirRegistro, { validos: true }); // assíncrono: o app não congela lendo o registro cheio
        let ex = await extrair({ dataDir, raizPowers, agora: agora() });
        // Sem logs mas com registro: treina só com o registro.
        if (!ex.ok) { if (!casosRegistro.length) throw new ErroDeTreino(503, `FALTA: ${ex.motivo}`); ex = { ok: true, casos: [] }; }
        // Textos do catálogo (re-montagem do índice a partir do retrato): o MESMO arquivo de cache de embeddings do catálogo (o do Kairos, `cache-semantica.js` do orchestrator).
        // Pedidos dos casos: arquivo próprio — pedido de treino nunca entra no cache compartilhado de produção.
        const dirDoCache = typeof dirCache === 'function' ? dirCache(dataDir) : dirCache;
        const embedder = comCacheEmDisco(embedderCru, join(dirDoCache, 'selecao-embeddings.json'), { roles: ['query'], mesclar: true });
        const embedderPedidos = comCacheEmDisco(embedderCru, join(dirDoCache, 'treino-pedidos-embeddings.json'), { roles: ['query'] });
        const aneis = {};
        for (const anel of opcoes.aneis) {
          const arqRet = join(dataDir, 'decisoes', 'indice', `${anel}.json`);
          let retrato = null;
          try { retrato = existsSync(arqRet) ? JSON.parse(readFileSync(arqRet, 'utf8')) : null; } catch { /* ilegível = sem retrato */ }
          let r;
          try {
            // A versão em uso ANTES deste treino (null se não há, é de outro embedder ou é v1 fora do provider): vira a régua do portão
            // (recalculada nos mesmos casos) e o que `mantida` preserva.
            const emUso = emUsoDoAnel(dirDecisoes, anel, embedder.modelSlug);
            r = await treinarAnel({ anel, retrato, casos: ex.casos, embedder, embedderPedidos, minAvaliacao: opcoes.minAvaliacao, margem: opcoes.margem, tolerancia: portao.toleranciaVersao, emUso, diasRecentes: opcoes.dias, treinarCabecaFn, casosRegistro, excluir: anel === 'provider' ? piso.ids : piso.fixas });
          } catch (e) { r = { ok: false, motivo: `erro: ${e?.message ?? e}` }; }
          try { embedder.salvar(); embedderPedidos.salvar(); } catch { /* cache é só aceleração */ }
          if (!r.ok) { aneis[anel] = { ok: false, motivo: r.motivo }; continue; }
          const quando = agora().toISOString();
          if (r.mantida) {
            // Sem veredito (`poucos-recentes` com versão em uso) ou piorou frente a ela: NADA é gravado nem invalidado, a em uso continua.
            // O histórico registra a rejeição (aparece na conferência) e os casos são consumidos (cursor/contador abaixo).
            const his = registrarHistorico(dirDecisoes, anel, { quando, anel, completo: true, rejeitada: r.motivo, mantida: true, casos: ex.casos.length + casosRegistro.length, anelAprovado: r.resumo.anelAprovado, portao: r.resumo.portao, metricasAnel: r.resumo.metricasAnel, diagnostico: r.resumo.diagnostico, resumo: r.resumo, ate: consumidos.ts, ids: consumidos.ids });
            if (!his.ok) console.warn(`[treino] ${anel}: histórico não gravado (${his.erro})`);
            aneis[anel] = { ok: true, versao: versaoAtual(dirDecisoes, anel), motivo: r.motivo, ...r.resumo };
            continue;
          }
          const v = gravarVersao(dirDecisoes, anel, r.arquivo);
          if (!v.ok) { aneis[anel] = { ok: false, motivo: `erro ao gravar a versão: ${v.erro}` }; continue; }
          // reposição da base (vetor cru, sem texto): a atualização por lote parte dela; sem ela fica adiada (sem-base)
          const rep = gravarReposicao(dirDecisoes, anel, { slug: r.arquivo.slug, casos: r.reposicao || [] });
          if (!rep.ok) console.warn(`[treino] ${anel}: reposição da base não gravada (${rep.erro})`);
          // Entrada de histórico do treino completo (com o cursor consumido): aparece no relatório de conferência como uma atualização.
          // O portão fica no TOPO da entrada (a conferência lê `anelAprovado`/`metricasAnel` dali), não só dentro de `resumo`.
          const his = registrarHistorico(dirDecisoes, anel, { quando, anel, completo: true, casos: ex.casos.length + casosRegistro.length, versao: v.versao, anelAprovado: r.arquivo.anelAprovado, portao: r.arquivo.portao, metricasAnel: r.arquivo.metricasAnel, metricas: r.arquivo.metricas, diagnostico: r.resumo.diagnostico, resumo: r.resumo, ate: consumidos.ts, ids: consumidos.ids });
          if (!his.ok) console.warn(`[treino] ${anel}: histórico não gravado (${his.erro})`);
          // A calibração (exemplos roubados) é MANTIDA: só uma versão adotada a troca, e só o treino completo a grava. O runtime apenas aplica.
          if (r.calibracao) {
            const g = gravarCalibracao(dataDir, anel, r.calibracao);
            if (!g.ok) console.warn(`[treino] ${anel}: calibração não gravada (${g.erro})`);
          }
          invalidar(dataDir, anel);
          aneis[anel] = { ok: true, versao: versaoAtual(dirDecisoes, anel), ...r.resumo, metricas: r.arquivo.metricas }; // resumo: anelAprovado, portao, metricasAnel, diagnostico
        }
        const oks = Object.values(aneis).filter((a) => a.ok);
        // Os casos do registro já foram consumidos: a primeira atualização por lote só pega os posteriores.
        // Só os anéis que treinaram avançam o cursor e zeram o contador (um anel que falhou segue com os casos dele).
        if (oks.length) zerarContador(dirRegistro, { versao: Math.max(...oks.map((a) => a.versao ?? 0)), quando: agora().toISOString(), consumidos, aneis: Object.entries(aneis).filter(([, a]) => a.ok).map(([k]) => k) });
        return { ok: Object.values(aneis).some((a) => a.ok), casos: ex.casos.length, registro: casosRegistro.length, aneis };
      } finally { liberar(); }
    },
  };
}

// Ligação do decisor local de seleção (specs 2026-10-06 e 2026-10-07; semântica do Kairos, 2026-10-08), por HOST. Subiu do Igris
// (`fabrica/selecao.js`): era cola do host com mecanismo genérico, e o Ariadne usa o mesmo. Sem env e sem Igris: `dataDir`, a
// config já lida, `limiaresDoModelo` e o embedder entram por parâmetro (ver "Fiação por turno" em `decisoes/ARCHITECTURE.md`). Uma instância por
// SESSÃO (como o orq), sem catálogo próprio: o índice de cada anel é DERIVADO do `RefineInput` que o Kairos entrega
// (`input.semantica` + `item.semantica`: `indiceDoRefino`; as funções que o anel provider traz: `indiceDeFuncoesDoProvider`). Nada é
// montado nem embedado aqui — o aquecimento do catálogo do Kairos já deixa os vetores prontos e o refine é síncrono.
// Por processo guardamos só: a derivação memoizada por (anel, versão da semântica, calibração, refs do input), a CABEÇA e o índice do CATÁLOGO
// INTEIRO (para o retrato, o treino completo e o lote do treino contínuo). INFERÊNCIA usa só os itens do turno; TREINO usa o catálogo inteiro:
// o orchestrator entrega `manager.semantica()` (Kairos 0.838) depois de cada `reindex` e `registrarCatalogoSemantico` monta o índice, grava o
// retrato e o guarda para `indiceEmUso`. O turno não grava retrato nem alimenta `indiceEmUso`. A calibração dos exemplos roubados é MANTIDA (gravada só pelo treino completo em
// indice/<anel>-roubados.json; o runtime apenas a aplica, nunca recalibra); a cabeça vem de data/decisoes/cabecas. Os CORTES são fixos de
// produto (cortes-fixos.js, com override pela config do host): o estado do anel os carrega junto com o índice. Sem `input.semantica` o refinador
// local devolve a proposta do motor (degradado, `sem-semantica`).
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  exportarRetrato, REGRA_DO_INDICE, carregarCabeca, criarRefinadorLocal, estadoDoAnel, refinadorPorModo, MODOS, hashDosNos,
  normalizarCortesFixos, normalizarFuncaoTraz, CORTES_FIXOS, FUNCAO_TRAZ_PADRAO, capacidadeDoRef,
  indiceDoRefino, indiceDeFuncoesDoProvider, indiceDoCatalogo,
} from './index.js';
import { estadoDoPonteiro } from '../../treino/lib/versoes.js';
import { normalizarRefino } from '../refinadores/turno.js';

export const SELECAO_PADRAO = Object.freeze({
  modos: Object.freeze({ provider: 'local+sombra-jev', tool: 'local+sombra-jev', skill: 'jev+sombra-local' }),
  cortes: CORTES_FIXOS,
  funcaoTrazCapacidade: FUNCAO_TRAZ_PADRAO,
  minCasosCapacidade: 50,
  // Sombra Jev de provider/tool sai depois disto: a chamada do anel skill (Jev decide) chega antes ao gateway.
  atrasoSombraJevMs: 500,
});

/** Derivações memoizadas por processo: passou disso, descarta a mais antiga. */
export const MEMO_MAX = 8;

/** chave (dataDir|anel|tipo|slug|versão|calibração|hash das refs do input) → derivação pronta (só as boas) — ordem de inserção = idade. */
const MEMO = new Map();
/** `${dataDir}|${anel}` → { slug, dim, valor:{cabeca, info} }: a cabeça lida do disco, presa ao embedder/dimensão da semântica. */
const CABECAS = new Map();
/** `${dataDir}|${anel}` → { indice, cabeca, slug }: o índice do CATÁLOGO INTEIRO do anel (o que o retrato, o treino e o lote usam). */
const ULTIMO = new Map();
/** `${dataDir}|${anel}` → { slug, versao, anel }: o último snapshot do anel entregue por `registrarCatalogoSemantico` (referência, não cópia). */
const CATALOGO = new Map();
/** `${dataDir}|${anel}` → versão do catálogo já montada em `ULTIMO` (e com retrato tratado): só muda de versão remonta. `invalidarSelecaoLocal` a limpa. */
const CATALOGO_VISTO = new Map();
/** `${dataDir}|${anel}` → a entrada de `CATALOGO` cuja montagem falhou (sem nós com semântica): não remonta a cada `indiceEmUso`, só quando chega outra versão. */
const FALHAS_DO_CATALOGO = new Map();
/** `${dataDir}|${anel}` → { versao, nos, retrato:'gravado'|'igual'|'nao-gravado' }: o que o último catálogo registrado fez (vai para o trace do refine). */
const ESTADO_DO_CATALOGO = new Map();
/** Avisos por anel/dataDir (cabeça ignorada...): `invalidarSelecaoLocal` os reabre, porque a cabeça pode ter mudado. */
const AVISADOS = new Set();
/** Avisos de CONFIGURAÇÃO: `configDaSelecao` roda a cada sessão, então cada motivo vale uma vez por processo. */
const AVISOS_CONFIG = new Set();
/** `${dataDir}|${anel}` → JSON cru de `indice/<anel>-roubados.json` (só leitura boa); `invalidarSelecaoLocal` o descarta. */
const CALIBRACOES = new Map();
const avisarConfig = (msg) => { if (AVISOS_CONFIG.has(msg)) return; AVISOS_CONFIG.add(msg); console.warn(msg); };
const avisarUma = (chave, msg) => { if (AVISADOS.has(chave)) return; AVISADOS.add(chave); console.warn(msg); };

/**
 * Descarta o que o processo guardou do anel para o dataDir (derivações, CABEÇA e o último índice): o próximo refine rederiva e relê
 * data/decisoes/cabecas/<anel>/atual.json (a versão em uso; sem ponteiro, o legado cabecas/<anel>.json). Chamado pelo treino dentro do
 * app depois de gravar a cabeça nova. O índice do catálogo é remontado (cabeça e calibração novas) na próxima leitura de `indiceEmUso`, a partir do último snapshot do Kairos; sem snapshot ele devolve null.
 * @returns {number} entradas descartadas
 */
export function invalidarSelecaoLocal(dataDir, anel) {
  let n = 0;
  for (const chave of [...MEMO.keys()]) if (chave.startsWith(`${dataDir}|${anel}|`)) { MEMO.delete(chave); n++; }
  if (CABECAS.delete(`${dataDir}|${anel}`)) n++;
  if (ULTIMO.delete(`${dataDir}|${anel}`)) n++;
  FALHAS_DO_CATALOGO.delete(`${dataDir}|${anel}`);
  CATALOGO_VISTO.delete(`${dataDir}|${anel}`); // o snapshot fica: `indiceEmUso` remonta com a cabeça e a calibração novas
  for (const k of [...AVISADOS]) if (k.startsWith(`${dataDir}|${anel}:`)) AVISADOS.delete(k);
  CALIBRACOES.delete(`${dataDir}|${anel}`);
  return n;
}

/**
 * Índice do CATÁLOGO INTEIRO do anel neste processo (montado de `manager.semantica()` por `registrarCatalogoSemantico`), ou null se o Kairos
 * ainda não entregou o catálogo do anel (ou não há nó com semântica):
 * `{ indice, cabeca, anelAprovado, metricasAnel, nTreinoPorCapacidade, slug }` (v2 da cabeça: o portão é do anel; sem
 * `aprovadas`/`cortes`). O `indice.hash` é o do retrato (`hashDosNos` dos nós com texto), não a versão do Kairos. A atualização por lote usa este índice.
 */
export function indiceEmUso(dataDir, anel) {
  const k = `${dataDir}|${anel}`;
  if (!ULTIMO.has(k) && CATALOGO.has(k) && FALHAS_DO_CATALOGO.get(k) !== CATALOGO.get(k)) montarDoCatalogo(dataDir, anel, { gravar: false }); // depois de `invalidarSelecaoLocal`
  const u = ULTIMO.get(k);
  if (!u?.indice) return null;
  return {
    indice: u.indice,
    cabeca: u.cabeca?.cabeca ?? null,
    anelAprovado: u.cabeca?.anelAprovado ?? false,
    metricasAnel: u.cabeca?.metricasAnel ?? null,
    nTreinoPorCapacidade: u.cabeca?.nTreinoPorCapacidade ?? {},
    slug: u.slug,
  };
}

/** Só para teste. */
export function _limparSelecaoParaTestes() { CALIBRACOES.clear(); MEMO.clear(); CABECAS.clear(); ULTIMO.clear(); CATALOGO.clear(); CATALOGO_VISTO.clear(); FALHAS_DO_CATALOGO.clear(); ESTADO_DO_CATALOGO.clear(); AVISADOS.clear(); AVISOS_CONFIG.clear(); }

/** Só para teste: quantas derivações estão memoizadas (provas de reuso do memo). */
export const _memoDeDerivacoesParaTestes = () => MEMO.size;

const ANEIS_DO_CATALOGO = ['provider', 'tool', 'skill'];

/**
 * Monta o índice do catálogo inteiro do anel a partir do último snapshot (`CATALOGO`), com a calibração mantida e a cabeça do anel, e o
 * guarda em `ULTIMO`. `gravar` = grava também o retrato (nós ANTES da calibração, no formato de `nosDoAnel`: o treino remonta e aplica a
 * mesma regra); a remontagem depois de `invalidarSelecaoLocal` não regrava (o retrato só depende do catálogo, e `gravarRetrato` já ignora hash igual).
 */
function montarDoCatalogo(dataDir, anel, { gravar }) {
  const k = `${dataDir}|${anel}`;
  const c = CATALOGO.get(k);
  if (!c) return;
  ULTIMO.delete(k);
  const calLida = calibracaoMantida(dataDir, anel, c.slug);
  const cal = calLida.ok ? calLida : null;
  const r = indiceDoCatalogo(anel, c.anel, c.slug, cal);
  if (!r.ok || !r.indice.nos.size) {
    FALHAS_DO_CATALOGO.set(k, c); // por versão: `indiceEmUso` não remonta até chegar outro catálogo (ou `invalidarSelecaoLocal`)
    ESTADO_DO_CATALOGO.set(k, { versao: c.versao ?? null, nos: 0, retrato: 'nao-gravado' });
    return;
  }
  FALHAS_DO_CATALOGO.delete(k);
  const crua = cal?.roubados?.length ? indiceDoCatalogo(anel, c.anel, c.slug, null).indice : r.indice;
  const hash = hashDosNos([...crua.nos.entries()].map(([ref, no]) => ({ ref, textos: no.textos })));
  const retrato = gravar ? gravarRetrato(dataDir, anel, { anel, slug: c.slug, hash, nos: crua.nos }) : (ESTADO_DO_CATALOGO.get(k)?.retrato ?? 'nao-gravado');
  ESTADO_DO_CATALOGO.set(k, { versao: c.versao ?? null, nos: crua.nos.size, retrato });
  const { cabeca } = cabecaDoAnel(dataDir, anel, c.slug, r.indice.dim);
  ULTIMO.set(k, { indice: { ...r.indice, anel, hash }, cabeca, slug: c.slug });
  CATALOGO_VISTO.set(k, c.versao ?? null);
}

/**
 * Catálogo INTEIRO do Kairos (`manager.semantica()`, entregue pelo orchestrator depois de cada `reindex`): para cada anel presente cuja
 * `versao` mudou desde a última chamada (por dataDir + anel), monta o índice do catálogo todo, grava o retrato
 * (`data/decisoes/indice/<anel>.json`, lido pelo treino completo) e o guarda como o que `indiceEmUso` devolve (treino por lote).
 * `null`/snapshot sem anéis: não faz nada. Nunca lança (o catálogo não pode cair por causa do decisor).
 * @param {string} dataDir
 * @param {{slug?:string, aneis?:Record<string,{itens:ReadonlyMap<string,object>, media:number[], versao:string|null}>}|null} semantica
 */
export function registrarCatalogoSemantico(dataDir, semantica) {
  try {
    const aneis = semantica?.aneis;
    if (!aneis || typeof aneis !== 'object' || !Object.keys(aneis).length) {
      avisarConfig('[fabrica] seleção: Kairos sem semântica do catálogo — retrato e lote sem índice');
      return;
    }
    for (const anel of ANEIS_DO_CATALOGO) {
      const a = aneis[anel];
      if (!a) continue;
      const k = `${dataDir}|${anel}`;
      const versao = a.versao ?? null;
      const slug = semantica.slug ?? null;
      const prev = CATALOGO.get(k);
      if (versao != null && prev?.versao === versao && prev.slug === slug && (CATALOGO_VISTO.get(k) === versao || FALHAS_DO_CATALOGO.get(k) === prev)) continue;
      CATALOGO.set(k, { slug, versao, anel: a });
      montarDoCatalogo(dataDir, anel, { gravar: true });
    }
  } catch (e) { console.warn(`[fabrica] seleção: catálogo semântico não registrado (${e?.message ?? e})`); }
}

/** Chaves de `tetos` e o mínimo de cada uma (o orçamento do Kairos precisa de ≥ 1; os demais aceitam 0). */
const MINIMO_DOS_TETOS = { provider: 0, tool: 0, promocao: 0, kairosTools: 1 };
const ehObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
/** As chaves de topo que `configDaSelecao` lê; qualquer outra é typo ou sobra e avisa (senão o override some em silêncio). */
const CHAVES_DA_SELECAO = new Set(['modos', 'cortes', 'funcaoTrazCapacidade', 'minCasosCapacidade', 'tetos', 'atrasoSombraJevMs']);

/**
 * Cortes da base do decisor local para o embedder ativo (spec 2026-10-11 §4). Override do dono vence (ver `configDaSelecao`).
 * `limiaresDoModelo(slug)` é do host (no Igris, `@igris/embeddings/limiares`): devolve `{ decisorBase: { full, candidate } }`.
 */
export function cortesDaBaseDoModelo(slug, limiaresDoModelo) {
  const { decisorBase } = limiaresDoModelo(slug);
  return { full: decisorBase.full, candidate: decisorBase.candidate };
}

/** Slug do embedder do host: `embedder` pode ser o objeto (`{ modelSlug }`) ou uma função que o devolve (resolvido por turno). */
const slugDoEmbedder = (embedder) => () => (typeof embedder === 'function' ? embedder() : embedder)?.modelSlug ?? null;

// `cortes.base` vira getter: a config nasce uma vez por sessão, possivelmente antes de o embedder do host estar resolvido —
// o slug é lido a CADA acesso (por turno), sem recriar a selecaoLocal (que guarda estado). Sem `limiaresDoModelo` não há linha
// por modelo: vale a base fixa de `CORTES_FIXOS` (a do e5) e a origem fica 'fixo'.
function comBaseDoModelo(cortes, origem, slug, limiaresDoModelo) {
  if (typeof limiaresDoModelo !== 'function') return cortes;
  if (origem?.base === 'override') return cortes;
  origem.base = 'modelo'; // o fabrica.json diz de onde veio: linha do modelo ativo (override continua 'override')
  const saida = { ...cortes };
  Object.defineProperty(saida, 'base', { enumerable: true, configurable: true, get: () => cortesDaBaseDoModelo(slug(), limiaresDoModelo) });
  return saida;
}

/** A base de `config.cortes` já é a do modelo (getter), ou é override do dono: não há o que acrescentar. */
const baseJaResolvida = (config) => config.cortesOrigem?.base === 'override' || typeof Object.getOwnPropertyDescriptor(config.cortes ?? {}, 'base')?.get === 'function';

/**
 * Configuração da seleção (objeto que o host leu do env, de arquivo ou de painel; sem `JSON.parse` aqui): padrão + override. `modos` por anel; `cortes` por ORIGEM
 * (`{cabeca:{full,candidate}, base:{full,candidate}, promocao}` — o formato antigo `cortes.<anel>` é ignorado com aviso);
 * `funcaoTrazCapacidade` (D4b); `minCasosCapacidade` (D5); `tetos` (`{provider?, tool?, promocao?, kairosTools?}`, inteiros ≥ 0 — `kairosTools` ≥ 1;
 * ausente = SEM limite: quem filtra é o corte de nota); `atrasoSombraJevMs` (inteiro ≥ 0, padrão 500). Valor inválido (ou chave desconhecida) cai no padrão / é ignorado,
 * com UM aviso por motivo por processo. `undefined` = sem configuração (padrão, sem aviso); o que não é objeto simples avisa e usa o padrão.
 * `slug` (função) e `limiaresDoModelo` são do host e opcionais: sem `limiaresDoModelo` a base dos cortes é a fixa do produto.
 * @returns {{modos:object, cortes:object, cortesOrigem:object, funcaoTrazCapacidade:object, minCasosCapacidade:number, tetos:{provider?:number, tool?:number, promocao?:number, kairosTools?:number}, atrasoSombraJevMs:number}}
 */
export function configDaSelecao(bruto, { slug = () => null, limiaresDoModelo = null } = {}) {
  const nc0 = normalizarCortesFixos(undefined);
  const cfg = {
    modos: { ...SELECAO_PADRAO.modos },
    cortes: comBaseDoModelo(nc0.cortes, nc0.origem, slug, limiaresDoModelo), cortesOrigem: nc0.origem,
    funcaoTrazCapacidade: normalizarFuncaoTraz(undefined).valor,
    minCasosCapacidade: SELECAO_PADRAO.minCasosCapacidade,
    tetos: {},
    atrasoSombraJevMs: SELECAO_PADRAO.atrasoSombraJevMs,
  };
  if (bruto === undefined) return cfg;
  const j = bruto;
  if (!ehObjeto(j)) { avisarConfig('[fabrica] seleção: configuração não é objeto — usando defaults'); return cfg; }
  for (const k of Object.keys(j)) if (!CHAVES_DA_SELECAO.has(k)) avisarConfig(`[fabrica] seleção: opção desconhecida ${k} — ignorada`);
  if (j.modos !== undefined && !ehObjeto(j.modos)) avisarConfig('[fabrica] seleção: modos inválido (objeto anel → modo) — usando o padrão');
  else {
    for (const [anel, modo] of Object.entries(j.modos ?? {})) {
      if (!(anel in cfg.modos)) { avisarConfig(`[fabrica] seleção: anel desconhecido ${anel}`); continue; }
      if (!MODOS.has(modo)) { avisarConfig(`[fabrica] seleção: modo inválido ${modo} para ${anel}`); continue; }
      cfg.modos[anel] = modo;
    }
  }
  if (j.cortes !== undefined && !ehObjeto(j.cortes)) avisarConfig('[fabrica] seleção: cortes inválido (objeto com cabeca/base/promocao) — usando o padrão');
  const nc = normalizarCortesFixos(j.cortes);
  cfg.cortes = comBaseDoModelo(nc.cortes, nc.origem, slug, limiaresDoModelo); cfg.cortesOrigem = nc.origem;
  for (const m of nc.motivos) avisarConfig(`[fabrica] seleção: ${m} — usando o padrão`);
  if (j.funcaoTrazCapacidade !== undefined && !ehObjeto(j.funcaoTrazCapacidade)) avisarConfig('[fabrica] seleção: funcaoTrazCapacidade inválido (objeto) — usando o padrão');
  const nf = normalizarFuncaoTraz(j.funcaoTrazCapacidade);
  cfg.funcaoTrazCapacidade = nf.valor;
  for (const m of nf.motivos) avisarConfig(`[fabrica] seleção: ${m} — usando o padrão`);
  if (j.minCasosCapacidade !== undefined) {
    if (Number.isInteger(j.minCasosCapacidade) && j.minCasosCapacidade >= 0) cfg.minCasosCapacidade = j.minCasosCapacidade;
    else avisarConfig('[fabrica] seleção: minCasosCapacidade inválido (inteiro ≥ 0) — usando o padrão');
  }
  if (j.atrasoSombraJevMs !== undefined) {
    if (Number.isInteger(j.atrasoSombraJevMs) && j.atrasoSombraJevMs >= 0) cfg.atrasoSombraJevMs = j.atrasoSombraJevMs;
    else avisarConfig('[fabrica] seleção: atrasoSombraJevMs inválido (inteiro ≥ 0) — usando o padrão');
  }
  if (j.tetos !== undefined) {
    if (!ehObjeto(j.tetos)) avisarConfig('[fabrica] seleção: tetos inválido (objeto com provider/tool/promocao/kairosTools) — sem tetos');
    else {
      for (const [k, v] of Object.entries(j.tetos)) {
        if (!(k in MINIMO_DOS_TETOS)) { avisarConfig(`[fabrica] seleção: tetos.${k} desconhecido — ignorado`); continue; }
        if (Number.isInteger(v) && v >= MINIMO_DOS_TETOS[k]) cfg.tetos[k] = v;
        else avisarConfig(`[fabrica] seleção: tetos.${k} inválido (inteiro ≥ ${MINIMO_DOS_TETOS[k]}) — sem teto`);
      }
    }
  }
  return cfg;
}

const lerJson = (arq) => { try { return existsSync(arq) ? JSON.parse(readFileSync(arq, 'utf8')) : null; } catch { return null; /* ilegível: regrava */ } };

/**
 * Retrato só é reescrito quando o hash OU a regra do índice mudam; escrita atômica (tmp + rename). O hash dos nós cobre só os
 * TEXTOS, então a regra (`irmao-nao-rouba`) é gravada à parte: um retrato de antes da D3 (sem `regra`) é regravado mesmo com o
 * hash igual. O runtime NÃO grava `<anel>-roubados.json`: a calibração é mantida e só o treino completo a troca.
 * `retrato` = `{anel, slug, hash, nos}` (nós ANTES da calibração: o treino remonta e aplica a mesma regra).
 * @returns {'gravado'|'igual'|'nao-gravado'}
 */
function gravarRetrato(dataDir, anel, retrato) {
  const dir = join(dataDir, 'decisoes', 'indice');
  const arquivo = join(dir, `${anel}.json`);
  const j = lerJson(arquivo);
  if (j?.hash === retrato.hash && j?.slug === retrato.slug && j?.regra === REGRA_DO_INDICE) return 'igual';
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${arquivo}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...exportarRetrato(retrato), regra: REGRA_DO_INDICE }));
    renameSync(tmp, arquivo);
    return 'gravado';
  } catch (e) { console.warn(`[fabrica] seleção ${anel}: retrato não gravado (${e?.message ?? e})`); return 'nao-gravado'; }
}

/** @returns {{ausente:true}|{ilegivel:true}|object} */
function lerJsonDaCalibracao(dataDir, anel) {
  const arq = join(dataDir, 'decisoes', 'indice', `${anel}-roubados.json`);
  if (!existsSync(arq)) return { ausente: true };
  return lerJson(arq) ?? { ilegivel: true };
}
/**
 * @returns {{ok:true, roubados:object[], resumo:object|null, cortesSugeridos:object|null, hash:string|null}|{ok:false, motivo:string}}
 */
function calibracaoDoJson(j, slug) {
  if (j?.ausente) return { ok: false, motivo: 'sem-arquivo' };
  if (!j || j.ilegivel || !Array.isArray(j.roubados)) return { ok: false, motivo: 'ilegivel' };
  if (j.slug !== slug) return { ok: false, motivo: 'outro-embedder' };
  return { ok: true, roubados: j.roubados, resumo: j.resumo ?? null, cortesSugeridos: j.cortesSugeridos ?? null, hash: typeof j.hash === 'string' ? j.hash : null };
}
/**
 * Calibração mantida do anel (`indice/<anel>-roubados.json`, gravada pelo treino completo) para o embedder `slug`: UMA leitura por (dataDir, anel).
 * O memo guarda SÓ leitura boa (arquivo presente e legível): ausente/ilegível não é memorizado, então o próximo refine relê o disco
 * (o treino pode ter gravado o arquivo nesse meio tempo). `invalidarSelecaoLocal` descarta o memo quando o treino grava versão nova.
 */
function calibracaoMantida(dataDir, anel, slug) {
  const k = `${dataDir}|${anel}`;
  let j = CALIBRACOES.get(k);
  if (!j) { j = lerJsonDaCalibracao(dataDir, anel); if (!j.ausente && !j.ilegivel) CALIBRACOES.set(k, j); }
  return calibracaoDoJson(j, slug);
}

/**
 * Cabeça do anel (cache por dataDir/anel, presa ao `slug` e à `dim` da semântica; `invalidarSelecaoLocal` a descarta).
 * Versão em uso (cabecas/<anel>/atual.json); sem ponteiro cai no legado cabecas/<anel>.json. Sem hash: a cabeça só é presa ao embedder.
 * Ponteiro que EXISTE e está quebrado (ilegível, ou aponta para versão ausente) também cai no legado, mas isso não é o estado normal:
 * diz-se por quê (um aviso por processo) e o info leva `legado: true`. Cabeça v1 fora do provider é ignorada ("irmão não rouba" mudou
 * os centróides dos nós de tool/skill; no provider o nó é a capacidade e a regra não muda nada, então a v1 segue valendo ali).
 * @returns {{cabeca:{cabeca:object, anelAprovado:boolean, nTreinoPorCapacidade:object, metricasAnel:object|null}|null, info:object}}
 */
function cabecaDoAnel(dataDir, anel, slug, dim) {
  const k = `${dataDir}|${anel}`;
  const c = CABECAS.get(k);
  if (c && c.slug === slug && c.dim === dim) return c.valor;
  const avisar = (motivo, msg, destino = 'usando a base') => avisarUma(`${dataDir}|${anel}:${motivo}`, `[fabrica] seleção ${anel}: ${msg} — ${destino}`);
  const ponteiro = estadoDoPonteiro(join(dataDir, 'decisoes'), anel);
  if (ponteiro.motivo) {
    if (ponteiro.legado) avisar(ponteiro.motivo, `atual.json ${ponteiro.motivo}`, `usando a cabeça legada cabecas/${anel}.json`);
    else avisar(ponteiro.motivo, `atual.json ${ponteiro.motivo} e sem cabeça legada`);
  }
  let cabeca = null;
  let info;
  const ld = carregarCabeca({ arquivo: ponteiro.arquivo, slug, dim });
  if (!ld.ok) {
    info = { motivo: ld.motivo };
    if (ld.motivo !== 'sem-arquivo') avisar(ld.motivo, `cabeça ignorada (${ld.motivo})`);
  } else if (ld.versaoDoArquivo === 1 && anel !== 'provider') {
    info = { motivo: 'v1-fora-do-provider' };
    avisar('v1-fora-do-provider', 'cabeça v1 ignorada (centróides mudaram com "irmão não rouba"; vale de novo no retreino v2)');
  } else {
    cabeca = { cabeca: ld.cabeca, anelAprovado: ld.anelAprovado, nTreinoPorCapacidade: ld.nTreinoPorCapacidade, metricasAnel: ld.metricasAnel };
    info = { anelAprovado: ld.anelAprovado, versaoDoArquivo: ld.versaoDoArquivo };
  }
  if (ponteiro.motivo && ponteiro.legado) info = { ...info, legado: true };
  const valor = { cabeca, info };
  CABECAS.set(k, { slug, dim, valor });
  return valor;
}

/**
 * Índice derivado do `RefineInput` (memoizado por anel + versão da semântica do Kairos + calibração + refs do input).
 * `tipo` 'ring' = os itens do anel (`indiceDoRefino`); 'funcoes' = as funções que o anel provider traz (`indiceDeFuncoesDoProvider`),
 * que valem como índice do anel TOOL (D4b) e usam a calibração dele. Sem `versao` não há memo (deriva a cada chamada).
 * A chave leva o hash das REFS do input (em ordem): dois turnos com o mesmo número de itens e refs diferentes têm índices diferentes.
 * @returns {{ok:true, indice:object, removidos:number|null, semSemantica:string[], cal:object}|{ok:false, motivo:string}}
 */
function derivar(dataDir, anel, tipo, input) {
  const s = input?.semantica;
  if (!s) return { ok: false, motivo: 'sem-semantica' };
  const slug = s.slug ?? null;
  const calLida = calibracaoMantida(dataDir, anel, slug);
  const cal = calLida.ok ? calLida : null;
  const itens = Array.isArray(input.items) ? input.items : [];
  const refs = tipo === 'funcoes' ? itens.flatMap((it) => (it.semantica?.funcoes ?? []).map((f) => f.ref)) : itens.map((it) => it.ref);
  const hashRefs = createHash('sha1').update(refs.join('\n')).digest('hex');
  const versao = s.versao ?? null;
  const calKey = cal ? `m:${cal.hash ?? '-'}:${cal.roubados.length}` : `a:${calLida.motivo}`;
  const chave = versao == null ? null : `${dataDir}|${anel}|${tipo}|${slug}|${versao}|${calKey}|${hashRefs}`;
  const memo = chave ? MEMO.get(chave) : null;
  if (memo) { MEMO.delete(chave); MEMO.set(chave, memo); return memo; } // renova a posição: o descarte tira a menos usada
  let out;
  if (tipo === 'funcoes') {
    const ind = indiceDeFuncoesDoProvider(input, cal);
    out = ind.ok ? { ok: true, indice: ind, removidos: null, semSemantica: [], cal: calLida } : { ok: false, motivo: ind.motivo };
  } else {
    const r = indiceDoRefino(input, cal);
    if (!r.ok) out = { ok: false, motivo: r.motivo };
    else if (!r.indice.nos.size) out = { ok: false, motivo: 'sem-nos' };
    else {
      out = { ok: true, indice: { ...r.indice, anel }, removidos: r.removidos, semSemantica: r.semSemantica, cal: calLida };
    }
  }
  if (chave && out.ok) {
    MEMO.set(chave, out);
    while (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value);
  }
  return out;
}

/** Estado do anel para o refine: índice derivado + cabeça + cortes/config (a forma que `criarRefinadorLocal` espera) + `info` para o trace. */
function estadoDoRefino(dataDir, config, anel, input) {
  const versaoKairos = input?.semantica?.versao ?? null;
  const d = derivar(dataDir, anel, 'ring', input);
  if (!d.ok) return { indice: null, motivo: d.motivo, versaoKairos };
  const slug = input.semantica.slug ?? null;
  const cal = d.cal.ok ? d.cal : null;
  if (!cal) avisarUma(`${dataDir}|${anel}:calibracao`, `[fabrica] seleção ${anel}: sem calibração mantida (${d.cal.motivo}) — índice sem remoção de roubados; rode o treino`);
  const { cabeca, info: infoCabeca } = cabecaDoAnel(dataDir, anel, slug, d.indice.dim);
  return {
    indice: d.indice, cortes: config.cortes, cabeca, funcaoTraz: config.funcaoTrazCapacidade, minCasosCapacidade: config.minCasosCapacidade, slug,
    info: {
      versaoKairos, itensSemSemantica: d.semSemantica.length,
      estadoDoAnel: estadoDoAnel({ cabeca }, anel),
      cortes: { origem: config.cortesOrigem, ...config.cortes },
      cortesSugeridos: cal?.cortesSugeridos ?? null,
      resumo: cal?.resumo ?? null,
      roubados: { removidos: d.removidos, irmaos: cal?.resumo?.roubadosIrmaos ?? 0, mascarados: cal?.resumo?.roubadosMascarados ?? 0 },
      calibracao: { origem: cal ? 'mantida' : 'ausente', hash: cal?.hash ?? null },
      cabeca: infoCabeca,
    },
  };
}

/**
 * D4b (anel provider): o estado do anel TOOL derivado das funções que o provider traz em `item.semantica.funcoes`
 * (média própria `mediaFuncoes`, calibração e cabeça do tool). Sem funções → null (o refinador trata como "desconhecido").
 */
function estadoDasFuncoes(dataDir, config, input) {
  const d = derivar(dataDir, 'tool', 'funcoes', input);
  if (!d.ok) return null;
  const slug = input.semantica.slug ?? null;
  const { cabeca } = cabecaDoAnel(dataDir, 'tool', slug, d.indice.dim);
  return { indice: d.indice, cortes: config.cortes, cabeca, funcaoTraz: config.funcaoTrazCapacidade, minCasosCapacidade: config.minCasosCapacidade, slug };
}

/**
 * Marcador de "índice existe" para o estado cruzado do provider no anel tool (D4a): o refinador só pergunta ao provider em que caminho
 * ele está (`estadoDoAnel(ep, 'provider')`, que precisa de `ep.indice` não nulo e de `ep.cabeca`) — nunca pontua nada nesse índice.
 */
const INDICE_SO_DA_CABECA = Object.freeze({ nos: new Map(), somenteDaCabeca: true });

/** D4a (anel tool): só a cabeça do provider (+ marcador de índice), presa ao embedder/dimensão da semântica do refine do tool. */
function estadoDaCabecaDoProvider(dataDir, config, input) {
  const media = input?.semantica?.media;
  if (!Array.isArray(media) || !media.length) return null;
  const slug = input.semantica.slug ?? null;
  // M3: o provider só é "conhecido" se o catálogo dele tem índice (nó com semântica) para o MESMO embedder; senão desconhecido (não promove).
  const u = indiceEmUso(dataDir, 'provider');
  if (!u || u.slug !== slug) return null;
  const { cabeca } = cabecaDoAnel(dataDir, 'provider', slug, media.length);
  return { indice: INDICE_SO_DA_CABECA, cortes: config.cortes, cabeca, funcaoTraz: config.funcaoTrazCapacidade, minCasosCapacidade: config.minCasosCapacidade, slug };
}


/** Resposta degradada de qualquer decisor (Jev ou local) = não é resposta de verdade. */
const degradadoEm = (r) => Object.values(r?.explain || {}).some((x) => /^(jev|local):degradado/.test(String(x?.reason ?? '')));
const resumo = (r) => (r ? { full: r.full ?? [], candidates: r.candidates ?? [] } : null);

/**
 * Para o fabrica.json: `principal`/`sombra` saem resumidos a { full, candidates } (o `explain` inflava o artefato).
 */
export function serializarSelecao(t) {
  if (!t) return null;
  return {
    ...(t.desligado ? { desligado: t.desligado } : {}),
    porAnel: t.porAnel,
    // Tetos efetivos do local neste turno (null = sem limite): o inspetor/analista lê daqui por que uma função ficou fora ou dentro.
    ...(t.tetos ? { tetos: t.tetos } : {}),
    // Capacidades já carregadas quando o turno começou (1º refine do anel provider): fora da disputa das vagas. O inspetor explica a origem com elas.
    ...(Array.isArray(t.ativasNoInicio) ? { ativasNoInicio: [...t.ativasNoInicio] } : {}),
    // Decisão do local por anel (só refs): o que ele carregou, com ou sem Jev em sombra. Base do caso do treino contínuo.
    ...(t.decisoes && Object.keys(t.decisoes).length ? { decisoes: t.decisoes } : {}),
    // Corte próprio de capacidade (corte-de-funcao.js, spec §8): por função avaliada, a nota, o corte e se passou.
    ...(Array.isArray(t.corteDeFuncao) && t.corteDeFuncao.length ? { corteDeFuncao: t.corteDeFuncao } : {}),
    sombras: t.sombras.map((s) => ({
      anel: s.anel, principalDe: s.principalDe, sombraDe: s.sombraDe,
      estado: s.estado === 'pendente' ? 'sem-resposta' : s.estado,
      msPrincipal: s.msPrincipal, msSombra: s.msSombra, erro: s.erro, erroPrincipal: s.erroPrincipal ?? null,
      principal: resumo(s.principal), sombra: resumo(s.sombra),
      // Por decisor: concordância exige os dois limpos; "trouxe" e latência do local degradado dependem só de quem degradou.
      ...(degradadoEm(s.principal) ? { degradadoPrincipal: true } : {}),
      ...(degradadoEm(s.sombra) ? { degradadoSombra: true } : {}),
      ...(degradadoEm(s.principal) || degradadoEm(s.sombra) ? { degradado: true } : {}),
    })),
  };
}


const arred4 = (x) => Math.round(x * 1e4) / 1e4;

/** Origem da nota registrada no caso: pelo prefixo do `reason` do refinador (`local:cabeca`, `local:funcao-trouxe`, o resto é base). */
const origemDoReason = (reason) => {
  const r = String(reason ?? '');
  if (r.startsWith('local:cabeca')) return 'cabeca';
  if (r.startsWith('local:funcao-trouxe')) return 'funcao';
  return 'base';
};

/**
 * Registra no trace o que o LOCAL decidiu no anel (qualquer modo; também quando ele é a sombra), com a nota, a origem
 * (`cabeca`|`funcao`|`base`) e o motivo cru (`reason`, até 80 caracteres: guarda sufixos como ` (promocao)`) de cada ref; na origem
 * `funcao` leva também `funcao: {ref, nota}` (a função que trouxe a capacidade e a nota dela). Ref que o refinador marcou `doMotor` (o `full` dele não
 * depende da nota: proposta `full` do kairos num anel que não rebaixa) leva `doMotor: true` na nota — é o que tira o ref da carga à toa NOVA
 * (`cargaNovaDe`). Entre refines do mesmo turno vale a regra de `doMotorDe` (abaixo): o ref que um refine anterior pôs em `full` pela nota não é marcado
 * por uma proposta `full` que é consequência dessa decisão.
 * O anel pode ser refinado mais de uma vez no turno: acumula a UNIÃO de full/candidates
 * (full vence candidate) e uma chamada degradada nunca sobrescreve uma decisão não degradada.
 */
const MAX_DESCARTADAS = 40;
/** Nota da cabeça e nota da base do item (o refinador local manda as duas quando calcula; 10/10), com 4 casas. */
function comAsDuasNotas(alvo, e) {
  if (Number.isFinite(e?.notaCabeca)) alvo.notaCabeca = arred4(e.notaCabeca);
  if (Number.isFinite(e?.notaBase)) alvo.notaBase = arred4(e.notaBase);
  return alvo;
}

export function registrarDecisao(trace, anel, r) {
  const decisoes = (trace.decisoes ??= {});
  const degradado = degradadoEm(r);
  const prev = decisoes[anel];
  if (degradado) { if (!prev) decisoes[anel] = { full: [...(r?.full || [])], candidates: [...(r?.candidates || [])], degradado: true }; return; }
  const base = prev && !prev.degradado ? prev : { full: [], candidates: [], notas: {} };
  const full = [...new Set([...base.full, ...(r?.full || [])])];
  const candidates = [...new Set([...base.candidates, ...(r?.candidates || [])])].filter((x) => !full.includes(x));
  const notas = { ...(base.notas || {}) };
  const doMotorDe = (ref, e) => {
    const antes = base.full.includes(ref) ? base.notas?.[ref] : undefined; // nota do ref quando um refine anterior do turno já o pôs em full
    if (antes?.doMotor === true) return true;
    if (antes) return false;
    return e.doMotor === true;
  };
  for (const ref of [...(r?.full || []), ...(r?.candidates || [])]) {
    const e = r?.explain?.[ref];
    if (e && Number.isFinite(e.confidence)) {
      const origem = origemDoReason(e.reason);
      notas[ref] = { nota: arred4(e.confidence), origem, reason: String(e.reason ?? '').slice(0, 80) };
      // Capacidade trazida por função (D4b): `nota` é a da capacidade; a função que a trouxe e a nota dela vão à parte.
      if (origem === 'funcao' && typeof e.funcao?.ref === 'string' && Number.isFinite(e.funcao.nota)) notas[ref].funcao = { ref: e.funcao.ref, nota: arred4(e.funcao.nota) };
      // Ficou `full` por regra do MOTOR (anel que não rebaixa abaixo da proposta do kairos), não pela nota: campo próprio, nunca sufixo do `reason`
      // (cortado em 80). Ausente = o `full` veio da nota. Vários refines no turno: se um refine ANTERIOR já pôs o ref em `full` pela nota, a proposta
      // `full`/carregada que o refine seguinte vê é consequência dessa decisão (o 2º refine do provider vê em `loadedProviders` o que o 1º trouxe; o
      // kairos propõe `full` a função de capacidade que o 1º refine do tool promoveu) — o corte ainda a controla e a marca não vale; se o anterior já
      // a marcou, o motor já a segurava e a marca fica; senão vale a deste refine.
      if (doMotorDe(ref, e)) notas[ref].doMotor = true;
      comAsDuasNotas(notas[ref], e);
    }
  }
  // Descartados com nota (10/10): a revisão de cortes precisa saber o que ficou fora e por quanto. Um refine posterior que traga o ref o tira daqui.
  const descartadas = { ...(base.descartadas || {}) };
  for (const [ref, e] of Object.entries(r?.explain || {})) {
    if (full.includes(ref) || candidates.includes(ref) || !e || !Number.isFinite(e.confidence)) continue;
    descartadas[ref] = comAsDuasNotas({ nota: arred4(e.confidence), origem: origemDoReason(e.reason) }, e);
  }
  for (const ref of [...full, ...candidates]) delete descartadas[ref];
  // Teto: as `MAX_DESCARTADAS` de maior nota (o anel tool chega a ~110 itens por turno; o resto não muda nenhuma revisão de corte).
  const topo = Object.entries(descartadas).sort((a, b) => b[1].nota - a[1].nota).slice(0, MAX_DESCARTADAS);
  decisoes[anel] = { full, candidates, degradado: false, notas, ...(topo.length ? { descartadas: Object.fromEntries(topo) } : {}) };
}

/**
 * Teto de promoção POR TURNO (spec §3.4): a P1 do kairos promove o provider de toda função `full` de capacidade nova (fora do
 * turno), sem olhar o teto do provider, e o anel tool pode ser refinado mais de uma vez no turno (discover repetido, I3a).
 * Depois de cada refine do tool, as capacidades NOVAS cujas funções saíram `full` entram em `trace.promovidasNoTurno`
 * (Set); o wrapper desconta o tamanho do Set do teto da chamada seguinte. "Nova" = a mesma definição do refinador: fora de
 * `state.loadedProviders` e sem nenhum item não-pinned com `proposedTier` ≠ `discard`; item pinned/hasManual é fixo (o teto não
 * se aplica) e resposta degradada é a proposta do motor, não decisão do local — nenhum dos dois conta.
 */
export function registrarPromovidasNoTurno(trace, input, r) {
  if (!r || degradadoEm(r)) return;
  const itens = Array.isArray(input?.items) ? input.items : [];
  const doTurno = new Set(Array.isArray(input?.state?.loadedProviders) ? input.state.loadedProviders : []);
  for (const it of itens) if (!it.meta?.pinned && it.proposedTier !== 'discard') doTurno.add(capacidadeDoRef('tool', it.ref));
  const porRef = new Map(itens.map((it) => [it.ref, it]));
  for (const ref of r.full || []) {
    const it = porRef.get(ref);
    if (!it || it.meta?.pinned || it.meta?.hasManual) continue;
    const cap = capacidadeDoRef('tool', ref);
    if (doTurno.has(cap)) continue;
    (trace.promovidasNoTurno ??= new Set()).add(cap);
  }
}

const ANEIS = ['provider', 'tool', 'skill'];

/**
 * Uma instância por SESSÃO. `limiaresDoModelo(slug)` (do host; `{ decisorBase: { full, candidate } }`) e `embedder` (objeto com
 * `modelSlug`, ou função que o devolve — o embedder pode ainda não estar pronto quando a sessão nasce) dizem a base dos cortes do
 * modelo ativo: se informados e a `config` ainda não resolveu a base (nem é override do dono), `cortes.base` passa a ser lido por
 * turno do slug do embedder. Sem `limiaresDoModelo` a `config` vale como veio.
 * @param {{dataDir:string, config:object, limiaresDoModelo?:(slug:string|null)=>{decisorBase:{full:number,candidate:number}}, embedder?:object|(()=>object|null)|null}} p
 */
export function criarSelecaoLocal({ dataDir, config: configDada, limiaresDoModelo = null, embedder = null }) {
  let config = configDada;
  if (typeof limiaresDoModelo === 'function' && !baseJaResolvida(configDada)) {
    const cortesOrigem = { ...configDada.cortesOrigem };
    config = { ...configDada, cortesOrigem, cortes: comBaseDoModelo(configDada.cortes, cortesOrigem, slugDoEmbedder(embedder), limiaresDoModelo) };
  }
  return {
    /** Modo configurado do anel (o turno usa para saber se o Jev está só em sombra). */
    modoDe(anel) { return config.modos[anel]; },
    /**
     * @param {{jev:object, trace:{porAnel:object, sombras:object[]}, ativo?:boolean, refino?:object}} p
     * @returns {{provider?, tool?, skill?}}
     */
    refinadores({ jev, trace, ativo = true, refino = normalizarRefino() }) {
      const saida = {};
      // `ativo: false` = "sem decisor nenhum no refino" (o host desligou o decisor): nem o local entra.
      if (!ativo) { trace.desligado = 'decisor-0'; return saida; }
      // Tetos do local (`config.tetos`): ausente = SEM limite — quem filtra é o corte de nota. `promocao` limita as
      // capacidades NOVAS que a P1 do kairos promove pelo anel tool; é um teto POR TURNO: o anel tool pode ser refinado mais de uma vez
      // no turno, então o que já foi promovido (`trace.promovidasNoTurno`, abaixo) sai do teto de cada chamada seguinte. O estado é
      // montado a cada refine, então o teto chega a ele sem tocar em nada compartilhado.
      const tetosCfg = config.tetos ?? {};
      const tetoDoProvider = Number.isInteger(tetosCfg.promocao) ? tetosCfg.promocao : null;
      trace.tetos = { provider: tetosCfg.provider ?? null, tool: tetosCfg.tool ?? null, promocao: tetoDoProvider };
      // O local só conta promoção quando ele é quem decide o anel (em `jev+sombra-local` a resposta dele é sombra e não vai ao kairos).
      const localDecide = (anel) => config.modos[anel] === 'local' || config.modos[anel] === 'local+sombra-jev';
      const cruzado = (anel, outro, estado) => {
        const t = trace.porAnel[anel];
        if (t) t.cruzado = { ...(t.cruzado || {}), [outro]: estado }; // no objeto FRESCO deste refine, nunca no `info` cacheado
      };
      for (const anel of ANEIS) {
        const obterEstado = (input) => {
          const e = estadoDoRefino(dataDir, config, anel, input);
          const cat = ESTADO_DO_CATALOGO.get(`${dataDir}|${anel}`);
          trace.porAnel[anel] = e.indice
            ? { estado: 'pronto', ...e.info, ...(cat ? { catalogo: { ...cat } } : {}) }
            : { estado: 'degradado', motivo: e.motivo, ...(e.versaoKairos != null ? { versaoKairos: e.versaoKairos } : {}), ...(cat ? { catalogo: { ...cat } } : {}) };
          if (anel === 'tool') return tetoDoProvider === null ? e : { ...e, tetoProvider: Math.max(0, tetoDoProvider - (trace.promovidasNoTurno?.size ?? 0)) };
          // Provider: as "carregadas" da ordem das vagas são as ativas ANTES do turno (capturadas no 1º refine do provider, em `local`
          // abaixo), não o `loadedProviders` do refine corrente — o 2º refine do turno (promoção do kairos) já vê ali as que o 1º pôs em full.
          if (anel === 'provider') return { ...e, ativasNoInicio: trace.ativasNoInicio ?? null };
          return e;
        };
        // Estado do OUTRO anel, só como contexto do refinador, derivado do MESMO input (nada montado fora dele):
        //  - D4b (anel provider pergunta pelo `tool`): índice das funções que o provider traz (`item.semantica.funcoes`), com a cabeça do tool;
        //  - D4a (anel tool pergunta pelo `provider`): só o estado da cabeça do provider (o refinador usa `estadoDoAnel`), com um
        //    marcador de índice não nulo — nenhuma pontuação acontece nesse índice.
        // Devolve null quando não há como saber (sem funções, sem semântica, erro): o refinador trata null como "desconhecido".
        // NÃO grava no `trace.porAnel` do OUTRO anel; registra no do anel que consulta, em `cruzado`, em que pé estava o outro
        // (`pronto` | `falhou` | `erro`).
        const obterEstadoDe = (outro, input) => {
          let e = null;
          try {
            if (anel === 'provider' && outro === 'tool') e = estadoDasFuncoes(dataDir, config, input);
            else if (anel === 'tool' && outro === 'provider') e = estadoDaCabecaDoProvider(dataDir, config, input);
          } catch { cruzado(anel, outro, 'erro'); return null; }
          cruzado(anel, outro, e ? 'pronto' : 'falhou');
          return e;
        };
        // Teto de full do local: provider/tool vêm de `config.tetos` (ausente = sem limite). O anel skill segue o `maxFull` do refino do Jev
        // (o objeto de refino do host, `normalizarRefino`) e, ausente, o TETOS_FULL.skill do refinador — não foi pedido mexer nele.
        const teto = anel === 'skill' ? refino?.skill?.maxFull : tetosCfg[anel];
        // Treino contínuo: o vetor da consulta do turno (já calculado pelo kairos) fica no trace, na PRIMEIRA chamada do
        // refinador local do turno. Não muda o resultado; `serializarSelecao` não o leva (fabrica.json não incha).
        // CONTRATO: `query.vectors[0]` é o vetor do PEDIDO (o lote e o treino completo usam só ele); a pista de contexto
        // (B3.3), quando existe, vem depois — não reordene.
        // `ativasNoInicio`: capacidades já carregadas quando o turno começou (`state.loadedProviders` da primeira chamada do anel
        // provider). O treino mede o que PRECISOU ENTRAR (usadas - ativasNoInicio); o caso do turno o guarda.
        const local0 = criarRefinadorLocal({ anel, obterEstado, obterEstadoDe, ...(Number.isFinite(teto) ? { tetoFull: teto } : {}) });
        const local = async (input) => {
          if (!trace.vetoresConsulta && Array.isArray(input?.query?.vectors) && input.query.vectors.length) trace.vetoresConsulta = [...input.query.vectors];
          // Slug do embedder da semântica do Kairos neste turno: o caso do treino contínuo o grava (não depende de o catálogo já ter chegado).
          if (!trace.embedderSlug && typeof input?.semantica?.slug === 'string') trace.embedderSlug = input.semantica.slug;
          if (anel === 'provider' && !trace.ativasNoInicio && Array.isArray(input?.state?.loadedProviders)) trace.ativasNoInicio = [...input.state.loadedProviders];
          const r = await local0(input);
          try { registrarDecisao(trace, anel, r); } catch { /* observabilidade */ }
          if (anel === 'tool' && localDecide(anel)) { try { registrarPromovidasNoTurno(trace, input, r); } catch { /* observabilidade */ } }
          return r;
        };
        const r = refinadorPorModo({ modo: config.modos[anel], local, jev: jev?.[anel] || null, aoSombra: (reg) => trace.sombras.push(reg), atrasoSombraJevMs: config.atrasoSombraJevMs });
        if (r) saida[anel] = r;
      }
      return saida;
    },
  };
}

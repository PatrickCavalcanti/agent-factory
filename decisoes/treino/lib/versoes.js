// Versões da cabeça (spec 2026-10-07): data/decisoes/cabecas/<anel>/v<n>.json + atual.json (ponteiro) +
// historico.jsonl. Todo arquivo entra por tmp + rename. `cabecas/<anel>.json` (legado, pré-versões) continua
// valendo enquanto não houver ponteiro. Nenhuma função lança por I/O.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dirDoAnel = (dir, anel) => join(dir, 'cabecas', anel);
const nomeVersao = (n) => `v${n}.json`;
export const VERSOES_MANTIDAS = 10;

function gravarAtomico(arq, texto) {
  writeFileSync(`${arq}.tmp`, texto);
  renameSync(`${arq}.tmp`, arq);
}

/** Números das versões existentes, em ordem crescente. */
export function listarVersoes(dir, anel) {
  try {
    return readdirSync(dirDoAnel(dir, anel)).map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  } catch { return []; }
}

/** `ausente`: não há atual.json (estado normal de antes das versões). `ilegivel`: existe e não dá para usar (JSON quebrado, campos faltando, erro de leitura). */
function lerPonteiroDetalhado(dir, anel) {
  const arq = join(dirDoAnel(dir, anel), 'atual.json');
  if (!existsSync(arq)) return { estado: 'ausente', p: null };
  try {
    const j = JSON.parse(readFileSync(arq, 'utf8'));
    return Number.isInteger(j?.versao) && typeof j.arquivo === 'string' ? { estado: 'ok', p: j } : { estado: 'ilegivel', p: null };
  } catch { return { estado: 'ilegivel', p: null }; }
}

const lerPonteiro = (dir, anel) => lerPonteiroDetalhado(dir, anel).p;

/** Grava a cabeça como a próxima versão e aponta `atual.json` para ela. @returns {{ok:true, versao:number, caminho:string}|{ok:false, erro:string}} */
export function gravarVersao(dir, anel, arquivoCabeca) {
  try {
    const pasta = dirDoAnel(dir, anel);
    mkdirSync(pasta, { recursive: true });
    const n = Math.max(0, ...listarVersoes(dir, anel)) + 1;
    const caminho = join(pasta, nomeVersao(n));
    gravarAtomico(caminho, JSON.stringify({ ...arquivoCabeca, versaoDaCabeca: n }));
    gravarAtomico(join(pasta, 'atual.json'), JSON.stringify({ versao: n, arquivo: nomeVersao(n) }));
    // Poda: só as `VERSOES_MANTIDAS` mais recentes ficam (a atual é sempre a mais nova aqui, e nunca é apagada).
    const podadas = [];
    for (const v of listarVersoes(dir, anel).slice(0, -VERSOES_MANTIDAS)) {
      if (v === n) continue;
      try { unlinkSync(join(pasta, nomeVersao(v))); podadas.push(v); } catch { /* poda é higiene */ }
    }
    return { ok: true, versao: n, caminho, podadas };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

/**
 * A cabeça em uso e, quando o ponteiro está quebrado, por que ela é o legado. `arquivo`: a versão apontada, ou o legado
 * `cabecas/<anel>.json`; null se nenhum existe. `legado`: `arquivo` é o legado. `motivo`: `null` (ponteiro bom, ou sem `atual.json`,
 * o estado normal de antes das versões) | `'ponteiro-ilegivel'` (`atual.json` existe e não dá para usar) | `'versao-ausente'`
 * (aponta para uma versão que não está em disco). Com motivo, `arquivo` é o legado (ou null): a cabeça treinada NÃO está valendo.
 * @returns {{arquivo:string|null, legado:boolean, motivo:null|'ponteiro-ilegivel'|'versao-ausente'}}
 */
export function estadoDoPonteiro(dir, anel) {
  const { estado, p } = lerPonteiroDetalhado(dir, anel);
  let motivo = null;
  if (estado === 'ilegivel') motivo = 'ponteiro-ilegivel';
  else if (p) {
    const arq = join(dirDoAnel(dir, anel), p.arquivo);
    if (existsSync(arq)) return { arquivo: arq, legado: false, motivo: null };
    motivo = 'versao-ausente';
  }
  const legado = join(dir, 'cabecas', `${anel}.json`);
  return existsSync(legado) ? { arquivo: legado, legado: true, motivo } : { arquivo: null, legado: false, motivo };
}

/** Caminho da cabeça em uso: a versão apontada, ou o arquivo legado `cabecas/<anel>.json`; null se nenhum existe. */
export function caminhoAtual(dir, anel) {
  return estadoDoPonteiro(dir, anel).arquivo;
}

/** Versão em uso (número) ou null quando só há legado/nada. */
export function versaoAtual(dir, anel) {
  const p = lerPonteiro(dir, anel);
  return p && existsSync(join(dirDoAnel(dir, anel), p.arquivo)) ? p.versao : null;
}

/** Move o ponteiro para a versão existente imediatamente anterior à atual. */
export function voltar(dir, anel) {
  try {
    const atual = versaoAtual(dir, anel);
    if (atual === null) return { ok: false, erro: 'sem versão atual' };
    const anterior = listarVersoes(dir, anel).filter((n) => n < atual).at(-1);
    if (anterior === undefined) {
      // Sem versão anterior: se existe o legado (cabecas/<anel>.json, pré-versões), solta o ponteiro e o legado volta a valer.
      if (existsSync(join(dir, 'cabecas', `${anel}.json`))) {
        unlinkSync(join(dirDoAnel(dir, anel), 'atual.json'));
        return { ok: true, versao: null, legado: true };
      }
      return { ok: false, erro: 'sem versão anterior' };
    }
    gravarAtomico(join(dirDoAnel(dir, anel), 'atual.json'), JSON.stringify({ versao: anterior, arquivo: nomeVersao(anterior) }));
    return { ok: true, versao: anterior };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

/** Uma linha por atualização (ou falha) em cabecas/<anel>/historico.jsonl. */
export function registrarHistorico(dir, anel, entrada) {
  try {
    mkdirSync(dirDoAnel(dir, anel), { recursive: true });
    appendFileSync(join(dirDoAnel(dir, anel), 'historico.jsonl'), `${JSON.stringify(entrada)}\n`);
    return { ok: true };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

export function lerHistorico(dir, anel) {
  try {
    return readFileSync(join(dirDoAnel(dir, anel), 'historico.jsonl'), 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** Reposição da base por anel (decisoes/base/<anel>-reposicao.json): vetores CRUS arredondados, sem texto. */
export function gravarReposicao(dir, anel, { slug, casos }) {
  try {
    const pasta = join(dir, 'base');
    mkdirSync(pasta, { recursive: true });
    gravarAtomico(join(pasta, `${anel}-reposicao.json`), JSON.stringify({ versao: 2, slug, criadaEm: new Date().toISOString(), casos }));
    return { ok: true };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

/** A reposição do anel existe em disco? (checagem barata: sem ler nem parsear o arquivo, que pode ter MBs) */
export const reposicaoExiste = (dir, anel) => existsSync(join(dir, 'base', `${anel}-reposicao.json`));

/** @returns {{ok:true, slug:string|null, casos:{v:number[], rotulos:string[]}[]}|{ok:false, motivo:string}} */
export function lerReposicao(dir, anel) {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'base', `${anel}-reposicao.json`), 'utf8'));
    if (j?.versao !== 2 || !Array.isArray(j.casos)) return { ok: false, motivo: 'versao' };
    return { ok: true, slug: j.slug ?? null, casos: j.casos };
  } catch { return { ok: false, motivo: 'sem-arquivo' }; }
}

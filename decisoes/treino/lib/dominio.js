// Primitivas de domínio/alvo/recall dos anéis (compartilhadas pelo treino completo, pelo lote e pelo caso do registro).
import { pontuarNo } from '../../src/local/index.js';
import { capacidadeDoRef } from '../../src/local/refs.js';

// Capacidades distratoras (de maior nota base entre as não usadas) que entram no domínio do anel tool, além das usadas: 5, mais perto
// do que o 2º estágio recebe em produção (capacidades inteiras + candidatas). Era 2, herança da spec 1; a spec 2026-10-07 §5.7 passa a 5.
const DISTRATORAS = 5;
export const MIN_CANDIDATOS_RECALL = 4; // caso com <= 3 candidatos não discrimina no recall@3

export { capacidadeDoRef };
// No anel tool o alvo é a função usada DENTRO de uma capacidade usada (nome igual em outra capacidade não conta).
export const alvosDoCaso = (anel, caso, refs) => (anel === 'provider'
  ? (caso.capacidades || []).filter((c) => refs.includes(c))
  : refs.filter((r) => (caso.capacidades || []).includes(capacidadeDoRef(anel, r)) && (caso.funcoes || []).some((f) => r.endsWith(`/tool/${f}`))));

export function recall3(notas, alvos, candidatos) {
  const ord = candidatos.map((r) => [r, notas.get(r) ?? -Infinity]).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
  return alvos.filter((a) => ord.includes(a)).length / alvos.length;
}

/** Padrão do portão por anel (spec 2026-10-07 §6): vive em `IGRIS_CHAT_FABRICA_TREINO.portao` (é do treino, não da seleção). */
export const PORTAO_PADRAO = Object.freeze({ margem: 0, minAvaliacao: 30, toleranciaVersao: 0.02 });
const VALIDADORES_PORTAO = {
  margem: (v) => typeof v === 'number' && Number.isFinite(v) && v >= -1 && v <= 1,
  minAvaliacao: (v) => Number.isInteger(v) && v >= 1,
  toleranciaVersao: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
};
/**
 * Padrão + override validado (mesmo contrato das demais opções de config): sub-opção inválida ou desconhecida cai no padrão e
 * vira um motivo para o chamador avisar. `bruto` ausente = tudo no padrão, sem motivo.
 * @returns {{valor:{margem:number, minAvaliacao:number, toleranciaVersao:number}, motivos:string[]}}
 */
export function normalizarPortao(bruto) {
  const valor = { ...PORTAO_PADRAO }; const motivos = [];
  if (bruto === undefined || bruto === null) return { valor, motivos };
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { valor, motivos: ['portao não é objeto — usando o padrão'] };
  for (const [k, v] of Object.entries(bruto)) {
    // hasOwn: `k in obj` aceitaria '__proto__'/'constructor' herdados (e `VALIDADORES_PORTAO.__proto__(v)` lançaria)
    if (!Object.hasOwn(VALIDADORES_PORTAO, k)) { motivos.push(`portao.${k}: opção desconhecida`); continue; }
    if (!VALIDADORES_PORTAO[k](v)) { motivos.push(`portao.${k}: valor inválido (${JSON.stringify(v)}) — usando ${PORTAO_PADRAO[k]}`); continue; }
    valor[k] = v;
  }
  return { valor, motivos };
}

/** Origens dos casos de avaliação (funil do diagnóstico): `log` (janela), `registro-avaliacao` (`avaliacao: true`), `registro-treino` (janela). */
export const FONTES_AVALIACAO = Object.freeze(['log', 'registro-avaliacao', 'registro-treino']);
/** Funil da avaliação: brutos = semDominio + semAlvo + jaAtivos + poucosCandidatos + julgados (por origem). */
export const novoFunil = () => Object.fromEntries(FONTES_AVALIACAO.map((f) => [f, { brutos: 0, semDominio: 0, semAlvo: 0, jaAtivos: 0, poucosCandidatos: 0, julgados: 0 }]));
/** Contagem pareada por caso do R@3 da cabeça × base. */
export const novoPareado = () => ({ cabecaVenceu: 0, baseVenceu: 0, empate: 0 });
export function contarPareado(pareado, rCab, rBase) {
  if (rCab > rBase + 1e-9) pareado.cabecaVenceu++; else if (rBase > rCab + 1e-9) pareado.baseVenceu++; else pareado.empate++;
}

const EPS = 1e-9; // R@3 é média de frações: a fronteira exata (0,58 × 0,60 − 0,02) não pode virar rejeição por 1 ulp

/**
 * Portão POR ANEL (spec 2026-10-07 §5; revisão da Fase 3, 08/10): a cabeça é aprovada se o R@3 dela sobre TODAS as capacidades do
 * anel, nos casos de avaliação, é ≥ o R@3 da base + `margem`. Mora aqui (e não em treino.js) para o treino completo e o lote usarem a
 * MESMA função sem importar um ao outro.
 *
 * `emUso` = a versão em uso VÁLIDA, ou `null` (nenhuma; de outro embedder/dimensão; ou v1 fora do `provider`, que a produção ignora):
 * `{ r3Atual, r3Nova }` = o R@3 da versão em uso RECALCULADO nos mesmos casos em que se mede o R@3 da nova (`r3Nova`). O número que
 * ela gravou é de outra amostra e não serve de régua: com n ≈ 100 o erro-padrão de cada R@3 é ≈ 0,05, maior que a tolerância.
 *
 * Decisão (`acao`):
 * - `aprovada` → `gravar`, anel na cabeça.
 * - `nao-ganhou` (R@3 da cabeça < base + margem) → `gravar`, anel na BASE (a versão nova vale como ponto de partida do lote).
 * - `piorou-frente-a-atual` (`r3Nova < r3Atual − tolerancia`) → `mantida`: REJEIÇÃO, a nova não é gravada e a em uso continua.
 * - `poucos-recentes` (n < `minAvaliacao`: não há veredito) → `mantida` se há versão em uso válida; sem ela, `gravar` com o anel na base.
 * Não existe "herdar": uma cabeça nova não avaliada nunca recebe a aprovação da anterior.
 * @param {{r3Cabeca:number, r3Base:number, nAvaliacao:number, minAvaliacao?:number, margem?:number, tolerancia?:number, emUso?:{r3Atual:number|null, r3Nova:number|null}|null}} o
 * @returns {{acao:'gravar'|'mantida', anelAprovado:boolean, motivo:'aprovada'|'nao-ganhou'|'piorou-frente-a-atual'|'poucos-recentes'}}
 */
export function avaliarPortaoAnel({ r3Cabeca, r3Base, nAvaliacao, minAvaliacao = 30, margem = 0, tolerancia = 0.02, emUso = null }) {
  if (nAvaliacao < minAvaliacao) return { acao: emUso ? 'mantida' : 'gravar', anelAprovado: false, motivo: 'poucos-recentes' };
  if (emUso && Number.isFinite(emUso.r3Atual) && Number.isFinite(emUso.r3Nova) && emUso.r3Nova < emUso.r3Atual - tolerancia - EPS) return { acao: 'mantida', anelAprovado: false, motivo: 'piorou-frente-a-atual' };
  if (!(r3Cabeca + EPS >= r3Base + margem)) return { acao: 'gravar', anelAprovado: false, motivo: 'nao-ganhou' };
  return { acao: 'gravar', anelAprovado: true, motivo: 'aprovada' };
}

/**
 * Domínio de candidatos do caso, o mesmo da produção: no anel tool o refinador só vê as tools das
 * capacidades que o provider trouxe (as usadas + distratoras). No treino: usadas + as 5 capacidades de maior
 * nota base entre as não usadas. Anel provider: todos os candidatos. Devolve índices de `refs`; null = caso sem
 * capacidade usada no catálogo (nada a aprender nesse domínio).
 */
export function dominioDoCaso(anel, caso, refs, indice) {
  if (anel === 'provider') return refs.map((_, i) => i);
  const usadas = new Set((caso.capacidades || []).filter((c) => refs.some((r) => capacidadeDoRef(anel, r) === c)));
  if (!usadas.size) return null;
  const melhor = new Map();
  for (const r of refs) {
    const cap = capacidadeDoRef(anel, r);
    if (usadas.has(cap)) continue;
    const nota = pontuarNo(indice, [caso.s], r)?.nota ?? -Infinity;
    if (!(melhor.get(cap) >= nota)) melhor.set(cap, nota);
  }
  const distr = [...melhor.entries()].sort((a, b) => b[1] - a[1]).slice(0, DISTRATORAS).map((x) => x[0]);
  const dom = new Set([...usadas, ...distr]);
  return refs.map((r, i) => (dom.has(capacidadeDoRef(anel, r)) ? i : -1)).filter((i) => i >= 0);
}


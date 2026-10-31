// packages/decisions/src/local/indice-do-refino.js
// Índice do decisor local derivado da semântica que o Kairos entrega no RefineInput (sem catálogo próprio).
// Forma e regras IDÊNTICAS às de `montarIndice` (indice.js) para os mesmos textos e vetores brutos: texto antes dos
// exemplos, `textos` guarda todo texto não vazio (mesmo com vetor inválido; `origens` só os válidos), vetores
// centrados pela média dos brutos do anel, centroide = `centroideDe`. Não muta a entrada (`centrar` devolve array novo).
import { centrar, vetorValido } from './vetores.js';
import { centroideDe } from './indice.js';
import { aplicarRoubadosMantidos } from './cortes.js';

const textoLimpo = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);

function montar(anel, entradas, media, slug, versao) {
  const dim = Array.isArray(media) ? media.length : 0;
  if (!dim) return { ok: false, motivo: 'sem-semantica' };
  const nos = new Map();
  for (const { ref, semantica } of entradas) {
    if (!semantica) continue;
    const textos = []; const vetores = []; const origens = [];
    const t = textoLimpo(semantica.texto?.texto);
    if (t) {
      textos.push({ tipo: 'texto', texto: t });
      if (vetorValido(semantica.texto.vetor, dim)) { vetores.push(centrar(semantica.texto.vetor, media)); origens.push({ tipo: 'texto', i: 0 }); }
    }
    let iEx = 0;
    for (const ex of Array.isArray(semantica.exemplos) ? semantica.exemplos : []) {
      const te = textoLimpo(ex?.texto);
      if (!te) continue;
      textos.push({ tipo: 'exemplo', texto: te });
      if (vetorValido(ex.vetor, dim)) { vetores.push(centrar(ex.vetor, media)); origens.push({ tipo: 'exemplo', i: iEx }); }
      iEx += 1;
    }
    if (vetores.length) nos.set(ref, { textos, vetores, origens, centroide: centroideDe(vetores) });
  }
  return { ok: true, anel, slug, hash: versao, media, dim, nos };
}

/** Índice do anel do refino. `calibracao.roubados` (mantida) é aplicada por ref+texto. */
export function indiceDoRefino(input, calibracao) {
  const itens = Array.isArray(input?.items) ? input.items : [];
  const semSemantica = itens.filter((it) => !it.semantica).map((it) => it.ref);
  const s = input?.semantica;
  const ind = montar(input?.ring, itens.map((it) => ({ ref: it.ref, semantica: it.semantica })), s?.media, s?.slug ?? null, s?.versao ?? null);
  if (!ind.ok) return { ...ind, semSemantica };
  const { indice, removidos } = calibracao?.roubados ? aplicarRoubadosMantidos(ind, calibracao.roubados) : { indice: ind, removidos: 0 };
  return { ok: true, indice, removidos, semSemantica };
}

/** Índice do anel tool montado a partir das funções que o anel provider traz em `item.semantica.funcoes`. */
export function indiceDeFuncoesDoProvider(input, calibracaoTool) {
  const funcoes = (input?.items || []).flatMap((it) => it.semantica?.funcoes || []);
  const s = input?.semantica;
  const ind = montar('tool', funcoes.map((f) => ({ ref: f.ref, semantica: f })), s?.mediaFuncoes, s?.slug ?? null, s?.versao ?? null);
  if (!ind.ok) return ind;
  return calibracaoTool?.roubados ? aplicarRoubadosMantidos(ind, calibracaoTool.roubados).indice : ind;
}

/**
 * Índice do CATÁLOGO INTEIRO de um anel, a partir do snapshot que o Kairos entrega por `manager.semantica()`
 * (`aneis[anel] = { itens: Map<ref, { texto?, exemplos }>, media, versao }`). Mesma conta de `indiceDoRefino` (textos, centralização
 * pela `media`, centroide, calibração mantida por ref+texto); a diferença é só o conjunto de itens: aqui todos, não os do turno.
 * É o que o treino (completo e por lote) e o retrato usam; a inferência continua derivando do `RefineInput`.
 */
export function indiceDoCatalogo(anel, semanticaDoAnel, slug, calibracao) {
  const itens = semanticaDoAnel?.itens;
  const entradas = itens && typeof itens.entries === 'function' ? [...itens.entries()].map(([ref, semantica]) => ({ ref, semantica })) : [];
  const ind = montar(anel, entradas, semanticaDoAnel?.media, slug ?? null, semanticaDoAnel?.versao ?? null);
  if (!ind.ok) return ind;
  const { indice, removidos } = calibracao?.roubados ? aplicarRoubadosMantidos(ind, calibracao.roubados) : { indice: ind, removidos: 0 };
  return { ok: true, indice, removidos };
}

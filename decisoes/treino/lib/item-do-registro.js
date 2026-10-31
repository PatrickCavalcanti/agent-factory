// Caso do registro → item de treino/avaliação do anel. UMA função para os dois caminhos (lote e treino completo): os dois
// divergiram antes (alvo por cruzamento capacidade × nome, negativo sem domínio, piso por turno), por isso a regra mora aqui.
//
// Regras (spec 2026-10-07 §3):
// - rótulo = as refs EXATAS que o caso guardou (provider: capacidades; tool: `cap/tool/fn`), sem cruzar capacidade × nome;
// - piso do PRÓPRIO caso (`caso.piso`: provider = capacidades de piso do turno; tool = só as funções fixas delas) e o piso
//   incondicional do índice (`foraIndice`) saem de rótulos, carregadas e domínio;
// - caso cujos rótulos foram todos descartados (ref que não existe mais no índice) é `incerto`: o rótulo "nada" seria falso;
// - positivo: domínio da produção (`dominioDoCaso`) sem o piso do caso e sem a CARGA JUNTO (função carregada e não usada
//   de capacidade usada, neutra);
// - negativo fraco (carregou e não usou): domínio = o que foi carregado e não usado, ignorando capacidade usada no turno
//   (ex. `load_capability` sem chamada de função); peso `PESO_NEGATIVO_FRACO`; no máximo metade do lote (`limitarFracos`).
import { capacidadeDoRef, dominioDoCaso } from './dominio.js';

/** Peso de um negativo fraco no treino (carregado e não usado). */
export const PESO_NEGATIVO_FRACO = 0.5;

export function aleatorio(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Amostra determinística (Fisher-Yates parcial) de até `n` itens. */
export function amostrar(lista, n, seed) {
  if (lista.length <= n) return lista.slice();
  const r = aleatorio(seed + 7); const a = lista.slice();
  for (let i = 0; i < n; i++) { const j = i + Math.floor(r() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/** Refs que o local não decide NESTE caso: provider = capacidades de piso do turno; tool = só as funções fixas delas. */
export const foraDoCaso = (anel, caso) => new Set(anel === 'provider' ? (caso?.piso?.ids || []) : (caso?.piso?.fixas || []));

/** Formato que `dominioDoCaso` espera (capacidades + nomes de função). */
export const formatoDoDominio = (anel, s, rotulos) => (anel === 'provider'
  ? { s, capacidades: rotulos, funcoes: [] }
  : { s, capacidades: [...new Set(rotulos.map((r) => capacidadeDoRef(anel, r)))], funcoes: rotulos.map((r) => String(r).slice(String(r).indexOf('/tool/') + '/tool/'.length)) });

/**
 * @param {{anel:'provider'|'tool', caso:object, s:number[], refs:string[], indice:object, foraIndice?:Set<string>}} o
 *   `s` = vetor do pedido já centrado; `refs` = refs do anel já sem o piso incondicional; `foraIndice` = esse piso (só para
 *   não contar como ref descartada).
 * @returns {{tipo:'positivo'|'fraco', rotulos:string[], dom:number[], peso:number, descartadas:number, neutras?:string[]}|{tipo:'incerto'|'sem-sinal'|'sem-dominio', descartadas:number}}
 */
export function itemDoRegistro({ anel, caso, s, refs, indice, foraIndice = new Set() }) {
  const noIndice = new Set(refs);
  const fora = foraDoCaso(anel, caso);
  const emFora = (r) => fora.has(r) || foraIndice.has(r);
  const brutos = (anel === 'provider' ? (caso.usadas?.capacidades || []) : (caso.usadas?.funcoes || [])).filter((r) => !emFora(r));
  const rotulos = brutos.filter((r) => noIndice.has(r));
  // Nome cru de função que o catálogo do turno não resolveu (`usadas.naoResolvidas`) é rótulo que existiu e não dá para ler: conta
  // como descartado — o caso vira incerto, nunca um "fraco" que puniria o que o modelo de fato usou.
  const descartadas = brutos.length - rotulos.length + (caso.usadas?.naoResolvidas?.length ?? 0);
  if (!rotulos.length && descartadas > 0) return { tipo: 'incerto', descartadas };
  const capsUsadas = new Set([...(caso.usadas?.capacidades || []), ...rotulos.map((r) => capacidadeDoRef(anel, r))]);
  if (rotulos.length) {
    let dom = dominioDoCaso(anel, formatoDoDominio(anel, s, rotulos), refs, indice);
    if (!dom) return { tipo: 'sem-dominio', descartadas };
    dom = dom.filter((i) => !fora.has(refs[i]));
    // carga junto (anel tool): carregada e não usada, de capacidade usada → neutra, fora do domínio negativo
    let juntas = new Set();
    if (anel === 'tool') {
      juntas = new Set((caso.carregadas?.tool || []).filter((r) => noIndice.has(r) && !emFora(r) && capsUsadas.has(capacidadeDoRef(anel, r)) && !rotulos.includes(r)));
      if (juntas.size) dom = dom.filter((i) => !juntas.has(refs[i]));
    }
    // `neutras` = o que ficou fora do domínio NESTE caso (piso do caso + carga junto). Vai junto com o caso para a reposição da
    // base: quando ele volta num lote seguinte o domínio é refeito sem elas (senão a junta viraria negativo na segunda vez).
    return { tipo: 'positivo', rotulos, dom, peso: 1, descartadas, neutras: [...new Set([...fora, ...juntas])] };
  }
  const carregadas = (caso.carregadas?.[anel] || []).filter((r) => noIndice.has(r) && !emFora(r) && !capsUsadas.has(capacidadeDoRef(anel, r)));
  if (!carregadas.length) return { tipo: 'sem-sinal', descartadas };
  return { tipo: 'fraco', rotulos: [], dom: carregadas.map((r) => refs.indexOf(r)), peso: PESO_NEGATIVO_FRACO, descartadas };
}

/** Domínio de um item vindo da reposição: o da produção sem as neutras gravadas com ele (reposição antiga sem o campo segue igual). */
export function domSemNeutras(dom, refs, neutras) {
  if (!neutras?.length) return dom;
  const fora = new Set(neutras);
  return dom.filter((i) => !fora.has(refs[i]));
}

/** Negativos fracos que entram no lote: no máximo tantos quantos os positivos (⇒ no máximo metade), amostra determinística. */
export function limitarFracos(positivos, fracos, seed = 0) {
  return amostrar(fracos, positivos.length, seed + 3);
}

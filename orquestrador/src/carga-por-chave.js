// Carga de capacidade por CHAVE do trabalho: o host declara um mapa `chave → [ids de capacidade]` e, a cada
// turno, as capacidades das chaves do turno entram carregadas — pelo mesmo caminho do `carregar` das fontes
// (promoção no estado do kairos antes do primeiro `prepareTurn`), sem depender do ranking.
//
// Puro de propósito: valida e calcula; quem promove é `executarTurno` (`index.js`).

/**
 * Confere o mapa na montagem. Devolve mensagens de recusa (vazio = ok). Sem mapa nada é conferido.
 * @param {Record<string, string[]> | undefined} mapa
 * @param {readonly string[] | undefined} catalogo `config.catalogoDeChaves`
 * @param {ReadonlySet<string>} idsDasCapacidades ids de `config.capacidades`
 * @param {boolean} temChaves o host declarou `config.chaves` (a função que diz as chaves do turno)
 * @returns {string[]}
 */
export function validarCargaPorChave(mapa, catalogo, idsDasCapacidades, temChaves) {
  if (!mapa || Object.keys(mapa).length === 0) return [];
  // Sem catálogo, um erro de grafia na chave nunca bateria com chave nenhuma do turno: a carga ficaria
  // desligada sem erro nenhum. O catálogo faz o erro de nome aparecer na montagem.
  const faltas = [];
  if (!catalogo) faltas.push('cargaPorChave exige catalogoDeChaves (sem ele um erro de nome na chave nunca apareceria)');
  // Sem `config.chaves`, o turno recebe o catálogo INTEIRO como chaves (`chavesDoTurno`, `index.js`): toda chave do
  // mapa bateria em todo turno e a carga por chave viraria piso disfarçado — capacidade sempre carregada, sem
  // ranking, pelo caminho que devia ser condicional.
  if (!temChaves) faltas.push('cargaPorChave exige `chaves` (sem a função que diz as chaves do turno, todas as chaves do catálogo valem em todo turno e a carga vira piso disfarçado)');
  if (faltas.length) return faltas;
  const conhecidas = new Set(catalogo);
  const erros = [];
  for (const [chave, lista] of Object.entries(mapa)) {
    if (!conhecidas.has(chave)) erros.push(`cargaPorChave: chave "${chave}" fora de catalogoDeChaves`);
    if (!Array.isArray(lista) || lista.length === 0) {
      erros.push(`cargaPorChave: chave "${chave}" precisa de uma lista de ids de capacidade (não vazia)`);
      continue;
    }
    for (const id of lista) {
      if (!idsDasCapacidades.has(id)) erros.push(`cargaPorChave: chave "${chave}" aponta capacidade desconhecida "${id}"`);
    }
  }
  return erros;
}

/**
 * As capacidades que as chaves do turno carregam: união sem repetição, na ordem do mapa, e o que cada chave
 * carregou (para o rastro "carregou pela chave X"). Chave do turno que não está no mapa não carrega nada.
 * @param {Record<string, string[]> | undefined} mapa
 * @param {readonly string[]} chavesDoTurno
 * @returns {{ ids: string[], porChave: Record<string, string[]> }}
 */
export function capacidadesDaCarga(mapa, chavesDoTurno) {
  const doTurno = new Set(chavesDoTurno);
  const ids = [];
  const porChave = {};
  for (const [chave, lista] of Object.entries(mapa ?? {})) {
    if (!doTurno.has(chave)) continue;
    porChave[chave] = [...lista];
    for (const id of lista) if (!ids.includes(id)) ids.push(id);
  }
  return { ids, porChave };
}

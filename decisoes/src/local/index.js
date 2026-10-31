// API pública do decisor local de seleção (spec 2026-10-06).
export { produto, normalizar, media, centrar, percentil, vetorValido } from './vetores.js';
export { nosDoAnel, hashDosNos, montarIndice, exportarRetrato } from './indice.js';
export { indiceDoRefino, indiceDeFuncoesDoProvider, indiceDoCatalogo } from './indice-do-refino.js';
export { consultaCentrada, pontuarNo } from './pontuador.js';
export { capacidadeDoRef } from './refs.js';
export { PARAMETROS_CORTES, calibrarCortes, semRoubados, aplicarRoubadosMantidos } from './cortes.js';
export { REGRA_DO_INDICE } from './regra.js';
export { CORTES_FIXOS, FUNCAO_TRAZ_PADRAO, normalizarCortesFixos, normalizarFuncaoTraz } from './cortes-fixos.js';
export { novaCabeca, pontuarCabeca, treinarCabeca, serializarCabeca, carregarCabeca, cabecaFinita } from './cabeca.js';
export { TETOS_FULL, criarRefinadorLocal, estadoDoAnel } from './refinador-local.js';
export { refinadorPorModo, MODOS } from './modos.js';

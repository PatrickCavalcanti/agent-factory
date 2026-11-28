// Índice de capacidades (spec do Igris 2026-10-19): uma linha por capacidade FORA do piso, com o nome exato
// de cada função. O modelo fica sabendo o que existe mesmo quando o ranking semântico deixa a capacidade fora
// do turno, e carrega o manual pelo nome da função. É a rede de segurança da descoberta: o ranking pode errar,
// o índice não depende dele.
//
// Era do Igris e ficou fora da extração por depender de coisas dele (ORIGEM D8). Nasceu aqui sem esses laços:
// a prioridade, o formato do cartão e o cabeçalho chegam por parâmetro.
//
// Estabilidade: o texto é calculado UMA vez, na montagem do catálogo, e vai num bloco `system:stable` — dentro
// do prefixo do cache. Capacidade que vira piso no meio da sessão continua listada até a próxima montagem
// (duplicação aceita, nunca perda).
import { nomeExposto } from './capacidades.js';

// Os textos abaixo são bloco estável do system: NÃO mudar um byte (quebra o cache de quem já usa).
// Os outros formatos só ajustam a frase dos cards, que depende do que o cartão sugerido entrega.
const CABECALHO_COMPLETO = [
  'Índice de todas as capacidades disponíveis que não estão sempre carregadas — uma linha por',
  'capacidade, com o nome exato de cada função. As carregadas aparecem completas em <capabilities>;',
  'as mais prováveis para o pedido chegam como cards no turno. Se o pedido precisa de uma capacidade',
  'deste índice que não está carregada, carregue o manual da função com `load_capability` (nome',
  'exato, como aqui) antes de chamá-la. Prefira a capacidade feita para o pedido a uma função',
  'parecida de outra capacidade.',
].join('\n');

const CABECALHO_FUNCOES_SUGERIDAS = CABECALHO_COMPLETO.replace(
  'chegam como cards no turno. Se',
  'chegam como cards no turno, com as funções sugeridas. Se',
);

const CABECALHO_SEM_CARDS = [
  'Índice de todas as capacidades disponíveis que não estão sempre carregadas — uma linha por',
  'capacidade, com o nome exato de cada função. As carregadas aparecem completas em <capabilities>.',
  'Se o pedido precisa de uma capacidade deste índice que não está carregada, carregue o manual da',
  'função com `load_capability` (nome exato, como aqui) antes de chamá-la. Prefira a capacidade feita',
  'para o pedido a uma função parecida de outra capacidade.',
].join('\n');

/** @param {'completo'|'funcoesSugeridas'|'nenhum'} [formato] */
export function cabecalhoDoIndice(formato = 'completo') {
  if (formato === 'funcoesSugeridas') return CABECALHO_FUNCOES_SUGERIDAS;
  if (formato === 'nenhum') return CABECALHO_SEM_CARDS;
  return CABECALHO_COMPLETO;
}

const porId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * "Capacidade fora do piso com função": a que o índice lista (`piso: false` e ao menos uma tool). É o critério único
 * do que o índice mostra e do que a recusa R9 conta — se os dois divergissem, a recusa deixaria passar (ou barraria)
 * um índice vazio.
 * @param {{ piso?: boolean, tools?: unknown[] } | null | undefined} c
 */
export function foraDoPisoComFuncao(c) {
  return Boolean(c) && c.piso === false && Array.isArray(c.tools) && c.tools.length > 0;
}

/**
 * @param {Array<object>} [capacidades] `CapacidadeDeclarada[]`
 * @param {{ formato?: 'completo'|'funcoesSugeridas'|'nenhum', cabecalho?: string }} [opcoes]
 *   `cabecalho` substitui o texto padrão do formato (o host que escreve o próprio).
 * @returns {string} '' quando nenhuma capacidade está fora do piso
 */
export function renderizarIndiceDeCapacidades(capacidades = [], { formato = 'completo', cabecalho } = {}) {
  const fora = capacidades.filter(foraDoPisoComFuncao);
  if (!fora.length) return '';
  const linhas = [...fora].sort(porId).map((c) => {
    const nomes = c.tools.map((t) => nomeExposto(c.id, t.name, { prefixar: c.prefixarTools !== false }));
    // Só a primeira frase: o índice diz o que a capacidade é; o detalhe vem no manual, quando carregada.
    const descricao = String(c.descricao ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
    const primeira = descricao.split(/(?<=\.)\s+/)[0].replace(/[.\s]+$/, '');
    return `- ${c.id}${primeira ? ` — ${primeira}` : ''}. Funções: ${nomes.join(', ')}`;
  });
  return ['<capability_index>', cabecalho ?? cabecalhoDoIndice(formato), '', ...linhas, '</capability_index>'].join('\n');
}

/**
 * Contribuição de piso `system:stable` com o índice; o texto é calculado uma vez, na criação.
 * @param {Array<object>} capacidades
 * @param {{ formato?: 'completo'|'funcoesSugeridas'|'nenhum', prioridade?: number, cabecalho?: string }} [opcoes]
 */
export function contribuicaoDoIndiceDeCapacidades(capacidades, { formato, prioridade = 49.5, cabecalho } = {}) {
  const texto = renderizarIndiceDeCapacidades(capacidades, { formato, cabecalho });
  return {
    ref: 'orquestrador/stable/capability-index',
    kind: 'knowledge',
    description: 'capability-index',
    floor: true,
    volatil: false,
    destination: 'system:stable',
    priority: prioridade,
    read: async () => texto,
  };
}

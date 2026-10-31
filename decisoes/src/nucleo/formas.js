// packages/decisions/src/nucleo/formas.js
//
// Montadores das três formas de pergunta do Jev (N2, adendo §15 da spec). Cada aplicação
// (hoje a hidratação em ../index.js e ../perguntas.js; amanhã qualquer outra decisão
// orientada por LLM) só decide o CONTEÚDO — texto e critérios; os limites do protocolo são
// validados aqui, na MONTAGEM, não na resposta: um choice com opções demais ou um score com
// níveis fora do intervalo é bug de quem chamou (catálogo malformado, enum construído à
// mão), não uma degradação de rede — lança na hora, em vez de silenciosamente montar uma
// pergunta que a API rejeitaria.
export class ErroDeForma extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroDeForma';
  }
}

const TETO_OPCOES_CHOICE = 255;
const NIVEIS_MIN = 2;
const NIVEIS_MAX = 10;

// Correção 2 (review Fase 4, Task 13b) — Fase 0 (2026-09-18): movido de decidir()/
// montarPerguntas (index.js) para o núcleo, mesmo valor e mesmo papel. Todo eixo de TAMANHO
// já tem teto (regras 500 chars, bloco de estado 4000, estado global 24000 com corte,
// candidatos 60 itens/lista, next_tool até 254 opções) — mas a CONTAGEM de perguntas por
// chamada não tinha nenhum. `questions` inteiro vai no corpo HTTP sem guard: se estourar o
// limite da API, um 400 faz a chamada degradar e todas as contribuições de todos os
// chamadores do turno somem juntas, sem culpado. Teto total de 60 perguntas por chamada;
// cada aplicação decide sua própria ordem de corte por classe quando estoura (ver
// montarPerguntas em ../index.js para o caso da hidratação).
export const TETO_PERGUNTAS = 60;

function precisaTexto(v, nome, forma) {
  if (!v || typeof v !== 'string') throw new ErroDeForma(`${forma}: ${nome} precisa ser uma string não vazia`);
}

/**
 * Pergunta de escolha única entre um conjunto de opções nomeadas.
 * @param {string} instructions
 * @param {Record<string,string>} criteria opção → descrição; 1 a 255 opções
 */
export function choice(instructions, criteria) {
  precisaTexto(instructions, 'instructions', 'choice');
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new ErroDeForma('choice: criteria precisa ser um objeto {opcao: descricao}');
  const n = Object.keys(criteria).length;
  if (n < 1) throw new ErroDeForma('choice: criteria precisa de ao menos 1 opção');
  if (n > TETO_OPCOES_CHOICE) throw new ErroDeForma(`choice: ${n} opções acima do teto de ${TETO_OPCOES_CHOICE}`);
  return { type: 'choice', instructions, criteria };
}

/**
 * Pergunta booleana com grau de confiança (0–1). `criteria`, quando presente, descreve os
 * dois lados (ex.: `{ true: '...', false: '...' }`) — várias perguntas noul do protocolo
 * não têm criteria nenhum (o próprio instructions já é a pergunta sim/não).
 * @param {string} instructions
 * @param {Record<string,string>} [criteria]
 */
export function noul(instructions, criteria) {
  precisaTexto(instructions, 'instructions', 'noul');
  if (criteria === undefined) return { type: 'noul', instructions };
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) throw new ErroDeForma('noul: criteria, quando presente, precisa ser um objeto');
  return { type: 'noul', instructions, criteria };
}

/**
 * Pergunta de nível entre 2 e 10 graus ORDENADOS (do mais baixo ao mais alto). Diferente de
 * `choice`/`noul`, a ORDEM de `niveis` é o próprio conteúdo da pergunta — por isso `criteria`
 * é um **array**, não um objeto (spec §2): um objeto não garante que a ordem de inserção
 * sobreviva a toda volta de serialização, e a resposta só faz sentido lida na mesma ordem em
 * que os níveis foram declarados.
 *
 * Formato da resposta (confirmado por chamada real ao Jev, bancada `eval/hidratacao-bracos.mjs`
 * com `criteria: ['não precisa','talvez','provavelmente','certamente']`):
 * `{ score: number, legend: { "0": niveis[0], "1": niveis[1], … } }` — `score` é um valor
 * CONTÍNUO (não só os inteiros 0..n-1), e `legend` é **0-indexado** na mesma ordem de `niveis`
 * (índice 0 = o primeiro nível do array, o mais baixo). Ex.: `score >= 2` acima lê como
 * "provavelmente" ou mais.
 * @param {string} instructions
 * @param {string[]} niveis 2 a 10 rótulos não vazios, em ordem (do mais baixo ao mais alto)
 */
export function score(instructions, niveis) {
  precisaTexto(instructions, 'instructions', 'score');
  if (!Array.isArray(niveis)) throw new ErroDeForma('score: niveis precisa ser um array ordenado de rótulos (nível mais baixo primeiro)');
  const n = niveis.length;
  if (n < NIVEIS_MIN || n > NIVEIS_MAX) throw new ErroDeForma(`score: ${n} níveis fora do intervalo ${NIVEIS_MIN}-${NIVEIS_MAX}`);
  if (!niveis.every((v) => typeof v === 'string' && v.trim())) throw new ErroDeForma('score: cada nível precisa ser uma string não vazia');
  return { type: 'score', instructions, criteria: niveis };
}

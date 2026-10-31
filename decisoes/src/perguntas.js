// packages/decisions/src/perguntas.js
/**
 * `assistente` = como o texto chama o assistente roteado (o Igris passa `'assistente pessoal Igris'`; o padrão é neutro).
 * Só o nome entra: o resto do texto é fixo (o modelo decisor lê isto, então mudar o texto muda o comportamento).
 */
export const instrucoesNextTool = (assistente = 'assistente pessoal') =>
  `Você roteia o ${assistente}. Dado o pedido do usuário, o contexto dos powers e da sessão (o mesmo que o assistente vê), a conversa anterior, as ações já executadas (com resultados) e o que o assistente já disse, qual tool deve ser chamada EM SEGUIDA? Exatamente uma. Consulte antes de agir, honre condições, nunca repita ação já bem-sucedida com os mesmos argumentos. Se o assistente já tem no contexto o que precisa para responder, ou nada do catálogo se aplica, escolha respond_to_user. Ignore a escrita de memória de trabalho (mt_*): não é uma ação pedida pelo usuário.`;
export const INSTRUCOES_NEXT_TOOL = instrucoesNextTool();
export const INSTRUCOES_PRONTO =
  'O assistente já tem, no contexto atual (blocos dos powers, resultados das ações executadas, conversa), tudo o que precisa para responder ao usuário agora, sem chamar mais nenhuma tool.';
export const CRITERIA_PRONTO = { true: 'nada falta buscar: responde com o que já está no contexto', false: 'ainda falta executar ou consultar algo para atender o pedido' };
export const instrucoesPrefetch = (tool) =>
  `Para atender este pedido do usuário (dado o contexto dos powers, da sessão e a conversa anterior), o assistente vai precisar chamar a tool ${tool.name} — "${(tool.desc || '').split(/(?<=[.!?])\s+/)[0]}" (power ${tool.power})? Verdadeiro só se essa leitura for necessária ou claramente útil para responder; falso se o pedido não tem relação com ela ou o dado já está no contexto.`;
export const CRITERIA_PREFETCH = { true: 'a leitura é necessária ou claramente útil para este pedido', false: 'não tem relação com o pedido, ou o dado já está disponível no contexto' };
export const instrucoesArgumento = (tool, param) =>
  `Supondo que a próxima tool seja ${tool}: qual o valor correto do parâmetro "${param}" para atender o pedido, dado o contexto e as ações anteriores? Escolha o candidato exato, ou nenhum_dos_candidatos.`;

// H1/H2 (adendo §15 da spec): hidratação por power — texto B1 da bancada
// `eval/resultados/2026-09-18-hidratacao-bracos-3.json` (`textos.b1`), venceu `choice` e o
// texto "refinado" nos dois eixos de erro (39 esquecidos/1000, 85 desnecessários/1000). `id` e
// `desc` são as ÚNICAS interpolações (A1) — `desc` vem do manifesto do próprio power (primeira
// frase da `description`), nunca um texto fixo daqui.
export const instrucoesHidratarPower = (id, desc) =>
  `Para atender este pedido, o assistente vai precisar usar alguma tool do power ${id} — "${desc}"? Verdadeiro só se o pedido exigir; falso se não tiver relação.`;
export const CRITERIA_HIDRATAR_POWER = { true: 'o pedido exige usar alguma tool deste power', false: 'o pedido não tem relação com este power, ou já está resolvido sem ele' };

export const NENHUM = 'nenhum_dos_candidatos';
export const DESC_NENHUM = 'Nenhum dos candidatos listados é o valor certo para este parâmetro neste pedido.';

// Correção (review do conjunto): mesmo predicado usado por montarPerguntas (index.js, monta o
// criteria de arg_<tool>_<param>) e aplicarGates (gates.js, casa a resposta com o candidato) —
// um candidato cujo String(v) colide com o sentinela NENHUM sobrescreveria a entrada
// `nenhum_dos_candidatos` no criteria (perdendo DESC_NENHUM) e, mesmo se sobrevivesse, nunca
// poderia virar dica (o gate trata `choice === NENHUM` como "nenhuma dica", antes de olhar os
// candidatos) — descartado dos dois lados, mesmo padrão do enum de prefetch (SEM_ARGUMENTO).
export function candidatoUtilizavel(v) {
  return String(v) !== NENHUM;
}

// Adendo §14 (2026-09-18): argumento de domínio fechado do prefetch. `tool` e `param` aqui
// são sempre nomes (string), nunca o objeto do catálogo — o texto não pode citar mais do
// que o schema já expõe (A1): nenhuma palavra fixa deste arquivo pode nomear um power, uma
// tool ou um valor de enum.
export const SEM_ARGUMENTO = 'sem_argumento';
export const DESC_SEM_ARGUMENTO = 'O pedido não pede este recorte: usar o padrão da tool, sem este parâmetro.';
// Correção (lote 2, 30/09, bancada: "Lista os documentos da pasta de atas." executou `arquivo_listar {}`
// e entregou o acervo inteiro): o Jev só ESCOLHE entre opções, então quando o usuário NOMEIA um valor que
// não está na lista (não existe pasta "atas" entre as pastas reais) a única saída honesta era
// `sem_argumento` — a leitura rodava mais larga que o pedido. Esta segunda sentinela dá ao Jev a forma de
// dizer "o pedido cita um valor, e ele não está aqui": o loop então devolve a função ao modelo
// (`paraOModelo`), que tem o pedido em texto livre. Só existe nas perguntas `arg_*` do LOOP
// (`perguntasDoPasso`, loop/passo.js), obrigatórias ou não; as perguntas `pfarg_*` do prefetch
// (montarPerguntas, index.js) NÃO a recebem, por ora: o prefetch só roda na V1 (`IGRIS_DECISOES=1`) e
// `sem_argumento` segue como lá. Enum fechado NÃO impede o pedido de nomear valor fora dele (a medição
// de 30/09 disparou a sentinela em "depois de amanhã"/"urgente") — o análogo certo no prefetch seria
// DESCARTAR a leitura antecipada (`prefetchDescartados`, gates.js), pendência registrada.
export const FORA_DA_LISTA = 'valor_fora_da_lista';
export const DESC_FORA_DA_LISTA = 'O pedido cita um valor para este parâmetro que não está entre as opções.';
export const instrucoesArgumentoPrefetch = (tool, param) =>
  `Se a tool "${tool}" for executada antes da resposta para atender este pedido, qual valor do parâmetro "${param}" atende o pedido? Escolha a opção exata, ou "sem_argumento" se o pedido não pede este recorte.`;

// Correção 1 (review Fase 1): predicado único de "enum utilizável" para pfarg_*, usado tanto
// por montarPerguntas (index.js, gera a pergunta) quanto por aplicarGates (gates.js, valida a
// resposta) — antes cada lado tinha sua própria checagem (index.js exigia 1..254, gates.js só
// >=1), então um enum com 300 valores gerava pergunta em nenhum dos dois lados mas o gate
// mesmo assim EXIGIA resposta de uma pergunta que nunca existiu, descartando o item de
// prefetch pra sempre (motivo 'argumento-sem-resposta' eterno). Regra: array, valores
// normalizados com String(v) e deduplicados, 1 a 254 valores depois de normalizar, e sem o
// sentinela SEM_ARGUMENTO (colidiria com a chave da opção "sem argumento" no criteria).
// Devolve null quando o enum não é utilizável — o param então é tratado como se não tivesse
// enum nos dois lados: nenhuma pergunta pfarg_* é gerada, e o gate não exige resposta pra ele
// (o item de prefetch não é descartado por causa dele). Quando utilizável, devolve a lista
// normalizada com o índice original (pra casar com enumDescriptions, que não é reindexado) e
// o valor original (pra devolver em args[param] o tipo de dado do schema, não a string da UI).
export function enumUtilizavelDePrefetch(enumValores) {
  if (!Array.isArray(enumValores)) return null;
  const vistos = new Set();
  const normalizados = [];
  enumValores.forEach((v, indiceOriginal) => {
    const str = String(v);
    if (vistos.has(str)) return;
    vistos.add(str);
    normalizados.push({ original: v, str, indiceOriginal });
  });
  if (normalizados.length < 1 || normalizados.length > 254) return null;
  if (vistos.has(SEM_ARGUMENTO)) return null;
  // Correção 3 (review do conjunto): um valor cujo String(v).trim() é vazio (ex.: '', '   ')
  // viraria uma opção de criteria sem texto visível para o modelo escolher — mesma classe de
  // "enum não utilizável" que SEM_ARGUMENTO/>254 valores, então invalida o enum inteiro (não só
  // o valor vazio), nos dois lados (montarPerguntas não gera pergunta; aplicarGates não exige
  // resposta).
  if (normalizados.some((n) => n.str.trim() === '')) return null;
  return normalizados;
}

// Correção (ajuste pontual pós-review do conjunto): fonte única de verdade para "quem é dono
// de cada chave pfarg_<tool>_<param>" — antes montarPerguntas (index.js) calculava a colisão
// sozinha (`if (chave in q)`) e aplicarGates reconstruía a chave sem saber que ela tinha
// colidido, então a tool pulada lia `answers[chave]` sob a semântica da tool vencedora e caía
// em 'argumento-invalido'/'argumento-sem-resposta' por acidente de enum, não por ter sido
// pulada de fato (ver os testes "colisão de chave pfarg_*" em test/gates.test.js, escritos
// antes deste fix). Mesma ordem/predicado do loop original de montarPerguntas (primeira
// tool/param do catálogo, na ordem em que aparecem, com prefetch===true e enum utilizável)
// decide quem é o dono; toda combinação (tool, param) que perderia a chave para um dono
// anterior entra em `pulados`. Usada nos dois lados: montarPerguntas só gera pergunta para o
// dono; aplicarGates descarta o item da tool pulada sem ler `answers[chave]` (a resposta,
// quando existe, pertence à semântica do dono — lê-la para a tool pulada é dado da tool errada).
export function mapearChavesPfarg(catalogo) {
  const donos = new Map(); // chave -> { tool, param }
  const pulados = []; // { tool, param, chave }
  for (const t of catalogo || []) {
    if (t.prefetch !== true) continue;
    for (const p of t.params || []) {
      if (!enumUtilizavelDePrefetch(p?.enum)) continue;
      const chave = `pfarg_${t.name}_${p.name}`;
      if (donos.has(chave)) { pulados.push({ tool: t.name, param: p.name, chave }); continue; }
      donos.set(chave, { tool: t.name, param: p.name });
    }
  }
  return { donos, pulados };
}

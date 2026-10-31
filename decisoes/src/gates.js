// packages/decisions/src/gates.js
import { RESPOND } from './catalogo.js';
import { NENHUM, SEM_ARGUMENTO, enumUtilizavelDePrefetch, candidatoUtilizavel, mapearChavesPfarg } from './perguntas.js';

// hidratarItem: piso POR ITEM do top-k de next_tool (agora `sugestao`, não mais `hidratar` —
// ver H1/H5, adendo §15). Sem ele, quando a tool top é de power já carregado a costura (E5)
// descia para o próximo colocado mesmo a 0,01 e carregava um power sem relação com o pedido
// (633e40d8: async-shadows; 0ce718d7: navegador).
// hidratarPower (H2, adendo §15): corte do `noul` por power CANDIDATO — 0,7 é o ponto que
// dominou `choice` nos dois eixos de erro na bancada (`eval/README.md`, `textos.b1`).
export const CORTES_PADRAO = { semHidratacao: 0.3, topK: 0.5, k: 3, hidratarItem: 0.2, hidratarPower: 0.7, prefetch: 0.7, dica: 0.7, prefetchArg: 0.7 };

/**
 * @param {Record<string, any>} answers  resposta do Jev (chaves: next_tool, pronto, hidratar_<power>, prefetch_<tool>, pfarg_<tool>_<param>, arg_<tool>_<param>, power_<power>_<pergunta>)
 * @param {{ catalogo: Array<{name:string, power:string, prefetch?:boolean, params?: Array<{name:string, enum?:string[]}>}>, candidatos?: Record<string, Record<string, Array<[string,string]>>>, perguntasDosPowers?: Record<string, Record<string, object>>, cortes?: Partial<typeof CORTES_PADRAO>, powersCandidatos?: Array<{id:string, desc?:string}>, powersAtivos?: string[] }} opts
 */
export function aplicarGates(answers, { catalogo, candidatos = {}, perguntasDosPowers = {}, cortes = {}, powersCandidatos = [], powersAtivos = [] }) {
  const c = { ...CORTES_PADRAO, ...cortes };
  const porNome = new Map(catalogo.map((t) => [t.name, t]));
  const nt = answers.next_tool || {};
  const conf = Number(nt.confidence ?? 0);
  const ranked = Object.entries(nt.probabilities || {}).filter(([k, p]) => k !== RESPOND && p > 0 && porNome.has(k)).sort((a, b) => b[1] - a[1]);
  // `sugestao` (H5, era `hidratar` antes da Fase 1): dica da PRIMEIRA tool provável — só o
  // que o "Sugestão do roteador" (blocoDecisoes, executor) consome; `next_tool` continua ruim
  // para "quais" (soma 1 entre as opções), por isso não é mais a fonte de QUEM hidratar.
  let sugestao = [];
  if (nt.choice !== RESPOND && conf >= c.semHidratacao) {
    const quantos = conf >= c.topK ? c.k : 1;
    sugestao = ranked.slice(0, quantos).filter(([, p]) => p >= c.hidratarItem).map(([tool, p]) => ({ tool, power: porNome.get(tool).power, confidence: p }));
  }
  const sugeridos = new Set(sugestao.map((h) => h.tool));
  const indice = catalogo.filter((t) => !sugeridos.has(t.name)).map((t) => ({ tool: t.name, power: t.power }));
  // `hidratar` (H1/H2/H4, adendo §15): um `noul` POR POWER candidato (não `choice` — pedido
  // pode precisar de tools de mais de um power ao mesmo tempo, e `choice` soma 1 entre as
  // opções). `powersCandidatos` já deveria vir sem power ativo (o chamador monta a lista só
  // com candidatos do roteamento que ainda não estão carregados); o filtro por `powersAtivos`
  // aqui é defensivo (H4: "não há decisão a tomar" — se por acaso um candidato ativo vier
  // mesmo assim, ele é descartado, não hidratado de novo).
  const ativos = new Set(powersAtivos);
  const hidratar = [];
  for (const { id } of powersCandidatos) {
    if (!id || ativos.has(id)) continue;
    const a = answers[`hidratar_${id}`];
    if (!a) continue;
    const noulValor = Number(a.noul ?? 0);
    if (noulValor >= c.hidratarPower) hidratar.push({ power: id, noul: noulValor });
  }
  hidratar.sort((a, b) => b.noul - a.noul);
  const prefetchCandidatos = [];
  for (const [k, a] of Object.entries(answers)) {
    if (!k.startsWith('prefetch_')) continue;
    const t = porNome.get(k.slice('prefetch_'.length));
    // E10: só entra o que foi de fato perguntado. montarPerguntas (index.js) só gera
    // prefetch_<tool> para tool com prefetch===true no catálogo — uma chave prefetch_<tool>
    // cuja tool exista no catálogo mas NÃO tenha a flag (desvio de formato do modelo,
    // alucinação, conteúdo malicioso) não pode ser aceita só por existir no catálogo.
    if (t && t.prefetch === true && a?.noul >= c.prefetch) prefetchCandidatos.push({ tool: t.name, power: t.power, noul: a.noul });
    // Correção (review do conjunto): `t.prefetch === true` acima já usa comparação estrita —
    // ver o par simétrico em montarPerguntas (index.js), que antes usava truthy (`if
    // (t.prefetch)`). Um valor truthy não-boolean (ex. string 'true' de um manifesto malformado)
    // gerava a pergunta prefetch_<tool> mas o gate, com a comparação estrita já existente aqui,
    // sempre a rejeitava — mudo os dois lados para o mesmo `=== true`.
  }
  // A3 (adendo §14): argumento incerto ⇒ não pré-executa. Para cada candidato que passou o
  // gate de noul, cada parâmetro com enum UTILIZÁVEL (mesmo predicado de montarPerguntas —
  // enumUtilizavelDePrefetch, correção 1 do review Fase 1) DA TOOL NO CATÁLOGO vira uma
  // leitura de answers['pfarg_<tool>_<param>'] (reconstrução, sem regex, mesma lógica de
  // respostasDosPowers abaixo): resposta ausente, confiança abaixo do corte, ou valor fora
  // do enum descartam o item inteiro — dado da janela errada é pior que não pré-executar
  // (e0833cf2). `sem_argumento` só omite o parâmetro (a tool usa seu próprio padrão). Param
  // com enum não utilizável nunca teve pergunta gerada (mesmo predicado dos dois lados), então
  // aqui é tratado como se não tivesse enum: não entra em paramsComEnum, não é lido, não pode
  // descartar o item.
  //
  // Correção (ajuste pontual pós-review do conjunto): `pfarg_${tool}_${param}` pode colidir
  // entre duas combinações tool/param diferentes (ex. tool "a_b"+param "c" e tool "a"+param
  // "b_c" — mesma string "pfarg_a_b_c"); montarPerguntas (index.js) só gera a pergunta para a
  // primeira (o "dono" da chave, decidido por `mapearChavesPfarg`, perguntas.js — mesma ordem e
  // mesmo predicado). Antes deste fix, a tool pulada lia `answers[chave]` mesmo assim — a
  // resposta pertence à semântica do dono, então a tool pulada validava um valor de um domínio
  // que não é o dela, e caía em 'argumento-invalido' (ou 'argumento-sem-resposta' quando a
  // chave não tinha resposta nenhuma) por acidente, não porque foi de fato pulada. Agora, para
  // um (tool, param) que perdeu a chave, descarta direto com 'argumento-colisao', sem ler
  // `answers[chave]` — a tool dona da chave segue lida e validada normalmente.
  const { donos } = mapearChavesPfarg(catalogo);
  const prefetch = [];
  const prefetchDescartados = [];
  for (const item of prefetchCandidatos) {
    const t = porNome.get(item.tool);
    const paramsComEnum = (Array.isArray(t?.params) ? t.params : [])
      .map((p) => ({ p, normalizados: enumUtilizavelDePrefetch(p?.enum) }))
      .filter(({ normalizados }) => normalizados);
    const args = {};
    const argsOmitidos = [];
    let confMin = null;
    let descarte = null;
    for (const { p, normalizados } of paramsComEnum) {
      const chave = `pfarg_${item.tool}_${p.name}`;
      const dono = donos.get(chave);
      // Candidato dinâmico (candidatos.js) é opção de BAIXA confiança: qualquer problema com
      // ele só omite o parâmetro — a consulta roda sem o recorte, como antes das estratégias.
      // Nunca descarta o item: não pode tirar um prefetch que o enum do schema já garantia.
      const omitirOuDescartar = (motivo) => { if (p.candidatoDinamico) { argsOmitidos.push({ param: p.name, motivo }); return false; } descarte = { motivo, param: p.name }; return true; };
      if (dono.tool !== item.tool || dono.param !== p.name) { if (omitirOuDescartar('argumento-colisao')) break; continue; }
      const a = answers[chave];
      if (a === undefined) { if (omitirOuDescartar('argumento-sem-resposta')) break; continue; }
      const conf = Number(a.confidence ?? 0);
      if (conf < c.prefetchArg) { if (omitirOuDescartar('argumento-incerto')) break; continue; }
      if (a.choice === SEM_ARGUMENTO) continue;
      // comparação contra os valores NORMALIZADOS (string) — `p.enum.includes(a.choice)`
      // direto falhava pra enum numérico: a resposta do modelo (`choice`) é sempre string
      // (chave do criteria), mas p.enum pode ter number (ex. [1, 2, 3]), e 2 !== "2".
      const encontrado = normalizados.find((n) => n.str === a.choice);
      if (!encontrado) { if (omitirOuDescartar('argumento-invalido')) break; continue; }
      // args[param] carrega o valor ORIGINAL do enum (ex. number 2), não a string escolhida —
      // quem consome `prefetch[].args` espera o tipo de dado do schema da tool, não da UI.
      args[p.name] = encontrado.original;
      confMin = confMin === null ? conf : Math.min(confMin, conf);
    }
    if (descarte) { prefetchDescartados.push({ tool: item.tool, motivo: descarte.motivo, param: descarte.param }); continue; }
    const aceito = { ...item, args };
    if (confMin !== null) aceito.argsConfidence = confMin;
    if (argsOmitidos.length) aceito.argsOmitidos = argsOmitidos;
    prefetch.push(aceito);
  }
  const dicas = {};
  for (const [tool, params] of Object.entries(candidatos)) for (const [param, cands] of Object.entries(params)) {
    const a = answers[`arg_${tool}_${param}`];
    if (!a || a.choice === NENHUM || Number(a.confidence ?? 0) < c.dica) continue;
    // Correção (review do conjunto), irmã do fix de enum numérico em pfarg_* (correção 1,
    // enumUtilizavelDePrefetch): `v === a.choice` direto nunca casava com candidato numérico —
    // a resposta do modelo (`a.choice`) é sempre string (chave do criteria, montada como
    // `String(v)` em montarPerguntas), mas `v` aqui pode ser number (id de registro, por
    // exemplo). Compara contra o valor NORMALIZADO (String(v)) e devolve o valor ORIGINAL
    // (par[0], já não convertido). candidatoUtilizavel descarta candidato cujo String(v) colide
    // com o sentinela NENHUM — mesmo predicado usado por montarPerguntas ao montar o criteria.
    const par = cands.find(([v]) => candidatoUtilizavel(v) && String(v) === a.choice);
    if (!par) continue;
    (dicas[tool] ??= {})[param] = { valor: par[0], rotulo: par[1], confidence: a.confidence };
  }
  // reconstrói a chave a partir do que foi perguntado (perguntasDosPowers), em vez de
  // fazer split posicional em "power_<power>_<nome>": power com underscore (gestao_documentos)
  // quebra um regex /^power_([^_]+)_(.+)$/ porque ele para no primeiro "_".
  const respostasDosPowers = {};
  for (const [power, perguntas] of Object.entries(perguntasDosPowers)) {
    for (const nome of Object.keys(perguntas || {})) {
      const a = answers[`power_${power}_${nome}`];
      if (a !== undefined) (respostasDosPowers[power] ??= {})[nome] = a;
    }
  }
  return { escolha: nt.choice ?? null, confidence: conf, hidratar, sugestao, indice, prefetch, prefetchDescartados, pronto: Number(answers.pronto?.noul ?? 0), dicas, respostasDosPowers };
}

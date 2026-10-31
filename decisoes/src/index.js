// packages/decisions/src/index.js
import { montarCriteria, RESPOND } from './catalogo.js';
import { montarEstado } from './estado.js';
import { aplicarGates, CORTES_PADRAO } from './gates.js';
import { INSTRUCOES_NEXT_TOOL, INSTRUCOES_PRONTO, CRITERIA_PRONTO, instrucoesPrefetch, CRITERIA_PREFETCH, instrucoesArgumento, NENHUM, DESC_NENHUM, instrucoesArgumentoPrefetch, SEM_ARGUMENTO, DESC_SEM_ARGUMENTO, enumUtilizavelDePrefetch, candidatoUtilizavel, mapearChavesPfarg, instrucoesHidratarPower, CRITERIA_HIDRATAR_POWER } from './perguntas.js';
export { RESPOND, montarCriteria, montarEstado, aplicarGates, CORTES_PADRAO };
export { criarCliente } from './cliente.js';
export { criarClienteDoGateway } from './cliente-gateway.js';
import { aplicarEstrategiasDeCandidatos } from './candidatos.js';
export { aplicarEstrategiasDeCandidatos, entreAspas, ESTRATEGIAS_PADRAO } from './candidatos.js';
export { criarFetchKeepAlive, aquecer } from './transporte.js';
// Fase 0 (Task 0.1, N1/N5): prazo macio, resposta tardia e o teto de 60 perguntas por
// chamada moraram aqui e agora vivem no núcleo genérico (nucleo/perguntar.js,
// nucleo/formas.js) — decidir() só orquestra: monta estado/perguntas específicos da
// hidratação, chama perguntar() e aplica os gates na resposta. Mesmo contrato, reexportado.
// TETO_PERGUNTAS (valor e motivo completos em nucleo/formas.js — Fase 0, Task 0.1: é o
// mesmo teto de sempre, só que a definição agora mora no núcleo genérico). Aqui, na
// hidratação, a ordem de corte por classe quando estoura é de trás para frente (do
// descartável ao núcleo): power_* (perguntas próprias dos powers, extras) → arg_* (dicas de
// argumento, reforço) → nunca prefetch_*/pfarg_* (ganho medido da Fase 3 / adendo §14) →
// nunca hidratar_* (H6, adendo §15: sem elas não há hidratação por power) → nunca
// next_tool/pronto (núcleo da decisão).
import { perguntar, TETO_TARDIO_MS, TETO_PERGUNTAS, noul } from './nucleo/index.js';
export { TETO_TARDIO_MS, TETO_PERGUNTAS };

/** @typedef {{ tool: string, power: string, confidence: number }} Sugestao */
/** @typedef {{ power: string, noul: number }} HidratarPower */
/** @typedef {{ tool: string, power: string, noul: number, args: object, argsConfidence?: number }} PrefetchAceito */
/** @typedef {{ tool: string, motivo: string, param?: string }} PrefetchDescartado */
/** @typedef {{ hidratar: HidratarPower[], sugestao: Sugestao[], indice: {tool:string, power:string}[], prefetch: PrefetchAceito[], prefetchDescartados: PrefetchDescartado[], pronto: number, dicas: object, respostasDosPowers: object, escolha: string|null, confidence: number, meta: { ms: number, tokens: number, custo: number, modelo: string|null, degradado: false|string, estado?: object, cortes?: string[], perguntas?: string[], erro?: string, respostaCrua?: object } }} Decisao */

export function montarPerguntas({ catalogo, candidatos = {}, perguntasDosPowers = {}, nivel = 'curta', prioridadeDePower, powersCandidatos = [] }) {
  const q = { next_tool: { type: 'choice', instructions: INSTRUCOES_NEXT_TOOL, criteria: montarCriteria(catalogo, { nivel, prioridadeDePower }) }, pronto: { type: 'noul', instructions: INSTRUCOES_PRONTO, criteria: CRITERIA_PRONTO } };
  // H1/H6 (adendo §15): um `noul` por power CANDIDATO NÃO ATIVO — `powersCandidatos` já vem
  // filtrado pelo chamador (H4: power ativo não é perguntado, não há decisão a tomar).
  // Protegida do teto de TETO_PERGUNTAS igual a prefetch_*/pfarg_* (H6: sem elas não há
  // hidratação) — por isso a chave `hidratar_<id>` NUNCA entra em chavesArg/chavesPower
  // abaixo, os únicos arrays que cortarClasse alcança. Prefixo próprio: não colide com
  // power_*/arg_*/prefetch_*/pfarg_* (nomes de power não usam esses prefixos).
  for (const { id, desc } of powersCandidatos) {
    if (!id) continue;
    q[`hidratar_${id}`] = noul(instrucoesHidratarPower(id, desc || ''), CRITERIA_HIDRATAR_POWER);
  }
  // Correção (review do conjunto): `t.prefetch === true` (comparação estrita) — irmã do fix
  // simétrico em aplicarGates (gates.js), que já era estrito. Truthy (`if (t.prefetch)`) geraria
  // a pergunta pra um valor truthy não-boolean (ex. string 'true' de um manifesto malformado),
  // mas o gate, ao ler a resposta, nunca aceitaria (ele já exige `=== true`) — item preso sem
  // saída. Mesmo predicado nos dois lados.
  for (const t of catalogo) if (t.prefetch === true) q[`prefetch_${t.name}`] = { type: 'noul', instructions: instrucoesPrefetch(t), criteria: CRITERIA_PREFETCH };
  // A5/A2 (adendo §14): cada parâmetro de domínio fechado (`enum` utilizável — ver
  // enumUtilizavelDePrefetch em perguntas.js, correção 1 do review Fase 1) de uma tool de
  // prefetch vira uma choice própria — protegida do teto igual a prefetch_* (nunca entra em
  // chavesArg/chavesPower, então cortarClasse nunca a alcança). Enum não utilizável (vazio,
  // >254, ou contendo o sentinela sem_argumento) não gera pergunta — o mesmo predicado do
  // lado de aplicarGates trata esse param como se não tivesse enum, então o gate também não
  // vai exigir resposta pra ele.
  // Correção (ajuste pontual pós-review do conjunto): `pfarg_${tool}_${param}` colide entre, por
  // exemplo, tool "a_b" + param "c" e tool "a" + param "b_c" (mesma string "pfarg_a_b_c").
  // `mapearChavesPfarg` (perguntas.js) decide quem é o dono de cada chave com a mesma ordem e o
  // mesmo predicado deste loop — não sobrescreve: pula quem perdeu a chave e avisa.
  // aplicarGates usa a MESMA função para descartar o item da tool pulada por 'argumento-colisao'
  // sem ler `answers[chave]` (antes, ele reconstruía a chave sozinho e lia a resposta da
  // vencedora sob a semântica da tool errada — caía em 'argumento-sem-resposta' ou
  // 'argumento-invalido' por acidente).
  const { donos, pulados } = mapearChavesPfarg(catalogo);
  for (const { tool, param, chave } of pulados) console.warn(`[decisions] colisão de chave pfarg_*: "${chave}" já pertence a outra tool/param — pulando a pergunta de ${tool}.${param}`);
  for (const t of catalogo) {
    if (t.prefetch !== true) continue;
    for (const p of t.params || []) {
      const normalizados = enumUtilizavelDePrefetch(p?.enum);
      if (!normalizados) continue;
      const chave = `pfarg_${t.name}_${p.name}`;
      const dono = donos.get(chave);
      if (dono.tool !== t.name || dono.param !== p.name) continue; // colisão — já avisado acima
      const criteria = { [SEM_ARGUMENTO]: DESC_SEM_ARGUMENTO };
      for (const { str, indiceOriginal } of normalizados) criteria[str] = String(p.enumDescriptions?.[indiceOriginal] || str);
      q[chave] = { type: 'choice', instructions: instrucoesArgumentoPrefetch(t.name, p.name), criteria };
    }
  }
  const chavesArg = [];
  for (const [tool, params] of Object.entries(candidatos)) for (const [param, cands] of Object.entries(params)) {
    if (!Array.isArray(cands) || cands.length < 1) continue;
    const criteria = { [NENHUM]: DESC_NENHUM };
    // Correção (review do conjunto): candidato cujo String(v) colide com o sentinela NENHUM
    // sobrescreveria a entrada `nenhum_dos_candidatos` do criteria — descartado (não só o valor,
    // o candidato inteiro segue de fora do criteria), mesmo predicado usado por aplicarGates ao
    // casar a resposta (candidatoUtilizavel, perguntas.js).
    for (const [v, rotulo] of cands.slice(-60)) { if (candidatoUtilizavel(v)) criteria[String(v)] = String(rotulo || v); }
    const chave = `arg_${tool}_${param}`;
    q[chave] = { type: 'choice', instructions: instrucoesArgumento(tool, param), criteria };
    chavesArg.push(chave);
  }
  const chavesPower = [];
  for (const [power, perguntas] of Object.entries(perguntasDosPowers)) for (const [nome, p] of Object.entries(perguntas || {})) if (p?.type && p?.instructions) {
    const chave = `power_${power}_${nome}`;
    q[chave] = p;
    chavesPower.push(chave);
  }
  let excesso = Object.keys(q).length - TETO_PERGUNTAS;
  const cortarClasse = (chaves, rotulo) => {
    if (excesso <= 0 || !chaves.length) return;
    const aCortar = chaves.slice(-Math.min(excesso, chaves.length)); // de trás para frente
    for (const chave of aCortar) delete q[chave];
    excesso -= aCortar.length;
    console.warn(`[decisions] teto de ${TETO_PERGUNTAS} perguntas: descartadas ${aCortar.length} do tipo ${rotulo}`);
  };
  cortarClasse(chavesPower, 'power_*');
  cortarClasse(chavesArg, 'arg_*');
  // Correção 2 (review Fase 1): power_* e arg_* já cortaram tudo que podiam e o teto ainda
  // estourou — sobrou excesso só nas classes protegidas (next_tool/pronto/prefetch_*/pfarg_*/
  // hidratar_*, regra A5/H6, nunca cortadas). Isso passava em silêncio: o corpo HTTP ia maior
  // que o teto sem nenhum aviso, e se a API rejeitar (400), decidir() degrada sem culpado
  // igual ao cenário que motivou o teto original (comentário no topo do arquivo).
  if (excesso > 0) {
    console.warn(`[decisions] teto de ${TETO_PERGUNTAS} perguntas excedido por classes protegidas (next_tool/pronto/prefetch_*/pfarg_*/hidratar_*): ${Object.keys(q).length} perguntas, ${excesso} acima do teto`);
  }
  return q;
}

/**
 * @param {{ estado: object, catalogo: Array, candidatos?: object, perguntasDosPowers?: object, cliente: {decidir:Function}|null, cortes?: object, nivel?: string, prioridadeDePower?: object, tetoChars?: number, powersCandidatos?: Array<{id:string, desc?:string}> }} p
 * @returns {Promise<Decisao>}
 */
export async function decidir({ estado, catalogo: catalogoOriginal, candidatos = {}, perguntasDosPowers = {}, cliente, cortes, nivel = 'curta', prioridadeDePower, tetoChars, prazoMs, aoChegarTarde, estrategiasDeCandidatos, powersCandidatos = [] }) {
  // Parâmetros de texto livre das tools de prefetch ganham candidatos das estratégias
  // (candidatos.js) — mesmo catálogo derivado para perguntas e gates, senão os dois lados
  // divergem sobre quais pfarg_* existem.
  const catalogo = aplicarEstrategiasDeCandidatos(catalogoOriginal, { pedido: estado?.pedido, ...(estrategiasDeCandidatos ? { estrategias: estrategiasDeCandidatos } : {}) });
  const t0 = performance.now();
  const indice = (Array.isArray(catalogo) ? catalogo : []).map((t) => ({ tool: t.name, power: t.power }));
  const vazio = (degradado, extra = {}) => ({ escolha: null, confidence: 0, hidratar: [], sugestao: [], indice, prefetch: [], prefetchDescartados: [], pronto: 0, dicas: {}, respostasDosPowers: {}, meta: { ms: Math.round(performance.now() - t0), tokens: 0, custo: 0, modelo: null, degradado, ...extra } });
  if (!Array.isArray(catalogo) || !catalogo.length) return vazio('catalogo-vazio');
  if (!cliente) return vazio('sem-chave');
  // _cortes é meta-informação da montagem do estado (rótulos do que foi cortado pelo teto),
  // não conteúdo do pedido: fica de fora do que é enviado ao modelo e vai só no diagnóstico.
  const { _cortes, ...state } = montarEstado(estado, { tetoChars });
  const questions = montarPerguntas({ catalogo, candidatos, perguntasDosPowers, nivel, prioridadeDePower, powersCandidatos });
  // montarDecisao() converte o retorno genérico de perguntar() (nucleo/perguntar.js —
  // {answers, meta}, nunca lança) na Decisao completa da hidratação: aplica os gates quando
  // a chamada não degradou, e sempre acrescenta o diagnóstico específico deste chamador
  // (estado enviado, o que foi cortado, quais perguntas foram feitas). `powersAtivos` vem do
  // `estado` CRU (não do `state` já montado/cortado) — H4: aplicarGates ignora, por
  // segurança, qualquer candidato que por acaso já esteja ativo (o chamador já deveria ter
  // filtrado ao montar `powersCandidatos`; isso é só o cinto e suspensório).
  const montarDecisao = (r) => {
    if (r.meta.degradado) return { ...vazio(r.meta.degradado), meta: { ...r.meta, estado: state, cortes: _cortes, perguntas: Object.keys(questions) } };
    const d = aplicarGates(r.answers, { catalogo, candidatos, perguntasDosPowers, cortes, powersCandidatos, powersAtivos: estado?.powersAtivos });
    return { ...d, meta: { ...r.meta, estado: state, cortes: _cortes, perguntas: Object.keys(questions), respostaCrua: r.answers } };
  };
  const r = await perguntar({
    state, questions, cliente, prazoMs,
    aoChegarTarde: typeof aoChegarTarde === 'function' ? (tardia) => aoChegarTarde(montarDecisao(tardia)) : undefined,
  });
  return montarDecisao(r);
}

/**
 * Aquecimento com decisão real (adendo §14): o `GET` de `aquecer()` (transporte.js) só
 * esquenta DNS/TLS até a borda da OpenRouter, não o trecho até o provedor do modelo — a
 * primeira decisão ainda saía em ~750ms contra ~410ms das seguintes. Uma `POST` de decisão
 * mínima e genérica (uma única pergunta `pronto`, reaproveitando o texto já existente —
 * nenhuma palavra nova, custo ~US$ 0,00001) abre esse caminho antes da primeira mensagem
 * real do usuário. Nunca lança: falha (inclusive cliente null) vira `false`.
 * @param {{decidir:Function}|null} cliente
 * @returns {Promise<boolean>}
 */
export async function aquecerDecisao(cliente) {
  if (!cliente) return false;
  try {
    const r = await cliente.decidir({ state: { pedido: 'aquecimento' }, questions: { pronto: { type: 'noul', instructions: INSTRUCOES_PRONTO, criteria: CRITERIA_PRONTO } } });
    return Boolean(r?.answers);
  } catch {
    return false;
  }
}

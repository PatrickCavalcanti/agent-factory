// Registro de casos para treino (0.3.0). No fecho de cada turno NÃO trivial a fábrica monta o caso do turno com
// `montarCaso` (decisoes/treino/lib/caso.js — a mesma função que o treino do host lê) e o entrega a
// `config.aoRegistrarCaso`. Mora na fábrica porque é ela que tem, no mesmo lugar e na mesma hora, o texto do turno, o
// vetor da consulta, o `discover.explain` e as operações executadas; o host só decide ONDE gravar (no Igris, um
// arquivo; no Ariadne, o banco pelo rastro) e completa o que só ele tem (ver `dadosDoCaso`).
import { montarCaso, kairosDoExplain } from '../../decisoes/treino/lib/caso.js';

/**
 * Nome que o modelo chamou (`agenda__listar`, ou o cru `listar` quando a capacidade declara `aliasCru`) → ref
 * `capacidade/tool/função`, que é o que `montarCaso` espera para contar função e capacidade usadas. Só o catálogo diz
 * isso, e a fábrica o tem: sem esta resolução o nome entraria no caso como "nome cru" e o host teria de refazê-la.
 * @param {Array<{id: string, tools?: Array<{name: string}>, prefixarTools?: boolean}>} capacidades
 * @param {Map<string, string>} [sinonimosCrus] nome cru → nome exposto (`sinonimosCrus(...).porCru`)
 * @param {(capId: string, toolName: string, opts: {prefixar: boolean}) => string} nomeExposto
 * @returns {Map<string, string>}
 */
export function refsPorNomeChamado(capacidades, sinonimosCrus, nomeExposto) {
  const mapa = new Map();
  for (const cap of capacidades ?? []) {
    for (const tool of cap.tools ?? []) {
      mapa.set(nomeExposto(cap.id, tool.name, { prefixar: cap.prefixarTools !== false }), `${cap.id}/tool/${tool.name}`);
    }
  }
  for (const [cru, exposto] of sinonimosCrus ?? []) if (mapa.has(exposto)) mapa.set(cru, mapa.get(exposto));
  return mapa;
}

/**
 * Monta o caso do turno e o entrega ao gancho do host. NUNCA lança: falha do `dadosDoCaso`, do `montarCaso` ou do próprio
 * gancho (síncrona ou promessa rejeitada) vira `{ ref: 'registro-de-casos', error }` em `renderErrors` — observabilidade
 * do host não derruba o turno. O gancho NÃO é aguardado (fire-and-forget): promessa pendente não segura o retorno.
 *
 * Duas saídas para o erro. `renderErrors` é lido pelo host no retorno do turno, então só serve para o que falha ANTES do
 * retorno (síncrono). A rejeição TARDIA da promessa do gancho acontece depois que o host já leu o array: lá, o erro
 * só chega a quem está ouvindo, por `aoEvento({ tipo: 'fabrica:registro-de-casos', erro })` (em try/catch: handler que
 * lança não vira rejeição solta). O erro síncrono NÃO emite o evento: já está em `renderErrors`.
 *
 * @param {object} p
 * @param {{ aoRegistrarCaso?: Function, dadosDoCaso?: Function }} p.config
 * @param {object} p.ctx
 * @param {string} p.texto texto do usuário no turno
 * @param {boolean} p.trivial o turno foi trivial (o discover não rodou): não há caso a registrar
 * @param {number[][]|null} p.vetores vetores da consulta (os mesmos que o discover recebeu)
 * @param {Array<object>} p.operacoes
 * @param {object} p.discover `discoverResult` final do turno (de onde sai o `explain` do kairos)
 * @param {string[]} p.ativasNoInicio capacidades já ativas quando o turno começou (`loadedProviders` do estado dado ao 1º discover)
 * @param {Map<string, string>} p.refsPorNome ver `refsPorNomeChamado`
 * @param {Array<{ref: string, error: string}>} p.renderErrors
 * @param {(evento: object) => void} [p.aoEvento] `config.aoEvento`
 * @param {() => Date} [p.agora]
 */
export function registrarCasoDoTurno({ config, ctx, texto, trivial, vetores, operacoes, discover, ativasNoInicio, refsPorNome, renderErrors, aoEvento, agora = () => new Date() }) {
  if (typeof config.aoRegistrarCaso !== 'function' || trivial) return;
  const mensagem = (erro) => String(erro?.message ?? erro);
  const falhou = (erro) => renderErrors.push({ ref: 'registro-de-casos', error: mensagem(erro) });
  const falhouTarde = (erro) => {
    falhou(erro);
    try {
      aoEvento?.({ tipo: 'fabrica:registro-de-casos', erro: mensagem(erro) });
    } catch {
      // engolido de propósito — mesma garantia do `fabrica:catalogo-mudo`: handler de log não vira rejeição solta.
    }
  };
  try {
    const dados = (typeof config.dadosDoCaso === 'function' ? config.dadosDoCaso(ctx) : null) ?? {};
    const operacoesResolvidas = (operacoes ?? []).map((op) => {
      const ref = refsPorNome.get(String(op?.nome ?? ''));
      return ref ? { ...op, nome: ref } : op;
    });
    const caso = montarCaso({
      ts: agora().toISOString(),
      sessionId: dados.sessionId,
      interactionId: dados.interactionId,
      texto,
      vetores: vetores ?? [],
      operacoes: operacoesResolvidas,
      selecao: dados.selecao ?? null,
      guardarTexto: dados.guardarTexto === true,
      embedderSlug: dados.embedderSlug ?? null,
      ativasNoInicio: Array.isArray(dados.ativasNoInicio) ? dados.ativasNoInicio : ativasNoInicio,
      origem: dados.origem ?? 'chat',
      kairos: kairosDoExplain(discover?.explain),
    });
    const retorno = config.aoRegistrarCaso(caso, { texto, ctx, operacoes, discover, vetores: vetores ?? [] });
    if (retorno && typeof retorno.then === 'function') retorno.then(undefined, falhouTarde);
  } catch (erro) {
    falhou(erro);
  }
}

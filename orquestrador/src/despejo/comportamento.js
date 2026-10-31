// Aceite de contribuição de comportamento (spec 2026-10-29 aceite, §3 e §7). Funções PURAS, sem I/O — o orquestrador
// as chama; o host decide o que fazer com o resultado (semear o declarado no fecho do turno, Task 2.3).

/**
 * Separa o resultado de `aoPrepararHabilidade` entre o que vale só no turno e o que segue semeando direto, como hoje.
 *
 * Segue semeando direto (o host chama `aoSemear` para estes):
 *   - `requires` (habilidade com script): só no turno ela chegaria sem o `bash` do `skill-system`, que só entra pelo
 *     estado semeado do turno seguinte; o modelo não conseguiria segui-la para então declará-la (spec §7.3);
 *   - `jaCarregada`: já está na memória de trabalho (e no system); semear de novo é o no-op de sempre e o orquestrador
 *     só a registra em `skillsJaSemeadas` (dedup).
 * Vale só no turno: o resto (`sugeridas`), que ganha o bloco com o corpo e entra na oferta.
 *
 * @param {Array<{id: string, nome?: string, corpo?: string, aviso?: string, requires?: boolean, jaCarregada?: boolean}>} sucessos
 * @returns {{ sugeridas: Array<object>, semearDireto: string[] }}
 */
export function separarPreparadas(sucessos) {
  const sugeridas = [];
  const semearDireto = [];
  for (const s of Array.isArray(sucessos) ? sucessos : []) {
    if (!s || typeof s.id !== 'string' || !s.id) continue;
    if (s.jaCarregada === true || s.requires === true) semearDireto.push(s.id);
    else sugeridas.push(s);
  }
  return { sugeridas, semearDireto };
}

/**
 * Nome de exibição da habilidade: o `nome` que a carga devolve é a chave da memória de trabalho (`skill:<id>`) — o
 * prefixo é interno. Sem nome, ou com o nome igual ao id, fica só o id.
 *
 * @param {{ id: string, nome?: string }} s
 * @returns {string}
 */
export function nomeDaHabilidade(s) {
  const nome = typeof s?.nome === 'string' ? s.nome.trim().replace(/^skill:/, '') : '';
  return nome || s?.id;
}

/**
 * Conteúdo do bloco `#ativada` de uma habilidade que só vale no turno. O cabeçalho traz o ID: é ele que o modelo copia
 * em `_contribuicoes_usadas` para a habilidade subir para a memória de trabalho. Não diz "carregada": não está.
 *
 * @param {{ id: string, nome?: string, corpo: string, aviso?: string }} s
 * @returns {string}
 */
export function conteudoDaHabilidadeSugerida(s) {
  const aviso = typeof s.aviso === 'string' && s.aviso.trim() ? `${s.aviso}\n\n` : '';
  return `Habilidade sugerida para este pedido: ${nomeDaHabilidade(s)} (id: ${s.id})\n\n${aviso}${s.corpo}`;
}

/**
 * Oferta de comportamento do turno: o que o modelo pode declarar em `_contribuicoes_usadas`. O host só promove id que
 * está aqui (spec §3.2).
 *
 * @param {Array<{ id: string, ref: string, herdada?: boolean, nome?: string, origem?: 'jev'|'memoria'|'herdada'|'reofertada' }>} habilidades
 *   id puro + ref original (`<provider>/skill/<chave>`); `herdada`: veio do turno anterior (herança curta, spec §3.3);
 *   `nome`/`origem` (só quando há): de onde veio a oferta, para o card "Habilidade sugerida..." do host (não mudam id/ref/tipo)
 * @param {Array<{ id: string, ref?: string }>} [memorias] memórias que a fonte `memoria` incluiu no turno; o id é o `ref`
 *   do bloco (`memoria/memory/<categoria>.<chave>`), o mesmo `source` do `<info>` que o modelo lê. Memória não herda.
 * @returns {Array<{ tipo: 'habilidade'|'memoria', id: string, ref: string, herdada?: true }>}
 */
export function ofertaDoTurno(habilidades = [], memorias = []) {
  const vistos = new Set();
  const oferecidas = [];
  for (const h of habilidades) {
    if (!h?.id || vistos.has(h.id)) continue;
    vistos.add(h.id);
    oferecidas.push({
      tipo: 'habilidade', id: h.id, ref: h.ref ?? h.id, ...(h.herdada ? { herdada: true } : {}),
      ...(typeof h.nome === 'string' && h.nome ? { nome: nomeDaHabilidade(h) } : {}),
      ...(h.origem ? { origem: h.origem } : {}),
    });
  }
  for (const m of memorias) {
    if (!m?.id || vistos.has(m.id)) continue;
    vistos.add(m.id);
    oferecidas.push({ tipo: 'memoria', id: m.id, ref: m.ref ?? m.id });
  }
  return oferecidas;
}

/**
 * Saída do turno para o host: `{ oferecidas, herdadas, herdadasDescartadas }` com o interruptor ligado; `undefined`
 * desligado (a saída não ganha a chave). `herdadas` = ids da oferta que vieram do turno anterior (já estão em
 * `oferecidas`, com `herdada: true`); `herdadasDescartadas` = o que a herança tentou e não voltou, com o motivo.
 * `naoFixadasReofertadas` (só quando há): ids que o host NÃO conseguiu semear no fecho do turno anterior e que voltaram
 * agora, com a nota `<nao_fixadas>` (correção 1 da Fase 2).
 *
 * @param {boolean} ligado
 * @param {Array<{ tipo: string, id: string, ref: string, herdada?: boolean }>} oferecidas
 * @param {Array<{ id: string, motivo: string }>} [herdadasDescartadas]
 * @param {Array<{ id: string, motivo?: string }>} [naoFixadasReofertadas]
 * @param {string[]} [memoriasJaPromovidas] refs de memória que a seleção trouxe e saíram do turno por já estarem na
 *   memória de trabalho (Fase 3); só aparece quando há
 * @param {Record<string, string>} [textosDeMemoria] id -> texto (valor inteiro) das memórias oferecidas: é o que o host
 *   grava na memória de trabalho se o modelo declarar a memória; só aparece quando há
 * @returns {{ oferecidas: Array<object>, herdadas: string[], herdadasDescartadas: Array<object>, naoFixadasReofertadas?: Array<object>, memoriasJaPromovidas?: string[], textosDeMemoria?: Record<string, string> } | undefined}
 */
export function saidaDoComportamento(ligado, oferecidas, herdadasDescartadas = [], naoFixadasReofertadas = [], memoriasJaPromovidas = [], textosDeMemoria = {}) {
  if (!ligado) return undefined;
  return {
    oferecidas: [...oferecidas],
    herdadas: oferecidas.filter((o) => o.herdada).map((o) => o.id),
    herdadasDescartadas: [...herdadasDescartadas],
    ...(naoFixadasReofertadas.length ? { naoFixadasReofertadas: [...naoFixadasReofertadas] } : {}),
    ...(memoriasJaPromovidas.length ? { memoriasJaPromovidas: [...memoriasJaPromovidas] } : {}),
    ...(Object.keys(textosDeMemoria).length ? { textosDeMemoria: { ...textosDeMemoria } } : {}),
  };
}

/** Motivo de uma falha de semeio em uma linha curta (para o card e para a nota): sem quebra de linha nem `<`/`>`. */
export function motivoCurtoDeFalha(erro, max = 80) {
  const bruto = typeof erro === 'string' ? erro : (erro?.message ?? erro?.code ?? '');
  const limpo = String(bruto ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  if (!limpo) return 'recusada pelo sistema';
  return limpo.length > max ? `${limpo.slice(0, max - 1).trimEnd()}…` : limpo;
}

/**
 * Nota do turno para a habilidade que o modelo declarou e o host NÃO conseguiu fixar no fecho do turno anterior
 * (teto da memória de trabalho cheio, modo, poder ausente...). Mesmo padrão do aviso `<descartadas>`: bloco curto na
 * mensagem do turno. A habilidade volta como bloco neste pedido (uma vez só); declarar de novo tenta fixar outra vez.
 * Sem itens: `''` (o prompt-builder descarta a seção).
 *
 * @param {Array<{ id: string, nome?: string, motivo?: string }>} itens
 * @returns {string}
 */
export function notaDeNaoFixadas(itens = []) {
  const vistos = new Set();
  const linhas = [];
  for (const it of Array.isArray(itens) ? itens : []) {
    if (!it || typeof it.id !== 'string' || !it.id || vistos.has(it.id)) continue;
    vistos.add(it.id);
    const nome = nomeDaHabilidade(it);
    const rotulo = nome !== it.id ? `${nome} (id: ${it.id})` : it.id;
    linhas.push(`${rotulo} — você declarou esta habilidade, mas ela não entrou no contexto fixo (${motivoCurtoDeFalha(it.motivo)}). Ela vale neste pedido. Declarar de novo tenta fixar outra vez; enquanto o motivo continuar (ex.: memória de trabalho cheia), pode falhar de novo.`);
  }
  return linhas.length ? `<nao_fixadas>\n${linhas.join('\n')}\n</nao_fixadas>` : '';
}

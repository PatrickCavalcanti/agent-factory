// Embeddings dos exemplos de calibração persistidos em disco (spec do porte, §5.3). Chave =
// modelo + papel + hash do texto. Só frase nova ou alterada é embedada; o boot normal não paga
// o custo. NÃO é usado para pedidos reais do usuário — só para os exemplos dos poderes.
//
// Conferência geral 06/10 (B-I2/B-I4/B-M1): este cache é OTIMIZAÇÃO, nunca requisito do turno.
// A leitura é tolerante (arquivo vazio, JSON inválido, estrutura errada ou vetor ruim viram
// "refazer", com aviso) e a gravação é atômica (temporário + rename) e NUNCA lança — o
// `montarCatalogo` do orquestrador chama `salvar()` dentro do turno, e uma exceção aqui
// derrubava toda mensagem à fábrica com o disco cheio.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentHash } from '@okds/kairos/core/hash';

const avisados = new Set();
function avisarUmaVez(chave, mensagem) {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  console.warn(mensagem);
}

/** Vetor utilizável: array não vazio de números finitos. */
function vetorValido(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/**
 * Lê o arquivo do cache. Nunca lança. Arquivo ausente → cache vazio; erro de leitura (EISDIR,
 * EACCES…), vazio/JSON inválido ou estrutura fora de `{ versao: 1, itens: {…} }` → cache vazio +
 * `motivo` (`leitura:<código>`, `json-invalido`, `estrutura-invalida`); entrada que não é vetor
 * válido (`invalidas`), ou que é vetor válido mas de dimensão diferente da mais frequente do MESMO
 * modelo (`divergentes`), é descartada — o próximo `embed` daquele texto vai ao embedder de novo.
 * @returns {{ dados: { versao: 1, itens: Record<string, number[]> }, invalidas: number, divergentes: number, motivo: string|null }}
 */
function lerCache(arquivo) {
  const vazio = () => ({ versao: 1, itens: {} });
  if (!arquivo || !existsSync(arquivo)) return { dados: vazio(), invalidas: 0, divergentes: 0, motivo: null };
  let lido;
  try {
    lido = JSON.parse(readFileSync(arquivo, 'utf8'));
  } catch (err) {
    // Erro do sistema de arquivos (EISDIR, EACCES…) traz `code`; o SyntaxError do JSON não.
    return { dados: vazio(), invalidas: 0, divergentes: 0, motivo: err?.code ? `leitura:${err.code}` : 'json-invalido' };
  }
  if (lido?.versao !== 1 || !lido.itens || typeof lido.itens !== 'object' || Array.isArray(lido.itens)) {
    return { dados: vazio(), invalidas: 0, divergentes: 0, motivo: 'estrutura-invalida' };
  }
  const slugDe = (chave) => chave.split('#')[0];
  const contagem = new Map(); // modelSlug -> Map(dimensão -> quantas)
  for (const [chave, v] of Object.entries(lido.itens)) {
    if (!vetorValido(v)) continue;
    const porDim = contagem.get(slugDe(chave)) ?? new Map();
    porDim.set(v.length, (porDim.get(v.length) ?? 0) + 1);
    contagem.set(slugDe(chave), porDim);
  }
  const dimensaoDe = new Map();
  for (const [slug, porDim] of contagem) {
    dimensaoDe.set(slug, [...porDim].sort((a, b) => b[1] - a[1])[0][0]);
  }
  const itens = {};
  let invalidas = 0;
  let divergentes = 0;
  for (const [chave, v] of Object.entries(lido.itens)) {
    if (!vetorValido(v)) invalidas += 1;
    else if (v.length !== dimensaoDe.get(slugDe(chave))) divergentes += 1;
    else itens[chave] = v;
  }
  return { dados: { versao: 1, itens }, invalidas, divergentes, motivo: null };
}

/**
 * `roles` (opcional, conjunto de papéis): quando declarado, só esses papéis entram no cache em
 * disco — os outros passam direto ao embedder real, sem chave e sem entrada no arquivo. Default
 * `undefined` = TODO papel cacheado, que é o comportamento original e o que a calibração usa
 * (ela embeda só exemplos). O filtro existe para o CATÁLOGO (`cache-catalogo-disco.js`): lá o
 * mesmo objeto embedder também embebe a PERGUNTA do usuário a cada turno (`role: 'query'`, texto
 * novo sempre), e cacheá-la faria o arquivo crescer sem limite — um vetor por turno, para sempre.
 * `mesclar` (default `false`): no `salvar()`, relê o arquivo e acrescenta as entradas que outro
 * escritor gravou desde a nossa leitura (a memória vence). Para arquivo COMPARTILHADO (o de
 * `selecao-embeddings.json`, também escrito por `cache-semantica.js`); desligado, `salvar()` segue
 * sobrescrevendo, que é o que `limpar()` e os caches de dono único esperam.
 * ATENÇÃO: `limpar()` + `salvar()` com `mesclar: true` REIMPORTA o disco — as entradas que o `limpar()`
 * esvaziou na memória voltam do arquivo. Quem precisa realmente zerar o arquivo não deve usar `mesclar`.
 * @param {{ arquivo?: string, roles?: Set<string>|string[], mesclar?: boolean }} opcoes
 */
export function envolverEmbedderComDisco(embedder, { arquivo, roles, mesclar = false } = {}) {
  const filtro = roles ? new Set(roles) : null;
  const lido = lerCache(arquivo);
  let dados = lido.dados;
  // Entradas descartadas na leitura: regrava o arquivo limpo no próximo `salvar()`.
  let sujo = lido.invalidas + lido.divergentes > 0;
  if (lido.motivo) {
    avisarUmaVez(`ler:${arquivo}:${lido.motivo}`, `[orchestrator] cache de embeddings ${arquivo} ignorado (${lido.motivo}); será refeito.`);
  }
  if (lido.invalidas + lido.divergentes > 0) {
    const partes = [];
    if (lido.invalidas > 0) partes.push(`${lido.invalidas} vetor(es) inválido(s)`);
    if (lido.divergentes > 0) partes.push(`${lido.divergentes} com dimensão divergente da maioria do modelo`);
    avisarUmaVez(`descartadas:${arquivo}`, `[orchestrator] cache de embeddings ${arquivo}: ${partes.join(' e ')} descartado(s); serão refeitos.`);
  }
  const emVoo = new Map();
  return {
    modelSlug: embedder.modelSlug,
    // B1.5: a cadeia de embrulhos que envolve ESTE objeto. `cache-catalogo.js` usa para
    // chavear o bucket pela identidade do embedder de VERDADE — sem isso, uma segunda camada
    // (o cache em disco do catálogo) criaria um bucket novo por sessão e o reuso entre elas
    // (que o `WeakMap` existe justamente para garantir) seria perdido.
    embedderBase: embedder,
    async embed(texto, role) {
      if (filtro && !filtro.has(role)) return embedder.embed(texto, role);
      const chave = `${embedder.modelSlug}#${role}#${contentHash(texto)}`;
      if (dados.itens[chave]) return dados.itens[chave];
      if (emVoo.has(chave)) return emVoo.get(chave);
      const p = Promise.resolve(embedder.embed(texto, role)).then((v) => {
        emVoo.delete(chave);
        const vetor = Array.from(v);
        if (!vetorValido(vetor)) {
          // Vetor ruim ([] , NaN…) vai ao chamador como antes, mas NÃO entra no cache: gravado, voltaria
          // na próxima leitura como "inválido" e seria descartado (e refeito) para sempre.
          avisarUmaVez(`vetor-invalido:${embedder.modelSlug}`, `[orchestrator] embedder ${embedder.modelSlug} devolveu vetor inválido para o cache; não persisto.`);
          return vetor;
        }
        dados.itens[chave] = vetor; sujo = true; return vetor;
      }, (err) => { emVoo.delete(chave); throw err; });
      emVoo.set(chave, p);
      return p;
    },
    /**
     * Grava atômico (temporário por processo + rename) e NUNCA lança: falha de disco vira aviso
     * (uma vez por arquivo e código de erro) e o cache segue em memória, `sujo`, para a próxima
     * tentativa. O arquivo anterior nunca fica truncado — quem lê vê o antigo ou o novo inteiro.
     */
    async salvar() {
      if (!arquivo || !sujo) return;
      const tmp = `${arquivo}.${process.pid}.tmp`;
      try {
        if (mesclar) {
          const noDisco = lerCache(arquivo).dados.itens;
          for (const [k, v] of Object.entries(noDisco)) if (!(k in dados.itens)) dados.itens[k] = v;
        }
        mkdirSync(dirname(arquivo), { recursive: true });
        writeFileSync(tmp, JSON.stringify(dados));
        renameSync(tmp, arquivo);
        sujo = false;
      } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* temporário que nem chegou a existir ou é diretório: nada a limpar */ }
        const codigo = err?.code ?? err?.message ?? 'erro';
        avisarUmaVez(`salvar:${arquivo}:${codigo}`, `[orchestrator] não consegui gravar o cache de embeddings ${arquivo} (${codigo}); sigo com o cache em memória e tento de novo no próximo salvar.`);
      }
    },
    /**
     * Esquece TUDO o que está em memória (não o que já está no arquivo) — o próximo `embed` de
     * qualquer texto passa a ir ao embedder real de novo e o `salvar()` seguinte SOBRESCREVE o
     * arquivo. Usado pelo escape hatch do catálogo (`cache-catalogo-disco.js`,
     * `recalcularCatalogo` no `@igris/orchestrator`), que precisa forçar reembedding mesmo com
     * texto, hash e arquivo iguais.
     *
     * Reatribui `dados` (o closure dos `embed` em voo escreve na variável, não no objeto antigo),
     * então um embed que estava em voo no momento da limpeza pode voltar a gravar no `dados`
     * velho — ele se perde, que é o comportamento desejado num "esqueça tudo".
     */
    limpar() {
      dados = { versao: 1, itens: {} };
      emVoo.clear();
      sujo = false;
    },
  };
}

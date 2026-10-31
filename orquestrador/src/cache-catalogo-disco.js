// Vetores do catálogo da fábrica persistidos em DISCO (B1.5 do bloco B).
//
// O cache de processo (`cache-catalogo.js`) provou que o reuso entre sessões funciona, mas ele
// MORRE com o processo. Medido em `packages/api/dev-server.log` (01–02/10): o aquecimento do boot
// (`aquecerCatalogo`, `index.js`) leva 6,8 s a 42,8 s e a PRIMEIRA sessão chega no meio dele — o
// `catalogo` de 14.165–37.235 ms que ela paga é o RESTO desse aquecimento, não trabalho duplicado.
// Persistir o que o aquecimento embeda faz o custo existir só no primeiro boot da máquina.
//
// O mecanismo NÃO é novo: é o mesmo `envolverEmbedderComDisco` (`cache-exemplos.js`) que já
// guarda em disco os embeddings dos EXEMPLOS de calibração, com a MESMA invalidação (modelSlug +
// papel + `contentHash` do texto): texto novo ou mudado = chave nova = reembeda só ele.
//
// O que este módulo acrescenta é a IDENTIDADE. `envolverEmbedderComDisco` devolve um objeto
// NOVO a cada chamada, e o cache de processo chaveia o bucket pela REFERÊNCIA do embedder que
// recebe (`cache-catalogo.js`, `WeakMap`) — se cada sessão embrulhasse o embedder cru num wrapper
// novo, cada uma abriria o bucket vazio e o reuso entre sessões (que o commit 5afdb8b3b provou)
// seria perdido. Aqui o wrapper é MEMOIZADO por `embedder` (`WeakMap`) e por `arquivo` (`Map`),
// de modo que `aquecerCatalogo` e `montarCatalogo` — e duas sessões no mesmo processo — receivem
// SEMPRE o mesmo objeto, com o mesmo bucket do `cache-catalogo.js` e o mesmo `dados` em memória.
//
// Só o papel `passage` (`INDEX_ROLE`, o que o `indexAll` do kairos usa para os documentos do
// catálogo) vai para o arquivo: o mesmo objeto embedder também embede a PERGUNTA do usuário a
// cada turno (`role: 'query'`), e guardar isso em disco faria o arquivo crescer sem limite, um
// vetor por turno, para sempre. As perguntas passam direto ao embedder real — que é o que já
// acontecia, porque o cache de processo também não as guarda.
import { envolverEmbedderComDisco } from './cache-exemplos.js';
import { INDEX_ROLE } from '@okds/kairos/index/persist';

/** `embedder` CRU (o mesmo singleton de `getEmbedderDoKairos()`) -> `Map<arquivo, entry>`. */
let wrappers = new WeakMap();
/** Todos os wrappers já entregues, para `limparCacheDoCatalogoEmDisco` alcançar cada um — o
 *  `WeakMap` acima não é iterável e a limpeza é justamente global. O `FinalizationRegistry`
 *  tira de `vivos` o wrapper cujo embedder morreu, então o `Set` não vaza junto com o
 *  `WeakMap` (mesma economia de memória que `cache-catalogo.js` faz questão de manter). */
let vivos = new Set();
const vivosFinais = new FinalizationRegistry((entry) => vivos.delete(entry));

/**
 * Devolve `{ embedder, salvar }` para o cache em disco do catálogo.
 *
 * `salvar()` grava o arquivo — quem chama decide QUANDO (depois do `reindex()`, nunca no meio),
 * porque o wrapper marca `sujo` a cada embed novo e `salvar()` sai sem tocar o arquivo quando
 * nada mudou. `salvar()` sem `arquivo` é no-op (mesmo comportamento de `cache-exemplos.js`), e
 * sem embedder devolve `null`: quem chama degrada para o caminho só-lexico de sempre.
 *
 * `arquivo` ausente = persistência desligada: ainda devolve um wrapper (para não bifurcar o
 * chamador), mas ele não tem arquivo e `salvar()` não escreve nada.
 *
 * @param {object|null} embedder embedder CRU (antes de `envolverEmbedderComCache`)
 * @param {{ arquivo?: string|null }} [opcoes]
 * @returns {{ embedder: object, salvar: () => Promise<void> }|null}
 */
export function cacheDoCatalogoEmDisco(embedder, { arquivo } = {}) {
  if (!embedder) return null;
  let porArquivo = wrappers.get(embedder);
  if (!porArquivo) { porArquivo = new Map(); wrappers.set(embedder, porArquivo); }
  let entry = porArquivo.get(arquivo ?? null);
  if (!entry) {
    const envolvido = envolverEmbedderComDisco(embedder, { arquivo: arquivo ?? undefined, roles: [INDEX_ROLE] });
    entry = {
      embedder: envolvido,
      salvar: () => envolvido.salvar(),
      limpar: () => (envolvido.limpar ? envolvido.limpar() : undefined),
    };
    porArquivo.set(arquivo ?? null, entry);
    vivos.add(entry);
    vivosFinais.register(embedder, entry, entry);
  }
  return entry;
}

/**
 * Faz TODOS os wrappers em memória esquecerem o que embederam — para o próximo `reindex()` ir ao
 * embedder real de novo e o `salvar()` seguinte sobrescrever o arquivo.
 *
 * Chamado por `recalcularCatalogo` (`index.js`), o escape hatch manual: ele já limpa o cache de
 * processo (`limparCacheDeEmbeddingsDoProcesso`) para forçar reembedding mesmo com texto e hash
 * iguais. Deixar a camada de disco de fora faria o escape hatch não escapar de nada — o
 * `reindex()` leria os mesmos vetores de volta do arquivo. Não apaga o arquivo em si (o processo
 * seguinte volta a lê-lo); o que ele invalida é o CONTEÚDO em memória, que é reescrito no
 * próximo `salvar()`.
 */
export function limparCacheDoCatalogoEmDisco() {
  for (const entry of vivos) entry.limpar();
}
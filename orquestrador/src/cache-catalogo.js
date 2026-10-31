// Cache de embeddings do CATÁLOGO da fábrica, a nível de PROCESSO.
//
// Medido em `fabrica.json` (23/09): `tempos.orquestrador.catalogo` custa 1.656–1.924 ms no
// PRIMEIRO turno de cada sessão nova, 0 ms nos seguintes. `montarCatalogo` (index.js) já
// memoiza por INSTÂNCIA de orquestrador (`let catalogo`), e a fábrica cria uma instância por
// SESSÃO (`turno.js#executarTurnoPelaFabrica`) — então toda sessão nova reembeda do zero o
// MESMO texto semântico das MESMAS capacidades. O custo inteiro está em `manager.reindex()` →
// `indexAll()` (`@okds/kairos/index/persist`) → `embedder.embed()`.
//
// Por que não compartilhar o `manager` inteiro entre sessões (o desenho mais óbvio): os
// refinadores por anel que `criarOrquestrador` registra em `createManager({ refiners, ... })`
// fecham sobre `sessao.turnoAtual` da sessão que os criou (`turno.js` ~l.634-637) — um `manager`
// compartilhado entre a sessão A e a sessão B rodaria os refinadores de A quando B chamasse
// `discover()`. `createManager` também não aceita injetar um `VectorCache` alternativo (o
// `cache = createMemoryCache()` de `resolve/discover.ts` é fixo, por instância) — não há como
// pedir ao kairos para reusar o índice de outro manager.
//
// O que ESTE módulo faz em vez disso: envolve o `Embedder` que vai para `createManager` com uma
// camada de cache por CONTEÚDO (mesmo `contentHash` que `index/persist.ts` usa para o cache em
// disco do kairos) — processo inteiro, independente de qual `manager`/sessão pediu o embed.
// Granularidade por DOC (não por catálogo inteiro): mudar o texto de uma capacidade só invalida
// o hash DELA; as outras continuam batendo cache.
//
// "Identidade do embedder" é a REFERÊNCIA do objeto (`WeakMap`), não `embedder.modelSlug`. A
// primeira versão deste módulo chaveava por `modelSlug` — quebrou a suíte (`travas.test.js`):
// vários fixtures de teste, sem relação entre si, reusam o MESMO literal `'fake-test-v1'` para
// EMBEDDERS DIFERENTES (dimensões/funções diferentes) porque isso nunca importou antes — cada
// `createManager()` tinha seu próprio cache isolado. Com chave por `modelSlug`, dois fixtures
// que declaram o mesmo slug mas embedam DIFERENTE colidiam: o mesmo texto (`descricao` genérica
// repetida entre capacidades de teste) voltava com o vetor do OUTRO embedder, de outra
// dimensão — `cosine: dimensões divergentes`. Em produção isso nunca aconteceria (`modelSlug`
// real identifica um modelo real, um por processo, `getEmbedderDoKairos()` é singleton) — mas
// não custa nada ser estrito: a identidade VERDADEIRA de "este embedder" é o objeto em si, que
// `turno.js` já reusa como singleton (`getEmbedderDoKairos()`) entre turnos/sessões. `WeakMap`
// tem o bônus de não vazar memória se um embedder for trocado em runtime (o slug antigo nunca é
// coletado num `Map` comum; aqui o bucket inteiro morre com o objeto).
import { contentHash } from '@okds/kairos/core/hash';
import { INDEX_ROLE } from '@okds/kairos/index/persist';

/** `embedder` (objeto) -> Map(hash de conteúdo -> Promise<vetor>). `let`, não `const`: limpar o
 *  cache (`limparCacheDeEmbeddingsDoProcesso`) troca a instância inteira — `WeakMap` não tem
 *  `.clear()`. Guarda a PROMISE, não o vetor resolvido: dois chamadores concorrentes pedindo o
 *  MESMO hash (ex.: o aquecimento do boot ainda rodando quando a primeira sessão chega) precisam
 *  coalescer no mesmo embed() em voo, não disparar dois — mesmo motivo do `let catalogo`
 *  memoizar a PROMISE em `montarCatalogo` (index.js). */
let cacheDoProcesso = new WeakMap();

function bucket(embedder) {
  let m = cacheDoProcesso.get(embedder);
  if (!m) { m = new Map(); cacheDoProcesso.set(embedder, m); }
  return m;
}

/**
 * O embedder de VERDADE por trás de uma cadeia de embrulhos (`embedderBase`, que
 * `envolverEmbedderComDisco` — `cache-exemplos.js` — põe em cada camada que ele cria).
 *
 * B1.5: o catálogo passou a ser `envolverEmbedderComCache(cacheDoCatalogoEmDisco(embedderCru))` —
 * a camada de disco por FORA. Se o bucket fosse chaveado pelo objeto recebido, cada sessão que
 * montasse um wrapper próprio abriria o seu, e o reuso entre sessões (a garantia central deste
 * módulo, provada por `cache-catalogo.test.js` e por `fabrica-aquecimento-sessao.test.js`)
 * passaria a depender de todo chamador passar EXATAMENTE o mesmo `arquivoCache` — frágil demais
 * para uma otimização. Descer a cadeia devolve sempre o embedder cru, que é o singleton real
 * (`getEmbedderDoKairos()`), e o `WeakMap` volta a ter uma entrada por embedder, como antes.
 *
 * Só a CHAVE usa o base; as chamadas continuam indo para o embedder recebido (é ele que sabe
 * falar com o disco).
 */
function embedderDeBase(embedder) {
  let atual = embedder;
  while (atual && atual.embedderBase) atual = atual.embedderBase;
  return atual;
}

/**
 * Envolve um `Embedder` do kairos com o cache de processo — mesma forma (`modelSlug` +
 * `embed(text, role)`), transparente para `createManager`/`createGenosBridge`.
 *
 * Só intercepta `role === 'passage'` (`INDEX_ROLE`, o papel que `indexAll` usa para os
 * documentos do catálogo) — embeds de `'query'` (a pergunta do usuário, texto novo a cada
 * turno) passam direto para o embedder real, sem cache: cachear ali só ocuparia memória sem
 * nunca dar hit, e mudaria o comportamento de um caminho que não é o alvo desta otimização.
 *
 * A chave é o `embedder` CRU recebido aqui (identidade do objeto) — chamar esta função duas
 * vezes com o MESMO embedder (duas sessões, ou uma sessão depois de `aquecerCatalogo`) precisa
 * enxergar o mesmo bucket; embrulhar de novo o objeto JÁ envolvido não recria bucket nenhum
 * (`bucket()` usa o argumento recebido, e cada wrapper fecha sobre o `embedder` original que
 * lhe foi passado — nunca sobre outro wrapper). B1.5: com `embedderDeBase` acima, o mesmo vale
 * quando o objeto recebido já vem embrulhado em `envolverEmbedderComDisco`.
 *
 * Falha do embedder NÃO fica presa em cache: a entrada é removida antes de relançar, para a
 * PRÓXIMA chamada (mesmo hash) tentar de novo em vez de repetir o erro para sempre — mesmo
 * padrão do `catalogo.catch` em `montarCatalogo` (index.js).
 */
export function envolverEmbedderComCache(embedder) {
  if (!embedder) return embedder;
  return {
    modelSlug: embedder.modelSlug,
    async embed(text, role) {
      if (role !== INDEX_ROLE) return embedder.embed(text, role);
      const hash = contentHash(text);
      const m = bucket(embedderDeBase(embedder));
      const emCache = m.get(hash);
      if (emCache) return emCache;
      const promessa = Promise.resolve(embedder.embed(text, role)).catch((err) => {
        m.delete(hash);
        throw err;
      });
      m.set(hash, promessa);
      return promessa;
    },
  };
}

/**
 * Limpa o cache inteiro — usado por `recalcularCatalogo()` (index.js) para forçar reembedding
 * mesmo quando o texto/hash não mudou. Mudança normal de texto/capacidade/embedder já invalida
 * sozinha (embedder novo = objeto novo = bucket novo; texto novo = hash novo, cache miss); isto
 * é o escape hatch manual (ex.: suspeita de vetor corrompido).
 */
export function limparCacheDeEmbeddingsDoProcesso() {
  cacheDoProcesso = new WeakMap();
  limiaresDoProcesso = new Map();
}

// Limiares calculados por conjunto ativo (spec do porte, §5.4). Chave = ids + hash dos exemplos +
// modelo do embedder. Guarda a PROMESSA (duas sessões simultâneas não calculam duas vezes).
let limiaresDoProcesso = new Map();
export function limiaresEmCache(chave, calcular) {
  if (!limiaresDoProcesso.has(chave)) {
    const p = Promise.resolve().then(calcular).catch((err) => { limiaresDoProcesso.delete(chave); throw err; });
    limiaresDoProcesso.set(chave, p);
  }
  return limiaresDoProcesso.get(chave);
}

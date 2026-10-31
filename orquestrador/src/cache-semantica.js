// Adaptador `VectorCache` (`@okds/kairos/index/persist`) sobre o arquivo de vetores `query` do
// decisor local (`selecao-embeddings.json`), para `createManager({ cacheVetores })` (kairos 0.836).
//
// O kairos chama `get('<slug>#query', contentHash(texto))`; a chave gravada é
// `${'<slug>#query'}#${hash}` = `<slug>#query#<hash>` — a MESMA que `cache-exemplos.js#
// envolverEmbedderComDisco` grava (`${slug}#${papel}#${hash}`) com `roles: ['query']`. Um texto
// embedado pelo decisor é, portanto, cache-hit aqui, e vice-versa. Formato: `{ versao: 1, itens }`.
//
// OTIMIZAÇÃO, nunca requisito: leitura tolerante, gravação atômica (tmp + rename) que nunca lança.
//
// Coexistência com o decisor (até ele migrar para o Kairos): os dois escrevem o MESMO arquivo e
// cada um segura uma cópia em memória lida na construção. Aqui o `flush` RELÊ o arquivo e mescla
// (o que está em memória vence) antes de gravar, para não apagar o que o decisor gravou depois da
// nossa leitura. O outro sentido (decisor sobrescrevendo o nosso) é fechado por
// `envolverEmbedderComDisco({ mesclar: true })`.
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

const avisados = new Set();
function avisarUmaVez(chave, mensagem) {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  console.warn(mensagem);
}

const vetorValido = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Itens do arquivo; nunca lança (ausente/ilegível/estrutura errada → `{}`). */
function lerItens(arquivo) {
  try {
    if (!arquivo || !existsSync(arquivo)) return {};
    const j = JSON.parse(readFileSync(arquivo, 'utf8'));
    if (j?.versao !== 1 || !j.itens || typeof j.itens !== 'object' || Array.isArray(j.itens)) return {};
    // Vetor inválido (não array / não finito) não volta ao disco: some na primeira leitura.
    return Object.fromEntries(Object.entries(j.itens).filter(([, v]) => vetorValido(v)));
  } catch {
    return {};
  }
}

const instancias = new Map(); // caminho → cache (uma por caminho no processo)

/**
 * Uma instância por caminho no processo: sessões simultâneas compartilham a mesma memória e não
 * regravam o arquivo em paralelo cada uma com a sua cópia.
 * @param {string} arquivo
 * @returns {{ get(modelo: string, hash: string): number[]|undefined, set(modelo: string, hash: string, vetor: ArrayLike<number>): void, flush(): void }}
 */
export function criarCacheSemantica(arquivo) {
  const existente = instancias.get(arquivo);
  if (existente) return existente;
  const itens = lerItens(arquivo);
  let sujo = false;
  const cache = {
    get(modelo, hash) {
      const v = itens[`${modelo}#${hash}`];
      return vetorValido(v) ? v : undefined;
    },
    set(modelo, hash, vetor) {
      const v = Array.from(vetor);
      if (!vetorValido(v)) return; // vetor ruim não entra: voltaria "inválido" na próxima leitura
      itens[`${modelo}#${hash}`] = v;
      sujo = true;
    },
    flush() {
      if (!sujo || !arquivo) return;
      const tmp = `${arquivo}.${process.pid}.tmp`;
      try {
        // Mescla com o que outro escritor (o decisor) gravou desde a nossa leitura; a memória vence.
        const noDisco = lerItens(arquivo);
        for (const [k, v] of Object.entries(noDisco)) if (!(k in itens)) itens[k] = v;
        mkdirSync(dirname(arquivo), { recursive: true });
        writeFileSync(tmp, JSON.stringify({ versao: 1, itens }));
        renameSync(tmp, arquivo);
        sujo = false;
      } catch (err) {
        try { rmSync(tmp, { force: true }); } catch { /* nada a limpar */ }
        const codigo = err?.code ?? err?.message ?? 'erro';
        avisarUmaVez(`flush:${arquivo}:${codigo}`, `[orchestrator] não consegui gravar o cache semântico ${arquivo} (${codigo}); sigo em memória.`);
      }
    },
  };
  instancias.set(arquivo, cache);
  return cache;
}

/** Só para teste: esquece as instâncias memoizadas. */
export function limparCachesSemanticaDoProcesso() {
  instancias.clear();
}

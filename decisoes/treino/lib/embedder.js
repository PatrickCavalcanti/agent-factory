// Embedder do provider de roteamento para os comandos de treino — MESMO contrato e mesma lógica de
// `adaptarEmbedder` (packages/semantic-context/src/embedder.js:18-34), sem depender daquele pacote.
// Mesmos vetores da decisão (spec D5).
// No Igris o provider vem de @igris/embeddings (`getProviderForRole`), que só resolve com o estado de embeddings
// inicializado pelo app. Aqui o resolvedor é injetado pelo host; falha de resolução = o chamador termina com `FALTA:`.
// Cache em disco opcional: { versao:1, itens:{ "<slug>#<role>#<sha16>": number[] } }.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export async function embedderDoRoteamento({ resolver = null } = {}) {
  // O resolvedor (`(role) => provider`) é do host: o pacote não importa nenhum módulo de embeddings (no Igris:
  // `getProviderForRole` de @igris/embeddings).
  if (typeof resolver !== 'function') throw new Error('embedderDoRoteamento: resolver é obrigatório (função (role) => provider)');
  const resolve = resolver;
  const provider = await resolve('routing');
  if (!provider) throw new Error('provider de roteamento ausente');
  return {
    modelSlug: provider.slug,
    async embed(text, role = 'query') {
      const vetores = await provider.embed([text], { kind: role });
      const vetor = vetores?.[0];
      if (!Array.isArray(vetor)) throw new Error(`provider "${provider.slug}" nao devolveu vetor`);
      return vetor;
    },
  };
}

// `roles` (opcional): só esses papéis passam pelo cache; os demais vão direto ao provider. Mesmas chaves e
// formato do `envolverEmbedderComDisco` do orchestrator — o arquivo é compartilhável com a produção.
// `mesclar`: no `salvar()`, relê o arquivo e acrescenta as entradas que outro escritor gravou desde a nossa leitura
// (a memória vence) — para arquivo COMPARTILHADO (`selecao-embeddings.json`, também escrito pelo cache de semântica do Kairos).
export function comCacheEmDisco(embedder, arquivo, { roles = null, mesclar = false } = {}) {
  const filtro = roles ? new Set(roles) : null;
  let dados = { versao: 1, itens: {} };
  if (existsSync(arquivo)) { try { dados = JSON.parse(readFileSync(arquivo, 'utf8')); } catch { /* recomeça */ } }
  if (!dados?.itens || typeof dados.itens !== 'object') dados = { versao: 1, itens: {} };
  let sujo = false;
  return {
    modelSlug: embedder.modelSlug,
    async embed(texto, role = 'query') {
      if (filtro && !filtro.has(role)) return embedder.embed(texto, role);
      const chave = `${embedder.modelSlug}#${role}#${createHash('sha256').update(String(texto)).digest('hex').slice(0, 16)}`;
      if (Array.isArray(dados.itens[chave])) return dados.itens[chave];
      const v = await embedder.embed(texto, role);
      if (Array.isArray(v)) { dados.itens[chave] = v; sujo = true; }
      return v;
    },
    salvar() {
      if (!sujo) return;
      if (mesclar && existsSync(arquivo)) {
        try {
          const noDisco = JSON.parse(readFileSync(arquivo, 'utf8'))?.itens;
          if (noDisco && typeof noDisco === 'object') for (const [k, v] of Object.entries(noDisco)) if (!(k in dados.itens)) dados.itens[k] = v;
        } catch { /* ilegível: a memória sobrescreve */ }
      }
      mkdirSync(dirname(arquivo), { recursive: true });
      writeFileSync(`${arquivo}.tmp`, JSON.stringify(dados));
      renameSync(`${arquivo}.tmp`, arquivo);
      sujo = false;
    },
  };
}

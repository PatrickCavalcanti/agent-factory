// Cauda efêmera e despejo de capacidades (spec 2026-10-29). Padrão + override; nunca lança.
export const DESPEJO_PADRAO = Object.freeze({
  cauda: false,          // seleção vai só para a mensagem do turno; system recebe o que o modelo usou
  despejo: false,        // sem uso há X mensagens → descartável; sai em lote quando a conta compensa
  comportamento: false,  // seleção pelo comportamento fica desligada por padrão
  x: 8,                  // mensagens sem uso até virar descartável (calibrado na simulação de 29/10; spec: 5)
  m: 2,                  // mensagens seguidas na cauda sem uso até exigir sinal forte (calibrado em 29/10; spec: 3)
  n: 5,                  // mensagens à frente no horizonte (sem estimativa do Jev)
  k: 5,                  // janela da média de chamadas por mensagem
  pausaMin: 20,          // pausa a partir da qual o cache conta como perdido
  r: 0.1,                // preço lido do cache ÷ preço cheio
  w: 1.0,                // preço da escrita de cache ÷ preço cheio
  razaoPadrao: 0.25,     // tokens por caractere sem medida real
  tetoAvisoChars: 1200,  // teto do bloco <descartadas>
  dezMais: 10,           // valor de "10+" na estimativa do Jev
  sinalForte: Object.freeze({ cabeca: 0.4, z: 2.5 }),
  porModelo: Object.freeze({}),
});

const NUMEROS = {
  x: [1, 1000, true], m: [1, 1000, true], n: [1, 1000, false], k: [1, 100, true],
  pausaMin: [0, 100000, false], r: [0, 1, false], w: [0, 10, false],
  razaoPadrao: [0.01, 10, false], tetoAvisoChars: [0, 100000, true], dezMais: [1, 1000, false],
};

const valido = (v, [min, max, inteiro]) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!inteiro || Number.isInteger(v));

/** @returns {{ config: typeof DESPEJO_PADRAO, motivos: string[] }} */
export function normalizarDespejo(bruto) {
  const config = { ...DESPEJO_PADRAO, sinalForte: { ...DESPEJO_PADRAO.sinalForte }, porModelo: {} };
  const motivos = [];
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { config, motivos };
  for (const [chave, valor] of Object.entries(bruto)) {
    if (chave === 'cauda' || chave === 'despejo' || chave === 'comportamento') {
      if (typeof valor === 'boolean') config[chave] = valor;
      else motivos.push(`${chave} não é boolean`);
    } else if (NUMEROS[chave]) {
      if (valido(valor, NUMEROS[chave])) config[chave] = valor;
      else motivos.push(`${chave} fora da faixa [${NUMEROS[chave][0]}, ${NUMEROS[chave][1]}]`);
    } else if (chave === 'sinalForte') {
      if (valor && valido(valor.cabeca, [0, 1, false])) config.sinalForte.cabeca = valor.cabeca;
      if (valor && valido(valor.z, [0, 100, false])) config.sinalForte.z = valor.z;
    } else if (chave === 'porModelo') {
      for (const [modelo, p] of Object.entries(valor ?? {})) {
        const r = valido(p?.r, NUMEROS.r) ? p.r : undefined;
        const w = valido(p?.w, NUMEROS.w) ? p.w : undefined;
        if (r === undefined && w === undefined) { motivos.push(`porModelo.${modelo} sem r/w válidos`); continue; }
        config.porModelo[modelo] = { ...(r !== undefined ? { r } : {}), ...(w !== undefined ? { w } : {}) };
      }
    } else {
      motivos.push(`${chave} desconhecida`);
    }
  }
  return { config, motivos };
}

/** r e w do modelo do turno (override por modelo sobre o padrão da config). */
export function parametrosDoModelo(config, modelo) {
  const p = (modelo && config.porModelo?.[modelo]) || {};
  return { r: p.r ?? config.r, w: p.w ?? config.w };
}

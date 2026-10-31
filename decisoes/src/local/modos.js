// packages/decisions/src/local/modos.js
// Modo por anel (spec D3): quem decide e quem roda em sombra. A sombra sai em paralelo, o turno NÃO espera,
// e o registro é um objeto mutável — `estado` vai de 'pendente' a 'respondida'/'erro'; quem grava o
// artefato serializa o que tiver no fim do turno (pendente = sem resposta a tempo).
export const MODOS = new Set(['jev', 'local', 'local+sombra-jev', 'jev+sombra-local']);

// `atrasoSombraJevMs`: a sombra que é o JEV sai só depois desse atraso. O anel `skill` tem o Jev como principal e corre
// em paralelo com as sombras Jev de `provider`/`tool`; com o atraso, a chamada que decide chega primeiro ao gateway
// (sessão bf3ac6e2, 23/10: o Jev de habilidades estourou o prazo por 393 ms com as sombras disputando o gateway).
// Sombra local (rápida, não usa o gateway) nunca espera.
export function refinadorPorModo({ modo, local, jev, aoSombra = null, atrasoSombraJevMs = 0 }) {
  if (!MODOS.has(modo)) throw new Error(`modo desconhecido: ${modo}`);
  if (modo === 'local') return local;
  if (modo === 'jev') return jev || null;
  const [principal, sombra, nomes] = modo === 'local+sombra-jev' ? [local, jev, ['local', 'jev']] : [jev, local, ['jev', 'local']];
  if (!principal) return null;
  const atrasoMs = nomes[1] === 'jev' && atrasoSombraJevMs > 0 ? atrasoSombraJevMs : 0;
  return async function refinarComSombra(input) {
    // A sombra sai ANTES do await do principal (paralelo de verdade). O registro nasce com `principal: null`
    // e é preenchido quando o principal volta; se o principal lançar, a sombra segue registrada e o erro propaga.
    let reg = null;
    if (sombra && aoSombra) {
      reg = { anel: input?.ring, principalDe: nomes[0], sombraDe: nomes[1], principal: null, msPrincipal: null, erroPrincipal: null, estado: 'pendente', sombra: null, msSombra: null, erro: null, ...(atrasoMs ? { atrasoMs } : {}) };
      aoSombra(reg);
      const espera = atrasoMs ? new Promise((r) => setTimeout(r, atrasoMs)) : Promise.resolve();
      let t1 = performance.now();
      espera.then(() => { t1 = performance.now(); return sombra(input); }).then(
        (s) => { reg.estado = 'respondida'; reg.sombra = s; reg.msSombra = Math.round(performance.now() - t1); },
        (e) => { reg.estado = 'erro'; reg.erro = String(e?.message ?? e); reg.msSombra = Math.round(performance.now() - t1); },
      );
    }
    const t0 = performance.now();
    try {
      const r = await principal(input);
      if (reg) { reg.principal = r; reg.msPrincipal = Math.round(performance.now() - t0); }
      return r;
    } catch (e) {
      if (reg) { reg.erroPrincipal = String(e?.message ?? e); reg.msPrincipal = Math.round(performance.now() - t0); }
      throw e;
    }
  };
}

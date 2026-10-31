// packages/decisions/treino/lib/sombra.js
// Resumo das sombras (spec §7): por anel — concordância de `full`, fração de turnos em que cada decisor trouxe
// o que a LLM de fato usou (anel provider/skill: a capacidade, em full ∪ candidates; anel tool: a ref
// cap/tool/<função>, só em full), e latência p50/p95. Só turnos com sombra respondida e principal presente entram em concordância e "trouxe".
const p = (xs, q) => { if (!xs.length) return null; const o = [...xs].sort((a, b) => a - b); return o[Math.floor(q * (o.length - 1))]; };
const capDoRef = (ref) => String(ref).split(/\/(?:tool|skill)\//)[0];

export function resumirSombras(fabricas, mapaFuncaoCap) {
  const porAnel = {};
  for (const f of fabricas) {
    // 10/10: poder prefixado (`cap__fn`) resolve pelo nome cru.
    const nomes = (f?.operacoes || []).map((o) => { const n = String(o?.nome ?? ''); const i = n.indexOf('__'); return i > 0 ? n.slice(i + 2) : n; }).filter((n) => mapaFuncaoCap.get(n));
    const usadasCap = new Set(nomes.map((n) => mapaFuncaoCap.get(n)));
    const usadasRef = new Set(nomes.map((n) => `${mapaFuncaoCap.get(n)}/tool/${n}`));
    for (const s of f?.selecaoLocal?.sombras || []) {
      const a = (porAnel[s.anel] ??= { turnos: 0, semResposta: 0, erros: 0, errosPrincipal: 0, degradados: 0, _conc: [], _trouxe: {}, _ms: {} });
      a.turnos++;
      // Degradado é por decisor: `degradadoPrincipal`/`degradadoSombra` (registro antigo só com `degradado` vale para os dois).
      // Concordância exige os dois não degradados; "trouxe" de cada decisor só exige que AQUELE não esteja degradado.
      const legado = s.degradadoPrincipal === undefined && s.degradadoSombra === undefined && s.degradado === true;
      const dp = legado || s.degradadoPrincipal === true; const ds = legado || s.degradadoSombra === true;
      const deg = dp || ds;
      // Latência: a do Jev degradado (prazo estourado) entra — é o tempo que se quer ver; a do local degradado
      // (sem-semantica, erro...) é ~0 por construção e não representa o decisor, então fica fora.
      const tempo = (quem, ms, degradado) => { if (ms != null && quem && !(degradado && quem === 'local')) (a._ms[quem] ??= []).push(ms); };
      if (deg) a.degradados++;
      if (s.principal) tempo(s.principalDe, s.msPrincipal, dp);
      if (!s.principal || (s.estado === 'respondida' && s.sombra) || ds) tempo(s.sombraDe, s.msSombra, ds);
      if (!deg) {
        // Principal falhou ou não voltou: sem referência, o turno fica fora de concordância e de "trouxe".
        if (!s.principal) { a.errosPrincipal++; continue; }
        if (s.estado !== 'respondida' || !s.sombra) { if (s.estado === 'erro') a.erros++; else a.semResposta++; continue; }
      } else if (!s.principal || !s.sombra) continue;
      if (!deg) {
        const fp = new Set(s.principal.full); const fs = new Set(s.sombra.full);
        const uniao = new Set([...fp, ...fs]);
        a._conc.push(uniao.size ? [...fp].filter((x) => fs.has(x)).length / uniao.size : 1);
      }
      const usadas = s.anel === 'tool' ? usadasRef : usadasCap;
      if (usadas.size) for (const [quem, r, d] of [[s.principalDe, s.principal, dp], [s.sombraDe, s.sombra, ds]]) {
        if (d) continue;
        const trouxe = new Set((s.anel === 'tool' ? r.full : [...r.full, ...r.candidates]).map((x) => (s.anel === 'tool' ? String(x) : capDoRef(x))));
        (a._trouxe[quem] ??= []).push([...usadas].every((u) => trouxe.has(u)) ? 1 : 0);
      }
    }
  }
  const media = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  return Object.fromEntries(Object.entries(porAnel).map(([anel, a]) => [anel, {
    turnos: a.turnos, semResposta: a.semResposta, erros: a.erros, errosPrincipal: a.errosPrincipal, degradados: a.degradados, concordaFull: media(a._conc),
    trouxeUsado: Object.fromEntries(Object.entries(a._trouxe).map(([k, v]) => [k, media(v)])),
    ms: Object.fromEntries(Object.entries(a._ms).map(([k, v]) => [k, { p50: p(v, 0.5), p95: p(v, 0.95) }])),
  }]));
}

/** Turnos com o decisor desligado (selecaoLocal.desligado): contados à parte, não entram em nenhum anel. */
export const contarDesligados = (fabricas) => fabricas.filter((f) => f?.selecaoLocal?.desligado).length;

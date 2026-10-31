// Linha-sinal do treino completo por anel (contrato de processo: `OK …` / `FALTA: …`). Sem imports: o `treinar.mjs` é um
// cliente HTTP puro e o formato precisa ser testável sem subir o app.
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2).replace('.', ',') : '—');
const pareadoDe = (r) => {
  const p = r.diagnostico?.pareado;
  return p ? `venceu ${p.cabecaVenceu}, perdeu ${p.baseVenceu}, empate ${p.empate}` : null;
};

/**
 * Linha-sinal de um anel (`r` = o resumo do anel devolvido pela rota: `anelAprovado`, `portao`, `mantida`, `versao`, `metricasAnel
 * {base, cabeca, n}` e `diagnostico {n, minAvaliacao, pareado, emUso {r3Nova, r3Recalculado, comparou}}`):
 * - aprovada:        `OK provider: cabeça aprovada (R@3 0,56 × base 0,42, n=106; venceu 30, perdeu 8, empate 68)`
 * - não ganhou:      `OK tool: cabeça reprovada — não ganhou da base (n=64: cabeça 0,41 × base 0,50; venceu 9, perdeu 17, empate 38)`
 * - sem veredito, gravada com o anel na base: `OK tool: cabeça reprovada — poucos-recentes (n=12/30, sem veredito; R@3 0,58 × base 0,50)`
 * - piorou (rejeição): `OK provider: versão v3 mantida — nova 0,52 × atual 0,60 × base 0,45 nos mesmos 48 casos (piorou)`
 * - versão em uso v1 que perdia da base: o sufixo `— versão v1 em uso descartada (atual 0,40 × base 0,45 nos mesmos 48 casos)`
 * - sem veredito, em uso mantida: `OK provider: versão v1 mantida — poucos-recentes (n=12/30, sem veredito; R@3 0,58 × base 0,50)`
 */
export function linhaSinalDoAnel(anel, r) {
  const m = r.metricasAnel ?? {};
  const d = r.diagnostico ?? {};
  const n = m.n ?? d.n ?? 0;
  const pareado = pareadoDe(r);
  const quem = r.versao != null ? `versão v${r.versao}` : 'versão em uso';
  if (r.mantida && r.portao === 'piorou-frente-a-atual') {
    const e = d.emUso ?? {};
    return `OK ${anel}: ${quem} mantida — nova ${fmt(e.r3Nova)} × atual ${fmt(e.r3Recalculado)} × base ${fmt(e.r3BaseNosMesmos)} nos mesmos ${e.comparou ?? 0} casos (piorou)`;
  }
  if (r.portao === 'poucos-recentes') {
    const quando = `${r.mantida ? `${quem} mantida` : 'cabeça reprovada'} — poucos-recentes`;
    return `OK ${anel}: ${quando} (n=${n}/${d.minAvaliacao ?? '?'}, sem veredito; R@3 ${fmt(m.cabeca)} × base ${fmt(m.base)})`;
  }
  if (r.mantida) return `OK ${anel}: ${quem} mantida — ${r.portao ?? r.motivo ?? 'rejeitada'} (n=${n})`;
  const pareadoTxt = pareado ? `; ${pareado}` : '';
  // versão em uso sem avaliação (v1) que perdia da base nos mesmos casos: descartada como régua, a nova foi julgada só contra a base
  const e = d.emUso ?? {};
  const descartada = e.descartada === 'perde-da-base' ? ` — ${e.versao != null ? `versão v${e.versao}` : 'versão'} em uso descartada (atual ${fmt(e.r3Recalculado)} × base ${fmt(e.r3BaseNosMesmos)} nos mesmos ${e.comparou ?? 0} casos)` : '';
  if (r.anelAprovado) return `OK ${anel}: cabeça aprovada (R@3 ${fmt(m.cabeca)} × base ${fmt(m.base)}, n=${n}${pareadoTxt})${descartada}`;
  if (r.portao === 'nao-ganhou') return `OK ${anel}: cabeça reprovada — não ganhou da base (n=${n}: cabeça ${fmt(m.cabeca)} × base ${fmt(m.base)}${pareadoTxt})${descartada}`;
  return `OK ${anel}: cabeça reprovada (R@3 ${fmt(m.cabeca)} × base ${fmt(m.base)}, n=${n}${pareadoTxt})${r.portao ? ` — portão: ${r.portao}` : ''}`;
}

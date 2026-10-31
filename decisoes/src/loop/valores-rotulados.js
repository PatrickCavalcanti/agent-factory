// Registro de valores rotulados (spec 2026-10-14 §6.2; D7 da spec 2026-09-17): ids que resultados de
// funções trouxeram, com rótulo legível, oferecidos como OPÇÃO a parâmetros do mesmo `tipo`. O Jev
// continua só escolhendo. Puro.

export const TETO_POR_TIPO = 8;

function valoresNoCaminho(objeto, caminho) {
  // `a.b` → [obj.a.b]; `a[].b` → obj.a.map(x => x.b). Devolve lista de { elemento, valor }.
  const partes = caminho.split('.');
  let atuais = [objeto];
  for (const parte of partes) {
    const ehLista = parte.endsWith('[]');
    const chave = ehLista ? parte.slice(0, -2) : parte;
    const proximos = [];
    for (const a of atuais) {
      const v = a && typeof a === 'object' ? a[chave] : undefined;
      if (ehLista) { if (Array.isArray(v)) proximos.push(...v); } else proximos.push(v);
    }
    atuais = proximos;
  }
  return atuais;
}

function paresDoProdutor(resultado, { id, rotulo }) {
  // id e rótulo no MESMO elemento: separa o prefixo comum até o último `[]`.
  const corte = id.lastIndexOf('[]');
  if (corte >= 0 && rotulo.startsWith(id.slice(0, corte + 2))) {
    const prefixo = id.slice(0, corte + 2);
    const elementos = valoresNoCaminho(resultado, prefixo.slice(0, -2) + '[]');
    const restoId = id.slice(corte + 3);
    const restoRotulo = rotulo.slice(corte + 3);
    return elementos.map((el) => ({ valor: valoresNoCaminho(el, restoId)[0], rotulo: valoresNoCaminho(el, restoRotulo)[0] }));
  }
  return [{ valor: valoresNoCaminho(resultado, id)[0], rotulo: valoresNoCaminho(resultado, rotulo)[0] }];
}

/** @returns {Record<string, Array<{valor: string|number, rotulo: string}>>} */
export function extrairRotulados(resultado, produz) {
  let obj = resultado;
  if (typeof resultado === 'string') { try { obj = JSON.parse(resultado); } catch { return {}; } }
  if (!obj || typeof obj !== 'object' || !Array.isArray(produz)) return {};
  const saida = {};
  for (const p of produz) {
    if (!p?.tipo || !p?.id || !p?.rotulo) continue;
    for (const { valor, rotulo } of paresDoProdutor(obj, p)) {
      if ((typeof valor !== 'string' && typeof valor !== 'number') || String(valor).trim() === '') continue;
      if (typeof rotulo !== 'string' || !rotulo.trim()) continue; // sem rótulo não entra
      (saida[p.tipo] ??= []).push({ valor, rotulo: rotulo.trim() });
    }
  }
  return saida;
}

/** Junta registros: o primeiro argumento é o mais recente. Sem repetir valor; teto por tipo. */
export function mesclarRotulados(...registros) {
  const saida = {};
  for (const r of registros) {
    for (const [tipo, lista] of Object.entries(r ?? {})) {
      const atual = (saida[tipo] ??= []);
      for (const v of lista ?? []) {
        if (atual.length >= TETO_POR_TIPO) break;
        if (!atual.some((x) => String(x.valor) === String(v.valor))) atual.push(v);
      }
    }
  }
  return saida;
}

/** Acrescenta as opções do registro aos params com `tipo`. Não muta. */
export function comOpcoesRotuladas(params, valoresPorTipo) {
  if (!Array.isArray(params) || !valoresPorTipo) return params;
  return params.map((p) => {
    const lista = p?.tipo ? valoresPorTipo[p.tipo] : null;
    if (!lista?.length) return p;
    const opcoes = Array.isArray(p.opcoes) ? [...p.opcoes] : [];
    for (const v of lista) {
      if (!opcoes.some((o) => String(o?.valor) === String(v.valor))) opcoes.push({ valor: v.valor, descricao: v.rotulo, fonte: 'resultado-anterior' });
    }
    return { ...p, opcoes };
  });
}

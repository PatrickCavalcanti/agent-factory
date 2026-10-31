// Consultas do turno para o Jev do turno seguinte (`consultasAnteriores`, Melhoria A de 23/09). Até 10/10 só entravam
// as leituras que o PRÓPRIO loop do Jev fez; as do MODELO ficavam de fora, porque nada separava leitura de escrita
// nelas. Agora (dono, 10/10) entram também as do modelo, filtradas pelo `effect` de cada função no catálogo do turno:
// só `read`. O nome é normalizado para o nome EXPOSTO — é por ele que o espaço do loop chama a função — a partir das
// três formas que o modelo pode usar: o exposto (`cap__fn`), o sinônimo cru e a ref interna (`cap/tool/fn`, pela
// meta-tool `call_capability`).

/** @param {Array<{id:string, prefixarTools?:boolean, aliasCru?:boolean, tools?:Array<{name:string, effect?:string}>}>} capacidades */
export function mapaDeFuncoesDoTurno(capacidades) {
  const porNome = new Map();
  const crus = new Map();
  for (const cap of capacidades || []) {
    for (const t of cap.tools || []) {
      if (!t?.name) continue;
      const exposto = cap.prefixarTools === false ? t.name : `${cap.id}__${t.name}`;
      const info = { exposto, effect: t.effect || 'write' };
      porNome.set(exposto, info);
      porNome.set(`${cap.id}/tool/${t.name}`, info);
      if (cap.aliasCru === true && exposto !== t.name) crus.set(t.name, crus.has(t.name) ? null : info); // cru repetido = ambíguo
    }
  }
  for (const [cru, info] of crus) if (info && !porNome.has(cru)) porNome.set(cru, info);
  return porNome;
}

/**
 * @param {Array<{nome?:string, args?:object, ok?:boolean, origem?:string}>} operacoes `saida.operacoes` do orquestrador
 * @param {Map<string,{exposto:string, effect:string}>} mapa `mapaDeFuncoesDoTurno(capacidades)`
 * @returns {Array<{funcao:string, args:object, ok:boolean}>}
 */
export function consultasDoTurnoDe(operacoes, mapa) {
  const saida = [];
  for (const o of operacoes || []) {
    if (!o || typeof o.nome !== 'string') continue;
    const args = o.args && typeof o.args === 'object' ? o.args : {};
    if (o.origem === 'jev') { saida.push({ funcao: o.nome, args, ok: o.ok !== false }); continue; } // o loop só lê
    const info = mapa?.get(o.nome);
    if (!info || info.effect !== 'read') continue; // escrita, meta-tool ou desconhecida: fora
    saida.push({ funcao: info.exposto, args, ok: o.ok !== false });
  }
  return saida;
}

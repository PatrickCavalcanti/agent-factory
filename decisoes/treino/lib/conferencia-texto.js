// Texto do relatório de conferência (o que o `conferencia.mjs` imprime antes do JSON). Puro, sem imports: recebe o resumo de
// `resumirConferencia` e devolve linhas legíveis. Coisas que o dono precisa ver de relance e que o JSON esconde:
//  1. `trouxeUsado` do provider separado em "já ativa" (já estava ativa no início do turno: o local não decidiu nada, é 100% por definição e NÃO
//     mede a seleção) × "precisou entrar" (usadas − ativasNoInicio: o que a seleção de fato decide). `n/d` = sem `ativasNoInicio` array.
//  2. Se o `efeito` de cada versão é COMPARÁVEL: as janelas antes × depois foram gravadas pela mesma regra (carimbo `regra` do caso)?
//  3. A carga à toa em DUAS linhas: a NOVA (o que o local pôs em `full` PELA NOTA e não foi usado; `n/d` onde não dá para separar) e o TOTAL
//     (inclui também o que já estava ativo, as funções fixas e o que o motor segura em `full` independente da nota — a proposta `full` do kairos num
//     anel que não rebaixa, a carregada que nunca cai —, que o corte não muda). Ajustar o corte pelo total é ajustar pelo que o local não decidiu.
//     No tool a nova é `n/d` em caso gravado sem a marca do motor (`doMotor`).
//     A nova só é "a que o corte muda" no PROVIDER. No TOOL a linha se chama "trazida pela nota e não usada", sem a seta, e leva um aviso: o teto
//     de vagas de `full` (4) costuma estar cheio, e então subir o corte TROCA a função que ocupa a vaga (uma proposta `full` do kairos que a nota tinha
//     deslocado volta) em vez de tirar carga — no registro real a queda da carga à toa do tool com o corte máximo foi 0 nos turnos medidos (08/10). O efeito real do corte
//     no tool exige o contrafactual na origem (pendência; não medido): não se decide o corte por essa linha.
//  4. "Jev melhor" com a contagem de turnos com e sem sombra do Jev: sem sombra o juiz não estava lá, e esses turnos não entram na porcentagem
//     (aviso quando houve).
//  5. O lote do anel está ADIADO por quê, lido do `estado.json`: quantos casos de avaliação há (e o mínimo) e com quantos válidos o lote tenta
//     de novo — a próxima TENTATIVA, não o dia em que o lote roda. Só o adiamento por falta de casos de avaliação tem "próxima tentativa"; o
//     `sem-base` espera o treino completo e o `sem-piso` espera o registry de powers (nenhum dos dois é liberado por válidos: sem "já pode").

const pct = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : `${Math.round(x * 100)}%`);
const num = (x, casas = 2) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : x.toFixed(casas).replace('.', ','));
const pp = (x) => (x === null || x === undefined || !Number.isFinite(x) ? 'n/d' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)} pp`);
const pad = (t, n) => String(t).padEnd(n);
const campo = (nome, valor) => `   ${nome} ${'.'.repeat(Math.max(2, 30 - nome.length))} ${valor}`; // "   rótulo ........ valor", valor na mesma coluna das linhas fixas
const carimbos = (m) => Object.entries(m || {}).map(([k, n]) => `${k}×${n}`).join(', ') || '—';

// Adiamentos que NÃO têm "próxima tentativa" por válidos: o lote espera outra coisa (o estado guarda `tentativaEm` 0 ou o de um adiamento antigo).
const ESPERA_DO_ADIAMENTO = {
  'sem-base': 'espera o treino completo (cabeça e reposição); os válidos não o liberam',
  'sem-piso': 'espera o registry de powers carregar (piso incondicional); os válidos não o liberam',
};

const MOTIVOS = {
  'sem-carimbo': 'há casos gravados antes do carimbo da regra (regra antiga)',
  'carimbos-diferentes': 'as janelas foram gravadas por regras diferentes',
  'janela-vazia': 'uma das janelas está vazia',
};

function linhasDoAnel(anel, a) {
  const L = [];
  L.push(`== ${anel} — ${a.turnos} turnos`);
  L.push(`   trouxe o que foi usado ........ ${pct(a.trouxeUsado)}`);
  if (anel === 'provider') {
    L.push(`     já ativa no início .......... ${pct(a.trouxeUsadoJaAtiva)}  (${a.casosJaAtiva ?? 0} casos)   ← o local não decidiu: não mede a seleção`);
    L.push(`     precisou entrar ............. ${pct(a.trouxeUsadoPrecisouEntrar)}  (${a.casosPrecisouEntrar ?? 0} casos)   ← o que a seleção decide`);
    L.push(`     n/d (sem ativasNoInicio) .... ${a.casosSemAtivasNoInicio ?? 0} casos com uso`);
  }
  // Carga à toa em duas medidas: a NOVA é o que o local trouxe pela nota e ninguém usou; o TOTAL inclui o que o local não decidiu (já ativas no
  // provider; no tool, as funções fixas e o que o refinador manteve em `full` por regra do motor). No PROVIDER a nova é a que o corte muda (subir o
  // corte só tira). No TOOL não: o teto de vagas de `full` costuma estar cheio e o corte TROCA a função da vaga (C2 da revisão do conjunto) — sem a seta.
  const nNova = a.casosCargaNova ?? 0; const nDado = nNova > 0 && a.turnos > nNova ? ` — ${a.turnos - nNova} turnos n/d` : '';
  if (anel === 'tool') {
    L.push(campo('trazida pela nota e não usada', `${num(a.cargaAToaNovaMedia)} (${nNova} casos${nDado})   ← o local pôs em full pela nota e não usou (fora o que o kairos propôs full e as fixas)`));
    L.push('     ⚠ no tool o teto de vagas pode fazer o corte trocar a função em vez de tirar carga — não decida o corte por esta linha (e o corte vale para os dois anéis)');
    // Casos de antes da marca `doMotor` (carimbo antigo) saem n/d: sem ela a nota não separa o que o motor manteve.
    if (a.turnos > nNova) L.push(`     n/d no tool: caso gravado antes da marca do motor (regra antiga) — sem ela não dá para separar o que o kairos já mantinha em full`);
  } else {
    L.push(campo('carga à toa nova', `${num(a.cargaAToaNovaMedia)} (${nNova} casos${nDado})   ← o local pôs em full pela nota e não usou (fora as ativas no início e a carregada que nunca cai): é esta que o corte muda`));
  }
  L.push(campo('carga à toa total', `${num(a.cargaAToaMedia)}   (inclui o que já estava ativo${anel === 'tool' ? ', as funções fixas e o que o motor manteve em full' : ' e as funções fixas'})`));
  // "Jev melhor" só sobre turnos com uso E com sombra do Jev; sem sombra o juiz não estava lá (não é "o Jev nunca foi melhor").
  const comSombra = a.turnosComUsoComSombra ?? 0; const semSombra = a.turnosComUsoSemSombra ?? 0;
  L.push(campo('Jev melhor', `${pct(a.jevMelhor)}  (${comSombra} turnos com sombra; ${semSombra} sem)`));
  if (semSombra > 0) L.push(`   ⚠ sem sombra do Jev em ${semSombra} turnos com uso — o juiz não estava lá`);
  if (a.adiamento) {
    const d = a.adiamento;
    // "próxima tentativa" não é "o lote roda": o adiamento por avaliação se repete a cada tentativa até haver casos de avaliação suficientes.
    // `sem-base`/`sem-piso` não têm tentativa por válidos (esperam o treino completo / o registry): nada de "próxima tentativa" nem "já pode".
    const espera = ESPERA_DO_ADIAMENTO[d.adiada];
    L.push(d.adiada
      ? `   lote ADIADO ................... ${d.adiada} (${d.validos} válidos; ${espera ?? `próxima tentativa com ${d.tentativaEm} válidos${d.aguardaValidos ? '' : ', já pode'}`}) — não consome casos`
      : `   lote .......................... sem adiamento (${d.validos} válidos no contador${d.falhas ? `, ${d.falhas} falha(s) seguidas` : ''})`);
    if (d.adiada && d.avaliacao) L.push(campo('casos de avaliação', `${d.avaliacao.n ?? 'n/d'} de ${d.avaliacao.minimo} — o lote só roda com o mínimo`));
  }
  const caps = Object.entries(a.porCapacidade || {});
  if (anel === 'provider' && caps.length) {
    L.push('   por capacidade:');
    L.push(`     ${pad('capacidade', 28)}${pad('usos', 6)}${pad('trouxe', 8)}${pad('já ativa', 16)}${pad('precisou entrar', 18)}n/d`);
    for (const [cap, c] of caps) {
      if (!c.usos) continue;
      L.push(`     ${pad(cap, 28)}${pad(c.usos, 6)}${pad(pct(c.trouxeUsado), 8)}${pad(`${pct(c.trouxeUsadoJaAtiva)} (n=${c.usosJaAtiva ?? 0})`, 16)}${pad(`${pct(c.trouxeUsadoPrecisouEntrar)} (n=${c.usosPrecisouEntrar ?? 0})`, 18)}${c.usosSemAtivasNoInicio ?? 0}`);
    }
  }
  if ((a.atualizacoes || []).length) {
    L.push('   versões (efeito = só o que o modelo chamou, depois − antes):');
    for (const u of a.atualizacoes) {
      const ok = u.comparavel === true;
      L.push(`     v${u.versao} ${u.quando}  efeito ${pp(u.efeito)}  ${ok ? 'COMPARÁVEL' : `NÃO COMPARÁVEL (${u.motivoIncomparavel ?? 'sem informação de carimbo'}): ${MOTIVOS[u.motivoIncomparavel] ?? 'carimbo da regra ausente no relatório'}`}`);
      L.push(`        casos por carimbo — antes: ${carimbos(u.carimbos?.antes)} · depois: ${carimbos(u.carimbos?.depois)}`);
      if (anel === 'provider') L.push(`        precisou entrar: antes ${pct(u.antes?.trouxeUsadoPrecisouEntrar)} (n=${u.antes?.casosPrecisouEntrar ?? 0}) → depois ${pct(u.depois?.trouxeUsadoPrecisouEntrar)} (n=${u.depois?.casosPrecisouEntrar ?? 0})`);
    }
  }
  if ((a.rejeitadas || []).length) {
    L.push('   rejeições do portão (a versão em uso continua):');
    for (const r of a.rejeitadas) L.push(`     ${r.quando}  ${r.motivo}${r.mantida ? '  (mantida)' : ''}`);
  }
  return L;
}

/** @param {object} resumo `resumirConferencia(...)` @returns {string} */
export function formatarConferencia(resumo) {
  const L = [`Conferência — ${resumo.turnosValidos} turnos válidos${resumo.desde ? ` desde ${resumo.desde}` : ''}`];
  for (const [anel, a] of Object.entries(resumo.aneis || {})) L.push('', ...linhasDoAnel(anel, a));
  const incomparaveis = Object.values(resumo.aneis || {}).flatMap((a) => a.atualizacoes || []).filter((u) => u.comparavel !== true).length;
  if (incomparaveis) L.push('', `Atenção: ${incomparaveis} atualização(ões) NÃO COMPARÁVEL(is) — o efeito dessas versões mistura a mudança de regra com a da versão; compare só a coluna "precisou entrar" dentro de uma mesma regra.`);
  return L.join('\n');
}

// Extração dos casos de treino a partir dos logs (só leitura) — compartilhada por casos.mjs (linha de comando)
// e pelo treino dentro do app (rota POST /api/decisoes/treinar). Assíncrona de propósito: cede o event loop
// a cada sessão, porque na API roda na mesma thread dos turnos.
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapaDeFuncoes, casoDaInteracao, ehTurnoAutomatico, tsDaPasta, ehFuturo, ehCaminhoDeBancada } from './casos.js';

export const RAIZ_POWERS_PADRAO = resolve(fileURLToPath(new URL('../../../powers/src/powers', import.meta.url)));
const CHAVE_FUNCOES = 'functions'; // conferido no passo zero em google-calendar/power.json
const lerJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const dirs = (p) => (existsSync(p) ? readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()) : []);
const ceder = () => new Promise((r) => setImmediate(r));

// Espelho de POWERS_PISO_NA_FABRICA (packages/powers/src/fabrica/capacidade.js): poderes que são piso na fábrica sem `alwaysLoaded`.
const PISO_NA_FABRICA = ['tela'];

/**
 * ESPELHO do piso INCONDICIONAL, derivado dos manifestos (NÃO é fallback de caminho nenhum de treino: o serviço exige `obterPiso` e o
 * `treinar.mjs` só chama a rota do app; também NÃO serve a `casos.mjs`/`sombra.mjs` — nenhum dos dois o chama; hoje quem o chama é o teste de
 * contrato do executor, que o compara com a derivação de produção): capacidades sempre carregadas no provider
 * (`alwaysLoaded`, mais PISO_NA_FABRICA) e as funções FIXAS delas no tool. A produção (`powers/src/fabrica/capacidade.js`,
 * `fixa: fn.fixa === true`) só fixa a função que o manifesto declara `fixa: true` — o resto da capacidade piso entra por
 * demanda —, então o espelho usa a MESMA regra. Os hosts (executor e a rota do app) NÃO usam este espelho: injetam o piso
 * derivado de `capacidadeDoPower` + `toolEhFixa` (executor/fabrica/piso-incondicional.js), que é a fonte da verdade; um teste
 * de contrato no executor garante que os dois coincidem. Não conhece `foraDaFabrica` (vem do módulo do power, não do manifesto).
 * O piso CONDICIONAL de um turno (`carrega` do agente, sessão de fundo) NÃO entra aqui: ele vive em `caso.piso`, por caso.
 * @returns {{ids:string[], fixas:string[]}}
 */
export function pisoIncondicional({ raizPowers = RAIZ_POWERS_PADRAO } = {}) {
  const ids = []; const fixas = [];
  if (!existsSync(raizPowers)) {
    // Sem a raiz dos powers o piso volta vazio: o treino não exclui NADA (funções sob demanda do piso e o próprio piso entram nos rótulos).
    console.warn(`[treino] pisoIncondicional: a raiz dos powers não existe (${raizPowers}) — nenhum piso será excluído do treino`);
    return { ids, fixas };
  }
  for (const d of dirs(raizPowers)) {
    const m = lerJson(join(raizPowers, d, 'power.json'));
    if (!m?.id || (m.alwaysLoaded !== true && !PISO_NA_FABRICA.includes(m.id))) continue;
    const cap = String(m.id).replace(/_/g, '-');
    ids.push(cap);
    for (const f of m[CHAVE_FUNCOES] || []) if (f?.name && f.fixa === true) fixas.push(`${cap}/tool/${f.name}`);
  }
  return { ids, fixas };
}

/** @returns {Promise<{ok:true, casos:object[], descartadas:number, fora:number, futuros:number, arquivo:string}|{ok:false, motivo:string}>} */
export async function extrairCasos({ dataDir, raizPowers = RAIZ_POWERS_PADRAO, agora = new Date() }) {
  const manifests = dirs(raizPowers).map((d) => lerJson(join(raizPowers, d, 'power.json'))).filter(Boolean);
  const mapa = mapaDeFuncoes(manifests, CHAVE_FUNCOES);
  const raiz = join(dataDir, 'logs', 'sessions');
  if (!existsSync(raiz)) return { ok: false, motivo: `${raiz} não existe` };
  const casos = []; let descartadas = 0; let fora = 0; let futuros = 0;
  for (const mes of dirs(raiz)) for (const sessao of dirs(join(raiz, mes))) {
    await ceder();
    const inter = join(raiz, mes, sessao, 'interactions');
    for (const id of dirs(inter)) {
      if (!/^\d{8}-\d{6}/.test(id)) { fora++; continue; } // pasta que não é interação datada
      const base = join(inter, id);
      const execLog = lerJson(join(base, 'artifacts', 'execution-log.json'));
      if (ehCaminhoDeBancada(join(mes, sessao, id)) || ehTurnoAutomatico(execLog)) { fora++; continue; }
      const ts = tsDaPasta(id);
      if (ehFuturo(ts, agora)) { futuros++; continue; }
      const fabrica = lerJson(join(base, 'artifacts', 'fabrica.json'));
      // A BancadaTeste grava sessões com nome normal: a origem do turno (fabrica.json, desde 10/10) é a marca que vale.
      if (fabrica?.origem && fabrica.origem !== 'chat') { fora++; continue; }
      const c = casoDaInteracao({ id, sessao, ts, execLog, timeline: lerJson(join(base, 'run-timeline.json')), fabrica, mapa });
      if (!c) continue;
      descartadas += c.descartadas.length;
      casos.push(c);
    }
  }
  const saida = join(dataDir, 'decisoes', 'casos');
  mkdirSync(saida, { recursive: true });
  const arquivo = join(saida, 'casos.jsonl');
  writeFileSync(`${arquivo}.tmp`, casos.map((c) => JSON.stringify(c)).join('\n') + '\n');
  renameSync(`${arquivo}.tmp`, arquivo);
  return { ok: true, casos, descartadas, fora, futuros, arquivo };
}

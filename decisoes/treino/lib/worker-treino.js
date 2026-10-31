// treinarCabeca num worker_thread: o treino é CPU síncrona por segundos e, na thread da API, travaria o
// event loop (turnos, SSE). Mensagem de entrada = argumentos de treinarCabeca (clonáveis: arrays + Set);
// saída = { ok:true, resultado } | { ok:false, erro }.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { treinarCabeca } from '../../src/local/cabeca.js';

if (!isMainThread && parentPort) {
  parentPort.once('message', (args) => {
    try { parentPort.postMessage({ ok: true, resultado: treinarCabeca(args) }); }
    catch (e) { parentPort.postMessage({ ok: false, erro: String(e?.message ?? e) }); }
  });
}

/** Tempo máximo de um treino no worker (o treino completo leva dezenas de segundos; um lote, poucos). */
export const TIMEOUT_TREINO_MS = 10 * 60_000;

/**
 * Mesma assinatura de `treinarCabeca`, mas assíncrona e fora da thread principal.
 * `timeoutMs`: passou disso, o worker é encerrado (`terminate`) e a promessa rejeita com `tempo-esgotado` (quem chamou
 * libera a trava no `finally`). `0`/Infinity desliga.
 */
export function treinarCabecaNoWorker(args, { timeoutMs = TIMEOUT_TREINO_MS } = {}) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url));
    let fim = false; let relogio = null;
    const encerrar = (fn, v) => { if (fim) return; fim = true; if (relogio) clearTimeout(relogio); w.terminate().catch(() => {}); fn(v); };
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) relogio = setTimeout(() => encerrar(reject, new Error(`tempo-esgotado: treino excedeu ${timeoutMs} ms`)), timeoutMs);
    w.once('message', (m) => (m.ok ? encerrar(resolve, m.resultado) : encerrar(reject, new Error(`treino no worker: ${m.erro}`))));
    w.once('error', (e) => encerrar(reject, e));
    w.once('exit', (code) => encerrar(reject, new Error(`worker de treino saiu sem resposta (código ${code})`)));
    w.postMessage(args);
  });
}

// Transporte HTTP com keep-alive para o cliente de decisões.
//
// Por que existe: o uso real é UMA chamada por mensagem do usuário, com dezenas
// de segundos entre elas. O fetch nativo do Node fecha a conexão ociosa em ~4s
// (e mudar isso exige o pacote `undici`), então toda mensagem pagava DNS + TLS
// + roteamento: ~1,3s medidos, contra um teto de 1,5s — as três decisões da
// sessão ba1a6023 estouraram o teto. Com um https.Agent de keep-alive, a
// conexão sobreviveu a 60s parada do lado da OpenRouter (medido: 327ms após 20s
// ociosa, 580ms após 60s, reusando o socket). Só node:https, zero dependências.
//
// O formato devolvido é o mínimo que `cliente.js` consome: { status, ok, text() },
// e abort do `signal` rejeita com AbortError (que o cliente traduz em timeout).
import https from 'node:https';

const URL_AQUECIMENTO = 'https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints';

function erroDeAbort() {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * @param {{ agent?: object, request?: typeof https.request }} [opts]
 * @returns {(url: string, init?: { method?: string, headers?: object, body?: string, signal?: AbortSignal }) => Promise<{ status: number, ok: boolean, text: () => Promise<string> }>}
 */
export function criarFetchKeepAlive({
  agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 4 }),
  request = https.request,
} = {}) {
  return (url, init = {}) => new Promise((resolve, reject) => {
    const { signal } = init;
    if (signal?.aborted) {
      reject(erroDeAbort());
      return;
    }
    const body = init.body ?? '';
    const headers = { ...(init.headers || {}), 'Content-Length': Buffer.byteLength(body) };

    const req = request(url, { method: init.method || 'GET', headers, agent }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const txt = Buffer.concat(partes).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => txt });
      });
    });

    const aoAbortar = () => req.destroy(erroDeAbort());
    signal?.addEventListener('abort', aoAbortar, { once: true });
    const soltar = () => signal?.removeEventListener?.('abort', aoAbortar);
    req.on('error', (err) => { soltar(); reject(err); });
    req.on('close', soltar);
    req.end(body);
  });
}

/**
 * Abre a conexão com a OpenRouter antes da primeira mensagem, para ela não pagar
 * DNS + TLS. Endpoint público, pequeno e sem custo. Nunca lança.
 * @returns {Promise<boolean>} true se respondeu
 */
export function aquecer(fetchImpl, url = URL_AQUECIMENTO) {
  return Promise.resolve()
    .then(() => fetchImpl(url, { method: 'GET' }))
    .then((r) => r.text())
    .then(() => true, () => false);
}

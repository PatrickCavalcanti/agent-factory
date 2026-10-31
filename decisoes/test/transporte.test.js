import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { criarFetchKeepAlive, aquecer } from '../src/transporte.js';

// request falso no formato de https.request(url, opts, cb): devolve um "req" com
// end/destroy e, quando mandado, chama cb com uma "res" que emite data/end.
function requestFalso({ status = 200, corpo = '{"ok":true}', responder = true } = {}) {
  const chamadas = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.corpo = null;
    req.end = (body) => {
      req.corpo = body;
      if (!responder) return;
      const res = new EventEmitter();
      res.statusCode = status;
      queueMicrotask(() => { cb(res); res.emit('data', Buffer.from(corpo)); res.emit('end'); });
    };
    req.destroy = (err) => { queueMicrotask(() => { req.emit('error', err); req.emit('close'); }); };
    chamadas.push({ url, opts, req });
    return req;
  };
  return { request, chamadas };
}

test('devolve status e text() no formato que o cliente consome', async () => {
  const { request } = requestFalso({ status: 200, corpo: '{"answers":{}}' });
  const f = criarFetchKeepAlive({ request, agent: 'AGENTE' });
  const r = await f('https://x/y', { method: 'POST', body: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.equal(await r.text(), '{"answers":{}}');
});

test('usa o agent de keep-alive, calcula Content-Length e repassa headers', async () => {
  const { request, chamadas } = requestFalso();
  const f = criarFetchKeepAlive({ request, agent: 'AGENTE' });
  await f('https://x/y', { method: 'POST', headers: { Authorization: 'Bearer k' }, body: 'olá' });
  const { opts, req } = chamadas[0];
  assert.equal(opts.agent, 'AGENTE');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers.Authorization, 'Bearer k');
  assert.equal(opts.headers['Content-Length'], Buffer.byteLength('olá'));
  assert.equal(req.corpo, 'olá');
});

test('status de erro nao lanca: o cliente decide o que fazer com ele', async () => {
  const { request } = requestFalso({ status: 429, corpo: 'slow down' });
  const f = criarFetchKeepAlive({ request });
  const r = await f('https://x/y', { method: 'POST', body: '' });
  assert.equal(r.status, 429);
  assert.equal(r.ok, false);
});

test('abort do signal rejeita com AbortError — e o que o cliente traduz em timeout', async () => {
  const { request } = requestFalso({ responder: false });
  const f = criarFetchKeepAlive({ request });
  const ctrl = new AbortController();
  const p = f('https://x/y', { method: 'POST', body: '', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (err) => err.name === 'AbortError');
});

test('signal ja abortado rejeita sem abrir requisicao', async () => {
  const { request, chamadas } = requestFalso();
  const f = criarFetchKeepAlive({ request });
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(f('https://x/y', { signal: ctrl.signal }), (err) => err.name === 'AbortError');
  assert.equal(chamadas.length, 0);
});

test('aquecer nunca lanca: devolve true se respondeu, false se falhou', async () => {
  const ok = criarFetchKeepAlive({ request: requestFalso().request });
  assert.equal(await aquecer(ok, 'https://x/y'), true);
  const quebrado = () => Promise.reject(new Error('ECONNREFUSED'));
  assert.equal(await aquecer(quebrado, 'https://x/y'), false);
});

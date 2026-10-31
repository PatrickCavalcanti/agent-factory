import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisoDeDescartadas } from '../src/despejo/aviso.js';
import { alinharKairos, promoverNoKairos } from '../src/despejo/kairos.js';

test('aviso: só o que já foi usado, com teto', () => {
  const descartadas = {
    whatsapp: { tipo: 'capacidade', capId: 'whatsapp', em: 9, usada: true, nomes: ['whatsapp_ler', 'whatsapp_enviar'] },
    midia: { tipo: 'capacidade', capId: 'midia', em: 9, usada: false, nomes: [] },
    'okapp/tool/salvar': { tipo: 'funcao', capId: 'okapp', em: 9, usada: true, nomes: ['okapp_salvar'] },
  };
  const t = avisoDeDescartadas(descartadas, { tetoChars: 1200 });
  assert.match(t, /^<descartadas>/);
  assert.match(t, /whatsapp \(whatsapp_ler, whatsapp_enviar\)/);
  assert.match(t, /okapp \(okapp_salvar\)/);
  assert.doesNotMatch(t, /midia/);
  assert.equal(avisoDeDescartadas({}, { tetoChars: 1200 }), '');
  const curto = avisoDeDescartadas(descartadas, { tetoChars: 60 });
  assert.equal(curto.split('\n').length, 3, 'teto curto: a 1ª linha entra sempre, as seguintes param no teto');
});

test('alinharKairos: tira providers e tools sem mexer no resto do estado', () => {
  const k = { loadedProviders: ['memoria', 'whatsapp', 'okapp'], hydratedTools: ['okapp/tool/listar', 'whatsapp/tool/enviar', 'okapp/tool/salvar'], lastUsedTurn: { okapp: 3 } };
  const r = alinharKairos(k, { providers: ['whatsapp'], refs: ['okapp/tool/salvar'] });
  assert.deepEqual(r.loadedProviders, ['memoria', 'okapp']);
  assert.deepEqual(r.hydratedTools, ['okapp/tool/listar']);
  assert.deepEqual(r.lastUsedTurn, { okapp: 3 });
  assert.equal(alinharKairos(k, { providers: [], refs: [] }), k);
});

test('alinharKairos: o provider que saiu perde a recência (recentUse e lastUsedTurn); o resto fica', () => {
  const k = {
    loadedProviders: ['okapp', 'whatsapp'],
    hydratedTools: [],
    consciousTools: ['whatsapp/tool/enviar'],
    loadedSkills: ['okapp/skill/x'],
    lastUsedTurn: { okapp: 3, whatsapp: 3 },
    recentUse: [{ ref: 'okapp', turn: 3 }, { ref: 'whatsapp', turn: 3 }],
  };
  const r = alinharKairos(k, { providers: ['whatsapp'], refs: [] });
  assert.deepEqual(r.lastUsedTurn, { okapp: 3 });
  assert.deepEqual(r.recentUse, [{ ref: 'okapp', turn: 3 }]);
  assert.deepEqual(r.consciousTools, ['whatsapp/tool/enviar'], 'consciousTools nenhum leitor lê; não se mexe');
  assert.deepEqual(r.loadedSkills, ['okapp/skill/x']);
  // Só tools saindo (provider continua): a recência do provider não muda.
  const soTool = alinharKairos(k, { providers: [], refs: ['okapp/tool/x'] });
  assert.deepEqual(soTool.recentUse, k.recentUse);
  assert.deepEqual(soTool.lastUsedTurn, k.lastUsedTurn);
  // Estado sem os campos (host antigo): não inventa chave.
  const velho = alinharKairos({ loadedProviders: ['a'], hydratedTools: [] }, { providers: ['a'] });
  assert.ok(!('recentUse' in velho) && !('lastUsedTurn' in velho));
});

test('promoverNoKairos: o que foi usado entra no estado (provider e função) e ganha recência; o resto fica', () => {
  const k = { loadedProviders: ['memoria'], hydratedTools: ['memoria/tool/ver'], consciousTools: ['x'], loadedSkills: [], lastUsedTurn: { memoria: 1 }, recentUse: [{ ref: 'memoria', turn: 1 }, { ref: 'whatsapp', turn: 0 }] };
  const r = promoverNoKairos(k, { providers: ['whatsapp', 'whatsapp'], refs: ['whatsapp/tool/exibir', 'memoria/tool/ver'], turno: 4 });
  assert.deepEqual(r.loadedProviders, ['memoria', 'whatsapp']);
  assert.deepEqual(r.hydratedTools, ['memoria/tool/ver', 'whatsapp/tool/exibir']);
  assert.deepEqual(r.lastUsedTurn, { memoria: 1, whatsapp: 4 });
  assert.deepEqual(r.recentUse, [{ ref: 'memoria', turn: 1 }, { ref: 'whatsapp', turn: 4 }], 'uma entrada por provider, a mais nova');
  assert.deepEqual(r.consciousTools, ['x']);
  assert.equal(promoverNoKairos(k, { providers: [], refs: [], turno: 4 }), k);
  const velho = promoverNoKairos({ loadedProviders: [], hydratedTools: [] }, { providers: ['a'], refs: ['a/tool/b'], turno: 1 });
  assert.ok(!('recentUse' in velho) && !('lastUsedTurn' in velho), 'estado sem os campos: não inventa chave');
});

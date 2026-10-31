import { test } from 'node:test';
import assert from 'node:assert/strict';
import { separarCauda, renderizarCauda, nomesDaCauda, herdarCauda, caudaParaOProximo } from '../src/despejo/cauda.js';

const classificar = (ref) => (ref.endsWith('#index') ? 'indice' : ref.endsWith('/instructions') ? 'instrucoes' : ref.endsWith('/card') ? 'card' : /^[^/]+\/tool\/[^/]+$/.test(ref) ? 'contrato' : 'contribuicao');

const entrada = (extra = {}) => ({
  ligado: true,
  classificar,
  indice: [
    { ref: 'memoria/tool/ver#index', nome: 'memoria_ver', providerId: 'memoria', conteudo: 'ver' },
    { ref: 'whatsapp/tool/enviar#index', nome: 'whatsapp_enviar', providerId: 'whatsapp', conteudo: 'enviar msg' },
  ],
  system: [{ ref: 'whatsapp/instructions', content: 'Desc WhatsApp' }, { ref: 'memoria/instructions', content: 'Desc memoria' }],
  turno: [
    { ref: 'whatsapp/tool/enviar', label: 'whatsapp_enviar', content: 'Manual enviar' },
    { ref: 'okapp/tool/listar', label: 'okapp_listar', content: 'Manual listar' },
    { ref: 'okapp/tool/salvar', label: 'okapp_salvar', content: 'Manual salvar' },
    { ref: 'whatsapp/card', content: 'card' },
    { ref: 'conhecimento/sugestao/trechos', content: 'trechos' },
  ],
  piso: new Set(['memoria']),
  carregados: new Set(['okapp']),
  hidratadas: new Set(['okapp/tool/listar']),
  comManual: new Set(),
  exigeSinalForte: new Set(),
  sinalForte: () => false,
  doLoop: new Set(),
  ...extra,
});

test('desligado: tudo passa como está', () => {
  const e = entrada({ ligado: false });
  const s = separarCauda(e);
  assert.equal(s.indice, e.indice);
  assert.equal(s.turno, e.turno);
  assert.equal(s.system, e.system);
  assert.deepEqual(s.cauda, []);
});

test('ligado: capacidade nova e manual não promovido vão para a cauda', () => {
  const s = separarCauda(entrada());
  assert.deepEqual(s.indice.map((i) => i.providerId), ['memoria']);
  assert.deepEqual(s.system.map((b) => b.ref), ['memoria/instructions']);
  assert.deepEqual(s.turno.map((b) => b.ref), ['okapp/tool/listar', 'conhecimento/sugestao/trechos'], 'card de capacidade na cauda sai; contribuição fica');
  assert.deepEqual(s.cauda.map((c) => c.id), ['whatsapp', 'okapp']);
  const wa = s.cauda.find((c) => c.id === 'whatsapp');
  assert.equal(wa.descricao, 'Desc WhatsApp');
  assert.deepEqual(wa.funcoes, [{ ref: 'whatsapp/tool/enviar', nome: 'whatsapp_enviar', indice: 'enviar msg', manual: 'Manual enviar' }]);
  assert.deepEqual(s.cauda.find((c) => c.id === 'okapp').funcoes.map((f) => f.ref), ['okapp/tool/salvar']);
});

test('sinal forte: capacidade que exige e não tem sai da cauda, menos o que veio do loop', () => {
  const s = separarCauda(entrada({ exigeSinalForte: new Set(['whatsapp', 'okapp']), doLoop: new Set(['okapp/tool/salvar']) }));
  assert.deepEqual(s.cauda.map((c) => c.id), ['okapp']);
  assert.deepEqual(s.cortadasPorSinal, ['whatsapp']);
  const comSinal = separarCauda(entrada({ exigeSinalForte: new Set(['whatsapp']), sinalForte: (id) => id === 'whatsapp' }));
  assert.ok(comSinal.cauda.some((c) => c.id === 'whatsapp'));
});

test('render e nomes chamáveis', () => {
  const s = separarCauda(entrada());
  const texto = renderizarCauda(s.cauda, { legenda: 'LEG' });
  assert.match(texto, /^<manuais_do_turno>\nLEG/);
  assert.match(texto, /<capability name="whatsapp">/);
  assert.match(texto, /<function name="whatsapp_enviar">\nManual enviar\n<\/function>/);
  assert.deepEqual([...nomesDaCauda(s.cauda)].sort(), ['okapp_salvar', 'whatsapp_enviar']);
  assert.equal(renderizarCauda([], { legenda: 'LEG' }), '');
});

test('card: capacidade na cauda SEM descrição mantém o card; com descrição ele sai', () => {
  // okapp não tem bloco de instruções no system desta entrada: o card é a única apresentação dela.
  const e = entrada({ turno: [
    { ref: 'okapp/tool/salvar', label: 'okapp_salvar', content: 'Manual salvar' },
    { ref: 'okapp/card', content: 'card okapp' },
    { ref: 'whatsapp/tool/enviar', label: 'whatsapp_enviar', content: 'Manual enviar' },
    { ref: 'whatsapp/card', content: 'card whatsapp' },
  ] });
  const s = separarCauda(e);
  assert.deepEqual(s.turno.map((b) => b.ref), ['okapp/card'], 'whatsapp tem descrição: card sai; okapp não tem: card fica');
});

test('card: cards que o host tirou por "carregada" voltam só para capacidade da cauda sem descrição', () => {
  const e = entrada({
    turno: [{ ref: 'okapp/tool/salvar', label: 'okapp_salvar', content: 'Manual salvar' }],
    carregados: new Set(),
    cardsDeCarregadas: [
      { ref: 'okapp/card', content: 'card okapp' },        // na cauda, sem descrição -> volta
      { ref: 'whatsapp/card', content: 'card whatsapp' },  // na cauda, com descrição -> não volta
      { ref: 'memoria/card', content: 'card memoria' },    // piso, fora da cauda -> não volta
    ],
    indice: [{ ref: 'whatsapp/tool/enviar#index', nome: 'whatsapp_enviar', providerId: 'whatsapp', conteudo: 'enviar msg' }],
  });
  const s = separarCauda(e);
  assert.deepEqual(s.turno.map((b) => b.ref), ['okapp/card']);
  const desligado = separarCauda({ ...e, ligado: false });
  assert.ok(!desligado.turno.some((b) => b.ref.endsWith('/card')), 'desligado nada volta');
});


// ---- cauda herdada (Task 2.5) ----
const capCauda = (id, funcoes, descricao = `Desc ${id}`) => ({ id, descricao, funcoes });
const fn = (ref, manual, nome = ref.split('/')[2]) => ({ ref, nome, indice: nome, ...(manual ? { manual } : {}) });
const systemCom = (capacidades) => ({ capacidades });

test('herdarCauda: soma o manual não usado do turno anterior, sem duplicar o que já está na cauda ou no system', () => {
  const anterior = [
    capCauda('whatsapp', [fn('whatsapp/tool/enviar', 'M enviar'), fn('whatsapp/tool/listar')]), // listar sem manual: não herda
    capCauda('okapp', [fn('okapp/tool/salvar', 'M salvar'), fn('okapp/tool/ler', 'M ler')]),
    capCauda('memoria', [fn('memoria/tool/ver', 'M ver')]),
  ];
  const propria = [capCauda('okapp', [fn('okapp/tool/salvar', 'M salvar novo'), fn('okapp/tool/ler')])];
  const system = systemCom([{ id: 'memoria', funcoes: [{ ref: 'memoria/tool/ver', manual: 'M ver' }] }]);
  const { cauda, herdadas } = herdarCauda({ anterior, propria, system });

  assert.deepEqual(herdadas.sort(), ['okapp/tool/ler', 'whatsapp/tool/enviar']);
  const okapp = cauda.find((c) => c.id === 'okapp');
  assert.equal(okapp.funcoes.find((f) => f.ref === 'okapp/tool/salvar').manual, 'M salvar novo', 'a deste turno vence');
  assert.equal(okapp.funcoes.find((f) => f.ref === 'okapp/tool/ler').manual, 'M ler', 'veio sem manual: recebe o herdado');
  assert.deepEqual(cauda.find((c) => c.id === 'whatsapp').funcoes.map((f) => f.ref), ['whatsapp/tool/enviar']);
  assert.ok(!cauda.some((c) => c.id === 'memoria'), 'já tem manual no system: fica de fora');
  assert.equal(propria[0].funcoes[1].manual, undefined, 'não muta a entrada');
});

test('herdarCauda: capacidade que já está no system não repete a descrição; sem anterior devolve a própria', () => {
  const anterior = [capCauda('okapp', [fn('okapp/tool/salvar', 'M salvar')])];
  const system = systemCom([{ id: 'okapp', funcoes: [{ ref: 'okapp/tool/ler', manual: 'M ler' }] }]);
  const { cauda } = herdarCauda({ anterior, propria: [], system });
  assert.equal(cauda[0].descricao, null);
  const propria = [];
  assert.equal(herdarCauda({ anterior: [], propria, system }).cauda, propria);
});

test('caudaParaOProximo: só manual não usado; o que a capacidade usou sai, o resto fica', () => {
  const propria = [
    capCauda('whatsapp', [fn('whatsapp/tool/enviar', 'M')]),
    capCauda('okapp', [fn('okapp/tool/salvar', 'M'), fn('okapp/tool/ler', 'M'), fn('okapp/tool/x')]),
  ];
  const r = caudaParaOProximo({ propria, usadasRefs: new Set(['whatsapp/tool/enviar', 'okapp/tool/ler']) });
  assert.deepEqual(r.map((c) => [c.id, c.funcoes.map((f) => f.ref)]), [['okapp', ['okapp/tool/salvar']]]);
});

test('sobe junto: fixa/acompanhante de capacidade carregada vai para o system; de capacidade só na cauda, não', () => {
  // `okapp` está carregada (`carregados`); `whatsapp` não. As duas têm a ref no `sobeJunto` — só a de okapp é promovida.
  const sobeJunto = new Set(['okapp/tool/salvar', 'whatsapp/tool/enviar']);
  const s = separarCauda(entrada({ sobeJunto }));
  assert.ok(s.turno.some((b) => b.ref === 'okapp/tool/salvar'), 'okapp carregada: a fixa sobe junto');
  assert.deepEqual(s.cauda.find((c) => c.id === 'okapp'), undefined, 'nada de okapp na cauda');
  assert.ok(!s.turno.some((b) => b.ref === 'whatsapp/tool/enviar'), 'whatsapp não está no system: fica na cauda');
  assert.ok(s.cauda.find((c) => c.id === 'whatsapp').funcoes.some((f) => f.ref === 'whatsapp/tool/enviar'));
  // Sem o sobeJunto (campo ausente), `salvar` continua na cauda como antes.
  assert.ok(separarCauda(entrada()).cauda.find((c) => c.id === 'okapp').funcoes.some((f) => f.ref === 'okapp/tool/salvar'));
});

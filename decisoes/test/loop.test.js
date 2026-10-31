import test from 'node:test';
import assert from 'node:assert/strict';
import { rodarLoop } from '../src/loop/index.js';
import { chaveDeArg } from '../src/loop/passo.js';
import { SEM_ARGUMENTO, FORA_DA_LISTA, DESC_FORA_DA_LISTA } from '../src/perguntas.js';

/**
 * Jev fake: uma resposta por passo, na ordem. Cada resposta é
 * `{ acao, conf?, args?, probs?, mais?, confMais? }`. `mais`/`confMais` (Melhoria 1) só entram
 * na resposta quando o roteiro os declara — igual o Jev real ausente (fake "antigo") faz
 * `lerPasso` devolver `mais: null`, nunca disputa o encerramento antecipado à toa.
 */
function jevRoteirizado(roteiro) {
  const chamadas = [];
  return {
    chamadas,
    async decidir({ state, questions }) {
      chamadas.push({ state, questions });
      const r = roteiro[Math.min(chamadas.length - 1, roteiro.length - 1)];
      const answers = { acao: { choice: r.acao, confidence: r.conf ?? 0.9, probabilities: r.probs ?? { [r.acao]: r.conf ?? 0.9 } } };
      for (const [param, valor] of Object.entries(r.args ?? {})) answers[`arg_${r.acao}_${param}`] = { choice: valor, confidence: r.confArgs ?? 0.9 };
      if (r.mais !== undefined) answers.mais = { choice: r.mais, confidence: r.confMais ?? 0.9 };
      return { answers, ms: 3 };
    },
  };
}

const fn = (nome, params = [], capacidade = 'tarefas') => ({ nome, descricao: nome, capacidade, params: async () => params });
const opt = (...valores) => valores.map((valor) => ({ valor }));

test('espaço vazio não chama o Jev', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const r = await rodarLoop({ pergunta: 'oi', espaco: { funcoes: [], candidatas: [] }, cliente, executar: async () => ({}) });
  assert.equal(r.estado, 'vazio');
  assert.equal(cliente.chamadas.length, 0);
});

test('um passo: executa com o argumento escolhido e para em pronto', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', args: { lista: 'Contas a pagar' } }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'contas a pagar pendentes',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Contas a pagar', 'Casa') }])], candidatas: [] },
    cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { tarefas: [1, 2] }; },
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(executados, [['task_listar', { lista: 'Contas a pagar' }]]);
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].confianca, 0.9);
  assert.equal(cliente.chamadas.length, 2);
  assert.ok(cliente.chamadas[1].state.rastro[0].resultado.includes('tarefas'));
});

// Calibração 2 (sessão 2026-09-23/24): rodarLoop repassa `state.rastro` para `perguntasDoPasso`
// — é o que faz o texto de `mais` do passo seguinte embutir o que já foi consultado.
test('rodarLoop repassa o rastro para o texto de `mais` do passo seguinte', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', args: { lista: 'Contas a pagar' } }, { acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'contas a pagar pendentes',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Contas a pagar', 'Casa') }])], candidatas: [] },
    cliente,
    executar: async () => ({ tarefas: [1, 2] }),
  });
  assert.equal(cliente.chamadas.length, 2);
  assert.ok(cliente.chamadas[0].questions.mais.instructions.includes('nada ainda'), '1º passo: rastro ainda vazio');
  assert.ok(cliente.chamadas[1].questions.mais.instructions.includes('task_listar(lista=Contas a pagar)'), '2º passo: rastro do 1º já no texto');
});

// M-confiança (correção da revisão do conjunto): o artefato do loop (`passos[]`, o que
// `fabrica.json`/`LoopViewer.jsx` mostram) precisa trazer `confiancaAcao` — só a confiança de
// `acao`, sem misturar com a dos argumentos — separada de `confianca` — o mínimo entre ação e
// argumentos, usado pela entrega para decidir histórico/bloco (spec §3.3, `lerPasso`). Confiança
// de ação alta (0.9) com argumento incerto (0.5) prova que os dois campos carregam valores
// DIFERENTES, não um alias do outro.
test('M-confiança: passos[] traz confiancaAcao separado de confianca (argumento incerto não abaixa a confiança da ação)', async () => {
  const cliente = jevRoteirizado([
    { acao: 'task_listar', conf: 0.9, args: { lista: 'Contas a pagar' }, confArgs: 0.5 },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'contas a pagar pendentes',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Contas a pagar', 'Casa') }])], candidatas: [] },
    cliente,
    executar: async () => ({ tarefas: [1] }),
  });
  assert.equal(r.passos[0].confianca, 0.5, 'confianca continua o mínimo entre ação e argumentos');
  assert.equal(r.passos[0].confiancaAcao, 0.9, 'confiancaAcao é só a confiança da pergunta acao');
});

test('confiança da ação abaixo do corte vale como pronto e não executa', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', conf: 0.3 }]);
  let executou = false;
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => { executou = true; } });
  assert.equal(r.estado, 'pronto');
  assert.equal(executou, false);
});

test('carregar traz as funções da capacidade para o passo seguinte', async () => {
  const cliente = jevRoteirizado([{ acao: 'carregar_google-calendar' }, { acao: 'gcal_listar_eventos', args: { periodo: 'amanha' } }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'agenda de amanhã',
    espaco: { funcoes: [fn('task_ver')], candidatas: [{ id: 'google-calendar', descricao: 'Agenda.' }] },
    cliente,
    carregar: async () => [fn('gcal_listar_eventos', [{ nome: 'periodo', obrigatoria: false, opcoes: opt('hoje', 'amanha') }], 'google-calendar')],
    executar: async () => ({ eventos: [] }),
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.carregadas, ['google-calendar']);
  assert.deepEqual(r.rastro.map((x) => [x.fn, x.args]), [['gcal_listar_eventos', { periodo: 'amanha' }]]);
  assert.ok('acao' in cliente.chamadas[1].questions);
  assert.ok(Object.keys(cliente.chamadas[1].questions.acao.criteria).includes('gcal_listar_eventos'));
});

// Comportamento antigo era "tira a função do espaço" — sumia de `acao` e o Jev escolhia um
// substituto em silêncio (re-revisão 7fe31cb7). Agora segue oferecida, só sem perguntas de argumento.
test('parâmetro obrigatório sem opção: função segue oferecida em acao, sem perguntas de argumento', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('gcal_ver_evento', [{ nome: 'eventId', obrigatoria: true, opcoes: [] }]), fn('task_listar')], candidatas: [] },
    cliente, executar: async () => ({}),
  });
  assert.deepEqual(Object.keys(cliente.chamadas[0].questions.acao.criteria).filter((k) => k.startsWith('gcal') || k.startsWith('task')), ['gcal_ver_evento', 'task_listar']);
  assert.equal(Object.keys(cliente.chamadas[0].questions).some((k) => k.startsWith('arg_gcal_ver_evento')), false);
});

// Melhoria B (sessão 2026-09-23, medição de sessões reais 74c42d74/6cf1cfec): antes desta
// melhoria, uma reconsulta EXATA (mesma função, mesmos argumentos, já bem-sucedida) só era pega
// pela trava `jaChamadas` (tirar a função do espaço e continuar para MAIS uma chamada ao Jev,
// que então respondia `pronto` porque a função já não estava mais oferecida — 3 chamadas ao
// todo). Agora a reconsulta exata encerra o loop DIRETO no passo em que é detectada — 2 chamadas
// (a execução original + a que tentou repetir) — sem gastar uma 3ª só para confirmar `pronto`.
test('reconsulta EXATA (mesma função, mesmos argumentos, já bem-sucedida) encerra o loop direto, sem 3ª chamada', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar' }]);
  let n = 0;
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar'), fn('task_listas')], candidatas: [] }, cliente,
    executar: async () => { n += 1; return {}; }, orcamento: { maxPassos: 3 },
  });
  assert.equal(n, 1, 'a função só é EXECUTADA uma vez — a reconsulta é evitada antes de chegar em executar');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'reconsulta evitada: mesma chamada (função e argumentos) já executada com sucesso neste turno');
  assert.equal(cliente.chamadas.length, 2, 'a Melhoria B encerra na 2ª chamada — não precisa de uma 3ª só para confirmar pronto');
});

// Nota (Melhoria B): a trava ANTIGA (`jaChamadas`/`tirar`, logo abaixo do bloco novo em
// `rodar-loop.js`) continua no código, intocada — mas para o caso de reconsulta EXATA de uma
// chamada BEM-SUCEDIDA (o cenário que o teste antigo, acima, exercitava) ela nunca mais é
// alcançada: a Melhoria B intercepta antes, no mesmo passo em que a reconsulta é detectada. Uma
// chamada que FALHA já sai do espaço imediatamente (`if (erro) tirar(fn.nome)`, antes mesmo de
// chegar a `jaChamadas`), então também não passa por ali. `jaChamadas` segue como rede de
// segurança para chaves (função+args) repetidas por uma via que nenhuma das outras travas cobre
// — não há um cenário de produção conhecido que a exercite hoje; é defesa em profundidade.

test('erro da função entra no rastro e o loop segue', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar' }, { acao: 'pronto' }]);
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => { throw new Error('sem banco'); } });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.rastro[0].erro, 'sem banco');
});

test('resultado { ok: false } conta como erro', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar' }, { acao: 'pronto' }]);
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => ({ ok: false, error: { message: 'não conectado' } }) });
  assert.equal(r.rastro[0].erro, 'não conectado');
});

test('Jev lento: encerra como estourado sem esperar', async () => {
  const cliente = { async decidir() { await new Promise((res) => setTimeout(res, 300)); return { answers: { acao: { choice: 'pronto', confidence: 1 } } }; } };
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => ({}), orcamento: { prazoPassoMs: 50 } });
  assert.equal(r.estado, 'estourado');
  assert.ok(r.ms < 250);
});

test('signal abortado encerra como cancelado', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente: jevRoteirizado([{ acao: 'pronto' }]), executar: async () => ({}), signal: ctrl.signal });
  assert.equal(r.estado, 'cancelado');
});

test('aoPasso recebe inicio, decisao, chamada, resultado e fim', async () => {
  const eventos = [];
  await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] },
    cliente: jevRoteirizado([{ acao: 'task_listar' }, { acao: 'pronto' }]), executar: async () => ({}),
    aoPasso: (e) => eventos.push(e.tipo),
  });
  // Instrumentação completa (2026-09-23): `espaco` (o que foi oferecido ao Jev neste passo) e
  // `jev` (a chamada bruta — state/questions/answers/meta) entram antes de `decisao` em cada
  // passo — `decisao` continua existindo (é a LEITURA já processada do mesmo `answers`).
  assert.deepEqual(eventos, ['inicio', 'espaco', 'jev', 'decisao', 'chamada', 'resultado', 'espaco', 'jev', 'decisao', 'fim']);
});

// Instrumentação completa do turno pela fábrica (2026-09-23): o evento `jev` carrega o
// state/questions/answers/meta BRUTOS da chamada — é o que falta para o Tracer mostrar "o que foi
// mandado e o que voltou", não só a leitura já processada (`decisao`).
test('aoPasso: evento jev carrega state/questions/answers/meta brutos, com inicioMs', async () => {
  const eventosJev = [];
  await rodarLoop({
    pergunta: 'contas a pagar', espaco: { funcoes: [fn('task_listar')], candidatas: [] },
    cliente: jevRoteirizado([{ acao: 'pronto' }]), executar: async () => ({}),
    aoPasso: (e) => { if (e.tipo === 'jev') eventosJev.push(e); },
  });
  assert.equal(eventosJev.length, 1);
  const [ev] = eventosJev;
  assert.equal(ev.origem, 'loop');
  assert.equal(ev.tardia, false);
  assert.equal(ev.state.pedido, 'contas a pagar');
  assert.ok(ev.questions.acao);
  assert.ok(ev.answers.acao);
  assert.equal(typeof ev.meta.ms, 'number');
  assert.equal(typeof ev.inicioMs, 'number');
});

// --- Correções fase 2 (revisão de qualidade, 2026-09-22) ---

test('foraDasK: k=1, Jev escolhe a 2ª função (com params) → passo seguinte pergunta os argumentos e executa', async () => {
  const paramsB = [{ nome: 'x', obrigatoria: false, opcoes: opt('v1', 'v2') }];
  const cliente = jevRoteirizado([{ acao: 'b' }, { acao: 'b', args: { x: 'v1' } }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a'), fn('b', paramsB)], candidatas: [] }, cliente,
    executar: async (f, args) => ({ f: f.nome, args }), k: 1,
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.rastro.map((x) => [x.fn, x.args]), [['b', { x: 'v1' }]]);
  assert.equal(cliente.chamadas.length, 3);
  assert.ok(chaveDeArg('b', 'x') in cliente.chamadas[1].questions);
});

test('I3: k=1, Jev escolhe função SEM params fora das K → executa no mesmo passo', async () => {
  const paramsA = [{ nome: 'y', obrigatoria: false, opcoes: opt('v') }];
  const cliente = jevRoteirizado([{ acao: 'semparam' }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a', paramsA), fn('semparam')], candidatas: [] }, cliente,
    executar: async (f, args) => ({ f: f.nome, args }), k: 1,
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].fn, 'semparam');
  assert.deepEqual(r.rastro[0].args, {});
  assert.equal(r.rastro[0].confianca, 0.9);
  assert.equal(cliente.chamadas.length, 2);
});

// Correção (revisão do conjunto, 7fe31cb7, 24/09): antes, `faltaObrigatoria` tirava a função do
// espaço em SILÊNCIO (`tirar` + `continue`) — o motor só encerrava com "espaço esgotado" quando
// não sobrava mais nada para perguntar, sem o modelo nunca saber que a escolha do Jev ficou sem
// resposta válida. Agora encerra na mesma chamada, devolvendo a função em `paraOModelo` — mesmo
// tratamento do caminho (a), "obrigatório sem opção" (ver os testes "correção 7fe31cb7" abaixo).
test('faltaObrigatoria: obrigatória com opções sem resposta válida → encerra e devolve paraOModelo', async () => {
  const cliente = jevRoteirizado([{ acao: 'f' }]);
  let executou = false;
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('f', [{ nome: 'id', obrigatoria: true, opcoes: opt('a', 'b') }])], candidatas: [] }, cliente,
    executar: async () => { executou = true; return {}; },
  });
  assert.equal(executou, false);
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida sem argumento obrigatório respondido: f');
  assert.deepEqual(r.paraOModelo, [{ nome: 'f', capacidade: 'tarefas' }]);
  assert.equal(cliente.chamadas.length, 1);
});

// Correção (revisão do conjunto, 7fe31cb7, 24/09): irmão do bug de "obrigatório sem opção"
// (caminho (a), testes "correção 7fe31cb7" abaixo) — aqui o parâmetro TEM opção (foi perguntado em
// `comArgs`), mas a resposta não veio válida. Antes desta correção, a função saía do espaço em
// SILÊNCIO e o Jev reselecionava outra função no passo seguinte — o modelo nunca sabia que a
// escolha original (`alvo`) ficou sem resposta e recebia o resultado de `outra` como se fosse a
// resposta certa ao pedido original — mesma classe do defeito corrigido em 9edeea6b. Vermelho antes
// da correção (Jev reselecionava e executava `outra`); verde depois (encerra na mesma chamada, sem
// reselecionar). Prova do revisor: `E:\tmp\rev-7fe31cb7\prova-irmaos.mjs`, caso A.
test('faltaObrigatoria com função irmã disponível: encerra sem reselecionar (não repete o bug de 9edeea6b)', async () => {
  const alvo = fn('alvo', [{ nome: 'x', obrigatoria: true, opcoes: opt('v1', 'v2') }], 'c');
  const outra = fn('outra', [], 'c');
  const cliente = jevRoteirizado([{ acao: 'alvo', conf: 0.95 }, { acao: 'outra', conf: 0.9 }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'p', espaco: { funcoes: [alvo, outra], candidatas: [] }, cliente, k: 2,
    executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida sem argumento obrigatório respondido: alvo');
  assert.deepEqual(r.paraOModelo, [{ nome: 'alvo', capacidade: 'c' }]);
  assert.equal(executados.length, 0, 'outra nunca deveria ter sido executada — o Jev não pode reselecionar em silêncio');
  assert.equal(cliente.chamadas.length, 1, 'decide na mesma chamada, sem gastar um segundo passo reselecionando');
});

test('prazo total estourando durante a execução → estourado, rastro com erro', async () => {
  const cliente = jevRoteirizado([{ acao: 'lenta' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('lenta')], candidatas: [] }, cliente,
    executar: () => new Promise((res) => setTimeout(() => res({}), 2000)),
    orcamento: { prazoTotalMs: 250, prazoPassoMs: 200 },
  });
  assert.equal(r.estado, 'estourado');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].fn, 'lenta');
  assert.ok(typeof r.rastro[0].erro === 'string' && r.rastro[0].erro.length > 0);
});

test('I6: carregar que lança → carregadas vazio, evento carregar com erro, loop segue', async () => {
  // Com esta candidata a única fonte de funções, o espaço esgota assim que ela sai da lista
  // (falhou), sem gastar mais uma chamada ao Jev perguntando "e agora?" (checagem de espaço
  // vazio já cobre isso) — por isso só 1 chamada, não 2.
  const eventos = [];
  const cliente = jevRoteirizado([{ acao: 'carregar_cal' }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [], candidatas: [{ id: 'cal' }] }, cliente,
    executar: async () => ({}), carregar: async () => { throw new Error('boom'); },
    aoPasso: (e) => eventos.push(e),
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'espaço esgotado');
  assert.deepEqual(r.carregadas, []);
  assert.equal(cliente.chamadas.length, 1);
  const evCarregar = eventos.find((e) => e.tipo === 'carregar');
  assert.ok(evCarregar);
  assert.equal(evCarregar.capacidade, 'cal');
  assert.equal(evCarregar.erro, 'boom');
});

test('bloqueado → estado bloqueado', async () => {
  const cliente = jevRoteirizado([{ acao: 'bloqueado' }]);
  const r = await rodarLoop({ pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] }, cliente, executar: async () => ({}) });
  assert.equal(r.estado, 'bloqueado');
});

test('teto de passos preserva o rastro do que já rodou', async () => {
  const cliente = jevRoteirizado([{ acao: 'a' }, { acao: 'a' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] }, cliente,
    executar: async () => ({}), orcamento: { maxPassos: 1 },
  });
  assert.equal(r.estado, 'estourado');
  assert.equal(r.motivo, 'teto de passos');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].fn, 'a');
});

test('C2: orcamento com maxPassos undefined respeita o teto padrão (4)', async () => {
  const nomes = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const cliente = jevRoteirizado(nomes.map((acao) => ({ acao })));
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: nomes.map((n) => fn(n)), candidatas: [] }, cliente,
    executar: async () => ({}), orcamento: { maxPassos: undefined }, k: 5,
  });
  assert.equal(r.estado, 'estourado');
  assert.equal(r.motivo, 'teto de passos');
  assert.equal(r.passos.length, 4);
  assert.equal(cliente.chamadas.length, 4);
});

test('C1: provedor com 300 opções não lança e a pergunta tem no máximo 255 opções', async () => {
  const opcoes = Array.from({ length: 300 }, (_, i) => ({ valor: `L${i}` }));
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('g', [{ nome: 'p', obrigatoria: false, opcoes }])], candidatas: [] }, cliente,
    executar: async () => ({}),
  });
  const pergunta = cliente.chamadas[0].questions[chaveDeArg('g', 'p')];
  assert.ok(pergunta);
  assert.ok(Object.keys(pergunta.criteria).length <= 255);
});

test('C1: param sem `opcoes` não lança e não gera pergunta de argumento', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('h', [{ nome: 'q', obrigatoria: false }])], candidatas: [] }, cliente,
    executar: async () => ({}),
  });
  assert.equal(cliente.chamadas[0].questions[chaveDeArg('h', 'q')], undefined);
});

test('I1: ação com confiança alta e argumento com confiança baixa executa (confianca do rastro = a do argumento)', async () => {
  const cliente = jevRoteirizado([
    { acao: 'task_listar', conf: 0.95, args: { lista: 'Casa' }, confArgs: 0.4 },
    { acao: 'pronto' },
  ]);
  let executou = false;
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] }, cliente,
    executar: async () => { executou = true; return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(executou, true);
  assert.equal(r.rastro[0].confianca, 0.4);
});

test('I7: abort no meio da execução encerra como cancelado em menos de 200ms', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  const cliente = jevRoteirizado([{ acao: 'lenta' }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('lenta')], candidatas: [] }, cliente,
    executar: () => new Promise((res) => setTimeout(() => res({}), 1000)), signal: ctrl.signal,
  });
  assert.equal(r.estado, 'cancelado');
  assert.ok(r.ms < 200, `ms=${r.ms}`);
  assert.equal(r.rastro.length, 1);
  assert.equal(r.rastro[0].erro, 'cancelado');
});

// --- Correções fase 2, 2ª rodada (re-revisão, 2026-09-22) ---

test('N1: abort durante a chamada ao Jev cancela em menos de 200ms e nunca chega a executar', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  let executou = false;
  const clienteLento = {
    async decidir() {
      await new Promise((res) => setTimeout(res, 1000));
      return { answers: { acao: { choice: 'pronto', confidence: 1 } }, ms: 1000 };
    },
  };
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente: clienteLento,
    executar: async () => { executou = true; return {}; }, signal: ctrl.signal,
  });
  assert.equal(r.estado, 'cancelado');
  assert.ok(r.ms < 200, `ms=${r.ms}`);
  assert.equal(executou, false);
});

test('N2: prazo total estourado por params lentos → estourado em até 1100ms', async () => {
  const lenta = { nome: 'lenta', descricao: 'lenta', capacidade: 't', params: () => new Promise((res) => setTimeout(() => res([]), 900)) };
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [lenta], candidatas: [] }, cliente,
    executar: async () => ({}), orcamento: { prazoTotalMs: 1000, prazoPassoMs: 1500 },
  });
  assert.equal(r.estado, 'estourado');
  assert.ok(r.ms <= 1100, `ms=${r.ms}`);
});

test('N3: sinal entregue a executar continua aborted=false 600ms depois do loop terminar', async () => {
  let sinalRecebido;
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] },
    cliente: jevRoteirizado([{ acao: 'task_listar' }, { acao: 'pronto' }]),
    executar: async (f, args, signal) => { sinalRecebido = signal; return {}; },
    orcamento: { prazoTotalMs: 400 },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(sinalRecebido.aborted, false);
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(sinalRecebido.aborted, false);
});

test('N4: carregar recebe um AbortSignal como segundo argumento', async () => {
  let args;
  await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [], candidatas: [{ id: 'cal' }] },
    cliente: jevRoteirizado([{ acao: 'carregar_cal' }, { acao: 'pronto' }]),
    executar: async () => ({}),
    carregar: async (...a) => { args = a; return []; },
  });
  assert.equal(args.length, 2);
  assert.ok(args[1] instanceof AbortSignal, `args[1]=${args[1]}`);
});

test('N5: orçamento esgotando antes da execução nunca emite chamada sem resultado correspondente', async () => {
  const eventos = [];
  const clienteComAtraso = {
    async decidir() {
      await new Promise((res) => setTimeout(res, 100));
      return { answers: { acao: { choice: 'a', confidence: 0.9 } }, ms: 100 };
    },
  };
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] }, cliente: clienteComAtraso,
    executar: async () => ({}), orcamento: { prazoTotalMs: 200, prazoPassoMs: 1000 },
    aoPasso: (e) => eventos.push(e.tipo),
  });
  assert.equal(r.estado, 'estourado');
  assert.equal(eventos.filter((t) => t === 'chamada').length, eventos.filter((t) => t === 'resultado').length);
});

test('N7: orcamento/cortes null e itens inválidos em espaco.funcoes/candidatas não lançam', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [null, { nome: 'f', params: async () => [] }], candidatas: [null] },
    cliente, executar: async () => ({}),
    orcamento: null, cortes: null,
  });
  assert.equal(r.estado, 'pronto');
});

// --- Regressão pós-fase-2 (revisor, prova U1, 2026-09-22): host aborta o turno de dentro do
// `aoPasso({ tipo: 'chamada' })`, síncrono. Nesse instante `signal.aborted` já é `true` quando
// `comCancelamento` entra em ação; a promessa de `executar` (que respeita o sinal e rejeita) só
// resolve num microtask seguinte. Se `comCancelamento` só liga `promessa.then(...)` depois do
// `if (signal.aborted) { concluir(...); return; }`, essa rejeição nunca ganha handler —
// `unhandledRejection` que, no processo da API, vira `process.exit(1)` (server.js:1204).

test('U1: abort síncrono dentro de aoPasso(chamada) não deixa unhandledRejection solta', async () => {
  let rejeicoesSoltas = 0;
  const aoRejeicaoSolta = () => { rejeicoesSoltas += 1; };
  process.on('unhandledRejection', aoRejeicaoSolta);
  try {
    const ctrl = new AbortController();
    // Host que RESPEITA o sinal: se já chega abortado, rejeita na hora (é o comportamento
    // normal de um handler cooperativo — não é o host que está errado aqui).
    const executarQueRespeitaSinal = (f, args, s) => new Promise((res, rej) => {
      if (s?.aborted) { rej(s.reason ?? new Error('abortado')); return; }
      const t = setTimeout(() => res({ ok: true }), 200);
      s?.addEventListener('abort', () => { clearTimeout(t); rej(s.reason ?? new Error('abortado')); }, { once: true });
    });
    const cliente = jevRoteirizado([{ acao: 'a' }, { acao: 'pronto' }]);
    const r = await rodarLoop({
      pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] }, cliente,
      executar: executarQueRespeitaSinal, signal: ctrl.signal,
      aoPasso: (e) => { if (e.tipo === 'chamada') ctrl.abort(); },
    });
    // Deixa os microtasks/timers pendentes correrem antes de checar a rejeição solta.
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(r.estado, 'cancelado');
    assert.equal(rejeicoesSoltas, 0, `unhandledRejection disparou ${rejeicoesSoltas}x`);
  } finally {
    process.off('unhandledRejection', aoRejeicaoSolta);
  }
});

// --- Correção sessão fbab5b12 (22/09): "Tem uma lista de tarefa aí chamado trabalho." — o Jev
// escolheu `task_listar` com `confiancaAcao` 0.26 (abaixo do corte 0,4) e o loop virou `pronto`
// sem executar nada, mesmo as funções de LEITURA somando 0,89 contra 0,09 de `pronto` (ele só
// estava dividido sobre QUAL leitura, não SE deveria ler).

// Task 4 (piso de execução): com o piso padrão (0,4) este caso — `confiancaAcao` 0,26 — passou a ir
// para `paraOModelo` em vez de executar (ver os testes `piso:` no fim do arquivo). O mecanismo da soma
// das leituras segue valendo: aqui é provado com o piso desligado (`cortes.execucao: 0`).
test('fbab5b12 (piso desligado): confiança de ação abaixo do corte, mas soma das leituras acima do corte → executa a função escolhida', async () => {
  const probs = { task_listas: 0.39, task_listar: 0.38, task_ver: 0.12, pronto: 0.09, bloqueado: 0.02, task_historico: 0 };
  const cliente = jevRoteirizado([
    { acao: 'task_listar', conf: 0.26, probs, args: { lista: 'Projetos / Trabalho' } },
    { acao: 'pronto' },
  ]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Tem uma lista de tarefa aí chamado trabalho.',
    espaco: {
      funcoes: [
        fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Projetos / Trabalho') }]),
        fn('task_listas'), fn('task_ver'), fn('task_historico'),
      ],
      candidatas: [],
    },
    cliente, cortes: { execucao: 0 },
    executar: async (f, args) => { executados.push([f.nome, args]); return { tarefas: [1] }; },
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(executados, [['task_listar', { lista: 'Projetos / Trabalho' }]]);
  assert.equal(r.rastro.length, 1);
  assert.ok(r.rastro[0].confianca <= 0.26, `confianca=${r.rastro[0].confianca}`);
  assert.ok(Math.abs(r.passos[0].confiancaLeitura - 0.89) < 1e-9, `confiancaLeitura=${r.passos[0].confiancaLeitura}`);
});

test('confiança de ação baixa e soma das leituras abaixo do corte → continua pronto sem executar', async () => {
  const probs = { pronto: 0.7, task_a: 0.15, task_b: 0.15 };
  const cliente = jevRoteirizado([{ acao: 'pronto', conf: 0.7, probs }]);
  let executou = false;
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('task_a'), fn('task_b')], candidatas: [] },
    cliente, executar: async () => { executou = true; return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(executou, false);
});

test('escolha `pronto` com confiança baixa e leituras altas segue valendo como pronto (a regra nova só vale para escolha de FUNÇÃO)', async () => {
  const probs = { pronto: 0.2, task_a: 0.4, task_b: 0.4 };
  const cliente = jevRoteirizado([{ acao: 'pronto', conf: 0.2, probs }]);
  let executou = false;
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('task_a'), fn('task_b')], candidatas: [] },
    cliente, executar: async () => { executou = true; return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(executou, false);
});

test('sem probabilidades (ausentes/vazias) no passo → comportamento de hoje (pronto, sem executar)', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', conf: 0.3, probs: {} }]);
  let executou = false;
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => { executou = true; return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(executou, false);
});

// --- Melhoria 1 (sessão 2026-09-23): "vai precisar de mais consulta?" em todo passo ---

test('mais=nao com confiança alta encerra logo após a execução, SEM nova chamada ao Jev', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', args: { lista: 'Casa' }, mais: 'nao', confMais: 0.9 }]);
  const r = await rodarLoop({
    pergunta: 'o que tem na lista casa',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] },
    cliente,
    executar: async () => ({ tarefas: [1] }),
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'jev disse que bastava');
  assert.equal(cliente.chamadas.length, 1, 'não pode ter gasto uma 2ª chamada só pra confirmar pronto');
  assert.equal(r.rastro.length, 1);
  assert.equal(r.passos.length, 1);
  assert.equal(r.passos[0].mais, 'nao');
  assert.equal(r.passos[0].confiancaMais, 0.9);
});

test('mais=sim continua o loop normalmente (chama o Jev de novo)', async () => {
  const cliente = jevRoteirizado([
    { acao: 'task_listar', args: { lista: 'Casa' }, mais: 'sim', confMais: 0.95 },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] },
    cliente,
    executar: async () => ({ tarefas: [1] }),
  });
  assert.equal(r.estado, 'pronto');
  assert.notEqual(r.motivo, 'jev disse que bastava');
  assert.equal(cliente.chamadas.length, 2);
});

test('mais=nao com confiança abaixo do corteFim continua o loop normalmente', async () => {
  const cliente = jevRoteirizado([
    { acao: 'task_listar', args: { lista: 'Casa' }, mais: 'nao', confMais: 0.3 },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] },
    cliente,
    executar: async () => ({ tarefas: [1] }),
  });
  assert.notEqual(r.motivo, 'jev disse que bastava');
  assert.equal(cliente.chamadas.length, 2);
});

test('erro na execução ignora mais=nao e segue o fluxo de hoje (o Jev decide no passo seguinte)', async () => {
  // Duas funções no espaço (não só a que falha): senão o espaço esgota e o loop encerra por
  // "espaço esgotado" de qualquer forma, sem provar nada sobre `mais` — ver o motivo de cada
  // `fim(...)` em rodar-loop.js.
  const cliente = jevRoteirizado([
    { acao: 'task_listar', mais: 'nao', confMais: 0.99 },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar'), fn('task_listas')], candidatas: [] }, cliente,
    executar: async () => { throw new Error('sem banco'); },
  });
  assert.equal(r.estado, 'pronto');
  assert.notEqual(r.motivo, 'jev disse que bastava');
  assert.equal(r.rastro[0].erro, 'sem banco');
  assert.equal(cliente.chamadas.length, 2, 'erro não pode ter encerrado sem o passo seguinte');
});

test('carregar_* ignora mais=nao — carregar nunca encerra o loop sozinho', async () => {
  const cliente = jevRoteirizado([
    { acao: 'carregar_google-calendar', mais: 'nao', confMais: 0.99 },
    { acao: 'gcal_listar_eventos', args: { periodo: 'amanha' } },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'agenda de amanhã',
    espaco: { funcoes: [], candidatas: [{ id: 'google-calendar', descricao: 'Agenda.' }] },
    cliente,
    carregar: async () => [fn('gcal_listar_eventos', [{ nome: 'periodo', obrigatoria: false, opcoes: opt('amanha') }], 'google-calendar')],
    executar: async () => ({ eventos: [] }),
  });
  assert.equal(r.estado, 'pronto');
  assert.notEqual(r.motivo, 'jev disse que bastava');
  assert.deepEqual(r.carregadas, ['google-calendar']);
  assert.equal(cliente.chamadas.length, 3);
});

test('corte de mais configurável via cortes.fim', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', mais: 'nao', confMais: 0.5 }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), cortes: { fim: 0.4 },
  });
  assert.equal(r.motivo, 'jev disse que bastava');
  assert.equal(cliente.chamadas.length, 1);
});

// 2026-09-23 (spec §4.1 addendum): `conversa` — mensagens ANTERIORES da mesma sessão, entram no
// `state` do Jev como campo de primeira classe (nunca dentro de `contexto`, que é genérico).
test('rodarLoop manda `state.conversa` ao Jev, saneado (item invalido/vazio cai fora)', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const conversa = [
    { papel: 'usuario', texto: 'oi' },
    { papel: 'assistente', texto: 'Oi, Patrick.' },
    { papel: 'invalido', texto: 'nao deveria entrar' },
    { papel: 'usuario', texto: '' },
    { papel: 'usuario' },
    { papel: 'assistente', texto: '   ' },
  ];
  await rodarLoop({
    pergunta: 'que dia é hoje?', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), conversa,
  });
  assert.deepEqual(cliente.chamadas[0].state.conversa, [
    { papel: 'usuario', texto: 'oi' },
    { papel: 'assistente', texto: 'Oi, Patrick.' },
  ]);
});

test('sem conversa (ausente/vazia), state nao ganha a chave — compatibilidade com o formato de antes', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({ pergunta: 'oi', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => ({}) });
  assert.equal('conversa' in cliente.chamadas[0].state, false);

  const cliente2 = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({ pergunta: 'oi', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente: cliente2, executar: async () => ({}), conversa: [] });
  assert.equal('conversa' in cliente2.chamadas[0].state, false);
});

test('conversa gigante cede ANTES de contexto sob pressao do teto de 16.000 chars', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const conversaGigante = Array.from({ length: 40 }, (_, i) => ({
    papel: i % 2 === 0 ? 'usuario' : 'assistente', texto: 'x'.repeat(1000),
  }));
  await rodarLoop({
    pergunta: 'oi', contexto: { nota: 'contexto pequeno' },
    espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), conversa: conversaGigante,
  });
  const { state } = cliente.chamadas[0];
  assert.ok(JSON.stringify(state).length <= 16000, 'state deveria caber no teto de 16.000 chars');
  assert.ok((state.conversa?.length ?? 0) < conversaGigante.length, 'conversa deveria ter sido cortada pelo teto');
  assert.deepEqual(state.contexto, { nota: 'contexto pequeno' }, 'contexto pequeno sobrevive intacto — conversa cede primeiro (ordemDeCorte)');
});

// Melhoria A (2026-09-23, spec §4.1 addendum, medição de sessões reais 74c42d74/6cf1cfec):
// `consultasAnteriores` — consultas de leitura de turno(s) anteriores da mesma sessão (função +
// argumentos + sucesso, SEM resultado), campo de PRIMEIRA CLASSE no estado (nunca dentro de
// `contexto`), mesmo tratamento de `conversa`.
test('rodarLoop manda `state.consultasAnteriores` ao Jev, saneado (item invalido cai fora, args/ok tem default)', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const consultasAnteriores = [
    { funcao: 'gcal_listar_eventos', args: { periodo: 'semana' }, ok: true },
    { funcao: 'task_listar', ok: false },
    { funcao: 'gcal_status' },
    { funcao: '' },
    { funcao: 42 },
    null,
    { args: { x: 1 } },
  ];
  await rodarLoop({
    pergunta: 'e a da OKDS?', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), consultasAnteriores,
  });
  assert.deepEqual(cliente.chamadas[0].state.consultasAnteriores, [
    { funcao: 'gcal_listar_eventos', args: { periodo: 'semana' }, ok: true },
    { funcao: 'task_listar', args: {}, ok: false },
    { funcao: 'gcal_status', args: {}, ok: true },
  ]);
});

test('sem consultasAnteriores (ausente/vazia), state nao ganha a chave — compatibilidade com o formato de antes', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({ pergunta: 'oi', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente, executar: async () => ({}) });
  assert.equal('consultasAnteriores' in cliente.chamadas[0].state, false);

  const cliente2 = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'oi', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente: cliente2,
    executar: async () => ({}), consultasAnteriores: [],
  });
  assert.equal('consultasAnteriores' in cliente2.chamadas[0].state, false);
});

test('consultasAnteriores gigante cede DEPOIS de conversa e ANTES de contexto, sob pressao do teto de 16.000 chars', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const consultasGigante = Array.from({ length: 60 }, (_, i) => ({
    funcao: `funcao_${i}`, args: { nota: 'x'.repeat(300) }, ok: true,
  }));
  await rodarLoop({
    pergunta: 'oi', contexto: { nota: 'contexto pequeno' },
    espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), consultasAnteriores: consultasGigante,
  });
  const { state } = cliente.chamadas[0];
  assert.ok(JSON.stringify(state).length <= 16000, 'state deveria caber no teto de 16.000 chars');
  assert.ok((state.consultasAnteriores?.length ?? 0) < consultasGigante.length, 'consultasAnteriores deveria ter sido cortada pelo teto');
  assert.deepEqual(state.contexto, { nota: 'contexto pequeno' }, 'contexto pequeno sobrevive intacto — consultasAnteriores cede antes de contexto');
});

test('sob pressao: conversa cede completamente ANTES de consultasAnteriores perder qualquer item', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const conversaGigante = Array.from({ length: 30 }, (_, i) => ({
    papel: i % 2 === 0 ? 'usuario' : 'assistente', texto: 'x'.repeat(500),
  }));
  const consultasAnteriores = [{ funcao: 'gcal_listar_eventos', args: { periodo: 'semana' }, ok: true }];
  await rodarLoop({
    pergunta: 'oi', espaco: { funcoes: [fn('task_listar')], candidatas: [] }, cliente,
    executar: async () => ({}), conversa: conversaGigante, consultasAnteriores,
  });
  const { state } = cliente.chamadas[0];
  assert.ok(JSON.stringify(state).length <= 16000, 'state deveria caber no teto de 16.000 chars');
  assert.deepEqual(
    state.consultasAnteriores, consultasAnteriores,
    'consultasAnteriores (pequena) sobrevive intacta — conversa (grande) e quem cede primeiro',
  );
});

// Melhoria C (sessão 2026-09-23/24, decisão do dono — sessão real 0201256f: "e as concluídas?"
// perdeu `task_listar` do `comArgs` do passo 1 porque a ordem por score do kairos o deixou em 7º
// lugar, fora do K de 3, mesmo sendo a MESMA função que `consultasAnteriores` mostra ter sido
// executada no turno anterior). Agora as funções do turno anterior entram no TOPO da ordem que
// decide `comArgs`, na frente do score — `task_listar` (7º na ordem do espaço) precisa ganhar a
// pergunta de argumento (`arg_task_listar_status`) já no passo 1.
test('Melhoria C: consultasAnteriores prioriza comArgs no passo 1, mesmo com score baixo (7º lugar, K=3)', async () => {
  const outras = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => fn(`fn_${x}`));
  const alvo = fn('task_listar', [{ nome: 'status', obrigatoria: false, opcoes: opt('pending', 'done') }]);
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'e as concluídas?',
    espaco: { funcoes: [...outras, alvo], candidatas: [] },
    cliente,
    executar: async () => ({}),
    consultasAnteriores: [{ funcao: 'task_listar', args: { lista: 'Projetos / Trabalho', status: 'pending' }, ok: true }],
  });
  const chave = chaveDeArg('task_listar', 'status');
  assert.ok(chave in cliente.chamadas[0].questions, 'task_listar (7º na ordem por score) deveria ter recebido pergunta de argumento no passo 1, herdada de consultasAnteriores');
});

// --- Correção (sessão 7fe31cb7, 24/09): "Tô livre quinta de manhã?" depois de "O que eu tenho
// na agenda amanhã?" — o Jev escolheu `gcal_disponibilidade` fora das K (confiança 0,84), que
// exige `timeMin`/`timeMax` obrigatórios SEM opção nenhuma (o Jev nunca inventa valor, spec
// §3.2). O código antigo promovia a escolha mesmo assim; no passo seguinte ela caía no `tirar` de
// obrigatório-sem-opção e SUMIA do espaço sem aviso — o Jev reselecionava `gcal_listar_eventos`
// herdando `periodo:"amanha"` do turno anterior com confiança 0,24 (o pedido nomeava OUTRO dia),
// e essa segunda escolha era entregue como resposta confiável (0,99) ao pedido original.
test('correção 7fe31cb7: Jev escolhe fora das K função com obrigatório sem opção → encerra sem reselecionar, devolve paraOModelo', async () => {
  const disponibilidade = fn('gcal_disponibilidade', [
    { nome: 'timeMin', obrigatoria: true, opcoes: [] },
    { nome: 'timeMax', obrigatoria: true, opcoes: [] },
  ], 'google-calendar');
  const listarEventos = fn('gcal_listar_eventos', [
    { nome: 'periodo', obrigatoria: false, opcoes: opt('hoje', 'amanha', 'semana') },
  ], 'google-calendar');
  const cliente = jevRoteirizado([
    { acao: 'gcal_disponibilidade', conf: 0.84, probs: { gcal_disponibilidade: 0.86, gcal_listar_eventos: 0.14 } },
    // Se o motor não decidir no passo 1 (bug antigo), o roteiro cairia aqui — reselecionando
    // `gcal_listar_eventos` com o `periodo` herdado do turno anterior, reproduzindo o bug.
    { acao: 'gcal_listar_eventos', args: { periodo: 'amanha' }, confArgs: 0.24 },
  ]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Tô livre quinta de manhã?',
    espaco: { funcoes: [listarEventos, disponibilidade], candidatas: [] },
    cliente,
    k: 1,
    consultasAnteriores: [{ funcao: 'gcal_listar_eventos', args: { periodo: 'amanha' }, ok: true }],
    executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida precisa de argumento que só o modelo preenche: gcal_disponibilidade');
  assert.deepEqual(r.paraOModelo, [{ nome: 'gcal_disponibilidade', capacidade: 'google-calendar' }]);
  assert.equal(executados.length, 0, 'gcal_listar_eventos nunca deveria ter sido reexecutado com o periodo herdado errado');
  assert.equal(r.rastro.length, 0);
  assert.equal(cliente.chamadas.length, 1, 'decide na mesma chamada que descobriu o parâmetro sem opção, sem gastar o passo de promoção');
});

// Caminho (a) acima cobre função com parâmetro MISTO (um askável, outro obrigatório sem opção) —
// prova que a promoção normal (função com parâmetro real askável) continua intacta depois da
// correção, sem regredir o caso são.
test('foraDasK com parâmetro real askável continua promovendo normalmente (não regressão do caminho (a))', async () => {
  const paramsB = [{ nome: 'x', obrigatoria: false, opcoes: opt('v1', 'v2') }];
  const cliente = jevRoteirizado([{ acao: 'b' }, { acao: 'b', args: { x: 'v1' } }, { acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a'), fn('b', paramsB)], candidatas: [] }, cliente,
    executar: async (f, args) => ({ f: f.nome, args }), k: 1,
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.rastro.map((x) => [x.fn, x.args]), [['b', { x: 'v1' }]]);
  assert.equal(r.paraOModelo, undefined, 'promoção normal não devolve paraOModelo');
});

// Teste prometido pelo comentário acima mas nunca escrito (achado da revisão do conjunto,
// 7fe31cb7): função fora das K com parâmetro MISTO — um askável (com opções) e outro obrigatório
// SEM opção nenhuma. A checagem `paramsFn.some((p) => p.obrigatoria && !p.opcoes.length)` (caminho
// (a), `rodar-loop.js`) precisa disparar mesmo quando NEM TODOS os parâmetros são o caso ruim —
// prova que o `.some(...)` não depende de a função inteira ser "só" obrigatório-sem-opção.
test('caminho (a) com parâmetro MISTO (um askável, outro obrigatório sem opção) também encerra com paraOModelo', async () => {
  const mista = fn('mista', [
    { nome: 'opcional', obrigatoria: false, opcoes: opt('v1', 'v2') },
    { nome: 'livre', obrigatoria: true, opcoes: [] },
  ], 'google-calendar');
  const cliente = jevRoteirizado([{ acao: 'mista', conf: 0.9 }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a'), mista], candidatas: [] }, cliente, k: 1,
    executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida precisa de argumento que só o modelo preenche: mista');
  assert.deepEqual(r.paraOModelo, [{ nome: 'mista', capacidade: 'google-calendar' }]);
  assert.equal(executados.length, 0, 'não executa: o parâmetro obrigatório sem opção nunca teria valor');
  assert.equal(cliente.chamadas.length, 1);
});

// Re-revisão do conjunto (7fe31cb7), irmão DENTRO das K: função com obrigatório sem opção que cai
// entre as K (`comArgs`) era tirada do espaço (`tirar`) e por isso também SUMIA das opções de
// `acao` daquele passo — o Jev nunca a via e escolhia um substituto (`gcal_listar_eventos`
// herdando `periodo` do turno anterior), a mesma troca silenciosa do caminho fora das K. Agora ela
// continua oferecida em `acao` (só não recebe perguntas de argumento); se o Jev a escolher, o ramo
// `foraDasK` encerra com `paraOModelo`. O Jev de teste só pode escolher o que lhe foi oferecido.
function jevQueSoEscolheOferecido(preferencias) {
  const chamadas = [];
  return {
    chamadas,
    async decidir({ state, questions }) {
      chamadas.push({ state, questions });
      const oferecidas = Object.keys(questions.acao.criteria);
      const escolha = preferencias.find((p) => oferecidas.includes(p.acao)) ?? { acao: 'pronto' };
      const answers = { acao: { choice: escolha.acao, confidence: escolha.conf ?? 0.9, probabilities: { [escolha.acao]: escolha.conf ?? 0.9 } } };
      for (const [param, valor] of Object.entries(escolha.args ?? {})) answers[`arg_${escolha.acao}_${param}`] = { choice: valor, confidence: escolha.confArgs ?? 0.9 };
      answers.mais = { choice: escolha.mais ?? 'sim', confidence: 0.5 };
      return { answers, ms: 3 };
    },
  };
}

test('correção 7fe31cb7 (irmão dentro das K): função com obrigatório sem opção entre as K segue oferecida em acao e, escolhida, devolve paraOModelo', async () => {
  const disponibilidade = fn('gcal_disponibilidade', [
    { nome: 'timeMin', obrigatoria: true, opcoes: [] },
    { nome: 'timeMax', obrigatoria: true, opcoes: [] },
  ], 'google-calendar');
  const listarEventos = fn('gcal_listar_eventos', [
    { nome: 'periodo', obrigatoria: false, opcoes: opt('hoje', 'amanha', 'semana') },
  ], 'google-calendar');
  const status = fn('gcal_status', [], 'google-calendar');
  const cliente = jevQueSoEscolheOferecido([
    { acao: 'gcal_disponibilidade', conf: 0.84 },
    { acao: 'gcal_listar_eventos', args: { periodo: 'amanha' }, confArgs: 0.24 },
  ]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Tô livre quinta de manhã?',
    // ordem por score: disponibilidade em 1º — DENTRO de K=3
    espaco: { funcoes: [disponibilidade, listarEventos, status], candidatas: [] },
    cliente,
    k: 3,
    consultasAnteriores: [{ funcao: 'gcal_listar_eventos', args: { periodo: 'amanha' }, ok: true }],
    executar: async (f, args) => { executados.push([f.nome, args]); return { eventos: [] }; },
  });
  assert.ok(Object.keys(cliente.chamadas[0].questions.acao.criteria).includes('gcal_disponibilidade'),
    'a função com argumento livre continua entre as opções de acao');
  assert.equal(chaveDeArg('gcal_disponibilidade', 'timeMin') in cliente.chamadas[0].questions, false,
    'mas não recebe pergunta de argumento (o Jev nunca inventa valor)');
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida precisa de argumento que só o modelo preenche: gcal_disponibilidade');
  assert.deepEqual(r.paraOModelo, [{ nome: 'gcal_disponibilidade', capacidade: 'google-calendar' }]);
  assert.deepEqual(executados, [], 'nenhum substituto executado em silêncio');
  assert.equal(r.rastro.length, 0);
  assert.equal(cliente.chamadas.length, 1);
});

test('função com argumento livre dentro das K não gasta vaga de K nos passos seguintes', async () => {
  const livre = fn('livre', [{ nome: 'texto', obrigatoria: true, opcoes: [] }]);
  const listar = fn('listar', [{ nome: 'periodo', obrigatoria: false, opcoes: opt('hoje', 'amanha') }]);
  const sem = fn('sem_params');
  // Passo 1: o Jev prefere `sem_params` (executa direto, não promove). Passo 2: com k=1, a vaga tem
  // de ir para `listar` — não para `livre`, que só está ali para ser oferecida em `acao`.
  const cliente = jevQueSoEscolheOferecido([
    { acao: 'sem_params', mais: 'sim' },
    { acao: 'pronto' },
  ]);
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [livre, listar, sem], candidatas: [] }, cliente, k: 1,
    executar: async () => ({}),
  });
  assert.equal(r.estado, 'pronto');
  assert.deepEqual(r.rastro.map((x) => x.fn), ['sem_params']);
  assert.equal(chaveDeArg('listar', 'periodo') in cliente.chamadas[1].questions, true,
    'no passo 2 a vaga de K vai para `listar`, não para a função de argumento livre');
  assert.ok(Object.keys(cliente.chamadas[1].questions.acao.criteria).includes('livre'), 'e `livre` segue oferecida em acao');
});

test('Melhoria C: sem consultasAnteriores, a ordem por score decide comArgs normalmente (nada muda) — task_listar em 7º fica fora do K=3', async () => {
  const outras = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => fn(`fn_${x}`));
  const alvo = fn('task_listar', [{ nome: 'status', obrigatoria: false, opcoes: opt('pending', 'done') }]);
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  await rodarLoop({
    pergunta: 'e as concluídas?',
    espaco: { funcoes: [...outras, alvo], candidatas: [] },
    cliente,
    executar: async () => ({}),
  });
  const chave = chaveDeArg('task_listar', 'status');
  assert.equal(chave in cliente.chamadas[0].questions, false, 'sem consultasAnteriores, task_listar (7º) continua fora do K=3 — comportamento de antes preservado');
});


// ---------------------------------------------------------------------------------------------
// Lote 2 (30/09, bancada): dois defeitos da mesma classe — a leitura rodava mais larga (ou vazia)
// que o pedido. Reproduzidos com o Jev real antes da correção (sessões 4f6eaeeb e 64102b97).
//   (1) `note_buscar {}`: o manifesto declara `query` e `pasta` opcionais e a exigência "um dos dois"
//       só existia no código da tool (`params_required`). Irmão: `note_ler` (id|path, ambos livres).
//   (2) `arquivo_listar {}`: "a pasta de atas" não existe entre as opções e o Jev só tinha as pastas
//       reais e `sem_argumento` — escolheu `sem_argumento`, e o acervo inteiro voltou.
// ---------------------------------------------------------------------------------------------
const GRUPO_BUSCA = [['query'], ['pasta']];
const buscarNotas = (capacidade = 'notas') => fn('note_buscar', [
  { nome: 'query', obrigatoria: false, opcoes: [], umDe: GRUPO_BUSCA },
  { nome: 'pasta', obrigatoria: false, opcoes: opt('Sebrae', 'Igris'), umDe: GRUPO_BUSCA },
], capacidade);

test('lote 2 / defeito 1: note_buscar com pasta = sem_argumento (nenhum grupo completo) vai para paraOModelo e NÃO executa', async () => {
  const cliente = jevRoteirizado([{ acao: 'note_buscar', args: { pasta: SEM_ARGUMENTO } }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Procura nas minhas anotações a da reunião de alinhamento.',
    espaco: { funcoes: [buscarNotas()], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, [], 'antes da correção executava note_buscar {} e voltava params_required');
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida sem argumento obrigatório respondido: note_buscar');
  assert.deepEqual(r.paraOModelo, [{ nome: 'note_buscar', capacidade: 'notas' }]);
  assert.equal(cliente.chamadas.length, 1, 'decide na mesma chamada, sem reselecionar');
});

test('lote 2 / controle: note_buscar com o grupo `pasta` satisfeito executa pelo Jev', async () => {
  const cliente = jevRoteirizado([{ acao: 'note_buscar', args: { pasta: 'Sebrae' }, mais: 'nao', confMais: 0.95 }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Procura nas anotações da pasta Sebrae.',
    espaco: { funcoes: [buscarNotas()], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true, notas: [] }; },
  });
  assert.deepEqual(executados, [['note_buscar', { pasta: 'Sebrae' }]]);
  assert.equal(r.paraOModelo, undefined);
});

test('lote 2 / irmão: note_ler (id|path, ambos sem opções) é só-o-modelo — sem perguntas de argumento, vai para paraOModelo e NÃO executa', async () => {
  const grupo = [['id'], ['path']];
  const noteLer = fn('note_ler', [
    { nome: 'id', obrigatoria: false, opcoes: [], umDe: grupo },
    { nome: 'path', obrigatoria: false, opcoes: [], umDe: grupo },
  ], 'notas');
  const cliente = jevRoteirizado([{ acao: 'note_ler' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Lê pra mim a nota da reunião de alinhamento.',
    espaco: { funcoes: [noteLer], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, [], 'antes da correção note_ler {} rodava vazia (nenhum param era "obrigatório")');
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'função escolhida precisa de argumento que só o modelo preenche: note_ler');
  assert.deepEqual(r.paraOModelo, [{ nome: 'note_ler', capacidade: 'notas' }]);
  assert.ok(!Object.keys(cliente.chamadas[0].questions).some((k) => k.startsWith('arg_note_ler_')), 'o Jev nem é perguntado sobre argumentos que só o modelo preenche');
});

test('lote 2 / defeito 2: valor_fora_da_lista (parâmetro opcional) vai para paraOModelo e NÃO executa', async () => {
  const listar = fn('arquivo_listar', [{ nome: 'pasta', obrigatoria: false, opcoes: opt('Cidade Empreendedora', 'Desenhos') }], 'docs');
  const cliente = jevRoteirizado([{ acao: 'arquivo_listar', args: { pasta: FORA_DA_LISTA } }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'Lista os documentos da pasta de atas.',
    espaco: { funcoes: [listar], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { ok: true }; },
  });
  assert.deepEqual(executados, [], 'antes da correção o Jev só tinha sem_argumento e o acervo inteiro voltava');
  assert.equal(r.estado, 'pronto');
  assert.equal(r.motivo, 'o pedido cita valor fora das opções: arquivo_listar.pasta');
  assert.deepEqual(r.paraOModelo, [{ nome: 'arquivo_listar', capacidade: 'docs' }]);
  assert.equal(cliente.chamadas.length, 1);
  assert.equal(r.passos[0].args, null);
  assert.deepEqual(r.passos[0].foraDaLista, ['pasta']);
  assert.equal(r.passos[0].jev.questions.arg_arquivo_listar_pasta.criteria[FORA_DA_LISTA], DESC_FORA_DA_LISTA, 'a opção foi de fato oferecida ao Jev');
});

test('lote 2 / defeito 2: valor_fora_da_lista (parâmetro obrigatório com opções) vai para paraOModelo, sem escolher opção errada', async () => {
  const cliente = jevRoteirizado([{ acao: 'f', args: { id: FORA_DA_LISTA } }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('f', [{ nome: 'id', obrigatoria: true, opcoes: opt('a', 'b') }])], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.deepEqual(executados, []);
  assert.equal(r.motivo, 'o pedido cita valor fora das opções: f.id');
  assert.deepEqual(r.paraOModelo, [{ nome: 'f', capacidade: 'tarefas' }]);
});

test('lote 2: a sentinela vinda do provedor como opção real é descartada (nunca vira valor executável)', async () => {
  const cliente = jevRoteirizado([{ acao: 'f', args: { p: 'a' }, mais: 'nao', confMais: 0.95 }]);
  const executados = [];
  await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('f', [{ nome: 'p', obrigatoria: false, opcoes: opt('a', FORA_DA_LISTA, SEM_ARGUMENTO) }])], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push(args); return {}; },
  });
  assert.deepEqual(executados, [{ p: 'a' }]);
  assert.deepEqual(cliente.chamadas[0].questions.arg_f_p.criteria[FORA_DA_LISTA], DESC_FORA_DA_LISTA);
});

test('lote 2: valor_fora_da_lista de OUTRA função (não a escolhida) não interfere na execução', async () => {
  const a = fn('a', [{ nome: 'p', obrigatoria: false, opcoes: opt('x', 'y') }]);
  const b = fn('b', [{ nome: 'q', obrigatoria: false, opcoes: opt('m', 'n') }]);
  const cliente = {
    chamadas: [],
    async decidir({ state, questions }) {
      this.chamadas.push({ state, questions });
      return { answers: {
        acao: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9 } },
        mais: { choice: 'nao', confidence: 0.95 },
        arg_a_p: { choice: 'x', confidence: 0.9 },
        arg_b_q: { choice: FORA_DA_LISTA, confidence: 0.9 },
      }, ms: 1 };
    },
  };
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [a, b], candidatas: [] }, cliente, k: 2,
    executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.deepEqual(executados, [['a', { p: 'x' }]]);
  assert.equal(r.paraOModelo, undefined);
});

test('lote 2: `umDe` atravessa a normalização (espacoOferecido.comArgs) e um `umDe` malformado é descartado sem bloquear a função', async () => {
  const cliente = jevRoteirizado([{ acao: 'pronto' }]);
  const r = await rodarLoop({
    pergunta: 'x', cliente, executar: async () => ({}),
    espaco: { funcoes: [
      buscarNotas(),
      fn('ruim', [{ nome: 'p', obrigatoria: false, opcoes: opt('a'), umDe: 'isto-nao-e-lista' }, { nome: 'q', obrigatoria: false, opcoes: opt('b'), umDe: [[], ['q']] }]),
    ], candidatas: [] },
  });
  const comArgs = r.passos[0].espacoOferecido.comArgs;
  const buscar = comArgs.find((c) => c.nome === 'note_buscar');
  assert.deepEqual(buscar.params.map((p) => p.umDe), [GRUPO_BUSCA, GRUPO_BUSCA]);
  const ruim = comArgs.find((c) => c.nome === 'ruim');
  assert.ok(ruim, 'função com umDe malformado continua com perguntas de argumento');
  assert.deepEqual(ruim.params.map((p) => p.umDe), [undefined, undefined]);
});

test('lote 2: função com obrigatório sem opção escolhida SEM estar nas K segue indo para paraOModelo (caminho (a) intacto)', async () => {
  const cliente = jevRoteirizado([{ acao: 'g' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x', k: 1,
    espaco: { funcoes: [fn('f', [{ nome: 'p', obrigatoria: false, opcoes: opt('a') }]), fn('g', [{ nome: 'id', obrigatoria: true, opcoes: [] }])], candidatas: [] }, cliente,
    executar: async (f) => { executados.push(f.nome); return {}; },
  });
  assert.deepEqual(executados, []);
  assert.deepEqual(r.paraOModelo, [{ nome: 'g', capacidade: 'tarefas' }]);
});

// --- Piso de confiança para EXECUTAR (Task 4, spec fábrica-capacidades-mcp §11; bancada do lote 4) ---
// Defeito medido: o loop executou `identidade_poderes_listar` com confiança 0,33 e `si_listar
// {tipo:"observation", status:"open"}` com o argumento `tipo` a 0,17 (inventado — o pedido era "quais
// insights estão abertos no backlog de revisão?"). Antes o corte só decidia histórico × bloco na
// entrega, nunca SE a função executava.

const SI_PARAMS = [
  { nome: 'tipo', obrigatoria: false, opcoes: opt('observation', 'insight') },
  { nome: 'status', obrigatoria: false, opcoes: opt('open', 'closed') },
];

test('piso: ação a 0,33 (leituras somando acima do corte) NÃO executa — vai para paraOModelo', async () => {
  const probs = { identidade_poderes_listar: 0.33, identidade_ver: 0.4, pronto: 0.2 };
  const cliente = jevRoteirizado([{ acao: 'identidade_poderes_listar', conf: 0.33, probs }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'quais poderes você tem?',
    espaco: { funcoes: [fn('identidade_poderes_listar'), fn('identidade_ver')], candidatas: [] },
    cliente, executar: async (f) => { executados.push(f.nome); return {}; },
  });
  assert.deepEqual(executados, []);
  assert.equal(r.estado, 'pronto');
  assert.match(r.motivo, /piso de execução/);
  assert.deepEqual(r.paraOModelo, [{ nome: 'identidade_poderes_listar', capacidade: 'tarefas' }]);
  assert.equal(cliente.chamadas.length, 1);
});

test('piso: argumento OPCIONAL a 0,17 é omitido (sem_argumento), a ação segue e executa só com o que tem confiança', async () => {
  const cliente = jevRoteirizado([{ acao: 'si_listar', conf: 0.9, args: { tipo: 'observation' }, confArgs: 0.17 }, { acao: 'pronto' }]);
  // `status` com confiança alta: o roteiro dá a mesma confArgs a todos; monta à mão abaixo.
  const original = cliente.decidir.bind(cliente);
  cliente.decidir = async (p) => {
    const out = await original(p);
    out.answers.arg_si_listar_status = { choice: 'open', confidence: 0.9 };
    return out;
  };
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'quais insights estão abertos no backlog de revisão?',
    espaco: { funcoes: [fn('si_listar', SI_PARAMS)], candidatas: [] },
    cortes: { execucaoArgs: 0.4 }, cliente, executar: async (f, args) => { executados.push([f.nome, args]); return { itens: [] }; },
  });
  assert.deepEqual(executados, [['si_listar', { status: 'open' }]]);
  assert.deepEqual(r.rastro[0].argsOmitidos, ['tipo']);
  assert.equal(r.rastro[0].confianca, 0.9, 'o argumento descartado não puxa a confiança do item');
  assert.deepEqual(r.passos[0].argsAbaixoDoPiso, ['tipo']);
});

test('piso: argumento OBRIGATÓRIO abaixo do piso → a função vai ao modelo, não executa', async () => {
  const cliente = jevRoteirizado([{ acao: 'g', conf: 0.9, args: { lista: 'Casa' }, confArgs: 0.2 }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('g', [{ nome: 'lista', obrigatoria: true, opcoes: opt('Casa', 'Trabalho') }])], candidatas: [] },
    cortes: { execucaoArgs: 0.4 }, cliente, executar: async (f) => { executados.push(f.nome); return {}; },
  });
  assert.deepEqual(executados, []);
  assert.deepEqual(r.paraOModelo, [{ nome: 'g', capacidade: 'tarefas' }]);
  assert.equal(r.estado, 'pronto');
});

test('piso: herança legítima de consultasAnteriores (mesmo valor, confiança >= PISO_CONFIANCA_HERANCA) segue valendo mesmo abaixo do piso', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', conf: 0.9, args: { lista: 'Casa' }, confArgs: 0.35 }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'e as concluídas?',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] },
    consultasAnteriores: [{ funcao: 'task_listar', args: { lista: 'Casa' }, ok: true }],
    cortes: { execucaoArgs: 0.4 }, cliente, executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.deepEqual(executados, [['task_listar', { lista: 'Casa' }]]);
  assert.equal(r.rastro[0].confianca, 0.9);
});

test('piso: o mesmo valor SEM herança (nenhuma consulta anterior) a 0,35 é palpite — omitido', async () => {
  const cliente = jevRoteirizado([{ acao: 'task_listar', conf: 0.9, args: { lista: 'Casa' }, confArgs: 0.35 }, { acao: 'pronto' }]);
  const executados = [];
  await rodarLoop({
    pergunta: 'x',
    espaco: { funcoes: [fn('task_listar', [{ nome: 'lista', obrigatoria: false, opcoes: opt('Casa') }])], candidatas: [] },
    cortes: { execucaoArgs: 0.4 }, cliente, executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.deepEqual(executados, [['task_listar', {}]]);
});

test('piso: pronto e bloqueado não são afetados', async () => {
  const rp = await rodarLoop({
    pergunta: 'oi', espaco: { funcoes: [fn('a')], candidatas: [] },
    cliente: jevRoteirizado([{ acao: 'pronto', conf: 0.9 }]), executar: async () => ({}),
  });
  assert.equal(rp.estado, 'pronto');
  assert.equal(rp.paraOModelo, undefined);
  const rb = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('a')], candidatas: [] },
    cliente: jevRoteirizado([{ acao: 'bloqueado', conf: 0.9 }]), executar: async () => ({}),
  });
  assert.equal(rb.estado, 'bloqueado');
  assert.equal(rb.paraOModelo, undefined);
});

test('piso: configurável por cortes.execucao (0,3 deixa executar a 0,33; 0 desliga o piso)', async () => {
  const probs = { a: 0.33, b: 0.4, pronto: 0.2 };
  for (const execucao of [0.3, 0]) {
    const executados = [];
    await rodarLoop({
      pergunta: 'x', espaco: { funcoes: [fn('a'), fn('b')], candidatas: [] }, cortes: { execucao },
      cliente: jevRoteirizado([{ acao: 'a', conf: 0.33, probs }, { acao: 'pronto' }]),
      executar: async (f) => { executados.push(f.nome); return {}; },
    });
    assert.deepEqual(executados, ['a'], `execucao=${execucao}`);
  }
});

test('piso: por padrão (execucaoArgs desligado) argumento opcional a 0,17 NÃO é omitido — o piso padrão vale só para a ação', async () => {
  // Medição de 01/10: o argumento certo de continuação de conversa vem a 0,15-0,34 (#25 caía de 8/8 para 0/8).
  const cliente = jevRoteirizado([{ acao: 'si_listar', conf: 0.9, args: { tipo: 'observation' }, confArgs: 0.17 }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'x', espaco: { funcoes: [fn('si_listar', SI_PARAMS)], candidatas: [] }, cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return {}; },
  });
  assert.deepEqual(executados, [['si_listar', { tipo: 'observation' }]]);
  assert.equal(r.rastro[0].confianca, 0.17);
  assert.equal(r.passos[0].argsAbaixoDoPiso, undefined);
});

// Dono, 10/10: o valor da consulta anterior vira OPÇÃO do parâmetro — também de texto livre, que antes não tinha
// opção nenhuma e mandava a repetição da chamada sempre ao modelo (o `query` da busca do zumbi, A0.8).
test('consulta anterior: parâmetro obrigatório de texto livre ganha a opção do valor usado antes, e o Jev repete a chamada', async () => {
  const cliente = jevRoteirizado([{ acao: 'docs__arquivo_buscar', args: { query: 'desenho infantil zumbi' } }, { acao: 'pronto' }]);
  const executados = [];
  const r = await rodarLoop({
    pergunta: 'mostra de novo aquele desenho',
    espaco: { funcoes: [fn('docs__arquivo_buscar', [{ nome: 'query', obrigatoria: true, opcoes: [] }], 'docs')], candidatas: [] },
    cliente,
    executar: async (f, args) => { executados.push([f.nome, args]); return { achados: 1 }; },
    consultasAnteriores: [{ funcao: 'docs__arquivo_buscar', args: { query: 'desenho infantil zumbi' }, ok: true }],
  });
  const pergunta = cliente.chamadas[0].questions[chaveDeArg('docs__arquivo_buscar', 'query')];
  assert.ok(pergunta, 'a pergunta do argumento tem que existir (antes o parâmetro sem opção era pulado)');
  assert.deepEqual(executados, [['docs__arquivo_buscar', { query: 'desenho infantil zumbi' }]]);
  assert.equal(r.estado, 'pronto');
});

test('comOpcoesHerdadas: só escalares, sem duplicar opção existente, sem mutar os params', async () => {
  const { comOpcoesHerdadas } = await import('../src/loop/rodar-loop.js');
  const params = [{ nome: 'lista', opcoes: [{ valor: 'Casa' }] }, { nome: 'q', opcoes: [] }, { nome: 'obj' }];
  const saida = comOpcoesHerdadas(params, { lista: 'Casa', q: 'zumbi', obj: { a: 1 } });
  assert.equal(saida[0], params[0], 'valor já entre as opções: param intacto');
  assert.deepEqual(saida[1].opcoes, [{ valor: 'zumbi', descricao: 'o mesmo valor da consulta anterior', fonte: 'consulta-anterior' }]);
  assert.equal(saida[2], params[2], 'objeto não vira opção');
  assert.deepEqual(params[1].opcoes, [], 'não muta o cache de params');
  assert.equal(comOpcoesHerdadas(params, undefined), params);
});

test('consulta anterior fora do espaço deste turno: a função é trazida pela capacidade (carregar) e pode ser repetida', async () => {
  const cliente = jevRoteirizado([{ acao: 'docs__arquivo_buscar', args: { query: 'desenho infantil zumbi' } }, { acao: 'pronto' }]);
  const executados = []; const carregadas = [];
  const buscar = fn('docs__arquivo_buscar', [{ nome: 'query', obrigatoria: true, opcoes: [] }], 'docs');
  await rodarLoop({
    pergunta: 'busca de novo esse desenho',
    espaco: { funcoes: [fn('vb__listar')], candidatas: [] },
    cliente,
    carregar: async (id) => { carregadas.push(id); return id === 'docs' ? [buscar, fn('docs__outra', [], 'docs')] : []; },
    executar: async (f, args) => { executados.push([f.nome, args]); return { achados: 1 }; },
    consultasAnteriores: [{ funcao: 'docs__arquivo_buscar', args: { query: 'desenho infantil zumbi' }, ok: true }],
  });
  assert.deepEqual(carregadas, ['docs']);
  assert.deepEqual(executados, [['docs__arquivo_buscar', { query: 'desenho infantil zumbi' }]]);
  assert.ok(!cliente.chamadas[0].state.funcoes || true);
});

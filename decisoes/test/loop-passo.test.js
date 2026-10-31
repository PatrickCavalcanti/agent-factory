import test from 'node:test';
import assert from 'node:assert/strict';
import {
  perguntasDoPasso, lerPasso, chaveDeArg, ACAO_PRONTO, ACAO_BLOQUEADO, MAIS_SIM, MAIS_NAO,
  PISO_CONFIANCA_HERANCA, exigeOModelo,
} from '../src/loop/passo.js';
import { SEM_ARGUMENTO, FORA_DA_LISTA, DESC_FORA_DA_LISTA } from '../src/perguntas.js';

const listar = {
  nome: 'task_listar',
  params: [
    { nome: 'lista', obrigatoria: false, opcoes: [{ valor: 'Contas a pagar', descricao: '12 pendentes' }, { valor: 'Casa' }] },
    { nome: 'status', obrigatoria: false, opcoes: [{ valor: 'pending' }, { valor: 'done' }] },
    { nome: 'livre', obrigatoria: false, opcoes: [] },
  ],
};

test('acao é uma escolha única com funções, carregar, pronto e bloqueado', () => {
  const q = perguntasDoPasso({
    funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }],
    candidatas: [{ id: 'google-calendar', descricao: 'Agenda.' }],
    comArgs: [listar],
  });
  assert.equal(q.acao.type, 'choice');
  assert.deepEqual(Object.keys(q.acao.criteria), ['task_listar', 'carregar_google-calendar', ACAO_PRONTO, ACAO_BLOQUEADO]);
  assert.deepEqual(Object.keys(q[chaveDeArg('task_listar', 'lista')].criteria), ['Contas a pagar', 'Casa', 'sem_argumento', 'valor_fora_da_lista']);
  assert.equal(q[chaveDeArg('task_listar', 'lista')].criteria['Contas a pagar'], '12 pendentes');
  assert.equal(q[chaveDeArg('task_listar', 'livre')], undefined);
});

test('função em comArgs ganha sufixo "Valores: ..." com as opções dos params no critério de acao', () => {
  const q = perguntasDoPasso({
    funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }],
    candidatas: [],
    comArgs: [listar],
  });
  assert.ok(q.acao.criteria.task_listar.includes('Valores: lista = Contas a pagar, Casa'));
});

test('função fora de comArgs fica só com a descrição, sem sufixo de valores', () => {
  const q = perguntasDoPasso({
    funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }, { nome: 'task_listas', descricao: 'Lista todas as listas.' }],
    candidatas: [],
    comArgs: [listar],
  });
  assert.equal(q.acao.criteria.task_listas, 'Lista todas as listas.');
  assert.ok(!q.acao.criteria.task_listas.includes('Valores:'));
});

test('valor longo com descrição mostra a descrição, não o valor opaco', () => {
  const comId = {
    nome: 'gcal_ver_evento',
    params: [{ nome: 'calendarId', obrigatoria: false, opcoes: [{ valor: 'abcdefghijklmnopqrstuvwxyz0123456789', descricao: 'Principal' }] }],
  };
  const q = perguntasDoPasso({ funcoes: [{ nome: 'gcal_ver_evento', descricao: 'Vê evento.' }], candidatas: [], comArgs: [comId] });
  assert.ok(q.acao.criteria.gcal_ver_evento.includes('Principal'));
  assert.ok(!q.acao.criteria.gcal_ver_evento.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('sufixo de valores mostra no máximo 12 por param, com reticências se houver mais', () => {
  const muitas = {
    nome: 'f',
    params: [{ nome: 'p', obrigatoria: false, opcoes: Array.from({ length: 15 }, (_, i) => ({ valor: `v${i}` })) }],
  };
  const q = perguntasDoPasso({ funcoes: [{ nome: 'f', descricao: 'F.' }], candidatas: [], comArgs: [muitas] });
  const sufixo = q.acao.criteria.f;
  assert.equal((sufixo.match(/v\d+/g) || []).length, 12);
  assert.ok(sufixo.includes('…'));
});

test('parâmetro obrigatório não oferece sem_argumento (mas oferece valor_fora_da_lista)', () => {
  const q = perguntasDoPasso({ funcoes: [{ nome: 'f' }], candidatas: [], comArgs: [{ nome: 'f', params: [{ nome: 'id', obrigatoria: true, opcoes: [{ valor: 'a' }] }] }] });
  assert.deepEqual(Object.keys(q[chaveDeArg('f', 'id')].criteria), ['a', 'valor_fora_da_lista']);
});

test('respeita o teto de perguntas do núcleo', () => {
  const params = Array.from({ length: 80 }, (_, i) => ({ nome: `p${i}`, obrigatoria: false, opcoes: [{ valor: 'x' }] }));
  const q = perguntasDoPasso({ funcoes: [{ nome: 'f' }], candidatas: [], comArgs: [{ nome: 'f', params }] });
  assert.equal(Object.keys(q).length, 60);
});

// Melhoria 1 (sessão 2026-09-23): `mais` entra em toda chamada, junto de `acao`.
test('mais: pergunta de escolha sim/nao presente em toda chamada, com as 2 perguntas de base contando pro teto', () => {
  const q = perguntasDoPasso({ funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }], candidatas: [], comArgs: [listar] });
  assert.equal(q.mais.type, 'choice');
  assert.deepEqual(Object.keys(q.mais.criteria), [MAIS_SIM, MAIS_NAO]);
});

test('mais: conta como pergunta de base — 80 params param no mesmo teto de 60 de antes', () => {
  const params = Array.from({ length: 80 }, (_, i) => ({ nome: `p${i}`, obrigatoria: false, opcoes: [{ valor: 'x' }] }));
  const q = perguntasDoPasso({ funcoes: [{ nome: 'f' }], candidatas: [], comArgs: [{ nome: 'f', params }] });
  assert.ok('mais' in q);
  assert.equal(Object.keys(q).length, 60);
});

test('lerPasso: função escolhida com argumentos válidos; confiança é o mínimo', () => {
  const answers = {
    acao: { choice: 'task_listar', confidence: 0.9, probabilities: { task_listar: 0.9, pronto: 0.1 } },
    [chaveDeArg('task_listar', 'lista')]: { choice: 'Contas a pagar', confidence: 0.8 },
    [chaveDeArg('task_listar', 'status')]: { choice: 'sem_argumento', confidence: 0.99 },
  };
  const r = lerPasso(answers, { comArgs: [listar] });
  assert.equal(r.acao, 'task_listar');
  assert.deepEqual(r.args, { lista: 'Contas a pagar' });
  assert.deepEqual(r.argsOmitidos, ['status', 'livre']);
  assert.equal(r.confianca, 0.8);
  assert.equal(r.foraDasK, false);
  assert.equal(r.faltaObrigatoria, false);
});

// Uso real 757739e5: "e as concluídas?" herdou a lista da consulta anterior e trocou só o
// status; a confiança do argumento herdado derrubava o item para o bloco de confiança baixa.
test('lerPasso: argumento herdado com o mesmo valor da consulta anterior não entra no mínimo', () => {
  const answers = {
    acao: { choice: 'task_listar', confidence: 1 },
    [chaveDeArg('task_listar', 'lista')]: { choice: 'Contas a pagar', confidence: 0.4 },
    [chaveDeArg('task_listar', 'status')]: { choice: 'done', confidence: 0.9 },
  };
  const herdados = { task_listar: { lista: 'Contas a pagar', status: 'pending' } };
  const r = lerPasso(answers, { comArgs: [listar], herdados });
  assert.deepEqual(r.args, { lista: 'Contas a pagar', status: 'done' });
  assert.equal(r.confianca, 0.9); // a lista herdada (0,4) não conta; o status trocado (0,9) conta
  // Valor diferente do herdado continua contando.
  const outro = lerPasso(answers, { comArgs: [listar], herdados: { task_listar: { lista: 'Casa' } } });
  assert.equal(outro.confianca, 0.4);
  // Herança de OUTRA função não vale.
  const outraFn = lerPasso(answers, { comArgs: [listar], herdados: { task_ver: { lista: 'Contas a pagar' } } });
  assert.equal(outraFn.confianca, 0.4);
});

// Correção (sessão 7fe31cb7, 24/09): "Tô livre quinta de manhã?" (hoje é quinta à noite) depois de
// "O que eu tenho na agenda amanhã?" — o Jev herdou `periodo:"amanha"` com confiança 0,24 (as
// probabilidades reais medidas: amanha 0,35, semana 0,22, sem_argumento 0,21 — o Jev claramente
// incerto), e como o valor batia com a consulta anterior, a herança escondia essa incerteza do
// mínimo — o item saiu do loop com confiança 0,99 (só da ação) e o modelo respondeu sobre o dia
// errado. Valores exatos do artefato real (fabrica.json da sessão).
test('lerPasso: PISO_CONFIANCA_HERANCA — herança com confiança abaixo do piso entra no mínimo normalmente (sessão 7fe31cb7)', () => {
  const gcalListarEventos = {
    nome: 'gcal_listar_eventos',
    params: [{ nome: 'periodo', obrigatoria: false, opcoes: [{ valor: 'amanha' }, { valor: 'semana' }, { valor: 'hoje' }] }],
  };
  const answers = {
    acao: { choice: 'gcal_listar_eventos', confidence: 0.99 },
    [chaveDeArg('gcal_listar_eventos', 'periodo')]: { choice: 'amanha', confidence: 0.24 },
  };
  const herdados = { gcal_listar_eventos: { periodo: 'amanha' } };
  const r = lerPasso(answers, { comArgs: [gcalListarEventos], herdados });
  assert.deepEqual(r.args, { periodo: 'amanha' });
  assert.equal(r.confianca, 0.24, 'abaixo do piso (0,3): a herança não conta, o argumento incerto entra no mínimo');
});

test('lerPasso: PISO_CONFIANCA_HERANCA — herança com confiança acima do piso (0,4) continua fora do mínimo (regressão do 2c52f84c, sessão 757739e5)', () => {
  const r = lerPasso({
    acao: { choice: 'task_listar', confidence: 1 },
    [chaveDeArg('task_listar', 'lista')]: { choice: 'Contas a pagar', confidence: 0.4 },
  }, { comArgs: [listar], herdados: { task_listar: { lista: 'Contas a pagar' } } });
  assert.ok(0.4 >= PISO_CONFIANCA_HERANCA, 'pré-condição: 0,4 (caso legítimo) precisa estar acima do piso');
  assert.equal(r.confianca, 1, 'confianca continua só a da ação — herança acima do piso não entra no mínimo');
});

test('lerPasso: PISO_CONFIANCA_HERANCA — confiança exatamente no piso (>=) ainda conta como herança', () => {
  const r = lerPasso({
    acao: { choice: 'task_listar', confidence: 1 },
    [chaveDeArg('task_listar', 'lista')]: { choice: 'Contas a pagar', confidence: PISO_CONFIANCA_HERANCA },
  }, { comArgs: [listar], herdados: { task_listar: { lista: 'Contas a pagar' } } });
  assert.equal(r.confianca, 1);
});

test('lerPasso: valor fora das opções é tratado como sem resposta', () => {
  const r = lerPasso({ acao: { choice: 'task_listar', confidence: 0.9 }, [chaveDeArg('task_listar', 'lista')]: { choice: 'Inventada', confidence: 0.99 } }, { comArgs: [listar] });
  assert.equal(r.args.lista, undefined);
  assert.ok(r.argsOmitidos.includes('lista'));
});

test('lerPasso: obrigatória sem resposta marca faltaObrigatoria; função fora das K marca foraDasK', () => {
  const f = { nome: 'f', params: [{ nome: 'id', obrigatoria: true, opcoes: [{ valor: 'a' }] }] };
  assert.equal(lerPasso({ acao: { choice: 'f', confidence: 0.9 } }, { comArgs: [f] }).faltaObrigatoria, true);
  const fora = lerPasso({ acao: { choice: 'g', confidence: 0.9 } }, { comArgs: [f] });
  assert.equal(fora.foraDasK, true);
  assert.equal(fora.args, null);
});

// Melhoria 1 (sessão 2026-09-23): `mais`/`confiancaMais` lidos independente de `acao` ter caído
// dentro ou fora das K — é a MESMA chamada que respondeu `acao`.
test('lerPasso: mais/confiancaMais lidos da mesma resposta, dentro e fora das K', () => {
  const dentro = lerPasso({
    acao: { choice: 'task_listar', confidence: 0.9 },
    mais: { choice: MAIS_NAO, confidence: 0.85 },
  }, { comArgs: [listar] });
  assert.equal(dentro.mais, MAIS_NAO);
  assert.equal(dentro.confiancaMais, 0.85);

  const fora = lerPasso({
    acao: { choice: 'g', confidence: 0.9 },
    mais: { choice: MAIS_SIM, confidence: 0.7 },
  }, { comArgs: [{ nome: 'f', params: [] }] });
  assert.equal(fora.mais, MAIS_SIM);
  assert.equal(fora.confiancaMais, 0.7);
});

test('lerPasso: sem resposta de mais (fake antigo) vira null/0, nunca lança', () => {
  const r = lerPasso({ acao: { choice: 'task_listar', confidence: 0.9 } }, { comArgs: [listar] });
  assert.equal(r.mais, null);
  assert.equal(r.confiancaMais, 0);
});

// Calibração 2 (sessão 2026-09-23/24): o texto de `mais` embute o resumo do rastro — a variante
// que passou de "nunca dispara" a economia real contra o Jev real (ver comentário em passo.js).
test('mais: sem rastro, a pergunta diz "nada ainda"', () => {
  const q = perguntasDoPasso({ funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }], candidatas: [], comArgs: [listar] });
  assert.ok(q.mais.instructions.includes('nada ainda'));
});

test('mais: com rastro, a pergunta embute função e argumentos já consultados', () => {
  const q = perguntasDoPasso({
    funcoes: [{ nome: 'task_listar', descricao: 'Lista tarefas.' }],
    candidatas: [],
    comArgs: [listar],
    rastro: [{ funcao: 'gcal_listar_eventos', args: { periodo: 'amanha' } }],
  });
  assert.ok(q.mais.instructions.includes('gcal_listar_eventos(periodo=amanha)'));
  assert.ok(!q.mais.instructions.includes('nada ainda'));
});

test('mais: rastro ausente (chamador antigo, sem o campo) não lança — default []', () => {
  assert.doesNotThrow(() => perguntasDoPasso({ funcoes: [{ nome: 'task_listar', descricao: 'Lista.' }], candidatas: [], comArgs: [listar] }));
});


// Correção (lote 2, 30/09): `valor_fora_da_lista` — o pedido NOMEIA um valor que a lista não tem
// ("a pasta de atas", sem pasta assim). Antes só existia `sem_argumento`: a leitura rodava mais larga
// que o pedido (`arquivo_listar {}` entregou o acervo inteiro) e, no obrigatório, o Jev era forçado a
// escolher uma opção errada.
test('valor_fora_da_lista entra em toda pergunta arg_* com opções, obrigatória ou não, com a descrição fixa', () => {
  const q = perguntasDoPasso({
    funcoes: [{ nome: 'f' }], candidatas: [],
    comArgs: [{ nome: 'f', params: [
      { nome: 'pasta', obrigatoria: false, opcoes: [{ valor: 'a' }] },
      { nome: 'id', obrigatoria: true, opcoes: [{ valor: 'b' }] },
      { nome: 'livre', obrigatoria: false, opcoes: [] },
    ] }],
  });
  assert.equal(q[chaveDeArg('f', 'pasta')].criteria[FORA_DA_LISTA], DESC_FORA_DA_LISTA);
  assert.equal(q[chaveDeArg('f', 'id')].criteria[FORA_DA_LISTA], DESC_FORA_DA_LISTA);
  assert.equal(q[chaveDeArg('f', 'livre')], undefined, 'sem opções não há pergunta — nem sentinela');
});

test('valor_fora_da_lista nunca aparece como valor no sufixo "Valores: ..." nem como opção real', () => {
  const comOpcaoLiteral = { nome: 'f', params: [{ nome: 'p', obrigatoria: false, opcoes: [{ valor: 'a' }, { valor: FORA_DA_LISTA }, { valor: SEM_ARGUMENTO }] }] };
  const q = perguntasDoPasso({ funcoes: [{ nome: 'f', descricao: 'F.' }], candidatas: [], comArgs: [comOpcaoLiteral] });
  assert.ok(q.acao.criteria.f.includes('p = a'));
  assert.ok(!q.acao.criteria.f.includes(FORA_DA_LISTA));
  assert.equal(q[chaveDeArg('f', 'p')].criteria[FORA_DA_LISTA], DESC_FORA_DA_LISTA, 'a descrição da sentinela vence a de uma opção homônima');
});

test('lerPasso: valor_fora_da_lista marca foraDaLista — não é omissão, não é falta, args nulo', () => {
  const f = { nome: 'f', params: [{ nome: 'pasta', obrigatoria: false, opcoes: [{ valor: 'a' }] }, { nome: 'tipo', obrigatoria: false, opcoes: [{ valor: 'x' }] }] };
  const r = lerPasso({
    acao: { choice: 'f', confidence: 0.9 },
    [chaveDeArg('f', 'pasta')]: { choice: FORA_DA_LISTA, confidence: 0.8 },
    [chaveDeArg('f', 'tipo')]: { choice: 'x', confidence: 0.9 },
  }, { comArgs: [f] });
  assert.deepEqual(r.foraDaLista, ['pasta']);
  assert.equal(r.faltaObrigatoria, false);
  assert.deepEqual(r.argsOmitidos, []);
  assert.equal(r.args, null);
});

test('lerPasso: valor_fora_da_lista em parâmetro obrigatório também marca foraDaLista (sem faltaObrigatoria)', () => {
  const f = { nome: 'f', params: [{ nome: 'id', obrigatoria: true, opcoes: [{ valor: 'a' }] }] };
  const r = lerPasso({ acao: { choice: 'f', confidence: 0.9 }, [chaveDeArg('f', 'id')]: { choice: FORA_DA_LISTA, confidence: 0.9 } }, { comArgs: [f] });
  assert.deepEqual(r.foraDaLista, ['id']);
  assert.equal(r.faltaObrigatoria, false);
  assert.equal(r.args, null);
});

test('lerPasso: a sentinela nunca vira valor real, nem quando uma opção tem o mesmo valor', () => {
  const f = { nome: 'f', params: [{ nome: 'p', obrigatoria: false, opcoes: [{ valor: FORA_DA_LISTA }] }] };
  const r = lerPasso({ acao: { choice: 'f', confidence: 0.9 }, [chaveDeArg('f', 'p')]: { choice: FORA_DA_LISTA, confidence: 0.9 } }, { comArgs: [f] });
  assert.deepEqual(r.foraDaLista, ['p']);
  assert.equal(r.args, null, 'nada de args.p = "valor_fora_da_lista"');
});

test('lerPasso: sem foraDaLista o campo vem como array vazio (dentro e fora das K)', () => {
  assert.deepEqual(lerPasso({ acao: { choice: 'task_listar', confidence: 0.9 } }, { comArgs: [listar] }).foraDaLista, []);
  assert.deepEqual(lerPasso({ acao: { choice: 'g', confidence: 0.9 } }, { comArgs: [listar] }).foraDaLista, []);
});

// Correção (lote 2, 30/09): grupos obrigatórios do schema (`umDe`) — `anyOf`/`oneOf` de `required`.
const buscar = () => ({
  nome: 'note_buscar',
  params: [
    { nome: 'query', obrigatoria: false, opcoes: [], umDe: [['query'], ['pasta']] },
    { nome: 'pasta', obrigatoria: false, opcoes: [{ valor: 'Sebrae' }, { valor: 'Igris' }], umDe: [['query'], ['pasta']] },
  ],
});

test('lerPasso umDe: nenhum grupo completo (pasta = sem_argumento, query sem opções) → faltaObrigatoria, args nulo', () => {
  const r = lerPasso({ acao: { choice: 'note_buscar', confidence: 0.9 }, [chaveDeArg('note_buscar', 'pasta')]: { choice: SEM_ARGUMENTO, confidence: 0.9 } }, { comArgs: [buscar()] });
  assert.equal(r.faltaObrigatoria, true);
  assert.equal(r.args, null);
  assert.deepEqual(r.argsOmitidos, ['query', 'pasta']);
});

test('lerPasso umDe: um grupo satisfeito executa normalmente (note_buscar {pasta: "Sebrae"})', () => {
  const r = lerPasso({ acao: { choice: 'note_buscar', confidence: 0.9 }, [chaveDeArg('note_buscar', 'pasta')]: { choice: 'Sebrae', confidence: 0.9 } }, { comArgs: [buscar()] });
  assert.equal(r.faltaObrigatoria, false);
  assert.deepEqual(r.args, { pasta: 'Sebrae' });
});

test('lerPasso umDe: grupo de vários membros só conta completo com todos preenchidos', () => {
  const f = { nome: 'f', params: [
    { nome: 'a', obrigatoria: false, opcoes: [{ valor: '1' }], umDe: [['a', 'b']] },
    { nome: 'b', obrigatoria: false, opcoes: [{ valor: '2' }], umDe: [['a', 'b']] },
  ] };
  const so = lerPasso({ acao: { choice: 'f', confidence: 0.9 }, [chaveDeArg('f', 'a')]: { choice: '1', confidence: 0.9 } }, { comArgs: [f] });
  assert.equal(so.faltaObrigatoria, true, 'só a: o grupo [a, b] não está completo');
  const ambos = lerPasso({ acao: { choice: 'f', confidence: 0.9 }, [chaveDeArg('f', 'a')]: { choice: '1', confidence: 0.9 }, [chaveDeArg('f', 'b')]: { choice: '2', confidence: 0.9 } }, { comArgs: [f] });
  assert.equal(ambos.faltaObrigatoria, false);
  assert.deepEqual(ambos.args, { a: '1', b: '2' });
});

test('lerPasso: função sem umDe não muda (param opcional omitido segue executando)', () => {
  const r = lerPasso({ acao: { choice: 'task_listar', confidence: 0.9 } }, { comArgs: [listar] });
  assert.equal(r.faltaObrigatoria, false);
  assert.deepEqual(r.args, {});
});

test('exigeOModelo: obrigatório sem opção; grupos em que todo grupo tem membro sem opção; grupo que o Jev completa não', () => {
  assert.equal(exigeOModelo([{ nome: 'id', obrigatoria: true, opcoes: [] }]), true);
  assert.equal(exigeOModelo([{ nome: 'id', obrigatoria: true, opcoes: [{ valor: 'a' }] }]), false);
  // note_ler: id | path, ambos livres → só o modelo preenche.
  const grupoLivre = [['id'], ['path']];
  assert.equal(exigeOModelo([
    { nome: 'id', obrigatoria: false, opcoes: [], umDe: grupoLivre },
    { nome: 'path', obrigatoria: false, opcoes: [], umDe: grupoLivre },
  ]), true);
  // note_buscar: query livre | pasta com opções → o grupo `pasta` o Jev completa.
  assert.equal(exigeOModelo(buscar().params), false);
  // grupo de dois membros com um livre não é completável; o outro grupo é.
  assert.equal(exigeOModelo([
    { nome: 'a', obrigatoria: false, opcoes: [{ valor: '1' }], umDe: [['a', 'b'], ['c']] },
    { nome: 'b', obrigatoria: false, opcoes: [], umDe: [['a', 'b'], ['c']] },
    { nome: 'c', obrigatoria: false, opcoes: [{ valor: '3' }], umDe: [['a', 'b'], ['c']] },
  ]), false);
  // grupo que cita propriedade inexistente nunca é completável.
  assert.equal(exigeOModelo([{ nome: 'a', obrigatoria: false, opcoes: [{ valor: '1' }], umDe: [['a', 'fantasma']] }]), true);
  assert.equal(exigeOModelo([]), false);
});

test('intencao_vale: entra quando há intenção e é lido em lerPasso', () => {
  const intencao = [{ funcao: 'conhecimento__kb_no_gravar' }, { funcao: 'conhecimento__kb_no_ler', args: { base: 'principal' } }];
  const q = perguntasDoPasso({ funcoes: [{ nome: 'conhecimento__kb_no_ler' }], candidatas: [], comArgs: [], intencao });
  assert.equal(q.intencao_vale.type, 'noul');
  assert.match(q.intencao_vale.instructions, /kb_no_gravar/);
  const lido = lerPasso({ acao: { choice: 'pronto', confidence: 0.9 }, intencao_vale: { noul: 0.82 } }, { comArgs: [] });
  assert.equal(lido.intencaoVale, 0.82);
});

test('intencao_vale: arg objeto não vira [object Object]; só escalares, cada valor cortado em 60', () => {
  const intencao = [{ funcao: 'a__b', args: { filtro: { x: 1 }, lista: [1, 2], base: 'principal', n: 3, ok: true, longo: 'z'.repeat(200) } }];
  const { instructions } = perguntasDoPasso({ funcoes: [{ nome: 'a__b' }], candidatas: [], comArgs: [], intencao }).intencao_vale;
  assert.doesNotMatch(instructions, /\[object Object\]/);
  assert.doesNotMatch(instructions, /filtro=|lista=/);
  assert.match(instructions, /base=principal, n=3, ok=true, longo=z{59}…[,)]/);
  assert.doesNotMatch(instructions, /z{60}/);
});

test('intencao_vale: lista enorme é cortada em 400 caracteres com reticências', () => {
  const textoDe = (intencao) => perguntasDoPasso({ funcoes: [{ nome: 'a' }], candidatas: [], comArgs: [], intencao }).intencao_vale.instructions;
  const fixo = textoDe([{ funcao: 'x' }]).length - 1;
  const enorme = Array.from({ length: 200 }, (_, n) => ({ funcao: `capacidade__funcao_${n}`, args: { base: 'principal' } }));
  const texto = textoDe(enorme);
  assert.ok(texto.length <= fixo + 400 + 1, `instrução com ${texto.length} chars (limite ${fixo + 401})`);
  assert.match(texto, /…\. O PEDIDO atual/);
});

test('intencao_vale: ausente sem intenção; resposta ausente vira null', () => {
  const q = perguntasDoPasso({ funcoes: [{ nome: 'a' }], candidatas: [], comArgs: [] });
  assert.equal(q.intencao_vale, undefined);
  assert.equal(lerPasso({ acao: { choice: 'pronto', confidence: 0.9 } }, { comArgs: [] }).intencaoVale, null);
});

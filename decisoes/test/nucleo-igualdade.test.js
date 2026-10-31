// Teste de igualdade (Fase 0, Task 0.1, N5): `montarPerguntas` e `montarEstado` têm que
// produzir o MESMO JSON antes e depois da extração do núcleo genérico (perguntar/formas/
// corte de estado para nucleo/). Os literais abaixo foram gravados a partir do código atual
// (pré-refatoração), rodando os três casos representativos do plano: (A) catálogo com
// prefetch+enum+candidatos de aspas, (B) contribuições de power, (C) estado grande que
// força corte. Qualquer mudança de comportamento, inclusive de texto de pergunta
// (byte-idêntico, regra N5), quebra este teste.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { montarPerguntas, aplicarEstrategiasDeCandidatos } from '../src/index.js';
import { montarEstado } from '../src/estado.js';

// --- Caso A: catálogo com prefetch+enum+candidatos de aspas ---------------------------
const catalogoOriginalA = [
  {
    name: 'listar_tarefas', power: 'tarefas', desc: 'Lista tarefas pendentes. Aceita filtro de status.', prefetch: true,
    params: [
      { name: 'status', enum: ['pending', 'done'], enumDescriptions: ['Pendente', 'Concluída'] },
      { name: 'lista', type: 'string' },
    ],
  },
  { name: 'criar_tarefa', power: 'tarefas', desc: 'Cria uma nova tarefa.' },
];
const pedidoA = 'marca a tarefa "Revisar PR" como feita na lista "Trabalho"';

const PERGUNTAS_A = JSON.parse(`{"next_tool":{"type":"choice","instructions":"Você roteia o assistente pessoal Igris. Dado o pedido do usuário, o contexto dos powers e da sessão (o mesmo que o assistente vê), a conversa anterior, as ações já executadas (com resultados) e o que o assistente já disse, qual tool deve ser chamada EM SEGUIDA? Exatamente uma. Consulte antes de agir, honre condições, nunca repita ação já bem-sucedida com os mesmos argumentos. Se o assistente já tem no contexto o que precisa para responder, ou nada do catálogo se aplica, escolha respond_to_user. Ignore a escrita de memória de trabalho (mt_*): não é uma ação pedida pelo usuário.","criteria":{"respond_to_user":"Nenhuma tool é necessária agora: o pedido já está atendido pelas ações executadas, ou se responde com o que já está no contexto. O assistente escreve a resposta final.","listar_tarefas":"Lista tarefas pendentes. (power: tarefas)","criar_tarefa":"Cria uma nova tarefa. (power: tarefas)"}},"pronto":{"type":"noul","instructions":"O assistente já tem, no contexto atual (blocos dos powers, resultados das ações executadas, conversa), tudo o que precisa para responder ao usuário agora, sem chamar mais nenhuma tool.","criteria":{"true":"nada falta buscar: responde com o que já está no contexto","false":"ainda falta executar ou consultar algo para atender o pedido"}},"prefetch_listar_tarefas":{"type":"noul","instructions":"Para atender este pedido do usuário (dado o contexto dos powers, da sessão e a conversa anterior), o assistente vai precisar chamar a tool listar_tarefas — \\"Lista tarefas pendentes.\\" (power tarefas)? Verdadeiro só se essa leitura for necessária ou claramente útil para responder; falso se o pedido não tem relação com ela ou o dado já está no contexto.","criteria":{"true":"a leitura é necessária ou claramente útil para este pedido","false":"não tem relação com o pedido, ou o dado já está disponível no contexto"}},"pfarg_listar_tarefas_status":{"type":"choice","instructions":"Se a tool \\"listar_tarefas\\" for executada antes da resposta para atender este pedido, qual valor do parâmetro \\"status\\" atende o pedido? Escolha a opção exata, ou \\"sem_argumento\\" se o pedido não pede este recorte.","criteria":{"sem_argumento":"O pedido não pede este recorte: usar o padrão da tool, sem este parâmetro.","pending":"Pendente","done":"Concluída"}},"pfarg_listar_tarefas_lista":{"type":"choice","instructions":"Se a tool \\"listar_tarefas\\" for executada antes da resposta para atender este pedido, qual valor do parâmetro \\"lista\\" atende o pedido? Escolha a opção exata, ou \\"sem_argumento\\" se o pedido não pede este recorte.","criteria":{"sem_argumento":"O pedido não pede este recorte: usar o padrão da tool, sem este parâmetro.","Revisar PR":"valor citado no pedido","Trabalho":"valor citado no pedido"}},"arg_criar_tarefa_titulo":{"type":"choice","instructions":"Supondo que a próxima tool seja criar_tarefa: qual o valor correto do parâmetro \\"titulo\\" para atender o pedido, dado o contexto e as ações anteriores? Escolha o candidato exato, ou nenhum_dos_candidatos.","criteria":{"nenhum_dos_candidatos":"Nenhum dos candidatos listados é o valor certo para este parâmetro neste pedido.","t1":"Revisar PR","t2":"Outra"}}}`);

const ESTADO_A = JSON.parse(`{"pedido_do_usuario":"marca a tarefa \\"Revisar PR\\" como feita na lista \\"Trabalho\\"","data_hora":"2026-09-18T10:00:00Z","anexos_desta_mensagem":["{\\"nome\\":\\"a.pdf\\"}"],"powers_ativos":["tarefas"],"candidatos_do_roteamento":[{"power":"tarefas","score":0.91}],"memoria_de_trabalho":[],"contexto_dos_powers":{},"regras_dos_powers_ativos":{},"conversa_anterior":[{"quem":"usuario","texto":"oi"},{"quem":"assistente","texto":"ola"}],"acoes_ja_executadas":[],"o_que_o_assistente_ja_disse":[],"_cortes":[]}`);

test('igualdade A: catálogo com prefetch+enum+candidatos de aspas — montarPerguntas byte-idêntico', () => {
  const catalogoA = aplicarEstrategiasDeCandidatos(catalogoOriginalA, { pedido: pedidoA });
  const q = montarPerguntas({ assistente: 'assistente pessoal Igris', catalogo: catalogoA, candidatos: { criar_tarefa: { titulo: [['t1', 'Revisar PR'], ['t2', 'Outra']] } } });
  assert.deepEqual(q, PERGUNTAS_A);
});

test('igualdade A: montarEstado byte-idêntico', () => {
  const estadoA = { pedido: pedidoA, dataHora: '2026-09-18T10:00:00Z', anexos: [{ nome: 'a.pdf' }], powersAtivos: ['tarefas'], candidatos: [{ id: 'tarefas', score: 0.91 }], mensagens: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'ola' }, { role: 'user', content: pedidoA }] };
  const s = montarEstado(estadoA);
  assert.deepEqual(s, ESTADO_A);
});

// --- Caso B: contribuições de power -----------------------------------------------------
const catalogoB = [{ name: 'a', power: 'pa', desc: 'A. Mais.' }, { name: 'g', power: 'pg', desc: 'G.', prefetch: true }];
const perguntasDosPowersB = {
  okapp: { precisa_schema: { type: 'noul', instructions: 'O usuário está pedindo dados que exigem o schema do OkApp?' } },
  gestao_documentos: { tipo_documento: { type: 'choice', instructions: 'Qual tipo de documento o pedido referencia?', criteria: { nota_fiscal: 'Nota fiscal', contrato: 'Contrato' } } },
};

const PERGUNTAS_B = JSON.parse(`{"next_tool":{"type":"choice","instructions":"Você roteia o assistente pessoal Igris. Dado o pedido do usuário, o contexto dos powers e da sessão (o mesmo que o assistente vê), a conversa anterior, as ações já executadas (com resultados) e o que o assistente já disse, qual tool deve ser chamada EM SEGUIDA? Exatamente uma. Consulte antes de agir, honre condições, nunca repita ação já bem-sucedida com os mesmos argumentos. Se o assistente já tem no contexto o que precisa para responder, ou nada do catálogo se aplica, escolha respond_to_user. Ignore a escrita de memória de trabalho (mt_*): não é uma ação pedida pelo usuário.","criteria":{"respond_to_user":"Nenhuma tool é necessária agora: o pedido já está atendido pelas ações executadas, ou se responde com o que já está no contexto. O assistente escreve a resposta final.","a":"A. (power: pa)","g":"G. (power: pg)"}},"pronto":{"type":"noul","instructions":"O assistente já tem, no contexto atual (blocos dos powers, resultados das ações executadas, conversa), tudo o que precisa para responder ao usuário agora, sem chamar mais nenhuma tool.","criteria":{"true":"nada falta buscar: responde com o que já está no contexto","false":"ainda falta executar ou consultar algo para atender o pedido"}},"prefetch_g":{"type":"noul","instructions":"Para atender este pedido do usuário (dado o contexto dos powers, da sessão e a conversa anterior), o assistente vai precisar chamar a tool g — \\"G.\\" (power pg)? Verdadeiro só se essa leitura for necessária ou claramente útil para responder; falso se o pedido não tem relação com ela ou o dado já está no contexto.","criteria":{"true":"a leitura é necessária ou claramente útil para este pedido","false":"não tem relação com o pedido, ou o dado já está disponível no contexto"}},"power_okapp_precisa_schema":{"type":"noul","instructions":"O usuário está pedindo dados que exigem o schema do OkApp?"},"power_gestao_documentos_tipo_documento":{"type":"choice","instructions":"Qual tipo de documento o pedido referencia?","criteria":{"nota_fiscal":"Nota fiscal","contrato":"Contrato"}}}`);

const ESTADO_B = JSON.parse(`{"pedido_do_usuario":"p","data_hora":null,"anexos_desta_mensagem":[],"powers_ativos":[],"candidatos_do_roteamento":[],"memoria_de_trabalho":["m1","m2"],"contexto_dos_powers":{"okapp":"bloco"},"regras_dos_powers_ativos":{"okapp":"Regra do okapp"},"conversa_anterior":[],"acoes_ja_executadas":[],"o_que_o_assistente_ja_disse":[],"_cortes":[]}`);

test('igualdade B: contribuições de power — montarPerguntas byte-idêntico', () => {
  const q = montarPerguntas({ assistente: 'assistente pessoal Igris', catalogo: catalogoB, perguntasDosPowers: perguntasDosPowersB });
  assert.deepEqual(q, PERGUNTAS_B);
});

test('igualdade B: montarEstado byte-idêntico', () => {
  const estadoB = { pedido: 'p', regrasDosPowers: { okapp: 'Regra do okapp' }, memoriaDeTrabalho: ['m1', 'm2'], blocosDosPowers: { okapp: 'bloco' } };
  const s = montarEstado(estadoB);
  assert.deepEqual(s, ESTADO_B);
});

// --- Caso C: estado grande que força corte -----------------------------------------------
const catalogoC = [{ name: 'x', power: 'px', desc: 'X.' }];

const PERGUNTAS_C = JSON.parse(`{"next_tool":{"type":"choice","instructions":"Você roteia o assistente pessoal Igris. Dado o pedido do usuário, o contexto dos powers e da sessão (o mesmo que o assistente vê), a conversa anterior, as ações já executadas (com resultados) e o que o assistente já disse, qual tool deve ser chamada EM SEGUIDA? Exatamente uma. Consulte antes de agir, honre condições, nunca repita ação já bem-sucedida com os mesmos argumentos. Se o assistente já tem no contexto o que precisa para responder, ou nada do catálogo se aplica, escolha respond_to_user. Ignore a escrita de memória de trabalho (mt_*): não é uma ação pedida pelo usuário.","criteria":{"respond_to_user":"Nenhuma tool é necessária agora: o pedido já está atendido pelas ações executadas, ou se responde com o que já está no contexto. O assistente escreve a resposta final.","x":"X. (power: px)"}},"pronto":{"type":"noul","instructions":"O assistente já tem, no contexto atual (blocos dos powers, resultados das ações executadas, conversa), tudo o que precisa para responder ao usuário agora, sem chamar mais nenhuma tool.","criteria":{"true":"nada falta buscar: responde com o que já está no contexto","false":"ainda falta executar ou consultar algo para atender o pedido"}}}`);

test('igualdade C: catálogo simples — montarPerguntas byte-idêntico', () => {
  const q = montarPerguntas({ assistente: 'assistente pessoal Igris', catalogo: catalogoC });
  assert.deepEqual(q, PERGUNTAS_C);
});

test('igualdade C: estado grande que força corte — montarEstado byte-idêntico (campos, cortes e tamanho final dos campos cortados)', () => {
  const grandeC = 'x'.repeat(3000);
  const estadoC = {
    pedido: 'p',
    blocosDosPowers: { a: grandeC, b: grandeC },
    regrasDosPowers: { p1: grandeC },
    mensagens: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'msg ' + i })).concat([{ role: 'user', content: 'p' }]),
    acoesDoTurno: [{ passo: 1, tool: 't', args: '{}', status: 'completed', resultado: grandeC }],
  };
  const s = montarEstado(estadoC, { tetoChars: 4000 });
  // registrado a partir do código atual: contexto_dos_powers (2 chaves de 3000 chars) some
  // por inteiro; regras_dos_powers_ativos.p1 e acoes_ja_executadas[0].resultado sobrevivem
  // cortados por halving (3000 → 1500 e 3000 → 600, ambos com reticência).
  const esperado = {
    pedido_do_usuario: 'p',
    data_hora: null,
    anexos_desta_mensagem: [],
    powers_ativos: [],
    candidatos_do_roteamento: [],
    memoria_de_trabalho: [],
    contexto_dos_powers: {},
    regras_dos_powers_ativos: { p1: 'x'.repeat(1500) + '…' },
    conversa_anterior: [
      { quem: 'usuario', texto: 'msg 14' },
      { quem: 'assistente', texto: 'msg 15' },
      { quem: 'usuario', texto: 'msg 16' },
      { quem: 'assistente', texto: 'msg 17' },
      { quem: 'usuario', texto: 'msg 18' },
      { quem: 'assistente', texto: 'msg 19' },
    ],
    acoes_ja_executadas: [{ passo: 1, tool: 't', args: '{}', status: 'completed', resultado: 'x'.repeat(600) + '…' }],
    o_que_o_assistente_ja_disse: [],
    _cortes: ['contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'contexto_dos_powers', 'regras_dos_powers_ativos'],
  };
  assert.deepEqual(s, esperado);
  assert.ok(JSON.stringify(s).length <= 4000);
});

test('assistente: o padrão é neutro (sem Igris) e só o nome muda o texto do next_tool', () => {
  const neutro = montarPerguntas({ catalogo: catalogoC }).next_tool.instructions;
  const igris = montarPerguntas({ assistente: 'assistente pessoal Igris', catalogo: catalogoC }).next_tool.instructions;
  assert.ok(!/igris/i.test(neutro));
  assert.ok(neutro.startsWith('Você roteia o assistente pessoal. Dado o pedido'));
  assert.equal(igris.replace('assistente pessoal Igris', 'assistente pessoal'), neutro);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarConstrutorDePrompt, systemVazio } from '../src/prompt-builder.js';

const config = {
  base: () => [{ nome: 'identidade', conteudo: '<identidade>Sou um agente.</identidade>' }],
};

/** Bloco no formato que a ponte do Kairos entrega. */
function bloco(ref, content, destination = 'turn:context', priority = 1) {
  return { ref, label: ref, content, destination, priority };
}

/** Quantos bytes iniciais os dois textos têm em comum. */
function prefixoComum(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

test('capacidade nova no turno 2 preserva o prefixo do turno 1 por inteiro, e o turno 1 é o prompt certo', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [bloco('agenda/tool/listar', 'Lista eventos. args: {dia}')],
    indice: [{ ref: 'agenda/tool/listar#index', providerId: 'agenda', nome: 'agenda__listar', conteudo: 'agenda__listar — lista eventos' }],
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  const p1 = construtor.montar({
    contexto: {}, texto: 'o que tenho hoje?', system: t1.system, efemeros: [], historico: [],
  });

  // Ancora o CONTEÚDO de p1.system: sem isso, p1 e p2 poderiam ser lixo idêntico e o
  // teste de prefixo abaixo passaria mesmo com o acumulador quebrado.
  const capsAbertas = p1.system.match(/<capability /g) ?? [];
  const funcoesAbertas = p1.system.match(/<function /g) ?? [];
  assert.equal(capsAbertas.length, 1, 'exatamente uma <capability>');
  // Antes de 2026-09-18 a mesma função aparecia em DUAS tags por desenho: a linha
  // curta no índice (`<funcoes>`) e o contrato completo no manual (`<manuais>`),
  // porque o manual hidratou no mesmo turno. A Mudança 2 fundiu os dois grupos em
  // `<functions>` e tirou a função do grupo "carregáveis" assim que ela ganha
  // manual — por isso agora é UMA tag só (ver `renderizarCapacidade`); duas aqui
  // voltaria a ser a duplicação que a mudança elimina.
  assert.equal(funcoesAbertas.length, 1, 'uma função com manual entra em uma <function> só, não duas');
  assert.ok(p1.system.includes('name="agenda__listar"'), 'o NOME EXPOSTO precisa estar na tag');
  assert.ok(!p1.system.includes('#index'), 'o índice nunca deveria vazar a marca de índice pro prompt');
  assert.ok(
    !p1.system.includes('name="agenda/tool/listar"'),
    'refDaTool quebrado faria o manual duplicar a função com a ref crua como nome',
  );

  // Turno 2: o host manda o índice INTEIRO de toda tool consciente, hidratada ou não
  // (contrato de `EntradaDaAcumulacao.indice`) — não só a tool nova. Mandar só a nova
  // nunca exercitaria o dedupe do passo 1 (`cap.funcoes.some(...)`), que é o que segura
  // o append-only quando o host reenvia o catálogo completo a cada turno.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [bloco('notas/tool/buscar', 'Busca notas. args: {q}')],
    indice: [
      { ref: 'agenda/tool/listar#index', providerId: 'agenda', nome: 'agenda__listar', conteudo: 'agenda__listar — lista eventos' },
      { ref: 'notas/tool/buscar#index', providerId: 'notas', nome: 'notas__buscar', conteudo: 'notas__buscar — busca notas' },
    ],
    conscientes: ['agenda/tool/listar', 'notas/tool/buscar'],
    providersCarregados: ['notas'],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'e as notas?', system: t2.system, efemeros: [], historico: [],
  });

  // A capacidade nova entra no FIM do bloco de capacidades. Tudo que o turno 1
  // escreveu antes disso tem que sobreviver byte a byte.
  const comum = prefixoComum(p1.system, p2.system);
  const marcaDoFim = p1.system.lastIndexOf('</capabilities>');
  assert.ok(
    comum >= marcaDoFim,
    `prefixo preservado até ${comum}, mas o conteúdo do turno 1 vai até ${marcaDoFim}`,
  );
});

test('a mesma ref de contribuição com conteúdo novo SUBSTITUI, não duplica', () => {
  const construtor = criarConstrutorDePrompt(config);
  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [bloco('contexto/tela', 'Tela: agenda', 'system:stable', 100)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  });
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [bloco('contexto/tela', 'Tela: notas', 'system:stable', 100)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });
  assert.ok(p2.system.includes('Tela: notas'));
  assert.ok(!p2.system.includes('Tela: agenda'));
});

test('duas contribuições do mesmo nível com a mesma prioridade lançam', () => {
  const construtor = criarConstrutorDePrompt(config);
  assert.throws(
    () => construtor.acumular({
      anterior: systemVazio(),
      system: [
        bloco('a/x', 'A', 'system:stable', 100),
        bloco('b/y', 'B', 'system:stable', 100),
      ],
      turno: [], indice: [], conscientes: [], providersCarregados: [],
    }),
    /mesma prioridade/,
  );
});

test('contribuição na prioridade reservada do bloco de capacidades lança', () => {
  const construtor = criarConstrutorDePrompt(config);
  assert.throws(
    () => construtor.acumular({
      anterior: systemVazio(),
      system: [bloco('a/x', 'A', 'system:stable', 50)],
      turno: [], indice: [], conscientes: [], providersCarregados: [],
    }),
    /bloco de capacidades/,
  );
});

test('manual não é reescrito: o conteúdo congelado na primeira hidratação sobrevive', () => {
  const construtor = criarConstrutorDePrompt(config);
  const indice = [{ ref: 'agenda/tool/listar#index', providerId: 'agenda', nome: 'agenda__listar', conteudo: 'idx' }];

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [bloco('agenda/tool/listar', 'Manual V1')],
    indice,
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    // Mesma tool, hidratando de novo com um texto DIFERENTE — simula o discover
    // reidratando a mesma função num turno seguinte.
    turno: [bloco('agenda/tool/listar', 'Manual V2')],
    indice,
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });

  assert.ok(p2.system.includes('Manual V1'), 'o manual congelado na primeira vez tem que sobreviver');
  assert.ok(!p2.system.includes('Manual V2'), 'reescrever o manual trocaria bytes já cacheados');
});

test('revalidação de permissão remove a tool que não está mais em conscientes', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [bloco('dados/tool/a', 'Manual A'), bloco('dados/tool/b', 'Manual B')],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'dados__b idx' },
    ],
    conscientes: ['dados/tool/a', 'dados/tool/b'],
    providersCarregados: ['dados'],
  });

  // Turno 2: o provider `dados` revalidou (está em providersCarregados), mas só
  // `dados/tool/a` continua em conscientes — `dados/tool/b` perdeu permissão.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
    ],
    conscientes: ['dados/tool/a'],
    providersCarregados: ['dados'],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });

  assert.ok(t2.sairam.includes('dados/tool/b'), 'a perda de permissão tem que aparecer no rastro `sairam`');
  assert.ok(p2.system.includes('dados__a'), 'a tool que continua permitida sobrevive');
  assert.ok(!p2.system.includes('dados__b'), 'a tool que perdeu permissão some do prompt');
  assert.ok(!p2.system.includes('Manual B'));
});

test('contribuição que muda de nível entre turnos não aparece duplicada', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [bloco('projeto/estado', 'ESTADO_ATUAL_DO_PROJETO', 'system:stable', 100)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  });

  // Mesma ref, mesmo conteúdo, mas a fonte agora classifica como `system:dynamic`.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [bloco('projeto/estado', 'ESTADO_ATUAL_DO_PROJETO', 'system:dynamic', 100)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });

  const ocorrencias = p2.system.split('ESTADO_ATUAL_DO_PROJETO').length - 1;
  assert.equal(ocorrencias, 1, 'sem remover do nível antigo, a contribuição apareceria duas vezes');
});

test('ordem por prioridade: menor prioridade fica antes das capacidades, maior fica depois', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [
      bloco('anexo/grande', 'CONTEUDO_DO_ANEXO', 'system:stable', 10),
      bloco('contexto/tela', 'CONTEUDO_DA_TELA', 'system:stable', 200),
    ],
    turno: [bloco('agenda/tool/listar', 'Lista eventos.')],
    indice: [{ ref: 'agenda/tool/listar#index', providerId: 'agenda', nome: 'agenda__listar', conteudo: 'idx' }],
    conscientes: ['agenda/tool/listar'],
    providersCarregados: ['agenda'],
  });
  const p1 = construtor.montar({
    contexto: {}, texto: 'x', system: t1.system, efemeros: [], historico: [],
  });

  const posAnexo = p1.system.indexOf('CONTEUDO_DO_ANEXO');
  const posCapacidades = p1.system.indexOf('<capabilities>');
  const posTela = p1.system.indexOf('CONTEUDO_DA_TELA');

  assert.ok(posAnexo >= 0 && posCapacidades >= 0 && posTela >= 0, 'as três seções têm que estar presentes');
  assert.ok(posAnexo < posCapacidades, 'prioridade 10 (mais estável que a capacidade) vem ANTES do bloco de capacidades');
  assert.ok(posCapacidades < posTela, 'prioridade 200 (menos estável) vem DEPOIS do bloco de capacidades');
});

test('efêmeros vão para a mensagem do turno, não para o system', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    // `turn:context` que não é contrato: cai no ramo `efemeros.push(bloco)` do passo 2.
    turno: [bloco('contexto/tela', 'TELA_ABERTA_AGORA', 'turn:context')],
    indice: [], conscientes: [], providersCarregados: [],
  });
  const p1 = construtor.montar({
    contexto: {}, texto: 'x', system: t1.system, efemeros: t1.efemeros, historico: [],
  });

  assert.ok(p1.mensagemDoTurno.includes('TELA_ABERTA_AGORA'), 'efêmero tem que chegar na mensagem do turno');
  assert.ok(!p1.system.includes('TELA_ABERTA_AGORA'), 'efêmero não pode invadir o system acumulado');
});

test('revogação TOTAL (conscientes vazio): a guarda de permissão remove as duas tools do índice e o rastro registra as duas em `sairam`', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [bloco('dados/tool/a', 'Manual A'), bloco('dados/tool/b', 'Manual B')],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'dados__b idx' },
    ],
    conscientes: ['dados/tool/a', 'dados/tool/b'],
    providersCarregados: ['dados'],
  });

  // Turno 2: revogação TOTAL — `conscientes` vem vazio — e o host, não-conforme,
  // continua mandando as duas tools no índice. É o caso que a guarda existe para
  // conter: sem ela, as duas são removidas pela revalidação acima e RECRIADAS a
  // partir do índice, sem os manuais.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'dados__b idx' },
    ],
    conscientes: [],
    providersCarregados: ['dados'],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });

  assert.ok(!p2.system.includes('dados__a'), 'revogação total: a tool a não pode ser recriada a partir do índice');
  assert.ok(!p2.system.includes('dados__b'), 'revogação total: a tool b não pode ser recriada a partir do índice');
  assert.ok(!p2.system.includes('Manual A'));
  assert.ok(!p2.system.includes('Manual B'));
  assert.ok(t2.sairam.includes('dados/tool/a'), 'o rastro tem que registrar a revogação de a');
  assert.ok(t2.sairam.includes('dados/tool/b'), 'o rastro tem que registrar a revogação de b');
});

test('revogação PARCIAL com host não-conforme (índice ainda manda a tool revogada): a que sobra mantém o manual, a outra some só dela', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    turno: [bloco('dados/tool/a', 'Manual A'), bloco('dados/tool/b', 'Manual B')],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'dados__b idx' },
    ],
    conscientes: ['dados/tool/a', 'dados/tool/b'],
    providersCarregados: ['dados'],
  });

  // Turno 2: só `dados/tool/a` continua em `conscientes`, mas o host (não-conforme)
  // manda o índice das DUAS tools — exercita a guarda dentro do próprio laço do
  // índice, e não só a revalidação que roda antes dele.
  const t2 = construtor.acumular({
    anterior: t1.system,
    system: [],
    turno: [],
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'dados__a idx' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'dados__b idx' },
    ],
    conscientes: ['dados/tool/a'],
    providersCarregados: ['dados'],
  });
  const p2 = construtor.montar({
    contexto: {}, texto: 'x', system: t2.system, efemeros: [], historico: [],
  });

  assert.ok(p2.system.includes('dados__a'), 'a que continua permitida sobrevive');
  assert.ok(p2.system.includes('Manual A'), 'o manual da que sobrevive não pode ser perdido');
  assert.ok(!p2.system.includes('dados__b'), 'a que perdeu permissão some do prompt');
  assert.ok(!p2.system.includes('Manual B'));
  assert.deepEqual(t2.sairam, ['dados/tool/b'], 'só a que perdeu permissão aparece no rastro');
});

test('colisão de prioridade ENTRE TURNOS: turno 2 registrando outra ref na prioridade já ocupada pelo turno 1 lança', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [bloco('a/x', 'A', 'system:stable', 100)],
    turno: [], indice: [], conscientes: [], providersCarregados: [],
  });

  assert.throws(
    () => construtor.acumular({
      anterior: t1.system,
      system: [bloco('b/y', 'B', 'system:stable', 100)],
      turno: [], indice: [], conscientes: [], providersCarregados: [],
    }),
    /mesma prioridade/,
  );
});

test('os três `throw` de validação do item de índice: falta `nome`, falta `providerId`, falta `conteudo`', () => {
  const construtor = criarConstrutorDePrompt(config);

  assert.throws(
    () => construtor.acumular({
      anterior: systemVazio(),
      system: [],
      turno: [],
      indice: [{ ref: 'dados/tool/a#index', providerId: 'dados', conteudo: 'idx' }],
      conscientes: ['dados/tool/a'],
      providersCarregados: ['dados'],
    }),
    /sem `nome`/,
  );

  assert.throws(
    () => construtor.acumular({
      anterior: systemVazio(),
      system: [],
      turno: [],
      indice: [{ ref: 'dados/tool/a#index', nome: 'dados__a', conteudo: 'idx' }],
      conscientes: ['dados/tool/a'],
      providersCarregados: ['dados'],
    }),
    /sem `providerId`/,
  );

  assert.throws(
    () => construtor.acumular({
      anterior: systemVazio(),
      system: [],
      turno: [],
      indice: [{ ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a' }],
      conscientes: ['dados/tool/a'],
      providersCarregados: ['dados'],
    }),
    /sem `conteudo`/,
  );
});

test('numa capacidade com duas funções, a com manual só aparece em "disponíveis" e a sem manual só em "carregáveis" — nenhuma nos dois grupos', () => {
  const construtor = criarConstrutorDePrompt(config);

  const t1 = construtor.acumular({
    anterior: systemVazio(),
    system: [],
    // Só `dados/tool/a` hidrata neste turno — `dados/tool/b` fica no índice
    // sem manual, o estado "carregável" da Mudança 2.
    turno: [bloco('dados/tool/a', 'Manual completo de A. args: {x}')],
    // `conteudo` já vem sem o prefixo `${key} — ` — quem tira é `linhasDeIndice`
    // (index.js), fora do escopo deste teste (que exercita só o prompt-builder
    // isolado). O strip do prefixo tem teste próprio, de integração, em
    // `agente-de-prova.test.js`.
    indice: [
      { ref: 'dados/tool/a#index', providerId: 'dados', nome: 'dados__a', conteudo: 'Função A.' },
      { ref: 'dados/tool/b#index', providerId: 'dados', nome: 'dados__b', conteudo: 'Função B.' },
    ],
    conscientes: ['dados/tool/a', 'dados/tool/b'],
    providersCarregados: ['dados'],
  });
  const p1 = construtor.montar({
    contexto: {}, texto: 'x', system: t1.system, efemeros: [], historico: [],
  });

  // A COM manual: só a tag, com o corpo do manual — nunca a linha de índice.
  assert.match(p1.system, /<function name="dados__a">/, 'a função com manual não abriu a tag esperada');
  assert.ok(p1.system.includes('Manual completo de A.'), 'o manual de A não entrou no prompt');
  assert.ok(!p1.system.includes('- dados__a — '), 'A tem manual E apareceu como linha carregável — duplicação que a Mudança 2 elimina');

  // B SEM manual: só a linha "- nome — descrição", nunca a tag `<function>`.
  assert.ok(p1.system.includes('- dados__b — Função B.'), 'a linha carregável de B não apareceu como esperado');
  assert.ok(!p1.system.includes('<function name="dados__b">'), 'B não tem manual e não deveria abrir a tag de função');
});

test('blocoDeOperacoes: junta nome e erro das operações; lista vazia devolve string vazia', () => {
  const construtor = criarConstrutorDePrompt(config);

  assert.equal(construtor.blocoDeOperacoes([]), '');

  const saida = construtor.blocoDeOperacoes([
    { nome: 'agenda__listar', args: { dia: 'hoje' }, ok: true },
    { nome: 'notas__buscar', args: { q: 'x' }, ok: false, erro: 'timeout no provider' },
  ]);
  assert.ok(saida.includes('agenda__listar'));
  assert.ok(saida.includes('notas__buscar'));
  assert.ok(saida.includes('timeout no provider'));
});

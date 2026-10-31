import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeEmbedder } from '@okds/kairos/index/embedder';
import { calibrarLimiares, exemplosDasCapacidades, percentil } from '../src/calibracao.js';

const cap = (id, texto, tools) => ({ id, descricao: id, semanticText: texto, piso: false, tools });
const tool = (name, semanticText, exemplos) => ({ name, description: name, semanticText, exemplos, inputSchema: { type: 'object', properties: {} }, handler: () => null });

const capacidades = [
  cap('agenda', 'agenda compromissos reuniões eventos calendário', [
    tool('gcal_listar', 'eventos da agenda num período', ['o que tenho na agenda amanhã', 'tenho reunião hoje', 'compromissos da semana na agenda']),
  ]),
  cap('tarefas', 'tarefas listas pendências afazeres', [
    tool('task_listar', 'tarefas de uma lista por status', ['tarefas pendentes da lista', 'o que falta fazer nas tarefas', 'lista de afazeres concluídos']),
  ]),
];

test('percentil ordena e interpola pelo índice', () => {
  assert.equal(percentil([3, 1, 2], 0), 1);
  assert.equal(percentil([3, 1, 2], 1), 3);
  assert.equal(percentil([], 0.5), null);
});

test('exemplosDasCapacidades devolve frase + capacidade + função esperadas', () => {
  const ex = exemplosDasCapacidades(capacidades);
  assert.equal(ex.length, 6);
  assert.deepEqual(ex[0], { texto: 'o que tenho na agenda amanhã', capacidade: 'agenda', funcao: 'gcal_listar' });
});

test('poucos exemplos: origem padrão, limiares do padrão', async () => {
  const r = await calibrarLimiares({ capacidades, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 20 } });
  assert.equal(r.origem, 'padrao');
  assert.equal(r.limiares.zFull, 0.8);
});

// M-f (revisão do conjunto, item 7): com só os 2 providers de `capacidades` (piso: false, mas
// abaixo de MIN_PROVIDERS_PARA_Z=3), o grupo z cai no padrão e `r.origem === 'calculado'` só
// bate porque o grupo tool (independente) calculou — o teste passava trivial sem o z rodar de
// verdade. Terceiro provider (`capTerceiraComExemplo`, definido abaixo) força os 3 no ranking.
test('exemplos suficientes: calcula, devolve resumo e conflitos por exemplo', async () => {
  const tresProviders = [...capacidades, capTerceiraComExemplo];
  const r = await calibrarLimiares({ capacidades: tresProviders, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.origem, 'calculado');
  assert.equal(typeof r.limiares.zFull, 'number');
  assert.ok(r.limiares.zCandidate <= r.limiares.zFull);
  assert.equal(r.porExemplo.length, 9);
  assert.ok(Array.isArray(r.conflitos));
  assert.equal(typeof r.resumo.acertoCapacidade, 'number');
  assert.equal(r.resumo.zOrigem, 'calculado', 'com 3 providers no ranking o grupo z precisa calcular de verdade, não só o grupo tool');
  assert.notEqual(r.limiares.zFull, 0.8, 'zFull calculado não pode coincidir com o padrão recebido');
});

test('anel `tool`: scoreToolEsperada é número real, posição vem por relevância — não por ordem de registro (achado crítico da revisão da Fase 2)', async () => {
  // Passo zero confirmado no kairos instalado (node_modules/.pnpm/@okds+kairos.../dist/resolve/
  // discover.js ~l.916-920): sem refinador de anel `tool` registrado, `hydrateExplain` (o que
  // vira `explain` do anel `tool`) sai como `{ ref, ring, reason, strategy }` — SEM `scores`.
  // `calibracao.js` agora registra um refinador IDENTIDADE (`refiners.tool`) no manager, o que
  // muda `discover()` para o ramo `rt.usou === true` (~l.903-914), que estampa `scores: it.
  // scores` em cada item do anel. Reproduzido ANTES do fix: `scoreToolEsperada`/`melhorTool.
  // score` vinham `undefined` para TODOS os exemplos, `limiares.tool` nem aparecia no objeto
  // (percentil de array só-undefined é `null`), e `posicaoTool` batia por COINCIDÊNCIA de ordem
  // de registro (agenda antes de tarefas), não por score semântico.
  const r = await calibrarLimiares({ capacidades, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.origem, 'calculado');
  assert.ok(r.porExemplo.every((p) => typeof p.scoreToolEsperada === 'number'), 'scoreToolEsperada precisa ser número em TODO exemplo, nunca undefined');
  assert.ok(r.porExemplo.every((p) => typeof p.melhorTool?.score === 'number'), 'melhorTool.score precisa ser número em TODO exemplo');
  // Com vocabulários bem distintos entre as duas capacidades/tools (agenda × tarefas), a função
  // certa é sempre a mais bem pontuada — valor concreto fixado pelo FakeEmbedder determinístico.
  assert.equal(r.resumo.funcaoNoTopo, 1);
  assert.equal(typeof r.limiares.tool?.hydrate, 'number', 'limiares.tool.hydrate precisa entrar no resultado (percentil de valores reais, não de puro undefined)');
});

// Revisão do conjunto (2026-09-24, item 1 + correção do controller — "irmão"): duas condições
// INDEPENDENTES, uma por grupo de campo. `zFull`/`zCandidate` dependem de QUANTOS providers
// `piso: false` disputam o ranking (`rank-providers.ts` pula `loading.always` — só quem NÃO é
// `always` entra na dispersão do z), nunca de quem tem exemplo. `tool.hydrate` depende de QUEM
// TEM exemplo — todo provider com função não-fixa precisa ter, ele próprio, pelo menos um.
const capHabilidadesSemExemplo = { id: 'habilidades', descricao: 'h', semanticText: 'habilidades skills que o agente pode carregar', piso: false, tools: [{ name: 'hab_listar', description: 'lista', semanticText: 'lista habilidades disponíveis', inputSchema: { type: 'object', properties: {} }, handler: () => null }] };
const capTerceiraComExemplo = cap('habilidades3', 'habilidades skills que o agente pode carregar', [
  tool('hab_listar', 'lista habilidades disponíveis', ['quais habilidades você tem', 'liste as skills disponíveis', 'o que você sabe fazer']),
]);

test('com 3 providers `piso: false` no ranking, z sai calculado (resumo.zOrigem/providersNoRanking)', async () => {
  const tresProviders = [...capacidades, capTerceiraComExemplo];
  const r = await calibrarLimiares({ capacidades: tresProviders, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.providersNoRanking, 3);
  assert.equal(r.resumo.zOrigem, 'calculado');
  assert.equal(r.resumo.toolOrigem, 'calculado');
  assert.equal(r.origem, 'calculado');
});

test('com 2 providers `piso: false` no ranking, z fica no padrão (dispersão degenerada) mesmo com tool.hydrate calculado', async () => {
  const r = await calibrarLimiares({ capacidades, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.providersNoRanking, 2);
  assert.equal(r.resumo.zOrigem, 'padrao');
  assert.equal(r.limiares.zFull, 0.8, 'sem cálculo, zFull precisa ser exatamente o padrão recebido');
  assert.equal(r.limiares.zCandidate, -1.01);
  assert.ok(r.resumo.zMotivo, 'motivo do fallback de z precisa aparecer no resumo');
  // O grupo `tool` é independente — com os 2 providers cobertos por exemplo, `hydrate` calcula
  // normalmente, e o `origem` geral (OR dos dois grupos) continua 'calculado'.
  assert.equal(r.resumo.toolOrigem, 'calculado');
  assert.equal(r.origem, 'calculado');
});

test('provider `piso: false` com função não-fixa e ZERO exemplos bloqueia tool.hydrate (resumo.toolOrigem/funcoesSemExemplos), mas ainda entra no ranking do z', async () => {
  const comGapDeExemplo = [...capacidades, capHabilidadesSemExemplo];
  const r = await calibrarLimiares({ capacidades: comGapDeExemplo, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.toolOrigem, 'padrao');
  assert.deepEqual(r.resumo.funcoesSemExemplos, ['habilidades/hab_listar']);
  assert.equal(r.resumo.funcoesSemExemplosTotal, 1);
  assert.equal(r.limiares.tool, undefined, 'padrao não declarava `tool` — sem hydrate calculado, não pode aparecer do nada');
  assert.ok(r.resumo.toolMotivo);
  // "habilidades" não tem exemplo PRÓPRIO, mas ainda é `piso: false` — ainda disputa o ranking
  // de TODO exemplo dos outros dois providers, e entra na contagem de `providersNoRanking`.
  assert.equal(r.resumo.providersNoRanking, 3);
  assert.equal(r.resumo.zOrigem, 'calculado', 'com 3 no ranking, z calcula mesmo com um deles sem exemplo próprio');
  assert.equal(r.origem, 'calculado', 'origem geral \'calculado\' — o grupo z compensou o grupo tool travado');
});

// Regra por FUNÇÃO (não por provider): provider com função de leitura COM exemplo e função de
// escrita SEM exemplo não libera o hydrate — a escrita nunca foi medida (lote 1: 8/52 pedidos
// reais de escrita ficariam abaixo do hydrate calculado sobre a leitura).
const capComEscritaSemExemplo = (escritaComExemplo) => cap('tarefas', 'tarefas listas pendências afazeres', [
  tool('task_listar', 'tarefas de uma lista por status', ['tarefas pendentes da lista', 'o que falta fazer nas tarefas', 'lista de afazeres concluídos']),
  { ...tool('task_editar', 'edita uma tarefa existente', escritaComExemplo ? ['edita a tarefa da lista', 'muda o título da tarefa', 'altera o prazo da tarefa'] : undefined), effect: 'write' },
]);

test('hydrate: função de escrita não-fixa SEM exemplo (leitura do mesmo provider com exemplo) mantém o padrão e lista a função', async () => {
  const r = await calibrarLimiares({ capacidades: [capacidades[0], capComEscritaSemExemplo(false), capTerceiraComExemplo], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.toolOrigem, 'padrao');
  assert.deepEqual(r.resumo.funcoesSemExemplos, ['tarefas/task_editar']);
  assert.equal(r.resumo.funcoesSemExemplosTotal, 1);
  assert.match(r.resumo.toolMotivo, /1 funções não fixas sem exemplo, ex\.: tarefas\/task_editar/);
  assert.equal(r.limiares.tool, undefined, 'sem hydrate calculado, `tool` não aparece do nada');
  // z independe: 3 providers no ranking; origem geral segue 'calculado' pelo grupo z.
  assert.equal(r.resumo.zOrigem, 'calculado');
  assert.equal(r.origem, 'calculado');
});

test('hydrate: toda função não-fixa (leitura e escrita) com exemplo calcula', async () => {
  const r = await calibrarLimiares({ capacidades: [capacidades[0], capComEscritaSemExemplo(true), capTerceiraComExemplo], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.toolOrigem, 'calculado');
  assert.equal(r.resumo.funcoesSemExemplos, undefined);
  assert.equal(typeof r.limiares.tool?.hydrate, 'number');
});

// Porte lote 1 / T1: capacidade `piso: true` (`loading.always`) não disputa o anel `provider` —
// o exemplo dela sai com `zEsperado` undefined. Não pode contar como "poder errado" (derrubaria
// `acertoCapacidade` e poluiria `conflitos`); entra só na medida de FUNÇÃO.
test('capacidade de piso: fora da medida de poder, dentro da medida de função', async () => {
  const capMemoriaPiso = { id: 'memoria', descricao: 'memoria', semanticText: 'memória lembrar guardar anotar fatos do usuário', piso: true, tools: [
    tool('mem_buscar', 'busca lembranças guardadas', ['você lembra do que eu disse sobre meu aniversário', 'o que você guardou sobre mim', 'busca nas suas memórias o nome da minha filha']),
  ] };
  const r = await calibrarLimiares({ capacidades: [...capacidades, capTerceiraComExemplo, capMemoriaPiso], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.porExemplo.length, 12);
  const deMemoria = r.porExemplo.filter((p) => p.capacidade === 'memoria');
  assert.equal(deMemoria.length, 3);
  assert.ok(deMemoria.every((p) => p.disputaRanking === false && p.melhorOutro === null));
  // Medida de poder: só os 9 exemplos das capacidades `piso: false`.
  assert.equal(r.resumo.exemplosNoRanking, 9);
  assert.equal(r.resumo.exemplos, 12);
  assert.equal(typeof r.resumo.acertoCapacidade, 'number');
  assert.ok(Number.isFinite(r.resumo.acertoCapacidade));
  // acertoCapacidade divide por 9, não por 12: o de piso não conta nem como acerto nem como erro.
  const acertosRanking = r.porExemplo.filter((p) => p.disputaRanking && p.acertouCapacidade).length;
  assert.equal(r.resumo.acertoCapacidade, acertosRanking / 9);
  // Função: os 12 entram (tool de memória tem score real).
  assert.ok(deMemoria.every((p) => typeof p.scoreToolEsperada === 'number'), 'exemplo de piso mede função com score real');
  assert.equal(r.resumo.funcaoNoTopo, r.porExemplo.filter((p) => p.posicaoTool === 0).length / 12);
  // Nenhum conflito de PODER para o de piso: só pode aparecer por função fora do topo.
  for (const c of r.conflitos.filter((c) => c.esperado.capacidade === 'memoria')) {
    const p = r.porExemplo.find((x) => x.texto === c.texto);
    assert.notEqual(p.posicaoTool, 0, 'conflito de piso só por função fora do topo');
    assert.equal(c.veio.capacidade, undefined, 'sem "melhor outro poder" para exemplo de piso');
  }
});

test('hydrate: só exemplos de função NÃO fixa entram no percentil; funcaoNoTopo segue com todos', async () => {
  const capMista = { id: 'notas', descricao: 'notas', semanticText: 'notas anotações cadernos texto salvo', piso: true, tools: [
    { ...tool('nota_salvar', 'salva uma nota nova', ['salva essa nota para mim', 'anota isso no caderno', 'guarda essa anotação']), fixa: true },
    { ...tool('nota_listar', 'lista as notas existentes por caderno', ['liste minhas notas do caderno', 'quais notas eu tenho salvas', 'mostra as anotações do caderno']), fixa: false },
  ] };
  const r = await calibrarLimiares({ capacidades: [...capacidades, capMista], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.porExemplo.length, 12);
  const fixas = r.porExemplo.filter((p) => p.funcaoFixa);
  assert.deepEqual([...new Set(fixas.map((p) => p.funcao))], ['nota_salvar']);
  assert.equal(fixas.length, 3);
  assert.equal(r.resumo.toolOrigem, 'calculado');
  assert.equal(r.resumo.exemplosNoHydrate, 9);
  const esperado = percentil(r.porExemplo.filter((p) => !p.funcaoFixa).map((p) => p.scoreToolEsperada), 0.10);
  assert.equal(r.limiares.tool.hydrate, esperado);
  // funcaoNoTopo continua sobre os 12 exemplos.
  assert.equal(r.resumo.funcaoNoTopo, r.porExemplo.filter((p) => p.posicaoTool === 0).length / 12);
  // Nenhum exemplo de função fixa é medido no hydrate: sem fixa, o mesmo conjunto usa 12.
  const semFixa = capMista.tools.map((t) => ({ ...t, fixa: false }));
  const r2 = await calibrarLimiares({ capacidades: [...capacidades, { ...capMista, tools: semFixa }], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r2.resumo.exemplosNoHydrate, 12);
});

test('só capacidades de piso com exemplos: acertoCapacidade null (não NaN), exemplosNoRanking 0', async () => {
  const soPiso = ['a', 'b', 'c'].map((id) => ({ id, descricao: id, semanticText: `${id} assunto proprio ${id}`, piso: true, tools: [tool(`${id}_ler`, `le ${id}`, [`pedido sobre ${id} um`, `pedido sobre ${id} dois`])] }));
  const r = await calibrarLimiares({ capacidades: soPiso, embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.exemplosNoRanking, 0);
  assert.equal(r.resumo.acertoCapacidade, null);
  assert.equal(r.conflitos.filter((c) => c.veio.capacidade !== undefined).length, 0);
});

test('exemplos de habilidades entram quando a fonte declara', () => {
  const caps = [{ id: 'habilidades', descricao: 'h', semanticText: 'h', piso: false, tools: [], fonte: {}, skillsDeclaradas: [{ key: 'docx', exemplos: ['faz um word'] }] }];
  const ex = exemplosDasCapacidades(caps);
  assert.deepEqual(ex, [{ texto: 'faz um word', capacidade: 'habilidades', habilidade: 'docx' }]);
});

test('exemplosDasCapacidades ignora capacidade com calibravel:false (servidor MCP genérico)', () => {
  const mcp = { ...cap('mcp-crm', 'crm clientes', [tool('mcp_crm_buscar', 'busca cliente', ['acha o cliente João'])]), calibravel: false };
  const ex = exemplosDasCapacidades([...capacidades, mcp]);
  assert.equal(ex.length, 6, 'os exemplos do genérico não entram');
  assert.ok(ex.every((e) => e.capacidade !== 'mcp-crm'));
  // calibravel:true (okapp) e ausente (poder interno) continuam entrando.
  const okapp = { ...cap('okapp', 'okapp', [tool('okapp_listar', 'lista', ['lista meus projetos'])]), calibravel: true };
  assert.equal(exemplosDasCapacidades([okapp]).length, 1);
});

// Spec 2026-10-01 M1: o genérico (calibravel:false) continua registrado (disputa o roteamento), mas não
// entra na conta da calibração — nem para liberar o z (providersNoRanking) nem para bloquear o hydrate
// (funcoesSemExemplos).
const capGenericaSemExemplo = { ...cap('mcp-crm', 'crm clientes contatos', [{ name: 'mcp_crm_buscar', description: 'busca', semanticText: 'busca cliente no crm', inputSchema: { type: 'object', properties: {} }, handler: () => null }]), calibravel: false };

test('genérico sem exemplos não bloqueia tool.hydrate: toolCalculavel igual ao de sem genérico', async () => {
  const base = [...capacidades, capTerceiraComExemplo];
  const padrao = { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 };
  const sem = await calibrarLimiares({ capacidades: base, embedder: new FakeEmbedder(), padrao, parametros: { minExemplos: 3 } });
  const com = await calibrarLimiares({ capacidades: [...base, capGenericaSemExemplo], embedder: new FakeEmbedder(), padrao, parametros: { minExemplos: 3 } });
  assert.equal(sem.resumo.toolOrigem, 'calculado');
  assert.equal(com.resumo.toolOrigem, 'calculado');
  assert.equal(com.resumo.funcoesSemExemplos, undefined);
  assert.equal(com.resumo.providersNoRanking, sem.resumo.providersNoRanking, 'o genérico não conta como provider no ranking');
  assert.equal(com.resumo.zOrigem, sem.resumo.zOrigem);
  assert.equal(com.porExemplo.length, sem.porExemplo.length, 'e não contribui com exemplos');
});

test('genérico não completa os 3 providers do z: com 2 poderes + 1 genérico o z fica no padrão', async () => {
  const r = await calibrarLimiares({ capacidades: [...capacidades, capGenericaSemExemplo], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.providersNoRanking, 2);
  assert.equal(r.resumo.zOrigem, 'padrao');
  assert.equal(r.limiares.zFull, 0.8);
});

test('sem a marca (poder interno), o mesmo sem-exemplo continua bloqueando o hydrate', async () => {
  const interna = { ...capGenericaSemExemplo, calibravel: undefined };
  const r = await calibrarLimiares({ capacidades: [...capacidades, capTerceiraComExemplo, interna], embedder: new FakeEmbedder(), padrao: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, parametros: { minExemplos: 3 } });
  assert.equal(r.resumo.toolOrigem, 'padrao');
  assert.deepEqual(r.resumo.funcoesSemExemplos, ['mcp-crm/mcp_crm_buscar']);
});

// Revisão do conjunto (I2): o genérico saía do cálculo de limiares mas continuava no manager de
// calibração, e o z do kairos é a dispersão sobre TODO provider pontuado — os z esperados (e o percentil
// deles) mudavam conforme o usuário cadastrava servidores. Agora o genérico não entra no manager.
test('I2: limiares e z por exemplo iguais com e sem genéricos no conjunto', async () => {
  const base = [...capacidades, capTerceiraComExemplo];
  const padrao = { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 };
  const par = { minExemplos: 3 };
  const outro = { ...cap('mcp-fs', 'arquivos pastas tarefas do sistema', [{ name: 'mcp_fs_x', description: 'x', semanticText: 'arquivos pastas tarefas do sistema', inputSchema: { type: 'object', properties: {} }, handler: () => null }]), calibravel: false };
  const sem = await calibrarLimiares({ capacidades: base, embedder: new FakeEmbedder(), padrao, parametros: par });
  const com = await calibrarLimiares({ capacidades: [...base, capGenericaSemExemplo, outro], embedder: new FakeEmbedder(), padrao, parametros: par });
  assert.deepEqual(com.limiares, sem.limiares);
  assert.deepEqual(com.porExemplo.map((p) => p.zEsperado), sem.porExemplo.map((p) => p.zEsperado), 'o z de cada exemplo não se desloca');
  assert.deepEqual(com.resumo.zCertos, sem.resumo.zCertos);
  assert.equal(com.resumo.acertoCapacidade, sem.resumo.acertoCapacidade);
});

test('I2: a chave do cache de limiares ignora genéricos (cadastrar servidor não recalibra)', async () => {
  const { limiaresDoConjunto } = await import('../src/index.js');
  const { limparCacheDeEmbeddingsDoProcesso } = await import('../src/cache-catalogo.js');
  limparCacheDeEmbeddingsDoProcesso();
  const base = [...capacidades, capTerceiraComExemplo];
  const fake = new FakeEmbedder();
  let chamadas = 0;
  const embedder = { modelSlug: fake.modelSlug, dim: fake.dim, embed: (...a) => { chamadas += 1; return fake.embed(...a); } };
  const config = (caps) => ({ capacidades: caps, limiares: { zFull: 0.8, zCandidate: -1.01, rawFloor: 0.8 }, calibracao: { ativa: true, parametros: { minExemplos: 3 } } });
  const a = await limiaresDoConjunto(config(base), embedder);
  const depoisDaPrimeira = chamadas;
  assert.ok(depoisDaPrimeira > 0);
  const b = await limiaresDoConjunto(config([...base, capGenericaSemExemplo]), embedder);
  assert.equal(chamadas, depoisDaPrimeira, 'entrou um genérico: a mesma chave, sem recalcular');
  assert.deepEqual(b.infoLimiares.valores, a.infoLimiares.valores);
  assert.equal(a.infoLimiares.origem, 'calculado');
});

// decisoes/src/refinadores/turno.js
//
// Fiação por turno do refino por anel (provider/tool/skill) do kairos: o que o HOST do chat (Igris, Ariadne) faz a cada
// turno para pôr o Jev no refino — defaults de orçamento por anel (`REFINO_PADRAO`), validação do objeto de refino
// (`normalizarRefino`), os três refinadores com cache de respostas por turno e memoização (`refinadoresDoTurno`) e a
// mescla das respostas tardias no artefato (`comTardias`). Subiu do Igris (`fabrica/refinadores.js`): era cola do host
// com mecanismo genérico; o Ariadne usa o mesmo. O que continua do host: ler env/JSON, dizer de onde vêm o cliente do
// Jev, a conversa e as consultas do turno. A fábrica não interpreta o contrato de `RingRefiner`, só transporta o que
// `refinadoresDoChat` (`./index.js`) já monta pronto. Sem `process.env`: o host entrega o objeto já lido.
import { refinadoresDoChat, PADRAO_PROVIDER, PADRAO_TOOL, PADRAO_SKILL } from './index.js';

/**
 * Defaults por anel — Q3 (correção do review da Fase 3): os três objetos de anel vêm por
 * SPREAD de `PADRAO_PROVIDER`/`PADRAO_TOOL`/`PADRAO_SKILL` (`decisoes/src/refinadores/{provider,tool,skill}.js`), não mais duplicados como literais — antes, uma mudança nos
 * defaults do lado de `decisoes` (cortes/tetos) divergia em silêncio do que o chat
 * usava, sem nenhum teste acusando. Só os quatro campos de orçamento (`prazoMs`/
 * `prazoGeralMs`/`candidateProvidersForRefine`/`maxActivate`, R4/R6) continuam literais aqui:
 * são específicos de `ConfigDoOrquestrador.refino`, sem equivalente do lado de `decisoes` (o construtor de refinador não conhece orçamento de chamada, só cortes/tetos de
 * classificação). O objeto de refino do host (`normalizarRefino` abaixo) mescla por cima
 * — RASO por anel (`{ ...REFINO_PADRAO, ...json, provider: { ...REFINO_PADRAO.provider,
 * ...json.provider } , ... }`), nunca substitui um anel inteiro por um objeto parcial.
 */
// Orçamentos — histórico de calibração (21/09, sessão `5d786bc9` depois `1be5fa6d`/`08cb76d8`):
// começou em 600/800 (só `provider`, 3 perguntas, ~520ms, respondia a tempo; `skill`/`tool`
// caíam em `jev:degradado (timeout)` em TODO turno); subiu para 1000/2000 e depois para
// 1100/2200 (folga de 50ms para o caso quente de `skill`, 35 perguntas, 416–964ms, que perdia o
// prazo por 3–14ms e disparava a cascata do I3a). Os frios (1283–1831ms, gateway ocioso) ficam
// para o keep-alive do lado do gateway (pendência) — fora do alcance deste ajuste.
// Task 3 (2026-09-21-ajustes-de-uso-da-fabrica): reorganizado para PRAZO POR ANEL. `prazoMs`
// GLOBAL agora é só o teto do kairos (`refinerBudgetMs`, o timer de fundo que o motor arma por
// refinador, IGUAL para os três anéis) — cada anel usa o seu próprio prazo interno
// (`config.<anel>.prazoMs ?? prazoMs`, aplicado dentro de `refinadorDe{Capacidades,Funcoes,
// Habilidades}` → `criarRefinadorJev`), sempre com folga (mínimo 50ms) ABAIXO do teto, para o
// nosso prazo interno vencer a corrida contra o timer do motor (`MARGEM_MS`,
// `criar-refinador-jev.js`). Histórico do modo combinado (superado pelo modo V1 abaixo):
// `provider`/`tool` em 1100 (folga de 500 contra o teto de 1600); `skill` em 1500 (mais
// perguntas — até 35 — folga de 100). `prazoGeralMs` é a RODADA inteira do
// turno: onda 1 (`provider`/`skill`/... em paralelo, até 1500) + onda 2 (`tool`, até 1100) — mas
// com o anel `provider` já perguntando pelas funções da capacidade na MESMA chamada (Task 2,
// cache por turno abaixo), a onda 2 normalmente não pergunta nada de novo (`aPerguntar.length
// === 0`, o Jev nem chega a ser chamado) e a folga é para quando o cache não cobre tudo (função
// fora da capacidade promovida). Calibração fina fica para depois de ler `refino.porAnel[*].msReal`
// (a latência REAL do Jev quando estoura, via `aoChegarTarde` abaixo).
// Correção do review da Fase 1 (#4): 3000 → 3600. O `deadlineAt` do kairos (`dist/resolve/
// discover.js` ~linha 395, `const deadlineAt = Date.now() + refinersBudgetMs`) é armado ANTES do
// scoring (`rankProviders`) e da hidratação — não só das duas ondas de refino. `prazoGeralMs`
// cobre, a partir dali: scoring + onda 1 (até 1500) + hidratação por provider (sequencial, Fase
// 3 do kairos) + onda 2 (até 1100) — soma que já passa de 2600ms de refino puro sem contar
// scoring/hidratação; 3000 deixava pouca folga.
// Modo combinado é o PADRÃO (22/09, ajuste pontual): a medição de 21/09 (sessões
// `97c4bc58`/`3fae43e0`, Vercel) mostrou que a chamada combinada em si respondia em 432–752 ms,
// dentro do orçamento — o que estourava não era o prazo, era o CACHE: só cobria 6 de 18 funções
// por turno porque as capacidades de PISO (memoria/redator/roteiros, sempre carregadas pelo
// host) nunca eram candidatas do anel `provider` (só os itens do anel viravam extra — ver
// `perguntasExtras` em `decisoes/src/refinadores/provider.js`), e a segunda rodada do anel
// `tool` (I3a) reperguntava tudo porque não gravava as próprias respostas de volta no cache. As
// duas causas foram corrigidas (extras também cobrem `input.state.loadedProviders`; o anel
// `tool` grava as próprias respostas via o gancho `aoResponder` de `criarRefinadorJev`) — com
// isso o modo combinado volta a ser o padrão.
// Histórico (21/09, sessão `5d786bc9` depois `1be5fa6d`/`08cb76d8`): antes desta correção, o modo
// combinado sofria com o cache raso e o dono voltou temporariamente ao modo V1 (commit
// `5d3d3bbc`, pendência "medicao pos-entrega — chamada combinada estoura o prazo") para o teste
// seguinte — decisão revertida aqui, com a causa raiz corrigida. Os dois modos anteriores
// continuam disponíveis pelo objeto de refino do host, nada foi apagado:
// - Modo V1 (Jev decide só `provider`/`skill`; `tool` pelo score do motor; sem a chamada
//   combinada de funções): `normalizarRefino({ aneisComJev: ['provider', 'skill'],
//   funcoesNaChamadaDeCapacidades: false })`
// - Chamada única (Jev decide só `provider`): `normalizarRefino({ aneisComJev: ['provider'] })`
export const REFINO_PADRAO = {
  prazoMs: 1600,
  prazoGeralMs: 3600,
  candidateProvidersForRefine: 8,
  maxActivate: 2,
  provider: { ...PADRAO_PROVIDER, prazoMs: 1500 },
  tool: { ...PADRAO_TOOL, prazoMs: 1100 },
  skill: { ...PADRAO_SKILL, prazoMs: 1500 },
  // Anéis que o Jev decide (repassado a `refinadoresDoChat({ aneis })`, `decisoes/
  // refinadores`) — modo combinado (padrão): os três. `tool` só fica de fora no modo V1, pelo objeto de refino do host.
  aneisComJev: ['provider', 'tool', 'skill'],
  // Repassado a `refinadoresDoChat({ config: { funcoesNaChamadaDeCapacidades } })` — `true`
  // (modo combinado, padrão): o anel `provider` pergunta pelas funções das capacidades enviadas
  // NA MESMA chamada ao Jev (`funcoesDe`/`cache`, sempre passados por `turno.js`) — é o que
  // permite ao anel `tool` reaproveitar a resposta do cache. `false` só no modo V1, pelo objeto de refino do host.
  funcoesNaChamadaDeCapacidades: true,
};

// Task 7 (2026-09-21-ajustes-de-uso-da-fabrica): validação de SHAPE do JSON de
// `refino`, além do guard de "é objeto" (F2 acima). Até aqui o merge raso
// aceitava qualquer chave/valor sem checar — uma chave errada (`maxfull` em vez de `maxFull`)
// ou um valor não numérico (`"2"` em vez de `2`) entrava direto no config e só quebrava (ou
// pior, silenciosamente virava `NaN`/string em conta aritmética) dentro do kairos, longe de
// onde o erro nasceu. Cada problema vira um `console.warn` citando a chave e o campo continua
// no padrão — mesma garantia de "nunca derruba o turno por env mal formada" do resto da função.
const CAMPOS_TOPO_NUMERICOS = new Set(['prazoMs', 'prazoGeralMs', 'candidateProvidersForRefine', 'maxActivate']);

// Task (21/09, modo V1): os dois campos de topo NÃO numéricos — validados à parte, antes do
// `CAMPOS_TOPO_NUMERICOS` acima (que só sabe validar número). `aneisComJev`: array não-vazio de
// strings dentre `provider`/`tool`/`skill` (repassado a `refinadoresDoChat({ aneis })`, que só
// aceita esses três — qualquer outra string viraria uma chave sem construtor, silenciosamente
// ignorada do outro lado; melhor recusar aqui, perto de onde a env foi escrita).
// `funcoesNaChamadaDeCapacidades`: boolean puro.
const ANEIS_VALIDOS = new Set(['provider', 'tool', 'skill']);

function aneisComJevValido(valor) {
  return Array.isArray(valor) && valor.length > 0 && valor.every((a) => typeof a === 'string' && ANEIS_VALIDOS.has(a));
}

function numeroFinito(valor) {
  return typeof valor === 'number' && Number.isFinite(valor);
}

// Acabamento do review de qualidade da Fase 2 (item 3, plano 2026-09-21-ajustes-de-uso-da-
// fabrica.md): Task 7 só validava "e numero finito" — um valor absurdo mas finito
// (`corteFull: 70`, `prazoMs: -5`, `maxFull: 2.5`) passava direto e só quebrava (ou virava
// silenciosamente errado) dentro do kairos, longe de onde a env foi escrita. Cada campo tem uma
// faixa coerente com o que consome (`decisoes/src/refinadores/{provider,tool,skill}.js`):
// cortes são probabilidade (`[0, 1]`); tetos/orçamentos são inteiro `>= 0`; prazos são número
// `> 0` (ver também a invariante de `<anel>.prazoMs` vs `prazoMs` de topo, mais abaixo).
const CAMPOS_CORTE = new Set(['corteFull', 'corteCandidate']);
const CAMPOS_INTEIRO_NAO_NEGATIVO = new Set(['maxFull', 'enviar', 'candidateProvidersForRefine', 'maxActivate']);
const CAMPOS_PRAZO = new Set(['prazoMs', 'prazoGeralMs']);

function valorValidoParaCampo(chave, valor) {
  if (CAMPOS_CORTE.has(chave)) return numeroFinito(valor) && valor >= 0 && valor <= 1;
  if (CAMPOS_INTEIRO_NAO_NEGATIVO.has(chave)) return numeroFinito(valor) && Number.isInteger(valor) && valor >= 0;
  if (CAMPOS_PRAZO.has(chave)) return numeroFinito(valor) && valor > 0;
  return numeroFinito(valor);
}

function motivoInvalido(chave, valor) {
  if (CAMPOS_CORTE.has(chave)) return 'fora da faixa [0,1] (e corte/probabilidade)';
  if (CAMPOS_INTEIRO_NAO_NEGATIVO.has(chave)) return 'nao e um inteiro >= 0';
  if (CAMPOS_PRAZO.has(chave)) return 'nao e um numero > 0';
  return 'nao e um numero finito';
}

/**
 * Valida o JSON de um anel (`json.provider`/`.tool`/`.skill`) contra o padrão daquele anel.
 * Campos válidos = as chaves do `PADRAO_*` do anel + `prazoMs` (override só daquele anel, não
 * existe em `PADRAO_*`, ver `REFINO_PADRAO` acima). Anel que não é objeto (string, array,
 * `null`, número): warn e devolve o padrão inteiro. Chave desconhecida: warn e ignora só ela.
 * Valor não numérico finito: warn e mantém o valor do padrão para aquele campo.
 * @param {string} nome nome do anel, só para a mensagem do warn
 * @param {object} padrao `REFINO_PADRAO.<anel>`
 * @param {unknown} valorDoJson `json.<anel>`, pode ser `undefined` (anel não mencionado no objeto de refino)
 */
function validarAnel(nome, padrao, valorDoJson) {
  if (valorDoJson === undefined) return { ...padrao };
  if (typeof valorDoJson !== 'object' || valorDoJson === null || Array.isArray(valorDoJson)) {
    console.warn(`[fabrica] refino.${nome} nao e um objeto, usando o padrao do anel`);
    return { ...padrao };
  }
  const camposValidos = new Set([...Object.keys(padrao), 'prazoMs']);
  const resultado = { ...padrao };
  for (const [chave, valor] of Object.entries(valorDoJson)) {
    if (!camposValidos.has(chave)) {
      console.warn(`[fabrica] refino.${nome}.${chave} e uma chave desconhecida, ignorando`);
      continue;
    }
    if (!valorValidoParaCampo(chave, valor)) {
      console.warn(`[fabrica] refino.${nome}.${chave} ${motivoInvalido(chave, valor)}, mantendo o padrao`);
      continue;
    }
    resultado[chave] = valor;
  }
  return resultado;
}

// Item 2 (acabamento do review de qualidade da Fase 2): os early-returns de `normalizarRefino`
// abaixo devolviam a referência direta de `REFINO_PADRAO` (sem objeto, objeto inválido, valor que não
// é objeto) — um chamador que mutasse o objeto devolvido (ex.: `config.provider.maxFull = 1`)
// corromperia o default compartilhado por toda chamada futura de `normalizarRefino`/
// `refinadoresDoTurno` no processo. `copiaPadrao()` devolve uma cópia RASA por anel, mesmo
// formato do merge feito no caminho feliz mais abaixo.
function copiaPadrao() {
  return {
    ...REFINO_PADRAO,
    provider: { ...REFINO_PADRAO.provider },
    tool: { ...REFINO_PADRAO.tool },
    skill: { ...REFINO_PADRAO.skill },
    aneisComJev: [...REFINO_PADRAO.aneisComJev],
  };
}

/**
 * Valida e completa o objeto de refino que o HOST leu (do env, de arquivo, de painel): `undefined` = sem configuração, vale
 * o padrão (sem aviso); `{ provider?, tool?, skill?, prazoMs?, ... }` mescla RASO por anel por cima de `REFINO_PADRAO`.
 * Valor fora do formato (não é objeto, chave desconhecida, número fora da faixa, anel mal formado) avisa por `console.warn`
 * e o campo fica no padrão — nunca derruba o turno por configuração mal formada. Não lê `process.env` nem faz
 * `JSON.parse`: o host entrega o objeto pronto (era `configDeRefino(env)` no Igris, que lia a env e o JSON).
 * @param {object} [json]
 * @returns {typeof REFINO_PADRAO}
 */
export function normalizarRefino(json) {
  if (json === undefined) return copiaPadrao();
  // F2 (correção da revisão final do conjunto): o que não é objeto simples (`null`, array, string, número) não é o
  // `{ provider?, tool?, skill?, ... }` que o merge abaixo espera — sem este guard o spread de um array produziria um objeto
  // com chaves numéricas, silenciosamente errado. Mesma garantia do resto da função: nunca derruba o turno, só avisa.
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    console.warn('[fabrica] refino nao e um objeto, usando defaults:', json);
    return copiaPadrao();
  }
  const resultado = {
    ...REFINO_PADRAO,
    provider: validarAnel('provider', REFINO_PADRAO.provider, json.provider),
    tool: validarAnel('tool', REFINO_PADRAO.tool, json.tool),
    skill: validarAnel('skill', REFINO_PADRAO.skill, json.skill),
    aneisComJev: [...REFINO_PADRAO.aneisComJev],
  };
  for (const [chave, valor] of Object.entries(json)) {
    if (chave === 'provider' || chave === 'tool' || chave === 'skill') continue;
    if (chave === 'aneisComJev') {
      if (!aneisComJevValido(valor)) {
        console.warn(`[fabrica] refino.aneisComJev nao e um array nao-vazio de 'provider'/'tool'/'skill', usando o padrao`);
        continue;
      }
      resultado.aneisComJev = [...valor];
      continue;
    }
    if (chave === 'funcoesNaChamadaDeCapacidades') {
      if (typeof valor !== 'boolean') {
        console.warn('[fabrica] refino.funcoesNaChamadaDeCapacidades nao e boolean, usando o padrao');
        continue;
      }
      resultado.funcoesNaChamadaDeCapacidades = valor;
      continue;
    }
    if (!CAMPOS_TOPO_NUMERICOS.has(chave)) {
      console.warn(`[fabrica] refino.${chave} e uma chave de topo desconhecida, ignorando`);
      continue;
    }
    if (!valorValidoParaCampo(chave, valor)) {
      console.warn(`[fabrica] refino.${chave} ${motivoInvalido(chave, valor)}, mantendo o padrao`);
      continue;
    }
    resultado[chave] = valor;
  }
  // Item 3 (acabamento): a invariante documentada em REFINO_PADRAO acima — `<anel>.prazoMs + 50
  // <= prazoMs` (topo, o teto do kairos/`refinerBudgetMs`) — precisa continuar valendo depois do
  // merge da env, senão o prazo interno do anel nunca vence a corrida contra o timer de fundo do
  // motor (MARGEM_MS, `criar-refinador-jev.js`) e o anel degrada (timeout) mesmo respondendo a
  // tempo. Quando a env deixa algum anel violar a invariante contra o TOPO que o usuário mexeu,
  // quem se corrige é o TETO GLOBAL (`prazoMs` de topo volta ao padrão, 1600) — não os anéis:
  // cada `<anel>.prazoMs` pode ter vindo válido por si só (já passou por `valorValidoParaCampo`
  // acima), então não há por que descartar um override válido só porque o topo mudou.
  //
  // Acabamento do review final: o warn acima prometia "o teto global volta ao padrao" mesmo
  // quando o topo JÁ ERA o padrão (ex.: `{"skill":{"prazoMs":2000}}` sem tocar `prazoMs` de
  // topo) — resetar o topo para o próprio valor que já tinha não corrige nada, e o warn mentia.
  // Regra: só reseta o TOPO quando ele não era o padrão (o usuário de fato mexeu nele); depois
  // de resetar (ou quando o topo já era o padrão desde o início), RE-CHECA cada anel contra o
  // topo final — quem ainda viola a invariante mesmo com o topo no padrão é porque o próprio
  // `<anel>.prazoMs` está alto demais, e quem se corrige então é O ANEL (volta ao padrão daquele
  // anel), com um warn dizendo isso, não mais o topo.
  const topoEraPadrao = resultado.prazoMs === REFINO_PADRAO.prazoMs;
  let invarianteViolada = false;
  for (const anel of ['provider', 'tool', 'skill']) {
    const prazoDoAnel = resultado[anel].prazoMs;
    if (prazoDoAnel + 50 > resultado.prazoMs) {
      // Topo ja no padrao: quem avisa e o segundo laco (o remedio e no anel, nao no topo).
      if (!topoEraPadrao) console.warn(`[fabrica] refino: ${anel}.prazoMs (${prazoDoAnel}) + 50 > prazoMs de topo (${resultado.prazoMs}) — o teto global volta ao padrao`);
      invarianteViolada = true;
    }
  }
  if (invarianteViolada && !topoEraPadrao) resultado.prazoMs = REFINO_PADRAO.prazoMs;
  for (const anel of ['provider', 'tool', 'skill']) {
    const prazoDoAnel = resultado[anel].prazoMs;
    if (prazoDoAnel + 50 > resultado.prazoMs) {
      console.warn(`[fabrica] refino: ${anel}.prazoMs (${prazoDoAnel}) + 50 > prazoMs de topo (${resultado.prazoMs}) mesmo com o topo ja no padrao — o prazo do anel ${anel} volta ao padrao (${REFINO_PADRAO[anel].prazoMs})`);
      resultado[anel].prazoMs = REFINO_PADRAO[anel].prazoMs;
    }
  }
  return resultado;
}

// Anéis cuja lista de itens é idêntica nos dois `discover` de um turno (I3a): memoizáveis.
// `tool` fica fora — ver o JSDoc abaixo.
const ANEIS_MEMOIZAVEIS = new Set(['provider', 'skill']);

/**
 * Monta os três refinadores do chat (`provider`/`tool`/`skill`) com o cliente de decisões do
 * TURNO — chamado a cada turno em `turno.js`, nunca uma vez só na criação da instância do
 * orquestrador: o cliente do Jev é reavaliado por turno (o gateway pode ficar pronto no meio de
 * uma sessão já aberta), então a função de refino não pode ficar presa à que existia quando o
 * `orq` foi criado/reusado — mesmo motivo de `embedderAtual`/`clienteDeDecisao` em `turno.js`.
 * Sem `cliente` (sem gateway, sem conta), `refinadoresDoChat` devolve `{}` — nenhum anel é
 * substituído, o kairos decide sozinho (R1: "sem `refiners`, saída idêntica à de antes").
 *
 * F1 (correção da revisão final do conjunto) + N1 (correção do re-review final): MEMOIZADO por
 * turno, mas SÓ para `provider` e `skill` — NUNCA para `tool`. I3a (`turno.js`/`index.js` do
 * orquestrador, bloco "I3a") pode disparar um SEGUNDO `bridge.prepareTurn` quando o discover
 * sugere a skill de um provider ainda não carregado — esse segundo `prepareTurn` roda um SEGUNDO
 * `discover()` completo, que chama de novo CADA anel com refinador registrado (até 3 chamadas a
 * mais ao Jev, até +800ms medidos). O texto do turno (`input.query.text`) não muda entre as duas
 * chamadas do MESMO anel no MESMO turno, mas o UNIVERSO de itens que cada anel avalia muda de
 * forma diferente por anel:
 * - `provider`: a lista de providers candidatos não lê `state.loadedProviders` — o segundo
 *   `discover` avalia os MESMOS providers do primeiro. Memoizar é seguro: a resposta do Jev
 *   para "isto é relevante para este pedido" continua válida porque a pergunta não mudou.
 * - `skill`: as skills vêm do registry global, também não mudam entre os dois `discover` do
 *   mesmo turno. Mesma garantia.
 * - `tool`: MUDA. O provider promovido pelo I3a entra em `state.loadedProviders` antes do
 *   segundo `discover`, e o motor do kairos hidrata as tools DESSE provider com
 *   `proposedTier: 'full'` — elas só existem na segunda chamada, não na primeira. Se a resposta
 *   do primeiro `discover` (memoizada) fosse reusada, essas tools novas nunca apareceriam nos
 *   `items` que o refinador de `tool` avalia — e por R2 (regra do kairos: item fora do universo
 *   que o refinador viu vira `discard`), elas seriam descartadas e NUNCA hidratadas, mesmo tendo
 *   sido promovidas. Por isso `tool` precisa perguntar ao Jev de novo a cada `discover` — é o
 *   único anel cujo universo de itens cresce dentro do mesmo turno.
 * Cache por `${anel}\n${texto}`: um `Map` criado aqui dentro, uma vez por CHAMADA desta função —
 * como `turno.js` chama `refinadoresDoTurno` uma vez por turno (nunca reusa a função entre
 * turnos: `sessao.turnoAtual.refinadores` é reatribuído a cada turno, `turno.js:372`), o cache
 * nasce vazio a cada turno e nunca vaza para o próximo. Guarda a PROMISE da primeira chamada (não
 * o resultado já resolvido) — duas chamadas concorrentes ao mesmo anel/texto (não deveria
 * acontecer dentro de um `prepareTurn`, mas não custa) reusam a mesma promise em voo em vez de
 * disparar duas chamadas ao cliente.
 * Cache de respostas do Jev POR TURNO (Task 3, 2026-09-21-ajustes-de-uso-da-fabrica): criado
 * aqui dentro, uma vez por chamada desta função (um turno) — chave é o `ref` do kairos
 * (`<capacidadeId>/tool/<nome>` para funções), valor o `noul` numérico respondido. O anel
 * `provider` GRAVA nele (via `funcoesDe`: pergunta pelas funções de cada capacidade enviada, na
 * MESMA chamada ao Jev, `aoResponderExtras` grava cada resposta); o anel `tool` LÊ — item do
 * anel `tool` com resposta já no cache não é perguntado de novo ao Jev (explain termina em
 * `(cache)`, ver `criarRefinadorJev`). Como `turno.js` chama `refinadoresDoTurno` uma vez por
 * turno (nunca reusa entre turnos), o cache nasce vazio a cada turno e nunca vaza para o
 * próximo (mesma garantia da memoização de `ANEIS_MEMOIZAVEIS` abaixo, motivo diferente).
 * @param {{ cliente: {decidir:Function}|null, config?: typeof REFINO_PADRAO, aoChegarTarde?: (t: { anel: string, msReal: number, ms: number, degradado: false|string }) => void, funcoesDe?: (capacidadeId: string) => Array<{ ref: string, descricao?: string, pinned?: boolean }>, capacidadesDePiso?: () => string[], conversaDoHost?: () => Array<{ papel: 'usuario'|'assistente', texto: string }>, consultasAnterioresDoHost?: () => Array<{ funcao: string, args?: object, ok: boolean }>, aoChamarJev?: (registro: object) => void }} p
 *   `aoChegarTarde` (21/09): diagnóstico da resposta tardia do Jev — chamado por anel quando a
 *   resposta chega depois do prazo interno, com a latência real (`msReal`); `turno.js` guarda
 *   em `refino.porAnel[anel].msReal` no artefato. Repassado como está, sem memoização (é evento,
 *   não resultado). `funcoesDe` (Task 3): catálogo de funções por capacidade, do host
 *   (`turno.js`) — repassado ao anel `provider` só quando `config.funcoesNaChamadaDeCapacidades`
 *   é `true` (modo combinado; default `false`, modo V1, ver `REFINO_PADRAO.aneisComJev` acima).
 *   `capacidadesDePiso` (23/09, ajuste pontual): getter dos ids de capacidade de PISO do host
 *   (`turno.js`) — repassado ao anel `provider` sem memoização (lido a cada chamada, mesmo
 *   motivo de `funcoesDe`), para cobrir as funções do piso na mesma chamada ao Jev mesmo no
 *   primeiro turno de refino da sessão, quando `state.loadedProviders` ainda está vazio (ver
 *   JSDoc de `refinadorDeCapacidades`, `decisoes/src/refinadores/provider.js`).
 *   `config.aneisComJev` decide quais anéis ganham a chave no objeto devolvido — anel de fora
 *   nunca chama o Jev, o kairos decide pelo score sozinho.
 *   `aoChamarJev` (2026-09-23, instrumentação completa — decisão do dono: "tudo que a fábrica
 *   faz tem que ir para o Tracer"): repassado intacto aos TRÊS anéis (`refinadoresDoChat`,
 *   `./index.js`) — cada chamada de volta já identifica QUAL anel foi
 *   (`registro.anel`). `turno.js` é quem usa isto de verdade: acumula o registro bruto
 *   (state/questions/answers/meta, itens enviados/do cache, tier final) no artefato do turno e
 *   publica um evento na timeline da sessão.
 *   `conversaDoHost` (2026-09-23): getter das mensagens de conversa do TURNO (`sessao.turnoAtual.
 *   conversa`, `turno.js` — mesmo array que `configDoLoop` alimenta no loop), lido a cada chamada
 *   como `funcoesDe`/`capacidadesDePiso` (o valor só existe depois que `turno.js` computa o
 *   histórico, mas os TRÊS refinadores já foram criados antes disso no turno). Vira
 *   `estadoDoHost(input) => { conversa }` para os três anéis (provider/tool/skill compartilham o
 *   MESMO `estadoDoHost`, `refinadoresDoChat` abaixo) — é o gancho que já existia (`estadoDoHost:
 *   () => null` antes desta mudança), primeiro campo a cair no corte de 16k chars de
 *   `montarEstado` (`criar-refinador-jev.js`), antes de `itens`/`extras`.
 *   `consultasAnterioresDoHost` (Melhoria A, 2026-09-23, spec §4.1 addendum): getter das
 *   consultas de leitura de turno(s) anteriores (`sessao.turnoAtual.consultasAnteriores`,
 *   `turno.js` — mesmo dado que `config.loop` passa a `rodarLoop`, "o mesmo dado nos dois
 *   pontos" pedido pela spec), lido a cada chamada como `conversaDoHost`. Entra em
 *   `estadoDoHost(input)` junto de `conversa` — os TRÊS anéis veem os dois campos no mesmo
 *   `contexto`. NENHUM anel muda `pergunta`/`classificar` por causa disto nesta entrega: os três
 *   anéis só decidem RELEVÂNCIA (full/candidate/discard de uma capacidade/função/skill), nunca
 *   valor de argumento — quem usa `consultasAnteriores` para herdar argumento é só o loop
 *   (`decisoes/src/loop/passo.js`). Adicionar um texto persuasivo ao `pergunta` de um anel
 *   por causa de um campo novo no estado é o tipo de mudança que `provider.js` (`classificar`,
 *   comentário de 23/09 sobre `corteFullContinuacao`) já mediu como NÃO confiável contra o Jev
 *   real (efeito dentro do ruído, ~±0,1) — por isso o dado entra no estado (visível, e o Jev pode
 *   usá-lo se achar relevante para julgar continuidade de assunto), mas o TEXTO da pergunta de
 *   cada anel fica intocado nesta entrega; se uma calibração futura medir ganho real, ela edita
 *   `pergunta()` em `provider.js`/`tool.js`/`skill.js` com a mesma disciplina de medição (Jev
 *   real, antes/depois, sem regressão) que os outros ajustes deste arquivo já seguem.
 * @returns {{ provider?: Function, tool?: Function, skill?: Function }}
 */
export function refinadoresDoTurno({ cliente, config = normalizarRefino(), aoChegarTarde, funcoesDe, capacidadesDePiso, conversaDoHost, consultasAnterioresDoHost, aoChamarJev }) {
  // Contrato do cache: ver JSDoc acima e "Contratos novos" do plano. `Map` simples — nada aqui
  // precisa sobreviver além do escopo desta chamada (fechado pelas closures devolvidas abaixo).
  const cacheDeRespostas = new Map();
  // Correção do review da Fase 1 (#9): `tamanho()` era código morto — nenhum chamador lia.
  const cache = {
    obter: (ref) => cacheDeRespostas.get(ref),
    gravar: (ref, valorNoul) => { cacheDeRespostas.set(ref, valorNoul); },
  };
  const refinadores = refinadoresDoChat({
    cliente,
    config: { provider: config.provider, tool: config.tool, skill: config.skill, funcoesNaChamadaDeCapacidades: config.funcoesNaChamadaDeCapacidades },
    // Modo V1 (21/09): `aneisComJev` (default `['provider', 'skill']`, ver REFINO_PADRAO acima)
    // decide quais anéis o Jev decide — `tool` de fora por padrão, o kairos decide pelo score.
    aneis: config.aneisComJev,
    prazoMs: config.prazoMs,
    aoChegarTarde,
    aoChamarJev,
    funcoesDe,
    capacidadesDePiso,
    cache,
    // 2026-09-23: a conversa da sessão (mensagens anteriores, texto puro — `conversaDoHost`,
    // `turno.js`) é hoje o único estado de host que os três anéis recebem. Sem ela (getter
    // ausente, ou turno sem histórico) volta ao `null` de antes ("nada extra", que
    // `criarRefinadorJev` já trata como `estadoDoHost` opcional).
    estadoDoHost: () => {
      const conversa = typeof conversaDoHost === 'function' ? conversaDoHost() : null;
      const consultasAnteriores = typeof consultasAnterioresDoHost === 'function' ? consultasAnterioresDoHost() : null;
      const extra = {};
      if (conversa?.length) extra.conversa = conversa;
      if (consultasAnteriores?.length) extra.consultasAnteriores = consultasAnteriores;
      return Object.keys(extra).length ? extra : null;
    },
  });
  // Sem cliente: `refinadores` é `{}` — nada a memoizar, devolve como está (mesmo formato de
  // antes, R1 intacto).
  if (Object.keys(refinadores).length === 0) return refinadores;
  const cacheDeMemoizacao = new Map();
  const memoizados = {};
  for (const anel of Object.keys(refinadores)) {
    if (!ANEIS_MEMOIZAVEIS.has(anel)) {
      // `tool`: sem memoização (N1) — o universo de itens cresce entre o primeiro e o segundo
      // `discover` do mesmo turno (I3a), então cada chamada precisa perguntar ao Jev de novo.
      memoizados[anel] = refinadores[anel];
      continue;
    }
    memoizados[anel] = (input) => {
      const chave = `${anel}\n${input?.query?.text ?? ''}`;
      if (!cacheDeMemoizacao.has(chave)) cacheDeMemoizacao.set(chave, refinadores[anel](input));
      return cacheDeMemoizacao.get(chave);
    };
  }
  return memoizados;
}

/**
 * 21/09: mescla as respostas tardias do Jev (latência real) no `refino` do artefato —
 * `porAnel[anel].msReal` (e `msPrazo`, o instante em que o refinador desistiu). Não cria anel
 * que o kairos não reportou; sem `refino` (turno `unchanged`/sem refino) devolve como veio.
 * @param {object|null} refino
 * @param {Record<string, { msReal: number, ms: number, degradado: false|string }>} tardias
 */
export function comTardias(refino, tardias) {
  if (!refino?.porAnel || !tardias || Object.keys(tardias).length === 0) return refino;
  const porAnel = { ...refino.porAnel };
  for (const [anel, t] of Object.entries(tardias)) {
    if (!porAnel[anel]) continue;
    porAnel[anel] = { ...porAnel[anel], msReal: t.msReal ?? null, msPrazo: t.ms ?? null };
  }
  return { ...refino, porAnel };
}

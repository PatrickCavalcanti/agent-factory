// packages/decisions/src/refinadores/index.js
//
// Construtor genérico de refinador de anel do kairos (Task 6, spec 4 §3.2/R9) + as três
// instâncias concretas (Task 7: provider/tool/skill) + `refinadoresDoChat`, que a fábrica do
// chat (`packages/executor/.../fabrica/decisor.js`) chama para montar o conjunto que vai
// para `criarOrquestrador({ refinadores })`.
export { criarRefinadorJev } from './criar-refinador-jev.js';
export { refinadorDeCapacidades, PADRAO_PROVIDER } from './provider.js';
export { refinadorDeFuncoes, PADRAO_TOOL } from './tool.js';
export { refinadorDeHabilidades, PADRAO_SKILL } from './skill.js';

// `export {...} from` acima só reexporta — não cria binding local; refinadoresDoChat precisa
// dos três construtores no próprio escopo do módulo, daí o import redundante com as linhas
// de cima.
import { refinadorDeCapacidades } from './provider.js';
import { refinadorDeFuncoes } from './tool.js';
import { refinadorDeHabilidades } from './skill.js';

/**
 * Monta os refinadores do chat com um único cliente de decisões (gateway). Sem cliente
 * (sem gateway configurado) devolve `{}` — nenhum refinador é injetado e o kairos monta como
 * hoje (J0 continua, R9). `config` espelha o shape de `refino` da fábrica:
 * `{ provider: {...}, tool: {...}, skill: {...} }`, cada um repassado como o `config` de
 * cada construtor concreto (defaults por anel se omitido); `config.<anel>.prazoMs`, quando
 * presente, vence o `prazoMs` global só para aquele anel (Task 2, 2026-09-21).
 *
 * `aneis` (21/09): quais anéis o Jev decide, dos três (`provider`/`tool`/`skill`). Default
 * `['provider', 'tool', 'skill']` (os três, comportamento de sempre neste construtor genérico —
 * quem escolhe o modo V1, com `tool` de fora, é o default de `aneisComJev` da fábrica do chat,
 * `packages/executor/.../fabrica/refinadores.js`). Anel fora da lista não é construído — a
 * chave correspondente não existe no objeto devolvido, e o kairos cai no fallback "aceita a
 * proposta do motor" para aquele anel (mesmo efeito de nunca ter tido cliente PARA ele).
 *
 * `config.funcoesNaChamadaDeCapacidades` (default `false`, modo V1): quando `true`, o anel
 * `provider` também pergunta pelas funções das capacidades enviadas NA MESMA chamada ao Jev
 * (via `funcoesDe`/`cache`, Task 2) — é o que permite ao anel `tool` reaproveitar a resposta do
 * cache em vez de perguntar de novo. Com a flag em `false` (default), `funcoesDe`/`cache` NÃO
 * são repassados ao anel `provider` mesmo que o chamador os informe — a chamada ao Jev fica só
 * com as `cap_*` (medição de 21/09: a chamada combinada, capacidades + ~30 funções, estourava o
 * prazo e o custo crescia com perguntas em voo).
 * @param {object} p
 * @param {{decidir:Function}|null} p.cliente
 * @param {{provider?: object, tool?: object, skill?: object, funcoesNaChamadaDeCapacidades?: boolean}} [p.config]
 * @param {Array<'provider'|'tool'|'skill'>} [p.aneis] quais anéis construir (default `['provider', 'tool', 'skill']`)
 * @param {number} [p.prazoMs]
 * @param {(input: object) => object|null} [p.estadoDoHost]
 * @param {(t: { anel: string, msReal: number, ms: number, degradado: false|string }) => void} [p.aoChegarTarde]
 *   diagnóstico da resposta tardia do Jev, por anel (ver `criarRefinadorJev`)
 * @param {(capacidadeId: string) => Array<{ ref: string, descricao?: string, pinned?: boolean }>} [p.funcoesDe]
 *   Task 2: catálogo de funções por capacidade (host) — repassado ao anel `provider` só quando
 *   `config.funcoesNaChamadaDeCapacidades === true`, que pergunta pelas funções das capacidades
 *   enviadas na MESMA chamada ao Jev.
 * @param {{ obter: (ref: string) => number|undefined, gravar: (ref: string, noul: number) => void }} [p.cache]
 *   Task 2: cache de respostas por turno. O anel `provider` GRAVA as respostas das funções que
 *   perguntou via `funcoesDe` (mesma condição da flag acima: só chega ao anel `provider` com
 *   `config.funcoesNaChamadaDeCapacidades === true`). O anel `tool` sempre recebe `cache` (sem
 *   gate de flag) — LÊ (item com resposta no cache não é perguntado de novo) e, 22/09, também
 *   GRAVA as próprias respostas de volta (`tool.js`/`refinadorDeFuncoes`, gancho `aoResponder` de
 *   `criarRefinadorJev`): uma segunda chamada ao anel `tool` no mesmo turno (ex.: o segundo
 *   `discover` do I3a) só pergunta pelos `ref`s que ainda não têm resposta em nenhum dos dois.
 * @param {(registro: object) => void} [p.aoChamarJev] instrumentação completa (2026-09-23):
 *   repassado, sem memoização/transformação nenhuma, aos TRÊS anéis — cada chamada de
 *   `criarRefinadorJev` (ver JSDoc lá) chama de volta com `anel` já identificando quem foi.
 * @param {() => string[]} [p.capacidadesDePiso]
 *   23/09 (ajuste pontual): ids de capacidade de PISO conhecidos pelo host — repassado ao anel
 *   `provider` (`refinadorDeCapacidades`), que os usa para cobrir as funções do piso na MESMA
 *   chamada ao Jev mesmo no PRIMEIRO turno de refino da sessão, quando `input.state?.
 *   loadedProviders` ainda está vazio (a descoberta só o populada depois). Ver JSDoc de
 *   `refinadorDeCapacidades` em `provider.js`.
 */
export function refinadoresDoChat({ cliente, config = {}, aneis = ['provider', 'tool', 'skill'], prazoMs, estadoDoHost, aoChegarTarde, funcoesDe, cache, capacidadesDePiso, aoChamarJev } = {}) {
  if (!cliente) return {};
  const comFuncoesNaCapacidade = config.funcoesNaChamadaDeCapacidades === true;
  const construtores = {
    provider: () => refinadorDeCapacidades({
      cliente,
      config: config.provider,
      prazoMs,
      estadoDoHost,
      aoChegarTarde,
      aoChamarJev,
      funcoesDe: comFuncoesNaCapacidade ? funcoesDe : undefined,
      cache: comFuncoesNaCapacidade ? cache : undefined,
      capacidadesDePiso: comFuncoesNaCapacidade ? capacidadesDePiso : undefined,
    }),
    tool: () => refinadorDeFuncoes({ cliente, config: config.tool, prazoMs, estadoDoHost, aoChegarTarde, cache, aoChamarJev }),
    skill: () => refinadorDeHabilidades({ cliente, config: config.skill, prazoMs, estadoDoHost, aoChegarTarde, aoChamarJev }),
  };
  const refinadores = {};
  for (const anel of aneis) {
    if (construtores[anel]) refinadores[anel] = construtores[anel]();
  }
  return refinadores;
}

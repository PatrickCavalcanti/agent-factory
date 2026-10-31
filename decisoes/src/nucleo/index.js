// packages/decisions/src/nucleo/index.js
//
// Núcleo genérico "estado + perguntas → respostas" (N1–N3, adendo §15 da spec): qualquer
// módulo que precise de uma decisão orientada por LLM — não só a hidratação do Jev — importa
// daqui (`@igris/decisions/nucleo`). Ver docs/project-architecture/decisions.md (Task 0.3)
// para o contrato completo e um exemplo guiado ("quais memórias carregar").
//
// `criarCliente` (cliente HTTP do endpoint de decisões) e `criarFetchKeepAlive`/`aquecer`
// (transporte com keep-alive) já eram genéricos — não conhecem tool/power (P1) — e
// continuam em `../cliente.js`/`../transporte.js`, reexportados aqui sem mudança: mover o
// código arriscaria os testes que os importam direto (`test/cliente.test.js`,
// `test/transporte.test.js`).
//
// Task 0.2 (N3): `criarProvedorDeCliente` (nucleo/provedor.js) envolve os dois acima com
// cache/retry/aquecimento — cliente compartilhado, uma instância registrada no
// `@igris/executor-registry` (`setDecisionsClientProvider`/`getDecisionsClientProvider`).
export { perguntar, TETO_TARDIO_MS } from './perguntar.js';
export { choice, noul, score, TETO_PERGUNTAS, ErroDeForma } from './formas.js';
export { cortarEstado } from './estado.js';
export { criarProvedorDeCliente } from './provedor.js';
export { criarCliente } from '../cliente.js';
export { criarFetchKeepAlive, aquecer } from '../transporte.js';

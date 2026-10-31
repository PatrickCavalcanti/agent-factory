// packages/decisions/src/loop/index.js — loop de decisão do Jev (spec 2026-09-22).
export { rodarLoop, resumirResultado, ORCAMENTO_PADRAO, CORTE_ACAO_PADRAO, CORTE_FIM_PADRAO, PISO_EXECUCAO, PISO_ESCRITA, K_PADRAO } from './rodar-loop.js';
export {
  perguntasDoPasso, lerPasso, chaveDeArg, ACAO_PRONTO, ACAO_BLOQUEADO, PREFIXO_CARREGAR, MAIS_SIM, MAIS_NAO,
} from './passo.js';

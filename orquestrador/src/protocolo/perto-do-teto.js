// O que o modelo recebe uns turnos antes do teto de iterações (`forceFinishMessage`). Encerrar é certo;
// encerrar MUDO, não: o usuário (que pode ser um cliente, não o dono) vê o trabalho parar sem saber por
// quê. Decisão do dono, 2026-10-28, depois de um vídeo que parou com "ainda não gerei o MP4" sem explicação.
// A mesma ideia para o PRAZO de tempo da mensagem (pipeline, etapa `execute`): entra pela fila intra-turno
// alguns minutos antes de vencer, porque estourar o prazo aborta o turno no meio e vira erro sem explicação.
export const AVISO_PERTO_DO_PRAZO = [
  '[Aviso do sistema] O tempo desta mensagem está acabando: faltam poucos minutos.',
  'Não comece nenhuma etapa longa (render, download, instalação).',
  'Encerre o turno agora avisando o usuário, em linguagem simples, que o tempo desta mensagem chegou ao fim;',
  'diga em poucas linhas o que já ficou pronto e quais etapas faltam, e pergunte se pode continuar',
  '(basta ele responder "continua"). Se terminou, só entregue o resultado.',
].join(' ');

export const AVISO_PERTO_DO_TETO = [
  'Você chegou perto do limite de passos desta mensagem: não chame mais nenhuma tool.',
  'Encerre o turno avisando o usuário, em linguagem simples, que o limite de passos desta mensagem chegou.',
  'Se o trabalho ainda não terminou, diga em poucas linhas o que já ficou pronto e quais etapas faltam,',
  'e pergunte se pode continuar (basta ele responder "continua"). Se terminou, só entregue o resultado.',
].join(' ');

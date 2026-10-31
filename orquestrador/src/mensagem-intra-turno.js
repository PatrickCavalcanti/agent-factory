/**
 * Enquadramento da mensagem do usuário que chega com o turno em andamento
 * (spec 2026-10-28 mensagem intra-turno §4.2). O genos chama isto na fronteira
 * entre iterações com as mensagens drenadas; o resultado vira UMA mensagem `user`.
 * @param {Array<{id: string, content: string}>} mensagens
 * @returns {string}
 */
export function formatarMensagensIntraTurno(mensagens) {
  // Aviso do próprio Igris (ex.: prazo da mensagem acabando) usa a mesma fila, mas NÃO é do usuário.
  const doSistema = mensagens.filter((m) => m?.metadata?.sistema);
  const doUsuario = mensagens.filter((m) => !m?.metadata?.sistema);
  const partes = [];
  if (doUsuario.length) {
    partes.push(
      '[Mensagem do usuário enviada enquanto você trabalhava]',
      ...doUsuario.map((m, i) => `${i + 1}. "${String(m.content ?? '')}"${m?.metadata?.modoVoz === 'conversa' ? ' (enviada durante a conversa por voz)' : ''}`),
      'Vem do usuário, não de uma ferramenta. Avalie se ela muda o que você está fazendo e decida como tratar (agora, junto do que já faz, ou no fim), sem refazer o que já foi feito. Na sua próxima fala, deixe claro que recebeu e entendeu a mensagem, com as suas palavras; nunca repita a mensagem. Se ela não muda nada (um "ok", um "isso"), siga sem comentar.',
    );
  }
  for (const m of doSistema) partes.push(String(m.content ?? ''));
  return partes.join('\n');
}

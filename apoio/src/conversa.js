// packages/executor/src/orchestration/fabrica/conversa.js
//
// Contexto da CONVERSA para o Jev (2026-09-23): tanto o loop de decisão (`loop.js`) quanto os
// refinadores por anel (`refinadores.js`) mandavam ao Jev só a mensagem atual — sem nada dos
// turnos anteriores, ele não resolve referências ("e depois de amanhã?", "e da lista de
// contas?", "marca a primeira") nem herda filtro/período já citado antes ("e a da OKDS?" perdia
// `periodo:"semana"`, medido na bancada ampliada, categoria 7: 10/15).
//
// `conversaDoHistorico` é o ÚNICO helper — mesmo recorte para os dois consumidores (`turno.js`
// chama uma vez por turno e guarda o resultado em `sessao.turnoAtual.conversa`, lido por ambos).
// Extrai só o TEXTO que o usuário viu na tela (a bolha de chat), nunca chamada/resultado de
// tool: `ctx.processedMessages[i].content` já é esse texto — `prepareIncomingAttachments.js`
// copia `msg.content` direto do transcript que o frontend reenvia (o mesmo que
// `ctx.response`/`respostaFinal`, `turno.js`, grava como resposta do assistente), sem envelope
// nem bloco de operações (esse só entra depois, em `stitchOperations`, para o PROMPT do modelo —
// nunca para este canal). `_fala?.text` é o fallback defensivo para uma mensagem que, por algum
// canal (voz, replay), guardou o texto falado em vez de `content` — não observado hoje em
// `ctx.processedMessages`, mas mais barato checar aqui do que deixar a referência cair muda.
const PAPEL_POR_ROLE = { user: 'usuario', assistant: 'assistente' };

// Defaults (2026-09-23, a calibrar contra a bancada real — ver report do plano):
// - `maxMensagens: 6` — 3 idas e vindas. Suficiente para os casos de continuação medidos
//   ("e a da OKDS?", "confere se ela ainda está pendente") — a referência sempre mira o turno
//   imediatamente anterior; ir além disso é custo sem ganho medido e mais chance de o Jev
//   herdar um filtro de um assunto já encerrado.
// - `maxChars: 3000` — cabe folgado dentro do teto de 16.000 chars do `state` (loop e cada anel
//   de refino, `TETO_CHARS_ESTADO`), ao lado de `rastro`/`itens`/`pedido`, sem forçar o corte a
//   sacrificar o resto do estado por causa da conversa.
export const LIMITES_CONVERSA_PADRAO = Object.freeze({ maxMensagens: 6, maxChars: 3000 });

function textoVisivel(mensagem) {
  if (typeof mensagem?.content === 'string' && mensagem.content.trim()) return mensagem.content.trim();
  const fala = mensagem?._fala?.text;
  if (typeof fala === 'string' && fala.trim()) return fala.trim();
  return '';
}

/**
 * @param {Array<{role?: string, content?: string, _fala?: {text?: string}}>} mensagens histórico
 *   BRUTO (sem a mensagem do turno atual — quem chama corta), na ordem em que chegaram (mais
 *   antiga primeiro). Tool call/resultado não tem `role` `user`/`assistant` — descartado por
 *   construção (só os dois roles entram).
 * @param {{ maxMensagens?: number, maxChars?: number }} [limites]
 * @returns {Array<{ papel: 'usuario'|'assistente', texto: string }>} mais antiga primeiro, só
 *   texto — corta do MAIS ANTIGO (início) para caber nos dois limites.
 */
export function conversaDoHistorico(mensagens, limites = {}) {
  const maxMensagens = Number.isFinite(limites.maxMensagens) && limites.maxMensagens >= 0
    ? limites.maxMensagens : LIMITES_CONVERSA_PADRAO.maxMensagens;
  const maxChars = Number.isFinite(limites.maxChars) && limites.maxChars >= 0
    ? limites.maxChars : LIMITES_CONVERSA_PADRAO.maxChars;
  if (!Array.isArray(mensagens) || maxMensagens <= 0 || maxChars <= 0) return [];

  const itens = [];
  for (const m of mensagens) {
    const papel = PAPEL_POR_ROLE[m?.role];
    if (!papel) continue;
    const texto = textoVisivel(m);
    if (!texto) continue;
    itens.push({ papel, texto });
  }

  // Corte 1 (quantidade): fica só com as `maxMensagens` mais RECENTES — descarta do início.
  let recorte = itens.length > maxMensagens ? itens.slice(itens.length - maxMensagens) : itens;

  // Corte 2 (tamanho): remove do início (mais antiga) até caber em `maxChars` somados.
  let total = recorte.reduce((soma, it) => soma + it.texto.length, 0);
  while (recorte.length > 0 && total > maxChars) {
    total -= recorte[0].texto.length;
    recorte = recorte.slice(1);
  }
  return recorte;
}

// Registro de casos do treino contínuo (spec 2026-10-07): JSONL com limite + estado (contador, cursor e backoff POR ANEL).
// Nenhuma função lança por I/O: devolve {ok:false, erro} ou o padrão.
//
// PREMISSA: processo único. Só o app grava o registro (um turno por vez dispara `aposTurno`) e a leitura-modifica-
// escreve do `estado.json` não tem trava entre processos. Dois processos gravando o mesmo `dir` podem perder um
// incremento do contador (o arquivo de casos, por ser append, sobrevive).
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, fstatSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { open as abrirAsync } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const ARQ_CASOS = 'casos.jsonl';
const ARQ_ESTADO = 'estado.json';
const FOLGA = 1.2; // só rotaciona quando passa de tamanho * 1.2 (evita reescrever a cada gravação)
const BLOCO = 64 * 1024;

/** Anéis que têm contador e cursor próprios (cada um consome o registro no seu ritmo). */
export const ANEIS_DO_REGISTRO = Object.freeze(['provider', 'tool']);
/**
 * `adiada` = motivo de espera persistente do anel (ex. `sem-base`: falta o treino completo), só informativo. `validos` = válidos desde a última atualização DO ANEL;
 * `cursor` = ts do último consumido e `ids` = chaves dos casos com esse ts; `falhas`/`tentativaEm` = backoff.
 * `avaliacao` = `{ n:number|null, minimo:number }` enquanto `adiada` é falta de casos de avaliação (quantos há × quantos o portão exige; `n` null =
 * o lote não informou); `null` fora desse adiamento. Contrato lido pela conferência.
 */
const anelPadrao = () => ({ validos: 0, cursor: null, ids: [], falhas: 0, tentativaEm: 0, adiada: null, avaliacao: null });
const padrao = () => ({ validosDesdeUltima: 0, ultimaAtualizacao: null, versao: null, linhas: 0, tamanho: null, aneis: Object.fromEntries(ANEIS_DO_REGISTRO.map((a) => [a, anelPadrao()])) });

/** Estado do registro; arquivo ausente ou corrompido devolve o padrão. Estado antigo (sem `aneis`) migra do contador/cursor global. */
export function lerEstado(dir) {
  try {
    const j = JSON.parse(readFileSync(join(dir, ARQ_ESTADO), 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return padrao();
    const aneis = {};
    for (const a of ANEIS_DO_REGISTRO) {
      aneis[a] = j.aneis?.[a] && typeof j.aneis[a] === 'object'
        ? { ...anelPadrao(), ...j.aneis[a] }
        : { ...anelPadrao(), validos: Number.isInteger(j.validosDesdeUltima) ? j.validosDesdeUltima : 0, cursor: j.ultimaAtualizacao ?? null };
    }
    return { ...padrao(), ...j, aneis };
  } catch { return padrao(); }
}

/** Estado de um anel (contador, cursor, backoff). */
export const estadoDoAnel = (dir, anel) => lerEstado(dir).aneis[anel] ?? anelPadrao();

function gravarEstado(dir, estado) {
  try {
    mkdirSync(dir, { recursive: true });
    const arq = join(dir, ARQ_ESTADO);
    writeFileSync(`${arq}.tmp`, JSON.stringify(estado));
    renameSync(`${arq}.tmp`, arq);
    return { ok: true };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

/** Conta linhas em blocos (nunca carrega o arquivo inteiro). */
function contarLinhas(arquivo) {
  let fd; let n = 0;
  try { fd = openSync(arquivo, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.alloc(BLOCO); let lido; let ultimo = 10;
    while ((lido = readSync(fd, buf, 0, BLOCO, null)) > 0) { for (let i = 0; i < lido; i++) if (buf[i] === 10) n++; ultimo = buf[lido - 1]; }
    if (ultimo !== 10) n++; // última linha sem quebra
  } finally { closeSync(fd); }
  return n;
}

/** Linhas do arquivo da mais nova para a mais antiga, lidas em blocos a partir do fim (para cedo se o consumidor parar). */
function* linhasDeTras(arquivo) {
  let fd;
  try { fd = openSync(arquivo, 'r'); } catch { return; }
  try {
    let pos = fstatSync(fd).size;
    let resto = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(BLOCO, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const dados = Buffer.concat([buf, resto]);
      let fim = dados.length;
      for (let i = dados.length - 1; i >= 0; i--) {
        if (dados[i] !== 10) continue;
        if (fim > i + 1) { const l = dados.toString('utf8', i + 1, fim); if (l.trim()) yield l; }
        fim = i;
      }
      resto = Buffer.from(dados.subarray(0, fim)); // início de linha ainda incompleta
    }
    if (resto.length) { const l = resto.toString('utf8'); if (l.trim()) yield l; }
  } finally { closeSync(fd); }
}

/**
 * Acrescenta o caso e atualiza o estado numa só gravação (contadores por anel + `linhas`). NÃO rotaciona: roda no
 * caminho síncrono do turno. Passou de `tamanho * 1.2` linhas → devolve `rotacionar: true` e quem chamou agenda
 * `rotacionarRegistro` fora do turno. `valido` (padrão: `caso.triagem.valido`) incrementa o contador de todos os anéis.
 */
export function gravarCaso(dir, caso, { tamanho = 20000, valido = caso?.triagem?.valido === true } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    const estado = lerEstado(dir);
    const arq = join(dir, ARQ_CASOS);
    // Estado sem contagem de linhas confiável (ausente/corrompido): conta uma vez no arquivo, em blocos.
    let linhas = Number.isInteger(estado.linhas) && estado.linhas > 0 ? estado.linhas : contarLinhas(arq);
    appendFileSync(arq, `${JSON.stringify(caso)}
`); // se isto lança, o caso NÃO foi gravado
    linhas += 1;
    const novos = valido ? 1 : 0;
    const aneis = Object.fromEntries(Object.entries(estado.aneis).map(([a, e]) => [a, { ...e, validos: (e.validos || 0) + novos }]));
    // estado.tamanho: lerCasos nunca devolve mais que o limite, mesmo antes da rotação
    const r = gravarEstado(dir, { ...estado, linhas, tamanho, aneis, validosDesdeUltima: (estado.validosDesdeUltima || 0) + novos });
    // Se só o estado falhou, o caso ESTÁ no arquivo: quem chamou agenda `reconciliarEstado` (recontagem a partir do registro).
    if (!r.ok) return { ok: true, caso: true, estadoFalhou: r.erro, rotacionar: false };
    return { ok: true, rotacionar: linhas > tamanho * FOLGA };
  } catch (e) { return { ok: false, erro: String(e?.message ?? e) }; }
}

/** Conta linhas em blocos de 1 MB, devolvendo o controle ao event loop entre eles. */
async function contarLinhasAsync(arquivo) {
  let fh;
  try { fh = await abrirAsync(arquivo, 'r'); } catch { return 0; }
  try {
    const buf = Buffer.alloc(1024 * 1024); let n = 0; let pos = 0; let ultimo = 10;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) n++;
      ultimo = buf[bytesRead - 1]; pos += bytesRead;
      await new Promise((r) => setImmediate(r));
    }
    return ultimo === 10 ? n : n + 1;
  } finally { await fh.close(); }
}

/**
 * Recontagem a partir do registro (spec §5: "a contagem é refeita a partir do registro na abertura"): quando `linhas` do
 * estado diverge do arquivo (estado.json que falhou depois do append, apagado ou de outra versão), refaz `linhas` e o contador
 * de válidos de cada anel (os que vêm depois do cursor do anel). Assíncrona.
 *
 * CONCORRÊNCIA: a recontagem tem `await` no meio, e `zerarContador`, `registrarFalhaDoAnel`, `marcarAdiadaDoAnel` e
 * `gravarCaso` escrevem o mesmo `estado.json`. Por isso (1) o treino contínuo a roda sob a trava única e (2) aqui, depois do
 * último `await`, a conferência e a escrita são UM bloco síncrono: tamanho do arquivo e estado inteiro (linhas, cursor, ids,
 * falhas, backoff, adiada de cada anel) têm de estar como estavam quando a contagem começou; senão descarta e tenta de novo
 * (até 3 vezes) — nunca restaura um cursor antigo. `aposContar` é só gancho de teste.
 * @returns {Promise<{ok:boolean, ajustado:boolean, erro?:string}>}
 */
export async function reconciliarEstado(dir, { aposContar = null } = {}) {
  const arq = join(dir, ARQ_CASOS);
  if (!existsSync(arq)) return { ok: true, ajustado: false };
  try {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const antes = lerEstado(dir);
      const tamanho0 = statSync(arq).size;
      const reais = await contarLinhasAsync(arq);
      if (statSync(arq).size !== tamanho0) continue; // gravaram durante a contagem
      if (reais === antes.linhas) return { ok: true, ajustado: false };
      const validos = {};
      for (const [a, e] of Object.entries(antes.aneis)) {
        const lidos = await lerCasosAsync(dir, { validos: true, desde: e.cursor ? umMsAntes(e.cursor) : null, leve: true });
        const ja = new Set(e.ids || []);
        validos[a] = lidos.filter((c) => !e.cursor || c.ts > e.cursor || (c.ts === e.cursor && !ja.has(chaveDoCaso(c)))).length;
      }
      if (aposContar) await aposContar();
      // ---- bloco síncrono: SEM await entre a conferência e a escrita
      const agora = lerEstado(dir);
      if (statSync(arq).size !== tamanho0 || JSON.stringify(agora.aneis) !== JSON.stringify(antes.aneis) || agora.linhas !== antes.linhas) continue;
      const aneis = Object.fromEntries(Object.entries(agora.aneis).map(([a, e]) => [a, { ...e, validos: validos[a] ?? e.validos }]));
      const r = gravarEstado(dir, { ...agora, linhas: reais, aneis, validosDesdeUltima: Math.max(0, ...Object.values(aneis).map((e) => e.validos)) });
      return { ok: r.ok, ajustado: r.ok, ...(r.ok ? {} : { erro: r.erro }) };
    }
    return { ok: false, ajustado: false, erro: 'registro ou estado mudou durante a recontagem' };
  } catch (e) { return { ok: false, ajustado: false, erro: String(e?.message ?? e) }; }
}

/** 1 ms antes do ts (só ISO com Z; outro formato fica como está). */
const umMsAntes = (ts) => (/Z$/.test(String(ts)) ? new Date(Date.parse(ts) - 1).toISOString() : ts);

const rotacionando = new Set();
/**
 * Mantém só as últimas `tamanho` linhas, FORA do caminho do turno: acha o início por varredura assíncrona em blocos,
 * copia o resto por stream para um tmp e, num passo síncrono final (sem interleave com gravarCaso), acrescenta o que
 * foi gravado durante a cópia, troca o arquivo e atualiza `linhas`. Nunca carrega o arquivo inteiro.
 * @returns {Promise<{ok:boolean, removidas?:number, pulado?:boolean, erro?:string}>}
 */
export async function rotacionarRegistro(dir, tamanho = lerEstado(dir).tamanho ?? 20000) {
  if (rotacionando.has(dir)) return { ok: true, pulado: true };
  rotacionando.add(dir);
  const arq = join(dir, ARQ_CASOS); const tmp = `${arq}.rot.tmp`;
  try {
    const excesso = (lerEstado(dir).linhas || 0) - tamanho;
    if (excesso <= 0) return { ok: true, removidas: 0 };
    // início = byte logo depois da `excesso`-ésima quebra de linha (varredura para frente, assíncrona)
    const fh = await abrirAsync(arq, 'r');
    let inicio = 0; let fim = 0;
    try {
      const buf = Buffer.alloc(1024 * 1024); let pos = 0; let vistas = 0; let achou = false;
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        for (let i = 0; i < bytesRead && !achou; i++) if (buf[i] === 10 && ++vistas === excesso) { inicio = pos + i + 1; achou = true; }
        pos += bytesRead;
        if (achou) break;
      }
      fim = (await fh.stat()).size;
    } finally { await fh.close(); }
    if (inicio === 0) return { ok: true, removidas: 0 };
    await pipeline(createReadStream(arq, { start: inicio, end: fim - 1 }), createWriteStream(tmp));
    // passo síncrono final: o que entrou durante a cópia vai para o tmp antes da troca
    const fd = openSync(arq, 'r');
    try {
      const tam = fstatSync(fd).size;
      if (tam > fim) { const resto = Buffer.alloc(tam - fim); readSync(fd, resto, 0, resto.length, fim); appendFileSync(tmp, resto); }
    } finally { closeSync(fd); }
    renameSync(tmp, arq);
    const estado = lerEstado(dir);
    gravarEstado(dir, { ...estado, linhas: Math.max(0, (estado.linhas || 0) - excesso) });
    return { ok: true, removidas: excesso };
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* sem tmp */ }
    return { ok: false, erro: String(e?.message ?? e) };
  } finally { rotacionando.delete(dir); }
}

/**
 * Casos em ordem de gravação (no máximo `tamanho` mais recentes). `desde` = só ts posteriores (a leitura vem do fim
 * do arquivo e PARA no primeiro ts <= desde — premissa: gravação em ordem de ts); `validos` = só os que a triagem
 * aprovou (`caso.triagem.valido`; linha que não traz `"valido":true` nem é parseada); `ultimos` = no máximo N (os mais
 * recentes); `leve` = sem `vetores`/`texto`. Linha corrompida é ignorada.
 */
export function lerCasos(dir, { desde = null, validos = false, ultimos = null, leve = false } = {}) {
  const { tamanho } = lerEstado(dir);
  const limite = Number.isInteger(tamanho) && tamanho > 0 ? tamanho : Infinity;
  const achados = [];
  let vistas = 0;
  for (const l of linhasDeTras(join(dir, ARQ_CASOS))) {
    if (++vistas > limite) break;
    // Pré-filtro de texto: com `validos`, a linha cuja triagem não é válida nem chega a ser parseada (os vetores pesam).
    if (validos && !l.includes('"valido":true')) {
      if (desde) { const m = /"ts":"([^"]*)"/.exec(l); if (m && !(m[1] > String(desde))) break; } // o corte por `desde` continua valendo sem parsear
      continue;
    }
    let c;
    try { c = JSON.parse(l); } catch { continue; } // linha corrompida
    if (desde && !(String(c.ts) > String(desde))) break;
    if (validos && !c.triagem?.valido) continue;
    if (leve) { delete c.vetores; delete c.texto; }
    achados.push(c);
    if (Number.isInteger(ultimos) && ultimos > 0 && achados.length >= ultimos) break;
  }
  return achados.reverse();
}

const cederAoLoop = () => new Promise((r) => setImmediate(r));
/**
 * Mesmo contrato de `lerCasos`, mas devolve o controle ao event loop a cada `lote` linhas parseadas: o app não congela
 * lendo dezenas de milhares de casos (relatório, treino completo). A leitura em blocos é a mesma (da cauda para a frente).
 */
export async function lerCasosAsync(dir, { desde = null, validos = false, ultimos = null, leve = false, lote = 25 } = {}) {
  const { tamanho } = lerEstado(dir);
  const limite = Number.isInteger(tamanho) && tamanho > 0 ? tamanho : Infinity;
  const achados = [];
  let vistas = 0; let parseadas = 0;
  for (const l of linhasDeTras(join(dir, ARQ_CASOS))) {
    if (++vistas > limite) break;
    if (validos && !l.includes('"valido":true')) {
      if (desde) { const m = /"ts":"([^"]*)"/.exec(l); if (m && !(m[1] > String(desde))) break; }
      if (vistas % 500 === 0) await cederAoLoop();
      continue;
    }
    let c;
    try { c = JSON.parse(l); } catch { continue; }
    if (++parseadas % lote === 0) await cederAoLoop();
    if (desde && !(String(c.ts) > String(desde))) break;
    if (validos && !c.triagem?.valido) continue;
    if (leve) { delete c.vetores; delete c.texto; }
    achados.push(c);
    if (Number.isInteger(ultimos) && ultimos > 0 && achados.length >= ultimos) break;
  }
  return achados.reverse();
}

/** +1 no contador de válidos (global e de cada anel) para quem gravou o caso sem `valido`. */
export function marcarValido(dir) {
  const estado = lerEstado(dir);
  const aneis = Object.fromEntries(Object.entries(estado.aneis).map(([a, e]) => [a, { ...e, validos: (e.validos || 0) + 1 }]));
  return gravarEstado(dir, { ...estado, aneis, validosDesdeUltima: (estado.validosDesdeUltima || 0) + 1 });
}

/** Chave estável do caso para dedupe: `chave` gravada, o interactionId, ou ts + sessão + hash do texto/vetor (caso sem id). */
export function chaveDoCaso(c) {
  if (c?.chave) return String(c.chave);
  if (c?.interactionId) return String(c.interactionId);
  let h = 0x811c9dc5;
  for (const ch of String(c?.texto ?? JSON.stringify((c?.vetores?.[0] ?? []).slice(0, 16)))) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${c?.ts}|${c?.sessionId ?? ''}|${h.toString(16)}`;
}

/**
 * Retrato do que uma atualização vai consumir: a contagem de válidos agora (global e por anel), o ts do último caso
 * válido e as chaves dos casos válidos com esse ts. Tire no INÍCIO da atualização e passe a `zerarContador({consumidos})`.
 * @returns {{n:number, ts:string|null, ids:string[], aneis:Record<string,number>}}
 */
export function retratoDoContador(dir) {
  const estado = lerEstado(dir);
  const ultimos = lerCasos(dir, { validos: true, ultimos: 50, leve: true });
  const ts = ultimos.at(-1)?.ts ?? null;
  return { n: estado.validosDesdeUltima || 0, ts, ids: ultimos.filter((c) => c.ts === ts).map(chaveDoCaso), aneis: Object.fromEntries(Object.entries(estado.aneis).map(([a, e]) => [a, e.validos || 0])) };
}

/**
 * Com `consumidos` (retrato do início): SUBTRAI os consumidos (o que foi gravado durante a atualização continua
 * contado), e o cursor do anel = ts do último consumido (+ ids com esse ts), não "agora". Sem `consumidos`: zera e usa `quando`.
 * `aneis` (lista) = só esses anéis avançam (um anel adiado ou que falhou mantém contador e cursor); omitido = todos.
 * `porAnel` (`{ [anel]: { n, ts, ids } }`, só com `consumidos`) = consumo PARCIAL: o anel com entrada aí desconta só `n` (os casos que o
 * lote realmente incluiu) e vai ao `ts`/`ids` dele — o que ficou de fora continua contado e depois do cursor; os demais anéis seguem o
 * `consumidos` global (contrato do treino completo, que não passa `porAnel`). Com `porAnel` (mesmo vazio) o `validosDesdeUltima` global
 * vira o MAIOR contador entre os anéis depois da atualização (o que ainda falta ao anel mais atrasado) e `ultimaAtualizacao` o cursor mais
 * antigo entre os que avançaram; sem ele, o global desconta o retrato inteiro, como sempre.
 * O backoff e o adiamento (`adiada`/`avaliacao`) do anel zeram junto.
 */
export function zerarContador(dir, { versao = null, quando = new Date().toISOString(), consumidos = null, aneis = null, porAnel = null } = {}) {
  const estado = lerEstado(dir);
  const novos = { ...estado.aneis };
  const avancam = aneis ?? Object.keys(estado.aneis);
  const zerado = { falhas: 0, tentativaEm: 0, adiada: null, avaliacao: null };
  for (const a of avancam) {
    const e = estado.aneis[a] ?? anelPadrao();
    const parcial = consumidos ? porAnel?.[a] : null;
    if (parcial) novos[a] = { ...e, validos: Math.max(0, (e.validos || 0) - (parcial.n || 0)), cursor: parcial.ts ?? e.cursor ?? quando, ids: parcial.ids ?? [], ...zerado };
    else if (consumidos) novos[a] = { ...e, validos: Math.max(0, (e.validos || 0) - (consumidos.aneis?.[a] ?? consumidos.n ?? 0)), cursor: consumidos.ts ?? e.cursor ?? quando, ids: consumidos.ids ?? [], ...zerado };
    else novos[a] = { ...e, validos: 0, cursor: quando, ids: [], ...zerado };
  }
  if (!consumidos) return gravarEstado(dir, { ...estado, aneis: novos, validosDesdeUltima: 0, ultimaAtualizacao: quando, versao });
  const cursoresQueAvancaram = avancam.map((a) => novos[a]?.cursor).filter(Boolean);
  const ultimaAtualizacao = porAnel && cursoresQueAvancaram.length
    ? cursoresQueAvancaram.reduce((m, c) => (c < m ? c : m))
    : (consumidos.ts ?? estado.ultimaAtualizacao ?? quando);
  return gravarEstado(dir, {
    ...estado, aneis: novos,
    validosDesdeUltima: porAnel ? Math.max(0, ...Object.values(novos).map((e) => e.validos || 0)) : Math.max(0, (estado.validosDesdeUltima || 0) - (consumidos.n || 0)),
    ultimaAtualizacao,
    versao,
  });
}

/**
 * Marca (ou limpa, com null) o motivo de espera do anel no estado: sem backoff e sem entrada de histórico.
 * `tentativaEm` (opcional) = só tenta de novo quando o anel tiver tantos válidos (o mesmo campo do backoff, mas SEM contar falha): é como o
 * adiamento por falta de casos de avaliação evita reagendar uma rodada a cada turno.
 * `avaliacao` (`{ n, minimo }`, só para o adiamento por falta de casos de avaliação) fica gravada junto do motivo; qualquer outra marcação
 * (outro motivo, ou null = limpar) a leva a `null` — o campo só vale enquanto o adiamento por avaliação vale.
 */
export function marcarAdiadaDoAnel(dir, anel, motivo, { tentativaEm = null, avaliacao = null } = {}) {
  const estado = lerEstado(dir);
  const e = estado.aneis[anel] ?? anelPadrao();
  const av = motivo === null ? null : avaliacao;
  if ((e.adiada ?? null) === motivo && (tentativaEm === null || e.tentativaEm === tentativaEm) && JSON.stringify(e.avaliacao ?? null) === JSON.stringify(av)) return { ok: true, igual: true };
  return gravarEstado(dir, { ...estado, aneis: { ...estado.aneis, [anel]: { ...e, adiada: motivo, avaliacao: av, ...(tentativaEm === null ? {} : { tentativaEm }) } } });
}

/** Falha de verdade do anel (worker, gravação, divergência, tempo): backoff exponencial em VÁLIDOS (base, 2×base, 4×base… até `teto`), gravado no estado. */
export function registrarFalhaDoAnel(dir, anel, { base = 10, teto = 400 } = {}) {
  const estado = lerEstado(dir);
  const e = estado.aneis[anel] ?? anelPadrao();
  const falhas = (e.falhas || 0) + 1;
  const passo = Math.min(teto, base * 2 ** (falhas - 1));
  return gravarEstado(dir, { ...estado, aneis: { ...estado.aneis, [anel]: { ...e, falhas, tentativaEm: (e.validos || 0) + passo } } });
}

export const arquivoDoRegistro = (dir) => join(dir, ARQ_CASOS);
export const registroExiste = (dir) => existsSync(join(dir, ARQ_CASOS));

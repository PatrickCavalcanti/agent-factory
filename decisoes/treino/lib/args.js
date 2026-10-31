// Leitor de argumentos das CLIs do treino (`treinar.mjs`, `conferencia.mjs`). Existe porque o parser antigo (um `reduce` solto) IGNORAVA
// o que não conhecia: `treinar.mjs --help` ou `--anel=tool` (forma com `=`, que virava a chave "anel=tool") chegava ao `fetch` e disparava
// um treino completo real dos dois anéis no data do dono (revisão de 08/10, D7). Aqui a regra é recusar na dúvida: tudo que não é uma
// flag permitida com valor vira `FALTA:` — e o chamador sai ANTES de qualquer chamada.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const falta = (m) => ({ ok: false, linha: `FALTA: ${m} (use --help)` });

/**
 * @param {string[]} argv  `process.argv.slice(2)`
 * @param {{ permitidas: string[], uso?: string }} opcoes  `permitidas` sem os `--`; `uso` é o texto que `--help` imprime
 * @returns {{ ok: true, args: Record<string,string> } | { ok: false, ajuda: true, uso: string } | { ok: false, linha: string }}
 *   Só `ok: true` autoriza o chamador a agir. `--help`/`-h` em QUALQUER posição vence tudo (inclusive flag desconhecida).
 *   Aceita `--k valor` e `--k=valor`. Recusa com `FALTA:`: flag desconhecida, flag repetida, flag sem valor (fim do argv, valor vazio ou
 *   próximo token começando com `--`) e qualquer token solto (argumento posicional, `-x`). `args` não tem protótipo.
 */
export function lerArgs(argv, { permitidas, uso = '' }) {
  if (argv.some((x) => x === '--help' || x === '-h')) return { ok: false, ajuda: true, uso };
  const conhecidas = new Set(permitidas);
  const args = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) return falta(`argumento inesperado "${x}"`);
    const igual = x.indexOf('=');
    const nome = igual === -1 ? x.slice(2) : x.slice(2, igual);
    if (!conhecidas.has(nome)) return falta(`flag desconhecida --${nome}`);
    if (nome in args) return falta(`--${nome} repetida`);
    let valor;
    if (igual !== -1) valor = x.slice(igual + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) valor = argv[++i];
    if (valor === undefined || valor === '') return falta(`--${nome} precisa de um valor`);
    args[nome] = valor;
  }
  return { ok: true, args };
}

/** O uso de uma CLI é o cabeçalho de comentários `//` do próprio arquivo (uma fonte só): passe `import.meta.url`. */
export function usoDoCabecalho(urlDoArquivo) {
  const uso = [];
  for (const linha of readFileSync(fileURLToPath(urlDoArquivo), 'utf8').split(/\r?\n/)) {
    if (!linha.startsWith('//')) break;
    uso.push(linha.replace(/^\/\/ ?/, ''));
  }
  return uso.join('\n');
}

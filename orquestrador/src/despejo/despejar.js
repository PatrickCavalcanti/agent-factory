// Tira do acumulado do prompt-builder o que o despejo decidiu (spec 2026-10-29 §5.3). Puro, cópia por nível.
const semManual = ({ manual, ...resto }) => resto;

export function despejar(system, { capacidades = [], funcoes = [] }) {
  const caps = new Set(capacidades);
  const refs = new Set(funcoes);
  if (caps.size === 0 && refs.size === 0) return system;
  const capacidadesNovas = system.capacidades
    .filter((c) => !caps.has(c.id))
    .map((c) => (c.funcoes.some((f) => refs.has(f.ref) && f.manual)
      ? { ...c, funcoes: c.funcoes.map((f) => (refs.has(f.ref) ? semManual(f) : f)) }
      : c));
  const diario = Array.isArray(system.diario)
    ? system.diario.filter((e) => !caps.has(e.capId) && !(e.tipo === 'manual' && refs.has(e.ref)))
    : system.diario;
  return { ...system, capacidades: capacidadesNovas, diario };
}
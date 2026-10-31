// packages/decisions/src/local/refs.js
// Ref de item → id da capacidade dona. provider: a própria ref; tool/skill: o prefixo antes de /tool/ ou /skill/.
export const capacidadeDoRef = (anel, ref) => (anel === 'provider' ? ref : String(ref).split(/\/(?:tool|skill)\//)[0]);

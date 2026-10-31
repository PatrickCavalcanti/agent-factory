// Fixtures compartilhadas dos testes do decisor local (fora do glob *.test.js: não rodam como teste).
// embedder falso: vetor determinístico por palavra-chave (dimensão 4)
export const embedderFalso = (slug = 'falso-1') => {
  const chaves = ['agenda', 'tarefa', 'nota', 'busca'];
  let chamadas = 0;
  return {
    modelSlug: slug,
    get chamadas() { return chamadas; },
    async embed(texto) {
      chamadas++;
      const t = String(texto).toLowerCase();
      return chaves.map((k) => (t.includes(k) ? 1 : 0.01));
    },
  };
};

export const capsFalsas = () => [
  { id: 'google-calendar', semanticText: 'agenda compromissos', tools: [
    { name: 'gcal_listar_eventos', semanticText: 'listar agenda', exemplos: ['o que tenho na agenda amanhã'] },
  ] },
  { id: 'tarefas', descricao: 'tarefa pendente', tools: [
    { name: 'task_listar', description: 'lista tarefa', exemplos: ['quais tarefa abertas', 'minhas tarefa'] },
  ], skillsDeclaradas: [{ key: 'rotina', descricao: 'nota de rotina', exemplos: ['busca a rotina'] }] },
];

/** Embedder por tabela texto→vetor, escolhido à mão: o teste sabe exatamente quem é vizinho de quem. */
export const embedderTabela = (tabela, slug = 'tabela-1') => ({
  modelSlug: slug,
  async embed(texto) {
    const v = tabela[String(texto)];
    if (!v) throw new Error('texto fora da tabela: ' + texto);
    return v;
  },
});

// Três grupos bem separados (agenda ≈ x, tarefas ≈ y, notas ≈ z). `b-rouba` está escrito no grupo de tarefas
// mas pertence ao vizinho da agenda: é o exemplo que "rouba".
export const TABELA = {
  'a-texto': [1, 0, 0], a1: [0.99, 0.1, 0.05], a2: [0.99, -0.1, 0.05],
  'b-texto': [0, 1, 0], b1: [0.1, 0.98, 0.05], b2: [-0.1, 0.97, 0.1], 'b-rouba': [0.9, 0.4, 0.1],
  'c-texto': [0, 0, 1], c1: [0.05, 0.1, 0.99], c2: [-0.05, -0.1, 0.98],
};
export const caps = () => [
  { id: 'agenda', semanticText: 'a-texto', tools: [{ name: 'a', exemplos: ['a1', 'a2'] }] },
  { id: 'tarefas', semanticText: 'b-texto', tools: [{ name: 't', exemplos: ['b1', 'b2', 'b-rouba'] }] },
  { id: 'notas', semanticText: 'c-texto', tools: [{ name: 'n', exemplos: ['c1', 'c2'] }] },
];

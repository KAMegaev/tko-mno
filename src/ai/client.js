// Передаются только сведения, необходимые для подсказки ИИ. Файлы остаются в браузере.
async function ask(body) {
  const response = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Сервер вернул HTTP ' + response.status);
  return data;
}

export async function suggestColumns(_config, { titles, what }) {
  const data = await ask({ task: 'columns', table: what.includes('выгрузка') ? 'registry' : 'template', titles });
  return data.columns;
}

export async function suggestMatches(_config, { registryNames, templateNames }) {
  const data = await ask({ task: 'matches', registryNames, templateNames });
  return data.matches;
}

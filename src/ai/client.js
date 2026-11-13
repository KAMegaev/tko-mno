// Браузер обращается только к серверу сайта. Ключей провайдера здесь нет.
export async function api(path, body, sessionId) {
  const response = await fetch('/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionId ? { 'x-mno-session': sessionId } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Сервер вернул HTTP ' + response.status);
  return data;
}
export async function suggestColumns(config, { what }) {
  const data = await api('ai', { task: 'columns', table: what.includes('выгрузка') ? 'registry' : 'template', columns: config.columns }, config.sessionId);
  return data.columns;
}
export async function suggestMatches(config, { registryNames }) {
  const data = await api('ai', { task: 'matches', registryNames, columns: config.columns }, config.sessionId);
  return data.matches;
}

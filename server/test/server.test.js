import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../app.js';

const origin = 'http://mno.test';
test('сервер принимает только ограниченные текстовые задачи ИИ', async t => {
  const calls = [];
  const server = createApp({ publicOrigin: origin, apiKey: 'server-key', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, options, body });
    const isMatch = body.response_format.json_schema.schema.required.includes('matches');
    const result = isMatch
      ? { matches: [{ registry: 'Вольский район', template: 'Вольский муниципальный район', confidence: 0.95, reason: 'Одно МО' }] }
      : { columns: [{ role: 'mo', columnIndex: 1, reason: 'Заголовок' }] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (data, path = 'ai', from = origin) => fetch(base + '/api/' + path, {
    method: 'POST', headers: { origin: from, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const columns = { task: 'columns', table: 'template', titles: ['Субъект', 'Муниципальное образование'] };
  try {
    await t.test('нет загрузки, серверной сборки, результатов и служебных файлов', async () => {
      for (const route of ['files', 'match', 'build', 'reset', 'result']) assert.equal((await post({}, route)).status, 404);
      for (const path of ['/server/app.js', '/server/worker.js', '/.env', '/.git/config', '/tools/testdata/registry.xlsx']) assert.equal((await fetch(base + path)).status, 404);
      const config = await (await fetch(base + '/api/config')).json();
      assert.equal(config.processing, 'local');
      assert.equal(JSON.stringify(config).includes('server-key'), false);
      assert.equal((await fetch(base + '/')).status, 200);
    });
    await t.test('заголовки отправляются с серверным ключом и моделью', async () => {
      const res = await post(columns);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).columns[0].columnIndex, 1);
      assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(calls[0].options.headers.authorization, 'Bearer server-key');
      assert.equal(calls[0].body.model, 'gpt-4.1-mini');
      assert.equal(calls[0].body.response_format.json_schema.strict, true);
      assert.ok(calls[0].body.messages[1].content.includes('Муниципальное образование'));
    });
    await t.test('сопоставление получает два списка наименований', async () => {
      const res = await post({ task: 'matches', registryNames: ['Вольский район'], templateNames: ['Вольский муниципальный район'] });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).matches[0].confidence, 0.95);
    });
    await t.test('файлы, строки реестра и произвольные инструкции отклоняются', async () => {
      const before = calls.length;
      for (const extra of [{ file: 'UEsDB...' }, { rows: [[1, 2]] }, { apiKey: 'client-key' }, { model: 'client-model' }, { prompt: 'arbitrary' }]) assert.equal((await post({ ...columns, ...extra })).status, 400);
      assert.equal((await post(columns, 'ai', 'https://foreign.test')).status, 403);
      assert.equal((await post({ ...columns, titles: [42] })).status, 400);
      assert.equal((await post({ task: 'matches', registryNames: ['a'], templateNames: [] })).status, 400);
      assert.equal((await post({ ...columns, titles: ['x'.repeat(140000)] })).status, 413);
      assert.equal(calls.length, before);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('отсутствующий ключ не мешает открытию сайта и не раскрывается', async () => {
  const server = createApp({ publicOrigin: origin, apiKey: '' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await (await fetch(base + '/api/config')).json()).aiReady, false);
    const res = await fetch(base + '/api/ai', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'columns', table: 'template', titles: ['Субъект', 'МО'] }) });
    assert.equal(res.status, 503);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

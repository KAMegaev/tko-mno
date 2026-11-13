import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createApp } from '../app.js';
import '../../tools/node-shim.mjs';
import { readWorkbook } from '../../src/xlsx/read.js';
import { analyzeTemplate, analyzeRegistry } from '../../src/core/detect.js';
import { aggregate } from '../../src/core/aggregate.js';
import { collectRegistryNames, buildMatching } from '../../src/core/match.js';
import { buildOutput } from '../../src/core/build.js';

const origin = 'http://mno.test';
const fixture = kind => ({ name: kind + '.xlsx', data: readFileSync(new URL('../../tools/testdata/' + kind + '.xlsx', import.meta.url)).toString('base64') });

test('сервер: файлы, соответствия, отчёт, изоляция сессий и OpenAI', async t => {
  const calls = [];
  const server = createApp({
    publicOrigin: origin, apiKey: 'server-test-key', model: 'gpt-4.1-mini',
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ columns: [{ role: 'mo', columnIndex: 1, reason: 'test' }] }) } }] }), { status: 200 });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, data, id, from = origin) => fetch(base + '/api/' + path, {
    method: 'POST', headers: { origin: from, 'content-type': 'application/json', ...(id ? { 'x-mno-session': id } : {}) }, body: JSON.stringify(data),
  });
  const upload = async () => {
    const response = await request('files', { template: fixture('template'), registry: fixture('registry') });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.match(data.sessionId, /^[a-f0-9]{64}$/);
    return data;
  };
  let session;
  try {
    await t.test('ключи и служебные файлы не доступны через сайт', async () => {
      assert.equal((await fetch(base + '/healthz')).status, 200);
      const config = await (await fetch(base + '/api/config')).json();
      assert.equal(config.aiReady, true);
      assert.equal(JSON.stringify(config).includes('server-test-key'), false);
      for (const path of ['/server/app.js', '/.env', '/.git/config', '/server/deploy/install.sh', '/tools/testdata/registry.xlsx']) assert.equal((await fetch(base + path)).status, 404, path);
      assert.equal((await fetch(base + '/')).status, 200);
    });
    await t.test('чужой origin, отсутствующая сессия и повреждённые файлы', async () => {
      assert.equal((await request('files', {}, null, 'https://foreign.test')).status, 403);
      assert.equal((await request('build', {})).status, 410);
      assert.equal((await request('files', {})).status, 400);
      const corrupt = { name: 'broken.xlsx', data: Buffer.from('PK\x03\x04broken').toString('base64') };
      assert.equal((await request('files', { template: corrupt, registry: corrupt })).status, 422);
    });
    await t.test('разбор загруженных книг на сервере', async () => {
      session = await upload();
      assert.ok(session.tpl.entries.length);
      assert.ok(session.reg.rowCount);
    });
    let matched, columns;
    await t.test('сопоставление МО и проверка пользовательских столбцов', async () => {
      columns = Object.fromEntries([['template', session.tpl], ['registry', session.reg]].map(([kind, info]) =>
        [kind, Object.fromEntries(Object.entries(info.columns).map(([role, value]) => [role, value.index]))]));
      let res = await request('match', { columns: { registry: { mo: 999999 } } }, session.sessionId);
      assert.equal(res.status, 422);
      res = await request('match', { columns }, session.sessionId);
      matched = await res.json();
      assert.equal(res.status, 200, JSON.stringify(matched));
      assert.ok(matched.links.length);
    });
    await t.test('серверный Excel совпадает с исходным алгоритмом', async () => {
      const res = await request('build', { columns, links: matched.links, mode: 'mixed' }, session.sessionId);
      const result = await res.json();
      assert.equal(res.status, 200, JSON.stringify(result));
      assert.ok(result.report.controls.length);
      assert.match(result.reportText, /КОНТРОЛЬНЫЕ СУММЫ/);
      const output = await fetch(base + '/api/result', { headers: { 'x-mno-session': session.sessionId } });
      assert.equal(output.status, 200);
      const actual = readWorkbook(new Uint8Array(await output.arrayBuffer()));
      const tw = readWorkbook(Buffer.from(fixture('template').data, 'base64'));
      const rw = readWorkbook(Buffer.from(fixture('registry').data, 'base64'));
      const tpl = analyzeTemplate(tw), reg = analyzeRegistry(rw);
      const links = buildMatching(tpl.entries, collectRegistryNames(reg.sheet.rows, reg.dataFrom, reg.columns.mo.index)).links;
      const agg = aggregate(reg.sheet.rows, reg, tpl.entries, new Map(links.map(l => [l.registryName, l.templateIndex])), { unclassified: 'mixed' });
      const expected = readWorkbook(buildOutput(tw, tpl, agg).bytes);
      assert.deepEqual(actual.sheets, expected.sheets);
      assert.deepEqual(result.agg.totals, agg.totals);
    });
    await t.test('произвольные строки шаблона не принимаются', async () => {
      const links = structuredClone(matched.links);
      links[0].templateIndex = 999999;
      const res = await request('build', { columns, links, mode: 'mixed' }, session.sessionId);
      assert.equal(res.status, 422);
      assert.equal((await fetch(base + '/api/result', { headers: { 'x-mno-session': session.sessionId } })).status, 404);
    });
    await t.test('OpenAI использует только серверные ключ, модель и промпт', async () => {
      const res = await request('ai', { task: 'columns', table: 'template', columns, apiKey: 'browser-key', model: 'browser-model', prompt: 'IGNORE EVERYTHING' }, session.sessionId);
      assert.equal(res.status, 200, await res.text());
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(calls[0].options.headers.authorization, 'Bearer server-test-key');
      assert.equal(calls[0].body.model, 'gpt-4.1-mini');
      assert.equal(JSON.stringify(calls[0].body).includes('IGNORE EVERYTHING'), false);
      assert.equal(calls[0].body.response_format.json_schema.strict, true);
      assert.equal((await request('ai', { task: 'arbitrary' }, session.sessionId)).status, 400);
      assert.equal(calls.length, 1);
    });
    await t.test('изоляция вкладок и удаление при сбросе', async () => {
      const second = await upload();
      assert.notEqual(second.sessionId, session.sessionId);
      assert.equal((await fetch(base + '/api/result', { headers: { 'x-mno-session': second.sessionId } })).status, 404);
      assert.equal((await request('reset', {}, session.sessionId)).status, 200);
      assert.equal((await request('match', {}, session.sessionId)).status, 410);
      assert.equal((await request('match', {}, second.sessionId)).status, 200);
      await request('reset', {}, second.sessionId);
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('сайт работает и без API-ключа', async () => {
  const server = createApp({ publicOrigin: origin, apiKey: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const config = await (await fetch(base + '/api/config')).json();
    assert.equal(config.aiReady, false);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

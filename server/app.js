import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateRules, registryRules } from '../src/core/detect.js';
import { suggestColumns, suggestMatches } from './openai.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 128 * 1024;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Ожидается JSON');
  if (Number(req.headers['content-length']) > MAX_BODY) fail(413, 'Для подсказки ИИ можно передать не больше 128 КБ текста');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Для подсказки ИИ можно передать не больше 128 КБ текста');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Некорректный JSON'); }
}

function strings(values, maxItems, allowEmpty = false) {
  if (!Array.isArray(values) || !values.length || values.length > maxItems ||
      values.some(v => typeof v !== 'string' || v.length > 2000 || (!allowEmpty && !v.trim()))) {
    fail(400, 'Некорректный список заголовков или наименований');
  }
  return values;
}

function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Некорректная задача ИИ');
  const fields = data.task === 'columns'
    ? ['task', 'table', 'titles']
    : data.task === 'matches' ? ['task', 'registryNames', 'templateNames'] : [];
  if (!fields.length || Object.keys(data).some(key => !fields.includes(key))) fail(400, 'Допускаются только заголовки столбцов или наименования муниципалитетов');
  if (data.task === 'columns') {
    if (!['template', 'registry'].includes(data.table)) fail(400, 'Неизвестная таблица');
    strings(data.titles, 512, true);
  } else {
    strings(data.registryNames, 250);
    strings(data.templateNames, 2500);
    if (new Set(data.registryNames).size !== data.registryNames.length) fail(400, 'Повторяющиеся наименования реестра');
  }
}

export function createApp(options = {}) {
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8788';
  const ai = { apiKey: options.apiKey ?? process.env.OPENAI_API_KEY, model: options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini', fetchImpl: options.fetchImpl || fetch };
  let aiBusy = 0, aiWindow = Date.now(), aiCount = 0;

  async function api(req, res, pathname) {
    // Загрузки исходных файлов и серверной сборки больше нет.
    if (pathname !== '/api/ai') fail(404, 'Неизвестная операция');
    if (req.method !== 'POST') fail(405, 'Метод не поддерживается');
    if (req.headers.origin !== publicOrigin) fail(403, 'Запрос разрешён только со страницы сайта');
    const data = await body(req);
    validate(data);
    if (!ai.apiKey) fail(503, 'Серверный API-ключ OpenAI ещё не настроен');
    if (Date.now() - aiWindow > 3600000) { aiWindow = Date.now(); aiCount = 0; }
    if (aiBusy >= 2 || aiCount >= 60) fail(429, 'Достигнут лимит запросов ИИ. Попробуйте позднее');
    aiBusy++; aiCount++;
    try {
      if (data.task === 'columns') {
        const rules = data.table === 'template' ? templateRules : registryRules;
        const columns = await suggestColumns(ai, { titles: data.titles, roles: rules, what: data.table === 'template' ? 'Шаблон сведений о МНО' : 'Реестр МНО' });
        if (!Array.isArray(columns) || columns.some(c => !rules.some(r => r.role === c.role) || (c.columnIndex !== null && (!Number.isInteger(c.columnIndex) || c.columnIndex < 0 || c.columnIndex >= data.titles.length)))) fail(502, 'ИИ предложил недопустимые столбцы');
        json(res, 200, { columns });
      } else {
        const matches = await suggestMatches(ai, { registryNames: data.registryNames, templateNames: data.templateNames });
        if (!Array.isArray(matches) || matches.some(m => !data.registryNames.includes(m.registry) || (m.template !== null && !data.templateNames.includes(m.template)) || !Number.isFinite(m.confidence) || m.confidence < 0 || m.confidence > 1)) fail(502, 'ИИ предложил недопустимые соответствия');
        json(res, 200, { matches });
      }
    } finally { aiBusy--; }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', app: 'tko-mno' }); return; }
      if (pathname === '/api/config' && req.method === 'GET') { json(res, 200, { aiReady: Boolean(ai.apiKey), model: ai.model, processing: 'local' }); return; }
      if (pathname.startsWith('/api/')) { await api(req, res, pathname); return; }
      if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Метод не поддерживается');
      const path = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
      if (!(path === '/index.html' || /^\/(?:assets|src)\/[A-Za-z0-9_.\/-]+$/.test(path)) || path.split('/').some(p => p === '..' || p.startsWith('.')) || !MIME[extname(path)]) fail(404, 'Страница не найдена');
      const full = resolve(ROOT, '.' + path);
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) fail(404, 'Страница не найдена');
      res.writeHead(200, { 'content-type': MIME[extname(path)], 'cache-control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : await readFile(full));
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 502, { error: error.status ? error.message : 'Ошибка сервера. Повторите попытку или обратитесь к администратору' });
      else res.destroy();
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 30000;
  return server;
}

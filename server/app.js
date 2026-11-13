import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { templateRules, registryRules } from '../src/core/detect.js';
import { suggestColumns, suggestMatches } from './openai.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE = 12 * 1024 * 1024, MAX_BODY = 33 * 1024 * 1024;
const TTL = 30 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Ожидается JSON');
  if (Number(req.headers['content-length']) > MAX_BODY) fail(413, 'Общий размер файлов слишком большой');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'Общий размер файлов слишком большой');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Некорректный JSON'); }
}

export function createApp(options = {}) {
  const publicOrigin = options.publicOrigin || process.env.PUBLIC_ORIGIN || 'http://127.0.0.1:8788';
  const ai = { apiKey: options.apiKey ?? process.env.OPENAI_API_KEY, model: options.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini', fetchImpl: options.fetchImpl || fetch };
  const sessions = new Map(), rates = new Map();
  const workers = new Set();
  let opening = 0, aiBusy = 0, aiWindow = Date.now(), aiCount = 0;

  async function erase(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    await rm(session.dir, { recursive: true, force: true });
  }

  function job(session, task, payload = {}) {
    if (workers.size >= 1) fail(429, 'Сервер обрабатывает другие файлы. Повторите через несколько секунд');
    return new Promise((resolveJob, rejectJob) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { ...payload, task, templatePath: session.templatePath, registryPath: session.registryPath, files: session.files },
        resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
      });
      workers.add(worker);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        workers.delete(worker);
        void worker.terminate();
        error ? rejectJob(error) : resolveJob(result);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('Обработка заняла слишком много времени. Попробуйте уменьшить файл'), { status: 422 })), 45000);
      worker.once('message', data => finish(data.error ? Object.assign(new Error(data.error), { status: 422 }) : null, data.result));
      worker.once('error', () => finish(Object.assign(new Error('Не удалось обработать книгу. Проверьте размер и структуру файла'), { status: 422 })));
      worker.once('exit', () => finish(Object.assign(new Error('Обработка книги прервана'), { status: 422 })));
    });
  }

  function rate(req) {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    let entry = rates.get(ip);
    if (!entry || now - entry.start > 60000) rates.set(ip, entry = { start: now, count: 0 });
    if (++entry.count > 120) fail(429, 'Слишком много запросов. Повторите через минуту');
  }

  async function api(req, res, pathname) {
    if (!['/api/files', '/api/match', '/api/build', '/api/ai', '/api/reset', '/api/result'].includes(pathname)) fail(404, 'Неизвестная операция');
    if (pathname === '/api/result' ? req.method !== 'GET' : req.method !== 'POST') fail(405, 'Метод не поддерживается');
    if (req.method === 'POST' && req.headers.origin !== publicOrigin) fail(403, 'Запрос разрешён только со страницы сайта');
    rate(req);
    if (pathname === '/api/files') {
      if (sessions.size + opening >= 12) fail(503, 'Сервер занят. Повторите позднее');
      opening++;
      let dir, id;
      try {
        const data = await body(req);
        const decoded = {};
        for (const kind of ['template', 'registry']) {
          const file = data?.[kind];
          if (!file || typeof file.name !== 'string' || file.name.length > 240 || !/\.(xlsx|xlsm|xltx)$/i.test(file.name) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) fail(400, 'Нужны два файла Excel (.xlsx, .xlsm, .xltx)');
          const bytes = Buffer.from(file.data, 'base64');
          if (bytes.length < 4 || bytes.length > MAX_FILE) fail(413, 'Каждый файл должен быть не больше 12 МБ');
          if (bytes.readUInt32LE(0) !== 0x04034b50) fail(422, 'Файл не является книгой Excel');
          decoded[kind] = bytes;
        }
        dir = await mkdtemp(resolve(tmpdir(), 'mno-'));
        await writeFile(resolve(dir, 'template.xlsx'), decoded.template, { mode: 0o600 });
        await writeFile(resolve(dir, 'registry.xlsx'), decoded.registry, { mode: 0o600 });
        id = randomBytes(32).toString('hex');
        const session = { dir, templatePath: resolve(dir, 'template.xlsx'), registryPath: resolve(dir, 'registry.xlsx'), files: { templateName: data.template.name, registryName: data.registry.name }, expires: Date.now() + TTL, aiCalls: 0, busy: false };
        sessions.set(id, session);
        const result = await job(session, 'parse');
        json(res, 200, { sessionId: id, ...result });
      } catch (error) {
        if (id) await erase(id);
        else if (dir) await rm(dir, { recursive: true, force: true });
        throw error;
      } finally { opening--; }
      return;
    }
    const id = req.headers['x-mno-session'];
    const session = typeof id === 'string' ? sessions.get(id) : null;
    if (!session || session.expires < Date.now()) {
      if (session) await erase(id);
      fail(410, 'Срок хранения файлов истёк. Загрузите их заново');
    }
    if (pathname === '/api/result') {
      if (!session.outputPath) fail(404, 'Сначала соберите результат');
      const bytes = await readFile(session.outputPath);
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="mno-result.xlsx"' });
      res.end(bytes);
      return;
    }
    if (session.busy) fail(409, 'Дождитесь завершения предыдущего действия');
    session.busy = true;
    try {
      const data = await body(req);
      if (pathname === '/api/match') {
        json(res, 200, await job(session, 'match', { columns: data.columns }));
      } else if (pathname === '/api/build') {
        // Удаляем прежний результат до попытки новой сборки.
        session.outputPath = null;
        const result = await job(session, 'build', { columns: data.columns, links: data.links, mode: data.mode });
        const outputPath = resolve(session.dir, 'result.xlsx');
        await writeFile(outputPath, result.bytes, { mode: 0o600 });
        session.outputPath = outputPath;
        delete result.bytes;
        json(res, 200, result);
      } else if (pathname === '/api/ai') {
        if (!ai.apiKey) fail(503, 'Серверный API-ключ OpenAI ещё не настроен');
        if (Date.now() - aiWindow > 3600000) { aiWindow = Date.now(); aiCount = 0; }
        if (aiBusy >= 2 || aiCount >= 60 || session.aiCalls >= 12) fail(429, 'Достигнут лимит запросов ИИ. Попробуйте позднее');
        if (!['columns', 'matches'].includes(data.task)) fail(400, 'Неизвестная задача ИИ');
        const info = await job(session, 'ai-data', { columns: data.columns });
        if (JSON.stringify(info).length > 100000) fail(422, 'Слишком много данных для одного запроса ИИ. Уменьшите таблицу');
        aiBusy++; aiCount++; session.aiCalls++;
        try {
          if (data.task === 'columns') {
            if (!['template', 'registry'].includes(data.table)) fail(400, 'Неизвестная таблица');
            const rules = data.table === 'template' ? templateRules : registryRules;
            const titles = data.table === 'template' ? info.templateTitles : info.registryTitles;
            const columns = await suggestColumns(ai, { titles, roles: rules, what: data.table === 'template' ? 'Шаблон сведений о МНО' : 'Реестр МНО' });
            if (!Array.isArray(columns) || columns.some(c => !rules.some(r => r.role === c.role) || (c.columnIndex !== null && (!Number.isInteger(c.columnIndex) || c.columnIndex < 0 || c.columnIndex >= titles.length)))) fail(502, 'ИИ предложил недопустимые столбцы');
            json(res, 200, { columns });
          } else {
            const names = data.registryNames;
            if (!Array.isArray(names) || !names.length || names.length > 250 || new Set(names).size !== names.length || names.some(n => !info.registryNames.includes(n))) fail(400, 'Выберите до 250 наименований из загруженного реестра');
            const matches = await suggestMatches(ai, { registryNames: names, templateNames: info.templateNames });
            if (!Array.isArray(matches) || matches.some(m => !names.includes(m.registry) || (m.template !== null && !info.templateNames.includes(m.template)) || !Number.isFinite(m.confidence) || m.confidence < 0 || m.confidence > 1)) fail(502, 'ИИ предложил недопустимые соответствия');
            json(res, 200, { matches });
          }
        } finally { aiBusy--; }
      } else if (pathname === '/api/reset') {
        await erase(id);
        json(res, 200, { status: 'ok' });
      } else fail(404, 'Неизвестная операция');
    } finally { session.busy = false; }
  }

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/healthz' && req.method === 'GET') { json(res, 200, { status: 'ok', app: 'tko-mno' }); return; }
      if (pathname === '/api/config' && req.method === 'GET') { json(res, 200, { aiReady: Boolean(ai.apiKey), model: ai.model, maxFileMb: 12, retentionMinutes: 30 }); return; }
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
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (s.expires < now && !s.busy) void erase(id).catch(() => {});
    for (const [ip, entry] of rates) if (now - entry.start > 60000) rates.delete(ip);
  }, 10000);
  cleanup.unref();
  server.on('close', () => {
    clearInterval(cleanup);
    for (const worker of workers) void worker.terminate();
    for (const id of sessions.keys()) void erase(id).catch(() => {});
  });
  return server;
}

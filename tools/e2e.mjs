// Сквозная проверка страницы в браузере: загрузка → столбцы → соответствия → файл.
import { chromium } from 'playwright';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const OUT = process.env.OUT || '/tmp/e2e-out.xlsx';
const root = path.resolve('.');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });

await page.setInputFiles('[data-drop="registry"] input', path.join(root, 'tools/testdata/registry.xlsx'));
await page.setInputFiles('[data-drop="template"] input', path.join(root, 'tools/testdata/template.xlsx'));
await page.click('#btn-parse');
await page.waitForSelector('.step[data-step="2"].is-current', { timeout: 30000 });

const cols = await page.$$eval('#tpl-columns tbody tr, #reg-columns tbody tr', (rows) =>
  rows.map((r) => [r.querySelector('.role').textContent, r.querySelector('select').selectedOptions[0].textContent]));
console.log('— распознанные столбцы —');
for (const [role, col] of cols) console.log('  ', role, '=>', col);

await page.click('#btn-to-mo');
await page.waitForSelector('.step[data-step="3"].is-current', { timeout: 30000 });
const summary = await page.$$eval('#mo-summary .box', (b) => b.map((x) => `${x.querySelector('b').textContent} ${x.querySelector('span').textContent}`));
console.log('— сопоставление —');
summary.forEach((s) => console.log('  ', s));
console.log('   отсутствуют:', await page.$$eval('#mo-missing li', (l) => l.map((x) => x.textContent)));

await page.click('#btn-build');
await page.waitForSelector('.step[data-step="4"].is-current', { timeout: 60000 });
const controls = await page.$$eval('#controls tr', (rows) =>
  rows.map((r) => `${r.children[0].childNodes[0].textContent} = ${r.children[1].textContent}`));
console.log('— контрольные суммы —');
controls.forEach((c) => console.log('  ', c));
const problems = await page.$$eval('#problems li', (l) => l.map((x) => `[${x.className.replace('lvl-', '')}] ${x.querySelector('.p-title').textContent}`));
console.log('— проблемы —');
problems.forEach((p) => console.log('  ', p));

// Путь 1: выбор папки (File System Access API). В headless системный диалог
// показать нельзя, поэтому подменяем его на перехватчик и проверяем сами байты.
await page.evaluate(() => {
  window.__picked = null;
  window.showSaveFilePicker = async (opts) => ({
    createWritable: async () => ({
      write: async (blob) => { window.__picked = { name: opts.suggestedName, size: blob.size, type: blob.type }; },
      close: async () => {},
    }),
  });
});
await page.click('#btn-save');
await page.waitForFunction(() => window.__picked !== null, { timeout: 30000 });
console.log('— «Сохранить файл…»:', await page.evaluate(() => window.__picked));

// Путь 2: обычная загрузка, когда браузер не умеет выбирать папку.
await page.evaluate(() => { delete window.showSaveFilePicker; });
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('#btn-save'),
]);
await download.saveAs(OUT);
console.log('— загрузка в папку загрузок:', download.suggestedFilename(), '→', OUT);

// Отчёт .txt тем же путём.
const [reportDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('#btn-save-report'),
]);
await reportDl.saveAs(OUT.replace(/\.xlsx$/, '.txt'));
console.log('— отчёт:', reportDl.suggestedFilename());

if (errors.length) { console.log('— ОШИБКИ В БРАУЗЕРЕ —'); errors.forEach((e) => console.log('  ', e)); }
await browser.close();
process.exit(errors.length ? 1 : 0);

import '../tools/node-shim.mjs';
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { readWorkbook, indexToCol } from '../src/xlsx/read.js';
import { analyzeTemplate, analyzeRegistry } from '../src/core/detect.js';
import { collectRegistryNames, buildMatching, missingTemplateRows, unlinkedRegistryNames } from '../src/core/match.js';
import { aggregate } from '../src/core/aggregate.js';
import { buildOutput } from '../src/core/build.js';
import { buildReport, reportToText } from '../src/core/report.js';

function workbook(path) {
  const bytes = readFileSync(path);
  // Проверяем центральный каталог ZIP до распаковки: ограничиваем общий объём.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('Файл не является корректной книгой Excel');
  const count = bytes.readUInt16LE(end + 10);
  let pos = bytes.readUInt32LE(end + 16), total = 0;
  if (!count || count > 5000) throw new Error('Слишком много частей в книге Excel');
  for (let i = 0; i < count; i++) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error('Повреждён архив Excel');
    total += bytes.readUInt32LE(pos + 24);
    if (total > 80 * 1024 * 1024) throw new Error('Распакованная книга превышает 80 МБ');
    pos += 46 + bytes.readUInt16LE(pos + 28) + bytes.readUInt16LE(pos + 30) + bytes.readUInt16LE(pos + 32);
  }
  const wb = readWorkbook(bytes);
  for (const s of wb.sheets) {
    if (s.rowCount > 150000 || s.maxCol > 512) throw new Error('Поддерживаются книги до 150 000 строк и 512 столбцов');
  }
  return wb;
}

function columns(info, choices) {
  if (choices === undefined) return;
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) throw new Error('Некорректные столбцы');
  for (const [role, index] of Object.entries(choices)) {
    if (!Object.hasOwn(info.columns, role) || !Number.isInteger(index) || index < -1 || index >= info.titles.length) throw new Error('Некорректный номер столбца');
    Object.assign(info.columns[role], { index, column: index < 0 ? '' : indexToCol(index + 1), title: index < 0 ? '' : info.titles[index], auto: false });
  }
}

function templateEntries(tpl, oldMo, oldSubject) {
  if (tpl.columns.mo.index === oldMo && tpl.columns.subject.index === oldSubject) return;
  const mo = tpl.columns.mo.index, subject = tpl.columns.subject.index;
  if (mo < 0) throw new Error('Выберите столбец муниципального образования в шаблоне');
  const entries = [];
  let gap = 0;
  tpl.existingTotalRow = null;
  for (let r = tpl.dataFrom; r < tpl.sheet.rows.length; r++) {
    const name = String(tpl.sheet.rows[r]?.[mo] ?? '').trim();
    if (!name) { if (++gap > 5) break; continue; }
    gap = 0;
    if (/^(итого|итог|всего)( по субъекту)?$/i.test(name)) { tpl.existingTotalRow = r + 1; continue; }
    entries.push({ rowIndex: r, excelRow: r + 1, subject: subject < 0 ? '' : tpl.sheet.rows[r]?.[subject] ?? '', name });
  }
  if (!entries.length) throw new Error('В выбранном столбце шаблона нет муниципальных образований');
  tpl.entries = entries;
  tpl.firstDataExcelRow = entries[0].excelRow;
  tpl.lastDataExcelRow = entries.at(-1).excelRow;
}

function processJob(data) {
  const tw = workbook(data.templatePath), rw = workbook(data.registryPath);
  const tpl = analyzeTemplate(tw), reg = analyzeRegistry(rw);
  const oldMo = tpl.columns.mo.index, oldSubject = tpl.columns.subject.index;
  columns(tpl, data.columns?.template);
  columns(reg, data.columns?.registry);
  templateEntries(tpl, oldMo, oldSubject);
  if (data.task === 'parse') return { tpl, reg };
  const names = reg.columns.mo.index < 0 ? [] : collectRegistryNames(reg.sheet.rows, reg.dataFrom, reg.columns.mo.index);
  const links = buildMatching(tpl.entries, names).links;
  if (data.task === 'match') {
    if (reg.columns.mo.index < 0 || tpl.columns.mo.index < 0) throw new Error('Выберите столбцы муниципальных образований');
    return { tpl, reg, links };
  }
  if (data.task === 'ai-data') return { templateTitles: tpl.titles, registryTitles: reg.titles, registryNames: names.map(n => n.name), templateNames: tpl.entries.map(e => e.name) };
  if (reg.columns.mo.index < 0 || tpl.columns.mo.index < 0) throw new Error('Выберите столбцы муниципальных образований');
  if (data.task !== 'build') throw new Error('Неизвестная операция');
  if (!['mixed', 'other', 'drop'].includes(data.mode)) throw new Error('Некорректное правило контейнеров');
  if (!Array.isArray(data.links) || data.links.length !== links.length) throw new Error('Список соответствий изменился. Повторите сопоставление');
  const supplied = new Map(data.links.map(l => [l.registryName, l]));
  if (supplied.size !== links.length || [...supplied.keys()].some(n => !links.some(l => l.registryName === n))) throw new Error('Некорректные соответствия');
  for (const link of links) {
    const chosen = supplied.get(link.registryName);
    const index = chosen?.templateIndex;
    if (index !== null && (!Number.isInteger(index) || index < 0 || index >= tpl.entries.length)) throw new Error('Некорректная строка шаблона');
    link.templateIndex = index;
    link.templateName = index === null ? '' : tpl.entries[index].name;
    link.kind = ['exact', 'core', 'fuzzy', 'ambiguous', 'none', 'manual', 'ai'].includes(chosen.kind) ? chosen.kind : 'manual';
    link.source = ['rules', 'manual', 'ai'].includes(chosen.source) ? chosen.source : 'manual';
  }
  const map = new Map(links.map(l => [l.registryName, l.templateIndex]));
  const agg = aggregate(reg.sheet.rows, reg, tpl.entries, map, { unclassified: data.mode });
  const output = buildOutput(tw, tpl, agg);
  const hits = new Map(links.filter(l => l.templateIndex !== null).map(l => [l.templateIndex, true]));
  const report = buildReport({ templateInfo: tpl, registryInfo: reg, links, missing: missingTemplateRows(tpl.entries, hits), unlinked: unlinkedRegistryNames(links), agg, output, files: data.files });
  const bytes = output.bytes;
  delete output.bytes;
  return { bytes, output, agg, report, reportText: reportToText(report, { links }), tpl };
}

try { parentPort.postMessage({ result: processJob(workerData) }); }
catch (error) { parentPort.postMessage({ error: error.message }); }

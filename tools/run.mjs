// Прогон полного сценария в Node на реальных файлах (без браузера).
import { writeFileSync } from 'node:fs';
import { bytes, REG, TPL } from './node-shim.mjs';
import { readWorkbook } from '../src/xlsx/read.js';
import { analyzeTemplate, analyzeRegistry } from '../src/core/detect.js';
import { collectRegistryNames, buildMatching, missingTemplateRows, unlinkedRegistryNames } from '../src/core/match.js';
import { aggregate } from '../src/core/aggregate.js';
import { buildOutput } from '../src/core/build.js';

const twb = readWorkbook(bytes(TPL));
const rwb = readWorkbook(bytes(REG));
const t = analyzeTemplate(twb);
const r = analyzeRegistry(rwb);
const names = collectRegistryNames(r.sheet.rows, r.dataFrom, r.columns.mo.index);
const { links, templateHits } = buildMatching(t.entries, names);
const map = new Map(links.map((l) => [l.registryName, l.templateIndex]));
const agg = aggregate(r.sheet.rows, r, t.entries, map, { unclassified: process.env.MODE || 'mixed' });
const out = buildOutput(twb, t, agg);
writeFileSync(process.env.OUT || 'out.xlsx', out.bytes);
console.log('total row:', out.totalExcelRow, 'columns:', out.filledColumns.join(','), 'skipped:', out.skippedRoles);
console.log('missing:', missingTemplateRows(t.entries, templateHits).map((m) => m.name));
console.log('unlinked:', unlinkedRegistryNames(links).map((l) => l.registryName));
console.log('totals:', agg.totals);

// ── Ожидаемые значения для встроенных фикстур ────────────────────────────────
// Проверяются только на тестовых файлах из tools/testdata; при подстановке
// своих файлов через REG/TPL проверка пропускается.
if (!process.env.REG && !process.env.TPL) {
  const expect = {
    mno: 15, mnoSeparate: 3, mixed: 36, separate: 5, bulky: 2, other: 1, unclassified: 8,
  };
  const problems = [];
  for (const [k, v] of Object.entries(expect)) {
    if (agg.totals[k] !== v) problems.push(`${k}: получено ${agg.totals[k]}, ожидалось ${v}`);
  }
  const containers = agg.totals.mixed + agg.totals.separate + agg.totals.bulky + agg.totals.other;
  if (containers !== agg.stats.totalContainersRegistry) {
    problems.push(`сумма по группам ${containers} ≠ «Общее количество» ${agg.stats.totalContainersRegistry}`);
  }
  if (agg.totals.mno !== agg.stats.scanned) {
    problems.push(`строк учтено ${agg.totals.mno}, обработано ${agg.stats.scanned}`);
  }
  if (missingTemplateRows(t.entries, templateHits).length !== 1) {
    problems.push('ожидалась ровно одна строка шаблона без данных в реестре');
  }
  if (unlinkedRegistryNames(links).length !== 0) {
    problems.push('все наименования реестра должны были привязаться');
  }
  if (out.totalExcelRow !== t.lastDataExcelRow + 1) problems.push('итоговая строка не на своём месте');
  if (problems.length) {
    console.error('ПРОВЕРКА НЕ ПРОЙДЕНА:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('проверка пройдена');
}

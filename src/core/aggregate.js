// Агрегация строк реестра по строкам шаблона.
import { toNumber, isUnparsableNumber } from './text.js';

/** Куда относить контейнеры без разбивки по группам. */
export const UNCLASSIFIED_MODES = {
  mixed: 'В «Смешанные ТКО»',
  other: 'В «Иное»',
  drop: 'Не учитывать',
};

/**
 * @param {any[][]} rows строки листа реестра
 * @param {object} registryInfo результат analyzeRegistry
 * @param {Array} templateEntries строки шаблона
 * @param {Map<string, number|null>} nameToTemplate соответствие «имя в реестре → индекс строки шаблона»
 * @param {{unclassified: 'mixed'|'other'|'drop'}} options
 */
export function aggregate(rows, registryInfo, templateEntries, nameToTemplate, options = {}) {
  const mode = options.unclassified || 'mixed';
  const col = (role) => registryInfo.columns[role]?.index ?? -1;
  const cMo = col('mo');
  const cTotal = col('cont_total');
  const cMixed = col('g_mixed');
  const cSep = col('g_separate');
  const cBulky = col('g_bulky');
  const cOther = col('g_other');
  const cFlag = col('sep_flag');

  const blank = () => ({ mno: 0, mnoSeparate: 0, mixed: 0, separate: 0, bulky: 0, other: 0, unclassified: 0 });
  const perRow = templateEntries.map(blank);
  const skipped = blank();

  const stats = {
    scanned: 0, matched: 0, skippedRows: 0, emptyMo: 0,
    breakdownMissing: 0, breakdownPartial: 0, breakdownOver: 0,
    unparsable: 0, unclassifiedContainers: 0,
    flagYesNoContainers: 0, containersNoFlag: 0,
    totalContainersRegistry: 0, totalContainersBreakdown: 0,
  };

  for (let r = registryInfo.dataFrom; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;
    const moRaw = cMo >= 0 ? row[cMo] : null;
    if (moRaw === undefined || moRaw === null || String(moRaw).trim() === '') {
      // Строка без МО: пропускаем, но только если она вообще не пустая.
      if (row.some((v) => v !== undefined && v !== null && String(v).trim() !== '')) stats.emptyMo++;
      continue;
    }
    stats.scanned++;
    const name = String(moRaw).trim();
    const target = nameToTemplate.get(name);

    const get = (i) => (i >= 0 ? row[i] : null);
    for (const i of [cTotal, cMixed, cSep, cBulky, cOther]) {
      if (i >= 0 && isUnparsableNumber(row[i])) stats.unparsable++;
    }
    const total = toNumber(get(cTotal));
    const mixed = toNumber(get(cMixed));
    const sep = toNumber(get(cSep));
    const bulky = toNumber(get(cBulky));
    const other = toNumber(get(cOther));
    const sum = mixed + sep + bulky + other;

    stats.totalContainersRegistry += total;
    stats.totalContainersBreakdown += sum;

    let rest = total - sum;
    if (rest > 0) {
      if (sum === 0) stats.breakdownMissing++; else stats.breakdownPartial++;
      stats.unclassifiedContainers += rest;
    } else {
      if (rest < 0) stats.breakdownOver++;
      rest = 0;
    }

    if (cFlag >= 0) {
      const flag = String(get(cFlag) ?? '').trim().toLowerCase();
      if (flag === 'да' && sep === 0) stats.flagYesNoContainers++;
      if (sep > 0 && flag !== 'да') stats.containersNoFlag++;
    }

    const acc = (target === null || target === undefined) ? skipped : perRow[target];
    if (acc === skipped) stats.skippedRows++; else stats.matched++;

    acc.mno += 1;
    if (sep > 0) acc.mnoSeparate += 1;
    acc.mixed += mixed;
    acc.separate += sep;
    acc.bulky += bulky;
    acc.other += other;
    acc.unclassified += rest;
    if (rest > 0) {
      if (mode === 'mixed') acc.mixed += rest;
      else if (mode === 'other') acc.other += rest;
    }
  }

  const totals = blank();
  for (const v of perRow) for (const k of Object.keys(totals)) totals[k] += v[k];

  return { perRow, totals, skipped, stats, mode };
}

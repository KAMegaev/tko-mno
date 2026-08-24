// Определение структуры файлов: какой лист, где шапка, какие столбцы за что отвечают.
import { norm } from './text.js';
import { indexToCol } from '../xlsx/read.js';

// Значения-подсказки под шапкой шаблона («список», «обязательное поле», …).
const META_VALUES = new Set([
  'список', 'число', 'текст', 'дата', 'да нет', 'логический', 'строка',
  'обязательное поле', 'необязательное поле', 'необязательно', 'обязательно',
  'формат', 'тип данных', 'примечание', 'пример',
]);

const isMeta = (v) => META_VALUES.has(norm(v));

// Строки-итоги, которые могут уже быть в шаблоне.
const TOTAL_WORDS = new Set(['итого', 'итог', 'всего', 'итого по субъекту', 'всего по субъекту']);

/** Протягивает значения объединённых ячеек вправо по строке шапки. */
function fillRight(row, width) {
  const out = new Array(width).fill('');
  let last = '';
  for (let i = 0; i < width; i++) {
    const v = row?.[i];
    if (v !== undefined && v !== null && String(v).trim() !== '') last = String(v).trim();
    out[i] = last;
  }
  return out;
}

/** Склеивает многоуровневую шапку в один заголовок на столбец. */
export function buildTitles(rows, headerFrom, headerTo, width) {
  const levels = [];
  for (let r = headerFrom; r <= headerTo; r++) levels.push(fillRight(rows[r], width));
  const titles = [];
  for (let c = 0; c < width; c++) {
    const parts = [];
    for (const lv of levels) {
      const v = lv[c];
      if (v && !parts.includes(v) && !isMeta(v)) parts.push(v);
    }
    titles.push(parts.join(' → '));
  }
  return titles;
}

/** Ищет строку шапки: ту, где есть и «субъект», и «муниципальн». */
function findHeaderRow(rows, scanLimit = 30) {
  const limit = Math.min(rows.length, scanLimit);
  let fallback = -1;
  for (let r = 0; r < limit; r++) {
    const cells = (rows[r] || []).map(norm);
    const hasSubject = cells.some((v) => v.includes('субъект'));
    const hasMo = cells.some((v) => v.includes('муниципальн'));
    if (hasSubject && hasMo) return r;
    if (fallback < 0 && hasMo) fallback = r;
  }
  return fallback;
}

// ── Правила распознавания столбцов ────────────────────────────────────────
// Каждое правило: сначала исключения (not), затем обязательные группы (all),
// где каждая группа — список синонимов (достаточно одного).

const TEMPLATE_RULES = [
  { role: 'subject', label: 'Субъект РФ', all: [['субъект']], not: ['потребност'] },
  { role: 'mo', label: 'Муниципальное образование', all: [['муниципальн']], not: ['потребност'] },
  { role: 'mno_total', label: 'Количество МНО', all: [['мно', 'мест накопления', 'места накопления', 'площадок']], not: ['потребност', 'раздельн', 'контейнер'] },
  { role: 'mno_separate', label: 'Количество МНО с раздельным сбором', all: [['мно', 'мест накопления', 'места накопления', 'площадок'], ['раздельн']], not: ['потребност', 'контейнер'] },
  { role: 'cont_mixed', label: 'Контейнеры: смешанные ТКО', all: [['контейнер'], ['смешан', 'совместн', 'несортирован']], not: ['потребност'] },
  { role: 'cont_separate', label: 'Контейнеры: раздельный сбор', all: [['контейнер'], ['раздельн']], not: ['потребност'] },
  { role: 'cont_bulky', label: 'Контейнеры: КГО', all: [['контейнер'], ['кго', 'крупногабарит']], not: ['потребност'] },
  { role: 'cont_other', label: 'Контейнеры: иное', all: [['контейнер'], ['иное', 'иные', 'прочие', 'проч']], not: ['потребност'] },
];

const REGISTRY_RULES = [
  { role: 'subject', label: 'Субъект РФ', all: [['субъект']] },
  { role: 'mo', label: 'Муниципальное образование', all: [['муниципальн']] },
  { role: 'cont_total', label: 'Общее количество контейнеров', all: [['общее количество контейнер', 'общее кол во контейнер']] },
  { role: 'g_mixed', label: 'Контейнеры для совместного накопления, шт.', all: [['количество контейнер'], ['совместн', 'смешан', 'несортирован']] },
  { role: 'g_separate', label: 'Контейнеры для раздельного накопления, шт.', all: [['количество контейнер'], ['раздельн']] },
  { role: 'g_bulky', label: 'Контейнеры для КГО, шт.', all: [['количество контейнер'], ['крупногабарит', 'кго']] },
  { role: 'g_other', label: 'Иные контейнеры, шт.', all: [['количество контейнер'], ['иные', 'иное', 'прочие']] },
  { role: 'sep_flag', label: 'Наличие раздельного накопления', all: [['наличие раздельн']] },
];

function scoreRule(title, rule) {
  const t = norm(title);
  if (!t) return 0;
  for (const bad of rule.not || []) if (t.includes(bad)) return 0;
  let score = 0;
  for (const group of rule.all) {
    const hit = group.find((syn) => t.includes(syn));
    if (!hit) return 0;
    score += hit.length;
  }
  // Более короткий заголовок при равных совпадениях — более точный.
  return score + 100 / (t.length + 10);
}

/** Подбирает столбцы по правилам; на роль выбирается лучший столбец. */
export function mapColumns(titles, rules) {
  const map = {};
  for (const rule of rules) {
    let best = null;
    titles.forEach((title, i) => {
      const s = scoreRule(title, rule);
      if (s > 0 && (!best || s > best.score)) best = { index: i, score: s, title };
    });
    map[rule.role] = best
      ? { role: rule.role, label: rule.label, index: best.index, column: indexToCol(best.index + 1), title: best.title, auto: true }
      : { role: rule.role, label: rule.label, index: -1, column: '', title: '', auto: true };
  }
  return map;
}

export const templateRules = TEMPLATE_RULES;
export const registryRules = REGISTRY_RULES;

/** Выбирает лист шаблона: с таблицей «Сведения о местах (площадках) накопления», иначе первый подходящий. */
export function pickTemplateSheet(sheets) {
  const scored = sheets.map((sheet, order) => {
    const head = (sheet.rows.slice(0, 12).flat() || []).map(norm).join(' | ');
    let score = 0;
    if (/сведения о мест|сведения о площад|места площадки накопления|мест площадок накопления/.test(head)) score += 100;
    if (head.includes('субъект') && head.includes('муниципальн')) score += 50;
    if (head.includes('количество')) score += 10;
    score -= order; // при равенстве — более ранняя вкладка
    return { sheet, score, order };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].sheet;
}

/** Выбирает лист реестра: самый «широкий и длинный» с нужной шапкой. */
export function pickRegistrySheet(sheets) {
  const scored = sheets.map((sheet, order) => {
    const head = (sheet.rows.slice(0, 12).flat() || []).map(norm).join(' | ');
    let score = Math.min(sheet.rowCount, 100000) / 1000;
    if (head.includes('муниципальн')) score += 60;
    if (head.includes('контейнер')) score += 60;
    score -= order * 0.1;
    return { sheet, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].sheet;
}

/**
 * Разбирает шаблон: лист, границы шапки, строки муниципальных образований, столбцы.
 */
export function analyzeTemplate(workbook) {
  const sheet = pickTemplateSheet(workbook.sheets);
  const rows = sheet.rows;
  const headerRow = findHeaderRow(rows);
  if (headerRow < 0) {
    throw new Error(`На листе «${sheet.name}» не найдена шапка таблицы (нет столбца «Муниципальное образование»)`);
  }
  const width = Math.max(sheet.maxCol, 2);

  // Шапка может занимать несколько строк, ниже — строки-подсказки («список»,
  // «обязательное поле»). Данные начинаются с первой строки с реальным МО.
  const moColumnGuess = (rows[headerRow] || []).findIndex((v) => norm(v).includes('муниципальн'));
  let dataFrom = -1;
  let headerTo = headerRow;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const value = row[moColumnGuess >= 0 ? moColumnGuess : 1];
    if (value === undefined || value === null || String(value).trim() === '') { continue; }
    if (isMeta(value)) { headerTo = Math.max(headerTo, r - 1); continue; }
    dataFrom = r;
    break;
  }
  if (dataFrom < 0) throw new Error(`На листе «${sheet.name}» нет ни одной строки с муниципальным образованием`);

  // Строки шапки — все до первой строки-подсказки/данных.
  headerTo = headerRow;
  for (let r = headerRow + 1; r < dataFrom; r++) {
    const row = rows[r] || [];
    const filled = row.filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
    if (!filled.length) break;
    if (filled.every(isMeta)) break;
    headerTo = r;
  }

  const titles = buildTitles(rows, headerRow, headerTo, width);
  const columns = mapColumns(titles, TEMPLATE_RULES);
  const moIndex = columns.mo.index >= 0 ? columns.mo.index : (moColumnGuess >= 0 ? moColumnGuess : 1);
  const subjectIndex = columns.subject.index;

  const entries = [];
  let existingTotalRow = null;
  let gap = 0;
  for (let r = dataFrom; r < rows.length; r++) {
    const value = rows[r]?.[moIndex] ?? rows[r]?.[subjectIndex >= 0 ? subjectIndex : 0];
    if (value === undefined || value === null || String(value).trim() === '') {
      if (++gap > 5) break;
      continue;
    }
    gap = 0;
    // Шаблон мог уже содержать строку «ИТОГО» — её не считаем муниципалитетом,
    // а перезаписываем формулами.
    if (TOTAL_WORDS.has(norm(value))) { existingTotalRow = r + 1; continue; }
    entries.push({
      rowIndex: r,          // 0-based
      excelRow: r + 1,      // 1-based, как в Excel
      subject: subjectIndex >= 0 ? (rows[r]?.[subjectIndex] ?? '') : '',
      name: String(rows[r]?.[moIndex] ?? value).trim(),
    });
  }
  if (!entries.length) throw new Error('В шаблоне не найдено строк муниципальных образований');

  return {
    sheet, titles, columns, entries, width, existingTotalRow,
    headerFrom: headerRow, headerTo, dataFrom,
    firstDataExcelRow: entries[0].excelRow,
    lastDataExcelRow: entries[entries.length - 1].excelRow,
  };
}

/** Разбирает реестр: лист, шапка, первая строка данных, столбцы. */
export function analyzeRegistry(workbook) {
  const sheet = pickRegistrySheet(workbook.sheets);
  const rows = sheet.rows;
  const headerRow = findHeaderRow(rows);
  if (headerRow < 0) {
    throw new Error(`На листе «${sheet.name}» не найдена шапка реестра (нет столбца «Муниципальное образование»)`);
  }
  const width = sheet.maxCol;

  // Подшапка: следующая строка, если она заполнена «под» объединёнными ячейками.
  let headerTo = headerRow;
  const next = rows[headerRow + 1] || [];
  const nextFilled = next.filter((v) => v !== undefined && v !== null && String(v).trim() !== '').length;
  const topFilled = (rows[headerRow] || []).filter((v) => v !== undefined && v !== null && String(v).trim() !== '').length;
  if (nextFilled >= 2 && nextFilled < topFilled * 3) {
    const looksLikeData = norm(next[0] || '').length > 0 && !norm(next.join(' ')).includes('количество');
    if (!looksLikeData) headerTo = headerRow + 1;
  }

  const titles = buildTitles(rows, headerRow, headerTo, width);
  const columns = mapColumns(titles, REGISTRY_RULES);
  return {
    sheet, titles, columns, width,
    headerFrom: headerRow, headerTo,
    dataFrom: headerTo + 1,
    rowCount: Math.max(0, rows.length - (headerTo + 1)),
  };
}

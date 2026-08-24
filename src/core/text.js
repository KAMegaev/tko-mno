// Нормализация русских наименований и текста заголовков.

const NBSP = /[   ]/g;

/** Приводит строку к сравнимому виду: нижний регистр, ё→е, только буквы и цифры. */
export function norm(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(NBSP, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^0-9a-zа-я]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Слова, которые описывают тип муниципального образования, а не его имя.
// Для сравнения «по сути» их отбрасываем: «Вольский муниципальный район»
// и «Вольский район» должны совпасть.
const TYPE_WORDS = [
  'муниципальный район', 'муниципальное образование', 'муниципальный округ',
  'городской округ', 'городское поселение', 'сельское поселение',
  'внутригородской район', 'закрытое административно территориальное образование',
  'зато', 'архив', 'район', 'округ', 'город', 'поселок', 'посёлок', 'пгт',
  'рабочий поселок', 'село', 'станица', 'аул', 'имени', 'им', 'мо', 'г', 'с', 'п',
];

/** Ключ для сравнения без слов-типов («Вольский муниципальный район» → «вольский»). */
export function coreKey(value) {
  let s = ' ' + norm(value) + ' ';
  for (const w of TYPE_WORDS) s = s.split(' ' + w + ' ').join(' ');
  // повтор: после удаления составных остаются одиночные («муниципальный», «городской»)
  for (const w of ['муниципальный', 'муниципальное', 'городской', 'городское',
    'сельское', 'поселение', 'район', 'округ', 'город']) {
    s = s.split(' ' + w + ' ').join(' ');
  }
  return s.trim().replace(/\s+/g, ' ');
}

/** Расстояние Левенштейна (итеративное, одна строка памяти). */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Схожесть строк в диапазоне 0..1. */
export function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / max;
}

/** Число из ячейки реестра: понимает «1,5», пробелы-разделители, пустые значения. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const s = String(value).replace(NBSP, ' ').replace(/\s/g, '').replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** true, если значение вообще не похоже на число (для диагностики). */
export function isUnparsableNumber(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return !Number.isFinite(value);
  const s = String(value).replace(NBSP, ' ').replace(/\s/g, '').replace(',', '.');
  return s !== '' && !Number.isFinite(Number(s));
}

/**
 * Русское согласование с числительным.
 * plural(2, ['строка', 'строки', 'строк']) → 'строки'
 */
export function plural(n, forms) {
  const abs = Math.abs(Math.round(n)) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

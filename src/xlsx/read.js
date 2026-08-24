// Минимальный читатель .xlsx: распаковка zip + разбор XML листов.
// Используется вместо тяжёлых библиотек, чтобы страница оставалась лёгкой
// и чтобы исходный файл шаблона можно было позже пропатчить без потерь.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[code] ?? m;
  });
}

export function colToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n; // 1-based
}

export function indexToCol(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = (n - 1 - r) / 26;
  }
  return s;
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    if (inner === undefined) { out.push(''); continue; }
    // <t> может встречаться несколько раз (форматированный текст) — склеиваем.
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) text += t[1] === undefined ? '' : t[1];
    out.push(unescapeXml(text));
  }
  return out;
}

function cellValue(tag, body, shared) {
  const type = attr(tag, 't') || 'n';
  if (type === 'inlineStr') {
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
    let t;
    while ((t = tRe.exec(body)) !== null) text += t[1] === undefined ? '' : t[1];
    return unescapeXml(text);
  }
  const vm = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  if (!vm) return null;
  const raw = unescapeXml(vm[1]);
  switch (type) {
    case 's': {
      const idx = parseInt(raw, 10);
      return shared[idx] ?? '';
    }
    case 'str':
    case 'e':
      return raw;
    case 'b':
      return raw === '1';
    default: {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
  }
}

function parseSheet(xml, shared, limits) {
  const maxRows = limits?.maxRows ?? Infinity;
  const rows = [];
  let maxCol = 0;
  const cellRe = /<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = cellRe.exec(xml)) !== null) {
    const tag = ' ' + m[1];
    const ref = attr(tag, 'r');
    if (!ref) continue;
    const rm = ref.match(/^([A-Z]+)(\d+)$/);
    if (!rm) continue;
    const r = parseInt(rm[2], 10);
    if (r > maxRows) continue;
    const c = colToIndex(rm[1]);
    const value = m[2] === undefined ? null : cellValue(tag, m[2], shared);
    if (value === null || value === '') continue;
    if (!rows[r - 1]) rows[r - 1] = [];
    rows[r - 1][c - 1] = value;
    if (c > maxCol) maxCol = c;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return { rows, maxCol, rowCount: rows.length };
}

/**
 * Читает книгу .xlsx.
 * @param {Uint8Array} bytes содержимое файла
 * @returns {{sheets: Array<{name:string, path:string, rows:any[][], maxCol:number, rowCount:number}>, files: Record<string, Uint8Array>}}
 */
export function readWorkbook(bytes) {
  const fflate = globalThis.fflate;
  if (!fflate) throw new Error('fflate не загружена');
  let files;
  try {
    files = fflate.unzipSync(bytes);
  } catch (e) {
    throw new Error('Файл не является корректным .xlsx (не удалось распаковать архив)');
  }
  const dec = new TextDecoder('utf-8');
  const text = (p) => (files[p] ? dec.decode(files[p]) : null);

  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('Файл не является книгой Excel: не найден xl/workbook.xml');

  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\s+([^>]*)\/>/g)) {
    const tag = ' ' + m[1];
    const id = attr(tag, 'Id');
    let target = attr(tag, 'Target');
    if (!id || !target) continue;
    if (target.startsWith('/')) target = target.slice(1);
    else if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
    rels[id] = target;
  }

  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));

  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\s+([^>]*?)\/>/g)) {
    const tag = ' ' + m[1];
    const name = attr(tag, 'name');
    const rid = attr(tag, 'r:id') || attr(tag, 'id');
    const path = rels[rid];
    if (!name || !path || !files[path]) continue;
    const parsed = parseSheet(dec.decode(files[path]), shared);
    sheets.push({ name, path, state: attr(tag, 'state') || 'visible', ...parsed });
  }
  if (!sheets.length) throw new Error('В книге не найдено ни одного листа с данными');
  return { sheets, files };
}

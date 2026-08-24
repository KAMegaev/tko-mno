// Запись результата: точечный патч XML шаблона внутри исходного .xlsx.
// Так сохраняются все стили, выпадающие списки, настройки печати и прочие
// части файла, которые обычные библиотеки теряют при перезаписи.
import { indexToCol, colToIndex } from './read.js';

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const attrOf = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

const RE_ROW = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const RE_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function parseRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  return m ? { col: colToIndex(m[1]), row: parseInt(m[2], 10) } : null;
}

/** Собирает статистику стилей по столбцам в диапазоне данных. */
function collectColumnStyles(sheetXml, fromRow, toRow) {
  const perColumn = new Map();
  RE_ROW.lastIndex = 0;
  let rm;
  while ((rm = RE_ROW.exec(sheetXml)) !== null) {
    const r = parseInt(attrOf(' ' + rm[1], 'r') || '0', 10);
    if (r < fromRow || r > toRow || !rm[2]) continue;
    RE_CELL.lastIndex = 0;
    let cm;
    while ((cm = RE_CELL.exec(rm[2])) !== null) {
      const tag = ' ' + cm[1];
      const ref = parseRef(attrOf(tag, 'r'));
      if (!ref) continue;
      const s = attrOf(tag, 's');
      if (s === null) continue;
      if (!perColumn.has(ref.col)) perColumn.set(ref.col, new Map());
      const counts = perColumn.get(ref.col);
      counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  const best = new Map();
  for (const [col, counts] of perColumn) {
    let top = null;
    for (const [s, n] of counts) if (!top || n > top.n) top = { s, n };
    if (top) best.set(col, top.s);
  }
  return best;
}

function renderCell(col, row, cell, style) {
  const ref = indexToCol(col) + row;
  const s = style !== null && style !== undefined ? ` s="${style}"` : '';
  if (cell.formula !== undefined) {
    const cached = cell.value === undefined || cell.value === null ? '' : `<v>${escapeXml(cell.value)}</v>`;
    return `<c r="${ref}"${s}><f>${escapeXml(cell.formula)}</f>${cached}</c>`;
  }
  if (cell.value === null || cell.value === undefined || cell.value === '') return `<c r="${ref}"${s}/>`;
  if (typeof cell.value === 'number') {
    if (!Number.isFinite(cell.value)) return `<c r="${ref}"${s}/>`;
    return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
}

/** Добавляет в styles.xml полужирный вариант указанного формата ячейки. */
function makeBoldStyles(stylesXml, baseStyles) {
  const fontsBlock = stylesXml.match(/<fonts\b([^>]*)>([\s\S]*?)<\/fonts>/);
  const xfsBlock = stylesXml.match(/<cellXfs\b([^>]*)>([\s\S]*?)<\/cellXfs>/);
  if (!fontsBlock || !xfsBlock) return { xml: stylesXml, map: new Map() };

  const fonts = fontsBlock[2].match(/<font(?:\s[^>]*)?>[\s\S]*?<\/font>|<font(?:\s[^>]*)?\/>/g) || [];
  const xfs = xfsBlock[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
  if (!xfs.length) return { xml: stylesXml, map: new Map() };

  const newFonts = [...fonts];
  const newXfs = [...xfs];
  const map = new Map();
  const boldFontCache = new Map();

  for (const base of baseStyles) {
    const idx = base === null || base === undefined ? 0 : parseInt(base, 10);
    const xf = newXfs[Number.isFinite(idx) && idx < xfs.length ? idx : 0];
    const fontId = parseInt(attrOf(' ' + xf, 'fontId') || '0', 10);
    let boldFontId = boldFontCache.get(fontId);
    if (boldFontId === undefined) {
      const font = newFonts[fontId] || '<font><sz val="11"/><name val="Calibri"/></font>';
      let bold;
      if (/<b\/>|<b\s/.test(font)) bold = font;
      else if (/<font(?:\s[^>]*)?\/>/.test(font)) bold = '<font><b/></font>';
      else bold = font.replace(/<font(\s[^>]*)?>/, (m) => m + '<b/>');
      boldFontId = newFonts.length;
      newFonts.push(bold);
      boldFontCache.set(fontId, boldFontId);
    }
    let boldXf = xf
      .replace(/\sfontId="\d+"/, ` fontId="${boldFontId}"`)
      .replace(/\sapplyFont="[^"]*"/, '');
    if (!/\sfontId="/.test(boldXf)) boldXf = boldXf.replace('<xf', `<xf fontId="${boldFontId}"`);
    boldXf = boldXf.replace('<xf', '<xf applyFont="1"');
    map.set(String(base ?? ''), String(newXfs.length));
    newXfs.push(boldXf);
  }

  let xml = stylesXml
    .replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/, `<fonts count="${newFonts.length}">${newFonts.join('')}</fonts>`)
    .replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/, `<cellXfs count="${newXfs.length}">${newXfs.join('')}</cellXfs>`);
  return { xml, map };
}

/** Обрезает диапазоны проверки данных, чтобы итоговая строка не считалась ошибкой. */
function trimValidationRanges(sheetXml, lastDataRow, totalRow) {
  const fix = (sqref) => sqref.split(/\s+/).map((range) => {
    const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!m) return range;
    const start = parseInt(m[2], 10);
    const end = parseInt(m[4], 10);
    if (start <= totalRow && end >= totalRow && end > lastDataRow) {
      return `${m[1]}${m[2]}:${m[3]}${Math.max(lastDataRow, start)}`;
    }
    return range;
  }).join(' ');

  return sheetXml
    .replace(/(<dataValidation\b[^>]*\ssqref=")([^"]*)(")/g, (m, a, sq, b) => a + fix(sq) + b)
    .replace(/(<xm:sqref>)([\s\S]*?)(<\/xm:sqref>)/g, (m, a, sq, b) => a + fix(sq) + b);
}

/**
 * Заполняет шаблон и возвращает готовый .xlsx.
 *
 * @param {{files: Record<string, Uint8Array>}} workbook исходный шаблон (readWorkbook)
 * @param {string} sheetPath путь листа внутри книги
 * @param {Map<number, Map<number, {value?:any, formula?:string}>>} updates строка(1-based) → столбец(1-based) → ячейка
 * @param {{row:number, cells: Map<number, object>, bold?: boolean}|null} totalRow итоговая строка
 * @param {{firstDataRow:number, lastDataRow:number}} range диапазон данных
 * @returns {Uint8Array}
 */
export function writeFilledWorkbook(workbook, sheetPath, updates, totalRow, range) {
  const fflate = globalThis.fflate;
  const dec = new TextDecoder('utf-8');
  const enc = new TextEncoder();
  const files = { ...workbook.files };
  let sheetXml = dec.decode(files[sheetPath]);

  const columnStyles = collectColumnStyles(sheetXml, range.firstDataRow, range.lastDataRow);
  const styleFor = (col) => (columnStyles.has(col) ? columnStyles.get(col) : null);

  // Полужирные стили для итоговой строки.
  let boldMap = new Map();
  if (totalRow?.bold && files['xl/styles.xml']) {
    const bases = [...new Set([...totalRow.cells.keys()].map((c) => styleFor(c)))];
    const res = makeBoldStyles(dec.decode(files['xl/styles.xml']), bases);
    files['xl/styles.xml'] = enc.encode(res.xml);
    boldMap = res.map;
  }
  const totalStyleFor = (col) => {
    const base = styleFor(col);
    return boldMap.get(String(base ?? '')) ?? base;
  };

  let maxCol = 0;
  for (const cols of updates.values()) for (const c of cols.keys()) maxCol = Math.max(maxCol, c);
  if (totalRow) for (const c of totalRow.cells.keys()) maxCol = Math.max(maxCol, c);

  // ── Правка существующих строк ────────────────────────────────────────────
  const sheetDataMatch = sheetXml.match(/<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>|<sheetData\b[^>]*\/>/);
  if (!sheetDataMatch) throw new Error('В листе шаблона не найден блок sheetData');
  let body = sheetDataMatch[1] ?? '';

  body = body.replace(RE_ROW, (whole, rawAttrs, inner) => {
    const attrs = ' ' + rawAttrs;
    const r = parseInt(attrOf(attrs, 'r') || '0', 10);
    const patch = updates.get(r);
    if (!patch) return whole;
    const cells = new Map();
    if (inner) {
      RE_CELL.lastIndex = 0;
      let cm;
      while ((cm = RE_CELL.exec(inner)) !== null) {
        const ref = parseRef(attrOf(' ' + cm[1], 'r'));
        if (ref) cells.set(ref.col, { xml: cm[0], style: attrOf(' ' + cm[1], 's') });
      }
    }
    for (const [col, cell] of patch) {
      const style = cells.get(col)?.style ?? styleFor(col);
      cells.set(col, { xml: renderCell(col, r, cell, style), style });
    }
    const ordered = [...cells.entries()].sort((a, b) => a[0] - b[0]);
    const spanEnd = Math.max(maxCol, ordered.length ? ordered[ordered.length - 1][0] : 1);
    const newAttrs = rawAttrs.replace(/\sspans="[^"]*"/, '') + ` spans="1:${spanEnd}"`;
    return `<row${newAttrs}>${ordered.map(([, c]) => c.xml).join('')}</row>`;
  });

  // ── Итоговая строка ──────────────────────────────────────────────────────
  let lastRow = range.lastDataRow;
  if (totalRow) {
    const ordered = [...totalRow.cells.entries()].sort((a, b) => a[0] - b[0]);
    const xml = ordered
      .map(([col, cell]) => renderCell(col, totalRow.row, cell, totalStyleFor(col)))
      .join('');
    const rowXml = `<row r="${totalRow.row}" spans="1:${maxCol}">${xml}</row>`;
    const existing = new RegExp(`<row\\b[^>]*\\sr="${totalRow.row}"[^>]*(?:/>|>[\\s\\S]*?</row>)`);
    body = existing.test(body) ? body.replace(existing, rowXml) : body + rowXml;
    lastRow = Math.max(lastRow, totalRow.row);
    sheetXml = trimValidationRanges(sheetXml, range.lastDataRow, totalRow.row);
  }

  sheetXml = sheetXml.replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>|<sheetData\b[^>]*\/>/, `<sheetData>${body}</sheetData>`);

  // ── dimension ────────────────────────────────────────────────────────────
  sheetXml = sheetXml.replace(/<dimension\s+ref="([^"]*)"\s*\/>/, (m, ref) => {
    const parts = ref.split(':');
    const start = parseRef(parts[0]) || { col: 1, row: 1 };
    const end = parseRef(parts[1] || parts[0]) || start;
    const col = Math.max(end.col, maxCol);
    const row = Math.max(end.row, lastRow);
    return `<dimension ref="${indexToCol(start.col)}${start.row}:${indexToCol(col)}${row}"/>`;
  });

  files[sheetPath] = enc.encode(sheetXml);

  // ── Пересчёт при открытии ────────────────────────────────────────────────
  if (files['xl/workbook.xml']) {
    let wb = dec.decode(files['xl/workbook.xml']);
    if (/<calcPr\b[^>]*>/.test(wb)) {
      wb = wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`);
    } else {
      wb = wb.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
    }
    files['xl/workbook.xml'] = enc.encode(wb);
  }

  // Устаревшая цепочка вычислений мешает пересчёту — удаляем.
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    if (files['[Content_Types].xml']) {
      const ct = dec.decode(files['[Content_Types].xml'])
        .replace(/<Override[^>]*calcChain\.xml[^>]*\/>/g, '');
      files['[Content_Types].xml'] = enc.encode(ct);
    }
    if (files['xl/_rels/workbook.xml.rels']) {
      const rels = dec.decode(files['xl/_rels/workbook.xml.rels'])
        .replace(/<Relationship[^>]*calcChain\.xml[^>]*\/>/g, '');
      files['xl/_rels/workbook.xml.rels'] = enc.encode(rels);
    }
  }

  return fflate.zipSync(files, { level: 6 });
}

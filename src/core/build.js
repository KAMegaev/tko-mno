// Сборка выходного файла: значения по строкам + формулы SUM в итоговой строке.
import { indexToCol } from '../xlsx/read.js';
import { writeFilledWorkbook } from '../xlsx/write.js';

// Роли шаблона, которые заполняем числами. Столбцы «Потребность …»
// сознательно остаются пустыми — таких данных в реестре нет.
export const VALUE_ROLES = [
  { role: 'mno_total', field: 'mno' },
  { role: 'mno_separate', field: 'mnoSeparate' },
  { role: 'cont_mixed', field: 'mixed' },
  { role: 'cont_separate', field: 'separate' },
  { role: 'cont_bulky', field: 'bulky' },
  { role: 'cont_other', field: 'other' },
];

export const TOTAL_LABEL = 'ИТОГО';

/**
 * @param {object} templateWorkbook результат readWorkbook(шаблон)
 * @param {object} templateInfo результат analyzeTemplate
 * @param {object} agg результат aggregate
 * @returns {{bytes: Uint8Array, totalExcelRow: number, filledColumns: string[], skippedRoles: string[]}}
 */
export function buildOutput(templateWorkbook, templateInfo, agg) {
  const { columns, entries, sheet } = templateInfo;
  const updates = new Map();
  const filledColumns = [];
  const skippedRoles = [];

  const active = VALUE_ROLES.filter(({ role }) => {
    const col = columns[role];
    if (!col || col.index < 0) { skippedRoles.push(role); return false; }
    filledColumns.push(col.column);
    return true;
  });

  entries.forEach((entry, i) => {
    const value = agg.perRow[i];
    const cells = new Map();
    for (const { role, field } of active) {
      cells.set(columns[role].index + 1, { value: value[field] });
    }
    updates.set(entry.excelRow, cells);
  });

  const firstDataRow = templateInfo.firstDataExcelRow;
  const lastDataRow = templateInfo.lastDataExcelRow;
  const totalExcelRow = templateInfo.existingTotalRow && templateInfo.existingTotalRow > lastDataRow
    ? templateInfo.existingTotalRow
    : lastDataRow + 1;

  const totalCells = new Map();
  const labelIndex = columns.mo.index >= 0 ? columns.mo.index : 0;
  totalCells.set(labelIndex + 1, { value: TOTAL_LABEL });
  for (const { role, field } of active) {
    const letter = columns[role].column;
    totalCells.set(columns[role].index + 1, {
      formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})`,
      value: agg.totals[field],
    });
  }

  const bytes = writeFilledWorkbook(
    templateWorkbook,
    sheet.path,
    updates,
    { row: totalExcelRow, cells: totalCells, bold: true },
    { firstDataRow, lastDataRow },
  );

  return { bytes, totalExcelRow, filledColumns, skippedRoles, labelColumn: indexToCol(labelIndex + 1) };
}

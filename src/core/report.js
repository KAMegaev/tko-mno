// Отчёт о сборке: контрольные суммы и найденные проблемы.
import { UNCLASSIFIED_MODES } from './aggregate.js';
import { plural } from './text.js';

const fmt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n * 1000) / 1000);
const rows = (n) => `${fmt(n)} ${plural(n, ['строка', 'строки', 'строк'])}`;

/**
 * @returns {{controls: Array, problems: Array, summary: object}}
 */
export function buildReport(ctx) {
  const { templateInfo, registryInfo, links, missing, unlinked, agg, output, files } = ctx;
  const problems = [];
  const add = (level, title, detail) => problems.push({ level, title, detail });

  // ── Контрольные суммы ────────────────────────────────────────────────────
  const t = agg.totals;
  const s = agg.stats;
  const expectedContainers = agg.mode === 'drop' ? s.totalContainersBreakdown : s.totalContainersRegistry;
  const templateContainers = t.mixed + t.separate + t.bulky + t.other;

  const controls = [
    { label: 'Строк реестра обработано', value: fmt(s.scanned), note: `лист «${registryInfo.sheet.name}», данные с ${registryInfo.dataFrom + 1}-й строки` },
    { label: 'Количество МНО (сумма по шаблону)', value: fmt(t.mno), note: 'должно совпадать с числом обработанных строк', ok: t.mno + s.skippedRows === s.scanned },
    { label: 'Количество МНО с раздельным накоплением', value: fmt(t.mnoSeparate), note: 'строки, где контейнеров для раздельного накопления > 0' },
    { label: 'Контейнеров в реестре («Общее количество»)', value: fmt(s.totalContainersRegistry), note: 'сумма по столбцу реестра' },
    { label: 'Контейнеров по группам в реестре', value: fmt(s.totalContainersBreakdown), note: 'сумма четырёх столбцов с разбивкой' },
    { label: 'Контейнеров без разбивки по группам', value: fmt(s.unclassifiedContainers), note: `${rows(s.breakdownMissing + s.breakdownPartial)} · ${UNCLASSIFIED_MODES[agg.mode]}` },
    { label: 'Контейнеров записано в шаблон (сумма E:H)', value: fmt(templateContainers), note: `сходится с контролем ${fmt(expectedContainers)}`, ok: Math.abs(templateContainers - expectedContainers) < 1e-6 },
  ];

  for (const c of controls) {
    if (c.ok === false) add('error', `Контрольная сумма не сходится: ${c.label}`, `Получено ${c.value}, ожидалось иное. Проверьте распознавание столбцов.`);
  }

  // ── Проблемы сопоставления ───────────────────────────────────────────────
  if (missing.length) {
    add('warn', `В реестре нет данных для ${missing.length} ${plural(missing.length, ['строки', 'строк', 'строк'])} шаблона`,
      missing.map((m) => `${m.name} (строка ${m.excelRow})`).join('; ') + '. Эти строки заполнены нулями.');
  }
  if (unlinked.length) {
    const lost = unlinked.reduce((a, l) => a + l.registryRows, 0);
    add('error', `${unlinked.length} ${plural(unlinked.length, ['наименование', 'наименования', 'наименований'])} реестра не привязаны к шаблону`,
      `Потеряно ${rows(lost)} реестра: ` + unlinked.map((l) => l.registryName).join('; '));
  }
  const manual = links.filter((l) => l.source === 'manual').length;
  const fuzzy = links.filter((l) => l.kind === 'fuzzy' || l.kind === 'ambiguous').length;
  if (fuzzy) add('info', `${fuzzy} ${plural(fuzzy, ['соответствие подобрано', 'соответствия подобраны', 'соответствий подобрано'])} по схожести названий`, 'Проверено и подтверждено на шаге сопоставления.');
  if (manual) add('info', `${manual} ${plural(manual, ['соответствие задано', 'соответствия заданы', 'соответствий задано'])} вручную`, '');

  // ── Проблемы данных ──────────────────────────────────────────────────────
  if (s.breakdownMissing) {
    add(agg.mode === 'drop' ? 'warn' : 'info',
      `${rows(s.breakdownMissing)} с общим количеством контейнеров, но без разбивки по группам`,
      `Всего ${fmt(s.unclassifiedContainers)} ${plural(s.unclassifiedContainers, ['контейнер', 'контейнера', 'контейнеров'])}. Выбранное правило — ${UNCLASSIFIED_MODES[agg.mode]}.`);
  }
  if (s.breakdownPartial) {
    add('warn', `${rows(s.breakdownPartial)}, где разбивка по группам меньше общего количества`,
      'Разница отнесена по тому же правилу, что и строки без разбивки.');
  }
  if (s.breakdownOver) {
    add('warn', `${rows(s.breakdownOver)}, где сумма по группам больше «Общего количества»`,
      'Учтены значения по группам; «Общее количество» в этих строках занижено.');
  }
  if (s.unparsable) add('warn', `${fmt(s.unparsable)} ${plural(s.unparsable, ['нечисловое значение', 'нечисловых значения', 'нечисловых значений'])} в числовых столбцах реестра`, 'Такие значения считаны как 0.');
  if (s.emptyMo) add('warn', `${rows(s.emptyMo)} реестра без муниципального образования`, 'Они не попали ни в одну строку шаблона.');
  if (s.containersNoFlag) {
    add('info', `${rows(s.containersNoFlag)} с контейнерами для раздельного накопления при отметке «Наличие раздельного накопления» ≠ Да`,
      'Учитывались контейнеры, а не отметка — как и требуется.');
  }
  if (s.flagYesNoContainers) {
    add('info', `${rows(s.flagYesNoContainers)} с отметкой «Наличие раздельного накопления» = Да, но без контейнеров для раздельного накопления`,
      'В графу «МНО с раздельным сбором» не попали.');
  }
  if (output?.skippedRoles?.length) {
    add('error', 'В шаблоне не найдены столбцы', output.skippedRoles.join(', ') + '. Они остались незаполненными.');
  }
  if (!problems.length) add('ok', 'Проблем не обнаружено', '');

  const summary = {
    templateFile: files?.templateName || '',
    registryFile: files?.registryName || '',
    templateSheet: templateInfo.sheet.name,
    registrySheet: registryInfo.sheet.name,
    rowsFilled: templateInfo.entries.length,
    totalRow: output?.totalExcelRow,
    columns: output?.filledColumns?.join(', ') || '',
    dataRange: `${templateInfo.firstDataExcelRow}–${templateInfo.lastDataExcelRow}`,
  };

  return { controls, problems, summary };
}

/** Текстовая версия отчёта — для копирования в письмо или служебную записку. */
export function reportToText(report, ctx) {
  const L = [];
  L.push('ОТЧЁТ О СБОРКЕ ФАЙЛА МЕСТ НАКОПЛЕНИЯ ОТХОДОВ');
  L.push(new Date().toLocaleString('ru-RU'));
  L.push('');
  L.push(`Реестр:  ${report.summary.registryFile} → лист «${report.summary.registrySheet}»`);
  L.push(`Шаблон:  ${report.summary.templateFile} → лист «${report.summary.templateSheet}»`);
  L.push(`Заполнено строк: ${report.summary.rowsFilled} (${report.summary.dataRange}), столбцы ${report.summary.columns}`);
  L.push(`Итоговая строка «ИТОГО» с формулами SUM: строка ${report.summary.totalRow}`);
  L.push('');
  L.push('КОНТРОЛЬНЫЕ СУММЫ');
  for (const c of report.controls) {
    const mark = c.ok === false ? ' [!]' : c.ok === true ? ' [сходится]' : '';
    L.push(`  ${c.label}: ${c.value}${mark}${c.note ? ` — ${c.note}` : ''}`);
  }
  L.push('');
  L.push('ПРОБЛЕМЫ');
  const names = { error: 'ОШИБКА', warn: 'ВНИМАНИЕ', info: 'СПРАВОЧНО', ok: 'ОК' };
  for (const p of report.problems) {
    L.push(`  [${names[p.level]}] ${p.title}${p.detail ? `\n      ${p.detail}` : ''}`);
  }
  if (ctx?.links?.length) {
    L.push('');
    L.push('СООТВЕТСТВИЕ НАИМЕНОВАНИЙ (реестр → шаблон)');
    for (const l of ctx.links) {
      L.push(`  ${l.registryName} → ${l.templateName || '— не привязано —'} (${l.registryRows} стр.)`);
    }
  }
  return L.join('\n');
}

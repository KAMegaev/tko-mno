// Связка интерфейса: загрузка → столбцы → соответствия → сборка файла.
import { indexToCol } from '../xlsx/read.js';
import { templateRules, registryRules } from '../core/detect.js';
import { UNCLASSIFIED_MODES } from '../core/aggregate.js';
import { plural } from '../core/text.js';
import { api, suggestColumns, suggestMatches } from '../ai/client.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmt = (n) => new Intl.NumberFormat('ru-RU').format(n);

const state = {
  files: { registry: null, template: null },
  templateWb: null, registryWb: null,
  tpl: null, reg: null,
  links: [], mode: 'mixed',
  agg: null, output: null, report: null,
  ai: {}, sessionId: null, reportText: '',
  aiTarget: null,
  step: 1,
};

// ── Навигация ───────────────────────────────────────────────────────────────
function setStep(n) {
  state.step = n;
  $$('.step').forEach((el) => el.classList.toggle('is-current', Number(el.dataset.step) === n));
  $$('.stepper li').forEach((el) => {
    const i = Number(el.dataset.nav);
    el.classList.toggle('is-current', i === n);
    el.classList.toggle('is-done', i < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(sel, message) {
  const el = $(sel);
  if (!message) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = message;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function withBusy(button, label, fn) {
  const original = button.textContent;
  button.textContent = label;
  button.classList.add('is-busy');
  try {
    // даём браузеру перерисовать кнопку до тяжёлой синхронной работы
    await new Promise((r) => setTimeout(r, 16));
    return await fn();
  } finally {
    button.textContent = original;
    button.classList.remove('is-busy');
  }
}

// ── Шаг 1. Файлы ────────────────────────────────────────────────────────────
function bindDrop(el) {
  const kind = el.dataset.drop;
  const input = $('input', el);
  const accept = async (file) => {
    if (!file) return;
    if (!/\.(xlsx|xlsm|xltx)$/i.test(file.name)) {
      showError('#parse-error', `Файл «${file.name}» не в формате .xlsx — старый формат .xls не поддерживается, пересохраните его в Excel.`);
      return;
    }
    if (file.size > 12 * 1048576) {
      showError('#parse-error', 'Каждый файл должен быть не больше 12 МБ.');
      return;
    }
    showError('#parse-error', '');
    state.files[kind] = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    el.classList.add('is-set');
    $('.drop-file', el).textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} МБ`;
    $('#btn-parse').disabled = !(state.files.registry && state.files.template);
  };
  input.addEventListener('change', () => accept(input.files[0]));
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-over');
    accept(e.dataTransfer.files[0]);
  });
}

function encodeFile(file) {
  let binary = '';
  for (let i = 0; i < file.bytes.length; i += 32768) binary += String.fromCharCode(...file.bytes.subarray(i, i + 32768));
  return { name: file.name, data: btoa(binary) };
}

function selectedColumns() {
  return Object.fromEntries([['template', state.tpl], ['registry', state.reg]].map(([kind, info]) =>
    [kind, Object.fromEntries(Object.entries(info.columns).map(([role, c]) => [role, c.index]))]));
}

async function parseFiles() {
  showError('#parse-error', '');
  try {
    if (state.sessionId) await api('reset', {}, state.sessionId).catch(() => {});
    state.sessionId = null;
    const data = await api('files', {
      template: encodeFile(state.files.template),
      registry: encodeFile(state.files.registry),
    });
    state.sessionId = data.sessionId;
    state.tpl = data.tpl;
    state.reg = data.reg;
    state.output = null;
    state.report = null;
    renderColumns();
    setStep(2);
  } catch (error) {
    showError('#parse-error', error.message);
  }
}

// ── Шаг 2. Столбцы ──────────────────────────────────────────────────────────
function columnRow(info, roleDef, titles, onChange) {
  const tr = document.createElement('tr');
  const tdRole = document.createElement('td');
  tdRole.className = 'role';
  tdRole.textContent = roleDef.label;
  const tdSel = document.createElement('td');
  const select = document.createElement('select');
  const none = new Option('— не найден —', '-1');
  select.append(none);
  titles.forEach((title, i) => {
    select.append(new Option(`${indexToCol(i + 1)} — ${title || '(без заголовка)'}`, String(i)));
  });
  select.value = String(info.index);
  // Полный заголовок не помещается в поле — показываем его подсказкой.
  const syncTitle = () => { select.title = select.selectedOptions[0]?.textContent || ''; };
  syncTitle();
  select.addEventListener('change', () => {
    syncTitle();
    info.index = Number(select.value);
    info.column = info.index >= 0 ? indexToCol(info.index + 1) : '';
    info.title = info.index >= 0 ? titles[info.index] : '';
    info.auto = false;
    onChange();
  });
  tdSel.append(select);
  tr.append(tdRole, tdSel);
  if (info.index < 0) tr.classList.add('is-bad');
  return tr;
}

function renderColumns() {
  const { tpl, reg } = state;
  $('#tpl-sheet').textContent = `лист «${tpl.sheet.name}», строки ${tpl.firstDataExcelRow}–${tpl.lastDataExcelRow}`;
  $('#reg-sheet').textContent = `лист «${reg.sheet.name}», ${fmt(reg.rowCount)} строк данных`;

  const tplBody = $('#tpl-columns tbody');
  tplBody.textContent = '';
  for (const rule of templateRules) {
    tplBody.append(columnRow(tpl.columns[rule.role], rule, tpl.titles, renderColumns));
  }
  const regBody = $('#reg-columns tbody');
  regBody.textContent = '';
  for (const rule of registryRules) {
    regBody.append(columnRow(reg.columns[rule.role], rule, reg.titles, renderColumns));
  }

  const missing = [...templateRules, ...registryRules]
    .filter((r) => (templateRules.includes(r) ? tpl : reg).columns[r.role].index < 0);
  showError('#columns-error', missing.length
    ? 'Не найдены столбцы: ' + missing.map((r) => r.label).join(', ') + '. Выберите их вручную — иначе они останутся незаполненными.'
    : '');

  $('#unclassified-note').textContent =
    'В реестре встречаются строки, где заполнено «Общее количество контейнеров», но разбивка по группам пуста. '
    + 'Точное количество таких строк показано в отчёте на последнем шаге.';
}

// ── Шаг 3. Серверное сопоставление МО ────────────────────────────────────────
async function prepareMatching() {
  try {
    const data = await api('match', { columns: selectedColumns() }, state.sessionId);
    state.tpl = data.tpl;
    state.reg = data.reg;
    state.links = data.links;
    return true;
  } catch (error) {
    showError('#columns-error', error.message);
    return false;
  }
}

function renderMo() {
  const { links, tpl } = state;
  const body = $('#mo-rows');
  body.textContent = '';

  const order = [...links].sort((a, b) => {
    const rank = (l) => (l.templateIndex === null ? 0 : l.status === 'review' ? 1 : 2);
    return rank(a) - rank(b) || a.registryName.localeCompare(b.registryName, 'ru');
  });

  for (const link of order) {
    const tr = document.createElement('tr');
    if (link.templateIndex === null) tr.classList.add('is-bad');
    else if (link.status === 'review') tr.classList.add('is-review');

    const tdName = document.createElement('td');
    tdName.textContent = link.registryName;
    const tdRows = document.createElement('td');
    tdRows.className = 'num';
    tdRows.textContent = fmt(link.registryRows);

    const tdSel = document.createElement('td');
    const select = document.createElement('select');
    select.append(new Option('— не учитывать —', ''));
    tpl.entries.forEach((e, i) => {
      select.append(new Option(`${e.excelRow}. ${e.name}`, String(i)));
    });
    select.value = link.templateIndex === null ? '' : String(link.templateIndex);
    select.addEventListener('change', () => {
      link.templateIndex = select.value === '' ? null : Number(select.value);
      link.templateName = link.templateIndex === null ? '' : tpl.entries[link.templateIndex].name;
      link.status = 'auto';
      link.kind = 'manual';
      link.source = 'manual';
      renderMo();
    });
    tdSel.append(select);

    const tdHow = document.createElement('td');
    const tag = document.createElement('span');
    const KIND = {
      exact: ['tag-auto', 'точное совпадение'],
      core: ['tag-auto', 'совпадение без слов-типов'],
      fuzzy: ['tag-review', `по схожести ${Math.round(link.score * 100)}%`],
      ambiguous: ['tag-review', 'несколько похожих строк'],
      none: ['tag-none', 'не найдено'],
      manual: ['tag-auto', 'выбрано вручную'],
      ai: ['tag-ai', 'подсказка ИИ'],
    };
    const [cls, text] = KIND[link.kind] || ['tag', link.kind];
    tag.className = 'tag ' + cls;
    tag.textContent = text;
    tdHow.append(tag);

    tr.append(tdName, tdRows, tdSel, tdHow);
    body.append(tr);
  }

  const hits = new Set(links.filter((l) => l.templateIndex !== null).map((l) => l.templateIndex));
  const missing = tpl.entries.map((e, i) => ({ ...e, i })).filter((e) => !hits.has(e.i));
  const unlinked = links.filter((l) => l.templateIndex === null);
  const review = links.filter((l) => l.status === 'review' && l.templateIndex !== null);

  $('#mo-summary').innerHTML = '';
  const box = (value, label, level) => {
    const d = document.createElement('div');
    d.className = 'box' + (level ? ' is-' + level : '');
    d.innerHTML = `<b></b><span></span>`;
    $('b', d).textContent = fmt(value);
    $('span', d).textContent = label;
    return d;
  };
  const names = (n) => plural(n, ['наименование', 'наименования', 'наименований']);
  $('#mo-summary').append(
    box(links.length, `${names(links.length)} в реестре`),
    box(links.length - unlinked.length, 'привязано к шаблону'),
    box(review.length, `${plural(review.length, ['требует', 'требуют', 'требуют'])} проверки`, review.length ? 'warn' : ''),
    box(unlinked.length, 'не привязано'.concat(unlinked.length === 1 ? ' наименование' : ''), unlinked.length ? 'bad' : ''),
    box(missing.length, `${plural(missing.length, ['строка', 'строки', 'строк'])} шаблона без данных`, missing.length ? 'warn' : ''),
  );

  const missBox = $('#mo-missing-box');
  missBox.hidden = missing.length === 0;
  $('#mo-missing-count').textContent = String(missing.length);
  const ul = $('#mo-missing');
  ul.textContent = '';
  for (const m of missing) {
    const li = document.createElement('li');
    li.textContent = `строка ${m.excelRow} — ${m.name}`;
    ul.append(li);
  }

  showError('#mo-error', unlinked.length
    ? `${unlinked.length} наименований реестра ни к чему не привязаны — их записи (${fmt(unlinked.reduce((a, l) => a + l.registryRows, 0))} строк) в файл не попадут. Выберите строку шаблона или оставьте «не учитывать» осознанно.`
    : '');
}

// ── Шаг 4. Сборка ───────────────────────────────────────────────────────────
async function build() {
  state.mode = $('input[name="unclassified"]:checked').value;
  const data = await api('build', { columns: selectedColumns(), links: state.links, mode: state.mode }, state.sessionId);
  const response = await fetch('/api/result', { headers: { 'x-mno-session': state.sessionId } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Не удалось скачать результат с сервера');
  }
  state.tpl = data.tpl;
  state.agg = data.agg;
  state.output = { ...data.output, bytes: new Uint8Array(await response.arrayBuffer()) };
  state.report = data.report;
  state.reportText = data.reportText;
  renderReport();
  setStep(4);
}

function renderReport() {
  const { report, agg, output, tpl } = state;

  const body = $('#controls');
  body.textContent = '';
  for (const c of report.controls) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = c.label;
    if (c.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = c.note;
      td1.append(note);
    }
    const td2 = document.createElement('td');
    td2.className = 'value';
    td2.textContent = c.value;
    if (c.ok === false) tr.classList.add('is-bad');
    tr.append(td1, td2);
    body.append(tr);
  }

  const ul = $('#problems');
  ul.textContent = '';
  for (const p of report.problems) {
    const li = document.createElement('li');
    li.className = 'lvl-' + p.level;
    const t = document.createElement('div');
    t.className = 'p-title';
    t.textContent = p.title;
    li.append(t);
    if (p.detail) {
      const d = document.createElement('div');
      d.className = 'p-detail';
      d.textContent = p.detail;
      li.append(d);
    }
    ul.append(li);
  }

  const facts = $('#facts');
  facts.textContent = '';
  const addFact = (k, v) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  };
  addFact('Лист', `«${tpl.sheet.name}» — первая вкладка с таблицей сведений о местах накопления`);
  addFact('Строки', `${tpl.firstDataExcelRow}–${tpl.lastDataExcelRow}, порядок и наименования не изменялись`);
  addFact('Столбцы со значениями', output.filledColumns.join(', '));
  addFact('Итоговая строка', `${output.totalExcelRow} — «ИТОГО», формулы SUM(${output.filledColumns[0]}${tpl.firstDataExcelRow}:${output.filledColumns[0]}${tpl.lastDataExcelRow}) и аналогичные`);
  addFact('Столбцы «Потребность»', 'оставлены пустыми — таких данных в реестре нет');
  addFact('Контейнеры без разбивки', UNCLASSIFIED_MODES[agg.mode]);

  $('#save-hint').textContent = window.showSaveFilePicker
    ? 'Кнопка «Сохранить файл…» откроет выбор папки на компьютере.'
    : `Браузер не поддерживает выбор папки — файл уйдёт в папку загрузок под именем «${asciiName(outputName())}».`;
}

function outputName() {
  const base = state.files.template.name.replace(/\.(xlsx|xlsm|xltx)$/i, '');
  return `${base} — заполнено.xlsx`;
}

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Имя файла для обычной загрузки через ссылку.
 * Chromium в этом пути отбрасывает любое имя с символами вне ASCII — файл
 * приходит как «download» без расширения, поэтому имя транслитерируем.
 * Диалог выбора папки (showSaveFilePicker) с юникодом работает нормально
 * и получает исходное название.
 */
function asciiName(name) {
  const out = [...name].map((ch) => {
    const lower = ch.toLowerCase();
    if (TRANSLIT[lower] !== undefined) {
      const t = TRANSLIT[lower];
      return ch === lower ? t : t.charAt(0).toUpperCase() + t.slice(1);
    }
    return /[A-Za-z0-9 ._()-]/.test(ch) ? ch : '-';
  }).join('').replace(/-{2,}/g, '-').replace(/\s{2,}/g, ' ').trim();
  return out.replace(/^[-.\s]+/, '') || 'result.xlsx';
}

async function saveFile(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime });
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: name.endsWith('.txt') ? 'Текст' : 'Книга Excel', accept: { [mime]: [name.slice(name.lastIndexOf('.'))] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      toast('Файл сохранён');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      // не удалось — уходим в обычную загрузку
    }
  }
  const url = URL.createObjectURL(blob);
  const fallbackName = asciiName(name);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackName;
  a.rel = 'noopener';
  // Ссылка должна быть в документе, иначе часть браузеров игнорирует имя файла.
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Файл отправлен в загрузки: ${fallbackName}`);
}

// ── Помощник OpenAI через сервер сайта ──────────────────────────────────────
function openAi(target) {
  state.aiTarget = target;
  const button = $(target === 'columns' ? '#btn-ai-columns' : '#btn-ai-mo');
  return withBusy(button, 'Запрос к ИИ…', runAi);
}

async function runAi() {
  state.ai = { sessionId: state.sessionId, columns: selectedColumns() };
  const target = state.aiTarget;
  const errorSel = target === 'columns' ? '#columns-error' : '#mo-error';
  try {
    if (target === 'columns') {
      toast('Спрашиваю модель про столбцы…');
      const tplRes = await suggestColumns(state.ai, { what: 'шаблон МНО' });
      const regRes = await suggestColumns(state.ai, { what: 'выгрузка реестра' });
      let applied = 0;
      const apply = (info, res, titles) => {
        for (const r of res) {
          const col = info[r.role];
          if (!col) continue;
          const i = r.columnIndex;
          if (i === null || i === undefined || i < 0 || i >= titles.length) continue;
          if (col.index === i) continue;
          col.index = i;
          col.column = indexToCol(i + 1);
          col.title = titles[i];
          col.auto = false;
          applied++;
        }
      };
      apply(state.tpl.columns, tplRes, state.tpl.titles);
      apply(state.reg.columns, regRes, state.reg.titles);
      renderColumns();
      toast(applied ? `Модель изменила ${applied} столбцов` : 'Модель подтвердила текущее распознавание');
    } else {
      const pending = state.links.filter((l) => l.templateIndex === null || l.status === 'review');
      if (!pending.length) { toast('Все наименования уже сопоставлены'); return; }
      toast('Спрашиваю модель про наименования…');
      const res = await suggestMatches(state.ai, {
        registryNames: pending.map((l) => l.registryName),
        templateNames: state.tpl.entries.map((e) => e.name),
      });
      const byName = new Map(state.tpl.entries.map((e, i) => [e.name, i]));
      let applied = 0;
      for (const m of res) {
        const link = state.links.find((l) => l.registryName === m.registry);
        if (!link) continue;
        const idx = m.template === null ? null : byName.get(m.template);
        if (m.template !== null && idx === undefined) continue;
        link.templateIndex = idx === undefined ? null : idx;
        link.templateName = idx === undefined || idx === null ? '' : state.tpl.entries[idx].name;
        link.kind = 'ai';
        link.source = 'ai';
        link.status = m.confidence >= 0.8 && link.templateIndex !== null ? 'auto' : 'review';
        link.score = m.confidence ?? 0;
        applied++;
      }
      renderMo();
      toast(`Модель обработала ${applied} наименований — проверьте подсказки`);
    }
    showError(errorSel, '');
  } catch (e) {
    showError(errorSel, 'Помощник не сработал: ' + e.message);
  }
}

// ── Запуск ──────────────────────────────────────────────────────────────────
$$('.drop').forEach(bindDrop);

$('#btn-parse').addEventListener('click', (e) => withBusy(e.currentTarget, 'Читаю файлы…', parseFiles));
$('#btn-reset').addEventListener('click', async () => {
  if (state.sessionId) await api('reset', {}, state.sessionId).catch(() => {});
  location.reload();
});
$$('[data-goto]').forEach((b) => b.addEventListener('click', () => setStep(Number(b.dataset.goto))));

$('#btn-to-mo').addEventListener('click', (e) => withBusy(e.currentTarget, 'Сверяю наименования…', async () => {
  if (!await prepareMatching()) return;
  renderMo();
  setStep(3);
}));

$('#btn-build').addEventListener('click', (e) => withBusy(e.currentTarget, 'Собираю файл…', async () => {
  try {
    await build();
  } catch (err) {
    showError('#mo-error', 'Не удалось собрать файл: ' + err.message);
  }
}));

$('#btn-save').addEventListener('click', () => saveFile(
  state.output.bytes, outputName(),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
));

$('#btn-save-report').addEventListener('click', () => saveFile(
  new TextEncoder().encode('\uFEFF' + state.reportText),
  'Отчёт о сборке.txt', 'text/plain;charset=utf-8',
));

$('#btn-copy-report').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.reportText);
    toast('Отчёт скопирован');
  } catch {
    toast('Браузер не дал доступ к буферу обмена');
  }
});

$('#btn-ai-columns').addEventListener('click', () => openAi('columns'));
$('#btn-ai-mo').addEventListener('click', () => openAi('mo'));
// Старый ключ из прежней версии больше не используется.
sessionStorage.removeItem('anthropicKey');
fetch('/api/config').then(async response => {
  if (!response.ok) throw new Error('Сервер недоступен');
  const config = await response.json();
  $('#ai-status').textContent = config.aiReady
    ? 'ИИ: OpenAI через сервер сайта, модель ' + config.model + '. API-ключ хранится на сервере.'
    : 'ИИ пока не подключён: администратору нужно настроить серверный API-ключ.';
  $('#btn-ai-columns').disabled = !config.aiReady;
  $('#btn-ai-mo').disabled = !config.aiReady;
}).catch(() => { $('#ai-status').textContent = 'Не удалось проверить подключение к серверу.'; });

setStep(1);

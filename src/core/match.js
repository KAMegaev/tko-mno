// Сопоставление наименований муниципальных образований: шаблон ↔ реестр.
import { norm, coreKey, similarity } from './text.js';

export const AUTO_THRESHOLD = 0.90;   // выше — считаем совпадением без вопросов
export const SUGGEST_THRESHOLD = 0.62; // выше — предлагаем на проверку человеку

/** Собирает уникальные наименования МО из строк реестра. */
export function collectRegistryNames(rows, dataFrom, moIndex) {
  const counts = new Map();
  for (let r = dataFrom; r < rows.length; r++) {
    const v = rows[r]?.[moIndex];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const name = String(v).trim();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, rowCount]) => ({ name, rowCount }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/**
 * Строит таблицу соответствий «наименование в реестре → строка шаблона».
 * Каждое наименование реестра привязывается не более чем к одной строке шаблона,
 * но одна строка шаблона может собирать несколько наименований реестра.
 *
 * @returns {{links: Array, templateHits: Map<number, string[]>}}
 */
export function buildMatching(templateEntries, registryNames) {
  const targets = templateEntries.map((e, i) => ({
    i, entry: e, full: norm(e.name), core: coreKey(e.name),
  }));

  const links = registryNames.map((src) => {
    const full = norm(src.name);
    const core = coreKey(src.name);
    let exact = targets.find((t) => t.full === full);
    if (exact) {
      return link(src, exact, 1, 'exact', 'auto');
    }
    const coreHits = targets.filter((t) => t.core && t.core === core);
    if (coreHits.length === 1) return link(src, coreHits[0], 0.97, 'core', 'auto');
    if (coreHits.length > 1) {
      // Неоднозначно: несколько строк шаблона дают одинаковый «корень».
      const best = pickBest(coreHits, full, core);
      return link(src, best.target, best.score, 'ambiguous', 'review', coreHits.map((t) => t.i));
    }
    const best = pickBest(targets, full, core);
    if (!best.target) return link(src, null, 0, 'none', 'review');
    if (best.score >= AUTO_THRESHOLD) return link(src, best.target, best.score, 'fuzzy', 'auto');
    if (best.score >= SUGGEST_THRESHOLD) return link(src, best.target, best.score, 'fuzzy', 'review');
    return link(src, null, best.score, 'none', 'review', [best.target.i]);
  });

  const templateHits = new Map();
  for (const l of links) {
    if (l.templateIndex === null) continue;
    if (!templateHits.has(l.templateIndex)) templateHits.set(l.templateIndex, []);
    templateHits.get(l.templateIndex).push(l.registryName);
  }
  return { links, templateHits };
}

function pickBest(targets, full, core) {
  let best = { target: null, score: 0 };
  for (const t of targets) {
    const s = Math.max(similarity(full, t.full), core && t.core ? similarity(core, t.core) : 0);
    if (s > best.score) best = { target: t, score: s };
  }
  return best;
}

function link(src, target, score, kind, status, alternatives = []) {
  return {
    registryName: src.name,
    registryRows: src.rowCount,
    templateIndex: target ? target.i : null,
    templateName: target ? target.entry.name : '',
    score: Math.round(score * 1000) / 1000,
    kind,          // exact | core | fuzzy | ambiguous | none
    status,        // auto | review
    source: 'rules',
    alternatives,
  };
}

/** Строки шаблона, для которых в реестре не нашлось ни одной записи. */
export function missingTemplateRows(templateEntries, templateHits) {
  return templateEntries
    .map((e, i) => ({ i, entry: e }))
    .filter(({ i }) => !templateHits.has(i))
    .map(({ i, entry }) => ({ index: i, name: entry.name, excelRow: entry.excelRow }));
}

/** Наименования реестра, которые никуда не привязаны (их данные потеряются). */
export function unlinkedRegistryNames(links) {
  return links.filter((l) => l.templateIndex === null);
}

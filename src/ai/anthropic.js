// Необязательный помощник на Claude: уточняет распознавание столбцов и
// сопоставление наименований муниципальных образований.
//
// Страница статическая и собирается без бандлера, поэтому обращение к API идёт
// напрямую через fetch, а не через @anthropic-ai/sdk. Ключ пользователя никуда,
// кроме api.anthropic.com, не отправляется и хранится только в этой вкладке.

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — точнее' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — быстрее и дешевле' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — самый дешёвый' },
];

async function ask({ apiKey, model, system, prompt, schema, effort = 'medium' }) {
  if (!apiKey) throw new Error('Не указан API-ключ Anthropic');
  const body = {
    model: model || MODELS[0].id,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        // Требуется, чтобы браузер мог обращаться к API напрямую.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Не удалось связаться с api.anthropic.com: ' + e.message);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* пусто */ }
    throw new Error(`API Anthropic вернул ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Модель отклонила запрос');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Модель вернула ответ не в формате JSON');
  }
}

const MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['registry', 'template', 'confidence', 'reason'],
        properties: {
          registry: { type: 'string', description: 'наименование из реестра, дословно' },
          template: { type: ['string', 'null'], description: 'наименование из шаблона, дословно, или null' },
          confidence: { type: 'number', description: 'уверенность от 0 до 1' },
          reason: { type: 'string', description: 'краткое обоснование' },
        },
      },
    },
  },
};

/**
 * Просит модель сопоставить наименования МО, которые не удалось привязать правилами.
 * @returns {Promise<Array<{registry:string, template:string|null, confidence:number, reason:string}>>}
 */
export async function suggestMatches(config, { registryNames, templateNames }) {
  const data = await ask({
    ...config,
    system: 'Ты помогаешь сверять наименования муниципальных образований России в двух таблицах. '
      + 'Отвечай только на основании списков, ничего не выдумывай. Если подходящего варианта нет, ставь null. '
      + 'Учитывай, что одно и то же образование может называться по-разному: «Вольский муниципальный район» и «Вольский район», '
      + '«Городской округ город Саратов» и «г. Саратов», «Городской округ поселок Светлый (ЗАТО)» и «ЗАТО Светлый».',
    prompt: 'Наименования из реестра, которым нужно найти пару:\n'
      + registryNames.map((n) => `- ${n}`).join('\n')
      + '\n\nДоступные наименования из шаблона:\n'
      + templateNames.map((n) => `- ${n}`).join('\n')
      + '\n\nДля каждого наименования реестра укажи наименование шаблона (дословно из списка) или null.',
    schema: MATCH_SCHEMA,
  });
  return Array.isArray(data.matches) ? data.matches : [];
}

const COLUMN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['columns'],
  properties: {
    columns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'columnIndex', 'reason'],
        properties: {
          role: { type: 'string' },
          columnIndex: { type: ['integer', 'null'], description: 'номер столбца из списка, начиная с 0; null — не найден' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Просит модель сопоставить роли со столбцами по заголовкам.
 * @returns {Promise<Array<{role:string, columnIndex:number|null, reason:string}>>}
 */
export async function suggestColumns(config, { titles, roles, what }) {
  const data = await ask({
    ...config,
    system: 'Ты сопоставляешь смысловые роли со столбцами таблицы Excel по их заголовкам. '
      + 'Выбирай только из предложенных номеров столбцов. Если подходящего столбца нет — null.',
    prompt: `Таблица: ${what}.\n\nЗаголовки столбцов:\n`
      + titles.map((t, i) => `${i}: ${t || '(пусто)'}`).join('\n')
      + '\n\nРоли, которые нужно найти:\n'
      + roles.map((r) => `- ${r.role}: ${r.label}`).join('\n'),
    schema: COLUMN_SCHEMA,
  });
  return Array.isArray(data.columns) ? data.columns : [];
}

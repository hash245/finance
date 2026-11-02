/**
 * Посредник для распознавания банковских скриншотов (Cloudflare Worker).
 *
 * Переменные (Settings → Variables and Secrets):
 *   ANTHROPIC_API_KEY  — секрет, ключ из console.anthropic.com
 *   BOT_TOKEN          — секрет, токен вашего бота из @BotFather (нужен только для проверки, что запрос пришёл из вашего Mini App)
 *   ALLOWED_USERS      — текст, необязательно: id пользователей Telegram через запятую, кому разрешено
 *   MODEL              — текст, необязательно: модель Claude (по умолчанию claude-haiku-5-5)
 */

const ALLOWED_ORIGIN = 'https://hash245.github.io';
const MAX_IMAGES = 6;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method === 'GET') return reply({ ok: true, service: 'finance-ai' });
    if (request.method !== 'POST') return reply({ error: 'Метод не поддерживается' }, 405);

    let body;
    try { body = await request.json(); } catch { return reply({ error: 'Неверный запрос' }, 400); }

    // 1. Проверяем, что запрос пришёл из Telegram от разрешённого пользователя
    if (!env.BOT_TOKEN || !env.ANTHROPIC_API_KEY) return reply({ error: 'Посредник не настроен: нет BOT_TOKEN или ANTHROPIC_API_KEY' }, 500);
    const user = await checkInitData(body.initData || '', env.BOT_TOKEN);
    if (!user) return reply({ error: 'Доступ запрещён: откройте приложение из Telegram' }, 403);
    const allowed = (env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(String(user.id))) return reply({ error: 'Доступ запрещён для этого аккаунта' }, 403);

    // 2. Картинки
    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    if (!images.length) return reply({ error: 'Нет картинок' }, 400);
    for (const img of images) if (typeof img !== 'string' || img.length > 6_000_000) return reply({ error: 'Картинка слишком большая' }, 400);

    const ctx = body.context || {};
    const content = images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } }));
    content.push({ type: 'text', text: buildPrompt(ctx) });

    // 3. Запрос к Claude со строгой схемой ответа
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.MODEL || 'claude-haiku-5-5',
        max_tokens: 4096,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: TOOL.name },
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return reply({ error: 'Ошибка ИИ: ' + ((data.error && data.error.message) || res.status) }, 502);
    const block = (data.content || []).find(b => b.type === 'tool_use');
    if (!block) return reply({ error: 'ИИ не вернул результат' }, 502);
    return reply({ transactions: block.input.transactions || [], usage: data.usage });
  },
};

const TOOL = {
  name: 'save_transactions',
  description: 'Сохранить операции, найденные на скриншотах банковского приложения',
  input_schema: {
    type: 'object',
    properties: {
      transactions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Дата операции YYYY-MM-DD' },
            time: { type: 'string', description: 'Время HH:MM, если видно, иначе пустая строка' },
            type: { type: 'string', enum: ['expense', 'income'] },
            amount: { type: 'number', description: 'Сумма, всегда положительная, в валюте операции' },
            currency: { type: 'string', description: 'Код валюты ISO: KZT, RUB, USD, EUR…' },
            merchant: { type: 'string', description: 'Магазин, сервис или имя отправителя/получателя — коротко, как на скрине' },
            category: { type: 'string', description: 'Ровно одна категория из списка' },
            own_transfer: { type: 'boolean', description: 'true, если это перевод между своими счетами/картами/депозитами' },
          },
          required: ['date', 'type', 'amount', 'currency', 'merchant', 'category', 'own_transfer'],
        },
      },
    },
    required: ['transactions'],
  },
};

function buildPrompt(ctx) {
  const exp = (ctx.expenseCats || []).join(', ');
  const inc = (ctx.incomeCats || []).join(', ');
  return `Это скриншоты из банковского приложения (например, Kaspi, Halyk, Сбербанк, Тинькофф).
Найди на них ВСЕ операции и вызови save_transactions.

Правила:
- Сегодня ${ctx.today || ''}. «Сегодня», «Вчера», даты без года — переведи в YYYY-MM-DD относительно сегодняшней даты (дата не может быть в будущем).
- Если дата написана заголовком над группой операций — она относится ко всем операциям группы.
- Расход (покупки, оплаты, переводы другим людям, снятие наличных, комиссии) → type "expense". Поступления (зарплата, перевод от человека, пополнение, кэшбэк, проценты, возврат) → "income".
- Знак «−» обычно означает расход, «+» — доход. Цвет зелёный часто означает доход.
- Валюта по умолчанию: ${ctx.currency || 'KZT'}, если на скрине не видно другой.
- Категория расхода — одна из: ${exp}. Категория дохода — одна из: ${inc}. Если не подходит ничего — «Другое».
  Подсказки: супермаркеты (Magnum, Small, Galmart, Пятёрочка, Магнит) → Продукты; рестораны, кофейни, доставка еды (Glovo, Wolt) → Кафе;
  такси и общественный транспорт (Yandex Go, inDrive, Onay) → Транспорт; АЗС → Авто; аптеки → Здоровье; мобильная связь, интернет → Связь;
  Netflix, Spotify, Яндекс Плюс, iCloud → Подписки; Kaspi Gold/Red платежи за товары → по смыслу товара или магазина.
- Переводы между своими счетами (на свой депозит, «между своими», с карты на свою карту) → own_transfer: true.
- Не включай строки с остатком/балансом, бонусами без денег, рекламные блоки и незавершённые (отклонённые) операции.
- Не выдумывай: если операция видна частично и сумма не читается — пропусти её.
- Одна и та же операция может быть на нескольких скриншотах — не дублируй.`;
}

// Проверка подписи Telegram WebApp initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function checkInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const hmac = async (key, msg) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof msg === 'string' ? enc.encode(msg) : msg));
  };
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const sig = await hmac(secret, dataCheck);
  const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== hash) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400 * 7) return null; // сессия старше недели
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

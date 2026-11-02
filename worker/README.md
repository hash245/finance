# Посредник для распознавания скриншотов

Cloudflare Worker, который принимает скриншоты из Mini App, проверяет подпись Telegram
и отправляет их в Claude API. Ключ API хранится только здесь, в секретах Cloudflare.

Переменные: `ANTHROPIC_API_KEY` (секрет), `BOT_TOKEN` (секрет), `ALLOWED_USERS` (id через запятую), `MODEL` (необязательно).

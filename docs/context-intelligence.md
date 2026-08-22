# Context Intelligence Layer

Context Intelligence — опциональный слой качественной информации: интервью, клубные события,
экспертные прогнозы и будущие настраиваемые источники. Он работает только в режиме `SHADOW ONLY`.
Его оценки не передаются в production-вероятности, fair odds, edge, EV, Data Quality, Confidence или
классификацию VALUE/NEAR/WAIT/NO_BET.

## Архитектура

- `src/context/contextEngine.js` — безопасный сбор, сопоставление с матчами и агрегация.
- `contextTypes.js` — нормализованный формат и разделение FACT/QUOTE/REPORT/RUMOUR/EXPERT_OPINION.
- `contextScore.js` — независимые reliability, relevance, freshness и shadow Context Score.
- `dedupe.js` — защита от повторного учёта репостов.
- `fixtureMatching.js` — консервативное сопоставление команд, соперника и времени матча.
- `providers/footboom.js` — первый публичный провайдер.
- `providers/interviews.js`, `clubNews.js`, `telegram.js` — адаптеры для будущих проверенных источников.

Надёжность источника отделена от тональности. Базовые значения находятся в
`src/context/config.js`. Telegram не считается подтверждённым фактом и требует явно настроенного
списка каналов. Повторные загрузки ограничиваются локальным TTL-кешем в runtime-каталоге.

## Настройка

```env
CONTEXT_INTELLIGENCE_ENABLED=false
CONTEXT_CACHE_TTL_MINUTES=60
CONTEXT_FOOTBOOM_TTL_MINUTES=60
CONTEXT_REQUEST_TIMEOUT_SECONDS=15
CONTEXT_FOOTBOOM_RELIABILITY=60
CONTEXT_TELEGRAM_RELIABILITY=30
CONTEXT_TELEGRAM_CHANNELS=
CONTEXT_DEBUG=false
```

После включения результат сохраняется в `contextAnalysis` каждого матча и в
`history/analyses.jsonl`. В Telegram полная сводка доступна из карточки матча по кнопке
`🧠 Context`; основной dashboard не перегружается.

## Ограничения

FootBoom может отвечать Cloudflare challenge. Тогда провайдер возвращает нефатальный статус `N/A`
с причиной `CLOUDFLARE_CHALLENGE`; обход защиты не выполняется, данные не выдумываются. Провайдеры
интервью, клубных новостей и Telegram пока являются интерфейсами без непроверенных или жёстко
заданных источников.

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
CONTEXT_SOURCE_WINDOW_HOURS=72
CONTEXT_SOURCE_TTL_MINUTES=60
CONTEXT_ARTICLE_TTL_MINUTES=360
CONTEXT_MIN_HOST_INTERVAL_MS=1000
CONTEXT_SOURCE_CONCURRENCY=2
CONTEXT_MAX_ARTICLES_PER_SOURCE=3
CONTEXT_ENABLED_SOURCE_IDS=
CONTEXT_FOOTBOOM_RELIABILITY=60
CONTEXT_TELEGRAM_RELIABILITY=30
CONTEXT_TELEGRAM_CHANNELS=
CONTEXT_DEBUG=false
```

После включения результат сохраняется в `contextAnalysis` каждого матча и в
`history/analyses.jsonl`. В Telegram полная сводка доступна из карточки матча по кнопке
`🧠 Context`; основной dashboard не перегружается.

Stage 12 включает небольшой проверенный реестр реальных HTML-источников:

- официальный сайт Tottenham Hotspur (`PL`);
- официальный сайт Inter (`SA`);
- официальный сайт Ligue 1 (`FL1`);
- официальный сайт Lega Serie A (`SA`).

Premier League index присутствует в реестре выключенным: доступная HTML-страница не содержит
серверных ссылок на статьи, поэтому заявлять её рабочим источником нельзя. Начальное покрытие `PL`
обеспечивается только официальным сайтом Tottenham для матчей этого клуба.

Это фактическое начальное покрытие, а не заявление о поддержке всех турниров. Источник загружается
только при наличии соответствующего матча. Индекс фильтруется по обеим командам или по клубу и
сопернику; затем загружается ограниченное число статей. Материал без реального времени публикации
или вне предматчевого окна не используется.

Для изолированной live-проверки без запуска odds/API-Football pipeline:

```bash
npm run context:live
```

Append-only shadow dataset сохраняется в `<runtime>/context/analyses.jsonl`.

## Ограничения

FootBoom может отвечать Cloudflare challenge. Тогда провайдер возвращает нефатальный статус `N/A`
с причиной `CLOUDFLARE_CHALLENGE`; обход защиты не выполняется, данные не выдумываются. Провайдеры
интервью, клубных новостей и Telegram пока являются интерфейсами без непроверенных или жёстко
заданных источников.

## Обязательный Telegram registry

По требованию владельца зарегистрированы обязательные источники:

- `Метод Фидча. Курилка.` — `UNKNOWN`;
- `game. set. press 🎾` — `TENNIS`;
- `Теннис🎾Чатик 💬` — `TENNIS`;
- `Бегущий по линии | Прогноз…` — `UNKNOWN`;
- `LUXEBET ANALYTICS ⚽️🏒` — `MULTISPORT`;
- `Dychkovsky 🎾` — `TENNIS`.

Подтверждённые владельцем публичные связи активированы без угадывания:

- `Метод Фидча. Курилка.` → `@MethodFidch`;
- `LUXEBET ANALYTICS ⚽️🏒` → `@luxebetanalyt`.

`@jagsunci17` и шесть переданных внутренних ID хранятся в очереди разрешения отдельно от
source registry со статусом `UNRESOLVED`: они не связываются с отображаемыми именами без точного
совпадения title/username/ID. Resolver объединяет username и channel ID одного источника и не
создаёт дубликат. Недоступный или приватный чат остаётся неактивным; ограничения Telegram не
обходятся. Надёжность всех Telegram-источников остаётся `null / UNRATED`.

Основной механизм для внешних публичных источников — read-only загрузка страниц
`https://t.me/s/<username>`. Она не требует добавления `@FVM_Value_Bot` в канал, не использует
приватный контент и кешируется с ограничением частоты запросов. Доступные публикации сохраняются
append-only в runtime-файле `data/context/telegram-posts.jsonl`. Дополнительный Bot API путь может
принимать `channel_post` и `edited_channel_post`, если такие updates уже законно доставляются боту,
но он не является обязательным или основным способом мониторинга. Адаптер сохраняет исходные
`messageId`, `publishedAt`, `editedAt`,
`channelId`, `username` и title, классифицирует спорт и тип поста, а для ставок
извлекает match, market, selection, odds, bookmaker, author и reasoning. В FVM передаются только
посты, классифицированные как `FOOTBALL`; `TENNIS`, `HOCKEY`, `OTHER` и `UNKNOWN` не влияют на FVM.
Теннисные записи сохраняются для будущей TVM-интеграции,
но не попадают в football Context Score. Multisport-посты классифицируются по содержанию каждого
сообщения.

Все Telegram-события имеют нулевую начальную надёжность и остаются shadow data. Для каждого канала
подготовлена независимая статистика `picks/gradedPicks/wins/losses/pushes/hitRate/roi/avgOdds/clv/sampleSize`;
она не заполняется заявлениями самого канала и в будущем должна строиться только по независимо
проверенным результатам. Пост считается предматчевым только при `publishedAt < kickoff`; время
редактирования сохраняется отдельно для обнаружения последующих изменений.

### Включение мониторинга каналов

1. Для публичного канала зарегистрировать подтверждённый публичный username. Context Intelligence
   читает только опубликованную Telegram web-страницу и не требует действий владельца канала.
2. Указать действующий Bot API token в `TELEGRAM_BOT_TOKEN` только для команд самого FVM-бота.
   Публичный read-only provider от него не зависит.
3. Запустить FVM. Публичные страницы опрашиваются через общий кешированный Context HTTP client.
   Дополнительный единственный long-polling loop запрашивает `message`, `callback_query`,
   `channel_post` и `edited_channel_post`. Startup-диагностика без секретов показывает результат
   `getMe`, количество разрешённых и доступных источников.
4. При `MISSING_TOKEN` или `UNAUTHORIZED` Telegram UI и дополнительный Bot delivery отключаются без
   повторного polling-спама. Публичный read-only Context provider и фоновое обновление футбольных
   данных продолжают работать.

Публичная web-страница показывает только ограниченное окно публикаций и может не содержать точного
времени редактирования. Bot API не предоставляет произвольную загрузку истории. Закрытые каналы,
страницы с login/access restriction и Telegram-защиты не обходятся; такие источники получают
`PRIVATE`, `BLOCKED` или `UNRESOLVED` и не загружаются.

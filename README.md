# FVM Engine v0.5 + Telegram

Это первая версия, в которой Telegram использует не демонстрационные карточки, а реальный FVM-конвейер.

## Реализовано из утверждённой FVM

- Data Integrity: отсутствие данных не заменяется выдуманными значениями.
- 24-часовой скан реального расписания.
- Match Classification.
- Team Strength Model:
  - общая таблица;
  - отдельная домашняя и гостевая статистика, когда доступна;
  - голы за/против;
  - Poisson score matrix.
- Recent Form Model.
- Schedule Congestion Index:
  - дни после последнего матча;
  - сравнительная нагрузка.
- Consensus Engine нескольких независимых моделей.
- Market Agreement Index по разбросу коэффициентов букмекеров.
- Автоматическое удаление маржи.
- Реальные рынки:
  - 1X2;
  - Asian Handicap, когда Odds API его возвращает;
  - Over/Under, когда Odds API его возвращает.
- DNB и BTTS рассчитываются моделью, но получают WAIT, если API не дал реальный коэффициент.
- Data Quality.
- Stability Score.
- Confidence.
- FDS.
- Red Flags.
- Quality Gates.
- VALUE / Near Value / WAIT / NO BET.
- Максимум пять рекомендаций.
- Telegram Dashboard и раскрывающиеся реальные карточки.

## Не выдаётся за реализованное

Пока отсутствуют либо неполны:

- настоящий xG-провайдер;
- Tactical Model с PPDA и стилями;
- автоматическое сопоставление травм и составов между двумя API;
- история движения коэффициента и CLV;
- вечерний Audit Engine.

Их отсутствие снижает Data Quality. Код не создаёт вместо них фиктивные показатели.

## Нужные ключи

1. Telegram Bot Token.
2. football-data.org Token.
3. The Odds API key.

Все три обязательны для запуска этой версии.

## Запуск

1. Остановите старый бот (`Ctrl+C`).
2. Распакуйте архив в новую папку.
3. Запустите `start.bat`.
4. Заполните `.env`.
5. Снова запустите `start.bat`.
6. В Telegram отправьте `/refresh`.

## .env

```env
TELEGRAM_BOT_TOKEN=...
ALLOWED_CHAT_IDS=...
FOOTBALL_DATA_TOKEN=...
THE_ODDS_API_KEY=...
ODDS_REGION=eu
HORIZON_HOURS=24
MIN_EDGE_PP=4
MIN_EV_PERCENT=5
MIN_CONFIDENCE=70
MIN_DATA_QUALITY=70
MIN_STABILITY=70
MAX_RECOMMENDATIONS=5
REFRESH_MINUTES=30
MARKET_STALE_MINUTES=360
```

## Важно о бесплатном Odds API

Запрос нескольких рынков и лиг расходует квоту. Для первого запуска можно оставить только основные лиги или увеличить REFRESH_MINUTES. Бот обновляет данные не чаще заданного интервала.

Последний валидный market snapshot хранится локально. При временной недоступности провайдеров он помечается `STALE` в пределах `MARKET_STALE_MINUTES`; истёкший snapshot не используется, а `STALE` не может создать новый `VALUE`.

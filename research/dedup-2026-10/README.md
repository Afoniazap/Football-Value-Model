# FVM — дедупликация истории матчей (исследование, 2026-10-20)

Статус: **ИССЛЕДОВАНИЕ**. Ничего здесь не подключено к `src/`, не вызывается
из `app.js`, не влияет на работающего бота. Полный отчёт — в
`FVM_DEDUPLICATION_RESEARCH_RU.md` в корне репозитория.

## Файлы

- `dedupeV2.js` — предлагаемый алгоритм классификации и группировки
  (чистые функции, без I/O, без обращения к SQLite напрямую).
- `dedupeV2.test.js` — юнит-тесты (`node research/dedup-2026-10/dedupeV2.test.js`).
- `run-local-audit.mjs` — автономный скрипт для запуска в Termux на реальной
  копии `football.sqlite` и реальном чекауте `~/FVM-Android-Termux-v0.5`.
  Безопасность: исходный `--db` никогда не открывается напрямую (только его
  копия), исходный `--repo` используется только на чтение (dynamic import),
  никаких `merge/push/deploy/restart`, никакого доступа к `.env`.

## Запуск в Termux

```sh
node research/dedup-2026-10/run-local-audit.mjs \
  --repo ~/FVM-Android-Termux-v0.5 \
  --db ~/fvm-fb-backup-v8NrXs/football.sqlite \
  --audit-dir ~/fallback-audit-20261020-072741 \
  --out ~/fvm-dedup-research-output
```

Требуется Node >= 22.5 (как и у `termux-v0.5`, из-за `node:sqlite`).

Результат: `report.json` (полные данные) и `report.md` (сводка на русском) в
каталоге `--out`. Ни исходный `.sqlite`, ни `~/FVM-Android-Termux-v0.5` не
изменяются — скрипт физически не может писать в них (путь `--db` не
открывается, только его копия; `--repo` только читается через `import()`).

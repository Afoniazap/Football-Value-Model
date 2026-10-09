# Контрольный baseline FVM (P0) — безопасный набор для Termux

Назначение: зафиксировать, **что FVM делает сейчас**, до любых изменений слоя идентичности, и получить данные для проверки гипотез аудита. Набор только читает: SQLite открывается `readOnly`, `.env` не читается, запросов к провайдерам нет, `src/` не затрагивается. Результаты пишутся в `data/baseline/<UTC-метка>/` (каталог `data/` в `.gitignore`).

## 1. Установка набора на Termux (без изменения рабочего кода)

```bash
cd ~/Football-Value-Model            # корень вашего клона
git fetch origin claude/fvm-baseline-kit termux-v0.5 claude/termux-form-window-audit
git archive origin/claude/fvm-baseline-kit scripts/baseline docs/baseline-kit.md docs/identity-layer-plan.md test/baselineKit.test.js | tar -x -C .
git status --short                    # должны появиться ТОЛЬКО новые файлы в scripts/baseline, docs/, test/baselineKit.test.js
```
`git archive … | tar -x` кладёт файлы без индексации и без смены ветки; рабочая ветка `termux-v0.5` не меняется.

## 2. Одна команда

```bash
bash scripts/baseline/run-all.sh 14 7f383c1 9977de8 0b72b25 89b4edb e7e133c origin/claude/termux-form-window-audit
```
Первый аргумент — окно replay в днях; далее коммиты для сравнения: `7f383c1` до PR #2, `9977de8` после PR #2, `0b72b25` после PR #3, `89b4edb` после PR #4, `e7e133c` после PR #5, последний — PR #6. Без коммитов replay пропускается.

Что делает (по порядку): `capture` (контрольные показатели) → `freeze-db` (замороженная копия SQLite для воспроизводимых сравнений) → `identity-census` → `name-corpus` → `identity-legacy-snapshot` → `fixture-dup-census` (state и снимки) → `replay-drift` (по замороженной копии).

Отдельные команды (если нужно запускать по одной): `node scripts/baseline/<имя>.mjs` — шапка каждого файла описывает аргументы.

## 3. Что прислать обратно (только названия, источники, счётчики)

```bash
D=$(ls -d data/baseline/* | tail -1); echo $D
cat $D/capture.summary.json
head -c 6000 $D/identity-census.json
cat $D/fixture-dup-census.json; cat $D/fixture-dup-census.snapshots.txt
head -c 5000 $D/replay-drift.json
```
Не присылайте `football.frozen.sqlite`, `.env`, `data/` целиком. `baseline.json` содержит только отобранные поля (категория, покрытие моделей, DQ, Agreement, Stability, вероятности, ставка-кандидат, счётчики истории); тексты ошибок провайдеров и ключи в него не копируются.

## 4. Контрольные показатели (`baseline.json`)

На каждый матч из `state.results`: категория, `modelsAvailable`/`modelCoverage`, DQ и его 7 компонентов, Agreement, Stability, штраф SCI, MAI, вероятности консенсуса и каждой модели (+ λ Team Strength), кандидат (рынок, исход, кэф, букмекер, вероятность, Edge, EV, Confidence, FDS), число красных флагов, размеры истории (дом/гости, по месту проведения), источник и размер baseline, источник и свежесть рынка. Плюс сводка (число матчей, по категориям, покрытие моделей, средние DQ/Agreement/Stability), цифры SQLite (матчи, по лигам/сезонам, по источникам, строки без team id, `identityKey`-дубли), счётчики логов прогнозов и `digest` (sha256 канонического JSON). `snapshots.json` — временной ряд тех же показателей по сохранённым снимкам (хранятся 48 ч).

## 5. Как используется как «ворота совместимости» на этапе P1

`state.json` меняется при каждом обновлении, поэтому сравнивать «до/после» нужно **не живые состояния, а повтор на замороженных входах**:

| Ворота | Что сравнивается | Критерий |
|---|---|---|
| G1 | `identity-legacy-snapshot.json` на реальном корпусе имён: ключи, классы эквивалентности, пары для коэффициентов, выравнивание контекста | дайджесты секций совпадают **побитно** |
| G2 | `replay-drift` на замороженной SQLite: вероятности 1X2 по каждому логированному прогнозу | расхождение ≤ 1e-9 между коммитом «до P1» и «после P1» |
| G3 | `compare.mjs` двух `baseline.json`, снятых на одном и том же замороженном состоянии | `lockedDifferences = 0` (категории, покрытие, DQ, Agreement, Stability, вероятности) |
| G4 | `npm test` на Node 22 | 100% |
| G5 | `git diff` формул и порогов (`analyse.js`, `markets.js`, `models.js`, константы порогов) | пусто |

```bash
# пример G3: до и после на одном состоянии
node scripts/baseline/capture.mjs --out data/baseline/before
# ... применить изменение ...
node scripts/baseline/capture.mjs --out data/baseline/after
node scripts/baseline/compare.mjs data/baseline/before/baseline.json data/baseline/after/baseline.json   # exit 1 при любом изменении «замкнутых» полей
```
(`capture` читает `data/state.json`, который меняется только при следующем обновлении бота — для G3 не запускайте бота между двумя `capture`.)

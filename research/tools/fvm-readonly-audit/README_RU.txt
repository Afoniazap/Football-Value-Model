FVM read-only audit (Termux)
============================
Назначение: посчитать по реальным сохранённым данным калибровку Production/Challenger,
ROI/калибровку выпущенных сигналов, контрфактуальные срабатывания гейтов и целостность записей.
Ничего не пишет в data/, не вызывает API, не читает .env, не требует npm install.

Запуск (из любой папки, нужен только node >= 18):
  tar xzf FVM_readonly_audit_termux.tar.gz
  node fvm-readonly-audit/audit.mjs --data /путь/к/Football-Value-Model/data --out ~/fvm_audit_report.json

Скрипт отказывается писать внутрь папки data/. Читает только data/history/*.jsonl.
Пришлите ~/fvm_audit_report.json (в нём нет ключей и секретов; только агрегаты).
Перед отправкой можно проверить: grep -ci "key\|token" ~/fvm_audit_report.json  (должно быть 0).
Дополнительно сообщите: git rev-parse HEAD на Termux (для сверки с облачной копией).

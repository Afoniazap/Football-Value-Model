FVM v0.5 — Android / Termux

1. Установи Termux (лучше F-Droid/GitHub-версию, не старую Play Store).
2. Распакуй FVM-Android-Termux-v0.5 в Download.
3. В Termux выполни:
   termux-setup-storage
4. Затем:
   cd ~/storage/shared/Download/FVM-Android-Termux-v0.5
   chmod +x install-termux.sh start-termux.sh
   ./install-termux.sh
5. Открой:
   nano .env
6. Вставь свои:
   TELEGRAM_BOT_TOKEN
   ALLOWED_CHAT_IDS
   FOOTBALL_DATA_TOKEN
   THE_ODDS_API_KEY
7. Сохранение nano: Ctrl+O, Enter, Ctrl+X
8. Запусти:
   ./start-termux.sh

Для фоновой работы отключи оптимизацию батареи Android для Termux.

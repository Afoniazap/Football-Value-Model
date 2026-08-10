#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
echo "=== FVM Android / Termux ==="
pkg update -y
pkg install -y nodejs nano
npm install
if [ ! -f .env ]; then
  cp .env.example .env
fi
echo
echo "Готово. Теперь: nano .env"
echo "После сохранения: ./start-termux.sh"

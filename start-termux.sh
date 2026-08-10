#!/data/data/com.termux/files/usr/bin/bash
set -e
cd "$(dirname "$0")"
mkdir -p data logs
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock || true
node src/app.js

#!/bin/bash
# Обновление на VPS: git pull + пересборка контейнера
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git pull origin main
docker compose up -d --build

echo ""
echo "Деплой завершён. Проверка:"
sleep 3
curl -fsS "http://127.0.0.1:8080/api/ping" || echo "(сервис ещё стартует — подождите 30 сек)"
echo ""

#!/bin/bash
# Одна команда для консоли REG.RU (уже залогинены как root):
#   bash /opt/kaktus-zagruzka/deploy/vps-console.sh
set -euo pipefail

APP_DIR="/opt/kaktus-zagruzka"
cd "$APP_DIR"

echo "=== 1/5 Обновление кода ==="
git pull origin main || {
  echo "git pull не удался — продолжаем с текущей версией"
}

echo "=== 2/5 Docker ==="
docker compose up -d --build

echo "=== 3/5 Ожидание API (до 60 сек) ==="
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:8080/api/ping" >/dev/null 2>&1; then
    echo "API отвечает"
    curl -s "http://127.0.0.1:8080/api/ping"
    echo ""
    break
  fi
  sleep 3
  if [ "$i" -eq 20 ]; then
    echo "API не отвечает — логи:"
    docker compose logs --tail=40
    exit 1
  fi
done

echo "=== 4/5 Nginx ==="
if [ -f "$APP_DIR/deploy/fix-nginx-timeouts.sh" ]; then
  bash "$APP_DIR/deploy/fix-nginx-timeouts.sh" 2>/dev/null || true
fi
nginx -t
systemctl reload nginx

echo "=== 5/5 Проверка YouTube ==="
curl -fsS -m 35 -X POST "http://127.0.0.1:8080/api/analyze" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('title:', (d.get('title') or d.get('detail','?'))[:60]); print('formats:', len(d.get('formats',[])))" \
  || echo "(analyze не ответил за 35с — проверьте docker compose logs)"

echo ""
echo "Готово: https://kaktus-zagruzka.ru"

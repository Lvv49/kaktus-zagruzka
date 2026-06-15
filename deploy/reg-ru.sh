#!/bin/bash
# Полная установка «Кактус загрузка» на VPS REG.RU (Ubuntu 22.04/24.04)
#
# На вашем Mac (подставьте IP и домен):
#   scp -r "/Users/2x2/Desktop/Новая папка 17" root@IP_VPS:/opt/kaktus-zagruzka
#   ssh root@IP_VPS 'cd /opt/kaktus-zagruzka && bash deploy/reg-ru.sh ваш-домен.ru'
#
# Или на чистом VPS REG.RU:
#   git clone https://github.com/Lvv49/kaktus-zagruzka.git /opt/kaktus-zagruzka
#   cd /opt/kaktus-zagruzka && bash deploy/reg-ru.sh ваш-домен.ru
#
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Использование: bash deploy/reg-ru.sh ваш-домен.ru"
  echo ""
  echo "Перед запуском в панели REG.RU:"
  echo "  1. VPS → Ubuntu 22.04, 1 CPU / 1 GB RAM / 15 GB SSD"
  echo "  2. Домен → DNS → A-запись @ и www → IP вашего VPS"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo bash deploy/reg-ru.sh $DOMAIN"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Кактус загрузка → REG.RU ==="
echo "Домен: $DOMAIN"
echo "Папка: $ROOT"
echo ""

# 1. Docker, Nginx, Certbot
if ! command -v docker >/dev/null 2>&1; then
  echo "[1/6] Установка Docker, Nginx, Certbot..."
  bash "$ROOT/deploy/setup-vps.sh" >/dev/null 2>&1 || bash "$ROOT/deploy/setup-vps.sh"
else
  echo "[1/6] Docker уже установлен"
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx 2>/dev/null || true
fi

# 2. Домен в конфигах
echo "[2/6] Настройка домена..."
bash "$ROOT/deploy/set-domain.sh" "$DOMAIN"

# 3. Docker compose
echo "[3/6] Сборка и запуск контейнера..."
docker compose up -d --build

echo "[4/6] Ожидание старта API..."
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8080/api/ping" >/dev/null 2>&1; then
    echo "      API отвечает"
    break
  fi
  sleep 2
  if [ "$i" -eq 30 ]; then
    echo "      API ещё не отвечает — проверьте: docker compose logs -f"
  fi
done

# 4. Nginx
echo "[5/6] Nginx..."
cp "$ROOT/deploy/nginx-site.conf" /etc/nginx/sites-available/kaktus
ln -sf /etc/nginx/sites-available/kaktus /etc/nginx/sites-enabled/kaktus
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# 5. HTTPS
echo "[6/6] HTTPS (Let's Encrypt)..."
if certbot certificates 2>/dev/null | grep -q "$DOMAIN"; then
  certbot renew --quiet || true
else
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email || {
    echo ""
    echo "Certbot не выдал сертификат. Частые причины:"
    echo "  • A-запись домена ещё не указывает на этот VPS (подождите 5–30 мин)"
    echo "  • домен не делегирован на DNS REG.RU"
    echo ""
    echo "Повторите позже:"
    echo "  certbot --nginx -d $DOMAIN"
  }
fi

echo ""
echo "============================================"
echo "  Готово!"
echo "  Сайт:    https://$DOMAIN"
echo "  Проверка: https://$DOMAIN/api/ping"
echo ""
echo "  Обновление:  cd $ROOT && bash deploy/deploy.sh"
echo "  Логи:        docker compose logs -f"
echo "============================================"

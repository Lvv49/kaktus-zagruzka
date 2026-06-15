#!/bin/bash
# Первичная настройка VPS (Ubuntu 22.04/24.04). Запускать от root:
#   curl -fsSL ... | bash   или   sudo bash deploy/setup-vps.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo bash deploy/setup-vps.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

systemctl enable docker nginx
systemctl start docker

APP_DIR="${APP_DIR:-/opt/kaktus-zagruzka}"
echo ""
echo "=== VPS готов (Docker + Nginx + Certbot) ==="
echo ""
echo "REG.RU: закажите Cloud VPS, Ubuntu 22.04, от 1 vCPU / 1 GB RAM."
echo "В DNS REG.RU: A-запись @ → IP сервера (и www → IP, если нужно)."
echo ""
echo "Быстрая установка (одна команда на VPS):"
echo "   git clone https://github.com/Lvv49/kaktus-zagruzka.git $APP_DIR"
echo "   cd $APP_DIR && bash deploy/reg-ru.sh ВАШ-ДОМЕН.ru"
echo ""
echo "Или по шагам:"
echo "1. Клонируйте проект:"
echo "   git clone https://github.com/Lvv49/kaktus-zagruzka.git $APP_DIR"
echo "   cd $APP_DIR"
echo ""
echo "2. Укажите домен (A-запись домена → IP этого сервера):"
echo "   bash deploy/set-domain.sh ВАШ-ДОМЕН.ru"
echo ""
echo "3. Запустите приложение:"
echo "   docker compose up -d --build"
echo ""
echo "4. Nginx + HTTPS:"
echo "   cp deploy/nginx-site.conf /etc/nginx/sites-available/kaktus"
echo "   ln -sf /etc/nginx/sites-available/kaktus /etc/nginx/sites-enabled/kaktus"
echo "   rm -f /etc/nginx/sites-enabled/default"
echo "   nginx -t && systemctl reload nginx"
echo "   certbot --nginx -d ВАШ-ДОМЕН.ru"
echo ""
echo "5. Проверка: curl https://ВАШ-ДОМЕН.ru/api/ping"
echo ""

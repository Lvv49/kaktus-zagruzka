#!/bin/bash
# Деплой на VPS с вашего Mac. Первый раз спросит пароль root из письма REG.RU.
set -euo pipefail

VPS="root@161.104.17.133"
KEY="$HOME/.ssh/kaktus_vps"
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

echo "=== Подключение к $VPS ==="

if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$VPS" 'echo ok' >/dev/null 2>&1; then
  echo ""
  echo "Нужен пароль root из письма REG.RU (Сбросить пароль → на drak1337@list.ru)"
  echo "Введите пароль когда появится запрос Password:"
  echo ""
  ssh-copy-id -i "${KEY}.pub" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "$VPS"
fi

echo ""
echo "=== Деплой на сервере ==="
ssh "${SSH_OPTS[@]}" "$VPS" 'cd /opt/kaktus-zagruzka && git pull origin main && bash deploy/vps-console.sh'

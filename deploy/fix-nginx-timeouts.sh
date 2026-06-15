#!/bin/bash
# После certbot добавляет таймауты в SSL-конфиг nginx
set -euo pipefail
for f in /etc/nginx/sites-enabled/*; do
  if grep -q "proxy_pass" "$f" && ! grep -q "proxy_read_timeout" "$f"; then
    sed -i '/proxy_pass/a\        proxy_read_timeout 300s;\n        proxy_connect_timeout 60s;\n        proxy_send_timeout 300s;' "$f"
  fi
done
nginx -t && systemctl reload nginx

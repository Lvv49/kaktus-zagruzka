#!/bin/bash
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "Использование: ./deploy/set-domain.sh ваш-домен.ru"
  echo "Пример:       ./deploy/set-domain.sh kaktus.example.com"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="https://${DOMAIN}"

echo "Домен: $URL"

if [ -f "$ROOT/.env" ]; then
  if grep -q '^PUBLIC_URL=' "$ROOT/.env"; then
    sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=$URL|" "$ROOT/.env"
  else
    echo "PUBLIC_URL=$URL" >> "$ROOT/.env"
  fi
else
  cp "$ROOT/.env.example" "$ROOT/.env"
  sed -i "s|https://kaktus.example.com|$URL|" "$ROOT/.env"
fi

replace_in_file() {
  local file="$1"
  local pattern="$2"
  local replacement="$3"
  if [ -f "$file" ]; then
    sed -i "s|${pattern}|${replacement}|g" "$file"
  fi
}

replace_in_file "$ROOT/extension/background.js" "https://kaktus-zagruzka.onrender.com" "$URL"
replace_in_file "$ROOT/extension/popup.js" "https://kaktus-zagruzka.onrender.com" "$URL"
replace_in_file "$ROOT/extension/popup.html" "https://kaktus-zagruzka.onrender.com" "$URL"
replace_in_file "$ROOT/app.py" "https://kaktus-zagruzka.onrender.com" "$URL"

# manifest.json — добавить домен в matches
MANIFEST="$ROOT/extension/manifest.json"
if ! grep -q "\"https://${DOMAIN}/*\"" "$MANIFEST"; then
  python3 - "$MANIFEST" "$DOMAIN" <<'PY'
import json, sys
path, domain = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
site = f"https://{domain}/*"
for block in data.get("content_scripts", []):
    matches = block.setdefault("matches", [])
    if site not in matches:
        matches.insert(0, site)
host = f"https://{domain}/*"
perms = data.setdefault("host_permissions", [])
if host not in perms:
    perms.insert(0, host)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
fi

if [ -f "$ROOT/deploy/nginx-site.conf" ]; then
  sed -i "s|server_name .*;|server_name ${DOMAIN};|" "$ROOT/deploy/nginx-site.conf"
fi

echo ""
echo "Готово. PUBLIC_URL=$URL"
echo "Дальше на VPS: git pull && docker compose up -d --build"
echo "Пересоберите ZIP расширения: сайт → «Расширение Chrome» → скачать заново"

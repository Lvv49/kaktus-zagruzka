#!/bin/bash
cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
  echo "Создаю виртуальное окружение..."
  python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

echo ""
echo "🌵 Кактус загрузка запускается..."
echo "   Откройте: http://localhost:8081"
echo ""

uvicorn app:app --host 127.0.0.1 --port 8081 --reload

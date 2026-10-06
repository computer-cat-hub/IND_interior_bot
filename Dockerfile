# Образ для Yandex Serverless Containers: одно FastAPI-приложение отдаёт
# Mini App с корня, API под /api/v1 и принимает webhook Telegram.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY content ./content
COPY webapp ./webapp
COPY docs/welcome.jpg ./docs/welcome.jpg

# Порт задаёт платформа через $PORT.
CMD ["sh", "-c", "uvicorn app.api.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]

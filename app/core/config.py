from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def _int_set(raw: str) -> frozenset[int]:
    return frozenset(int(item.strip()) for item in raw.split(",") if item.strip().isdigit())


def _origin_tuple(raw: str) -> tuple[str, ...]:
    return tuple(item.strip().rstrip("/") for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Settings:
    telegram_token: str
    webapp_url: str
    database_url: str
    db_schema: str
    webhook_secret: str
    db_path: Path
    admin_telegram_ids: frozenset[int]
    init_data_max_age_seconds: int
    allowed_origins: tuple[str, ...]
    telegram_api_base: str = ""

    def require_bot_token(self) -> str:
        if not self.telegram_token:
            raise RuntimeError("TELEGRAM_TOKEN не задан в .env")
        return self.telegram_token

    def require_database_url(self) -> str:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL не задан — нужна строка подключения к Postgres")
        return self.database_url

    def require_webapp_url(self) -> str:
        if not self.webapp_url.startswith("https://"):
            raise RuntimeError("WEBAPP_URL должен быть публичным https:// адресом")
        return self.webapp_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    _load_env(BASE_DIR / ".env")
    db_value = os.environ.get("DB_FILE", "data/interior-narrative.sqlite3")
    db_path = Path(db_value)
    if not db_path.is_absolute():
        db_path = BASE_DIR / db_path
    return Settings(
        telegram_token=os.environ.get("TELEGRAM_TOKEN", "").strip(),
        webapp_url=os.environ.get("WEBAPP_URL", "").strip().rstrip("/"),
        database_url=os.environ.get("DATABASE_URL", "").strip(),
        # Пароль вебхука: Telegram присылает его заголовком, и без совпадения
        # апдейт не принимается — адрес функции публичный, подделать запрос
        # иначе не стоило бы ничего.
        webhook_secret=os.environ.get("WEBHOOK_SECRET", "").strip(),
        # Схема, а не отдельная база: в одном проекте Supabase живут два продукта,
        # и тесты гоняются в своей схеме, не задевая рабочие данные.
        db_schema=os.environ.get("DB_SCHEMA", "interior").strip(),
        db_path=db_path,
        admin_telegram_ids=_int_set(os.environ.get("ADMIN_TELEGRAM_IDS", "")),
        init_data_max_age_seconds=int(os.environ.get("INIT_DATA_MAX_AGE_SECONDS", "86400")),
        allowed_origins=_origin_tuple(os.environ.get("ALLOWED_ORIGINS", "")),
        # Адрес Bot API. Пусто — api.telegram.org напрямую. Из российского облака
        # Telegram недоступен, поэтому там бот ходит через ретранслятор за рубежом.
        telegram_api_base=os.environ.get("TELEGRAM_API_BASE", "").strip().rstrip("/"),
    )

"""Настройка бота в Telegram: команды, боковая кнопка, вебхук.

Бот в облаке просыпается на апдейт и ничего не «настраивает» сам, поэтому шаг
вынесен сюда и делается осознанно. Вебхук ставится на адрес ретранслятора
(proxy/main.ts на Deno Deploy): напрямую Telegram до Yandex Cloud не достаёт.

    python scripts/setup_bot.py --webhook https://<ретранслятор>.deno.net
    python scripts/setup_bot.py --polling     # вернуть локальный запуск: вебхук снимается
    python scripts/setup_bot.py --show        # что стоит сейчас
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from aiogram import Bot  # noqa: E402
from aiogram.types import MenuButtonCommands  # noqa: E402

from app.bot.main import COMMANDS  # noqa: E402
from app.core.config import get_settings  # noqa: E402

WEBHOOK_PATH = "/api/v1/telegram/webhook"


async def main() -> int:
    settings = get_settings()
    bot = Bot(token=settings.require_bot_token())
    try:
        if "--show" in sys.argv:
            info = await bot.get_webhook_info()
            print("вебхук:", info.url or "не задан")
            print("в очереди:", info.pending_update_count)
            print("последняя ошибка:", info.last_error_message or "нет")
            print("команды:", json.dumps(
                [c.command for c in await bot.get_my_commands()], ensure_ascii=False))
            return 0

        await bot.set_my_commands(COMMANDS)
        # Боковая кнопка — список команд, а не Web App: иначе команды доступны
        # только набором «/» вручную.
        await bot.set_chat_menu_button(menu_button=MenuButtonCommands())
        print("команды и кнопка меню обновлены")

        if "--polling" in sys.argv:
            await bot.delete_webhook(drop_pending_updates=False)
            print("вебхук снят — можно запускать локальный polling")
            return 0

        if "--webhook" in sys.argv:
            base = sys.argv[sys.argv.index("--webhook") + 1].rstrip("/")
            secret = os.environ.get("WEBHOOK_SECRET", "").strip()
            if not secret:
                print("WEBHOOK_SECRET не задан — без него апдейты принимать нельзя")
                return 2
            # allowed_updates только message: остальное боту не нужно, а лишние
            # апдейты — лишние вызовы функции.
            await bot.set_webhook(
                base + WEBHOOK_PATH, secret_token=secret, allowed_updates=["message"]
            )
            print("вебхук установлен:", base + WEBHOOK_PATH)
            return 0

        print(__doc__)
        return 1
    finally:
        await bot.session.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

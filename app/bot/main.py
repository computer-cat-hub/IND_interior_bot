from __future__ import annotations

import asyncio
import html
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ParseMode
from aiogram.filters import Command, CommandStart
from aiogram.exceptions import TelegramBadRequest
from aiogram.types import BotCommand, FSInputFile, MenuButtonCommands, Message

from app.api.telegram_auth import issue_session_token
from app.bot.keyboards import app_inline_button, app_keyboard
from app.core.config import BASE_DIR, get_settings
from app.storage import repository

WELCOME_IMAGE = BASE_DIR / "docs" / "welcome.jpg"

# Столько живёт токен, вшитый в кнопку. Дольше, чем у токена из initData:
# кнопка reply-клавиатуры остаётся у человека висеть месяцами, и если она
# протухнет раньше, чем он вернётся, вход снова окажется заперт.
BUTTON_TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60

COMMANDS = [
    BotCommand(command="start", description="О боте + перезагрузка"),
    BotCommand(command="app", description="Открыть приложение"),
    BotCommand(command="help", description="Если что-то не работает"),
    BotCommand(command="privacy", description="Какие данные сохраняются"),
]

SUPPORT_CONTACT = "@ded_indigo"

# Приветствие несёт то, что раньше пряталось в /info: без него первое сообщение
# не объясняло, зачем бот нужен.
WELCOME = (
    "Привет, {name}.\n\n"
    "Это внутренний инструмент дизайнеров интерьеров IND. Два независимых теста:\n\n"
    "01 · <b>Какой вы тип дизайнера</b> — определяет ваш авторский профиль: "
    "как вы находите идею, строите пространство и принимаете проектные решения. "
    "30 вопросов, около 10 минут.\n\n"
    "02 · <b>Нарратив проекта</b> — по полному брифу подбирает основной и два "
    "альтернативных нарратива, аргументацию для заказчика, визуальный язык "
    "и проекты-референсы. 35 вопросов, 10–15 минут.\n\n"
    "Результаты сохраняются в вашей истории — тесты можно проходить заново, "
    "а прерванный тест продолжится с того же вопроса.\n\n"
    "<b>Команды</b>\n"
    "/start — это сообщение и свежая кнопка входа\n"
    "/app — открыть приложение\n"
    "/help — если что-то не работает\n"
    "/privacy — какие данные сохраняются"
)

HELP = (
    "<b>Если что-то пошло не так</b>\n\n"
    "<b>Тест прервался.</b> Ничего не потеряно — ответы сохраняются по ходу. "
    "Откройте тест снова, он продолжится с того же вопроса.\n\n"
    "<b>СЕТЬ-1 — телефон не в сети.</b> Включите интернет или Wi-Fi.\n\n"
    "<b>СЕТЬ-2 — сервер не отвечает.</b> Обычно он возвращается сам за пару минут. "
    "Подождите и нажмите «Попробовать ещё раз».\n\n"
    "<b>СЕТЬ-3 — связь медленная.</b> Сервер не ответил за 15 секунд. "
    "Просто повторите.\n\n"
    "<b>«Открыто вне Telegram» — приложение не получило ваш профиль.</b> "
    "Так бывает, когда его открыли ссылкой или вернулись в старую вкладку. "
    "Закройте приложение и откройте кнопкой «Открыть приложение». "
    "Нет кнопки — отправьте /start. Интернет и VPN тут ни при чём.\n\n"
    f"Не помогло — напишите {SUPPORT_CONTACT}, пришлите код ошибки и скриншот."
)


def create_bot() -> Bot:
    settings = get_settings()
    session = None
    if settings.telegram_api_base:
        session = AiohttpSession(api=TelegramAPIServer.from_base(settings.telegram_api_base))
    return Bot(
        token=settings.require_bot_token(),
        session=session,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )


def create_dispatcher() -> Dispatcher:
    """Все хендлеры бота одним куском — без предположения, как приходят апдейты.

    Дома бот живёт на long polling, на Vercel его будит вебхук. Логика при этом
    обязана быть одна: разъехавшиеся копии хендлеров означают, что «у меня
    работает» перестаёт что-либо значить.
    """
    settings = get_settings()
    token = settings.require_bot_token()
    webapp_url = settings.require_webapp_url()
    dp = Dispatcher()

    # file_id первой отправки: Telegram хранит картинку у себя, дальше шлём
    # ссылкой на неё, а не перезаливаем файл на каждый /start.
    welcome_photo_id: str | None = None

    async def session_token_for(message: Message) -> str | None:
        """Вход, который бот подписывает сам.

        Бот знает, кто нажал команду, поэтому не зависит от initData — его
        Telegram-клиент отдаёт мини-аппу не всегда. Пользователя при этом
        обязательно кладём в БД: токен проверяется против таблицы users, и для
        незнакомого человека он был бы бесполезен."""
        user = message.from_user
        try:
            await repository.upsert_telegram_user(
                {
                    "id": user.id,
                    "username": user.username,
                    "first_name": user.first_name,
                    "last_name": user.last_name,
                    "language_code": user.language_code,
                }
            )
            return issue_session_token(user.id, token, BUTTON_TOKEN_TTL_SECONDS)
        except Exception:
            # Кнопка нужнее токена: без БД вход просто вернётся к initData.
            logging.exception("Не удалось выдать токен для кнопки, отдаём её без него")
            return None

    async def keyboard_for(message: Message, screen: str | None = None):
        return app_keyboard(webapp_url, screen, await session_token_for(message))

    @dp.message(CommandStart())
    async def start(message: Message) -> None:
        nonlocal welcome_photo_id
        name = html.escape(message.from_user.first_name or "коллега")
        caption = WELCOME.format(name=name)
        keyboard = await keyboard_for(message)

        if not WELCOME_IMAGE.exists():
            logging.warning("Нет приветственной картинки: %s", WELCOME_IMAGE)
            await message.answer(caption, reply_markup=keyboard)
            return

        photo = welcome_photo_id or FSInputFile(WELCOME_IMAGE)
        try:
            sent = await message.answer_photo(photo, caption=caption, reply_markup=keyboard)
        except TelegramBadRequest:
            # Протухший file_id (например, после смены бота) — перезальём файл.
            welcome_photo_id = None
            sent = await message.answer_photo(FSInputFile(WELCOME_IMAGE), caption=caption, reply_markup=keyboard)
        if welcome_photo_id is None and sent.photo:
            welcome_photo_id = sent.photo[-1].file_id

    @dp.message(Command("app"))
    async def open_app(message: Message) -> None:
        # Кнопка в сообщении, а не на клавиатуре: в Telegram Desktop
        # reply-клавиатура прячется за мелкой иконкой у поля ввода, и её просто
        # не находят. Токен входа тот же самый.
        await message.answer(
            "Приложение открывается по кнопке:",
            reply_markup=app_inline_button(webapp_url, None, await session_token_for(message)),
        )

    @dp.message(Command("help"))
    async def help_message(message: Message) -> None:
        await message.answer(HELP, reply_markup=await keyboard_for(message))

    @dp.message(Command("privacy"))
    async def privacy(message: Message) -> None:
        await message.answer(
            "Сохраняются Telegram ID, актуальный username, ответы и результаты тестов. "
            "Для проектов используются только внутренние коды или условные названия — без реальных названий заказчиков."
        )

    return dp


async def announce_commands(bot: Bot) -> None:
    """Команды и вид боковой кнопки. Настройки бота, а не запуска."""
    await bot.set_my_commands(COMMANDS)
    # Боковая кнопка — список команд, а не Web App: иначе команды доступны только
    # набором «/» вручную. Приложение открывается крупной кнопкой reply-клавиатуры
    # (app_keyboard), так что вход в него никуда не девается.
    await bot.set_chat_menu_button(menu_button=MenuButtonCommands())


async def main() -> None:
    """Локальный запуск на long polling."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    bot = create_bot()
    dp = create_dispatcher()
    await repository.init_db()
    await announce_commands(bot)
    logging.info("Interior Narrative Bot started")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())

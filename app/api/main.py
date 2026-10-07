from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

import asyncpg
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.api.telegram_auth import (
    TelegramAuthError,
    TelegramIdentity,
    issue_session_token,
    read_session_token,
    validate_init_data,
)
from app.core.config import BASE_DIR, get_settings
from app.domain import quiz_engine
from app.storage import repository

WEBAPP_DIR = BASE_DIR / "webapp"
SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60  # 30 дней — токен переживает баги Telegram-клиента с initData
# Токен продлевается молча, пока человек пользуется приложением: жёсткий конец
# тридцати дней однажды запирал вход насмерть — новый токен взять негде, когда
# Telegram-клиент отдаёт пустой initData.
SESSION_TOKEN_REFRESH_BEFORE_SECONDS = 7 * 24 * 60 * 60
SESSION_TOKEN_HEADER = "X-Session-Token"


# Бот и диспетчер переживают запросы в пределах инстанса: собирать их заново на
# каждый апдейт — лишняя работа на каждом сообщении.
_bot = None
_dispatcher = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    await repository.init_db()
    yield


app = FastAPI(
    title="IND Interior Narrative API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.allowed_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Session-Token", "X-Telegram-Init-Data"],
    # Без expose_headers браузер спрячет продлённый токен от скрипта.
    expose_headers=[SESSION_TOKEN_HEADER],
)
app.mount("/assets", StaticFiles(directory=WEBAPP_DIR / "assets"), name="assets")


class SessionCreate(BaseModel):
    test_key: Literal["designer-profile", "project-narrative"]
    project_id: str | None = Field(default=None, max_length=64)


class ProjectCreate(BaseModel):
    code_name: str = Field(min_length=1, max_length=120)
    object_type: str | None = Field(default=None, max_length=64)
    area_m2: float | None = Field(default=None, ge=0, le=1_000_000)
    project_started_on: str | None = Field(default=None, max_length=32)
    concept_due_on: str | None = Field(default=None, max_length=32)
    presentation_on: str | None = Field(default=None, max_length=32)
    implementation_on: str | None = Field(default=None, max_length=32)


class AnswerSubmit(BaseModel):
    option_ids: list[str] = Field(min_length=1, max_length=8)


async def telegram_identity(
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> TelegramIdentity:
    settings = get_settings()
    try:
        return validate_init_data(
            x_telegram_init_data or "",
            settings.require_bot_token(),
            settings.init_data_max_age_seconds,
        )
    except (TelegramAuthError, RuntimeError) as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


async def current_user(
    response: Response,
    authorization: Annotated[str | None, Header()] = None,
    x_session_token: Annotated[str | None, Header()] = None,
    x_telegram_init_data: Annotated[str | None, Header()] = None,
) -> dict:
    """Сессионный токен из /auth/exchange — приоритетный путь: не зависит от того,
    насколько свежий/целый initData отдал в этот раз Telegram-клиент. Сырой
    initData остаётся резервным путём для клиентов, ещё не получивших токен.

    Фронт шлёт токен в X-Session-Token: заголовок Authorization Yandex Serverless
    Containers забирает себе и проверяет как IAM-токен (чужой — 403 до приложения).
    Bearer в Authorization по-прежнему принимается — для тестов и старых клиентов."""
    settings = get_settings()
    token = None
    if x_session_token:
        token = x_session_token.strip()
    elif authorization and authorization.lower().startswith("bearer "):
        token = authorization[len("bearer "):].strip()
    if token:
        bot_token = settings.require_bot_token()
        parsed = read_session_token(token, bot_token)
        if parsed is None:
            raise HTTPException(status_code=401, detail="Сессионный токен недействителен или истёк")
        telegram_user_id, seconds_left = parsed
        if seconds_left < SESSION_TOKEN_REFRESH_BEFORE_SECONDS:
            response.headers[SESSION_TOKEN_HEADER] = issue_session_token(
                telegram_user_id, bot_token, SESSION_TOKEN_TTL_SECONDS
            )
        user = await repository.get_user_by_telegram_id(telegram_user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="Пользователь не найден")
        return user
    identity = await telegram_identity(x_telegram_init_data)
    return await repository.upsert_telegram_user(identity.user)


@app.post("/api/v1/auth/exchange")
async def auth_exchange(identity: Annotated[TelegramIdentity, Depends(telegram_identity)]) -> dict:
    """Разовый обмен подписанного Telegram initData на долгоживущий сессионный
    токен. Фронтенд вызывает это один раз при первом валидном запуске и дальше
    везде шлёт токен — initData больше не нужен для прохождения теста."""
    settings = get_settings()
    user = await repository.upsert_telegram_user(identity.user)
    token = issue_session_token(user["telegram_user_id"], settings.require_bot_token(), SESSION_TOKEN_TTL_SECONDS)
    return {
        "session_token": token,
        "telegram_user_id": user["telegram_user_id"],
        "username": user["username"],
        "first_name": user["first_name"],
    }


@app.post("/api/v1/telegram/webhook", include_in_schema=False)
async def telegram_webhook(
    update: dict,
    x_telegram_bot_api_secret_token: Annotated[str | None, Header()] = None,
) -> dict:
    """Апдейты Telegram, когда бот живёт функцией, а не процессом.

    Long polling требует вечно живого процесса на чьей-то машине — ровно то, от
    чего мы уезжаем. Вебхук будит функцию только когда кто-то написал боту.

    Заголовок с секретом обязателен: адрес функции публичный, и без проверки
    любой прислал бы боту поддельный апдейт от чужого имени.
    """
    settings = get_settings()
    secret = settings.webhook_secret
    if not secret or x_telegram_bot_api_secret_token != secret:
        raise HTTPException(status_code=403, detail="Чужой вебхук")

    # Импорт внутри: aiogram нужен одному этому роуту, а тянуть его на каждом
    # холодном старте ради запросов теста незачем.
    from aiogram.types import Update

    from app.bot.main import create_bot, create_dispatcher

    global _bot, _dispatcher
    if _bot is None or _dispatcher is None:
        _bot, _dispatcher = create_bot(), create_dispatcher()
    await _dispatcher.feed_webhook_update(_bot, Update.model_validate(update, context={"bot": _bot}))
    return {"ok": True}


@app.get("/api/v1/health")
async def health() -> dict:
    # Коммит в ответе: снаружи иначе не понять, доехал деплой или отвечает
    # прошлая версия функции — а на этом легко потерять полчаса.
    # Запрос в базу нужен и для keep-alive: бесплатный Supabase засыпает
    # после недели без активности, и тогда функция падает целиком.
    pool = await repository.get_pool()
    await pool.fetchval("SELECT 1")
    return {
        "status": "ok",
        "version": app.version,
        "commit": os.environ.get("GIT_COMMIT", "local")[:7],
    }


@app.get("/api/v1/me")
async def me(user: Annotated[dict, Depends(current_user)]) -> dict:
    return {
        "telegram_user_id": user["telegram_user_id"],
        "username": user["username"],
        "first_name": user["first_name"],
    }


@app.get("/api/v1/tests/{test_key}")
async def get_test_content(
    test_key: str,
    _user: Annotated[dict, Depends(current_user)],
    object_type: Annotated[str | None, Query(max_length=64)] = None,
) -> dict:
    """object_type — типология проекта: формулировки вопросов подстраиваются под неё
    (см. quiz_engine.public_questions). Без параметра — базовые формулировки."""
    try:
        content = quiz_engine.load_content(test_key)
    except quiz_engine.ContentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {
        "test_key": content["test_key"],
        "version": content["version"],
        "title": content["title"],
        "duration_hint": content["duration_hint"],
        "object_type": object_type,
        "questions": quiz_engine.public_questions(content, object_type),
    }


@app.post("/api/v1/projects", status_code=201)
async def create_project(payload: ProjectCreate, user: Annotated[dict, Depends(current_user)]) -> dict:
    return await repository.create_project(
        user["id"],
        payload.code_name,
        payload.object_type,
        payload.area_m2,
        payload.project_started_on,
        payload.concept_due_on,
        payload.presentation_on,
        payload.implementation_on,
    )


@app.post("/api/v1/sessions", status_code=201)
async def start_session(payload: SessionCreate, user: Annotated[dict, Depends(current_user)]) -> dict:
    if payload.test_key == "project-narrative" and not payload.project_id:
        raise HTTPException(status_code=422, detail="Для теста project-narrative нужен project_id")
    try:
        session = await repository.create_session(user["id"], payload.test_key, payload.project_id)
    except asyncpg.exceptions.IntegrityConstraintViolationError as exc:
        raise HTTPException(status_code=422, detail="Неизвестный project_id") from exc
    await repository.log_event("session_started", user["id"], session["id"], {"test_key": payload.test_key})
    return session


@app.get("/api/v1/sessions/active")
async def active_sessions(user: Annotated[dict, Depends(current_user)]) -> list[dict]:
    """Что человек начал и не закончил — чтобы предложить продолжить с того же места."""
    rows = await repository.list_active_sessions(user["id"])
    for row in rows:
        content = quiz_engine.load_content(row["test_key"])
        row["total"] = len(content["questions"])
        row["title"] = content.get("title", row["test_key"])
    return rows


@app.post("/api/v1/sessions/{session_id}/abandon")
async def abandon_session(session_id: str, user: Annotated[dict, Depends(current_user)]) -> dict:
    """Отказ от черновика: человек выбрал «начать заново».

    Прохождение не удаляется, а помечается брошенным — ответы остаются для
    аналитики, но предлагать его снова уже незачем.
    """
    if not await repository.abandon_session(session_id, user["id"]):
        raise HTTPException(status_code=404, detail="Сессия не найдена или уже закрыта")
    await repository.log_event("session_abandoned", user["id"], session_id, {})
    return {"status": "abandoned"}


async def _owned_session(session_id: str, user: dict) -> dict:
    session = await repository.get_session(session_id, user["id"])
    if session is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    return session


@app.get("/api/v1/sessions/{session_id}")
async def get_session(session_id: str, user: Annotated[dict, Depends(current_user)]) -> dict:
    session = await _owned_session(session_id, user)
    answers = await repository.list_session_answers(session_id)
    return {**session, "answers": answers}


@app.put("/api/v1/sessions/{session_id}/answers/{question_id}")
async def submit_answer(
    session_id: str, question_id: str, payload: AnswerSubmit, user: Annotated[dict, Depends(current_user)]
) -> dict:
    session = await _owned_session(session_id, user)
    if session["status"] != "in_progress":
        raise HTTPException(status_code=409, detail="Сессия уже завершена")
    try:
        content = quiz_engine.load_content(session["test_key"])
    except quiz_engine.ContentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    question = next((q for q in content["questions"] if q["id"] == question_id), None)
    if question is None:
        raise HTTPException(status_code=422, detail="Неизвестный вопрос")
    valid_ids = {o["id"] for o in question["options"]}
    if not set(payload.option_ids) <= valid_ids:
        raise HTTPException(status_code=422, detail="Неизвестный вариант ответа")
    if not question.get("multi", False) and len(payload.option_ids) > 1:
        raise HTTPException(status_code=422, detail="Этот вопрос допускает только один вариант ответа")
    await repository.upsert_answer(session_id, question_id, payload.option_ids)
    return {"status": "saved"}


@app.post("/api/v1/sessions/{session_id}/complete")
async def complete_session(session_id: str, user: Annotated[dict, Depends(current_user)]) -> dict:
    session = await _owned_session(session_id, user)
    if session["status"] != "in_progress":
        existing = await repository.get_result(session_id, user["id"])
        if existing is not None:
            return existing
        raise HTTPException(status_code=409, detail="Сессия уже завершена без результата")
    try:
        content = quiz_engine.load_content(session["test_key"])
    except quiz_engine.ContentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    answers = await repository.list_session_answers(session_id)
    result = quiz_engine.compose_result(session["test_key"], content, answers, session_id)
    written = await repository.complete_session(session_id, result)
    if written is None:
        # Параллельный запрос успел раньше — отдаём то, что он записал.
        existing = await repository.get_result(session_id, user["id"])
        if existing is None:
            raise HTTPException(status_code=409, detail="Сессия уже завершена без результата")
        return existing
    await repository.log_event(
        "session_completed", user["id"], session_id,
        {"test_key": session["test_key"], "primary_narrative_key": result["primary_narrative_key"]},
    )
    full = await repository.get_result(session_id, user["id"])
    return full


@app.get("/api/v1/sessions/{session_id}/result")
async def get_session_result(session_id: str, user: Annotated[dict, Depends(current_user)]) -> dict:
    result = await repository.get_result(session_id, user["id"])
    if result is None:
        raise HTTPException(status_code=404, detail="Результат не найден")
    content = quiz_engine.load_content(result["test_key"])
    if result["test_key"] == "project-narrative":
        phrase_bank = quiz_engine.load_phrase_bank()
        result["primary_detail"] = quiz_engine.narrative_detail_for_session(
            content, phrase_bank, result["primary_narrative_key"], session_id
        )
    else:
        result["primary_detail"] = quiz_engine.narrative_detail(content, result["primary_narrative_key"])
    for alt in result["alternatives"]:
        alt["detail"] = quiz_engine.narrative_detail(content, alt["key"])
    result["full_ranking"] = quiz_engine.full_ranking(content, result["scoring_trace"]["ranked"])
    return result


@app.get("/api/v1/results")
async def results(user: Annotated[dict, Depends(current_user)]) -> list[dict]:
    rows = await repository.list_user_results(user["id"])
    for row in rows:
        content = quiz_engine.load_content(row["test_key"])
        narrative = content["narratives"].get(row["primary_narrative_key"], {})
        row["primary_narrative_name"] = narrative.get("name", row["primary_narrative_key"])
        row["primary_narrative_color"] = narrative.get("color")
    return rows


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEBAPP_DIR / "index.html")


@app.get("/{path:path}", include_in_schema=False)
async def spa_fallback(path: str) -> FileResponse:
    if path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Не найдено")
    candidate = (WEBAPP_DIR / path).resolve()
    if candidate.is_file() and WEBAPP_DIR.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(WEBAPP_DIR / "index.html")

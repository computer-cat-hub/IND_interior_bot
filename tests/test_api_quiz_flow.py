import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlencode

import pytest


def _signed_init_data(token: str, user_id: int = 42, username: str = "designer") -> str:
    values = {
        "auth_date": str(int(time.time())),
        "query_id": "test-query",
        "user": json.dumps({"id": user_id, "first_name": "D", "username": username}, separators=(",", ":")),
    }
    check = "\n".join(f"{key}={values[key]}" for key in sorted(values))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    values["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(values)


@pytest.fixture()
def client(clean_tables, monkeypatch):
    from tests.conftest import TEST_SCHEMA

    monkeypatch.setenv("DB_SCHEMA", TEST_SCHEMA)
    monkeypatch.setenv("TELEGRAM_TOKEN", "test-token-for-pytest")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://example.containers.yandexcloud.net")

    from app.core.config import get_settings
    get_settings.cache_clear()

    from fastapi.testclient import TestClient
    from app.api import main as api_main
    from app.storage import repository

    # Пул asyncpg привязан к циклу событий, а TestClient заводит свой на каждый
    # тест — старый пул во втором тесте отвечал бы «another loop is running».
    repository._pool = None

    with TestClient(api_main.app) as test_client:
        yield test_client

    repository._pool = None
    get_settings.cache_clear()


@pytest.fixture()
def auth_headers():
    return {"X-Telegram-Init-Data": _signed_init_data("test-token-for-pytest")}


def test_health(client):
    assert client.get("/api/v1/health").json()["status"] == "ok"


def test_me_requires_init_data(client):
    assert client.get("/api/v1/me").status_code == 401


def test_designer_profile_full_flow(client, auth_headers):
    content = client.get("/api/v1/tests/designer-profile", headers=auth_headers).json()
    assert len(content["questions"]) == 30
    for question in content["questions"]:
        for option in question["options"]:
            assert "weights" not in option

    session = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    )
    assert session.status_code == 201
    session_id = session.json()["id"]

    for question in content["questions"]:
        resp = client.put(
            f"/api/v1/sessions/{session_id}/answers/{question['id']}",
            headers=auth_headers,
            json={"option_ids": [question["options"][0]["id"]]},
        )
        assert resp.status_code == 200

    resume = client.get(f"/api/v1/sessions/{session_id}", headers=auth_headers).json()
    assert len(resume["answers"]) == 30

    result = client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers).json()
    assert result["primary_narrative_key"]
    assert 0 <= result["primary_score"] <= 100
    assert result["confidence"] == 100
    assert len(result["alternatives"]) == 2

    # повторное завершение идемпотентно, не пересоздаёт результат
    again = client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers).json()
    assert again["primary_narrative_key"] == result["primary_narrative_key"]

    detail = client.get(f"/api/v1/sessions/{session_id}/result", headers=auth_headers).json()
    assert detail["primary_detail"]["advice"]

    blocked = client.put(
        f"/api/v1/sessions/{session_id}/answers/{content['questions'][0]['id']}",
        headers=auth_headers,
        json={"option_ids": [content["questions"][0]["options"][0]["id"]]},
    )
    assert blocked.status_code == 409


def test_project_narrative_result_uses_phrase_bank(client, auth_headers):
    project = client.post(
        "/api/v1/projects", headers=auth_headers, json={"code_name": "Банк фраз"}
    ).json()
    content = client.get("/api/v1/tests/project-narrative", headers=auth_headers).json()
    session_id = client.post(
        "/api/v1/sessions",
        headers=auth_headers,
        json={"test_key": "project-narrative", "project_id": project["id"]},
    ).json()["id"]

    for question in content["questions"]:
        client.put(
            f"/api/v1/sessions/{session_id}/answers/{question['id']}",
            headers=auth_headers,
            json={"option_ids": [question["options"][0]["id"]]},
        )
    client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers)

    detail = client.get(f"/api/v1/sessions/{session_id}/result", headers=auth_headers).json()
    primary = detail["primary_detail"]
    assert primary["fragment_ids"]
    for slot_field in ("thesis", "client_argument", "visual_direction", "risks", "next_step"):
        assert primary[slot_field]

    # повторный запрос детерминированно даёт тот же текст
    again = client.get(f"/api/v1/sessions/{session_id}/result", headers=auth_headers).json()
    assert again["primary_detail"] == primary


def test_project_narrative_requires_project_id(client, auth_headers):
    resp = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "project-narrative"}
    )
    assert resp.status_code == 422


def test_project_narrative_full_flow(client, auth_headers):
    project = client.post(
        "/api/v1/projects",
        headers=auth_headers,
        json={"code_name": "Проект тест", "object_type": "office", "area_m2": 500},
    )
    assert project.status_code == 201
    project_id = project.json()["id"]

    content = client.get("/api/v1/tests/project-narrative", headers=auth_headers).json()
    session = client.post(
        "/api/v1/sessions",
        headers=auth_headers,
        json={"test_key": "project-narrative", "project_id": project_id},
    )
    assert session.status_code == 201
    session_id = session.json()["id"]

    for question in content["questions"]:
        client.put(
            f"/api/v1/sessions/{session_id}/answers/{question['id']}",
            headers=auth_headers,
            json={"option_ids": [question["options"][0]["id"]]},
        )

    result = client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers).json()
    assert result["primary_narrative_key"]

    history = client.get("/api/v1/results", headers=auth_headers).json()
    assert len(history) == 1


def test_resume_picks_up_first_unanswered_question(client, auth_headers):
    content = client.get("/api/v1/tests/designer-profile", headers=auth_headers).json()
    session_id = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    ).json()["id"]

    for question in content["questions"][:5]:
        client.put(
            f"/api/v1/sessions/{session_id}/answers/{question['id']}",
            headers=auth_headers,
            json={"option_ids": [question["options"][0]["id"]]},
        )

    resume = client.get(f"/api/v1/sessions/{session_id}", headers=auth_headers).json()
    assert len(resume["answers"]) == 5
    assert resume["status"] == "in_progress"


def test_unknown_question_or_option_rejected(client, auth_headers):
    session_id = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    ).json()["id"]

    assert client.put(
        f"/api/v1/sessions/{session_id}/answers/does-not-exist",
        headers=auth_headers,
        json={"option_ids": ["a"]},
    ).status_code == 422

    assert client.put(
        f"/api/v1/sessions/{session_id}/answers/q1",
        headers=auth_headers,
        json={"option_ids": ["does-not-exist"]},
    ).status_code == 422


def test_unknown_session_id_is_404(client, auth_headers):
    assert client.get("/api/v1/sessions/nope", headers=auth_headers).status_code == 404


def test_cannot_read_another_users_session(client, auth_headers):
    session_id = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    ).json()["id"]

    other_headers = {"X-Telegram-Init-Data": _signed_init_data("test-token-for-pytest", user_id=999, username="other")}
    resp = client.get(f"/api/v1/sessions/{session_id}", headers=other_headers)
    assert resp.status_code == 404


def test_auth_exchange_issues_working_bearer_token(client, auth_headers):
    exchange = client.post("/api/v1/auth/exchange", headers=auth_headers)
    assert exchange.status_code == 200
    body = exchange.json()
    assert body["session_token"]
    assert body["username"] == "designer"

    # дальше initData вообще не нужен — только токен
    bearer_headers = {"Authorization": f"Bearer {body['session_token']}"}
    me = client.get("/api/v1/me", headers=bearer_headers)
    assert me.status_code == 200
    assert me.json()["username"] == "designer"


def test_bearer_token_survives_broken_init_data(client, auth_headers):
    exchange = client.post("/api/v1/auth/exchange", headers=auth_headers)
    token = exchange.json()["session_token"]

    # initData "сломан" (как при известном баге Telegram Desktop) — не важно,
    # раз есть валидный Bearer-токен запрос всё равно проходит.
    resp = client.get(
        "/api/v1/me",
        headers={"Authorization": f"Bearer {token}", "X-Telegram-Init-Data": "query_id=only"},
    )
    assert resp.status_code == 200


def test_garbage_bearer_token_rejected(client):
    resp = client.get("/api/v1/me", headers={"Authorization": "Bearer not-a-real-token"})
    assert resp.status_code == 401


def test_unknown_test_key_is_404(client, auth_headers):
    assert client.get("/api/v1/tests/does-not-exist", headers=auth_headers).status_code == 404


def test_multi_select_question_accepts_several_option_ids(client, auth_headers):
    content = client.get("/api/v1/tests/project-narrative", headers=auth_headers).json()
    multi_question = next(q for q in content["questions"] if q["multi"] and len(q["options"]) >= 2)
    project = client.post(
        "/api/v1/projects", headers=auth_headers, json={"code_name": "Мульти-тест"}
    ).json()
    session_id = client.post(
        "/api/v1/sessions",
        headers=auth_headers,
        json={"test_key": "project-narrative", "project_id": project["id"]},
    ).json()["id"]

    ids = [o["id"] for o in multi_question["options"][:2]]
    resp = client.put(
        f"/api/v1/sessions/{session_id}/answers/{multi_question['id']}",
        headers=auth_headers,
        json={"option_ids": ids},
    )
    assert resp.status_code == 200
    resume = client.get(f"/api/v1/sessions/{session_id}", headers=auth_headers).json()
    assert sorted(resume["answers"][multi_question["id"]]) == sorted(ids)


def test_single_select_question_rejects_multiple_option_ids(client, auth_headers):
    content = client.get("/api/v1/tests/designer-profile", headers=auth_headers).json()
    single_question = next(q for q in content["questions"] if not q["multi"])
    session_id = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    ).json()["id"]

    ids = [o["id"] for o in single_question["options"][:2]]
    resp = client.put(
        f"/api/v1/sessions/{session_id}/answers/{single_question['id']}",
        headers=auth_headers,
        json={"option_ids": ids},
    )
    assert resp.status_code == 422


def test_completing_twice_returns_the_same_result(client, auth_headers):
    """Двойной тап по последнему ответу или повтор запроса после таймаута.

    Раньше второй запрос доходил до INSERT и падал пятисоткой на UNIQUE по
    session_id; теперь статус меняется атомарно, а проигравший отдаёт уже
    записанный результат.
    """
    content = client.get("/api/v1/tests/designer-profile", headers=auth_headers).json()
    session_id = client.post(
        "/api/v1/sessions", headers=auth_headers, json={"test_key": "designer-profile"}
    ).json()["id"]
    for question in content["questions"][:5]:
        client.put(
            f"/api/v1/sessions/{session_id}/answers/{question['id']}",
            headers=auth_headers,
            json={"option_ids": [question["options"][0]["id"]]},
        )

    first = client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers)
    second = client.post(f"/api/v1/sessions/{session_id}/complete", headers=auth_headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["primary_narrative_key"] == second.json()["primary_narrative_key"]

    history = client.get("/api/v1/results", headers=auth_headers).json()
    assert len([row for row in history if row["session_id"] == session_id]) == 1


def test_bearer_token_from_bot_button_authenticates(client, auth_headers):
    """Токен, выданный ботом кнопке, должен пускать без всякого initData."""
    from app.api.telegram_auth import issue_session_token

    client.get("/api/v1/me", headers=auth_headers)  # юзер появился в БД
    token = issue_session_token(42, "test-token-for-pytest", 180 * 24 * 60 * 60)
    response = client.get("/api/v1/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["telegram_user_id"] == 42


def test_session_token_header_authenticates(client, auth_headers):
    """X-Session-Token — основной путь фронта: Authorization забирает Yandex Cloud."""
    from app.api.telegram_auth import issue_session_token

    client.get("/api/v1/me", headers=auth_headers)
    token = issue_session_token(42, "test-token-for-pytest", 3600)
    response = client.get("/api/v1/me", headers={"X-Session-Token": token})
    assert response.status_code == 200
    assert response.json()["telegram_user_id"] == 42


def test_session_token_renews_silently_before_expiry(client, auth_headers):
    """Токен на исходе продлевается заголовком — иначе вход однажды умирает,
    и взять новый негде: initData Telegram отдаёт не всегда."""
    from app.api import main as api_main
    from app.api.telegram_auth import issue_session_token, read_session_token

    client.get("/api/v1/me", headers=auth_headers)
    dying = issue_session_token(42, "test-token-for-pytest", 3 * 24 * 60 * 60)
    response = client.get("/api/v1/me", headers={"Authorization": f"Bearer {dying}"})
    assert response.status_code == 200
    renewed = response.headers.get(api_main.SESSION_TOKEN_HEADER)
    assert renewed and renewed != dying
    user_id, seconds_left = read_session_token(renewed, "test-token-for-pytest")
    assert user_id == 42
    assert seconds_left > api_main.SESSION_TOKEN_REFRESH_BEFORE_SECONDS


def test_fresh_session_token_is_not_renewed(client, auth_headers):
    from app.api import main as api_main

    exchanged = client.post("/api/v1/auth/exchange", headers=auth_headers).json()
    response = client.get("/api/v1/me", headers={"Authorization": f"Bearer {exchanged['session_token']}"})
    assert response.status_code == 200
    assert api_main.SESSION_TOKEN_HEADER not in response.headers


def test_expired_session_token_is_rejected(client, auth_headers):
    import time
    from app.api.telegram_auth import issue_session_token

    client.get("/api/v1/me", headers=auth_headers)
    dead = issue_session_token(42, "test-token-for-pytest", -10, now=time.time())
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {dead}"}).status_code == 401


def _start_answered_session(client, auth_headers, test_key="designer-profile", project_id=None, answers=3):
    body = {"test_key": test_key}
    if project_id:
        body["project_id"] = project_id
    session = client.post("/api/v1/sessions", json=body, headers=auth_headers).json()
    content = client.get(f"/api/v1/tests/{test_key}", headers=auth_headers).json()
    for question in content["questions"][:answers]:
        client.put(
            f"/api/v1/sessions/{session['id']}/answers/{question['id']}",
            json={"option_ids": [question["options"][0]["id"]]},
            headers=auth_headers,
        )
    return session, content


def test_active_sessions_report_where_a_person_stopped(client, auth_headers):
    """Черновик держится на сервере: без него брошенный тест не найти с другого
    устройства и после чистки хранилища вебвью."""
    assert client.get("/api/v1/sessions/active", headers=auth_headers).json() == []

    project = client.post(
        "/api/v1/projects", json={"code_name": "Альфабанк Офис"}, headers=auth_headers
    ).json()
    _start_answered_session(client, auth_headers, "project-narrative", project["id"], answers=4)

    drafts = client.get("/api/v1/sessions/active", headers=auth_headers).json()
    assert len(drafts) == 1
    draft = drafts[0]
    assert draft["test_key"] == "project-narrative"
    assert draft["code_name"] == "Альфабанк Офис"
    assert draft["answered"] == 4
    assert draft["total"] == 35


def test_only_the_freshest_draft_of_each_test_is_offered(client, auth_headers):
    _start_answered_session(client, auth_headers, answers=2)
    second, _ = _start_answered_session(client, auth_headers, answers=5)

    drafts = client.get("/api/v1/sessions/active", headers=auth_headers).json()
    # Иначе на карточке теста висел бы список забытых попыток.
    assert [d["session_id"] for d in drafts] == [second["id"]]
    assert drafts[0]["answered"] == 5


def test_finished_test_is_no_longer_a_draft(client, auth_headers):
    session, content = _start_answered_session(client, auth_headers, answers=len(
        client.get("/api/v1/tests/designer-profile", headers=auth_headers).json()["questions"]))
    client.post(f"/api/v1/sessions/{session['id']}/complete", headers=auth_headers)
    assert client.get("/api/v1/sessions/active", headers=auth_headers).json() == []


def test_abandon_removes_the_draft_and_cannot_repeat(client, auth_headers):
    session, _ = _start_answered_session(client, auth_headers, answers=2)

    assert client.post(f"/api/v1/sessions/{session['id']}/abandon", headers=auth_headers).status_code == 200
    assert client.get("/api/v1/sessions/active", headers=auth_headers).json() == []
    # Ответы остаются в базе — брошенное прохождение всё ещё материал для разбора.
    assert client.get(f"/api/v1/sessions/{session['id']}", headers=auth_headers).json()["status"] == "abandoned"
    assert client.post(f"/api/v1/sessions/{session['id']}/abandon", headers=auth_headers).status_code == 404


def test_abandoned_session_refuses_further_answers(client, auth_headers):
    session, content = _start_answered_session(client, auth_headers, answers=1)
    client.post(f"/api/v1/sessions/{session['id']}/abandon", headers=auth_headers)
    question = content["questions"][5]
    response = client.put(
        f"/api/v1/sessions/{session['id']}/answers/{question['id']}",
        json={"option_ids": [question["options"][0]["id"]]},
        headers=auth_headers,
    )
    assert response.status_code == 409


def test_draft_of_another_person_is_invisible(client, auth_headers):
    session, _ = _start_answered_session(client, auth_headers, answers=2)
    stranger = {"X-Telegram-Init-Data": _signed_init_data("test-token-for-pytest", user_id=777, username="stranger")}

    assert client.get("/api/v1/sessions/active", headers=stranger).json() == []
    assert client.post(f"/api/v1/sessions/{session['id']}/abandon", headers=stranger).status_code == 404


def test_test_content_is_reworded_for_project_typology(client, auth_headers):
    base = client.get("/api/v1/tests/project-narrative", headers=auth_headers).json()
    office = client.get(
        "/api/v1/tests/project-narrative", params={"object_type": "office"}, headers=auth_headers
    ).json()
    assert office["object_type"] == "office"
    assert [q["id"] for q in office["questions"]] == [q["id"] for q in base["questions"]]
    assert any(a["text"] != b["text"] for a, b in zip(office["questions"], base["questions"]))


def test_session_carries_project_typology_for_resume(client, auth_headers):
    """При возобновлении фронт берёт типологию из сессии, чтобы показать вопросы
    в тех же формулировках, что и при старте."""
    project = client.post(
        "/api/v1/projects", json={"code_name": "Музей", "object_type": "museum"}, headers=auth_headers
    ).json()
    session, _ = _start_answered_session(client, auth_headers, "project-narrative", project["id"], answers=2)
    fetched = client.get(f"/api/v1/sessions/{session['id']}", headers=auth_headers).json()
    assert fetched["object_type"] == "museum"
    assert len(fetched["answers"]) == 2

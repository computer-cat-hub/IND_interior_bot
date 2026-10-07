const tg = window.Telegram?.WebApp;
const statusNode = document.querySelector("#status");
const userLine = document.querySelector("#user-line");
const apiBaseUrl = (window.APP_CONFIG?.API_URL || "").replace(/\/$/, "");

if (tg) {
  tg.ready();
  tg.expand();
}

// initData не const: Telegram отдаёт пустую строку, когда вебвью восстановили
// из кеша, но при возврате приложения на передний план значение часто приходит
// снова. Держим последнее непустое и перечитываем по событию activated.
let initData = tg?.initData || "";

function refreshInitData() {
  const fresh = tg?.initData || "";
  if (fresh && fresh !== initData) {
    initData = fresh;
    return true;
  }
  return false;
}

// Telegram-клиенты (особенно Desktop) кешируют/обрезают initData между
// открытиями мини-аппа — известный баг без официального фикса. Поэтому initData
// используется только один раз, чтобы обменять его на собственный долгоживущий
// токен; дальше все запросы идут с этим токеном и не зависят от того, что в
// этот раз отдал Telegram-клиент.
const SESSION_TOKEN_KEY = "interior-narrative:session-token";
const SESSION_TOKEN_HEADER = "X-Session-Token";

// ── Хранилище, которое не роняет приложение ──
// Вебвью Telegram (на Desktop особенно) отдаёт localStorage, который бросает
// на любой операции — тогда голое обращение убивало запуск теста, а человек
// видел «нет связи», хотя связь была. Без хранилища всё работает, просто до
// закрытия приложения: сессия и токен доживают в памяти.
const memoryStore = new Map();

function readLocal(key) {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored;
  } catch {
    // Хранилище недоступно — ниже ответит память.
  }
  return memoryStore.get(key) ?? null;
}

function writeLocal(key, value) {
  memoryStore.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Значение уже в памяти, этого хватает на текущий сеанс.
  }
}

function dropLocal(key) {
  memoryStore.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Нечего убирать — хранилища и так нет.
  }
}

let sessionToken = readLocal(SESSION_TOKEN_KEY);

function storeSessionToken(token) {
  if (!token) return;
  sessionToken = token;
  writeLocal(SESSION_TOKEN_KEY, token);
}

// Вход, вшитый в кнопку бота. Единственный путь, который не зависит от initData:
// бот знает, кто нажал кнопку, и подписывает токен сам. Из адреса параметр сразу
// убираем — незачем оставлять его в истории вебвью и в заголовке шаринга.
(function adoptTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromButton = params.get("t");
  if (!fromButton) return;
  storeSessionToken(fromButton);
  params.delete("t");
  const query = params.toString();
  const cleanUrl = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
  try {
    window.history.replaceState(null, "", cleanUrl);
  } catch {
    // Не вышло — не страшно, токен уже сохранён.
  }
})();

async function exchangeForSessionToken() {
  if (!initData || !apiBaseUrl) return null;
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/auth/exchange`, {
      method: "POST",
      headers: { "X-Telegram-Init-Data": initData },
    });
    if (!response.ok) return null;
    const data = await response.json();
    storeSessionToken(data.session_token);
    return data;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// ОШИБКИ
// Раньше наружу летел текст исключения («Failed to fetch»), по которому нельзя
// понять ни причины, ни что делать. Теперь каждая ошибка получает вид (kind),
// а человеку показывается объяснение: подождать, переоткрыть или писать людям.
// ═══════════════════════════════════════════

const REQUEST_TIMEOUT_MS = 15000;

class ApiError extends Error {
  constructor(kind, { status = null, detail = "" } = {}) {
    super(detail || kind);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

const SUPPORT_CONTACT = (window.APP_CONFIG?.SUPPORT_CONTACT || "").trim();
const supportLine = SUPPORT_CONTACT
  ? `Если не пройдёт за десять минут — напишите ${SUPPORT_CONTACT}.`
  : "Если не пройдёт за десять минут — сообщите администратору бота.";

const ERROR_TEXTS = {
  offline: () => ({
    text: "Телефон не в сети. Включите интернет или Wi-Fi и попробуйте снова.",
    retry: true,
    code: "СЕТЬ-1",
  }),
  network: () => ({
    text: `Не получается связаться с сервером. Обычно это интернет или VPN: проверьте связь и попробуйте ещё раз. Сервер могли ненадолго выключить — тогда через пару минут заработает само. ${supportLine}`,
    retry: true,
    code: "СЕТЬ-2",
  }),
  timeout: () => ({
    text: "Сервер не ответил за 15 секунд — похоже, связь очень медленная. Попробуйте ещё раз.",
    retry: true,
    code: "СЕТЬ-3",
  }),
  auth: () => ({
    text: "Telegram не подтвердил вход. Закройте приложение и откройте заново кнопкой «Открыть приложение» в чате с ботом. Если не помогло — отправьте боту /start, кнопка обновится.",
    retry: false,
    // Без кода: он один такой, и в /help по нему всё равно нечего искать.
    code: null,
  }),
  server: (e) => ({
    text: `Сервер ответил ошибкой — это поломка на нашей стороне, не у вас. Попробуйте через минуту. ${supportLine}`,
    retry: true,
    code: `СЕРВЕР-${e.status || "500"}`,
  }),
  missing: (e) => ({
    text: e.detail || "Данные не нашлись на сервере. Вернитесь на главный экран и начните заново.",
    retry: false,
    code: "НЕТ-ДАННЫХ",
  }),
  client: (e) => ({ text: e.detail || "Запрос не принят сервером.", retry: false, code: null }),
  // Падение внутри самого приложения. Раньше такие ошибки описывались как
  // сетевые, и человек чинил интернет там, где дело было не в нём.
  unknown: () => ({
    text: `Приложение споткнулось на ровном месте. Закройте его и откройте заново кнопкой «Открыть приложение». ${supportLine}`,
    retry: true,
    code: "СБОЙ-1",
  }),
  config: () => ({
    text: "Приложение собрано без адреса сервера. Это ошибка сборки — сообщите администратору бота.",
    retry: false,
    code: "КОНФИГ-1",
  }),
};

function describeError(error) {
  const kind = error instanceof ApiError ? error.kind : "unknown";
  const build = ERROR_TEXTS[kind] || ERROR_TEXTS.network;
  const described = build(error);
  return { ...described, kind, message: described.code ? `${described.text} (код ${described.code})` : described.text };
}

// Показывает ошибку и, если повтор имеет смысл, кнопку «Попробовать ещё раз».
function renderError(node, error, retryFn) {
  const { message, retry } = describeError(error);
  node.innerHTML = "";
  const line = document.createElement("span");
  line.className = "error-text";
  line.textContent = message;
  node.appendChild(line);
  if (retry && retryFn) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-ghost btn-retry";
    btn.textContent = "Попробовать ещё раз";
    btn.addEventListener("click", () => { node.innerHTML = ""; retryFn(); });
    node.appendChild(btn);
  }
}

async function api(path, options = {}, _retried = false) {
  if (!apiBaseUrl) {
    throw new ApiError("config");
  }
  if (!sessionToken) {
    await exchangeForSessionToken();
  }
  const headers = { ...(options.headers || {}) };
  if (sessionToken) {
    // Не Authorization: его перехватывает Yandex Serverless Containers.
    headers["X-Session-Token"] = sessionToken;
  } else {
    headers["X-Telegram-Init-Data"] = initData;
  }
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  let response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetch(`${apiBaseUrl}${path}`, { ...options, headers, signal: abort.signal });
  } catch (cause) {
    // fetch не различает «нет сети», «сервер выключен» и «домен не отвечает» —
    // всё это один TypeError. Отделяем хотя бы таймаут и офлайн.
    if (cause.name === "AbortError") throw new ApiError("timeout");
    if (navigator.onLine === false) throw new ApiError("offline");
    if (!_retried) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return api(path, options, true);
    }
    throw new ApiError("network");
  } finally {
    clearTimeout(timer);
  }

  // Сервер продлевает токен заранее, не дожидаясь, пока он умрёт: иначе через
  // тридцать дней вход отваливался бы у всех, кому Telegram не отдаёт initData.
  const refreshed = response.headers.get(SESSION_TOKEN_HEADER);
  if (refreshed) {
    storeSessionToken(refreshed);
  }

  if (response.status === 401 && !_retried) {
    sessionToken = null;
    dropLocal(SESSION_TOKEN_KEY);
    if (await exchangeForSessionToken()) {
      return api(path, options, true);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload.detail || "";
    if (response.status === 401 || response.status === 403) throw new ApiError("auth", { status: response.status, detail });
    if (response.status === 404) throw new ApiError("missing", { status: 404, detail });
    if (response.status >= 500) throw new ApiError("server", { status: response.status, detail });
    throw new ApiError("client", { status: response.status, detail });
  }
  return response.status === 204 ? null : response.json();
}

async function initIdentity() {
  if (sessionToken) {
    try {
      const me = await api("/api/v1/me");
      userLine.textContent = me.username ? `@${me.username}` : me.first_name || "Профиль Telegram";
      return;
    } catch {
      // токен истёк/отозван — попробуем обменять initData заново ниже
    }
  }
  const exchanged = await exchangeForSessionToken();
  if (exchanged) {
    userLine.textContent = exchanged.username ? `@${exchanged.username}` : exchanged.first_name || "Профиль Telegram";
  } else if (sessionToken) {
    // Токен цел (401 бы его стёр) — значит не достучались до сервера, а не
    // потеряли вход. Тесты при этом продолжат работать по токену.
    userLine.textContent = "Профиль не обновился — нет связи";
  } else if (!initData) {
    userLine.textContent = "Открыто вне Telegram";
  } else {
    userLine.textContent = "Профиль не загрузился — нет связи";
  }
}
initIdentity().then(refreshDrafts);

// ═══════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════

const screens = {
  start: document.getElementById("screen-start"),
  project: document.getElementById("screen-project"),
  question: document.getElementById("screen-question"),
  results: document.getElementById("screen-results"),
  history: document.getElementById("screen-history"),
};

// Кнопка в шапке контекстная: на старте — вход в историю, на истории и на
// открытом результате — крестик «закрыть». Раньше там всегда висела «История»,
// и на самой истории кнопка вела в раздел, где ты уже находишься.
const topbarButton = document.getElementById("history-button");
const topbarLabel = document.getElementById("history-button-label")
  || topbarButton.querySelector(".history-button-label");
const topbarIcon = topbarButton.querySelector("use");

const TOPBAR_MODES = {
  history: { icon: "#ic-history", label: "Результаты", title: "Результаты тестов" },
  close: { icon: "#ic-close", label: "Закрыть", title: "Закрыть" },
};

function setTopbarMode(mode) {
  if (mode === "hidden") {
    topbarButton.hidden = true;
    return;
  }
  const preset = TOPBAR_MODES[mode];
  topbarButton.hidden = false;
  topbarButton.dataset.mode = mode;
  topbarIcon.setAttribute("href", preset.icon);
  topbarLabel.textContent = preset.label;
  topbarButton.setAttribute("aria-label", preset.title);
  topbarButton.title = preset.title;
}

// Куда возвращает крестик на экране результата: сразу после теста — на старт,
// из истории — обратно в историю, откуда пользователь и пришёл.
let resultOrigin = "quiz";

const TOPBAR_BY_SCREEN = {
  start: "history",
  project: "hidden",
  question: "hidden",
  results: "close",
  history: "close",
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.hidden = key !== name;
  });
  setTopbarMode(TOPBAR_BY_SCREEN[name] || "history");
  window.scrollTo({ top: 0 });
}

// ═══════════════════════════════════════════
// STATE — один активный тест за раз
// ═══════════════════════════════════════════

let quiz = null;
// quiz = { testKey, sessionId, content, questions, index, answers: {qid: optId}, pendingProjectDraft }

let busy = false;
let savingAnswer = false;

function setStatus(text) {
  statusNode.textContent = text;
}

// ═══════════════════════════════════════════
// START → выбор теста
// ═══════════════════════════════════════════

// Работать можно и без свежего initData — если с прошлого раза остался живой
// сессионный токен. Именно ради этого он и заводился: Telegram-клиент часто
// отдаёт пустой initData при повторном открытии, и упираться в него нельзя.
const hasIdentity = () => Boolean(initData || sessionToken);

const NOT_IN_TELEGRAM =
  "Приложение открыто вне Telegram — профиль не передан, поэтому тест не начать. "
  + "Отправьте боту /start и откройте приложение свежей кнопкой «Открыть приложение»: "
  + "она несёт вход в себе и работает даже когда Telegram не передаёт профиль.";

// ── Черновики: что начато и не закончено ──
// Держим на сервере: хранилище вебвью бывает недоступно и не переезжает на
// другое устройство, а человек ждёт свой недопройденный тест там же, где бросил.

const activeDrafts = new Map();

async function refreshDrafts() {
  if (!hasIdentity()) return;
  try {
    const drafts = await api("/api/v1/sessions/active");
    activeDrafts.clear();
    drafts.forEach((draft) => activeDrafts.set(draft.test_key, draft));
    renderDraftBadges();
  } catch {
    // Не достучались — карточки просто останутся без меток, тесты работают.
  }
}

function draftLine(draft) {
  const where = draft.code_name ? ` «${draft.code_name}»` : "";
  return `Начато${where}: ${draft.answered} из ${draft.total}`;
}

function renderDraftBadges() {
  document.querySelectorAll(".test-card").forEach((card) => {
    const draft = activeDrafts.get(card.dataset.test);
    let badge = card.querySelector(".test-progress");
    if (!draft) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "test-progress";
      card.querySelector(".test-content").appendChild(badge);
    }
    badge.textContent = draftLine(draft);
  });
}

const resumeModal = document.getElementById("resume-modal");
const resumeText = document.getElementById("resume-text");
let pendingDraft = null;

function askResume(draft) {
  pendingDraft = draft;
  const where = draft.code_name ? ` по проекту «${draft.code_name}»` : "";
  resumeText.textContent =
    `Прошлый раз вы остановились${where} на ${draft.answered} из ${draft.total} вопросов. `
    + "Можно продолжить с того же места или начать тест заново — тогда прежние ответы не сохранятся.";
  resumeModal.hidden = false;
}

function closeResume() {
  resumeModal.hidden = true;
  pendingDraft = null;
}

document.getElementById("resume-continue").addEventListener("click", async () => {
  const draft = pendingDraft;
  closeResume();
  if (!draft || busy) return;
  busy = true;
  const slow = slowHint("Возвращаемся к тесту…", "Возвращаемся к тесту… связь медленная, ещё пробуем");
  try {
    await resumeSession(draft);
  } catch (error) {
    renderError(statusNode, error, () => startTest(draft.test_key));
  } finally {
    slow.stop();
    busy = false;
  }
});

document.getElementById("resume-restart").addEventListener("click", async () => {
  const draft = pendingDraft;
  closeResume();
  if (!draft) return;
  try {
    // Помечаем брошенным до старта нового: иначе следующий заход предложит
    // продолжить уже забытое прохождение.
    await api(`/api/v1/sessions/${draft.session_id}/abandon`, { method: "POST" });
  } catch {
    // Не вышло — не повод не дать начать заново.
  }
  activeDrafts.delete(draft.test_key);
  renderDraftBadges();
  await launchTest(draft.test_key);
});

// Клик мимо карточки — то же, что «не сейчас»: диалог закрывается, выбор не сделан.
resumeModal.addEventListener("click", (event) => {
  if (event.target === resumeModal) closeResume();
});

async function startTest(testKey) {
  if (!hasIdentity()) {
    setStatus(NOT_IN_TELEGRAM);
    return;
  }
  if (busy) return;

  // Начатое и брошенное прохождение важнее нового: у второго теста заново
  // означало бы ещё раз заполнять бриф проекта, а ответы прошлого раза так и
  // остались бы висеть неоконченными.
  const draft = activeDrafts.get(testKey);
  if (draft) {
    askResume(draft);
    return;
  }

  await launchTest(testKey);
}

async function launchTest(testKey) {
  if (testKey === "project-narrative") {
    showScreen("project");
    return;
  }

  busy = true;
  const slow = slowHint("Загружаем вопросы…", "Загружаем вопросы… связь медленная, ещё пробуем");
  try {
    await beginSession(testKey, null);
  } catch (error) {
    renderError(statusNode, error, () => startTest(testKey));
  } finally {
    slow.stop();
    busy = false;
  }
}

// Долгое ожидание без единого слова читается как зависание. Через 6 секунд
// подменяем текст, чтобы человек понимал: приложение живо, тормозит связь.
function slowHint(text, slowText, node = statusNode) {
  node.textContent = text;
  const timer = setTimeout(() => { node.textContent = slowText; }, 6000);
  return { stop: () => clearTimeout(timer) };
}

// Формулировки вопросов подстраиваются под типологию проекта (офис, отель…):
// сервер отдаёт тот же набор вопросов и вариантов, но в словах выбранной типологии.
function testContentUrl(testKey, objectType) {
  const query = objectType ? `?object_type=${encodeURIComponent(objectType)}` : "";
  return `/api/v1/tests/${testKey}${query}`;
}

async function beginSession(testKey, projectId, objectType = null) {
  const content = await api(testContentUrl(testKey, objectType));
  const session = await api("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ test_key: testKey, project_id: projectId || undefined }),
  });
  await enterQuiz(testKey, session.id, content, {});
}

/** Возврат в брошенное прохождение — с того вопроса, где человек остановился. */
async function resumeSession(draft) {
  // Сначала сессия: в ней типология проекта, от которой зависят формулировки.
  const existing = await api(`/api/v1/sessions/${draft.session_id}`);
  const content = await api(testContentUrl(draft.test_key, existing.object_type));
  await enterQuiz(draft.test_key, existing.id, content, existing.answers || {});
}

async function enterQuiz(testKey, sessionId, content, answers) {
  refreshDrafts().catch(() => {});
  const answeredIds = new Set(Object.keys(answers));
  const firstUnanswered = content.questions.findIndex((q) => !answeredIds.has(q.id));

  quiz = {
    testKey,
    sessionId,
    content,
    answers,
    index: firstUnanswered === -1 ? content.questions.length - 1 : firstUnanswered,
  };

  setStatus("");
  renderQuestion();
  showScreen("question");
}

// ═══════════════════════════════════════════
// ПРОЕКТ (для теста 2)
// ═══════════════════════════════════════════

document.getElementById("project-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const codeName = form.code_name.value.trim();
  if (!codeName) {
    document.getElementById("project-status").textContent = "Укажите код проекта.";
    return;
  }
  busy = true;
  document.getElementById("project-status").textContent = "Создаём проект…";
  try {
    const areaRaw = form.area_m2.value.trim();
    const project = await api("/api/v1/projects", {
      method: "POST",
      body: JSON.stringify({
        code_name: codeName,
        object_type: form.object_type.value,
        area_m2: areaRaw ? Number(areaRaw) : undefined,
      }),
    });
    document.getElementById("project-status").textContent = "";
    await beginSession("project-narrative", project.id, form.object_type.value);
  } catch (error) {
    renderError(document.getElementById("project-status"), error, () => form.requestSubmit());
  } finally {
    busy = false;
  }
});

document.getElementById("project-cancel").addEventListener("click", () => {
  showScreen("start");
});

// ═══════════════════════════════════════════
// ЭКРАН ВОПРОСА
// ═══════════════════════════════════════════

function renderQuestion() {
  const { content, index, answers } = quiz;
  const question = content.questions[index];
  const total = content.questions.length;

  document.getElementById("q-counter").textContent = `Вопрос ${index + 1} из ${total}`;
  document.getElementById("q-percent").textContent = `${Math.round((index / total) * 100)}%`;
  document.getElementById("progress-fill").style.width = `${Math.round((index / total) * 100)}%`;
  document.getElementById("q-text").textContent = question.text;
  document.getElementById("save-indicator").textContent = "";
  document.getElementById("q-hint").hidden = !question.multi;

  const selected = new Set(answers[question.id] || []);

  const list = document.getElementById("options-list");
  list.innerHTML = "";
  question.options.filter((option) => option.id !== "dunno").forEach((option) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.dataset.optionId = option.id;
    btn.textContent = option.text;
    if (selected.has(option.id)) {
      btn.classList.add("chosen");
    }
    btn.addEventListener("click", () => {
      if (question.multi) {
        toggleMultiOption(question, option.id, btn);
      } else {
        chooseSingleOption(question.id, option.id, btn);
      }
    });
    list.appendChild(btn);
  });

  // На первом вопросе возвращаться некуда — вместо спрятанной кнопки даём выход
  // из теста, иначе начатый тест некуда закрыть, кроме как убить Mini App.
  const backBtn = document.getElementById("btn-back");
  const atFirst = index === 0;
  backBtn.dataset.mode = atFirst ? "close" : "back";
  backBtn.querySelector("use").setAttribute("href", atFirst ? "#ic-close" : "#ic-arrow-back");
  const closeLabel = question.multi ? "Закрыть" : "Закрыть тест";
  document.getElementById("btn-back-label").textContent = atFirst ? closeLabel : "Назад";
  // Тест 1 — про самого автора: там уместно «Пропустить». Тест 2 — про факты проекта,
  // которых человек может ещё не знать, там «Не знаю».
  document.querySelector("#btn-dunno span").textContent = quiz.testKey === "designer-profile"
    ? "Пропустить"
    : (question.multi ? "Не знаю" : "Ещё не знаю");

  syncActionButtons(question, selected);
}

// «Ещё не знаю» и «Далее» занимают одно место справа и никогда не нужны
// одновременно: пока ничего не выбрано, уместен пропуск, как только выбрали —
// переход дальше. Так обе кнопки помещаются даже на узком экране.
function syncActionButtons(question, selected) {
  const hasDunno = question.options.some((option) => option.id === "dunno");
  const chosenSomething = selected.size > 0 && !selected.has("dunno");
  document.getElementById("btn-dunno").hidden = !hasDunno || chosenSomething;
  const nextBtn = document.getElementById("btn-next");
  nextBtn.hidden = !question.multi || !chosenSomething;
  nextBtn.disabled = false;
}

// В строке автосохранения места мало: даём короткую причину, подробности с
// кнопкой повтора человек увидит, если тест сорвётся совсем.
function saveFailureText(error) {
  const { kind } = describeError(error);
  if (kind === "offline" || kind === "network" || kind === "timeout") {
    return "Ответ не ушёл — нет связи. Нажмите вариант ещё раз.";
  }
  if (kind === "auth") return "Вход слетел. Откройте приложение заново из чата.";
  return "Ответ не сохранился. Нажмите вариант ещё раз.";
}

// Multi-select: клик копит выбор локально, отправляем всё разом по «Далее».
// «Не знаю» эксклюзивен с остальными вариантами — иначе итоговый набор
// противоречив (и «не в курсе», и конкретный ответ одновременно).
function toggleMultiOption(question, optionId, buttonEl) {
  const current = new Set(quiz.answers[question.id] || []);
  const isDunno = optionId === "dunno";

  if (current.has(optionId)) {
    current.delete(optionId);
    buttonEl.classList.remove("chosen");
  } else {
    if (isDunno) {
      current.clear();
    } else {
      current.delete("dunno");
    }
    current.add(optionId);
    buttonEl.classList.add("chosen");
  }

  quiz.answers[question.id] = [...current];
  syncMultiButtonStates(question, current);
  syncActionButtons(question, current);
}

function syncMultiButtonStates(question, selectedSet) {
  const list = document.getElementById("options-list");
  [...list.children].forEach((btn) => {
    btn.classList.toggle("chosen", selectedSet.has(btn.dataset.optionId));
  });
}

async function chooseSingleOption(questionId, optionId, buttonEl) {
  if (savingAnswer) return;
  savingAnswer = true;

  document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = true; });
  const indicator = document.getElementById("save-indicator");
  indicator.textContent = "";

  quiz.answers[questionId] = [optionId];
  buttonEl.classList.add("chosen");

  try {
    await submitAnswer(questionId, [optionId]);
    indicator.textContent = "";
  } catch (error) {
    indicator.textContent = saveFailureText(error);
    document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = false; });
    savingAnswer = false;
    return;
  }

  setTimeout(async () => {
    savingAnswer = false;
    await advanceOrFinish();
  }, 160);
}

async function submitAnswer(questionId, optionIds) {
  await api(`/api/v1/sessions/${quiz.sessionId}/answers/${questionId}`, {
    method: "PUT",
    body: JSON.stringify({ option_ids: optionIds }),
  });
}

async function advanceOrFinish() {
  if (quiz.index + 1 >= quiz.content.questions.length) {
    await finishQuiz();
  } else {
    quiz.index += 1;
    renderQuestion();
  }
}

// «Ещё не знаю» отвечает и сразу листает дальше — и в одиночном вопросе,
// и в множественном, где такой ответ по смыслу исключает все остальные.
document.getElementById("btn-dunno").addEventListener("click", async () => {
  if (savingAnswer || !quiz) return;
  const question = quiz.content.questions[quiz.index];
  savingAnswer = true;
  quiz.answers[question.id] = ["dunno"];
  document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = true; el.classList.remove("chosen"); });
  const indicator = document.getElementById("save-indicator");
  indicator.textContent = "";

  try {
    await submitAnswer(question.id, ["dunno"]);
    indicator.textContent = "";
  } catch (error) {
    indicator.textContent = saveFailureText(error);
    document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = false; });
    savingAnswer = false;
    return;
  }

  savingAnswer = false;
  await advanceOrFinish();
});

document.getElementById("btn-next").addEventListener("click", async () => {
  if (savingAnswer || !quiz) return;
  const question = quiz.content.questions[quiz.index];
  const selected = quiz.answers[question.id] || [];
  if (!selected.length) return;

  savingAnswer = true;
  document.getElementById("btn-next").disabled = true;
  document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = true; });
  const indicator = document.getElementById("save-indicator");
  indicator.textContent = "";

  try {
    await submitAnswer(question.id, selected);
    indicator.textContent = "";
  } catch (error) {
    indicator.textContent = saveFailureText(error);
    document.querySelectorAll(".option-btn").forEach((el) => { el.disabled = false; });
    document.getElementById("btn-next").disabled = false;
    savingAnswer = false;
    return;
  }

  savingAnswer = false;
  await advanceOrFinish();
});

document.getElementById("btn-back").addEventListener("click", () => {
  if (savingAnswer || !quiz) return;
  if (quiz.index === 0) {
    // Черновик сессии остаётся на сервере и в хранилище: вернётся —
    // продолжит с того же места, а не начнёт заново.
    exitToStart();
    return;
  }
  quiz.index -= 1;
  renderQuestion();
});

function exitToStart() {
  quiz = null;
  setStatus("");
  showScreen("start");
  // Счётчик на карточке должен показывать, сколько человек успел ответить
  // именно сейчас, а не сколько было при открытии приложения.
  refreshDrafts().catch(() => {});
}

async function finishQuiz() {
  setStatus("");
  const qText = document.getElementById("q-text");
  qText.textContent = "Считаем результат…";
  const optionsList = document.getElementById("options-list");
  optionsList.innerHTML = "";
  const slow = slowHint("Считаем результат…", "Считаем результат… связь медленная, ещё пробуем", qText);
  try {
    const result = await api(`/api/v1/sessions/${quiz.sessionId}/complete`, { method: "POST" });
    activeDrafts.delete(quiz.testKey);
    renderDraftBadges();
    // Дожидаемся полной прорисовки НОВОГО результата, прежде чем показать
    // экран — иначе на долю секунды виден предыдущий результат (screen-results
    // ещё хранит DOM от прошлого прохождения, если это уже не первый тест в сессии).
    await renderResult(result);
    resultOrigin = "quiz";
    showScreen("results");
  } catch (error) {
    qText.textContent = "Ответы сохранены, но результат не пришёл";
    renderError(optionsList, error, () => finishQuiz());
  } finally {
    slow.stop();
  }
}

// ═══════════════════════════════════════════
// ЭКРАН РЕЗУЛЬТАТА
// ═══════════════════════════════════════════

// Два процента на одном экране путают: первый — насколько ответы совпали с
// этим архетипом, второй — на сколько вопросов вообще ответили. Второй теперь
// объясняется словами, а не голой цифрой «уверенность 100%».
function confidenceLine(confidence, isDesignerProfile) {
  if (confidence >= 100) return "Считали по всем вашим ответам.";
  const skipped = isDesignerProfile ? "остальные вы пропустили" : "остальные вы отметили «Не знаю»";
  if (confidence >= 70) {
    return `Содержательных ответов — ${confidence}%, ${skipped}. Данных хватает.`;
  }
  const advice = isDesignerProfile
    ? "Пройдите тест ещё раз и ответьте на пропущенные вопросы."
    : "Пройдите тест ещё раз, когда по проекту будет больше ясности.";
  return `Содержательных ответов — всего ${confidence}%, поэтому результат ориентировочный. ${advice}`;
}

async function loadFullResult(sessionId) {
  return api(`/api/v1/sessions/${sessionId}/result`);
}

async function renderResult(resultSummary) {
  try {
    const full = await loadFullResult(resultSummary.session_id || resultSummary.id);
    renderResultDetail(full);
  } catch {
    renderResultDetail(resultSummary);
  }
}

// Висячие предлоги/короткие слова — неразрывный пробел (U+00A0), не обычный.
// Порт 1:1 из шипнутого теста (index.html noWidow), включая lookbehind и тире.
function noWidow(str) {
  if (!str) return "";
  return str
    .replace(/(?<!\S)(\S{1,3})\s/g, "$1 ")
    .replace(/\s—/g, " —");
}

function setNoWidowText(el, text) {
  el.innerHTML = "";
  el.appendChild(document.createTextNode(noWidow(text)));
}

const DESIGNER_ARCHETYPE_IMAGE = (key) => `./assets/archetypes/${key}.jpg`;

function renderResultDetail(result) {
  const isDesignerProfile = result.test_key === "designer-profile";
  const primary = result.primary_detail || {};
  const ranking = result.full_ranking || [];

  document.getElementById("result-kicker").textContent = isDesignerProfile
    ? "Ваш ведущий архетип"
    : "Рабочая гипотеза нарратива";
  document.getElementById("result-name").textContent = primary.name || result.primary_narrative_key;
  document.getElementById("result-subtitle").textContent = primary.subtitle || "";
  // Цвет архетипа ставим на весь экран, а не только на карточку: по нему
  // красится и надпись «Ваш ведущий архетип» над карточкой.
  document.getElementById("screen-results").style.setProperty("--arch-color", primary.color || "#2563EB");

  const imageWrap = document.getElementById("result-image-wrap");
  if (isDesignerProfile) {
    document.getElementById("result-image").src = DESIGNER_ARCHETYPE_IMAGE(result.primary_narrative_key);
    document.getElementById("result-image").alt = primary.name || "";
    imageWrap.hidden = false;
  } else {
    imageWrap.hidden = true;
  }

  document.getElementById("fit-bar").style.width = `${result.primary_score}%`;
  document.getElementById("fit-bar").style.background = primary.color || "#2563EB";
  document.getElementById("fit-percent").textContent = `${result.primary_score}%`;
  document.getElementById("fit-label").textContent = isDesignerProfile
    ? "Совпадение с архетипом"
    : "Совпадение с нарративом";
  document.getElementById("confidence-line").textContent = confidenceLine(result.confidence, isDesignerProfile);
  setNoWidowText(document.getElementById("result-text"), result.result_text);

  const detail = document.getElementById("result-detail");
  detail.innerHTML = "";
  if (primary.desc) detail.appendChild(makeDetailBlock("Подробнее", primary.desc));
  if (primary.strengths?.length) {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = "Сильные стороны";
    wrap.appendChild(h);
    primary.strengths.forEach((s) => {
      const tag = document.createElement("span");
      tag.className = "strength-tag";
      tag.textContent = s;
      wrap.appendChild(tag);
    });
    detail.appendChild(wrap);
  }
  if (primary.blindspot) {
    const box = document.createElement("div");
    box.className = "blindspot-block";
    const strong = document.createElement("strong");
    strong.textContent = "Слепая зона: ";
    box.appendChild(strong);
    box.appendChild(document.createTextNode(noWidow(primary.blindspot)));
    detail.appendChild(box);
  }
  if (primary.thesis) detail.appendChild(makeDetailBlock("Тезис", primary.thesis));
  if (primary.client_argument) detail.appendChild(makeDetailBlock("Аргумент для заказчика", primary.client_argument));
  if (primary.visual_direction) detail.appendChild(makeDetailBlock("Визуальный язык", primary.visual_direction));
  if (primary.risks) detail.appendChild(makeDetailBlock("Риски", primary.risks));
  if (primary.next_step) detail.appendChild(makeDetailBlock("Следующий шаг", primary.next_step));
  if (primary.advice) detail.appendChild(makeDetailBlock("Попробуйте в следующем проекте", primary.advice));

  document.getElementById("wheel-title").textContent = isDesignerProfile
    ? "Профиль дизайнерского мышления"
    : "Профиль проектных стратегий";

  renderWheel(ranking);
  renderSummary(ranking, isDesignerProfile);
  renderRankedList(ranking, isDesignerProfile);
}

function makeDetailBlock(title, text) {
  const wrap = document.createElement("div");
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.appendChild(document.createTextNode(noWidow(text)));
  wrap.appendChild(h);
  wrap.appendChild(p);
  return wrap;
}

// ── Колесо: SVG-диаграмма, нормировка от максимального fit% в наборе ──
// (в оригинале — от топ-сырого-скора; здесь колонка данных уже % от
// собственного максимума нарратива, поэтому нормируем от топового %.)
function renderWheel(ranking) {
  const section = document.getElementById("wheel-section");
  if (!ranking.length) { section.hidden = true; return; }
  section.hidden = false;

  const svg = document.getElementById("wheel-svg");
  svg.innerHTML = "";
  const cx = 220, cy = 220, maxR = 155;
  const n = ranking.length;
  const step = (2 * Math.PI) / n;
  const startOffset = -Math.PI / 2;
  const ns = "http://www.w3.org/2000/svg";

  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }

  [0.25, 0.5, 0.75, 1.0].forEach((r) => {
    svg.appendChild(el("circle", {
      cx, cy, r: maxR * r, fill: "none",
      stroke: r === 1.0 ? "#CBD5E1" : "#E8ECF2",
      "stroke-width": r === 1.0 ? "1.5" : "1",
      "stroke-dasharray": r < 1 ? "3 4" : "none",
    }));
  });

  for (let i = 0; i < n; i++) {
    const angle = startOffset + i * step;
    svg.appendChild(el("line", {
      x1: cx, y1: cy,
      x2: cx + maxR * Math.cos(angle), y2: cy + maxR * Math.sin(angle),
      stroke: "#E8ECF2", "stroke-width": "1",
    }));
  }

  const topPct = Math.max(1, ...ranking.map((r) => r.fit_percent || 0));
  ranking.forEach((item, i) => {
    const pct = item.fit_percent || 0;
    const norm = pct / topPct;
    const r = Math.max(norm * maxR * 0.9, pct > 0 ? 4 : 0);
    const a1 = startOffset + i * step;
    const a2 = startOffset + (i + 1) * step;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    svg.appendChild(el("path", {
      d: `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2} Z`,
      fill: item.color || "#2563EB", "fill-opacity": "0.72",
      stroke: item.color || "#2563EB", "stroke-width": "0.5",
    }));
  });

  svg.appendChild(el("circle", { cx, cy, r: maxR, fill: "none", stroke: "#CBD5E1", "stroke-width": "1.5" }));
  svg.appendChild(el("circle", { cx, cy, r: 4, fill: "#94A3B8" }));

  ranking.forEach((item, i) => {
    const midAngle = startOffset + (i + 0.5) * step;
    const labelR = maxR + 26;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    const text = el("text", {
      x: lx, y: ly, "text-anchor": "middle", "dominant-baseline": "middle",
      "font-size": "9", "font-weight": "500", fill: "#64748B",
      "font-family": "Inter, system-ui, sans-serif",
    });
    text.textContent = item.short_name || item.name;
    svg.appendChild(text);
  });
}

// ── Саммари: топ-3 чипа + текст, совет по нижним-3 (только там, где есть advice) ──
function renderSummary(ranking, isDesignerProfile) {
  const section = document.getElementById("summary-section");
  if (!isDesignerProfile || ranking.length < 6) { section.hidden = true; return; }
  section.hidden = false;

  const top3 = ranking.slice(0, 3);
  const bottom3 = ranking.slice(-3).reverse();

  const chips = top3.map((a) =>
    `<div class="palette-chip"><span class="dot" style="background:${a.color}"></span>${a.name} ${a.fit_percent}%</div>`
  ).join("");

  const blindNames = bottom3.map((a) => a.name).join(", ");
  const adviceItems = bottom3
    .filter((a) => a.advice)
    .map((a) => `<p><strong>${a.name}.</strong> ${noWidow(a.advice)}</p>`)
    .join("");

  section.innerHTML = `
    <h3>Что говорит ваш профиль</h3>
    <div class="summary-palette">${chips}</div>
    <div class="summary-text">
      <p>${noWidow(`Ваш основной подход — ${top3[0].name}. Его хорошо дополняют ${top3[1].name} и ${top3[2].name} — вместе они дают гибкость под разные задачи.`)}</p>
      <p>${noWidow(`В профиле меньше — ${blindNames}. Это просто инструменты, которые пока реже используются в проектах.`)}</p>
    </div>
    ${adviceItems ? `<div class="summary-advice"><strong>Попробуйте в следующем проекте:</strong>${adviceItems}</div>` : ""}
  `;
}

// ── Полный список: все нарративы, раскрывающиеся карточки ──
function renderRankedList(ranking, isDesignerProfile) {
  const title = document.getElementById("ranked-title");
  title.textContent = isDesignerProfile ? "Все архетипы" : "Все нарративы";

  const list = document.getElementById("ranked-list");
  list.innerHTML = "";
  ranking.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "archetype-card";
    card.style.setProperty("--card-color", item.color || "#2563EB");

    const bodyParts = [];
    const bodyText = item.desc || item.thesis;
    if (bodyText) bodyParts.push(`<p>${noWidow(bodyText)}</p>`);
    if (item.when_fits) bodyParts.push(`<p>${noWidow(item.when_fits)}</p>`);
    const tags = item.strengths?.length
      ? `<div class="mini-strengths">${item.strengths.map((s) => `<span class="mini-tag">${s}</span>`).join("")}</div>`
      : "";

    card.innerHTML = `
      <div class="card-header">
        <div class="card-rank">${idx + 1}</div>
        <div class="card-color-dot" style="background:${item.color}"></div>
        <div class="card-name">
          <strong>${item.name}</strong>
          <span>${item.subtitle || ""}</span>
        </div>
        <div class="card-score-area">
          <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${item.fit_percent}%;background:${item.color}"></div></div>
          <div class="score-num">${item.fit_percent}%</div>
        </div>
        <div class="card-chevron"><svg class="ic" aria-hidden="true"><use href="#ic-expand-more"></use></svg></div>
      </div>
      <div class="card-body">${bodyParts.join("")}${tags}</div>
    `;
    card.querySelector(".card-header").addEventListener("click", () => card.classList.toggle("expanded"));
    list.appendChild(card);
  });
}

document.getElementById("btn-restart").addEventListener("click", exitToStart);

// ═══════════════════════════════════════════
// ИСТОРИЯ
// ═══════════════════════════════════════════

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

const TEST_LABELS = {
  "designer-profile": "Какой вы тип дизайнера",
  "project-narrative": "Нарратив для проекта",
};

async function showHistory() {
  if (!hasIdentity()) {
    setStatus(NOT_IN_TELEGRAM);
    return;
  }
  if (busy) return;
  busy = true;
  showScreen("history");
  const list = document.getElementById("history-list");
  list.innerHTML = "<p class=\"status\">Загружаем историю…</p>";
  try {
    const results = await api("/api/v1/results");
    if (!results.length) {
      list.innerHTML = "<p class=\"status\">Сохранённых результатов пока нет.</p>";
    } else {
      list.innerHTML = "";
      results.forEach((r) => {
        const item = document.createElement("div");
        item.className = "history-item";
        const date = r.completed_at ? new Date(r.completed_at).toLocaleDateString("ru-RU") : "";
        const name = r.primary_narrative_name || r.primary_narrative_key;
        // code_name человек вводит сам — в innerHTML он бы исполнился как разметка.
        const label = r.code_name ? `${escapeHtml(r.code_name)} — ${escapeHtml(name)}` : escapeHtml(name);
        item.innerHTML = `
          <div class="h-top"><span>${escapeHtml(TEST_LABELS[r.test_key] || r.test_key)}</span><span>${escapeHtml(date)}</span></div>
          <strong>${label} · ${Number(r.primary_score) || 0}%</strong>
        `;
        item.addEventListener("click", () => openHistoryResult(r.session_id));
        list.appendChild(item);
      });
    }
  } catch (error) {
    renderError(list, error, () => showHistory());
  } finally {
    busy = false;
  }
}

async function openHistoryResult(sessionId) {
  if (busy || !sessionId) return;
  busy = true;
  try {
    const result = await loadFullResult(sessionId);
    renderResultDetail(result);
    resultOrigin = "history";
    showScreen("results");
  } catch (error) {
    renderError(document.getElementById("history-list"), error, () => openHistoryResult(sessionId));
  } finally {
    busy = false;
  }
}

document.querySelectorAll("[data-test]").forEach((button) => {
  button.addEventListener("click", () => startTest(button.dataset.test));
});

topbarButton.addEventListener("click", () => {
  if (topbarButton.dataset.mode !== "close") {
    showHistory();
    return;
  }
  // Результат, открытый из истории, закрывается обратно в историю — иначе
  // список прохождений теряется и приходится открывать его заново.
  if (!screens.results.hidden && resultOrigin === "history") {
    showHistory();
    return;
  }
  exitToStart();
});

// Клик по лого — домой: привычный веб-паттерн, работает с любого экрана.
// Черновик теста при этом не теряется, сессия остаётся возобновляемой.
document.getElementById("brand-home").addEventListener("click", exitToStart);

// ═══════════════════════════════════════════
// САМОВОССТАНОВЛЕНИЕ
// Вебвью, поднятый из кеша, приходит без initData, а связь может отвалиться на
// минуту. И то и другое чинится само: при возврате приложения на передний план
// перечитываем initData, при возврате сети — повторяем вход. Просить человека
// слать /start нужно только если и это не помогло.
// ═══════════════════════════════════════════

let recovering = false;

async function recoverIdentity({ force = false } = {}) {
  if (recovering) return;
  const gotFreshInitData = refreshInitData();
  if (!force && !gotFreshInitData && sessionToken) return;
  recovering = true;
  try {
    await initIdentity().then(refreshDrafts);
    // Пропала причина — убираем и сообщение о ней.
    if (sessionToken && !screens.start.hidden && statusNode.querySelector(".error-text")) {
      statusNode.textContent = "";
    }
  } finally {
    recovering = false;
  }
}

tg?.onEvent?.("activated", () => recoverIdentity());
document.addEventListener("visibilitychange", () => { if (!document.hidden) recoverIdentity(); });
window.addEventListener("online", () => recoverIdentity({ force: true }));

setTopbarMode("history");

if (new URLSearchParams(window.location.search).get("screen") === "results") {
  showHistory();
}

// Прокси для Mini App на Deno Deploy: *.vercel.app режется у части российских
// провайдеров (блок по IP), а *.deno.dev открывается. Фронт ходит сюда,
// прокси пересылает запрос в функцию на Vercel и отдаёт ответ как есть —
// CORS и продлённый токен в X-Session-Token приходят от самого API.
// Адрес API на Vercel — переменная окружения UPSTREAM в настройках Deno Deploy:
// при переезде API меняется только она, код прокси остаётся тем же.
const UPSTREAM = (Deno.env.get("UPSTREAM") ?? "").replace(/\/$/, "");

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Корень отвечает 200: по нему Deno Deploy проверяет, что выкладка жива.
  if (url.pathname === "/") return new Response("ok");
  // Только API Mini App; вебхук Telegram ходит в Vercel напрямую.
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/v1/telegram")) {
    return new Response("Not found", { status: 404 });
  }
  if (!UPSTREAM) return new Response("UPSTREAM is not set", { status: 500 });

  const headers = new Headers(req.headers);
  headers.delete("host");

  const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });

  // fetch уже распаковал тело: если оставить content-encoding, браузер
  // попробует распаковать его второй раз и уронит response.json().
  const out = new Headers(upstream.headers);
  out.delete("content-encoding");
  out.delete("content-length");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
});

// Ретранслятор на Deno Deploy между Telegram и ботом в Yandex Cloud.
//
// Российские дата-центры и Telegram друг до друга не достают: webhook от
// Telegram в Yandex Serverless Containers не доходит («Connection timed out»),
// и обратно до api.telegram.org из Яндекса не достучаться. Deno Deploy стоит
// за рубежом и видит обоих, поэтому трафик идёт через него:
//
//   Telegram → POST /api/v1/telegram/webhook → UPSTREAM (бот в Яндексе)
//   бот      → /tg/bot<token>/<method>        → api.telegram.org
//
// Mini App сюда не ходит: Яндекс из РФ открывается напрямую.
//
// Переменные окружения в Deno Deploy:
//   UPSTREAM — адрес контейнера в Яндексе, например https://xxx.containers.yandexcloud.net
//   BOT_ID   — числовой id бота (начало токена до двоеточия): ретранслятор
//              пропускает к Bot API только этого бота, а не всех желающих.
const UPSTREAM = (Deno.env.get("UPSTREAM") ?? "").replace(/\/$/, "");
const BOT_ID = (Deno.env.get("BOT_ID") ?? "").trim();
const TELEGRAM = "https://api.telegram.org";

async function relay(req: Request, target: string): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete("host");
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });
  // fetch уже распаковал тело: если оставить content-encoding, получатель
  // попробует распаковать его второй раз.
  const out = new Headers(upstream.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

Deno.serve((req) => {
  const url = new URL(req.url);
  // Корень отвечает 200: по нему Deno Deploy проверяет, что выкладка жива.
  if (url.pathname === "/") return new Response("ok");

  if (url.pathname.startsWith("/tg/")) {
    const rest = url.pathname.slice("/tg".length); // /bot<token>/<method>
    if (!BOT_ID || !rest.startsWith(`/bot${BOT_ID}:`)) {
      return new Response("Forbidden", { status: 403 });
    }
    return relay(req, TELEGRAM + rest + url.search);
  }

  if (url.pathname.startsWith("/api/")) {
    if (!UPSTREAM) return new Response("UPSTREAM is not set", { status: 500 });
    return relay(req, UPSTREAM + url.pathname + url.search);
  }

  return new Response("Not found", { status: 404 });
});

// Rasf events platform: Cloudflare Worker entry point.
// Static pages and files come from ./public (Workers Static Assets); this Worker only handles /api/*.
import { Body, Env, HttpError, ensureSchema, fail, json, pathId } from "./lib";
import * as auth from "./auth";
import * as api from "./api";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/** Blocks cross-site writes: JSON content type (forces a CORS preflight we never answer) + same Origin. */
function checkCsrf(req: Request, url: URL) {
  const ct = (req.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") fail(415, "bad_content_type", "طلب غير صالح.");
  const origin = req.headers.get("Origin");
  const referer = req.headers.get("Referer");
  const src = origin && origin !== "null" ? origin : referer;
  if (!src) return; // same-origin fetches from all modern browsers send Origin; absence means a non-browser client
  let host = "";
  try { host = new URL(src).host; } catch { /* invalid */ }
  if (host !== url.host) fail(403, "bad_origin", "طلب من مصدر غير مسموح.");
}

async function readBody(req: Request, maxBytes: number): Promise<Body> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const len = Number(req.headers.get("Content-Length") || "0");
  if (len > maxBytes) fail(413, "too_large", "حجم الطلب أكبر من المسموح.");
  const text = await req.text();
  if (text.length > maxBytes) fail(413, "too_large", "حجم الطلب أكبر من المسموح.");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Body;
  } catch {
    fail(400, "bad_json", "طلب غير صالح.");
  }
}

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const m = req.method;
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const write = m !== "GET" && m !== "HEAD";
  if (write) checkCsrf(req, url);
  if (!env.DB) fail(500, "config", "قاعدة البيانات غير مربوطة (DB). راجع دليل التشغيل.");
  await ensureSchema(env.DB);
  const big = parts[0] === "admin" && (parts[1] === "media" || parts[1] === "identity");
  const b = await readBody(req, big ? 2_200_000 : 32_000);
  const [p0, p1, p2] = parts;

  if (p0 === "media" && p1 && m === "GET") return api.serveMedia(env, pathId(p1));
  if (p0 === "state" && m === "GET") return api.publicState(req, env, url);
  if (p0 === "me" && m === "GET") return auth.whoami(req, env);
  if (p0 === "join" && m === "POST") return auth.join(req, env, b);
  if (p0 === "play" && m === "POST") {
    if (p1 === "record") return api.myRecord(req, env, b);
    if (p1 === "start") return api.startQuestion(req, env, b);
    if (p1 === "answer") return api.submitAnswer(req, env, b);
  }
  if (p0 === "messages" && m === "POST" && !p1) return api.sendMessage(req, env, b);
  if (p0 === "account" && m === "GET") return api.myAccount(req, env);
  if (p0 === "screens" && p1 && p2 === "heartbeat" && m === "POST") return api.heartbeat(env, p1);
  if (p0 === "setup") {
    if (m === "GET") return json(await auth.setupStatus(env));
    if (m === "POST") return auth.setup(req, env, b);
  }
  if (p0 === "auth" && m === "POST") {
    if (p1 === "login") return auth.login(req, env, b);
    if (p1 === "logout") return auth.logout(req, env);
    if (p1 === "password") return auth.changePassword(req, env, b);
  }
  if (p0 === "admin") {
    if (!p1 && m === "GET") return api.adminData(req, env);
    if (p1 === "staff") {
      if (!p2 && m === "GET") return auth.listStaff(req, env);
      if (!p2 && m === "POST") return auth.addManager(req, env, b);
      if (p2 && m === "DELETE") return auth.removeManager(req, env, pathId(p2));
      if (p2 && parts[3] === "reset" && m === "POST") return auth.resetManager(req, env, pathId(p2), b);
    }
    return api.adminRoute(req, env, parts.slice(1), b);
  }
  fail(404, "not_found", "المسار غير موجود.");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req); // not normally reached (assets are served first)
    try {
      return withHeaders(await handleApi(req, env, url));
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(json({ error: e.code, message: e.message }, e.status));
      console.error("API error", e);
      return withHeaders(json({ error: "server_error", message: "حدث خطأ في الخادم، حاول مرة أخرى." }, 500));
    }
  },
} satisfies ExportedHandler<Env>;

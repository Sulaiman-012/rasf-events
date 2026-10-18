// Staff accounts (owner / manager), sessions, and employee participant tokens.
import {
  Body, EMAIL_RE, Env, fail, hashPassword, hmac, json, limit, now, randomToken, safeEqual, setCookie, sha256, str,
  cookie, clientIp, throttleCount, throttleHit, PBKDF2_ITERATIONS, pwIterations,
} from "./lib";

export const STAFF_COOKIE = "rasf_s";
export const PARTICIPANT_COOKIE = "rasf_p";
const SESSION_MS = 12 * 60 * 60 * 1000;
const PARTICIPANT_MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookies at ~400 days

export type Role = "owner" | "manager";
export interface Staff { id: number; email: string; name: string; role: Role; must_change: number }
export interface Participant { id: number; name: string; via_screen: number }

function secret(env: Env): string {
  const s = env.SESSION_SECRET || "";
  if (s.length < 16) fail(500, "config", "لم يُضبط المفتاح السري SESSION_SECRET (١٦ حرفًا على الأقل). راجع دليل التشغيل.");
  return s;
}

function password(b: Body, key = "password"): string {
  const v = b[key];
  if (typeof v !== "string" || v.length < 8) fail(400, "invalid", "كلمة المرور يجب أن تكون ٨ أحرف على الأقل.");
  if (v.length > 128) fail(400, "invalid", "كلمة المرور طويلة جدًا.");
  return v;
}

export function email(b: Body): string {
  const e = str(b, "email", 3, 254, "البريد الإلكتروني").toLowerCase();
  if (!EMAIL_RE.test(e)) fail(400, "invalid", "اكتب بريدًا إلكترونيًا صحيحًا.");
  return e;
}

// ---------- staff sessions ----------
export async function currentStaff(req: Request, env: Env): Promise<Staff | null> {
  const raw = cookie(req, STAFF_COOKIE);
  if (!raw || !env.SESSION_SECRET) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const sid = raw.slice(0, dot), sig = raw.slice(dot + 1);
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, "s:" + sid))) return null;
  const row = await env.DB.prepare(
    `SELECT st.id, st.email, st.name, st.role, st.must_change FROM sessions s JOIN staff st ON st.id = s.staff_id
     WHERE s.id = ? AND s.expires_at > ?`,
  ).bind(await sha256(sid), now()).first<Staff>();
  return row ?? null;
}

async function startSession(env: Env, staffId: number): Promise<string> {
  const sid = randomToken(32);
  await env.DB.prepare("INSERT INTO sessions (id, staff_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(sid), staffId, now() + SESSION_MS, now()).run();
  if (Math.random() < 0.1) await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now()).run();
  return setCookie(STAFF_COOKIE, `${sid}.${await hmac(secret(env), "s:" + sid)}`, SESSION_MS / 1000);
}

export async function requireStaff(req: Request, env: Env, opts: { owner?: boolean; allowMustChange?: boolean } = {}): Promise<Staff> {
  const s = await currentStaff(req, env);
  if (!s) fail(401, "unauthenticated", "انتهت الجلسة، سجّل الدخول من جديد.");
  if (s.must_change && !opts.allowMustChange) fail(403, "must_change_password", "غيّر كلمة المرور المؤقتة أولًا.");
  if (opts.owner && s.role !== "owner") fail(403, "forbidden", "هذا الإجراء لمالك المنصة فقط.");
  return s;
}

const staffView = (s: Staff) => ({ id: s.id, name: s.name, email: s.email, role: s.role, mustChange: !!s.must_change });

export async function setupStatus(env: Env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff").first<{ n: number }>();
  return { needsSetup: (r?.n ?? 0) === 0, setupKeyConfigured: !!env.SETUP_KEY, secretConfigured: (env.SESSION_SECRET || "").length >= 16 };
}

export async function setup(req: Request, env: Env, b: Body): Promise<Response> {
  await limit(env.DB, "setup:" + clientIp(req), 10, 15 * 60_000, "محاولات كثيرة، انتظر ربع ساعة ثم حاول.");
  if (!env.SETUP_KEY) fail(500, "config", "لم يُضبط مفتاح الإعداد SETUP_KEY في إعدادات Cloudflare.");
  secret(env);
  const status = await setupStatus(env);
  if (!status.needsSetup) fail(409, "already_setup", "تم إعداد المنصة مسبقًا. ادخل من صفحة الإدارة.");
  const key = typeof b.setupKey === "string" ? b.setupKey : "";
  if (!safeEqual(key, env.SETUP_KEY)) fail(403, "bad_setup_key", "مفتاح الإعداد غير صحيح.");
  const name = str(b, "name", 2, 60, "الاسم");
  const mail = email(b);
  const pw = await hashPassword(password(b), undefined, pwIterations(env));
  // INSERT ... SELECT WHERE NOT EXISTS keeps this safe even if two setups race.
  const r = await env.DB.prepare(
    `INSERT INTO staff (email, name, role, pw_hash, pw_salt, pw_iter, must_change, created_at)
     SELECT ?, ?, 'owner', ?, ?, ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM staff)`,
  ).bind(mail, name, pw.hash, pw.salt, pw.iterations, now()).run();
  if (!r.meta.changes) fail(409, "already_setup", "تم إعداد المنصة مسبقًا.");
  const staff = await env.DB.prepare("SELECT id, email, name, role, must_change FROM staff WHERE email = ?").bind(mail).first<Staff>();
  return json({ ok: true, staff: staffView(staff!) }, 200, { "Set-Cookie": await startSession(env, staff!.id) });
}

export async function login(req: Request, env: Env, b: Body): Promise<Response> {
  secret(env);
  const mail = typeof b.email === "string" ? b.email.trim().toLowerCase().slice(0, 254) : "";
  const pass = typeof b.password === "string" ? b.password.slice(0, 128) : "";
  if (!mail || !pass) fail(400, "invalid", "اكتب البريد وكلمة المرور.");
  const k = `login:${mail}|${clientIp(req)}`;
  if ((await throttleCount(env.DB, k, 15 * 60_000)) >= 5) fail(429, "rate_limited", "محاولات دخول كثيرة. انتظر ١٥ دقيقة ثم حاول مرة أخرى.");
  const row = await env.DB.prepare("SELECT id, email, name, role, must_change, pw_hash, pw_salt, pw_iter FROM staff WHERE email = ?")
    .bind(mail).first<Staff & { pw_hash: string; pw_salt: string; pw_iter: number }>();
  // Hash even when the user does not exist so timing does not reveal registered emails.
  const check = await hashPassword(pass, row?.pw_salt || "no-user-salt", row?.pw_iter || PBKDF2_ITERATIONS);
  if (!row || !safeEqual(check.hash, row.pw_hash)) {
    await throttleHit(env.DB, k);
    fail(401, "bad_credentials", "البريد أو كلمة المرور غير صحيحة.");
  }
  await env.DB.prepare("DELETE FROM throttle WHERE k = ?").bind(k).run();
  return json({ ok: true, staff: staffView(row) }, 200, { "Set-Cookie": await startSession(env, row.id) });
}

export async function logout(req: Request, env: Env): Promise<Response> {
  const raw = cookie(req, STAFF_COOKIE);
  if (raw && raw.lastIndexOf(".") > 0) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(raw.slice(0, raw.lastIndexOf(".")))).run();
  }
  return json({ ok: true }, 200, { "Set-Cookie": setCookie(STAFF_COOKIE, "", 0) });
}

export async function changePassword(req: Request, env: Env, b: Body): Promise<Response> {
  const s = await requireStaff(req, env, { allowMustChange: true });
  await limit(env.DB, "pw:" + s.id, 10, 15 * 60_000, "محاولات كثيرة، انتظر قليلًا.");
  const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM staff WHERE id = ?").bind(s.id).first<{ pw_hash: string; pw_salt: string; pw_iter: number }>();
  const cur = await hashPassword(typeof b.current === "string" ? b.current.slice(0, 128) : "", row!.pw_salt, row!.pw_iter);
  if (!safeEqual(cur.hash, row!.pw_hash)) fail(403, "bad_credentials", "كلمة المرور الحالية غير صحيحة.");
  const next = password(b, "next");
  if (next === b.current) fail(400, "invalid", "اختر كلمة مرور جديدة مختلفة.");
  const pw = await hashPassword(next, undefined, pwIterations(env));
  await env.DB.batch([
    env.DB.prepare("UPDATE staff SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 0 WHERE id = ?").bind(pw.hash, pw.salt, pw.iterations, s.id),
    env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(s.id),
  ]);
  return json({ ok: true }, 200, { "Set-Cookie": await startSession(env, s.id) });
}

// ---------- staff management (owner only) ----------
export async function listStaff(req: Request, env: Env): Promise<Response> {
  await requireStaff(req, env, { owner: true });
  const { results } = await env.DB.prepare("SELECT id, email, name, role, must_change, created_at FROM staff ORDER BY role DESC, created_at").all();
  return json({ staff: results });
}

export async function addManager(req: Request, env: Env, b: Body): Promise<Response> {
  await requireStaff(req, env, { owner: true });
  const name = str(b, "name", 2, 60, "الاسم");
  const mail = email(b);
  const pw = await hashPassword(password(b), undefined, pwIterations(env));
  const exists = await env.DB.prepare("SELECT 1 FROM staff WHERE email = ?").bind(mail).first();
  if (exists) fail(409, "exists", "هذا البريد مسجّل مسبقًا.");
  await env.DB.prepare(
    "INSERT INTO staff (email, name, role, pw_hash, pw_salt, pw_iter, must_change, created_at) VALUES (?, ?, 'manager', ?, ?, ?, 1, ?)",
  ).bind(mail, name, pw.hash, pw.salt, pw.iterations, now()).run();
  return json({ ok: true });
}

export async function removeManager(req: Request, env: Env, id: number): Promise<Response> {
  await requireStaff(req, env, { owner: true });
  const r = await env.DB.prepare("DELETE FROM staff WHERE id = ? AND role = 'manager'").bind(id).run();
  if (!r.meta.changes) fail(404, "not_found", "الحساب غير موجود أو لا يمكن حذفه.");
  return json({ ok: true });
}

export async function resetManager(req: Request, env: Env, id: number, b: Body): Promise<Response> {
  await requireStaff(req, env, { owner: true });
  const pw = await hashPassword(password(b), undefined, pwIterations(env));
  const r = await env.DB.prepare("UPDATE staff SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change = 1 WHERE id = ? AND role = 'manager'")
    .bind(pw.hash, pw.salt, pw.iterations, id).run();
  if (!r.meta.changes) fail(404, "not_found", "الحساب غير موجود.");
  await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?").bind(id).run();
  return json({ ok: true });
}

// ---------- employees (no account: random token in an HttpOnly cookie) ----------
export async function currentParticipant(req: Request, env: Env): Promise<Participant | null> {
  const tok = cookie(req, PARTICIPANT_COOKIE);
  if (!tok || tok.length < 20 || tok.length > 100) return null;
  return (await env.DB.prepare("SELECT id, name, via_screen FROM participants WHERE token_hash = ?").bind(await sha256(tok)).first<Participant>()) ?? null;
}

export function participantName(b: Body, key = "name"): string {
  const n = str(b, key, 2, 60, "الاسم").replace(/\n/g, " ");
  if (/[<>]/.test(n)) fail(400, "invalid", "الاسم يحتوي رموزًا غير مسموحة.");
  return n;
}

export async function join(req: Request, env: Env, b: Body): Promise<Response> {
  const name = participantName(b);
  const existing = await currentParticipant(req, env);
  if (existing) {
    await env.DB.batch([
      env.DB.prepare("UPDATE participants SET name = ? WHERE id = ?").bind(name, existing.id),
      env.DB.prepare("UPDATE app_state SET version = version + 1 WHERE id = 1"),
    ]);
    return json({ ok: true, participant: { id: existing.id, name } });
  }
  // Generous: a whole office may share one public IP.
  await limit(env.DB, "join:" + clientIp(req), 400, 60 * 60_000, "طلبات كثيرة من هذه الشبكة، حاول بعد قليل.");
  const tok = randomToken(32);
  const r = await env.DB.prepare("INSERT INTO participants (token_hash, name, via_screen, created_at) VALUES (?, ?, 0, ?)")
    .bind(await sha256(tok), name, now()).run();
  return json({ ok: true, participant: { id: r.meta.last_row_id, name } }, 200, {
    "Set-Cookie": setCookie(PARTICIPANT_COOKIE, tok, PARTICIPANT_MAX_AGE),
  });
}

export async function whoami(req: Request, env: Env): Promise<Response> {
  const [staff, participant, setupInfo] = await Promise.all([currentStaff(req, env), currentParticipant(req, env), setupStatus(env)]);
  return json({ staff: staff ? staffView(staff) : null, participant, needsSetup: setupInfo.needsSetup });
}

// Competition, screens, media, messages, analytics: the JSON API used by the pages.
import {
  Body, COLOR_RE, Env, bump, fail, int, json, limit, now, optId, optStr, optTime, screenKey, str,
} from "./lib";
import { Participant, Staff, currentParticipant, participantName, requireStaff } from "./auth";

const TEXT_TYPES = new Set(["short", "essay"]);
const Q_TYPES = new Set(["choice", "truefalse", "short", "essay"]);
const POINTS = 100;
const GRACE_MS = 4000; // network slack on top of the question duration
export const MAX_MEDIA_BYTES = 1_500_000;
const CHUNK = 700_000; // base64 chars per D1 row

interface StateRow {
  version: number; active_competition_id: number | null; active_question_id: number | null; featured_message_id: number | null;
  primary_color: string; accent_color: string; background_color: string; logo_media_id: number | null;
}
interface QuestionRow {
  id: number; competition_id: number; text: string; type: string; options: string; correct: number | null;
  attempts: number; duration: number; ord: number; answered_count: number; created_at: number;
}
interface CompRow { id: number; name: string; start_at: number | null; end_at: number | null; created_at: number }
interface AnswerRow { tries: string; n_tries: number; correct: number | null; started_at: number | null; at: number | null }

const mediaUrl = (id: number | null) => (id ? `/api/media/${id}` : null);

async function getState(env: Env): Promise<StateRow> {
  return (await env.DB.prepare("SELECT * FROM app_state WHERE id = 1").first<StateRow>())!;
}

function windowOf(c: CompRow | null, t = now()): "none" | "before" | "after" | "open" {
  if (!c) return "none";
  if (c.start_at && t < c.start_at) return "before";
  if (c.end_at && t > c.end_at) return "after";
  return "open";
}

const publicQuestion = (q: QuestionRow) => ({
  id: q.id, text: q.text, type: q.type, options: JSON.parse(q.options) as string[], attempts: q.attempts, duration: q.duration,
});

// ======================================================================
// Public state (polled by phones and screens). ETag = state version.
// ======================================================================
export async function publicState(req: Request, env: Env, url: URL): Promise<Response> {
  const key = url.searchParams.get("screen");
  const head = await env.DB.prepare("SELECT version FROM app_state WHERE id = 1").first<{ version: number }>();
  const etag = `"v${head!.version}${key ? "-" + key.slice(0, 40) : ""}"`;
  const cacheHeaders = { ETag: etag, "Cache-Control": "no-cache" };
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: cacheHeaders });

  const st = await getState(env);
  const comp = st.active_competition_id
    ? await env.DB.prepare("SELECT * FROM competitions WHERE id = ?").bind(st.active_competition_id).first<CompRow>()
    : null;
  let question = null as null | (ReturnType<typeof publicQuestion> & { index: number; total: number });
  let leaderboard: unknown[] = [];
  let participantCount = 0;
  if (comp) {
    const qs = await env.DB.prepare("SELECT id FROM questions WHERE competition_id = ? ORDER BY ord, id").bind(comp.id).all<{ id: number }>();
    if (st.active_question_id) {
      const q = await env.DB.prepare("SELECT * FROM questions WHERE id = ? AND competition_id = ?").bind(st.active_question_id, comp.id).first<QuestionRow>();
      if (q) question = { ...publicQuestion(q), index: qs.results.findIndex((x) => x.id === q.id) + 1, total: qs.results.length };
    }
    const [lb, cnt] = await env.DB.batch([
      env.DB.prepare(
        `SELECT s.participant_id AS id, p.name, p.via_screen AS kiosk, s.points FROM scores s JOIN participants p ON p.id = s.participant_id
         WHERE s.competition_id = ? AND s.points > 0 ORDER BY s.points DESC, s.last_correct_at ASC LIMIT 50`,
      ).bind(comp.id),
      env.DB.prepare("SELECT COUNT(*) AS n FROM scores WHERE competition_id = ?").bind(comp.id),
    ]);
    leaderboard = lb.results;
    participantCount = (cnt.results[0] as { n: number }).n;
  }
  const featured = st.featured_message_id
    ? await env.DB.prepare("SELECT id, text FROM messages WHERE id = ?").bind(st.featured_message_id).first<{ id: number; text: string }>()
    : null;
  let screen: unknown = undefined;
  if (key) {
    const s = await env.DB.prepare(
      `SELECT s.id, s.name, s.content_media_id AS mediaId, m.name AS mediaName FROM screens s LEFT JOIN media m ON m.id = s.content_media_id WHERE s.key = ?`,
    ).bind(key).first<{ id: number; name: string; mediaId: number | null; mediaName: string | null }>();
    screen = s ? { name: s.name, media: s.mediaId ? { id: s.mediaId, name: s.mediaName, url: mediaUrl(s.mediaId) } : null } : null;
  }
  return json({
    version: st.version,
    serverNow: now(),
    identity: { primary: st.primary_color, accent: st.accent_color, background: st.background_color, logoUrl: mediaUrl(st.logo_media_id) },
    competition: comp ? { id: comp.id, name: comp.name, start: comp.start_at, end: comp.end_at } : null,
    question,
    featured: featured ? { id: featured.id, text: featured.text } : null,
    participantCount,
    leaderboard,
    screen,
  }, 200, cacheHeaders);
}

// ======================================================================
// Playing: start the timer, submit an answer (graded here, never on the client).
// ======================================================================
async function kioskParticipant(env: Env, b: Body, create: boolean): Promise<Participant> {
  const key = typeof b.screenKey === "string" ? b.screenKey.slice(0, 40) : "";
  const screen = key ? await env.DB.prepare("SELECT id FROM screens WHERE key = ?").bind(key).first<{ id: number }>() : null;
  if (!screen) fail(404, "screen_not_found", "رابط الشاشة غير صحيح. انسخه من لوحة الإدارة.");
  const name = participantName(b, "name");
  let p = await env.DB.prepare("SELECT id, name, via_screen FROM participants WHERE via_screen = 1 AND screen_id = ? AND name = ?").bind(screen.id, name).first<Participant>();
  if (!p && create) {
    await env.DB.prepare("INSERT OR IGNORE INTO participants (token_hash, name, via_screen, screen_id, created_at) VALUES (NULL, ?, 1, ?, ?)").bind(name, screen.id, now()).run();
    p = await env.DB.prepare("SELECT id, name, via_screen FROM participants WHERE via_screen = 1 AND screen_id = ? AND name = ?").bind(screen.id, name).first<Participant>();
  }
  if (!p) fail(404, "not_found", "لا يوجد سجل لهذا الاسم.");
  return p;
}

async function player(req: Request, env: Env, b: Body, create: boolean): Promise<Participant> {
  if (b.screenKey) return kioskParticipant(env, b, create);
  const p = await currentParticipant(req, env);
  if (!p) fail(401, "no_participant", "اكتب اسمك أولًا للمشاركة.");
  return p;
}

async function activeQuestion(env: Env, questionId: number) {
  const st = await getState(env);
  if (!st.active_question_id || st.active_question_id !== questionId) fail(409, "question_closed", "هذا السؤال لم يعد معروضًا.");
  const q = await env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(questionId).first<QuestionRow>();
  const comp = q ? await env.DB.prepare("SELECT * FROM competitions WHERE id = ?").bind(q.competition_id).first<CompRow>() : null;
  if (!q || !comp || comp.id !== st.active_competition_id) fail(409, "question_closed", "هذا السؤال لم يعد معروضًا.");
  const w = windowOf(comp);
  if (w !== "open") fail(409, "closed", w === "before" ? "المسابقة لم تبدأ بعد." : "المسابقة مغلقة الآن.");
  return { q, comp };
}

function isDone(q: QuestionRow, a: AnswerRow | null): boolean {
  if (!a) return false;
  return a.correct === 1 || (TEXT_TYPES.has(q.type) && a.n_tries > 0) || a.n_tries >= q.attempts;
}

function recordView(q: QuestionRow, a: AnswerRow | null) {
  const done = isDone(q, a);
  return {
    questionId: q.id,
    tries: a ? (JSON.parse(a.tries) as unknown[]) : [],
    triesLeft: Math.max(0, q.attempts - (a?.n_tries ?? 0)),
    correct: a ? (a.correct === null ? null : a.correct === 1) : null,
    done,
    // The right answer is only revealed once the player is finished with the question.
    correctIndex: done && !TEXT_TYPES.has(q.type) ? q.correct : undefined,
  };
}

/** GET-like (POST so kiosk names stay out of URLs/logs): the caller's record for a question. */
export async function myRecord(req: Request, env: Env, b: Body): Promise<Response> {
  const qid = int(b, "questionId", 1, Number.MAX_SAFE_INTEGER, "السؤال");
  const q = await env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(qid).first<QuestionRow>();
  if (!q) fail(404, "not_found", "السؤال غير موجود.");
  let p: Participant | null;
  if (b.screenKey) {
    try { p = await kioskParticipant(env, b, false); } catch { p = null; }
  } else p = await currentParticipant(req, env);
  const a = p ? await env.DB.prepare("SELECT * FROM answers WHERE participant_id = ? AND question_id = ?").bind(p.id, qid).first<AnswerRow>() : null;
  return json({ record: recordView(q, a) });
}

export async function startQuestion(req: Request, env: Env, b: Body): Promise<Response> {
  const qid = int(b, "questionId", 1, Number.MAX_SAFE_INTEGER, "السؤال");
  const { q, comp } = await activeQuestion(env, qid);
  const p = await player(req, env, b, true);
  const a = await env.DB.prepare("SELECT * FROM answers WHERE participant_id = ? AND question_id = ?").bind(p.id, qid).first<AnswerRow>();
  if (isDone(q, a)) return json({ record: recordView(q, a), participant: { id: p.id, name: p.name } });
  await env.DB.prepare(
    `INSERT INTO answers (participant_id, question_id, competition_id, tries, n_tries, correct, started_at, at) VALUES (?, ?, ?, '[]', 0, NULL, ?, NULL)
     ON CONFLICT (participant_id, question_id) DO UPDATE SET started_at = excluded.started_at`,
  ).bind(p.id, qid, comp.id, now()).run();
  const fresh = await env.DB.prepare("SELECT * FROM answers WHERE participant_id = ? AND question_id = ?").bind(p.id, qid).first<AnswerRow>();
  return json({ record: recordView(q, fresh), participant: { id: p.id, name: p.name } });
}

export async function submitAnswer(req: Request, env: Env, b: Body): Promise<Response> {
  const qid = int(b, "questionId", 1, Number.MAX_SAFE_INTEGER, "السؤال");
  const { q, comp } = await activeQuestion(env, qid);
  const p = await player(req, env, b, false);
  const a = await env.DB.prepare("SELECT * FROM answers WHERE participant_id = ? AND question_id = ?").bind(p.id, qid).first<AnswerRow>();
  if (!a || !a.started_at) fail(409, "not_started", "اضغط «بدء المشاركة» أولًا.");
  if (isDone(q, a)) return json({ record: recordView(q, a) });
  if (now() > a.started_at + q.duration * 1000 + GRACE_MS) fail(409, "time_up", "انتهى الوقت.");

  const tries = JSON.parse(a.tries) as unknown[];
  let value: number | string;
  let correct: number | null;
  if (TEXT_TYPES.has(q.type)) {
    value = str(b, "value", 1, q.type === "essay" ? 1000 : 200, "الإجابة");
    correct = null;
  } else {
    const n = q.type === "truefalse" ? 2 : (JSON.parse(q.options) as string[]).length;
    value = int(b, "value", 0, n - 1, "الخيار");
    if (tries.includes(value)) fail(409, "duplicate", "جرّبت هذا الخيار من قبل.");
    correct = value === q.correct ? 1 : 0;
  }
  const t = now();
  const first = a.n_tries === 0;
  // Optimistic concurrency: only applies if n_tries did not change since we read it.
  const upd = await env.DB.prepare(
    "UPDATE answers SET tries = ?, n_tries = n_tries + 1, correct = ?, at = ? WHERE participant_id = ? AND question_id = ? AND n_tries = ?",
  ).bind(JSON.stringify([...tries, value]), correct, t, p.id, qid, a.n_tries).run();
  if (!upd.meta.changes) fail(409, "conflict", "تم استلام إجابة أخرى للتو، حدّث الصفحة.");
  const isRight = correct === 1;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scores (participant_id, competition_id, points, correct_count, answered, last_correct_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (participant_id, competition_id) DO UPDATE SET points = points + excluded.points, correct_count = correct_count + excluded.correct_count,
       answered = answered + excluded.answered, last_correct_at = COALESCE(excluded.last_correct_at, last_correct_at)`,
    ).bind(p.id, comp.id, isRight ? POINTS : 0, isRight ? 1 : 0, first ? 1 : 0, isRight ? t : null),
    env.DB.prepare("UPDATE questions SET answered_count = answered_count + ? WHERE id = ?").bind(first ? 1 : 0, qid),
    bump(env.DB),
  ]);
  const after = await env.DB.prepare("SELECT * FROM answers WHERE participant_id = ? AND question_id = ?").bind(p.id, qid).first<AnswerRow>();
  return json({ record: recordView(q, after) });
}

// ======================================================================
// Employee: messages & "my account"
// ======================================================================
export async function sendMessage(req: Request, env: Env, b: Body): Promise<Response> {
  const p = await currentParticipant(req, env);
  if (!p) fail(401, "no_participant", "اكتب اسمك أولًا من خانة المشاركة، ثم أرسل رسالتك.");
  const text = str(b, "text", 2, 180, "الرسالة");
  await limit(env.DB, "msg:" + p.id, 5, 10 * 60_000, "أرسلت رسائل كثيرة، انتظر قليلًا ثم حاول.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (participant_id, text, status, created_at) VALUES (?, ?, 'pending', ?)").bind(p.id, text, now()),
    bump(env.DB),
  ]);
  return json({ ok: true });
}

export async function myAccount(req: Request, env: Env): Promise<Response> {
  const p = await currentParticipant(req, env);
  if (!p) return json({ participant: null });
  const st = await getState(env);
  const [scores, answers, msgs] = await env.DB.batch([
    env.DB.prepare(
      `SELECT s.competition_id AS id, c.name, s.points, s.correct_count AS correctCount, s.answered, s.last_correct_at AS lastCorrect, c.created_at AS createdAt,
        (SELECT COUNT(*) FROM scores o WHERE o.competition_id = s.competition_id AND o.points > 0 AND (o.points > s.points OR (o.points = s.points AND o.last_correct_at < s.last_correct_at))) + 1 AS rank,
        (SELECT COUNT(*) FROM scores o WHERE o.competition_id = s.competition_id AND o.points > 0) AS ranked
       FROM scores s JOIN competitions c ON c.id = s.competition_id WHERE s.participant_id = ? ORDER BY c.created_at DESC`,
    ).bind(p.id),
    env.DB.prepare(
      `SELECT a.question_id AS qid, a.competition_id AS cid, a.n_tries AS nTries, a.correct, a.at, q.text, q.type, q.attempts
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.participant_id = ? AND a.n_tries > 0 ORDER BY a.at`,
    ).bind(p.id),
    env.DB.prepare("SELECT id, text, status, created_at AS at FROM messages WHERE participant_id = ? ORDER BY id DESC LIMIT 30").bind(p.id),
  ]);
  return json({
    participant: { id: p.id, name: p.name },
    activeCompetitionId: st.active_competition_id,
    featuredId: st.featured_message_id,
    competitions: scores.results,
    answers: answers.results,
    messages: msgs.results,
  });
}

// ======================================================================
// Screens: heartbeat & media
// ======================================================================
export async function heartbeat(env: Env, key: string): Promise<Response> {
  const r = await env.DB.prepare("UPDATE screens SET last_seen = ? WHERE key = ?").bind(now(), key.slice(0, 40)).run();
  if (!r.meta.changes) fail(404, "screen_not_found", "الشاشة غير موجودة.");
  return json({ ok: true });
}

export async function serveMedia(env: Env, id: number): Promise<Response> {
  const m = await env.DB.prepare("SELECT mime FROM media WHERE id = ?").bind(id).first<{ mime: string }>();
  if (!m) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const { results } = await env.DB.prepare("SELECT data FROM media_chunks WHERE media_id = ? ORDER BY idx").bind(id).all<{ data: string }>();
  const bin = atob(results.map((r) => r.data).join(""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      "Content-Type": m.mime,
      // Media rows are immutable (a new upload gets a new id), so browsers and the LG screens can cache forever.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}

const MIME_OK = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const LOGO_MIME_OK = new Set(["image/jpeg", "image/png", "image/webp"]);

function decodeUpload(b: Body, allowed: Set<string>): { mime: string; data: string; size: number } {
  const mime = typeof b.mime === "string" ? b.mime : "";
  if (!allowed.has(mime)) fail(415, "unsupported_type", "نوع الملف غير مدعوم. استخدم صورة JPG أو PNG أو WebP.");
  const data = typeof b.data === "string" ? b.data : "";
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail(400, "invalid", "ملف الصورة غير صالح.");
  const size = Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  if (size > MAX_MEDIA_BYTES) fail(413, "too_large", "الصورة أكبر من ١٫٥ ميجابايت حتى بعد الضغط. جرّب صورة أصغر.");
  // Magic-byte check so the stored file really is the declared image type.
  const head = atob(data.slice(0, 16));
  const sig = [...head].map((c) => c.charCodeAt(0));
  const is = (arr: number[]) => arr.every((v, i) => sig[i] === v);
  const ok = mime === "image/png" ? is([0x89, 0x50, 0x4e, 0x47])
    : mime === "image/jpeg" ? is([0xff, 0xd8, 0xff])
    : mime === "image/gif" ? is([0x47, 0x49, 0x46, 0x38])
    : is([0x52, 0x49, 0x46, 0x46]) && head.slice(8, 12) === "WEBP";
  if (!ok) fail(400, "invalid", "محتوى الملف لا يطابق نوع الصورة.");
  return { mime, data, size };
}

async function storeMedia(env: Env, name: string, kind: "image" | "logo", up: { mime: string; data: string; size: number }): Promise<number> {
  const r = await env.DB.prepare("INSERT INTO media (name, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?)").bind(name, kind, up.mime, up.size, now()).run();
  const id = r.meta.last_row_id as number;
  const stmts = [];
  for (let i = 0, k = 0; i < up.data.length; i += CHUNK, k++) {
    stmts.push(env.DB.prepare("INSERT INTO media_chunks (media_id, idx, data) VALUES (?, ?, ?)").bind(id, k, up.data.slice(i, i + CHUNK)));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
    throw e;
  }
  return id;
}

// ======================================================================
// Admin (owner + manager)
// ======================================================================
export async function adminData(req: Request, env: Env): Promise<Response> {
  const me = await requireStaff(req, env);
  const head = await env.DB.prepare("SELECT version, (SELECT MAX(last_seen) FROM screens) AS seen FROM app_state WHERE id = 1").first<{ version: number; seen: number | null }>();
  // Online/offline labels age with time, so the ETag also changes every minute.
  const etag = `"a${head!.version}-${head!.seen ?? 0}-${Math.floor(now() / 60_000)}-${me.id}"`;
  if (req.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache, private" } });
  const st = await getState(env);
  const [comps, qs, groups, screens, events, media, pending, featured] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, start_at AS start, end_at AS end, created_at AS createdAt FROM competitions ORDER BY created_at"),
    env.DB.prepare("SELECT id, competition_id AS competitionId, text, type, options, correct, attempts, duration, ord, answered_count AS answered FROM questions ORDER BY competition_id, ord, id"),
    env.DB.prepare("SELECT id, name, created_at AS createdAt FROM screen_groups ORDER BY created_at"),
    env.DB.prepare("SELECT id, key, name, group_id AS groupId, content_media_id AS mediaId, last_seen AS lastSeen, created_at AS createdAt FROM screens ORDER BY created_at"),
    env.DB.prepare("SELECT id, name, date, competition_id AS competitionId, media_id AS mediaId, group_id AS groupId, created_at AS createdAt FROM events ORDER BY COALESCE(date, created_at)"),
    env.DB.prepare("SELECT id, name, size, created_at AS createdAt FROM media WHERE kind = 'image' ORDER BY created_at DESC"),
    env.DB.prepare(
      `SELECT m.id, m.text, m.created_at AS at, p.name FROM messages m JOIN participants p ON p.id = m.participant_id
       WHERE m.status = 'pending' ORDER BY m.created_at DESC LIMIT 50`,
    ),
    env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'"),
  ]);
  const featuredMsg = st.featured_message_id
    ? await env.DB.prepare("SELECT id, text FROM messages WHERE id = ?").bind(st.featured_message_id).first()
    : null;
  return json({
    me: { id: me.id, name: me.name, email: me.email, role: me.role },
    serverNow: now(),
    state: { activeCompetitionId: st.active_competition_id, activeQuestionId: st.active_question_id, featured: featuredMsg },
    identity: { primary: st.primary_color, accent: st.accent_color, background: st.background_color, logoUrl: mediaUrl(st.logo_media_id) },
    competitions: comps.results,
    questions: (qs.results as Array<Record<string, unknown>>).map((q) => ({ ...q, options: JSON.parse(q.options as string) })),
    groups: groups.results,
    screens: screens.results,
    events: events.results,
    media: (media.results as Array<{ id: number }>).map((m) => ({ ...m, url: mediaUrl(m.id) })),
    pendingMessages: pending.results,
    pendingCount: (featured.results[0] as { n: number }).n,
  }, 200, { ETag: etag, "Cache-Control": "no-cache, private" });
}

async function exists(env: Env, table: "competitions" | "questions" | "screen_groups" | "screens" | "events" | "media" | "messages", id: number | null, label: string) {
  if (id === null) return;
  const row = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) fail(400, "invalid", `${label} غير موجود.`);
}

async function imageExists(env: Env, id: number | null) {
  if (id === null) return;
  const row = await env.DB.prepare("SELECT 1 FROM media WHERE id = ? AND kind = 'image'").bind(id).first();
  if (!row) fail(400, "invalid", "الصورة غير موجودة.");
}

function compBody(b: Body) {
  const name = str(b, "name", 1, 80, "اسم المسابقة");
  const start = optTime(b, "start"), end = optTime(b, "end");
  if (start && end && end <= start) fail(400, "invalid", "النهاية يجب أن تكون بعد البداية.");
  return { name, start, end };
}

/** Sets the live state (active competition / question / featured message). */
async function setState(env: Env, patch: { comp?: number | null; question?: number | null; featured?: number | null }) {
  const st = await getState(env);
  let comp = patch.comp !== undefined ? patch.comp : st.active_competition_id;
  let question = patch.question !== undefined ? patch.question : st.active_question_id;
  const featured = patch.featured !== undefined ? patch.featured : st.featured_message_id;
  if (patch.comp !== undefined && patch.comp !== st.active_competition_id && patch.question === undefined) question = null;
  if (question !== null) {
    const q = await env.DB.prepare("SELECT competition_id FROM questions WHERE id = ?").bind(question).first<{ competition_id: number }>();
    if (!q) fail(400, "invalid", "السؤال غير موجود.");
    if (patch.comp === undefined) comp = q.competition_id;
    if (q.competition_id !== comp) fail(400, "invalid", "السؤال لا يتبع المسابقة النشطة.");
  }
  await exists(env, "competitions", comp, "المسابقة");
  await env.DB.prepare(
    "UPDATE app_state SET active_competition_id = ?, active_question_id = ?, featured_message_id = ?, version = version + 1 WHERE id = 1",
  ).bind(comp, question, featured).run();
}

export async function adminRoute(req: Request, env: Env, parts: string[], b: Body): Promise<Response> {
  const me: Staff = await requireStaff(req, env);
  const m = req.method;
  const [res, idRaw, action] = parts;
  const id = idRaw !== undefined ? Number(idRaw) : null;
  if (idRaw !== undefined && (!/^\d{1,15}$/.test(idRaw) || !id)) fail(404, "not_found", "غير موجود.");
  const DB = env.DB;
  const ok = (extra: Record<string, unknown> = {}) => json({ ok: true, ...extra });
  const mustChange = async (r: D1Result) => { if (!r.meta.changes) fail(404, "not_found", "العنصر غير موجود، ربما حُذف."); };

  switch (res) {
    // ---------------- live state ----------------
    case "state": {
      if (m !== "POST") break;
      const patch: { comp?: number | null; question?: number | null; featured?: number | null } = {};
      if ("activeCompetitionId" in b) patch.comp = optId(b, "activeCompetitionId");
      if ("activeQuestionId" in b) patch.question = optId(b, "activeQuestionId");
      if ("featuredMessageId" in b) {
        patch.featured = optId(b, "featuredMessageId");
        if (patch.featured !== null) {
          const msg = await DB.prepare("SELECT status FROM messages WHERE id = ?").bind(patch.featured).first<{ status: string }>();
          if (!msg || msg.status !== "approved") fail(400, "invalid", "اعتمد الرسالة أولًا.");
        }
      }
      await setState(env, patch);
      return ok();
    }
    // ---------------- competitions ----------------
    case "competitions": {
      if (m === "POST" && id === null) {
        const c = compBody(b);
        const r = await DB.prepare("INSERT INTO competitions (name, start_at, end_at, created_at) VALUES (?, ?, ?, ?)").bind(c.name, c.start, c.end, now()).run();
        const newId = r.meta.last_row_id as number;
        const st = await getState(env);
        if (!st.active_competition_id) await setState(env, { comp: newId });
        else await bump(DB).run();
        return ok({ id: newId });
      }
      if (m === "PUT" && id !== null) {
        const c = compBody(b);
        await mustChange(await DB.prepare("UPDATE competitions SET name = ?, start_at = ?, end_at = ? WHERE id = ?").bind(c.name, c.start, c.end, id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "POST" && id !== null && action === "schedule") {
        const start = optTime(b, "start"), end = optTime(b, "end");
        if (start && end && end <= start) fail(400, "invalid", "النهاية يجب أن تكون بعد البداية.");
        await mustChange(await DB.prepare("UPDATE competitions SET start_at = ?, end_at = ? WHERE id = ?").bind(start, end, id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "POST" && id !== null && (action === "open" || action === "close")) {
        // "Start now" opens the window immediately; "End now" closes it immediately.
        const t = now();
        const sql = action === "open"
          ? "UPDATE competitions SET start_at = ?1, end_at = CASE WHEN end_at IS NOT NULL AND end_at <= ?1 THEN NULL ELSE end_at END WHERE id = ?2"
          : "UPDATE competitions SET end_at = ?1, start_at = CASE WHEN start_at IS NOT NULL AND start_at >= ?1 THEN NULL ELSE start_at END WHERE id = ?2";
        await mustChange(await DB.prepare(sql).bind(t, id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([
          DB.prepare("UPDATE app_state SET active_competition_id = NULL, active_question_id = NULL WHERE active_competition_id = ?").bind(id),
          DB.prepare("UPDATE events SET competition_id = NULL WHERE competition_id = ?").bind(id),
          DB.prepare("DELETE FROM answers WHERE competition_id = ?").bind(id),
          DB.prepare("DELETE FROM scores WHERE competition_id = ?").bind(id),
          DB.prepare("DELETE FROM questions WHERE competition_id = ?").bind(id),
          DB.prepare("DELETE FROM competitions WHERE id = ?").bind(id),
          bump(DB),
        ]);
        return ok();
      }
      break;
    }
    // ---------------- questions ----------------
    case "questions": {
      if ((m === "POST" && id === null) || (m === "PUT" && id !== null)) {
        const competitionId = optId(b, "competitionId");
        if (!competitionId) fail(400, "invalid", "اختر المسابقة.");
        await exists(env, "competitions", competitionId, "المسابقة");
        const text = str(b, "text", 1, 300, "نص السؤال");
        const type = typeof b.type === "string" && Q_TYPES.has(b.type) ? b.type : fail(400, "invalid", "نوع السؤال غير صالح.");
        const attempts = int(b, "attempts", 1, 10, "عدد المحاولات");
        const duration = int(b, "duration", 5, 300, "مدة الإجابة");
        let options: string[] = [];
        let correct: number | null = null;
        if (type === "choice") {
          if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 4) fail(400, "invalid", "أدخل من خيارين إلى أربعة خيارات.");
          options = b.options.map((o, i) => str({ o }, "o", 1, 120, `الخيار ${i + 1}`));
          correct = int(b, "correct", 0, options.length - 1, "الإجابة الصحيحة");
        } else if (type === "truefalse") {
          correct = int(b, "correct", 0, 1, "الإجابة الصحيحة");
        }
        if (id === null) {
          const maxOrd = await DB.prepare("SELECT COALESCE(MAX(ord), 0) AS o FROM questions WHERE competition_id = ?").bind(competitionId).first<{ o: number }>();
          const r = await DB.prepare(
            "INSERT INTO questions (competition_id, text, type, options, correct, attempts, duration, ord, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(competitionId, text, type, JSON.stringify(options), correct, attempts, duration, (maxOrd?.o ?? 0) + 1, now()).run();
          await bump(DB).run();
          return ok({ id: r.meta.last_row_id });
        }
        const cur = await DB.prepare("SELECT competition_id FROM questions WHERE id = ?").bind(id).first<{ competition_id: number }>();
        if (!cur) fail(404, "not_found", "السؤال غير موجود.");
        const stmts = [
          DB.prepare("UPDATE questions SET competition_id = ?, text = ?, type = ?, options = ?, correct = ?, attempts = ?, duration = ? WHERE id = ?")
            .bind(competitionId, text, type, JSON.stringify(options), correct, attempts, duration, id),
        ];
        if (cur.competition_id !== competitionId) {
          stmts.push(DB.prepare("UPDATE app_state SET active_question_id = NULL WHERE active_question_id = ?").bind(id));
          stmts.push(DB.prepare("UPDATE questions SET ord = (SELECT COALESCE(MAX(ord), 0) + 1 FROM questions WHERE competition_id = ?) WHERE id = ?").bind(competitionId, id));
        }
        stmts.push(bump(DB));
        await DB.batch(stmts);
        return ok();
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([
          DB.prepare("UPDATE app_state SET active_question_id = NULL WHERE active_question_id = ?").bind(id),
          // Points already earned on this question are removed from the totals.
          DB.prepare(
            `UPDATE scores SET points = points - ?1, correct_count = correct_count - 1
             WHERE (participant_id, competition_id) IN (SELECT participant_id, competition_id FROM answers WHERE question_id = ?2 AND correct = 1)`,
          ).bind(POINTS, id),
          DB.prepare(
            `UPDATE scores SET answered = answered - 1
             WHERE (participant_id, competition_id) IN (SELECT participant_id, competition_id FROM answers WHERE question_id = ?1 AND n_tries > 0)`,
          ).bind(id),
          DB.prepare("DELETE FROM answers WHERE question_id = ?").bind(id),
          DB.prepare("DELETE FROM questions WHERE id = ?").bind(id),
          bump(DB),
        ]);
        return ok();
      }
      break;
    }
    case "next-question": {
      if (m !== "POST") break;
      const st = await getState(env);
      if (!st.active_competition_id) fail(400, "invalid", "فعّل مسابقة أولًا.");
      const { results } = await DB.prepare("SELECT id FROM questions WHERE competition_id = ? ORDER BY ord, id").bind(st.active_competition_id).all<{ id: number }>();
      if (!results.length) fail(400, "invalid", "أضف أسئلة لهذه المسابقة أولًا.");
      const i = results.findIndex((q) => q.id === st.active_question_id);
      if (i !== -1 && i >= results.length - 1) fail(400, "last", "هذا آخر سؤال في المسابقة.");
      await setState(env, { question: results[i + 1].id });
      return ok();
    }
    // ---------------- groups ----------------
    case "groups": {
      if (m === "POST" && id === null) {
        const name = str(b, "name", 1, 80, "اسم المجموعة");
        await DB.batch([DB.prepare("INSERT INTO screen_groups (name, created_at) VALUES (?, ?)").bind(name, now()), bump(DB)]);
        return ok();
      }
      if (m === "PUT" && id !== null) {
        await mustChange(await DB.prepare("UPDATE screen_groups SET name = ? WHERE id = ?").bind(str(b, "name", 1, 80, "اسم المجموعة"), id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "POST" && id !== null && action === "content") {
        const mediaId = b.content === "quiz" ? null : optId(b, "content");
        await imageExists(env, mediaId);
        const r = await DB.prepare("UPDATE screens SET content_media_id = ? WHERE group_id = ?").bind(mediaId, id).run();
        await bump(DB).run();
        return ok({ updated: r.meta.changes });
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([
          DB.prepare("UPDATE screens SET group_id = NULL WHERE group_id = ?").bind(id),
          DB.prepare("UPDATE events SET group_id = NULL WHERE group_id = ?").bind(id),
          DB.prepare("DELETE FROM screen_groups WHERE id = ?").bind(id),
          bump(DB),
        ]);
        return ok();
      }
      break;
    }
    // ---------------- screens ----------------
    case "screens": {
      if (m === "POST" && id === null) {
        const name = str(b, "name", 1, 80, "اسم الشاشة");
        const groupId = optId(b, "groupId");
        await exists(env, "screen_groups", groupId, "المجموعة");
        await DB.batch([
          DB.prepare("INSERT INTO screens (key, name, group_id, content_media_id, created_at) VALUES (?, ?, ?, NULL, ?)").bind(screenKey(), name, groupId, now()),
          bump(DB),
        ]);
        return ok();
      }
      if (m === "PUT" && id !== null) {
        const name = str(b, "name", 1, 80, "اسم الشاشة");
        const groupId = optId(b, "groupId");
        await exists(env, "screen_groups", groupId, "المجموعة");
        await mustChange(await DB.prepare("UPDATE screens SET name = ?, group_id = ? WHERE id = ?").bind(name, groupId, id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "POST" && id !== null && action === "content") {
        const mediaId = b.content === "quiz" ? null : optId(b, "content");
        await imageExists(env, mediaId);
        await mustChange(await DB.prepare("UPDATE screens SET content_media_id = ? WHERE id = ?").bind(mediaId, id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "POST" && id !== null && action === "rekey") {
        await mustChange(await DB.prepare("UPDATE screens SET key = ?, last_seen = NULL WHERE id = ?").bind(screenKey(), id).run());
        await bump(DB).run();
        return ok();
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([
          DB.prepare("UPDATE participants SET screen_id = NULL WHERE screen_id = ?").bind(id),
          DB.prepare("DELETE FROM screens WHERE id = ?").bind(id),
          bump(DB),
        ]);
        return ok();
      }
      break;
    }
    // ---------------- events ----------------
    case "events": {
      if ((m === "POST" && id === null) || (m === "PUT" && id !== null)) {
        const name = str(b, "name", 1, 80, "اسم الفعالية");
        const date = optTime(b, "date");
        const competitionId = optId(b, "competitionId"), mediaId = optId(b, "mediaId"), groupId = optId(b, "groupId");
        await exists(env, "competitions", competitionId, "المسابقة");
        await imageExists(env, mediaId);
        await exists(env, "screen_groups", groupId, "المجموعة");
        if (id === null) {
          await DB.batch([
            DB.prepare("INSERT INTO events (name, date, competition_id, media_id, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(name, date, competitionId, mediaId, groupId, now()),
            bump(DB),
          ]);
        } else {
          await mustChange(await DB.prepare("UPDATE events SET name = ?, date = ?, competition_id = ?, media_id = ?, group_id = ? WHERE id = ?").bind(name, date, competitionId, mediaId, groupId, id).run());
          await bump(DB).run();
        }
        return ok();
      }
      if (m === "POST" && id !== null && action === "run") {
        const e = await DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<{ competition_id: number | null; media_id: number | null; group_id: number | null; name: string }>();
        if (!e) fail(404, "not_found", "الفعالية غير موجودة.");
        if (e.competition_id) await setState(env, { comp: e.competition_id });
        const r = e.group_id
          ? await DB.prepare("UPDATE screens SET content_media_id = ? WHERE group_id = ?").bind(e.media_id, e.group_id).run()
          : await DB.prepare("UPDATE screens SET content_media_id = ?").bind(e.media_id).run();
        await bump(DB).run();
        return ok({ updated: r.meta.changes });
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([DB.prepare("DELETE FROM events WHERE id = ?").bind(id), bump(DB)]);
        return ok();
      }
      break;
    }
    // ---------------- messages ----------------
    case "messages": {
      if (m === "POST" && id !== null && (action === "approve" || action === "hide")) {
        const status = action === "approve" ? "approved" : "hidden";
        await mustChange(await DB.prepare("UPDATE messages SET status = ?, decided_at = ? WHERE id = ?").bind(status, now(), id).run());
        if (action === "approve") await setState(env, { featured: id });
        else await DB.batch([DB.prepare("UPDATE app_state SET featured_message_id = NULL WHERE featured_message_id = ?").bind(id), bump(DB)]);
        return ok();
      }
      break;
    }
    // ---------------- media library ----------------
    case "media": {
      if (m === "POST" && id === null) {
        const name = (optStr(b, "name", 60, "اسم الصورة") || "صورة").replace(/\n/g, " ");
        const up = decodeUpload(b, MIME_OK);
        const newId = await storeMedia(env, name, "image", up);
        await bump(DB).run();
        return ok({ id: newId, url: mediaUrl(newId) });
      }
      if (m === "POST" && id !== null && action === "show-all") {
        await imageExists(env, id);
        const r = await DB.prepare("UPDATE screens SET content_media_id = ?").bind(id).run();
        await bump(DB).run();
        return ok({ updated: r.meta.changes });
      }
      if (m === "DELETE" && id !== null) {
        await DB.batch([
          DB.prepare("UPDATE screens SET content_media_id = NULL WHERE content_media_id = ?").bind(id),
          DB.prepare("UPDATE events SET media_id = NULL WHERE media_id = ?").bind(id),
          DB.prepare("DELETE FROM media_chunks WHERE media_id = ?").bind(id),
          DB.prepare("DELETE FROM media WHERE id = ? AND kind = 'image'").bind(id),
          bump(DB),
        ]);
        return ok();
      }
      break;
    }
    // ---------------- identity (owner only) ----------------
    case "identity": {
      if (me.role !== "owner") fail(403, "forbidden", "تعديل هوية الشركة لمالك المنصة فقط.");
      if (m === "PUT") {
        const colors = ["primary", "accent", "background"].map((k) => {
          const v = b[k];
          if (typeof v !== "string" || !COLOR_RE.test(v)) fail(400, "invalid", "لون غير صالح.");
          return v.toLowerCase();
        });
        let logoId: number | null | undefined;
        if (b.logo && typeof b.logo === "object") {
          logoId = await storeMedia(env, "شعار", "logo", decodeUpload(b.logo as Body, LOGO_MIME_OK));
        }
        const old = await getState(env);
        await DB.prepare(
          `UPDATE app_state SET primary_color = ?, accent_color = ?, background_color = ?, logo_media_id = ${logoId !== undefined ? "?" : "logo_media_id"}, version = version + 1 WHERE id = 1`,
        ).bind(...colors, ...(logoId !== undefined ? [logoId] : [])).run();
        if (logoId !== undefined && old.logo_media_id) {
          await DB.batch([DB.prepare("DELETE FROM media_chunks WHERE media_id = ?").bind(old.logo_media_id), DB.prepare("DELETE FROM media WHERE id = ? AND kind = 'logo'").bind(old.logo_media_id)]);
        }
        return ok();
      }
      if (m === "POST" && parts[1] === "reset") {
        const old = await getState(env);
        await DB.prepare("UPDATE app_state SET primary_color = '#8d6d52', accent_color = '#c6ab8c', background_color = '#f3eee7', logo_media_id = NULL, version = version + 1 WHERE id = 1").run();
        if (old.logo_media_id) await DB.batch([DB.prepare("DELETE FROM media_chunks WHERE media_id = ?").bind(old.logo_media_id), DB.prepare("DELETE FROM media WHERE id = ? AND kind = 'logo'").bind(old.logo_media_id)]);
        return ok();
      }
      break;
    }
    // ---------------- analytics ----------------
    case "insights": {
      if (m !== "GET" || id === null) break;
      const comp = await DB.prepare("SELECT id, name FROM competitions WHERE id = ?").bind(id).first();
      if (!comp) fail(404, "not_found", "المسابقة غير موجودة.");
      const [answers, board] = await DB.batch([
        DB.prepare(
          `SELECT a.participant_id AS pid, p.name, p.via_screen AS kiosk, a.question_id AS qid, a.tries, a.n_tries AS nTries, a.correct, a.at
           FROM answers a JOIN participants p ON p.id = a.participant_id WHERE a.competition_id = ? AND a.n_tries > 0 ORDER BY a.at`,
        ).bind(id),
        DB.prepare(
          `SELECT s.participant_id AS pid, p.name, p.via_screen AS kiosk, s.points, s.correct_count AS correctCount, s.answered, s.last_correct_at AS lastCorrect
           FROM scores s JOIN participants p ON p.id = s.participant_id WHERE s.competition_id = ? AND s.answered > 0
           ORDER BY s.points DESC, CASE WHEN s.last_correct_at IS NULL THEN 1 ELSE 0 END, s.last_correct_at ASC`,
        ).bind(id),
      ]);
      return json({
        competition: comp,
        answers: (answers.results as Array<Record<string, unknown>>).map((a) => ({ ...a, tries: JSON.parse(a.tries as string) })),
        leaderboard: board.results,
      });
    }
    case "participants": {
      if (m !== "GET") break;
      const { results } = await DB.prepare(
        `SELECT p.id, p.name, p.via_screen AS kiosk, sc.name AS screenName, p.created_at AS createdAt,
          COALESCE((SELECT SUM(points) FROM scores WHERE participant_id = p.id), 0) AS points,
          (SELECT COUNT(*) FROM messages WHERE participant_id = p.id) AS messages
         FROM participants p LEFT JOIN screens sc ON sc.id = p.screen_id ORDER BY p.created_at DESC LIMIT 1000`,
      ).all();
      return json({ participants: results });
    }
  }
  fail(404, "not_found", "المسار غير موجود.");
}

// Shared helpers: responses, validation, crypto, throttling.
import schemaSql from "../migrations/0001_init.sql";
import pairingSql from "../migrations/0002_tv_pairing.sql";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SETUP_KEY?: string;
  SESSION_SECRET?: string;
  /** Optional: PBKDF2 iterations for NEW passwords (10000..100000, default 100000). */
  PW_ITERATIONS?: string;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message || code);
  }
}

export const now = () => Date.now();

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  if (!h.has("Cache-Control")) h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
}

export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

// ---------- validation ----------
export type Body = Record<string, unknown>;

export function str(b: Body, key: string, min: number, max: number, label: string): string {
  const v = b[key];
  if (typeof v !== "string") fail(400, "invalid", `${label}: قيمة غير صالحة.`);
  const t = v.trim().replace(/\s+/g, (m) => (m.includes("\n") ? "\n" : " "));
  if (t.length < min) fail(400, "invalid", min <= 1 ? `اكتب ${label}.` : `${label} قصير جدًا.`);
  if (t.length > max) fail(400, "invalid", `${label} أطول من المسموح (${max} حرفًا).`);
  return t;
}

export function optStr(b: Body, key: string, max: number, label: string): string | null {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  return str(b, key, 1, max, label);
}

export function int(b: Body, key: string, min: number, max: number, label: string): number {
  const v = typeof b[key] === "string" ? Number(b[key]) : b[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(400, "invalid", `${label}: قيمة غير صالحة.`);
  return v;
}

/** Optional positive integer id (accepts numeric strings); null/""/undefined → null. */
export function optId(b: Body, key: string): number | null {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) fail(400, "invalid", "معرّف غير صالح.");
  return n;
}

export function optTime(b: Body, key: string): number | null {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 946684800000 || v > 4102444800000) fail(400, "invalid", "تاريخ غير صالح.");
  return v;
}

export function pathId(s: string | undefined): number {
  const n = Number(s);
  if (!s || !/^\d{1,15}$/.test(s) || !Number.isSafeInteger(n) || n <= 0) fail(404, "not_found", "غير موجود.");
  return n;
}

export const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,190}\.[a-z]{2,}$/i;
export const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ---------- encoding / crypto ----------
const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(nBytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(nBytes)));
}

/** Short, unguessable, easy-to-type key for screen links (60 bits). */
export function screenKey(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no i,l,o,0,1
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export async function sha256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text))));
}

export async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value))));
}

/** Cloudflare Workers caps PBKDF2 at 100,000 iterations. */
export const PBKDF2_ITERATIONS = 100_000;

/** Iterations for newly set passwords. Existing hashes keep the count stored with them. */
export function pwIterations(env: Env): number {
  const n = Number(env.PW_ITERATIONS);
  return Number.isInteger(n) && n >= 10_000 && n <= PBKDF2_ITERATIONS ? n : PBKDF2_ITERATIONS;
}

export async function hashPassword(password: string, salt?: string, iterations = PBKDF2_ITERATIONS) {
  const s = salt || randomToken(16);
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(s), iterations }, key, 256);
  return { hash: b64url(new Uint8Array(bits)), salt: s, iterations };
}

export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function cookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") || "local";
}

// ---------- throttling (stored in D1) ----------
export async function throttleCount(db: D1Database, k: string, windowMs: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM throttle WHERE k = ? AND at > ?").bind(k, now() - windowMs).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function throttleHit(db: D1Database, k: string): Promise<void> {
  await db.prepare("INSERT INTO throttle (k, at) VALUES (?, ?)").bind(k, now()).run();
  if (Math.random() < 0.03) await db.prepare("DELETE FROM throttle WHERE at < ?").bind(now() - 86_400_000).run();
}

export async function limit(db: D1Database, k: string, max: number, windowMs: number, message: string) {
  if ((await throttleCount(db, k, windowMs)) >= max) fail(429, "rate_limited", message);
  await throttleHit(db, k);
}

// ---------- state version (lets polling clients get 304) ----------
export function bump(db: D1Database): D1PreparedStatement {
  return db.prepare("UPDATE app_state SET version = version + 1 WHERE id = 1");
}

// ---------- schema bootstrap ----------
let schemaReady = false;

function sqlStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function tableExists(db: D1Database, check: string): Promise<boolean> {
  try {
    await db.prepare(check).first();
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates or upgrades the tables once per isolate. Production relies on this (the deploy does not run
 * `wrangler d1 migrations apply`). Every migration file is idempotent (IF NOT EXISTS), and 0001 runs only
 * when the database is empty, so existing data is never touched.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  if (schemaReady) return;
  const pending: string[] = [];
  if (!(await tableExists(db, "SELECT version FROM app_state WHERE id = 1"))) pending.push(...sqlStatements(schemaSql));
  if (!(await tableExists(db, "SELECT 1 FROM screen_pairings LIMIT 1"))) pending.push(...sqlStatements(pairingSql));
  if (pending.length) await db.batch(pending.map((x) => db.prepare(x)));
  schemaReady = true;
}

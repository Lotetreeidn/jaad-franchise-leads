import type { Env } from "./util.ts";
import { clientIp, HttpError, rateLimit, sha256Hex } from "./util.ts";

/** Single-operator login. The password and signing secret are Worker secrets, never stored in D1 or code. */

export const SESSION_COOKIE = "jfl_session";
const SESSION_TTL_MS = 7 * 86_400_000;
const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function authConfigured(env: Env): boolean {
  return Boolean(env.OPERATOR_PASSWORD && env.OPERATOR_PASSWORD.length >= 10 && env.SESSION_SECRET && env.SESSION_SECRET.length >= 32);
}

export async function login(request: Request, env: Env, password: string, now = Date.now()): Promise<string> {
  if (!authConfigured(env)) throw new HttpError(503, "auth_not_configured");
  const ipKey = `login:${(await sha256Hex(clientIp(request))).slice(0, 16)}`;
  if (!(await rateLimit(env.DB, ipKey, 5, 15 * 60_000, now))) throw new HttpError(429, "too_many_attempts");
  const ok = timingSafeEqual(await sha256Hex(password), await sha256Hex(env.OPERATOR_PASSWORD!));
  if (!ok) throw new HttpError(401, "wrong_password");
  const payload = `op.${now + SESSION_TTL_MS}`;
  const token = `${payload}.${await hmac(env.SESSION_SECRET!, payload)}`;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export const logoutCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function hasSession(request: Request, env: Env, now = Date.now()): Promise<boolean> {
  if (!authConfigured(env)) return false;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.split(/;\s*/).find(c => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "op") return false;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires < now) return false;
  return timingSafeEqual(parts[2], await hmac(env.SESSION_SECRET!, `${parts[0]}.${parts[1]}`));
}

/** State-changing operator requests must come from this origin and carry the app's custom header. */
export function assertSameOrigin(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "cross_origin");
  if (request.headers.get("x-jfl") !== "1") throw new HttpError(403, "missing_csrf_header");
}

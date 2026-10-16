import { handle } from "../../src/index.ts";
import type { Env } from "../../src/util.ts";
import { createD1 } from "./d1.ts";

export const ORIGIN = "https://leads.example";
export const PASSWORD = "correct horse battery";

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Every outbound fetch must be answered by a test route; anything else throws, so tests can never reach the internet. */
export function mockFetch(routes: Record<string, FetchHandler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const key = Object.keys(routes).find(k => url.startsWith(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    return routes[key](url, init);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function world(extraEnv: Partial<Env> = {}) {
  const { d1, raw } = createD1();
  const env: Env = { DB: d1, OPERATOR_PASSWORD: PASSWORD, SESSION_SECRET: "s".repeat(40), OVERPASS_URL: "https://overpass.test/api", ...extraEnv };
  let cookie = "";
  let ip = 1;
  async function api(method: string, path: string, body?: unknown, opts: { auth?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "cf-connecting-ip": `10.0.0.${ip}`, ...opts.headers };
    if (method !== "GET") { headers.origin = ORIGIN; headers["x-jfl"] = "1"; }
    if (opts.auth !== false && cookie) headers.cookie = cookie;
    if (body !== undefined && typeof body !== "string") headers["content-type"] = "application/json";
    Object.assign(headers, opts.headers);
    const res = await handle(new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* html or csv */ }
    return { status: res.status, data, headers: res.headers };
  }
  async function loginOk() {
    const res = await api("POST", "/api/login", { password: PASSWORD }, { auth: false });
    if (res.status !== 200) throw new Error(`login failed ${res.status}`);
    cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  }
  const row = (sql: string, ...p: any[]) => raw.prepare(sql).get(...p) as any;
  const rows = (sql: string, ...p: any[]) => raw.prepare(sql).all(...p) as any[];
  return { env, api, loginOk, row, rows, raw, nextIp: () => { ip++; } };
}

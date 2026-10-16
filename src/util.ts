export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  APP_NAME?: string;
  OVERPASS_URL?: string;
  OPERATOR_PASSWORD?: string;
  SESSION_SECRET?: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GMAIL_SENDER?: string;
  CRON_SECRET?: string;
  EXPORT_TOKEN?: string;
}

export const SEGMENTS = ["FNB_OPERATOR", "MASTER_FRANCHISE", "PROPERTY_OWNER"] as const;
export type Segment = (typeof SEGMENTS)[number];

export const STAGES = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED", "MEETING", "NEGOTIATION", "WON", "LOST", "DISQUALIFIED", "DO_NOT_CONTACT"] as const;
export type Stage = (typeof STAGES)[number];

/** Stages from which no outreach may ever be sent. */
export const CLOSED_STAGES: readonly Stage[] = ["WON", "LOST", "DISQUALIFIED", "DO_NOT_CONTACT"];

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const nowIso = (now = Date.now()) => new Date(now).toISOString();
export const newId = () => crypto.randomUUID();

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 64_000): Promise<T> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "body_too_large");
  try {
    const parsed = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function str(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function isSegment(value: unknown): value is Segment {
  return typeof value === "string" && (SEGMENTS as readonly string[]).includes(value);
}

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

/** Lowercase, accent-free, punctuation-free company name used for exact identity matching only. */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9؀-ۿ぀-ヿ一-鿿가-힯]+/g, " ")
    .trim();
}

/** Registrable-ish host without www. Returns null for invalid or non-http(s) URLs. */
export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

export function normalizeWebsite(url: string | null | undefined): string | null {
  const domain = domainOf(url);
  if (!domain || !url) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export const LOCAL_COUNTRY = "ID";
export const marketOf = (country: string) => (country.toUpperCase() === LOCAL_COUNTRY ? "LOCAL" : "GLOBAL");

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "local";
}

export async function activity(db: D1Database, leadId: string | null, kind: string, detail = "", now = Date.now()) {
  await db.prepare("INSERT INTO activities (id, lead_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(newId(), leadId, kind, detail.slice(0, 2000), nowIso(now)).run();
}

/** Fixed-window rate limit stored in D1. Returns true when the call is allowed. */
export async function rateLimit(db: D1Database, key: string, limit: number, windowMs: number, now = Date.now()): Promise<boolean> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare(
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(key, windowStart).first<{ count: number }>();
  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 7 * 86_400_000).run();
  }
  return Number(row?.count ?? 0) <= limit;
}

import { nowIso, str } from "./util.ts";

/**
 * Owner-typed franchise profile. Nothing here is invented by the app: every field starts empty and
 * outreach drafts refuse to generate until the fields they need are filled in by the owner.
 */
export interface FranchiseProfile {
  sender_name: string;
  sender_title: string;
  company_name: string;
  local_url: string;
  global_url: string;
  pitch_id: string;
  pitch_en: string;
  whatsapp_number: string;
  postal_address: string;
}

export const EMPTY_PROFILE: FranchiseProfile = {
  sender_name: "",
  sender_title: "",
  company_name: "JAAD Cafe",
  local_url: "https://jaadcafe.com",
  global_url: "https://global.jaadcafe.com",
  pitch_id: "",
  pitch_en: "",
  whatsapp_number: "",
  postal_address: "",
};

export interface AppSettings {
  auto_discovery_enabled: boolean;
  auto_verify_enabled: boolean;
  outreach_enabled: boolean;
  daily_email_cap: number;
  min_quality_to_draft: number;
  profile: FranchiseProfile;
}

export const DEFAULT_SETTINGS: AppSettings = {
  auto_discovery_enabled: false,
  auto_verify_enabled: false,
  outreach_enabled: false,
  daily_email_cap: 20,
  min_quality_to_draft: 40,
  profile: EMPTY_PROFILE,
};

export const MAX_DAILY_EMAIL_CAP = 100;

export async function readSettings(db: D1Database): Promise<AppSettings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const stored: Record<string, unknown> = {};
  for (const row of results ?? []) {
    try { stored[row.key] = JSON.parse(row.value); } catch { /* ignore corrupt values, defaults apply */ }
  }
  const profileIn = (stored.profile && typeof stored.profile === "object" ? stored.profile : {}) as Record<string, unknown>;
  const profile = { ...EMPTY_PROFILE };
  for (const key of Object.keys(EMPTY_PROFILE) as (keyof FranchiseProfile)[]) {
    if (typeof profileIn[key] === "string") profile[key] = profileIn[key] as string;
  }
  return {
    auto_discovery_enabled: stored.auto_discovery_enabled === true,
    auto_verify_enabled: stored.auto_verify_enabled === true,
    outreach_enabled: stored.outreach_enabled === true,
    daily_email_cap: clampInt(stored.daily_email_cap, DEFAULT_SETTINGS.daily_email_cap, 0, MAX_DAILY_EMAIL_CAP),
    min_quality_to_draft: clampInt(stored.min_quality_to_draft, DEFAULT_SETTINGS.min_quality_to_draft, 0, 100),
    profile,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/** Applies a partial update coming from the Settings screen; unknown keys are ignored. */
export async function writeSettings(db: D1Database, input: Record<string, unknown>, now = Date.now()): Promise<AppSettings> {
  const current = await readSettings(db);
  const next: AppSettings = { ...current, profile: { ...current.profile } };
  for (const key of ["auto_discovery_enabled", "auto_verify_enabled", "outreach_enabled"] as const) {
    if (typeof input[key] === "boolean") next[key] = input[key] as boolean;
  }
  if (input.daily_email_cap !== undefined) next.daily_email_cap = clampInt(Number(input.daily_email_cap), current.daily_email_cap, 0, MAX_DAILY_EMAIL_CAP);
  if (input.min_quality_to_draft !== undefined) next.min_quality_to_draft = clampInt(Number(input.min_quality_to_draft), current.min_quality_to_draft, 0, 100);
  if (input.profile && typeof input.profile === "object") {
    const p = input.profile as Record<string, unknown>;
    for (const key of Object.keys(EMPTY_PROFILE) as (keyof FranchiseProfile)[]) {
      if (typeof p[key] === "string") next.profile[key] = str(p[key], key.startsWith("pitch") ? 1500 : 300);
    }
    for (const key of ["local_url", "global_url"] as const) {
      if (next.profile[key] && !/^https:\/\/[^\s]+$/i.test(next.profile[key])) next.profile[key] = current.profile[key];
    }
  }
  const stamp = nowIso(now);
  const stmt = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
  await db.batch(Object.entries(next).map(([key, value]) => stmt.bind(key, JSON.stringify(value), stamp)));
  return next;
}

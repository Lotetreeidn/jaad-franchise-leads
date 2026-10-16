import type { Candidate } from "./discovery.ts";
import { candidatesFromOsm, fetchOverpass, isPlatformDomain, overpassQuery } from "./discovery.ts";
import { scoreLead } from "./scoring.ts";
import type { Env, Segment, Stage } from "./util.ts";
import { activity, domainOf, HttpError, isSegment, isStage, marketOf, nameKey, newId, normalizeWebsite, nowIso, str } from "./util.ts";
import { normalizePhone, verifySite } from "./verify.ts";

export interface LeadRow {
  id: string;
  segment: Segment;
  market: "LOCAL" | "GLOBAL";
  name: string;
  name_key: string;
  country: string;
  city: string;
  website: string | null;
  domain: string | null;
  place_kind: string | null;
  outlet_count: number;
  brand_count: number;
  stage: Stage;
  verification: string;
  quality_score: number;
  confidence_score: number;
  score_reasons: string;
  source: string;
  source_ref: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  contacted_at: string | null;
}

export interface NewLead {
  segment: Segment;
  name: string;
  country: string;
  city?: string;
  website?: string | null;
  placeKind?: string | null;
  outletCount?: number;
  brandCount?: number;
  source: "OSM" | "CSV" | "APPLY_FORM" | "MANUAL";
  sourceRef?: string | null;
  sourceUrl?: string;
  notes?: string;
}

export type InsertResult = { status: "inserted"; id: string } | { status: "duplicate"; id: string | null } | { status: "suppressed" };

/** Inserts a lead unless the same company (exact domain, source id, or exact name+country+city) already exists. */
export async function insertLead(db: D1Database, lead: NewLead, now = Date.now()): Promise<InsertResult> {
  const country = lead.country.toUpperCase().slice(0, 2);
  const city = (lead.city ?? "").trim().slice(0, 120);
  const name = lead.name.trim().slice(0, 200);
  const key = nameKey(name);
  if (!key) throw new HttpError(400, "invalid_name");
  const website = lead.website ? normalizeWebsite(lead.website) : null;
  let domain = domainOf(website);
  if (domain && isPlatformDomain(domain)) domain = null;
  if (domain) {
    const suppressed = await db.prepare("SELECT 1 AS hit FROM suppression WHERE value = ? OR value = ?").bind(domain, `@${domain}`).first();
    if (suppressed) return { status: "suppressed" };
  }
  const existing = await db.prepare(
    "SELECT id FROM leads WHERE (domain IS NOT NULL AND domain = ?) OR (source = ? AND source_ref IS NOT NULL AND source_ref = ?) OR (name_key = ? AND country = ? AND city = ?) LIMIT 1",
  ).bind(domain, lead.source, lead.sourceRef ?? null, key, country, city).first<{ id: string }>();
  if (existing) return { status: "duplicate", id: existing.id };

  const id = newId();
  const stamp = nowIso(now);
  const result = await db.prepare(
    `INSERT INTO leads (id, segment, market, name, name_key, country, city, website, domain, place_kind, outlet_count, brand_count,
       verification, source, source_ref, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(
    id, lead.segment, marketOf(country), name, key, country, city, domain ? website : null, domain, lead.placeKind ?? null,
    Math.max(0, lead.outletCount ?? 0), Math.max(0, lead.brandCount ?? 0), domain ? "PENDING" : "NO_WEBSITE",
    lead.source, lead.sourceRef ?? null, (lead.notes ?? "").slice(0, 2000), stamp, stamp,
  ).run();
  if (!result.meta.changes) return { status: "duplicate", id: null };
  if (lead.sourceUrl) {
    await db.prepare("INSERT INTO evidence (id, lead_id, kind, value, source_url, observed_at) VALUES (?, ?, 'DISCOVERED', ?, ?, ?)")
      .bind(newId(), id, `${lead.source}: ${name}${lead.outletCount ? ` (${lead.outletCount} outlet)` : ""}`, lead.sourceUrl, stamp).run();
  }
  await rescore(db, id, now);
  return { status: "inserted", id };
}

export async function rescore(db: D1Database, id: string, now = Date.now()) {
  const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<LeadRow>();
  if (!lead) return;
  const { results: evidence } = await db.prepare("SELECT kind, value FROM evidence WHERE lead_id = ? AND kind = 'SIGNAL'").bind(id).all<{ kind: string; value: string }>();
  const { results: contacts } = await db.prepare("SELECT kind FROM contacts WHERE lead_id = ?").bind(id).all<{ kind: string }>();
  const score = scoreLead({
    segment: lead.segment,
    source: lead.source,
    verification: lead.verification,
    outletCount: Number(lead.outlet_count),
    brandCount: Number(lead.brand_count),
    placeKind: lead.place_kind,
    signals: (evidence ?? []).map(e => e.value),
    hasEmail: (contacts ?? []).some(c => c.kind === "EMAIL"),
    hasPhone: (contacts ?? []).some(c => c.kind !== "EMAIL"),
    hasWebsite: Boolean(lead.domain),
  });
  // Only promote NEW -> QUALIFIED (or demote back) automatically; every later stage belongs to the operator.
  const stage = lead.stage === "NEW" && score.qualified ? "QUALIFIED" : lead.stage === "QUALIFIED" && !score.qualified ? "NEW" : lead.stage;
  await db.prepare("UPDATE leads SET quality_score = ?, confidence_score = ?, score_reasons = ?, stage = ?, updated_at = ? WHERE id = ?")
    .bind(score.quality, score.confidence, JSON.stringify(score.reasons), stage, nowIso(now), id).run();
}

export interface DiscoveryParams { segment: Segment; country: string; city: string; max?: number }

export async function runDiscovery(env: Env, params: DiscoveryParams, now = Date.now()) {
  const db = env.DB;
  const country = params.country.toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "invalid_country");
  const city = params.city.trim();
  if (!city || city.length > 80) throw new HttpError(400, "invalid_city");
  const runId = newId();
  await db.prepare("INSERT INTO runs (id, kind, params, status, started_at) VALUES (?, 'DISCOVERY', ?, 'RUNNING', ?)")
    .bind(runId, JSON.stringify({ segment: params.segment, country, city }), nowIso(now)).run();
  try {
    const elements = await fetchOverpass(env.OVERPASS_URL || "https://overpass-api.de/api/interpreter", overpassQuery(params.segment, country, city));
    const candidates: Candidate[] = candidatesFromOsm(params.segment, country, city, elements, Math.min(params.max ?? 40, 80));
    let inserted = 0;
    let duplicates = 0;
    for (const c of candidates) {
      const res = await insertLead(db, {
        segment: c.segment, name: c.name, country: c.country, city: c.city, website: c.website, placeKind: c.placeKind,
        outletCount: c.outletCount, brandCount: c.brandCount, source: "OSM", sourceRef: c.sourceRef, sourceUrl: c.sourceUrl,
      }, now);
      if (res.status === "inserted") inserted++; else duplicates++;
    }
    await db.prepare("UPDATE runs SET status = 'DONE', found = ?, inserted = ?, duplicates = ?, finished_at = ? WHERE id = ?")
      .bind(candidates.length, inserted, duplicates, nowIso(), runId).run();
    await db.prepare("UPDATE targets SET last_run_at = ? WHERE segment = ? AND country = ? AND city = ?").bind(nowIso(now), params.segment, country, city).run();
    return { runId, osmElements: elements.length, found: candidates.length, inserted, duplicates };
  } catch (error) {
    const message = String((error as Error).message || error).slice(0, 300);
    await db.prepare("UPDATE runs SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?").bind(message, nowIso(), runId).run();
    throw new HttpError(502, message.startsWith("overpass") ? message : "discovery_failed");
  }
}

/** Verifies up to `limit` pending websites. Free Workers allow 50 outbound requests per invocation: 2 per site. */
export async function verifyPending(env: Env, limit = 10, now = Date.now(), fetcher: typeof fetch = fetch) {
  const db = env.DB;
  const { results } = await db.prepare("SELECT * FROM leads WHERE verification = 'PENDING' AND website IS NOT NULL ORDER BY created_at LIMIT ?")
    .bind(Math.max(1, Math.min(limit, 20))).all<LeadRow>();
  const summary = { checked: 0, verified: 0, review: 0, failed: 0, blocked: 0 };
  for (const lead of results ?? []) {
    summary.checked++;
    const facts = await verifySite(lead.website!, lead.name, lead.country, fetcher);
    const stamp = nowIso(now);
    const statements: D1PreparedStatement[] = [
      db.prepare("UPDATE leads SET verification = ?, verified_at = ?, updated_at = ? WHERE id = ?").bind(facts.status, stamp, stamp, lead.id),
      db.prepare("INSERT INTO evidence (id, lead_id, kind, value, source_url, observed_at) VALUES (?, ?, 'VERIFICATION', ?, ?, ?)")
        .bind(newId(), lead.id, `${facts.status}: ${facts.reason}${facts.title ? ` — ${facts.title}` : ""}`, facts.finalUrl, stamp),
    ];
    if (facts.status === "VERIFIED" || facts.status === "REVIEW") {
      for (const signal of facts.signals) {
        statements.push(db.prepare("INSERT INTO evidence (id, lead_id, kind, value, source_url, observed_at) VALUES (?, ?, 'SIGNAL', ?, ?, ?)").bind(newId(), lead.id, signal, facts.finalUrl, stamp));
      }
      const contactRows: [string, string][] = [
        ...facts.emails.map(v => ["EMAIL", v] as [string, string]),
        ...facts.whatsapp.map(v => ["WHATSAPP", v] as [string, string]),
        ...facts.phones.map(v => ["PHONE", v] as [string, string]),
      ];
      for (const [kind, value] of contactRows) {
        statements.push(db.prepare("INSERT INTO contacts (id, lead_id, kind, value, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").bind(newId(), lead.id, kind, value, facts.finalUrl, stamp));
      }
    }
    await db.batch(statements);
    await rescore(db, lead.id, now);
    if (facts.status === "VERIFIED") summary.verified++;
    else if (facts.status === "REVIEW") summary.review++;
    else if (facts.status === "BLOCKED_ROBOTS") summary.blocked++;
    else summary.failed++;
  }
  return summary;
}

export interface LeadFilter { stage?: string; segment?: string; market?: string; verification?: string; q?: string; minQuality?: number; limit?: number; offset?: number }

export async function listLeads(db: D1Database, f: LeadFilter) {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (f.stage) { where.push("stage = ?"); binds.push(f.stage); }
  if (f.segment) { where.push("segment = ?"); binds.push(f.segment); }
  if (f.market) { where.push("market = ?"); binds.push(f.market); }
  if (f.verification) { where.push("verification = ?"); binds.push(f.verification); }
  if (f.minQuality) { where.push("quality_score >= ?"); binds.push(f.minQuality); }
  if (f.q) { where.push("(name LIKE ? OR city LIKE ? OR domain LIKE ?)"); const like = `%${f.q.replace(/[%_]/g, "")}%`; binds.push(like, like, like); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(f.limit ?? 50, 200));
  const offset = Math.max(0, Math.min(f.offset ?? 0, 100_000));
  const { results } = await db.prepare(
    `SELECT id, segment, market, name, country, city, website, domain, outlet_count, brand_count, stage, verification, quality_score, confidence_score, source, created_at, updated_at, contacted_at
     FROM leads ${clause} ORDER BY quality_score DESC, confidence_score DESC, created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM leads ${clause}`).bind(...binds).first<{ n: number }>();
  return { leads: results ?? [], total: Number(total?.n ?? 0), limit, offset };
}

export async function leadDetail(db: D1Database, id: string) {
  const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<LeadRow>();
  if (!lead) throw new HttpError(404, "lead_not_found");
  const [evidence, contacts, activities, drafts, inquiries] = await db.batch([
    db.prepare("SELECT kind, value, source_url, observed_at FROM evidence WHERE lead_id = ? ORDER BY observed_at DESC LIMIT 50").bind(id),
    db.prepare("SELECT id, kind, value, source_url, created_at FROM contacts WHERE lead_id = ? ORDER BY kind LIMIT 20").bind(id),
    db.prepare("SELECT kind, detail, created_at FROM activities WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50").bind(id),
    db.prepare("SELECT id, channel, language, to_value, subject, body, status, error, created_at, sent_at FROM drafts WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20").bind(id),
    db.prepare("SELECT id, company, contact_name, email, phone, partner_type, capital_range, has_location, message, created_at FROM inquiries WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10").bind(id),
  ]);
  return {
    lead: { ...lead, score_reasons: safeJson(lead.score_reasons) },
    evidence: evidence.results, contacts: contacts.results, activities: activities.results, drafts: drafts.results, inquiries: inquiries.results,
  };
}

const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return []; } };

export async function updateLead(db: D1Database, id: string, input: Record<string, unknown>, now = Date.now()) {
  const lead = await db.prepare("SELECT id, stage FROM leads WHERE id = ?").bind(id).first<{ id: string; stage: string }>();
  if (!lead) throw new HttpError(404, "lead_not_found");
  const sets: string[] = [];
  const binds: unknown[] = [];
  const log: string[] = [];
  if (input.stage !== undefined) {
    if (!isStage(input.stage)) throw new HttpError(400, "invalid_stage");
    sets.push("stage = ?"); binds.push(input.stage); log.push(`stage ${lead.stage} -> ${input.stage}`);
  }
  if (typeof input.notes === "string") { sets.push("notes = ?"); binds.push(str(input.notes, 4000)); log.push("notes updated"); }
  if (input.segment !== undefined) {
    if (!isSegment(input.segment)) throw new HttpError(400, "invalid_segment");
    sets.push("segment = ?"); binds.push(input.segment); log.push(`segment -> ${input.segment}`);
  }
  if (!sets.length) throw new HttpError(400, "nothing_to_update");
  sets.push("updated_at = ?"); binds.push(nowIso(now));
  await db.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await activity(db, id, "UPDATED", log.join("; "), now);
  if (input.segment !== undefined) await rescore(db, id, now);
  return { ok: true };
}

export async function addContact(db: D1Database, leadId: string, kind: string, value: string, sourceUrl: string, now = Date.now()) {
  if (!["EMAIL", "PHONE", "WHATSAPP"].includes(kind)) throw new HttpError(400, "invalid_contact_kind");
  const lead = await db.prepare("SELECT country FROM leads WHERE id = ?").bind(leadId).first<{ country: string }>();
  if (!lead) throw new HttpError(404, "lead_not_found");
  let clean = value.trim();
  if (kind === "EMAIL") {
    clean = clean.toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i.test(clean)) throw new HttpError(400, "invalid_email");
  } else {
    clean = normalizePhone(clean, lead.country);
    if (!clean) throw new HttpError(400, "invalid_phone");
  }
  await db.prepare("INSERT INTO contacts (id, lead_id, kind, value, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(newId(), leadId, kind, clean, str(sourceUrl, 500) || "operator", nowIso(now)).run();
  await activity(db, leadId, "CONTACT_ADDED", `${kind} (${str(sourceUrl, 200) || "operator"})`, now);
  await rescore(db, leadId, now);
  return { ok: true };
}

// ---------- CSV import / export ----------

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(c => c.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim())) rows.push(row);
  return rows;
}

export const CSV_COLUMNS = ["segment", "name", "country", "city", "website", "email", "phone", "notes", "outlet_count", "brand_count"];

export async function importCsv(db: D1Database, text: string, defaultSegment: Segment, now = Date.now()) {
  if (text.length > 400_000) throw new HttpError(413, "csv_too_large");
  const rows = parseCsv(text);
  if (!rows.length) throw new HttpError(400, "csv_empty");
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = (col: string) => header.indexOf(col);
  if (idx("name") < 0 || idx("country") < 0) throw new HttpError(400, "csv_needs_name_and_country_columns");
  const result = { rows: 0, inserted: 0, duplicates: 0, invalid: 0, suppressed: 0 };
  for (const row of rows.slice(1, 501)) {
    result.rows++;
    const get = (col: string) => (idx(col) >= 0 ? (row[idx(col)] ?? "").trim() : "");
    const segment = isSegment(get("segment").toUpperCase()) ? (get("segment").toUpperCase() as Segment) : defaultSegment;
    const country = get("country").toUpperCase();
    if (!get("name") || !/^[A-Z]{2}$/.test(country)) { result.invalid++; continue; }
    try {
      const count = (col: string) => Math.max(0, Math.min(10_000, Math.round(Number(get(col)) || 0)));
      const res = await insertLead(db, {
        segment, name: get("name"), country, city: get("city"), website: get("website") || null, source: "CSV", notes: get("notes"),
        outletCount: count("outlet_count"), brandCount: count("brand_count"),
      }, now);
      if (res.status === "inserted") {
        result.inserted++;
        if (get("email")) await addContact(db, res.id, "EMAIL", get("email"), "csv import", now).catch(() => undefined);
        if (get("phone")) await addContact(db, res.id, "PHONE", get("phone"), "csv import", now).catch(() => undefined);
      } else if (res.status === "suppressed") result.suppressed++;
      else result.duplicates++;
    } catch {
      result.invalid++;
    }
  }
  return result;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function exportCsv(db: D1Database): Promise<string> {
  const { results } = await db.prepare(
    `SELECT l.segment, l.market, l.name, l.country, l.city, l.website, l.stage, l.verification, l.quality_score, l.confidence_score, l.outlet_count, l.brand_count,
       (SELECT group_concat(value, ' ') FROM contacts c WHERE c.lead_id = l.id AND c.kind = 'EMAIL') AS emails,
       (SELECT group_concat(value, ' ') FROM contacts c WHERE c.lead_id = l.id AND c.kind != 'EMAIL') AS phones,
       l.created_at
     FROM leads l ORDER BY l.quality_score DESC LIMIT 5000`,
  ).all<Record<string, unknown>>();
  const cols = ["segment", "market", "name", "country", "city", "website", "stage", "verification", "quality_score", "confidence_score", "outlet_count", "brand_count", "emails", "phones", "created_at"];
  return [cols.join(","), ...(results ?? []).map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n");
}

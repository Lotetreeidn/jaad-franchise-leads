import type { LeadRow } from "./leads.ts";
import type { FranchiseProfile } from "./settings.ts";
import { readSettings } from "./settings.ts";
import type { Env } from "./util.ts";
import { activity, CLOSED_STAGES, HttpError, newId, nowIso, str } from "./util.ts";

/**
 * Outreach is human-approved and free:
 * - EMAIL drafts are sent one at a time through the owner's own Gmail (Gmail API, free) after the operator
 *   approves them, only when outreach is enabled in Settings, under a daily cap, never to suppressed contacts.
 * - WHATSAPP drafts become a wa.me link the operator opens and sends by hand; nothing is sent automatically.
 * Message text only uses the owner-typed profile (pitch, URLs, sender) plus facts the app has evidence for
 * (company name, city, country). It never states prices, fees or terms.
 */

export type Channel = "EMAIL" | "WHATSAPP";
export type Lang = "id" | "en";

const PREFERRED_EMAIL_PREFIXES = ["franchise", "franchising", "kemitraan", "partnership", "partners", "partner", "business", "bisnis", "bizdev", "leasing", "tenant", "corporate", "marketing", "info", "hello", "halo", "contact"];

export function pickEmail(emails: string[]): string | null {
  if (!emails.length) return null;
  const rank = (e: string) => {
    const local = e.split("@")[0];
    const i = PREFERRED_EMAIL_PREFIXES.findIndex(p => local === p || local.startsWith(`${p}.`) || local.startsWith(p));
    return i < 0 ? 99 : i;
  };
  return [...emails].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0];
}

export function countryName(code: string, lang: Lang): string {
  try {
    return new Intl.DisplayNames([lang === "id" ? "id" : "en"], { type: "region" }).of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

export function requiredProfileFields(lang: Lang, market: "LOCAL" | "GLOBAL"): (keyof FranchiseProfile)[] {
  return ["sender_name", "company_name", lang === "id" ? "pitch_id" : "pitch_en", market === "LOCAL" ? "local_url" : "global_url"];
}

export function missingProfileFields(profile: FranchiseProfile, lang: Lang, market: "LOCAL" | "GLOBAL"): string[] {
  return requiredProfileFields(lang, market).filter(k => !profile[k].trim());
}

export function composeMessage(lead: Pick<LeadRow, "name" | "segment" | "market" | "city" | "country">, profile: FranchiseProfile, lang: Lang, channel: Channel) {
  const url = lead.market === "LOCAL" ? profile.local_url : profile.global_url;
  const pitch = (lang === "id" ? profile.pitch_id : profile.pitch_en).trim();
  const sender = [profile.sender_name, profile.sender_title].filter(Boolean).join(lang === "id" ? ", " : ", ");
  const place = lead.city ? lead.city : countryName(lead.country, lang);
  const company = lead.name;

  let subject: string;
  let ask: string;
  if (lang === "id") {
    subject = lead.segment === "PROPERTY_OWNER" ? `Kerja sama lokasi ${profile.company_name} di ${place}` : `Peluang kemitraan ${profile.company_name} untuk ${company}`;
    ask = lead.segment === "PROPERTY_OWNER"
      ? `Kami ingin menjajaki kemungkinan kerja sama penempatan outlet ${profile.company_name} di ${company}. Apakah ada tim leasing atau tenant relation yang bisa kami hubungi?`
      : lead.segment === "MASTER_FRANCHISE"
        ? `Kami melihat ${company} mengelola beberapa brand F&B di ${place}, dan ingin tahu apakah tim Anda tertarik membahas kemitraan ${profile.company_name} untuk wilayah Anda.`
        : `Kami melihat ${company} sudah menjalankan bisnis F&B di ${place}, dan ingin tahu apakah tim Anda tertarik membuka ${profile.company_name} sebagai mitra franchise.`;
  } else {
    subject = lead.segment === "PROPERTY_OWNER" ? `${profile.company_name} location partnership in ${place}` : lead.segment === "MASTER_FRANCHISE" ? `${profile.company_name} franchise partnership for ${countryName(lead.country, "en")}` : `${profile.company_name} franchise opportunity for ${company}`;
    ask = lead.segment === "PROPERTY_OWNER"
      ? `We would like to explore placing a ${profile.company_name} outlet at ${company}. Is there a leasing or tenant relations contact we could speak with?`
      : lead.segment === "MASTER_FRANCHISE"
        ? `We noticed ${company} operates several F&B brands in ${place}, and would like to know whether your team is interested in discussing a ${profile.company_name} franchise partnership for your market.`
        : `We noticed ${company} already runs an F&B business in ${place}, and would like to know whether your team is interested in opening ${profile.company_name} as a franchise partner.`;
  }

  const more = lang === "id" ? `Informasi kemitraan: ${url}` : `Partnership information: ${url}`;
  if (channel === "WHATSAPP") {
    const hello = lang === "id" ? `Halo tim ${company}, saya ${sender} dari ${profile.company_name}.` : `Hello ${company} team, this is ${sender} from ${profile.company_name}.`;
    return { subject: "", body: [hello, pitch, ask, more].filter(Boolean).join("\n\n") };
  }
  const greeting = lang === "id" ? `Halo tim ${company},` : `Dear ${company} team,`;
  const intro = lang === "id" ? `Perkenalkan, saya ${sender} dari ${profile.company_name}.` : `My name is ${sender} from ${profile.company_name}.`;
  const close = lang === "id" ? "Jika berminat, cukup balas email ini dan kami jadwalkan obrolan singkat." : "If this is of interest, simply reply to this email and we will arrange a short call.";
  const wa = profile.whatsapp_number ? `WhatsApp: ${profile.whatsapp_number}` : "";
  const sign = [lang === "id" ? "Salam," : "Best regards,", profile.sender_name, profile.company_name, wa, profile.postal_address].filter(Boolean).join("\n");
  const optOut = lang === "id"
    ? 'Jika Anda tidak ingin menerima email dari kami lagi, balas dengan "STOP" dan kami tidak akan menghubungi Anda lagi.'
    : 'If you would rather not hear from us again, reply "STOP" and we will not contact you again.';
  return { subject, body: [greeting, intro, pitch, ask, more, close, sign, `--\n${optOut}`].filter(Boolean).join("\n\n") };
}

async function isSuppressed(db: D1Database, value: string): Promise<boolean> {
  const v = value.toLowerCase();
  const domain = v.includes("@") ? v.split("@")[1] : null;
  const row = await db.prepare("SELECT 1 AS hit FROM suppression WHERE value = ? OR (? IS NOT NULL AND (value = ? OR value = ?)) LIMIT 1")
    .bind(v, domain, domain, domain ? `@${domain}` : null).first();
  return Boolean(row);
}

export async function createDraft(env: Env, leadId: string, channel: Channel, now = Date.now()) {
  const db = env.DB;
  if (channel !== "EMAIL" && channel !== "WHATSAPP") throw new HttpError(400, "invalid_channel");
  const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(leadId).first<LeadRow>();
  if (!lead) throw new HttpError(404, "lead_not_found");
  if (CLOSED_STAGES.includes(lead.stage)) throw new HttpError(409, "lead_closed");
  const settings = await readSettings(db);
  if (Number(lead.quality_score) < settings.min_quality_to_draft && lead.source !== "APPLY_FORM") throw new HttpError(409, "quality_below_minimum");
  const lang: Lang = lead.market === "LOCAL" ? "id" : "en";
  const missing = missingProfileFields(settings.profile, lang, lead.market);
  if (missing.length) throw new HttpError(409, `profile_incomplete:${missing.join(",")}`);

  const { results: contacts } = await db.prepare("SELECT kind, value FROM contacts WHERE lead_id = ?").bind(leadId).all<{ kind: string; value: string }>();
  const list = contacts ?? [];
  const to = channel === "EMAIL"
    ? pickEmail(list.filter(c => c.kind === "EMAIL").map(c => c.value))
    : (list.find(c => c.kind === "WHATSAPP") ?? list.find(c => c.kind === "PHONE"))?.value ?? null;
  if (!to) throw new HttpError(409, channel === "EMAIL" ? "no_email_contact" : "no_phone_contact");
  if (await isSuppressed(db, to) || (lead.domain && await isSuppressed(db, lead.domain))) throw new HttpError(409, "contact_suppressed");
  const open = await db.prepare("SELECT id FROM drafts WHERE lead_id = ? AND channel = ? AND status IN ('DRAFT','APPROVED','SENDING') LIMIT 1").bind(leadId, channel).first();
  if (open) throw new HttpError(409, "open_draft_exists");

  const message = composeMessage(lead, settings.profile, lang, channel);
  const id = newId();
  await db.prepare("INSERT INTO drafts (id, lead_id, channel, language, to_value, subject, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)")
    .bind(id, leadId, channel, lang, to, message.subject, message.body, nowIso(now)).run();
  await activity(db, leadId, "DRAFT_CREATED", `${channel} -> ${to}`, now);
  return { id, channel, to, ...message };
}

interface DraftRow { id: string; lead_id: string; channel: Channel; language: Lang; to_value: string; subject: string; body: string; status: string }

async function loadDraft(db: D1Database, id: string): Promise<DraftRow> {
  const draft = await db.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<DraftRow>();
  if (!draft) throw new HttpError(404, "draft_not_found");
  return draft;
}

export async function editDraft(db: D1Database, id: string, input: Record<string, unknown>, now = Date.now()) {
  const draft = await loadDraft(db, id);
  if (draft.status !== "DRAFT" && draft.status !== "APPROVED") throw new HttpError(409, "draft_not_editable");
  const subject = input.subject === undefined ? draft.subject : str(input.subject, 200);
  const body = input.body === undefined ? draft.body : str(input.body, 6000);
  if (!body) throw new HttpError(400, "empty_body");
  await db.prepare("UPDATE drafts SET subject = ?, body = ?, status = 'DRAFT', approved_at = NULL WHERE id = ?").bind(subject, body, id).run();
  await activity(db, draft.lead_id, "DRAFT_EDITED", draft.channel, now);
  return { ok: true };
}

export function draftProblems(draft: Pick<DraftRow, "subject" | "body" | "channel">): string[] {
  const problems: string[] = [];
  if (/\{\{|\}\}|\[(?:isi|fill|todo)[^\]]*\]/i.test(`${draft.subject} ${draft.body}`)) problems.push("unfilled_placeholder");
  if (draft.channel === "EMAIL" && !draft.subject.trim()) problems.push("missing_subject");
  if (!draft.body.trim()) problems.push("empty_body");
  return problems;
}

export async function approveDraft(db: D1Database, id: string, now = Date.now()) {
  const draft = await loadDraft(db, id);
  if (draft.status !== "DRAFT" && draft.status !== "FAILED") throw new HttpError(409, "draft_not_approvable");
  const problems = draftProblems(draft);
  if (problems.length) throw new HttpError(409, `draft_invalid:${problems.join(",")}`);
  const res = await db.prepare("UPDATE drafts SET status = 'APPROVED', approved_at = ?, error = NULL WHERE id = ? AND status IN ('DRAFT','FAILED')").bind(nowIso(now), id).run();
  if (!res.meta.changes) throw new HttpError(409, "draft_changed");
  await activity(db, draft.lead_id, "DRAFT_APPROVED", draft.channel, now);
  return { ok: true };
}

export async function cancelDraft(db: D1Database, id: string, now = Date.now()) {
  const draft = await loadDraft(db, id);
  const res = await db.prepare("UPDATE drafts SET status = 'CANCELLED' WHERE id = ? AND status IN ('DRAFT','APPROVED','FAILED')").bind(id).run();
  if (!res.meta.changes) throw new HttpError(409, "draft_not_cancellable");
  await activity(db, draft.lead_id, "DRAFT_CANCELLED", draft.channel, now);
  return { ok: true };
}

export function gmailConfigured(env: Env): boolean {
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.GMAIL_SENDER);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);

export function buildMime(from: string, to: string, subject: string, body: string): string {
  const safe = (v: string) => v.replace(/[\r\n]+/g, " ");
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(body))).replace(/(.{76})/g, "$1\r\n");
  const mime = [
    `From: ${safe(from)}`,
    `To: ${safe(to)}`,
    `Subject: ${encodeHeader(safe(subject))}`,
    `List-Unsubscribe: <mailto:${safe(from)}?subject=STOP>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    bodyB64,
  ].join("\r\n");
  return b64url(new TextEncoder().encode(mime));
}

async function gmailSend(env: Env, to: string, subject: string, body: string): Promise<string> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID!, client_secret: env.GMAIL_CLIENT_SECRET!, refresh_token: env.GMAIL_REFRESH_TOKEN!, grant_type: "refresh_token" }),
  });
  if (!tokenRes.ok) throw new Error(`gmail_token_http_${tokenRes.status}`);
  const { access_token } = await tokenRes.json() as { access_token?: string };
  if (!access_token) throw new Error("gmail_token_missing");
  const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: buildMime(env.GMAIL_SENDER!, to, subject, body) }),
  });
  if (!sendRes.ok) throw new Error(`gmail_send_http_${sendRes.status}`);
  const data = await sendRes.json() as { id?: string };
  return data.id || "gmail";
}

export async function emailsSentLast24h(db: D1Database, now = Date.now()): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE channel = 'EMAIL' AND status IN ('SENT','SENDING') AND COALESCE(sent_at, approved_at) >= ?")
    .bind(nowIso(now - 86_400_000)).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Sends one approved email draft exactly once. Every gate is re-checked at send time. */
export async function sendEmailDraft(env: Env, id: string, now = Date.now()) {
  const db = env.DB;
  const draft = await loadDraft(db, id);
  if (draft.channel !== "EMAIL") throw new HttpError(400, "not_an_email_draft");
  if (draft.status !== "APPROVED") throw new HttpError(409, "draft_not_approved");
  const settings = await readSettings(db);
  if (!settings.outreach_enabled) throw new HttpError(409, "outreach_disabled");
  if (!gmailConfigured(env)) throw new HttpError(409, "gmail_not_configured");
  if (await emailsSentLast24h(db, now) >= settings.daily_email_cap) throw new HttpError(429, "daily_cap_reached");
  const lead = await db.prepare("SELECT * FROM leads WHERE id = ?").bind(draft.lead_id).first<LeadRow>();
  if (!lead || CLOSED_STAGES.includes(lead.stage)) throw new HttpError(409, "lead_closed");
  if (await isSuppressed(db, draft.to_value)) throw new HttpError(409, "contact_suppressed");
  const problems = draftProblems(draft);
  if (problems.length) throw new HttpError(409, `draft_invalid:${problems.join(",")}`);

  const claim = await db.prepare("UPDATE drafts SET status = 'SENDING', sent_at = ? WHERE id = ? AND status = 'APPROVED'").bind(nowIso(now), id).run();
  if (!claim.meta.changes) throw new HttpError(409, "draft_already_claimed");
  try {
    const providerId = await gmailSend(env, draft.to_value, draft.subject, draft.body);
    await markSent(db, draft, providerId, now);
    return { ok: true, providerId };
  } catch (error) {
    const message = String((error as Error).message || error).slice(0, 200);
    await db.prepare("UPDATE drafts SET status = 'FAILED', error = ? WHERE id = ?").bind(message, id).run();
    await activity(db, draft.lead_id, "EMAIL_FAILED", message, now);
    throw new HttpError(502, message);
  }
}

async function markSent(db: D1Database, draft: DraftRow, providerId: string, now: number) {
  const stamp = nowIso(now);
  await db.batch([
    db.prepare("UPDATE drafts SET status = 'SENT', provider_id = ?, sent_at = ?, error = NULL WHERE id = ?").bind(providerId, stamp, draft.id),
    db.prepare("UPDATE leads SET stage = CASE WHEN stage IN ('NEW','QUALIFIED') THEN 'CONTACTED' ELSE stage END, contacted_at = ?, updated_at = ? WHERE id = ?").bind(stamp, stamp, draft.lead_id),
    db.prepare("INSERT INTO activities (id, lead_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)").bind(newId(), draft.lead_id, `${draft.channel}_SENT`, draft.to_value, stamp),
  ]);
}

export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/** The operator sent the WhatsApp message by hand from the wa.me link; record it. */
export async function markWhatsappSent(db: D1Database, id: string, now = Date.now()) {
  const draft = await loadDraft(db, id);
  if (draft.channel !== "WHATSAPP") throw new HttpError(400, "not_a_whatsapp_draft");
  if (draft.status !== "APPROVED") throw new HttpError(409, "draft_not_approved");
  const lead = await db.prepare("SELECT stage FROM leads WHERE id = ?").bind(draft.lead_id).first<{ stage: LeadRow["stage"] }>();
  if (!lead || CLOSED_STAGES.includes(lead.stage)) throw new HttpError(409, "lead_closed");
  const claim = await db.prepare("UPDATE drafts SET status = 'SENDING' WHERE id = ? AND status = 'APPROVED'").bind(id).run();
  if (!claim.meta.changes) throw new HttpError(409, "draft_already_claimed");
  await markSent(db, draft, "manual-whatsapp", now);
  return { ok: true };
}

export async function listDrafts(db: D1Database, status?: string) {
  const valid = ["DRAFT", "APPROVED", "SENDING", "SENT", "FAILED", "CANCELLED"];
  const filter = status && valid.includes(status) ? status : null;
  const { results } = await db.prepare(
    `SELECT d.id, d.lead_id, d.channel, d.language, d.to_value, d.subject, d.body, d.status, d.error, d.created_at, d.sent_at, l.name AS lead_name, l.segment, l.market
     FROM drafts d JOIN leads l ON l.id = d.lead_id ${filter ? "WHERE d.status = ?" : ""} ORDER BY d.created_at DESC LIMIT 200`,
  ).bind(...(filter ? [filter] : [])).all<Record<string, string>>();
  return (results ?? []).map(d => ({ ...d, wa_link: d.channel === "WHATSAPP" ? whatsappLink(d.to_value, d.body) : null }));
}

export async function addSuppression(db: D1Database, rawValue: string, reason: string, now = Date.now()) {
  const value = rawValue.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!value || value.length > 200 || !/[@.]/.test(value)) throw new HttpError(400, "invalid_suppression_value");
  const stamp = nowIso(now);
  const domain = value.includes("@") ? null : value.replace(/^@/, "");
  await db.batch([
    db.prepare("INSERT INTO suppression (value, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(value) DO NOTHING").bind(value, str(reason, 300), stamp),
    db.prepare(`UPDATE drafts SET status = 'CANCELLED' WHERE status IN ('DRAFT','APPROVED','FAILED') AND (to_value = ? OR (? IS NOT NULL AND to_value LIKE ?))`).bind(value, domain, `%@${domain ?? ""}`),
    db.prepare(`UPDATE leads SET stage = 'DO_NOT_CONTACT', updated_at = ? WHERE (? IS NOT NULL AND domain = ?) OR id IN (SELECT lead_id FROM contacts WHERE value = ?)`).bind(stamp, domain, domain, value),
  ]);
  return { ok: true, value };
}

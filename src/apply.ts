import { addContact, insertLead } from "./leads.ts";
import { readSettings } from "./settings.ts";
import type { Env, Segment } from "./util.ts";
import { activity, clientIp, HttpError, isSegment, newId, nowIso, rateLimit, sha256Hex, str } from "./util.ts";

/**
 * Public franchise application form (/apply, /apply?lang=en). Spam protection: honeypot field, a signed
 * render timestamp with a minimum fill time, per-IP rate limit and a body size limit. The response never
 * echoes submitted data.
 */

const MIN_FILL_MS = 4000;
const MAX_FORM_AGE_MS = 6 * 3_600_000;

type Lang = "id" | "en";

const T = {
  id: {
    title: "Daftar Mitra Franchise JAAD Cafe",
    intro: "Isi formulir ini dan tim kami akan menghubungi Anda.",
    company: "Nama perusahaan / usaha", contact: "Nama Anda", email: "Email", phone: "WhatsApp / telepon",
    country: "Negara", city: "Kota", type: "Anda adalah", capital: "Perkiraan modal", location: "Sudah punya lokasi?",
    message: "Pesan (opsional)", consent: "Saya setuju data ini disimpan dan dipakai JAAD Cafe untuk menghubungi saya terkait kemitraan.",
    submit: "Kirim pendaftaran", chat: "Chat WhatsApp dengan tim kami", chatText: "Halo, saya baru saja mendaftar sebagai calon mitra franchise JAAD Cafe.", thanks: "Terima kasih! Pendaftaran Anda sudah kami terima. Tim kami akan menghubungi Anda.",
    error: "Pendaftaran belum bisa dikirim. Mohon periksa isian dan coba lagi.", slow: "Terlalu banyak percobaan. Coba lagi nanti.",
    types: { FNB_OPERATOR: "Pengusaha F&B / pemilik kafe atau resto", MASTER_FRANCHISE: "Investor / grup usaha (multi-outlet atau wilayah)", PROPERTY_OWNER: "Pemilik / pengelola lokasi atau properti" },
    capitals: ["< Rp 250 juta", "Rp 250 - 500 juta", "Rp 500 juta - 1 miliar", "> Rp 1 miliar", "Belum tahu"],
    locations: ["Sudah punya", "Sedang mencari", "Belum"],
    defaultCountry: "ID",
  },
  en: {
    title: "Become a JAAD Cafe Franchise Partner",
    intro: "Fill in this form and our team will get in touch.",
    company: "Company name", contact: "Your name", email: "Email", phone: "WhatsApp / phone",
    country: "Country (2-letter code, e.g. MY)", city: "City", type: "You are", capital: "Estimated budget", location: "Do you have a location?",
    message: "Message (optional)", consent: "I agree that JAAD Cafe stores this data and uses it to contact me about a partnership.",
    submit: "Submit application", chat: "Chat with our team on WhatsApp", chatText: "Hello, I have just applied to become a JAAD Cafe franchise partner.", thanks: "Thank you! We have received your application and our team will contact you.",
    error: "We could not submit your application. Please check the form and try again.", slow: "Too many attempts. Please try again later.",
    types: { FNB_OPERATOR: "F&B operator / cafe or restaurant owner", MASTER_FRANCHISE: "Investor / business group (multi-unit or master franchise)", PROPERTY_OWNER: "Property or location owner / manager" },
    capitals: ["< USD 50k", "USD 50k - 150k", "USD 150k - 500k", "> USD 500k", "Not sure yet"],
    locations: ["Yes", "Looking for one", "Not yet"],
    defaultCountry: "",
  },
} as const;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function sign(env: Env, value: string): Promise<string> {
  return (await sha256Hex(`${env.SESSION_SECRET || "unsigned"}|apply|${value}`)).slice(0, 24);
}

function page(lang: Lang, inner: string): Response {
  const t = T[lang];
  return new Response(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.title)}</title><link rel="stylesheet" href="/apply.css"></head><body><main class="apply"><h1>${esc(t.title)}</h1>${inner}
<p class="lang"><a href="/apply?lang=id">Bahasa Indonesia</a> · <a href="/apply?lang=en">English</a></p></main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'" },
  });
}

export async function renderApply(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const lang: Lang = new URL(request.url).searchParams.get("lang") === "en" ? "en" : "id";
  const t = T[lang];
  const ts = String(now);
  const option = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`;
  return page(lang, `<p>${esc(t.intro)}</p>
<form method="post" action="/apply?lang=${lang}" class="form">
<input type="hidden" name="ts" value="${ts}"><input type="hidden" name="sig" value="${await sign(env, ts)}"><input type="hidden" name="lang" value="${lang}">
<div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>${esc(t.company)}<input name="company" required maxlength="160"></label>
<label>${esc(t.contact)}<input name="contact_name" required maxlength="120" autocomplete="name"></label>
<label>${esc(t.email)}<input name="email" type="email" required maxlength="160" autocomplete="email"></label>
<label>${esc(t.phone)}<input name="phone" type="tel" maxlength="40" autocomplete="tel"></label>
<label>${esc(t.country)}<input name="country" required maxlength="2" minlength="2" pattern="[A-Za-z]{2}" value="${t.defaultCountry}"></label>
<label>${esc(t.city)}<input name="city" maxlength="80"></label>
<label>${esc(t.type)}<select name="partner_type" required>${Object.entries(t.types).map(([v, l]) => option(v, l)).join("")}</select></label>
<label>${esc(t.capital)}<select name="capital_range">${t.capitals.map(c => option(c, c)).join("")}</select></label>
<label>${esc(t.location)}<select name="has_location">${t.locations.map(c => option(c, c)).join("")}</select></label>
<label>${esc(t.message)}<textarea name="message" rows="4" maxlength="1500"></textarea></label>
<label class="check"><input type="checkbox" name="consent" value="yes" required> ${esc(t.consent)}</label>
<button type="submit">${esc(t.submit)}</button>
</form>`);
}

export async function submitApply(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const urlLang: Lang = new URL(request.url).searchParams.get("lang") === "en" ? "en" : "id";
  const fail = (lang: Lang, status: number, msg: string) => {
    const res = page(lang, `<p class="error">${esc(msg)}</p><p><a href="/apply?lang=${lang}">←</a></p>`);
    return new Response(res.body, { status, headers: res.headers });
  };
  const raw = await request.text();
  if (raw.length > 12_000) return fail(urlLang, 413, T[urlLang].error);
  const form = new URLSearchParams(raw);
  const lang: Lang = form.get("lang") === "en" ? "en" : urlLang;
  const t = T[lang];
  const ipHash = (await sha256Hex(clientIp(request))).slice(0, 16);
  if (!(await rateLimit(env.DB, `apply:${ipHash}`, 5, 3_600_000, now))) return fail(lang, 429, t.slow);

  // Bots: silently accept honeypot hits and too-fast submissions without storing anything.
  const ts = Number(form.get("ts"));
  const validSig = form.get("sig") === await sign(env, String(form.get("ts") ?? ""));
  if (form.get("website") || !validSig || !Number.isFinite(ts) || now - ts < MIN_FILL_MS || now - ts > MAX_FORM_AGE_MS) {
    return page(lang, `<p class="ok">${esc(t.thanks)}</p>`);
  }

  const company = str(form.get("company"), 160);
  const contactName = str(form.get("contact_name"), 120);
  const email = str(form.get("email"), 160).toLowerCase();
  const phone = str(form.get("phone"), 40);
  const country = str(form.get("country"), 2).toUpperCase();
  const city = str(form.get("city"), 80);
  const partnerType = str(form.get("partner_type"), 40);
  if (!company || !contactName || !/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i.test(email) || !/^[A-Z]{2}$/.test(country) || !isSegment(partnerType) || form.get("consent") !== "yes") {
    return fail(lang, 400, t.error);
  }
  const segment = partnerType as Segment;
  const stamp = nowIso(now);
  try {
    const inserted = await insertLead(env.DB, { segment, name: company, country, city, source: "APPLY_FORM", sourceRef: `apply:${newId()}`, notes: "" }, now);
    const leadId = inserted.status === "suppressed" ? null : inserted.id;
    await env.DB.prepare(
      `INSERT INTO inquiries (id, lead_id, company, contact_name, email, phone, country, city, partner_type, capital_range, has_location, message, language, consent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId(), leadId, company, contactName, email, phone, country, city, segment, str(form.get("capital_range"), 60), str(form.get("has_location"), 60), str(form.get("message"), 1500), lang, stamp, stamp).run();
    if (leadId) {
      await addContact(env.DB, leadId, "EMAIL", email, "apply form", now).catch(() => undefined);
      if (phone) await addContact(env.DB, leadId, "PHONE", phone, "apply form", now).catch(() => undefined);
      await activity(env.DB, leadId, "INQUIRY", `Form pendaftaran (${lang})`, now);
    }
  } catch (error) {
    if (error instanceof HttpError) return fail(lang, 400, t.error);
    throw error;
  }
  return thanks(env, lang);
}

async function thanks(env: Env, lang: Lang): Promise<Response> {
  const t = T[lang];
  const number = (await readSettings(env.DB)).profile.whatsapp_number.replace(/\D/g, "");
  const chat = number ? `<p><a class="wa" href="https://wa.me/${number}?text=${encodeURIComponent(t.chatText)}" rel="noopener">${esc(t.chat)}</a></p>` : "";
  return page(lang, `<p class="ok">${esc(t.thanks)}</p>${chat}`);
}

import { nameKey } from "./util.ts";

/**
 * Website verification. Reads at most one robots.txt and one homepage per company, bounded in size,
 * extracts only business-level facts (title, generic company inboxes, company phone / WhatsApp, keyword
 * signals). Named-person emails are deliberately ignored.
 */

export const USER_AGENT = "JAADFranchiseLeads/0.1 (B2B partner research)";
const MAX_BYTES = 250_000;

export interface SiteFacts {
  status: "VERIFIED" | "REVIEW" | "FAILED" | "BLOCKED_ROBOTS";
  finalUrl: string;
  title: string;
  description: string;
  emails: string[];
  phones: string[];
  whatsapp: string[];
  signals: string[];
  reason: string;
}

const GENERIC_EMAIL_PREFIXES = [
  "info", "hello", "halo", "contact", "kontak", "cs", "customerservice", "marketing", "partnership", "partners", "partner",
  "franchise", "franchising", "kemitraan", "business", "bisnis", "bizdev", "sales", "admin", "office", "enquiries",
  "enquiry", "inquiry", "inquiries", "leasing", "tenant", "tenancy", "corporate", "cafe", "reservations", "reservation",
];

export const SIGNAL_PATTERNS: Record<string, RegExp> = {
  franchise: /\b(franchis\w*|waralaba|kemitraan|master franchise|area developer|license partner)\b/i,
  multi_outlet: /\b(outlets?|branches|cabang|gerai|locations|our stores|store locator)\b/i,
  multi_brand: /\b(our brands|portfolio of brands|brand portfolio|multi[- ]brand|brands we operate|group of companies)\b/i,
  fnb: /\b(cafe|café|coffee|kopi|restaurant|restoran|f&b|food and beverage|food & beverage|bakery|kuliner)\b/i,
  hospitality: /\b(hotel|resort|hospitality)\b/i,
  leasing: /\b(leasing|tenant|tenancy|sewa|space for rent|retail space|commercial space)\b/i,
  investment: /\b(invest\w*|investor|holding|capital|ventures)\b/i,
};

export function robotsAllows(robotsTxt: string, path = "/"): boolean {
  let applies = false;
  let sawAgent = false;
  const disallows: string[] = [];
  const allows: string[] = [];
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!sawAgent) applies = false;
      sawAgent = true;
      const agent = value.toLowerCase();
      if (agent === "*" || agent.includes("jaadfranchiseleads")) applies = true;
    } else {
      sawAgent = false;
      if (!applies) continue;
      if (field === "disallow" && value) disallows.push(value);
      if (field === "allow" && value) allows.push(value);
    }
  }
  const longest = (rules: string[]) => Math.max(-1, ...rules.filter(r => path.startsWith(r.replace(/\*.*$/, ""))).map(r => r.length));
  const d = longest(disallows);
  return d < 0 || longest(allows) >= d;
}

async function readBounded(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, merged.length - offset));
    merged.set(slice, offset);
    offset += slice.length;
  }
  return new TextDecoder().decode(merged);
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");

export function extractFacts(html: string, name: string, domain: string, country = "ID"): Omit<SiteFacts, "status" | "finalUrl" | "reason"> & { identityMatch: boolean } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const description = decodeEntities(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ?? "").trim().slice(0, 300);
  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

  const emails = new Set<string>();
  for (const m of html.matchAll(/(?:mailto:)?([a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const email = m[1].toLowerCase();
    const [local, host] = email.split("@");
    const prefix = local.replace(/[._-].*$/, "");
    if (!GENERIC_EMAIL_PREFIXES.includes(prefix) && !GENERIC_EMAIL_PREFIXES.includes(local)) continue;
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/.test(host)) continue;
    emails.add(email);
  }
  const whatsapp = new Set<string>();
  for (const m of html.matchAll(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{8,15})/gi)) whatsapp.add(normalizePhone(m[1].startsWith("+") ? m[1] : `+${m[1]}`, country));
  const phones = new Set<string>();
  for (const m of html.matchAll(/href=["']tel:([+\d\s().-]{8,24})["']/gi)) phones.add(normalizePhone(m[1], country));

  const haystack = `${title} ${description} ${text.slice(0, 60_000)}`;
  const signals = Object.entries(SIGNAL_PATTERNS).filter(([, re]) => re.test(haystack)).map(([key]) => key);

  const tokens = nameKey(name).split(" ").filter(t => t.length >= 3 && !STOP_TOKENS.has(t));
  const titleKey = nameKey(`${title} ${description}`);
  const domainKey = domain.replace(/\.[a-z.]+$/, "").replace(/[^a-z0-9]/g, "");
  const identityMatch = tokens.length === 0
    ? false
    : tokens.some(t => titleKey.includes(t) || domainKey.includes(t));

  return { title, description, emails: [...emails].slice(0, 5), phones: [...phones].filter(Boolean).slice(0, 3), whatsapp: [...whatsapp].filter(Boolean).slice(0, 3), signals, identityMatch };
}

const STOP_TOKENS = new Set(["the", "and", "cafe", "coffee", "kopi", "resto", "restaurant", "group", "hotel", "mall", "plaza", "pt", "cv", "tbk", "sdn", "bhd", "llc", "ltd", "inc", "co"]);

const CALLING_CODES: Record<string, string> = {
  ID: "62", MY: "60", SG: "65", BN: "673", TH: "66", PH: "63", VN: "84", AE: "971", SA: "966", QA: "974", KW: "965",
  BH: "973", OM: "968", JP: "81", KR: "82", AU: "61", NZ: "64", GB: "44", US: "1", NL: "31", DE: "49", TR: "90", EG: "20",
};

/** E.164-style number. A national number (leading 0) is only converted when the country is known. */
export function normalizePhone(raw: string, country = "ID"): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits || digits.replace(/\D/g, "").length < 8) return "";
  if (digits.startsWith("+")) return `+${digits.slice(1).replace(/\D/g, "")}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) {
    const code = CALLING_CODES[country.toUpperCase()];
    return code ? `+${code}${digits.slice(1)}` : "";
  }
  return `+${digits}`;
}

export async function verifySite(website: string, name: string, country = "ID", fetcher: typeof fetch = fetch): Promise<SiteFacts> {
  const empty = { title: "", description: "", emails: [], phones: [], whatsapp: [], signals: [] };
  let origin: URL;
  try {
    origin = new URL(website);
    if (origin.protocol !== "https:" && origin.protocol !== "http:") throw new Error("scheme");
  } catch {
    return { ...empty, status: "FAILED", finalUrl: website, reason: "invalid_url" };
  }
  const headers = { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9" };
  try {
    const robots = await fetcher(`${origin.origin}/robots.txt`, { headers, redirect: "follow" });
    if (robots.ok) {
      const body = await readBounded(robots, 64_000);
      if (!robotsAllows(body, origin.pathname || "/")) return { ...empty, status: "BLOCKED_ROBOTS", finalUrl: website, reason: "robots_disallow" };
    }
  } catch {
    // robots.txt unreachable: treat like absent, the homepage fetch decides.
  }
  try {
    const page = await fetcher(website, { headers, redirect: "follow" });
    if (!page.ok) return { ...empty, status: "FAILED", finalUrl: website, reason: `http_${page.status}` };
    const type = page.headers.get("content-type") || "";
    if (type && !/html|text/i.test(type)) return { ...empty, status: "FAILED", finalUrl: page.url || website, reason: "not_html" };
    const html = await readBounded(page);
    const finalUrl = page.url || website;
    const domain = new URL(finalUrl).hostname.replace(/^www\./, "");
    const facts = extractFacts(html, name, domain, country);
    const { identityMatch, ...rest } = facts;
    return { ...rest, status: identityMatch ? "VERIFIED" : "REVIEW", finalUrl, reason: identityMatch ? "identity_match" : "identity_unclear" };
  } catch (error) {
    return { ...empty, status: "FAILED", finalUrl: website, reason: `fetch_error:${String((error as Error).message || error).slice(0, 80)}` };
  }
}

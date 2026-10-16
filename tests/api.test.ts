import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { scheduled } from "../src/index.ts";
import { html, mockFetch, ORIGIN, PASSWORD, world } from "./support/world.ts";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

const osm = (elements: unknown[]) => () => new Response(JSON.stringify({ elements }), { headers: { "content-type": "application/json" } });
const OSM_FNB = [
  { type: "node", id: 1, tags: { name: "Kopi Satu Kemang", amenity: "cafe", operator: "Kopi Satu Group", website: "https://kopisatu.example" } },
  { type: "node", id: 2, tags: { name: "Kopi Satu Senopati", amenity: "cafe", operator: "Kopi Satu Group" } },
  { type: "node", id: 3, tags: { name: "Kopi Satu Bintaro", amenity: "cafe", operator: "Kopi Satu Group" } },
  { type: "node", id: 4, tags: { name: "Roti Dua", amenity: "cafe", website: "https://rotidua.example" } },
];
const KOPI_SATU_HOME = `<title>Kopi Satu Group - Coffee chain</title><body>We run 3 outlets in Jakarta. Franchise and kemitraan: franchise@kopisatu.example, owner.name@kopisatu.example
<a href="https://wa.me/6281111111111">WhatsApp</a></body>`;

function sites(extra: Record<string, (url: string) => Response> = {}) {
  return {
    "https://overpass.test/api": osm(OSM_FNB),
    "https://kopisatu.example/robots.txt": () => new Response("User-agent: *\nDisallow: /admin", { headers: { "content-type": "text/plain" } }),
    "https://kopisatu.example": () => html(KOPI_SATU_HOME),
    "https://rotidua.example/robots.txt": () => new Response("User-agent: *\nDisallow: /", { headers: { "content-type": "text/plain" } }),
    "https://rotidua.example": () => html("<title>Roti Dua</title>"),
    ...extra,
  };
}

async function discoveredAndVerified() {
  const w = await world();
  const net = mockFetch(sites());
  restore = net.restore;
  await w.loginOk();
  const d = await w.api("POST", "/api/discovery/run", { segment: "FNB_OPERATOR", country: "ID", city: "Jakarta" });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const v = await w.api("POST", "/api/verify/run", { limit: 10 });
  assert.equal(v.status, 200);
  const kopi = w.row("SELECT * FROM leads WHERE name = 'Kopi Satu Group'");
  return { w, net, d, v, kopi };
}

test("operator API refuses requests without a session, wrong passwords and cross-site writes", async () => {
  const w = await world();
  assert.equal((await w.api("GET", "/api/leads")).status, 401);
  assert.equal((await w.api("POST", "/api/login", { password: "nope" }, { auth: false })).status, 401);
  await w.loginOk();
  assert.equal((await w.api("GET", "/api/leads")).status, 200);
  const cross = await w.api("POST", "/api/leads", { segment: "FNB_OPERATOR", name: "X", country: "ID" }, { headers: { origin: "https://evil.example" } });
  assert.equal(cross.status, 403);
  const tampered = await world();
  const res = await tampered.api("GET", "/api/leads", undefined, { headers: { cookie: "jfl_session=op.99999999999999.forged" } });
  assert.equal(res.status, 401);
});

test("login is rate limited per IP and fails closed when secrets are missing", async () => {
  const w = await world();
  for (let i = 0; i < 5; i++) assert.equal((await w.api("POST", "/api/login", { password: "bad" }, { auth: false })).status, 401);
  assert.equal((await w.api("POST", "/api/login", { password: PASSWORD }, { auth: false })).status, 429);
  const unconfigured = await world({ OPERATOR_PASSWORD: undefined });
  assert.equal((await unconfigured.api("POST", "/api/login", { password: PASSWORD }, { auth: false })).status, 503);
  assert.equal((await unconfigured.api("GET", "/api/session", undefined, { auth: false })).data.configured, false);
});

test("discovery stores evidenced candidates once; a second run only finds duplicates", async () => {
  const { w, d } = await discoveredAndVerified();
  assert.deepEqual([d.data.found, d.data.inserted, d.data.duplicates], [2, 2, 0]);
  const again = await w.api("POST", "/api/discovery/run", { segment: "FNB_OPERATOR", country: "ID", city: "Jakarta" });
  assert.deepEqual([again.data.inserted, again.data.duplicates], [0, 2]);
  assert.equal(w.row("SELECT COUNT(*) AS n FROM leads").n, 2);
  assert.ok(w.row("SELECT COUNT(*) AS n FROM evidence WHERE kind = 'DISCOVERED' AND source_url LIKE 'https://www.openstreetmap.org/%'").n >= 2);
  const run = w.row("SELECT * FROM runs ORDER BY started_at LIMIT 1");
  assert.equal(run.status, "DONE");
});

test("verification respects robots.txt, keeps generic inboxes only and qualifies evidenced leads", async () => {
  const { w, v, kopi, net } = await discoveredAndVerified();
  assert.deepEqual(v.data, { checked: 2, verified: 1, review: 0, failed: 0, blocked: 1 });
  assert.equal(kopi.verification, "VERIFIED");
  assert.equal(kopi.stage, "QUALIFIED");
  assert.ok(kopi.quality_score >= 50 && kopi.confidence_score >= 60);
  const contacts = w.rows("SELECT kind, value FROM contacts WHERE lead_id = ? ORDER BY kind", kopi.id);
  assert.deepEqual(contacts.map(c => c.value), ["franchise@kopisatu.example", "+6281111111111"]);
  const roti = w.row("SELECT * FROM leads WHERE name = 'Roti Dua'");
  assert.equal(roti.verification, "BLOCKED_ROBOTS");
  assert.ok(!net.calls.some(c => c.url === "https://rotidua.example"), "homepage not fetched when robots disallows");
  const detail = await w.api("GET", `/api/leads/${kopi.id}`);
  assert.ok(Array.isArray(detail.data.lead.score_reasons) && detail.data.evidence.length >= 2);
});

test("email outreach: profile required, approval required, switch + Gmail required, sent exactly once", async () => {
  const { w, kopi } = await discoveredAndVerified();
  const incomplete = await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "EMAIL" });
  assert.equal(incomplete.status, 409);
  assert.match(incomplete.data.error, /profile_incomplete:sender_name,pitch_id/);

  await w.api("PATCH", "/api/settings", { profile: { sender_name: "Rina", pitch_id: "JAAD Cafe adalah kafe kopi.", local_url: "javascript:alert(1)" } });
  assert.equal(w.row("SELECT value FROM settings WHERE key = 'profile'").value.includes("javascript"), false);
  const draft = await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "EMAIL" });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.data.to, "franchise@kopisatu.example");
  assert.equal((await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "EMAIL" })).status, 409, "one open draft per channel");

  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/send`)).data.error, "draft_not_approved");
  await w.api("PATCH", `/api/drafts/${draft.data.id}`, { body: "Halo {{nama}}" });
  assert.match((await w.api("POST", `/api/drafts/${draft.data.id}/approve`)).data.error, /unfilled_placeholder/);
  await w.api("PATCH", `/api/drafts/${draft.data.id}`, { body: "Halo tim Kopi Satu, ini JAAD Cafe. Balas STOP untuk berhenti." });
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/approve`)).status, 200);
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/send`)).data.error, "outreach_disabled");
  await w.api("PATCH", "/api/settings", { outreach_enabled: true });
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/send`)).data.error, "gmail_not_configured");

  Object.assign(w.env, { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", GMAIL_REFRESH_TOKEN: "rt", GMAIL_SENDER: "rina@jaad.example" });
  restore?.();
  const net = mockFetch({
    "https://oauth2.googleapis.com/token": () => Response.json({ access_token: "at" }),
    "https://gmail.googleapis.com/": () => Response.json({ id: "gmail-1" }),
  });
  restore = net.restore;
  const sent = await w.api("POST", `/api/drafts/${draft.data.id}/send`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(net.calls.filter(c => c.url.startsWith("https://gmail.googleapis.com/")).length, 1);
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/send`)).status, 409, "never sent twice");
  assert.equal(w.row("SELECT stage FROM leads WHERE id = ?", kopi.id).stage, "CONTACTED");
  assert.equal(w.row("SELECT status FROM drafts WHERE id = ?", draft.data.id).status, "SENT");
});

test("daily cap, suppression and closed stages block sending", async () => {
  const { w, kopi } = await discoveredAndVerified();
  Object.assign(w.env, { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "cs", GMAIL_REFRESH_TOKEN: "rt", GMAIL_SENDER: "rina@jaad.example" });
  await w.api("PATCH", "/api/settings", { outreach_enabled: true, daily_email_cap: 0, profile: { sender_name: "Rina", pitch_id: "JAAD Cafe adalah kafe kopi." } });
  const draft = await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "EMAIL" });
  await w.api("POST", `/api/drafts/${draft.data.id}/approve`);
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/send`)).data.error, "daily_cap_reached");

  const sup = await w.api("POST", "/api/suppression", { value: "kopisatu.example", reason: "replied STOP" });
  assert.equal(sup.status, 200);
  assert.equal(w.row("SELECT status FROM drafts WHERE id = ?", draft.data.id).status, "CANCELLED");
  assert.equal(w.row("SELECT stage FROM leads WHERE id = ?", kopi.id).stage, "DO_NOT_CONTACT");
  assert.equal((await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "WHATSAPP" })).data.error, "lead_closed");
  const dup = await w.api("POST", "/api/leads", { segment: "FNB_OPERATOR", name: "Kopi Satu Lagi", country: "ID", website: "https://kopisatu.example" });
  assert.equal(dup.data.status, "suppressed");
});

test("WhatsApp drafts become a wa.me link and are only recorded as sent by the operator", async () => {
  const { w, kopi } = await discoveredAndVerified();
  await w.api("PATCH", "/api/settings", { profile: { sender_name: "Rina", pitch_id: "JAAD Cafe adalah kafe kopi." } });
  const draft = await w.api("POST", `/api/leads/${kopi.id}/drafts`, { channel: "WHATSAPP" });
  assert.equal(draft.status, 201);
  const list = await w.api("GET", "/api/drafts?status=DRAFT");
  assert.match(list.data[0].wa_link, /^https:\/\/wa\.me\/6281111111111\?text=/);
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/whatsapp-sent`)).data.error, "draft_not_approved");
  await w.api("POST", `/api/drafts/${draft.data.id}/approve`);
  assert.equal((await w.api("POST", `/api/drafts/${draft.data.id}/whatsapp-sent`)).status, 200);
  assert.equal(w.row("SELECT stage FROM leads WHERE id = ?", kopi.id).stage, "CONTACTED");
});

function formBody(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

async function applyForm(w: Awaited<ReturnType<typeof world>>) {
  const page = await w.api("GET", "/apply?lang=en", undefined, { auth: false });
  const ts = /name="ts" value="(\d+)"/.exec(page.data)![1];
  const sig = /name="sig" value="([a-f0-9]+)"/.exec(page.data)![1];
  return { ts, sig, page };
}

test("public application form: bots are ignored, valid applications create an inquiry and a lead", async () => {
  const w = await world();
  const { ts, sig, page } = await applyForm(w);
  assert.equal(page.status, 200);
  assert.match(page.data, /<form method="post" action="\/apply\?lang=en"/);
  const base = { ts, sig, lang: "en", company: "Gulf Bean Holdings", contact_name: "Sam", email: "sam@gulfbean.example", phone: "+971 50 123 4567", country: "ae", city: "Dubai", partner_type: "MASTER_FRANCHISE", consent: "yes" };
  const post = (fields: Record<string, string>) => w.api("POST", "/apply?lang=en", formBody(fields), { auth: false, headers: { "content-type": "application/x-www-form-urlencoded" } });

  const tooFast = await post(base);
  assert.equal(tooFast.status, 200);
  assert.equal(w.row("SELECT COUNT(*) AS n FROM inquiries").n, 0, "submitted within the minimum fill time");

  const old = String(Number(ts) - 10_000);
  const forged = await post({ ...base, ts: old });
  assert.equal(forged.status, 200);
  assert.equal(w.row("SELECT COUNT(*) AS n FROM inquiries").n, 0, "timestamp without a matching signature is ignored");

  // A form rendered 10 s ago carries a correctly signed timestamp that has passed the minimum fill time.
  const { renderApply } = await import("../src/apply.ts");
  const pastPage = await (await renderApply(new Request(`${ORIGIN}/apply?lang=en`), w.env, Date.now() - 10_000)).text();
  const pastTs = /name="ts" value="(\d+)"/.exec(pastPage)![1];
  const pastSig = /name="sig" value="([a-f0-9]+)"/.exec(pastPage)![1];
  const honeypot = await post({ ...base, ts: pastTs, sig: pastSig, website: "http://spam.example" });
  assert.equal(honeypot.status, 200);
  assert.equal(w.row("SELECT COUNT(*) AS n FROM inquiries").n, 0);

  assert.equal((await post({ ...base, ts: pastTs, sig: pastSig, consent: "" })).status, 400);
  const ok = await post({ ...base, ts: pastTs, sig: pastSig });
  assert.equal(ok.status, 200);
  assert.doesNotMatch(ok.data, /Gulf Bean|sam@gulfbean/);
  const inquiry = w.row("SELECT * FROM inquiries");
  assert.equal(inquiry.country, "AE");
  const lead = w.row("SELECT * FROM leads WHERE id = ?", inquiry.lead_id);
  assert.deepEqual([lead.segment, lead.market, lead.source, lead.stage], ["MASTER_FRANCHISE", "GLOBAL", "APPLY_FORM", "QUALIFIED"]);
  assert.deepEqual(w.rows("SELECT value FROM contacts WHERE lead_id = ? ORDER BY kind", lead.id).map(c => c.value), ["sam@gulfbean.example", "+971501234567"]);
});

test("public form is rate limited per IP", async () => {
  const w = await world();
  const { renderApply } = await import("../src/apply.ts");
  const pastPage = await (await renderApply(new Request(`${ORIGIN}/apply`), w.env, Date.now() - 10_000)).text();
  const ts = /name="ts" value="(\d+)"/.exec(pastPage)![1];
  const sig = /name="sig" value="([a-f0-9]+)"/.exec(pastPage)![1];
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await w.api("POST", "/apply", formBody({ ts, sig, company: `Usaha ${i}`, contact_name: "A", email: `a${i}@usaha.example`, country: "ID", partner_type: "FNB_OPERATOR", consent: "yes" }), { auth: false, headers: { "content-type": "application/x-www-form-urlencoded" } });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test("CSV import dedupes and export neutralises spreadsheet formulas", async () => {
  const w = await world();
  await w.loginOk();
  const csv = "segment,name,country,city,website,email,notes\nPROPERTY_OWNER,Mall Satu,ID,Bandung,https://mallsatu.example,leasing@mallsatu.example,\n,=HYPERLINK(\"x\"),MY,Penang,,,\n,Mall Satu,ID,Bandung,,,dup\n,No Country,,,,,\n";
  const res = await w.api("POST", "/api/leads/import", { csv, segment: "FNB_OPERATOR" });
  assert.deepEqual(res.data, { rows: 4, inserted: 2, duplicates: 1, invalid: 1, suppressed: 0 });
  const exported = await w.api("GET", "/api/leads/export.csv");
  assert.match(exported.headers.get("content-type") || "", /text\/csv/);
  assert.match(exported.data, /'=HYPERLINK/);
  assert.match(exported.data, /leasing@mallsatu\.example/);
});

test("cron jobs do nothing until switched on, then run one target and a verify batch", async () => {
  const w = await world();
  const net = mockFetch(sites());
  restore = net.restore;
  await w.loginOk();
  await w.api("POST", "/api/targets", { segment: "FNB_OPERATOR", country: "ID", city: "Jakarta" });
  assert.deepEqual(await scheduled(w.env), {});
  assert.equal(net.calls.length, 0);
  await w.api("PATCH", "/api/settings", { auto_discovery_enabled: true, auto_verify_enabled: true });
  const out = await scheduled(w.env) as { discovery: { inserted: number }; verify: { checked: number } };
  assert.equal(out.discovery.inserted, 2);
  assert.equal(out.verify.checked, 2);
  assert.ok(w.row("SELECT last_run_at FROM targets").last_run_at);
});

test("dashboard summarises the funnel", async () => {
  const { w } = await discoveredAndVerified();
  const res = await w.api("GET", "/api/dashboard");
  assert.equal(res.status, 200);
  assert.equal(res.data.byStage.QUALIFIED, 1);
  assert.equal(res.data.byMarket.LOCAL, 2);
  assert.equal(res.data.gmailConfigured, false);
  assert.equal(res.data.settings.outreach_enabled, false);
});

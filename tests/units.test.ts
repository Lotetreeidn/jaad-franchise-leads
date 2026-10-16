import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatesFromOsm, overpassQuery } from "../src/discovery.ts";
import { buildMime, composeMessage, draftProblems, missingProfileFields, pickEmail } from "../src/outreach.ts";
import { scoreLead } from "../src/scoring.ts";
import { EMPTY_PROFILE } from "../src/settings.ts";
import { domainOf, nameKey } from "../src/util.ts";
import { extractFacts, normalizePhone, robotsAllows } from "../src/verify.ts";

const el = (id: number, tags: Record<string, string>) => ({ type: "node", id, tags });

test("overpass query strips quotes and limits country code", () => {
  const q = overpassQuery("FNB_OPERATOR", "id-x", 'Band"ung\\');
  assert.match(q, /"ISO3166-1"="ID"/);
  assert.match(q, /"name"="Bandung"/);
  assert.match(q, /amenity/);
  assert.match(overpassQuery("PROPERTY_OWNER", "MY", "Kuala Lumpur"), /shop"="mall/);
});

test("F&B candidates group outlets by operator/website, ignore social links and single venues without a site", () => {
  const elements = [
    el(1, { name: "Kopi Satu Kemang", amenity: "cafe", operator: "PT Kopi Satu" }),
    el(2, { name: "Kopi Satu Senopati", amenity: "cafe", operator: "PT Kopi Satu" }),
    el(3, { name: "Kopi Satu Bintaro", amenity: "cafe", operator: "PT Kopi Satu", website: "https://kopisatu.example" }),
    el(4, { name: "Warung Solo", amenity: "restaurant", website: "https://instagram.com/warungsolo" }),
    el(5, { name: "Roti Dua", amenity: "cafe", website: "https://rotidua.example" }),
    el(6, { amenity: "cafe" }),
  ];
  const c = candidatesFromOsm("FNB_OPERATOR", "ID", "Jakarta", elements);
  assert.equal(c.length, 2);
  assert.equal(c[0].name, "PT Kopi Satu");
  assert.equal(c[0].outletCount, 3);
  assert.equal(c[0].website, "https://kopisatu.example");
  assert.equal(c[1].name, "Roti Dua");
  assert.ok(!c.some(x => x.name.includes("Warung")), "social-only venue is not a company website");
});

test("master franchise candidates need one operator running 2+ distinct brands", () => {
  const elements = [
    el(1, { name: "Burger A", brand: "Burger A", amenity: "fast_food", operator: "Gulf Food Group" }),
    el(2, { name: "Pizza B", brand: "Pizza B", amenity: "restaurant", operator: "Gulf Food Group" }),
    el(3, { name: "Cafe C 1", brand: "Cafe C", amenity: "cafe", operator: "Solo Cafe LLC" }),
    el(4, { name: "Cafe C 2", brand: "Cafe C", amenity: "cafe", operator: "Solo Cafe LLC" }),
  ];
  const c = candidatesFromOsm("MASTER_FRANCHISE", "AE", "Dubai", elements);
  assert.deepEqual(c.map(x => [x.name, x.brandCount]), [["Gulf Food Group", 2]]);
});

test("property candidates need their own website", () => {
  const c = candidatesFromOsm("PROPERTY_OWNER", "ID", "Bandung", [
    el(1, { name: "Mall Satu", shop: "mall", website: "https://mallsatu.example" }),
    el(2, { name: "Hotel Dua", tourism: "hotel", stars: "4" }),
  ]);
  assert.deepEqual(c.map(x => [x.name, x.placeKind]), [["Mall Satu", "mall"]]);
});

test("robots.txt rules", () => {
  assert.equal(robotsAllows("User-agent: *\nDisallow: /"), false);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /admin"), true);
  assert.equal(robotsAllows("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\nAllow: /$"), false);
  assert.equal(robotsAllows(""), true);
});

test("site facts keep only generic company inboxes and detect identity and signals", () => {
  const page = `<html><head><title>Kopi Satu Group | Coffee &amp; Franchise</title><meta name="description" content="12 outlets across Jakarta"></head>
  <body>Contact info@kopisatu.example or budi.santoso@kopisatu.example or franchise@kopisatu.example. <a href="https://wa.me/6281234567890">WA</a>
  <a href="tel:021-555-1234">call</a> We have 12 outlets. Kemitraan tersedia.</body></html>`;
  const f = extractFacts(page, "PT Kopi Satu", "kopisatu.example", "ID");
  assert.deepEqual(f.emails.sort(), ["franchise@kopisatu.example", "info@kopisatu.example"]);
  assert.deepEqual(f.whatsapp, ["+6281234567890"]);
  assert.deepEqual(f.phones, ["+62215551234"]);
  assert.ok(f.signals.includes("franchise") && f.signals.includes("multi_outlet") && f.signals.includes("fnb"));
  assert.equal(f.identityMatch, true);
  assert.equal(extractFacts("<title>Something else</title>", "PT Kopi Satu", "other.example").identityMatch, false);
});

test("phone normalisation is country aware and never guesses an unknown country", () => {
  assert.equal(normalizePhone("0812-3456-7890", "ID"), "+6281234567890");
  assert.equal(normalizePhone("03-1234 5678", "MY"), "+60312345678");
  assert.equal(normalizePhone("012345678", "ZZ"), "");
  assert.equal(normalizePhone("+971 4 123 4567", "AE"), "+97141234567");
});

test("quality and confidence are separate: attractive but unverified is not qualified", () => {
  const base = { segment: "FNB_OPERATOR" as const, source: "OSM", outletCount: 8, brandCount: 3, placeKind: "cafe", signals: ["franchise", "fnb"], hasEmail: true, hasPhone: false, hasWebsite: true };
  const unverified = scoreLead({ ...base, verification: "PENDING" });
  assert.ok(unverified.quality >= 50);
  assert.ok(unverified.confidence < 60);
  assert.equal(unverified.qualified, false);
  assert.equal(scoreLead({ ...base, verification: "VERIFIED" }).qualified, true);
  assert.equal(scoreLead({ ...base, outletCount: 1, brandCount: 1, signals: [], hasEmail: false, verification: "VERIFIED" }).qualified, false);
});

test("utility identity helpers", () => {
  assert.equal(nameKey("Café  Kopi & Co."), "cafe kopi and co");
  assert.equal(domainOf("https://www.Kopi.example/path"), "kopi.example");
  assert.equal(domainOf("javascript:alert(1)"), null);
});

test("message composition uses only the owner profile and evidenced lead facts", () => {
  const profile = { ...EMPTY_PROFILE, sender_name: "Rina", sender_title: "Franchise Manager", pitch_id: "JAAD Cafe adalah kafe kopi Indonesia.", pitch_en: "JAAD Cafe is an Indonesian coffee cafe." };
  assert.deepEqual(missingProfileFields(EMPTY_PROFILE, "id", "LOCAL"), ["sender_name", "pitch_id"]);
  assert.deepEqual(missingProfileFields(profile, "en", "GLOBAL"), []);
  const lead = { name: "PT Kopi Satu", segment: "FNB_OPERATOR" as const, market: "LOCAL" as const, city: "Jakarta", country: "ID" };
  const id = composeMessage(lead, profile, "id", "EMAIL");
  assert.match(id.subject, /PT Kopi Satu/);
  assert.match(id.body, /https:\/\/jaadcafe\.com/);
  assert.match(id.body, /STOP/);
  assert.doesNotMatch(id.body, /Rp|USD|royalt|fee|ROI|BEP/i);
  const en = composeMessage({ ...lead, segment: "MASTER_FRANCHISE", market: "GLOBAL", city: "Dubai", country: "AE" }, profile, "en", "WHATSAPP");
  assert.equal(en.subject, "");
  assert.match(en.body, /global\.jaadcafe\.com/);
  assert.deepEqual(draftProblems({ subject: "Hi", body: "Hello {{name}}", channel: "EMAIL" }), ["unfilled_placeholder"]);
});

test("email selection prefers partnership inboxes; MIME is base64 and header-safe", () => {
  assert.equal(pickEmail(["info@a.example", "franchise@a.example", "sales@a.example"]), "franchise@a.example");
  const raw = buildMime("me@jaad.example", "x@a.example\r\nBcc: evil@x.example", "Kemitraan ☕", "Halo");
  const mime = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.doesNotMatch(mime, /\r\nBcc:/);
  assert.match(mime, /Subject: =\?UTF-8\?B\?/);
});

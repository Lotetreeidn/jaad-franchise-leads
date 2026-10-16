import type { Segment } from "./util.ts";
import { domainOf, nameKey, normalizeWebsite } from "./util.ts";

/**
 * Free discovery from OpenStreetMap through the public Overpass API.
 * OSM records are discovery pointers only: a candidate becomes trusted after its own website is verified.
 */

export interface Candidate {
  segment: Segment;
  name: string;
  country: string;
  city: string;
  website: string | null;
  placeKind: string;
  outletCount: number;
  brandCount: number;
  sourceRef: string;
  sourceUrl: string;
}

interface OsmElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

const FNB_AMENITIES = "cafe|restaurant|fast_food|ice_cream|food_court";

export function overpassQuery(segment: Segment, country: string, city: string, limit = 1500): string {
  const safeCountry = country.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  const safeCity = city.replace(/["\\]/g, "").trim().slice(0, 80);
  const area = `area["ISO3166-1"="${safeCountry}"][admin_level=2]->.country;\n` +
    `rel(area.country)["boundary"="administrative"]["name"="${safeCity}"];\nmap_to_area->.city;\n`;
  const body = segment === "PROPERTY_OWNER"
    ? `(nwr["shop"="mall"](area.city);nwr["tourism"="hotel"]["stars"~"^[345]"](area.city);nwr["building"="commercial"]["name"]["website"](area.city);nwr["landuse"="retail"]["name"]["website"](area.city););`
    : `nwr["amenity"~"^(${FNB_AMENITIES})$"](area.city);`;
  return `[out:json][timeout:60];\n${area}${body}\nout tags ${Math.max(1, Math.min(limit, 3000))};`;
}

const osmUrl = (el: OsmElement) => `https://www.openstreetmap.org/${el.type}/${el.id}`;

/** Tags that identify who runs a venue, most specific first. */
function operatorKey(tags: Record<string, string>): { key: string; label: string } | null {
  const operator = tags.operator?.trim();
  if (operator && operator.length > 1) return { key: `op:${nameKey(operator)}`, label: operator };
  const domain = domainOf(tags.website || tags["contact:website"]);
  if (domain && !isPlatformDomain(domain)) return { key: `web:${domain}`, label: tags.brand || tags.name || domain };
  const brand = tags.brand?.trim();
  if (brand && brand.length > 1) return { key: `brand:${nameKey(brand)}`, label: brand };
  return null;
}

/** Social and delivery platforms are not company-owned websites and never identify a company. */
const PLATFORM_DOMAINS = [
  "facebook.com", "instagram.com", "tiktok.com", "linktr.ee", "gofood.co.id", "grab.com", "food.grab.com",
  "shopee.co.id", "tokopedia.com", "wa.me", "whatsapp.com", "google.com", "goo.gl", "maps.app.goo.gl",
  "tripadvisor.com", "zomato.com", "talabat.com", "deliveroo.com", "foodpanda.com", "ubereats.com", "twitter.com", "x.com",
  "youtube.com", "linkedin.com", "wix.com", "business.site", "bit.ly",
];

export function isPlatformDomain(domain: string): boolean {
  return PLATFORM_DOMAINS.some(p => domain === p || domain.endsWith(`.${p}`));
}

function websiteOf(tags: Record<string, string>): string | null {
  const raw = tags.website || tags["contact:website"] || "";
  const domain = domainOf(raw);
  if (!domain || isPlatformDomain(domain)) return null;
  return normalizeWebsite(raw);
}

/**
 * Turns Overpass elements into company candidates.
 * - FNB_OPERATOR: venues grouped by operator / company website / brand; groups with 2+ outlets, or single venues
 *   that have their own website.
 * - MASTER_FRANCHISE: operators running 2+ distinct brands (multi-brand franchise groups) in the city.
 * - PROPERTY_OWNER: malls, 3-5 star hotels and commercial buildings that have their own website.
 */
export function candidatesFromOsm(segment: Segment, country: string, city: string, elements: OsmElement[], max = 40): Candidate[] {
  const named = elements.filter(el => el.tags?.name);
  if (segment === "PROPERTY_OWNER") {
    const out: Candidate[] = [];
    for (const el of named) {
      const tags = el.tags!;
      const website = websiteOf(tags);
      if (!website) continue;
      out.push({
        segment, name: tags.name, country, city, website,
        placeKind: tags.shop === "mall" ? "mall" : tags.tourism === "hotel" ? "hotel" : "commercial",
        outletCount: 1, brandCount: 0, sourceRef: `${el.type}/${el.id}`, sourceUrl: osmUrl(el),
      });
    }
    return rank(out).slice(0, max);
  }

  const groups = new Map<string, { label: string; venues: OsmElement[]; brands: Set<string>; website: string | null }>();
  for (const el of named) {
    const tags = el.tags!;
    const key = operatorKey(tags);
    if (!key) continue;
    const group = groups.get(key.key) ?? { label: key.label, venues: [], brands: new Set<string>(), website: null };
    group.venues.push(el);
    group.brands.add(nameKey(tags.brand || tags.name));
    group.website ||= websiteOf(tags);
    groups.set(key.key, group);
  }

  const out: Candidate[] = [];
  for (const [key, group] of groups) {
    const outlets = group.venues.length;
    const brands = group.brands.size;
    if (segment === "MASTER_FRANCHISE" && !(key.startsWith("op:") && brands >= 2)) continue;
    if (segment === "FNB_OPERATOR" && outlets < 2 && !group.website) continue;
    const first = group.venues[0];
    out.push({
      segment,
      name: group.label,
      country, city,
      website: group.website,
      placeKind: first.tags?.amenity || "fnb",
      outletCount: outlets,
      brandCount: brands,
      sourceRef: key,
      sourceUrl: osmUrl(first),
    });
  }
  return rank(out).slice(0, max);
}

function rank(list: Candidate[]): Candidate[] {
  return list.sort((a, b) => (b.brandCount - a.brandCount) || (b.outletCount - a.outletCount) || Number(Boolean(b.website)) - Number(Boolean(a.website)) || a.name.localeCompare(b.name));
}

export async function fetchOverpass(endpoint: string, query: string): Promise<OsmElement[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "JAADFranchiseLeads/0.1 (B2B partner research)" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!response.ok) throw new Error(`overpass_http_${response.status}`);
  const data = await response.json() as { elements?: OsmElement[] };
  return Array.isArray(data.elements) ? data.elements : [];
}

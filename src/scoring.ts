import type { Segment } from "./util.ts";

/**
 * Deterministic scoring. Lead quality (how attractive the partner is) and data confidence (how well the
 * facts are evidenced) are separate; a lead is only QUALIFIED when both pass.
 */

export interface ScoreInput {
  segment: Segment;
  source: string;
  verification: string;
  outletCount: number;
  brandCount: number;
  placeKind: string | null;
  signals: string[];
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
}

export interface ScoreResult {
  quality: number;
  confidence: number;
  reasons: string[];
  qualified: boolean;
}

export const QUALIFY_MIN_QUALITY = 50;
export const QUALIFY_MIN_CONFIDENCE = 60;

export function scoreLead(input: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  let quality = 0;
  const add = (points: number, reason: string) => { quality += points; reasons.push(`+${points} ${reason}`); };
  const has = (signal: string) => input.signals.includes(signal);

  if (input.segment === "FNB_OPERATOR") {
    if (input.outletCount >= 5) add(30, "5+ outlet F&B");
    else if (input.outletCount >= 2) add(20, "2-4 outlet F&B");
    else if (input.outletCount === 1) add(5, "1 outlet F&B");
    if (input.brandCount >= 2) add(15, "mengelola 2+ brand");
    if (has("franchise")) add(20, "pengalaman franchise/kemitraan");
    if (has("fnb")) add(10, "bisnis F&B terkonfirmasi di website");
    if (has("multi_outlet")) add(5, "menyebut cabang/outlet");
  } else if (input.segment === "MASTER_FRANCHISE") {
    if (input.brandCount >= 3) add(30, "grup 3+ brand");
    else if (input.brandCount >= 2) add(20, "grup 2 brand");
    if (has("franchise")) add(25, "pengalaman franchise/master franchise");
    if (has("multi_brand")) add(10, "portofolio multi-brand");
    if (input.outletCount >= 10) add(15, "10+ outlet");
    else if (input.outletCount >= 3) add(8, "3+ outlet");
    if (has("investment")) add(5, "holding/investasi");
  } else {
    if (input.placeKind === "mall") add(25, "mall");
    else if (input.placeKind === "hotel") add(15, "hotel");
    else add(10, "properti komersial");
    if (has("leasing")) add(25, "ada info leasing/tenant");
    if (has("hospitality")) add(5, "hospitality");
    if (has("fnb")) add(5, "punya area F&B");
  }
  if (input.hasEmail || input.hasPhone) add(10, "kontak bisnis tersedia");
  if (input.source === "APPLY_FORM") add(40, "daftar sendiri lewat form");

  let confidence = 0;
  const conf: string[] = [];
  const addConf = (points: number, reason: string) => { confidence += points; conf.push(`conf +${points} ${reason}`); };
  if (input.source === "OSM") addConf(20, "ditemukan di OpenStreetMap");
  if (input.source === "CSV" || input.source === "MANUAL") addConf(15, "diinput operator");
  if (input.source === "APPLY_FORM") addConf(40, "data dari pendaftar sendiri");
  if (input.verification === "VERIFIED") addConf(50, "website perusahaan cocok dengan nama");
  else if (input.verification === "REVIEW") addConf(20, "website ada tapi identitas belum jelas");
  if (input.hasEmail || input.hasPhone) addConf(20, "kontak dari sumber resmi");
  if (!input.hasWebsite && input.source !== "APPLY_FORM") conf.push("conf: tanpa website perusahaan");

  quality = Math.min(100, quality);
  confidence = Math.min(100, confidence);
  return { quality, confidence, reasons: [...reasons, ...conf], qualified: quality >= QUALIFY_MIN_QUALITY && confidence >= QUALIFY_MIN_CONFIDENCE };
}

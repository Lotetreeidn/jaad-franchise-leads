import { renderApply, submitApply } from "./apply.ts";
import { assertSameOrigin, authConfigured, hasSession, login, logoutCookie, timingSafeEqual } from "./auth.ts";
import { addContact, exportCsv, importCsv, insertLead, leadDetail, listLeads, runDiscovery, updateLead, verifyPending } from "./leads.ts";
import { addSuppression, approveDraft, cancelDraft, createDraft, editDraft, emailsSentLast24h, gmailConfigured, listDrafts, markWhatsappSent, sendEmailDraft } from "./outreach.ts";
import { ensureSchema } from "./schema.ts";
import { readSettings, writeSettings } from "./settings.ts";
import type { Env, Segment } from "./util.ts";
import { HttpError, isSegment, json, newId, nowIso, readJson, str } from "./util.ts";

type Handler = (ctx: { request: Request; env: Env; params: Record<string, string>; url: URL }) => Promise<Response>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; public?: boolean }

const routes: Route[] = [];
function route(method: string, path: string, handler: Handler, isPublic = false) {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`);
  routes.push({ method, pattern, keys, handler, public: isPublic });
}

// ---------- auth ----------
route("GET", "/api/session", async ({ request, env }) => json({ authenticated: await hasSession(request, env), configured: authConfigured(env), database: true }), true);
route("POST", "/api/login", async ({ request, env }) => {
  assertSameOrigin(request);
  const body = await readJson(request, 2000);
  const cookie = await login(request, env, str(body.password, 200));
  return json({ ok: true }, 200, { "set-cookie": cookie });
}, true);
route("POST", "/api/logout", async () => json({ ok: true }, 200, { "set-cookie": logoutCookie() }), true);

// ---------- dashboard ----------
route("GET", "/api/dashboard", async ({ env }) => {
  const db = env.DB;
  const since = nowIso(Date.now() - 7 * 86_400_000);
  const [byStage, bySegment, byMarket, byVerification, week, drafts, inquiries, runs] = await db.batch([
    db.prepare("SELECT stage AS k, COUNT(*) AS n FROM leads GROUP BY stage"),
    db.prepare("SELECT segment AS k, COUNT(*) AS n FROM leads GROUP BY segment"),
    db.prepare("SELECT market AS k, COUNT(*) AS n FROM leads GROUP BY market"),
    db.prepare("SELECT verification AS k, COUNT(*) AS n FROM leads GROUP BY verification"),
    db.prepare("SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?").bind(since),
    db.prepare("SELECT status AS k, COUNT(*) AS n FROM drafts GROUP BY status"),
    db.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE created_at >= ?").bind(since),
    db.prepare("SELECT id, kind, params, status, found, inserted, duplicates, error, started_at FROM runs ORDER BY started_at DESC LIMIT 8"),
  ]);
  const toMap = (r: D1Result) => Object.fromEntries((r.results as { k: string; n: number }[]).map(x => [x.k, Number(x.n)]));
  const settings = await readSettings(db);
  return json({
    byStage: toMap(byStage), bySegment: toMap(bySegment), byMarket: toMap(byMarket), byVerification: toMap(byVerification),
    newThisWeek: Number((week.results[0] as { n: number })?.n ?? 0), drafts: toMap(drafts),
    inquiriesThisWeek: Number((inquiries.results[0] as { n: number })?.n ?? 0), runs: runs.results,
    emailsLast24h: await emailsSentLast24h(db), settings: { ...settings, profile: undefined }, gmailConfigured: gmailConfigured(env),
  });
});

// ---------- leads ----------
route("GET", "/api/leads", async ({ env, url }) => {
  const q = url.searchParams;
  return json(await listLeads(env.DB, {
    stage: q.get("stage") || undefined, segment: q.get("segment") || undefined, market: q.get("market") || undefined,
    verification: q.get("verification") || undefined, q: str(q.get("q"), 80) || undefined,
    minQuality: Number(q.get("minQuality")) || undefined, limit: Number(q.get("limit")) || undefined, offset: Number(q.get("offset")) || undefined,
  }));
});
route("GET", "/api/leads/export.csv", async ({ env }) => new Response(await exportCsv(env.DB), {
  headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="jaad-franchise-leads-${nowIso().slice(0, 10)}.csv"`, "cache-control": "no-store" },
}));
route("POST", "/api/leads", async ({ request, env }) => {
  const body = await readJson(request);
  if (!isSegment(body.segment)) throw new HttpError(400, "invalid_segment");
  const country = str(body.country, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "invalid_country");
  const name = str(body.name, 200);
  if (!name) throw new HttpError(400, "invalid_name");
  const res = await insertLead(env.DB, { segment: body.segment, name, country, city: str(body.city, 120), website: str(body.website, 300) || null, source: "MANUAL", notes: str(body.notes, 2000) });
  return json(res, res.status === "inserted" ? 201 : 200);
});
route("POST", "/api/leads/import", async ({ request, env }) => {
  const body = await readJson(request, 450_000);
  const segment: Segment = isSegment(body.segment) ? body.segment : "FNB_OPERATOR";
  return json(await importCsv(env.DB, typeof body.csv === "string" ? body.csv : "", segment));
});
route("GET", "/api/leads/:id", async ({ env, params }) => json(await leadDetail(env.DB, params.id)));
route("PATCH", "/api/leads/:id", async ({ request, env, params }) => json(await updateLead(env.DB, params.id, await readJson(request))));
route("POST", "/api/leads/:id/contacts", async ({ request, env, params }) => {
  const body = await readJson(request);
  return json(await addContact(env.DB, params.id, str(body.kind, 20), str(body.value, 200), str(body.source_url, 500)));
});
route("POST", "/api/leads/:id/drafts", async ({ request, env, params }) => {
  const body = await readJson(request);
  return json(await createDraft(env, params.id, str(body.channel, 20) as "EMAIL" | "WHATSAPP"), 201);
});

// ---------- discovery & verification ----------
route("POST", "/api/discovery/run", async ({ request, env }) => {
  const body = await readJson(request);
  if (!isSegment(body.segment)) throw new HttpError(400, "invalid_segment");
  return json(await runDiscovery(env, { segment: body.segment, country: str(body.country, 2), city: str(body.city, 80), max: Number(body.max) || undefined }));
});
route("POST", "/api/verify/run", async ({ request, env }) => {
  const body = await readJson(request);
  return json(await verifyPending(env, Number(body.limit) || 10));
});
route("GET", "/api/runs", async ({ env }) => json((await env.DB.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 50").all()).results));
route("GET", "/api/targets", async ({ env }) => json((await env.DB.prepare("SELECT * FROM targets ORDER BY country, city, segment LIMIT 500").all()).results));
route("POST", "/api/targets", async ({ request, env }) => {
  const body = await readJson(request);
  if (!isSegment(body.segment)) throw new HttpError(400, "invalid_segment");
  const country = str(body.country, 2).toUpperCase();
  const city = str(body.city, 80);
  if (!/^[A-Z]{2}$/.test(country) || !city) throw new HttpError(400, "invalid_target");
  await env.DB.prepare("INSERT INTO targets (id, segment, country, city, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING")
    .bind(newId(), body.segment, country, city, nowIso()).run();
  return json({ ok: true }, 201);
});
route("PATCH", "/api/targets/:id", async ({ request, env, params }) => {
  const body = await readJson(request);
  await env.DB.prepare("UPDATE targets SET enabled = ? WHERE id = ?").bind(body.enabled ? 1 : 0, params.id).run();
  return json({ ok: true });
});
route("DELETE", "/api/targets/:id", async ({ env, params }) => {
  await env.DB.prepare("DELETE FROM targets WHERE id = ?").bind(params.id).run();
  return json({ ok: true });
});

// ---------- outreach ----------
route("GET", "/api/drafts", async ({ env, url }) => json(await listDrafts(env.DB, url.searchParams.get("status") || undefined)));
route("PATCH", "/api/drafts/:id", async ({ request, env, params }) => json(await editDraft(env.DB, params.id, await readJson(request))));
route("POST", "/api/drafts/:id/approve", async ({ env, params }) => json(await approveDraft(env.DB, params.id)));
route("POST", "/api/drafts/:id/cancel", async ({ env, params }) => json(await cancelDraft(env.DB, params.id)));
route("POST", "/api/drafts/:id/send", async ({ env, params }) => json(await sendEmailDraft(env, params.id)));
route("POST", "/api/drafts/:id/whatsapp-sent", async ({ env, params }) => json(await markWhatsappSent(env.DB, params.id)));
route("GET", "/api/suppression", async ({ env }) => json((await env.DB.prepare("SELECT * FROM suppression ORDER BY created_at DESC LIMIT 500").all()).results));
route("POST", "/api/suppression", async ({ request, env }) => {
  const body = await readJson(request);
  return json(await addSuppression(env.DB, str(body.value, 200), str(body.reason, 300)));
});

// ---------- inquiries & settings ----------
route("GET", "/api/inquiries", async ({ env }) => json((await env.DB.prepare(
  "SELECT id, lead_id, company, contact_name, email, phone, country, city, partner_type, capital_range, has_location, message, language, created_at FROM inquiries ORDER BY created_at DESC LIMIT 200",
).all()).results));
route("GET", "/api/settings", async ({ env }) => json({ ...(await readSettings(env.DB)), gmailConfigured: gmailConfigured(env) }));
route("PATCH", "/api/settings", async ({ request, env }) => json(await writeSettings(env.DB, await readJson(request))));

// ---------- cron for Cloudflare Pages (no native cron there) ----------
// A tiny separate Worker (cron-worker/worker.js) calls this on a schedule with the shared CRON_SECRET.
route("POST", "/api/cron", async ({ request, env }) => {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32 || !timingSafeEqual(token, env.CRON_SECRET)) throw new HttpError(401, "invalid_cron_secret");
  return json(await scheduled(env));
}, true);

// ---------- public application form ----------
route("GET", "/apply", async ({ request, env }) => renderApply(request, env), true);
route("POST", "/apply", async ({ request, env }) => submitApply(request, env), true);

const ERROR_STATUS_SAFE = new Set([400, 401, 403, 404, 409, 413, 429, 502, 503]);

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith("/api/") || url.pathname === "/apply";
  if (!isApi) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  try {
    if (!env.DB) {
      if (url.pathname === "/api/session") return json({ authenticated: false, configured: authConfigured(env), database: false });
      throw new HttpError(503, "database_not_bound");
    }
    await ensureSchema(env.DB);
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      if (!r.public) {
        if (!(await hasSession(request, env))) throw new HttpError(401, "login_required");
        if (request.method !== "GET") assertSameOrigin(request);
      }
      return await r.handler({ request, env, params, url });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    if (error instanceof HttpError && ERROR_STATUS_SAFE.has(error.status)) return json({ error: error.code }, error.status);
    console.error("unhandled", error);
    return json({ error: "internal_error" }, 500);
  }
}

/** Cron: both jobs stay idle until the owner switches them on in Settings. */
export async function scheduled(env: Env, now = Date.now()) {
  await ensureSchema(env.DB);
  const settings = await readSettings(env.DB);
  const out: Record<string, unknown> = {};
  if (settings.auto_discovery_enabled) {
    const target = await env.DB.prepare("SELECT * FROM targets WHERE enabled = 1 ORDER BY COALESCE(last_run_at, '') ASC LIMIT 1")
      .first<{ id: string; segment: Segment; country: string; city: string }>();
    if (target) {
      await env.DB.prepare("UPDATE targets SET last_run_at = ? WHERE id = ?").bind(nowIso(now), target.id).run();
      out.discovery = await runDiscovery(env, { segment: target.segment, country: target.country, city: target.city }, now).catch(e => ({ error: String(e.message || e) }));
    }
  }
  if (settings.auto_verify_enabled) out.verify = await verifyPending(env, 15, now);
  return out;
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: async (_event: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduled(env)); },
} satisfies ExportedHandler<Env>;

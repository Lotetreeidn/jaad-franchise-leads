// JAAD Franchise Leads — operator UI (vanilla JS, no build step). All dynamic text goes through textContent.

const SEGMENTS = { FNB_OPERATOR: "Pengusaha F&B", MASTER_FRANCHISE: "Master franchise", PROPERTY_OWNER: "Pemilik lokasi" };
const STAGES = { NEW: "Baru", QUALIFIED: "Lolos kualifikasi", CONTACTED: "Sudah dihubungi", REPLIED: "Membalas", MEETING: "Meeting", NEGOTIATION: "Negosiasi", WON: "Deal", LOST: "Gagal", DISQUALIFIED: "Tidak cocok", DO_NOT_CONTACT: "Jangan hubungi" };
const VERIF = { PENDING: ["Belum dicek", ""], VERIFIED: ["Terverifikasi", "ok"], REVIEW: ["Perlu dicek", "warn"], FAILED: ["Gagal dicek", "bad"], NO_WEBSITE: ["Tanpa website", ""], BLOCKED_ROBOTS: ["Diblokir robots.txt", "warn"] };
const DRAFT_STATUS = { DRAFT: ["Draf", ""], APPROVED: ["Disetujui", "info"], SENDING: ["Mengirim", "warn"], SENT: ["Terkirim", "ok"], FAILED: ["Gagal", "bad"], CANCELLED: ["Dibatalkan", ""] };
const MARKETS = { LOCAL: "Lokal (Indonesia)", GLOBAL: "Global" };
const ERRORS = {
  login_required: "Sesi habis, silakan login lagi.", wrong_password: "Password salah.", too_many_attempts: "Terlalu banyak percobaan, tunggu 15 menit.",
  auth_not_configured: "OPERATOR_PASSWORD / SESSION_SECRET belum di-set di Cloudflare.", outreach_disabled: "Outreach email masih OFF. Nyalakan di Pengaturan.",
  gmail_not_configured: "Gmail belum dihubungkan (lihat README).", daily_cap_reached: "Batas email harian tercapai.", draft_not_approved: "Setujui draf dulu.",
  no_email_contact: "Lead ini belum punya email bisnis.", no_phone_contact: "Lead ini belum punya nomor WhatsApp/telepon.", contact_suppressed: "Kontak ini ada di daftar jangan-hubungi.",
  lead_closed: "Lead sudah ditutup / jangan dihubungi.", open_draft_exists: "Sudah ada draf yang belum selesai untuk channel ini.", quality_below_minimum: "Skor lead di bawah minimum untuk outreach (lihat Pengaturan).",
  database_not_bound: "Database D1 belum di-bind dengan nama DB (lihat panduan deploy).",
  discovery_failed: "Pencarian gagal. Coba kota lain atau ulangi nanti.", invalid_city: "Nama kota belum diisi.", invalid_country: "Kode negara harus 2 huruf (mis. ID, MY).",
};

const $app = document.getElementById("app");
const state = { route: "", leadsQuery: { segment: "", market: "", stage: "", verification: "", q: "", offset: 0 } };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const safeHref = url => (/^https?:\/\//i.test(String(url || "")) ? String(url) : null);
const ext = (url, label) => (safeHref(url) ? h("a", { href: safeHref(url), target: "_blank", rel: "noopener noreferrer" }, label || url) : label || url || "");
const badge = (text, kind = "") => h("span", { class: `badge ${kind}` }, text);
const fmtDate = s => (s ? new Date(s).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "—");
const errText = code => {
  if (!code) return "Terjadi kesalahan.";
  if (code.startsWith("profile_incomplete:")) return `Lengkapi profil franchise di Pengaturan dulu: ${code.split(":")[1]}`;
  if (code.startsWith("draft_invalid:")) return `Draf belum valid: ${code.split(":")[1]}`;
  return ERRORS[code] || code;
};

function toast(message, bad = false) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: `toast ${bad ? "bad" : ""}`, role: "status" }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { "content-type": "application/json", "x-jfl": "1" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== "/api/login") { renderLogin(); throw new Error("login_required"); }
  if (!res.ok) throw new Error(data?.error || `http_${res.status}`);
  return data;
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { if (e.message !== "login_required") toast(errText(e.message), true); return null; }
}

// ---------- layout ----------
const NAV = [["#/", "Ringkasan"], ["#/leads", "Leads"], ["#/discover", "Cari leads"], ["#/outreach", "Outreach"], ["#/inquiries", "Pendaftar"], ["#/settings", "Pengaturan"]];

function shell(title, subtitle, actions, ...content) {
  const route = location.hash || "#/";
  const isActive = href => (href === "#/" ? route === "#/" || route === "" : route.startsWith(href));
  const nav = NAV.map(([href, label]) => h("a", { href, class: isActive(href) ? "active" : "" }, label));
  $app.replaceChildren(h("div", { class: "shell" },
    h("aside", { class: "side" }, h("div", { class: "brand" }, "JAAD Franchise", h("small", {}, "Pencari mitra franchise")), ...nav, h("div", { class: "spacer" }),
      h("a", { href: "/apply", target: "_blank" }, "Form pendaftaran ↗"), h("a", { href: "#", onclick: logout }, "Keluar"),
      h("small", { class: "muted attribution" }, "Data peta © ", h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener noreferrer" }, "OpenStreetMap"), " contributors")),
    h("div", {},
      h("nav", { class: "mobile-nav" }, ...NAV.map(([href, label]) => h("a", { href, class: isActive(href) ? "active" : "" }, label))),
      h("main", { class: "main" }, h("div", { class: "head" }, h("div", {}, h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null), actions ? h("div", { class: "row" }, actions) : null), ...content))));
}

async function logout(e) {
  e.preventDefault();
  await fetch("/api/logout", { method: "POST", headers: { "x-jfl": "1" } });
  renderLogin();
}

function renderLogin(configured = true, database = true) {
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  const form = h("form", { class: "card stack", onsubmit: async e => {
    e.preventDefault();
    const ok = await act(() => api("POST", "/api/login", { password: pw.value }));
    if (ok) { location.hash = "#/"; router(); }
  } },
  h("h1", {}, "JAAD Franchise Leads"), h("p", { class: "muted" }, "Masuk sebagai operator."),
  database ? null : h("p", { class: "note" }, "Database belum terhubung: di Cloudflare tambahkan binding D1 bernama DB, lalu deploy ulang."),
  configured ? null : h("p", { class: "note" }, "Password operator belum di-set: tambahkan secret OPERATOR_PASSWORD (min. 10 karakter) dan SESSION_SECRET (min. 32 karakter), lalu deploy ulang."),
  h("label", {}, "Password", pw), h("button", { class: "primary", type: "submit" }, "Masuk"));
  $app.replaceChildren(h("div", { class: "login" }, form));
  pw.focus();
}

// ---------- dashboard ----------
async function viewDashboard() {
  const d = await api("GET", "/api/dashboard");
  const total = Object.values(d.byStage).reduce((a, b) => a + b, 0);
  const metric = (n, label) => h("div", { class: "metric" }, h("b", {}, n ?? 0), h("span", {}, label));
  const order = ["NEW", "QUALIFIED", "CONTACTED", "REPLIED", "MEETING", "NEGOTIATION", "WON"];
  const max = Math.max(1, ...order.map(s => d.byStage[s] || 0));
  const funnel = h("div", { class: "funnel" }, ...order.map(s => h("div", {}, h("span", {}, STAGES[s]), h("div", { class: "bar" }, h("i", { style: `width:${((d.byStage[s] || 0) / max) * 100}%` })), h("b", {}, d.byStage[s] || 0))));
  const sw = (on, label) => h("li", {}, badge(on ? "ON" : "OFF", on ? "ok" : ""), " ", label);
  shell("Ringkasan", "Pipeline calon mitra franchise JAAD Cafe, lokal dan global.", null,
    h("div", { class: "metrics" },
      metric(total, "Total leads"), metric(d.newThisWeek, "Leads baru 7 hari"), metric(d.byStage.QUALIFIED, "Lolos kualifikasi"),
      metric(d.byStage.CONTACTED, "Sudah dihubungi"), metric(d.inquiriesThisWeek, "Pendaftar 7 hari"), metric(d.drafts.DRAFT, "Draf menunggu persetujuan")),
    h("div", { class: "grid2" },
      h("section", { class: "card" }, h("h2", {}, "Funnel"), funnel),
      h("section", { class: "card" }, h("h2", {}, "Per segmen & pasar"),
        h("ul", { class: "list" }, ...Object.entries(SEGMENTS).map(([k, v]) => h("li", {}, `${v}: `, h("b", {}, d.bySegment[k] || 0))),
          ...Object.entries(MARKETS).map(([k, v]) => h("li", {}, `${v}: `, h("b", {}, d.byMarket[k] || 0))))),
      h("section", { class: "card" }, h("h2", {}, "Status otomatis"),
        h("ul", { class: "list" }, sw(d.settings.auto_discovery_enabled, "Cari leads otomatis (cron)"), sw(d.settings.auto_verify_enabled, "Cek website otomatis (cron)"),
          sw(d.settings.outreach_enabled, `Kirim email lewat Gmail (${d.emailsLast24h}/${d.settings.daily_email_cap} dalam 24 jam)`),
          h("li", {}, badge(d.gmailConfigured ? "Terhubung" : "Belum", d.gmailConfigured ? "ok" : "warn"), " Gmail")),
        h("a", { href: "#/settings" }, "Ubah di Pengaturan →")),
      h("section", { class: "card" }, h("h2", {}, "Pencarian terakhir"), runsTable(d.runs))));
}

function runsTable(runs) {
  if (!runs?.length) return h("p", { class: "empty" }, "Belum ada pencarian.");
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Waktu"), h("th", {}, "Target"), h("th", {}, "Hasil"))),
    h("tbody", {}, ...runs.map(r => {
      let p = {}; try { p = JSON.parse(r.params); } catch { /* ignore */ }
      return h("tr", {}, h("td", {}, fmtDate(r.started_at)), h("td", {}, `${SEGMENTS[p.segment] || ""} · ${p.city || ""}, ${p.country || ""}`),
        h("td", {}, r.status === "DONE" ? `${r.inserted} baru, ${r.duplicates} duplikat` : badge(r.status === "FAILED" ? `Gagal: ${r.error || ""}` : r.status, r.status === "FAILED" ? "bad" : "warn")));
    }))));
}

// ---------- leads ----------
const opt = (map, value, all) => [h("option", { value: "" }, all), ...Object.entries(map).map(([k, v]) => h("option", { value: k, selected: k === value }, Array.isArray(v) ? v[0] : v))];

async function viewLeads() {
  const q = state.leadsQuery;
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v !== 0).map(([k, v]) => [k, String(v)]));
  params.set("limit", "50");
  const data = await api("GET", `/api/leads?${params}`);
  const set = (k, v) => { state.leadsQuery = { ...state.leadsQuery, [k]: v, offset: 0 }; viewLeads(); };
  const search = h("input", { type: "search", placeholder: "Cari nama, kota, domain…", value: q.q });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => set("q", search.value.trim()), 350); });
  const filters = h("div", { class: "filters" }, search,
    h("select", { onchange: e => set("segment", e.target.value), "aria-label": "Segmen" }, ...opt(SEGMENTS, q.segment, "Semua segmen")),
    h("select", { onchange: e => set("market", e.target.value), "aria-label": "Pasar" }, ...opt(MARKETS, q.market, "Lokal + global")),
    h("select", { onchange: e => set("stage", e.target.value), "aria-label": "Tahap" }, ...opt(STAGES, q.stage, "Semua tahap")),
    h("select", { onchange: e => set("verification", e.target.value), "aria-label": "Verifikasi" }, ...opt(VERIF, q.verification, "Semua verifikasi")));
  const rows = data.leads.map(l => h("tr", { class: "click", onclick: () => { location.hash = `#/lead/${l.id}`; } },
    h("td", {}, h("b", {}, l.name), h("div", { class: "sub" }, [l.city, l.country].filter(Boolean).join(", "), l.domain ? ` · ${l.domain}` : "")),
    h("td", {}, SEGMENTS[l.segment], h("div", { class: "sub" }, MARKETS[l.market])),
    h("td", {}, badge(STAGES[l.stage], l.stage === "QUALIFIED" ? "ok" : ["LOST", "DISQUALIFIED", "DO_NOT_CONTACT"].includes(l.stage) ? "bad" : l.stage === "NEW" ? "" : "info")),
    h("td", {}, badge(...VERIF[l.verification])),
    h("td", { class: "score" }, l.quality_score, h("div", { class: "sub" }, `yakin ${l.confidence_score}`)),
    h("td", {}, l.outlet_count ? `${l.outlet_count} outlet` : "—", l.brand_count > 1 ? h("div", { class: "sub" }, `${l.brand_count} brand`) : null)));
  const table = data.leads.length
    ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Perusahaan", "Segmen", "Tahap", "Website", "Skor", "Skala"].map(t => h("th", {}, t)))), h("tbody", {}, ...rows)))
    : h("p", { class: "empty" }, "Belum ada leads. Mulai dari menu Cari leads atau import CSV.");
  const pager = h("div", { class: "row" }, h("span", { class: "muted" }, `${data.total} leads`),
    h("button", { class: "small", disabled: q.offset === 0, onclick: () => { state.leadsQuery.offset = Math.max(0, q.offset - 50); viewLeads(); } }, "← Sebelumnya"),
    h("button", { class: "small", disabled: q.offset + 50 >= data.total, onclick: () => { state.leadsQuery.offset = q.offset + 50; viewLeads(); } }, "Berikutnya →"));
  shell("Leads", "Diurutkan dari skor tertinggi. Skor = seberapa cocok; 'yakin' = seberapa kuat buktinya.",
    [h("a", { href: "/api/leads/export.csv" }, h("button", {}, "Export CSV")), h("button", { onclick: () => addLeadForm() }, "Tambah manual"), h("button", { onclick: () => importForm() }, "Import CSV")],
    h("section", { class: "card" }, filters, table, pager));
}

function modalCard(title, body) {
  const box = h("section", { class: "card" }, h("div", { class: "head" }, h("h2", {}, title), h("button", { class: "small", onclick: () => box.remove() }, "Tutup")), body);
  document.querySelector(".main")?.insertBefore(box, document.querySelector(".main").children[1]);
  box.scrollIntoView({ behavior: "smooth" });
  return box;
}

function addLeadForm() {
  const f = { segment: h("select", {}, ...opt(SEGMENTS, "FNB_OPERATOR", "Pilih segmen").slice(1)), name: h("input", { required: true }), country: h("input", { value: "ID", maxlength: 2 }), city: h("input"), website: h("input", { placeholder: "https://" }), notes: h("textarea", { rows: 2 }) };
  const box = modalCard("Tambah lead manual", h("form", { class: "form", onsubmit: async e => {
    e.preventDefault();
    const r = await act(() => api("POST", "/api/leads", Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))));
    if (r?.status === "inserted") { toast("Lead ditambahkan."); box.remove(); location.hash = `#/lead/${r.id}`; }
    else if (r?.status === "duplicate") toast("Perusahaan ini sudah ada.", true);
    else if (r?.status === "suppressed") toast("Domain ini ada di daftar jangan-hubungi.", true);
  } }, h("label", {}, "Segmen", f.segment), h("label", {}, "Nama perusahaan", f.name), h("label", {}, "Negara (2 huruf)", f.country), h("label", {}, "Kota", f.city),
  h("label", { class: "wide" }, "Website perusahaan", f.website), h("label", { class: "wide" }, "Catatan / sumber", f.notes), h("div", { class: "wide" }, h("button", { class: "primary", type: "submit" }, "Simpan"))));
}

function importForm() {
  const seg = h("select", {}, ...opt(SEGMENTS, "FNB_OPERATOR", "").slice(1));
  const file = h("input", { type: "file", accept: ".csv,text/csv" });
  modalCard("Import CSV", h("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    const f = file.files?.[0];
    if (!f) return toast("Pilih file CSV dulu.", true);
    if (f.size > 400_000) return toast("File maksimal 400 KB (±500 baris).", true);
    const csv = await f.text();
    const r = await act(() => api("POST", "/api/leads/import", { csv, segment: seg.value }));
    if (r) { toast(`${r.inserted} baru, ${r.duplicates} duplikat, ${r.invalid} tidak valid, ${r.suppressed} diblokir.`); viewLeads(); }
  } }, h("p", { class: "muted" }, "Kolom: segment, name, country, city, website, email, phone, notes. Wajib: name dan country (2 huruf). Cocok untuk daftar peserta pameran franchise, member asosiasi, atau daftar mall."),
  h("label", {}, "Segmen default", seg), h("label", {}, "File", file), h("div", {}, h("button", { class: "primary", type: "submit" }, "Import"))));
}

// ---------- lead detail ----------
async function viewLead(id) {
  const d = await api("GET", `/api/leads/${id}`);
  const l = d.lead;
  const stage = h("select", { onchange: async e => { if (await act(() => api("PATCH", `/api/leads/${id}`, { stage: e.target.value }), "Tahap diperbarui.")) viewLead(id); } }, ...opt(STAGES, l.stage, "").slice(1));
  const notes = h("textarea", { rows: 4, value: l.notes });
  const contactKind = h("select", {}, h("option", { value: "EMAIL" }, "Email"), h("option", { value: "WHATSAPP" }, "WhatsApp"), h("option", { value: "PHONE" }, "Telepon"));
  const contactValue = h("input", { placeholder: "info@perusahaan.com / +62…" });
  const contactSource = h("input", { placeholder: "URL sumber (halaman kontak resmi)" });
  const draftBtn = ch => h("button", { class: ch === "EMAIL" ? "primary" : "", onclick: async () => {
    const r = await act(() => api("POST", `/api/leads/${id}/drafts`, { channel: ch }));
    if (r) { toast("Draf dibuat. Cek & setujui di Outreach."); location.hash = "#/outreach"; }
  } }, ch === "EMAIL" ? "Buat draf email" : "Buat draf WhatsApp");

  shell(l.name, `${SEGMENTS[l.segment]} · ${MARKETS[l.market]} · ${[l.city, l.country].filter(Boolean).join(", ")}`, [h("a", { href: "#/leads" }, h("button", {}, "← Leads"))],
    h("div", { class: "grid2" },
      h("section", { class: "card" }, h("h2", {}, "Ringkasan"),
        h("div", { class: "row" }, badge(STAGES[l.stage], "info"), badge(...VERIF[l.verification]), badge(`Skor ${l.quality_score}`), badge(`Yakin ${l.confidence_score}`)),
        h("p", {}, "Website: ", l.website ? ext(l.website) : h("span", { class: "muted" }, "tidak ada")),
        h("p", { class: "muted" }, `Sumber: ${l.source}${l.outlet_count ? ` · ${l.outlet_count} outlet` : ""}${l.brand_count > 1 ? ` · ${l.brand_count} brand` : ""} · ditambahkan ${fmtDate(l.created_at)}`),
        h("h3", {}, "Alasan skor"), h("ul", { class: "list" }, ...(l.score_reasons.length ? l.score_reasons : ["Belum ada"]).map(r => h("li", {}, r))),
        h("label", { class: "stack" }, "Tahap", stage),
        h("label", { class: "stack" }, "Catatan", notes),
        h("div", {}, h("button", { onclick: () => act(() => api("PATCH", `/api/leads/${id}`, { notes: notes.value }), "Catatan disimpan.") }, "Simpan catatan"))),
      h("section", { class: "card" }, h("h2", {}, "Kontak bisnis"),
        d.contacts.length ? h("ul", { class: "list" }, ...d.contacts.map(c => h("li", {}, badge(c.kind), " ", c.value, h("div", { class: "muted" }, "sumber: ", ext(c.source_url, c.source_url))))) : h("p", { class: "muted" }, "Belum ada kontak. Isi dari halaman kontak resmi perusahaan."),
        h("form", { class: "form", onsubmit: async e => {
          e.preventDefault();
          if (await act(() => api("POST", `/api/leads/${id}/contacts`, { kind: contactKind.value, value: contactValue.value, source_url: contactSource.value }), "Kontak ditambahkan.")) viewLead(id);
        } }, h("label", {}, "Jenis", contactKind), h("label", {}, "Kontak", contactValue), h("label", { class: "wide" }, "Sumber", contactSource), h("div", {}, h("button", { type: "submit" }, "Tambah kontak"))),
        h("p", { class: "muted" }, "Hanya kontak bisnis (info@, partnership@, nomor resmi). Jangan simpan data pribadi yang tidak perlu."),
        h("h2", {}, "Outreach"), h("div", { class: "row" }, draftBtn("EMAIL"), draftBtn("WHATSAPP")),
        d.drafts.length ? h("ul", { class: "list" }, ...d.drafts.map(x => h("li", {}, badge(...DRAFT_STATUS[x.status]), ` ${x.channel} → ${x.to_value} · ${fmtDate(x.sent_at || x.created_at)}`))) : null),
      h("section", { class: "card" }, h("h2", {}, "Bukti"), d.evidence.length ? h("ul", { class: "list" }, ...d.evidence.map(e => h("li", {}, h("b", {}, e.kind), ` ${e.value} `, h("div", { class: "muted" }, ext(e.source_url, "sumber"), ` · ${fmtDate(e.observed_at)}`)))) : h("p", { class: "muted" }, "Belum ada bukti.")),
      h("section", { class: "card" }, h("h2", {}, "Riwayat"),
        d.inquiries.length ? h("ul", { class: "list" }, ...d.inquiries.map(q => h("li", {}, h("b", {}, "Pendaftaran: "), `${q.contact_name} · ${q.email} · modal ${q.capital_range || "-"} · lokasi ${q.has_location || "-"}`, q.message ? h("div", { class: "muted" }, q.message) : null))) : null,
        d.activities.length ? h("ul", { class: "list" }, ...d.activities.map(a => h("li", {}, h("b", {}, a.kind), ` ${a.detail} `, h("span", { class: "muted" }, fmtDate(a.created_at))))) : h("p", { class: "muted" }, "Belum ada aktivitas."))));
}

// ---------- discovery ----------
async function viewDiscover() {
  const [targets, runs] = await Promise.all([api("GET", "/api/targets"), api("GET", "/api/runs")]);
  const seg = h("select", {}, ...opt(SEGMENTS, "FNB_OPERATOR", "").slice(1));
  const country = h("input", { value: "ID", maxlength: 2, "aria-label": "Negara" });
  const city = h("input", { placeholder: "mis. Bandung, Kuala Lumpur, Dubai" });
  const runBtn = h("button", { class: "primary", type: "submit" }, "Cari sekarang");
  const form = h("form", { class: "form", onsubmit: async e => {
    e.preventDefault();
    runBtn.disabled = true; runBtn.textContent = "Mencari… (bisa ±30 detik)";
    const r = await act(() => api("POST", "/api/discovery/run", { segment: seg.value, country: country.value, city: city.value }));
    runBtn.disabled = false; runBtn.textContent = "Cari sekarang";
    if (r) { toast(`${r.found} kandidat dari ${r.osmElements} tempat di OpenStreetMap: ${r.inserted} baru, ${r.duplicates} sudah ada.`); viewDiscover(); }
  } }, h("label", {}, "Segmen", seg), h("label", {}, "Negara (2 huruf)", country), h("label", {}, "Kota (nama resmi di peta)", city), h("div", { class: "wide row" }, runBtn,
    h("button", { type: "button", onclick: async () => {
      const r = await act(() => api("POST", "/api/verify/run", { limit: 15 }));
      if (r) toast(`${r.checked} website dicek: ${r.verified} terverifikasi, ${r.review} perlu dicek, ${r.blocked} diblokir robots.txt, ${r.failed} gagal.`);
    } }, "Cek website yang tertunda"),
    h("button", { type: "button", onclick: async () => { if (await act(() => api("POST", "/api/targets", { segment: seg.value, country: country.value, city: city.value }), "Ditambahkan ke jadwal otomatis.")) viewDiscover(); } }, "Simpan ke jadwal otomatis")));
  const targetRows = targets.map(t => h("tr", {},
    h("td", {}, `${t.city}, ${t.country}`), h("td", {}, SEGMENTS[t.segment]), h("td", {}, fmtDate(t.last_run_at)),
    h("td", {}, h("div", { class: "row" },
      h("button", { class: "small", onclick: async () => { await act(() => api("PATCH", `/api/targets/${t.id}`, { enabled: !t.enabled })); viewDiscover(); } }, t.enabled ? "Aktif" : "Nonaktif"),
      h("button", { class: "small danger", onclick: async () => { await act(() => api("DELETE", `/api/targets/${t.id}`)); viewDiscover(); } }, "Hapus")))));
  shell("Cari leads", "Gratis lewat OpenStreetMap, lalu website tiap perusahaan dicek (menghormati robots.txt).", null,
    h("section", { class: "card" }, h("h2", {}, "Cari di satu kota"), form,
      h("ul", { class: "list" },
        h("li", {}, h("b", {}, "Pengusaha F&B: "), "grup kafe/resto dengan 2+ outlet, atau usaha F&B yang punya website sendiri."),
        h("li", {}, h("b", {}, "Master franchise: "), "operator yang menjalankan 2+ brand F&B berbeda di kota itu. Untuk luar negeri, lengkapi juga dengan import CSV (daftar pameran/asosiasi franchise)."),
        h("li", {}, h("b", {}, "Pemilik lokasi: "), "mall, hotel bintang 3-5 dan gedung komersial yang punya website."))),
    h("section", { class: "card" }, h("h2", {}, "Jadwal otomatis"), h("p", { class: "muted" }, "Setiap jalan (09:15 & 17:15 WIB) cron mengambil 1 target yang paling lama belum dicari. Nyalakan di Pengaturan."),
      targets.length ? h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["Kota", "Segmen", "Terakhir", ""].map(t => h("th", {}, t)))), h("tbody", {}, ...targetRows))) : h("p", { class: "empty" }, "Belum ada target.")),
    h("section", { class: "card" }, h("h2", {}, "Riwayat pencarian"), runsTable(runs)));
}

// ---------- outreach ----------
async function viewOutreach(status = "DRAFT") {
  const drafts = await api("GET", `/api/drafts?status=${status}`);
  const tabs = h("div", { class: "tabs" }, ...Object.entries(DRAFT_STATUS).map(([k, [label]]) => h("button", { class: k === status ? "on" : "", onclick: () => viewOutreach(k) }, label)));
  const card = d => {
    const subject = h("input", { value: d.subject });
    const body = h("textarea", { rows: 10, value: d.body });
    const editable = d.status === "DRAFT" || d.status === "APPROVED";
    const reload = () => viewOutreach(status);
    const actions = [];
    if (editable) actions.push(h("button", { onclick: async () => { if (await act(() => api("PATCH", `/api/drafts/${d.id}`, { subject: subject.value, body: body.value }), "Draf disimpan (perlu disetujui lagi).")) reload(); } }, "Simpan perubahan"));
    if (d.status === "DRAFT" || d.status === "FAILED") actions.push(h("button", { class: "primary", onclick: async () => { if (await act(() => api("POST", `/api/drafts/${d.id}/approve`), "Disetujui.")) viewOutreach("APPROVED"); } }, "Setujui"));
    if (d.status === "APPROVED" && d.channel === "EMAIL") actions.push(h("button", { class: "primary", onclick: async () => {
      if (!confirm(`Kirim email ini ke ${d.to_value} lewat Gmail?`)) return;
      if (await act(() => api("POST", `/api/drafts/${d.id}/send`), "Email terkirim.")) reload();
    } }, "Kirim via Gmail"));
    if (d.status === "APPROVED" && d.channel === "WHATSAPP" && safeHref(d.wa_link)) {
      actions.push(h("a", { href: d.wa_link, target: "_blank", rel: "noopener noreferrer" }, h("button", { class: "primary" }, "Buka WhatsApp")));
      actions.push(h("button", { onclick: async () => { if (await act(() => api("POST", `/api/drafts/${d.id}/whatsapp-sent`), "Ditandai terkirim.")) reload(); } }, "Sudah saya kirim"));
    }
    if (["DRAFT", "APPROVED", "FAILED"].includes(d.status)) actions.push(h("button", { class: "danger", onclick: async () => { if (await act(() => api("POST", `/api/drafts/${d.id}/cancel`), "Dibatalkan.")) reload(); } }, "Batalkan"));
    return h("article", { class: "draft" },
      h("div", { class: "row" }, badge(...DRAFT_STATUS[d.status]), badge(d.channel), badge(d.language.toUpperCase()), h("a", { href: `#/lead/${d.lead_id}` }, d.lead_name), h("span", { class: "muted" }, `→ ${d.to_value}`)),
      d.error ? h("p", { class: "note" }, `Error: ${d.error}`) : null,
      editable ? h("div", { class: "stack" }, d.channel === "EMAIL" ? h("label", {}, "Subjek", subject) : null, h("label", {}, "Isi pesan", body))
        : h("div", { class: "stack" }, d.subject ? h("b", {}, d.subject) : null, h("pre", {}, d.body)),
      actions.length ? h("div", { class: "row" }, ...actions) : null);
  };
  shell("Outreach", "Semua pesan dicek dan disetujui manusia dulu. Email terkirim dari Gmail kamu; WhatsApp kamu kirim sendiri.", null,
    h("section", { class: "card" }, tabs, drafts.length ? h("div", { class: "stack" }, ...drafts.map(card)) : h("p", { class: "empty" }, "Tidak ada draf di status ini. Buat draf dari halaman detail lead.")));
}

// ---------- inquiries ----------
async function viewInquiries() {
  const list = await api("GET", "/api/inquiries");
  const link = `${location.origin}/apply`;
  shell("Pendaftar", "Calon mitra yang mengisi form pendaftaran.", null,
    h("section", { class: "card" }, h("p", {}, "Pasang link ini di jaadcafe.com: ", ext(link), " (Indonesia) dan ", ext(`${link}?lang=en`), " (global.jaadcafe.com).")),
    h("section", { class: "card" }, list.length ? h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ...["Tanggal", "Perusahaan", "Kontak", "Tipe", "Modal / lokasi", "Pesan"].map(t => h("th", {}, t)))),
      h("tbody", {}, ...list.map(q => h("tr", { class: q.lead_id ? "click" : "", onclick: () => { if (q.lead_id) location.hash = `#/lead/${q.lead_id}`; } },
        h("td", {}, fmtDate(q.created_at)), h("td", {}, h("b", {}, q.company), h("div", { class: "sub" }, [q.city, q.country].filter(Boolean).join(", "))),
        h("td", {}, q.contact_name, h("div", { class: "sub" }, q.email), h("div", { class: "sub" }, q.phone)), h("td", {}, SEGMENTS[q.partner_type] || q.partner_type),
        h("td", {}, q.capital_range || "—", h("div", { class: "sub" }, q.has_location)), h("td", {}, q.message || "—"))))))
      : h("p", { class: "empty" }, "Belum ada pendaftar.")));
}

// ---------- settings ----------
// Suggested pitch built from search-engine summaries of jaadcafe.com (the site itself could not be fetched).
// It is only inserted when the owner clicks the button and saves; nothing is sent from it automatically.
const PITCH_SUGGESTION = {
  id: "JAAD Cafe adalah jaringan kafe kopi di bawah PT Jaad Food Indonesia dengan rantai pasok kopi sendiri, dari hulu ke hilir. Saat ini ada 4 outlet di Bandung, Jatinangor, dan Malaysia. Mitra franchise mendapat pasokan kopi langsung dari kami, pelatihan, standar operasional, dan dukungan tim marketing.",
  en: "JAAD Cafe is a coffee cafe network run by PT Jaad Food Indonesia with its own coffee supply chain, from farm to cup. We currently operate 4 outlets in Bandung, Jatinangor and Malaysia. Franchise partners are supplied directly by us and receive training, operating standards and marketing support.",
};
async function viewSettings() {
  const [s, sup] = await Promise.all([api("GET", "/api/settings"), api("GET", "/api/suppression")]);
  const p = s.profile;
  const field = (key, label, attrs = {}) => { const el = attrs.rows ? h("textarea", { rows: attrs.rows, value: p[key] }) : h("input", { value: p[key], ...attrs }); el.dataset.key = key; return h("label", { class: attrs.rows ? "wide" : "" }, label, el); };
  const profileForm = h("form", { class: "form", onsubmit: async e => {
    e.preventDefault();
    const profile = {};
    profileForm.querySelectorAll("[data-key]").forEach(el => { profile[el.dataset.key] = el.value; });
    if (await act(() => api("PATCH", "/api/settings", { profile }), "Profil disimpan.")) viewSettings();
  } },
  field("sender_name", "Nama pengirim"), field("sender_title", "Jabatan"), field("company_name", "Nama brand"), field("whatsapp_number", "Nomor WhatsApp kantor"),
  field("local_url", "Link info franchise lokal", { placeholder: "https://jaadcafe.com/…" }), field("global_url", "Link info franchise global", { placeholder: "https://global.jaadcafe.com/…" }),
  field("pitch_id", "Pitch singkat (Bahasa Indonesia)", { rows: 4 }), field("pitch_en", "Pitch singkat (English)", { rows: 4 }),
  h("div", { class: "wide note info" },
    h("b", {}, "Teks saran (dari ringkasan hasil pencarian jaadcafe.com, cek dulu sebelum dipakai): "),
    h("div", {}, PITCH_SUGGESTION.id), h("div", {}, PITCH_SUGGESTION.en),
    h("button", { type: "button", class: "small", onclick: () => {
      profileForm.querySelector('[data-key="pitch_id"]').value = PITCH_SUGGESTION.id;
      profileForm.querySelector('[data-key="pitch_en"]').value = PITCH_SUGGESTION.en;
      toast("Teks saran dimasukkan. Periksa, lalu klik Simpan profil.");
    } }, "Pakai teks saran")),
  field("postal_address", "Alamat kantor (untuk footer email)", { rows: 2 }),
  h("p", { class: "wide note info" }, "Pitch dipakai apa adanya di setiap pesan. Tulis hanya fakta resmi dari jaadcafe.com / global.jaadcafe.com. Jangan cantumkan angka investasi, royalti, atau ROI kecuali sudah disetujui."),
  h("div", { class: "wide" }, h("button", { class: "primary", type: "submit" }, "Simpan profil")));

  const toggle = (key, label, help) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: s[key], onchange: async e => { await act(() => api("PATCH", "/api/settings", { [key]: e.target.checked }), "Disimpan."); } }), h("span", {}, h("b", {}, label), h("div", { class: "muted" }, help)));
  const cap = h("input", { type: "number", min: 0, max: 100, value: s.daily_email_cap });
  const minQ = h("input", { type: "number", min: 0, max: 100, value: s.min_quality_to_draft });
  const supValue = h("input", { placeholder: "email@domain.com atau domain.com" });
  const supReason = h("input", { placeholder: "alasan (mis. balas STOP)" });

  shell("Pengaturan", "Semua yang bersifat otomatis atau mengirim pesan default-nya OFF.", null,
    h("section", { class: "card" }, h("h2", {}, "Profil franchise"), profileForm),
    h("div", { class: "grid2" },
      h("section", { class: "card stack" }, h("h2", {}, "Otomatisasi"),
        toggle("auto_discovery_enabled", "Cari leads otomatis", "Cron mencari 1 target dari jadwal setiap jalan."),
        toggle("auto_verify_enabled", "Cek website otomatis", "Cron mengecek hingga 15 website tertunda setiap jalan."),
        toggle("outreach_enabled", "Izinkan kirim email lewat Gmail", "Tetap hanya draf yang sudah kamu setujui, satu per satu."),
        h("p", {}, "Gmail: ", badge(s.gmailConfigured ? "Terhubung" : "Belum terhubung", s.gmailConfigured ? "ok" : "warn")),
        h("div", { class: "form" }, h("label", {}, "Batas email per 24 jam", cap), h("label", {}, "Skor minimum untuk outreach", minQ)),
        h("div", {}, h("button", { onclick: async () => { if (await act(() => api("PATCH", "/api/settings", { daily_email_cap: Number(cap.value), min_quality_to_draft: Number(minQ.value) }), "Disimpan.")) viewSettings(); } }, "Simpan batas"))),
      h("section", { class: "card stack" }, h("h2", {}, "Jangan hubungi"), h("p", { class: "muted" }, "Siapa pun yang membalas STOP atau minta tidak dihubungi wajib masuk sini. Draf terbuka otomatis dibatalkan."),
        h("form", { class: "form", onsubmit: async e => { e.preventDefault(); if (await act(() => api("POST", "/api/suppression", { value: supValue.value, reason: supReason.value }), "Ditambahkan.")) viewSettings(); } },
          h("label", {}, "Email / domain", supValue), h("label", {}, "Alasan", supReason), h("div", {}, h("button", { type: "submit" }, "Tambah"))),
        sup.length ? h("ul", { class: "list" }, ...sup.map(x => h("li", {}, h("b", {}, x.value), ` ${x.reason ? `· ${x.reason}` : ""} `, h("span", { class: "muted" }, fmtDate(x.created_at))))) : h("p", { class: "muted" }, "Kosong."))));
}

// ---------- router ----------
async function router() {
  const hash = location.hash || "#/";
  try {
    if (hash.startsWith("#/lead/")) await viewLead(decodeURIComponent(hash.slice(7)));
    else if (hash === "#/leads") await viewLeads();
    else if (hash === "#/discover") await viewDiscover();
    else if (hash === "#/outreach") await viewOutreach();
    else if (hash === "#/inquiries") await viewInquiries();
    else if (hash === "#/settings") await viewSettings();
    else await viewDashboard();
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.message !== "login_required") toast(errText(e.message), true);
  }
}

window.addEventListener("hashchange", router);
(async () => {
  const s = await fetch("/api/session").then(r => r.json()).catch(() => ({ authenticated: false, configured: false, database: false }));
  if (!s.authenticated) renderLogin(s.configured, s.database !== false);
  else router();
})();

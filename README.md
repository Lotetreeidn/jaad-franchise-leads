# JAAD Franchise Leads

Aplikasi untuk mencari, memverifikasi, menilai, dan menghubungi calon **mitra franchise JAAD Cafe**, baik di Indonesia (jaadcafe.com) maupun di luar negeri (global.jaadcafe.com). Semuanya berjalan di **paket gratis Cloudflare**: satu Worker, database D1, file statis, dan cron.

## Apa yang dikerjakan aplikasi ini

| Bagian | Cara kerja | Biaya |
|---|---|---|
| **Cari leads** | Data tempat dari OpenStreetMap (Overpass API) per kota, dikelompokkan per operator/website | Gratis |
| | *Pengusaha F&B*: grup kafe/resto dengan 2+ outlet, atau usaha F&B yang punya website sendiri | |
| | *Master franchise*: operator yang menjalankan 2+ brand F&B berbeda (untuk pasar global) | |
| | *Pemilik lokasi*: mall, hotel bintang 3-5, gedung komersial yang punya website | |
| **Import CSV** | Daftar peserta pameran franchise, member asosiasi, daftar mall, dll. | Gratis |
| **Form pendaftaran** | `/apply` (Indonesia) dan `/apply?lang=en` (global), siap ditautkan dari kedua website | Gratis |
| **Verifikasi** | Membuka homepage perusahaan (menghormati robots.txt), mencocokkan nama, mengambil email bisnis generik (info@, partnership@, franchise@ …), nomor WhatsApp/telepon resmi, dan sinyal (franchise, multi-outlet, multi-brand, leasing) | Gratis |
| **Skor** | Dua skor terpisah: *kualitas* (seberapa cocok) dan *keyakinan* (seberapa kuat buktinya). Lead baru "Lolos kualifikasi" kalau keduanya cukup | Gratis |
| **Outreach email** | Draf → kamu edit & setujui → kirim satu per satu dari **Gmail kamu sendiri** (Gmail API) | Gratis |
| **Outreach WhatsApp** | Draf → kamu setujui → tombol `wa.me` membuka WhatsApp kamu → kirim sendiri → tandai terkirim | Gratis |
| **Jangan hubungi** | Email/domain yang minta berhenti; draf terbuka otomatis dibatalkan dan lead ditutup | Gratis |

Yang **sengaja tidak** dilakukan:
- Tidak mengirim apa pun secara otomatis.
- Tidak mengarang info franchise (harga, royalti, ROI). Isi pesan hanya dari "Profil franchise" yang kamu tulis sendiri di Pengaturan.
- Tidak mengumpulkan email pribadi orang dari website.
- Tidak memakai Google Maps API yang berbayar.

Semua otomatisasi (cron cari leads, cron cek website, kirim email) **default OFF**, dan baru jalan setelah kamu nyalakan di Pengaturan.

## Deploy ke Cloudflare (gratis)

**Tanpa terminal:** ikuti [DEPLOY_DASHBOARD.md](DEPLOY_DASHBOARD.md). Buat database D1, drag `jaad-franchise-pages.zip` ke Cloudflare Pages, lalu isi 2 secret. Zip dibuat dengan `npm run build:pages`.

**Dengan terminal (Workers + cron bawaan):**

Perlu: akun Cloudflare gratis dan Node.js 20 ke atas.

```bash
git clone https://github.com/Lotetreeidn/jaad-franchise-leads.git
cd jaad-franchise-leads
npm install
npx wrangler login                      # buka browser, login Cloudflare

npx wrangler d1 create jaad-franchise   # salin "database_id" yang muncul
# tempel database_id itu ke wrangler.jsonc (ganti 00000000-...)

npm run db:migrate:remote               # buat tabel di D1

npx wrangler secret put OPERATOR_PASSWORD   # password login kamu (min. 10 karakter)
npx wrangler secret put SESSION_SECRET      # string acak panjang, mis. hasil: openssl rand -hex 32

npm run deploy                          # muncul URL https://jaad-franchise-leads.<akun>.workers.dev
```

Setelah login, buka **Pengaturan** dan isi bagian ini:
1. **Profil franchise**: nama pengirim, pitch singkat (ID dan EN, hanya fakta resmi dari website), link info franchise, nomor WhatsApp kantor, dan alamat kantor.
2. **Jangan hubungi**: tambahkan kalau ada pihak yang minta tidak dihubungi.

Nomor WhatsApp kantor tampil di tanda tangan email dan sebagai tombol "Chat WhatsApp" di halaman terima kasih form pendaftaran.

Kalau mau pakai domain sendiri (mis. `mitra.jaadcafe.com`), DNS domainnya harus dikelola Cloudflare (paket gratis cukup). Tambahkan lewat dashboard Workers → Settings → Domains & Routes.

### Pasang link form pendaftaran

Di jaadcafe.com, tambahkan tombol "Daftar jadi mitra" ke `https://<url-worker>/apply`.
Di global.jaadcafe.com, pakai `https://<url-worker>/apply?lang=en`.

### Hubungkan Gmail (opsional, untuk kirim email)

Email dikirim dari akun Gmail/Google Workspace kamu sendiri lewat Gmail API, gratis dengan batas harian dari Google.

1. Buka [console.cloud.google.com](https://console.cloud.google.com), lalu buat project baru.
2. Masuk ke **APIs & Services → Library**, aktifkan **Gmail API**.
3. Masuk ke **OAuth consent screen**: pilih tipe *External*, isi nama aplikasi, dan tambahkan email kamu sebagai *test user*. Lalu tekan **Publish app** (status *In production*). Kalau masih *Testing*, refresh token kedaluwarsa tiap 7 hari. Aplikasi yang belum diverifikasi Google tetap bisa dipakai pemiliknya sendiri; kamu hanya akan melihat layar peringatan sekali.
4. Masuk ke **Credentials → Create credentials → OAuth client ID**, tipe *Web application*. Isi *Authorized redirect URI* dengan `https://developers.google.com/oauthplayground`.
5. Buka [OAuth Playground](https://developers.google.com/oauthplayground):
   - Klik ikon ⚙️, centang *Use your own OAuth credentials*, lalu isi client ID dan secret.
   - Di kolom scope, isi `https://www.googleapis.com/auth/gmail.send`, lalu klik *Authorize* dan login.
   - Klik *Exchange authorization code for tokens*, lalu salin **Refresh token**.
6. Simpan semuanya sebagai secret:
   ```bash
   npx wrangler secret put GMAIL_CLIENT_ID
   npx wrangler secret put GMAIL_CLIENT_SECRET
   npx wrangler secret put GMAIL_REFRESH_TOKEN
   npx wrangler secret put GMAIL_SENDER        # alamat pengirim, mis. franchise@jaadcafe.com
   ```
7. Di Pengaturan, nyalakan **Izinkan kirim email lewat Gmail**, lalu atur batas harian. Defaultnya 20 email per 24 jam, maksimal 100.

Balasan email masuk ke Gmail kamu seperti biasa. Aplikasi tidak membaca inbox, jadi ubah tahap lead (Membalas → Meeting → Negosiasi → Deal) secara manual. Kalau ada yang membalas STOP, masukkan ke **Jangan hubungi**.

## Batas paket gratis Cloudflare (yang relevan)

| Batas | Nilai gratis | Cara aplikasi menyesuaikan |
|---|---|---|
| Request Worker | 100.000 / hari | Aplikasi internal; jauh di bawah batas |
| CPU per request | 10 ms | Parsing ringan (regex, ukuran halaman dibatasi 250 KB) |
| Subrequest per invocation | 50 | Cek website maksimal 15–20 situs per jalan (2 request/situs) |
| D1 | 5 GB, 5 juta baris dibaca & 100 ribu baris ditulis / hari | Query dibatasi LIMIT dan pakai index |
| Cron trigger | Tersedia di paket gratis | 2 jadwal: 09:15 & 17:15 WIB |

Kalau pencarian di kota sangat besar gagal karena batas CPU, pakai kota/kecamatan yang lebih kecil (nama resmi di OpenStreetMap). Overpass API itu layanan publik gratis, jadi jangan dipakai berlebihan. Cron hanya menjalankan 1 kota per jadwal.

Data tempat © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).

## Pengembangan

```bash
cp .dev.vars.example .dev.vars          # isi OPERATOR_PASSWORD dan SESSION_SECRET lokal
npm run db:migrate:local
npm run dev                             # http://localhost:8787
npm test                                # node:test + SQLite bawaan Node, semua jaringan di-mock
npm run typecheck
```

Struktur:
- `src/index.ts`: router API dan cron
- `src/discovery.ts`: query OpenStreetMap dan pengelompokan kandidat
- `src/verify.ts`: robots.txt, pembacaan homepage, dan ekstraksi fakta
- `src/scoring.ts`: skor kualitas dan keyakinan
- `src/leads.ts`: simpan/dedupe, daftar, detail, dan CSV
- `src/outreach.ts`: draf, persetujuan, Gmail, WhatsApp, daftar jangan-hubungi
- `src/apply.ts`: form pendaftaran publik
- `src/settings.ts`: pengaturan dan profil franchise
- `public/`: tampilan operator (JS biasa, tanpa build)
- `migrations/`: skema D1. Hanya boleh ditambah file bernomor baru, jangan ubah yang sudah dijalankan.

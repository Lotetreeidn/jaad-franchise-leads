# Deploy tanpa terminal: drag & drop di dashboard Cloudflare (gratis)

Yang dibutuhkan cuma file **`jaad-franchise-pages.zip`** dan akun Cloudflare gratis. Sekitar 10 menit.

Zip-nya bisa dibuat ulang kapan saja dengan `npm run build:pages`. Isinya: tampilan web dan `_worker.js` (backend). Tabel database dibuat otomatis waktu aplikasi pertama kali dibuka, jadi tidak perlu menjalankan SQL apa pun.

## 1. Buat database D1

1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) dan login.
2. Menu kiri **Storage & Databases → D1 SQL Database → Create**.
3. Isi nama `jaad-franchise`, lalu klik **Create**.

## 2. Upload aplikasinya (drag & drop)

1. Menu kiri **Workers & Pages → Create**. Pilih tab **Pages**, lalu **Upload assets** (Drag and drop your files).
2. Isi nama project `jaad-franchise` (nanti jadi URL `https://jaad-franchise.pages.dev`), lalu klik **Create project**.
3. **Drag file `jaad-franchise-pages.zip`** ke kotak upload, lalu klik **Deploy site**.

Kalau dibuka sekarang, halaman login akan bilang database belum terhubung. Itu normal, lanjut ke langkah 3.

## 3. Hubungkan database dan isi password

Masuk ke project `jaad-franchise`, lalu buka tab **Settings**.

**Bindings → Add → D1 database**
- Variable name: `DB` (huruf besar, persis begini)
- D1 database: `jaad-franchise`
- Simpan

**Variables and Secrets → Add**. Pilih tipe **Secret** untuk semuanya:

| Nama | Isi |
|---|---|
| `OPERATOR_PASSWORD` | Password login kamu, minimal 10 karakter |
| `SESSION_SECRET` | String acak minimal 32 karakter. Cara cepat: di Chrome tekan F12 → Console, ketik `crypto.randomUUID()+crypto.randomUUID()`, lalu salin hasilnya tanpa tanda kutip |
| `CRON_SECRET` | *(opsional, untuk langkah 6)* string acak lain dengan cara yang sama |

## 4. Deploy ulang supaya setting di atas aktif

Binding dan secret hanya berlaku untuk deployment **baru**.

Buka tab **Deployments → Create deployment** (atau **Upload**), lalu drag `jaad-franchise-pages.zip` yang sama sekali lagi, dan klik **Deploy**.

## 5. Login dan isi Pengaturan

Buka `https://jaad-franchise.pages.dev`, lalu login dengan `OPERATOR_PASSWORD`. Masuk ke menu **Pengaturan** dan isi:
- **Nama pengirim** dan jabatan.
- **Nomor WhatsApp kantor**: nomor kamu (format 08… boleh, otomatis jadi +62…).
- **Pitch singkat** ID dan EN. Ada tombol *Pakai teks saran*: periksa dulu, ubah kalau perlu, lalu **Simpan profil**.
- **Link info franchise**. Default-nya sudah `https://jaadcafe.com` dan `https://global.jaadcafe.com`.

Link form pendaftaran untuk dipasang di website:
- jaadcafe.com: `https://jaad-franchise.pages.dev/apply`
- global.jaadcafe.com: `https://jaad-franchise.pages.dev/apply?lang=en`

Mau pakai domain sendiri (misalnya `mitra.jaadcafe.com`)? Tambahkan di tab **Custom domains**.

## 6. (Opsional) Jadwal otomatis

Pages tidak punya cron. Kalau mau pencarian dan cek website berjalan sendiri dua kali sehari, buat satu Worker kecil:

1. **Workers & Pages → Create → Worker**, beri nama `jaad-franchise-cron`, lalu **Deploy**.
2. Klik **Edit code**. Hapus semua isinya, tempel isi file `cron-worker/worker.js` dari repo ini, lalu klik **Deploy**.
3. Buka **Settings → Variables and Secrets** di Worker itu:
   - Variable `APP_URL` = `https://jaad-franchise.pages.dev`
   - Secret `CRON_SECRET` = sama persis dengan `CRON_SECRET` di project Pages
4. Buka **Settings → Trigger events → Add → Cron trigger**. Tambahkan `15 2 * * *` dan `15 10 * * *` (09:15 dan 17:15 WIB).
5. Di aplikasi, buka **Pengaturan** dan nyalakan *Cari leads otomatis* dan/atau *Cek website otomatis*. Lalu isi daftar kota di **Cari leads → Simpan ke jadwal otomatis**.

Tanpa langkah ini aplikasi tetap jalan; kamu tinggal klik tombol **Cari sekarang** dan **Cek website yang tertunda** sendiri.

## 7. (Opsional) Kirim email lewat Gmail

Pengiriman pakai Gmail API, jadi alamat pengirim **harus akun Google** (Gmail atau Google Workspace). Ada dua kondisi:
- **Alamatnya akun Google Workspace:** ikuti bagian "Hubungkan Gmail" di README. Login di OAuth Playground pakai alamat itu, lalu tambahkan 4 secret (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER`) di project Pages. Deploy ulang seperti langkah 4, lalu nyalakan *Izinkan kirim email lewat Gmail* di Pengaturan.
- **Email domainnya di-host di tempat lain** (misalnya GoDaddy/Microsoft 365): Gmail API tidak bisa mengirim atas nama alamat itu. Pilihannya: pakai alamat di domain yang email-nya di Google Workspace, atau kirim email manual dulu. Draf tetap bisa disalin dari menu Outreach.

## Biaya

Semua langkah di atas masuk paket gratis Cloudflare. Batas yang relevan: Pages Functions 100.000 request/hari, D1 5 GB, 5 juta baris dibaca dan 100 ribu baris ditulis per hari. Untuk aplikasi internal ini, angka itu jauh di atas kebutuhan.

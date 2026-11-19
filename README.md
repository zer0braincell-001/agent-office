# Agent Office (Kantor Agen)

Kantor 3D berisi agen AI: 1 kepala manajer (Arya) + divisi Backend, Frontend, Desain. Banyak workspace (proyek) jalan bersamaan.

## Dua cara pakai
1. **Tanpa server** — buka `index.html` (atau link artifact). Mode Simulasi gratis, atau mode Claude API pakai API key.
2. **Mode Laptop (tahap 1)** — agen dijalankan Claude Code di laptop pakai login Pro kamu.

## Mode Laptop di Windows
Syarat: Node.js 18+ (`node -v`) dan Claude Code yang sudah login (`claude` lalu `/login`).

1. Clone repo ini: `git clone https://github.com/zer0braincell-001/agent-office.git` (misal di `D:\`).
2. Klik dua kali `mulai.bat`. Pertama kali jalan, `server\config.json` dibuat otomatis.
3. Jendela hitam menampilkan link berisi PIN:
   - laptop: `http://localhost:4321/?pin=XXXXXX`
   - HP (wifi sama): `http://192.168.x.x:4321/?pin=XXXXXX`
   Kalau Windows Firewall bertanya, pilih **Private network** supaya HP bisa masuk.
4. Tulis brief, Manajer membagi tugas, staf mengerjakan file di `C:\Users\<kamu>\KantorAgen\proyek\<nama-proyek>`.

### Yang ada di tahap 1
- Manajer menyusun rencana (`claude -p`, model `opus`), staf mengerjakan file (model `sonnet`), Manajer menulis laporan akhir.
- Chat langsung ke agen (ketuk agen → Chat). Pesan diawali `ingat:` disimpan ke memori agen (`data\agen\<nama>.md`).
- Data (state, log, memori) di `C:\Users\<kamu>\KantorAgen\data`.
- Token terpakai + perkiraan biaya-setara per workspace. Batas bisa diatur (`batasBiaya`).
- Staf hanya boleh Read/Edit/Write/Glob/Grep. Bash (menjalankan perintah) belum diizinkan.
- Review manajer di tahap 1 otomatis (tidak memanggil Claude) supaya hemat kuota.

### config.json
| kunci | arti |
|---|---|
| `akun` | daftar login Claude Code. `configDir` kosong = login default. Akun kedua: isi folder lain, lalu login sekali dengan `set CLAUDE_CONFIG_DIR=C:\Users\<kamu>\.claude-b` + `claude`. |
| `maxAgenPerAkun` | berapa agen boleh jalan bersamaan per akun (default 2) |
| `model` | `manajer` dan `staf` (alias Claude Code: `opus`, `sonnet`, `haiku`) |
| `batasBiaya` | 0 = tanpa batas; selain itu workspace dijeda saat biaya-setara mencapai angka ini |
| `pin` | PIN akses web; ganti kalau bocor |
| `vault` | folder vault Obsidian (berisi `INDEX.md` + `repos.md`) untuk daftar project di dasbor |
| `usage.folderLog` | folder log Claude Code (`...\.claude\projects`). Kosong = login default + `configDir` tiap akun |
| `usage.akun` / `usage.org` | `accountUuid` / `organizationUuid` → nama tampilan akun |
| `usage.fileLimit` | opsional: `plan-usage-history.json` Claude Desktop (sampel persen limit). Kosong = tidak dibaca |

## Dasbor token (Fase 0)
`http://localhost:4321/dashboard.html?pin=XXXXXX` (link dicetak saat server jalan). Membaca log JSONL Claude Code secara read-only: ringkasan 7 hari per akun, token per hari, per project, 10 sesi termahal, per model, daftar project vault. API: `GET /api/usage`, `GET /api/projects` (PIN sama).
- Akun dikenali dari baris `session-owner` di log; sesi tanpa baris itu (Claude Desktop, CLI lama) tampil sebagai "tak diketahui".
- Respons API yang ditulis berulang (satu baris per blok konten) di-dedup per `message.id` + `requestId` — angka harian sama dengan `ccusage daily`.

## Kontrol 3D
Geser 1 jari = putar kamera, 2 jari = zoom/geser, scroll = zoom, ketuk agen = detail + chat.

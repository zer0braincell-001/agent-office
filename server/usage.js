// Kantor Agen — Fase 0 "Ukur": pembaca log token Claude Code + daftar project vault.
// Read-only terhadap folder .claude. Tanpa dependency: cukup Node.js 18+.
//
// Sumber data (semua lokal):
// - <folderLog>/**/*.jsonl  — transkrip Claude Code. Usage ada di baris type=assistant (message.usage).
//   Satu respons API ditulis berulang (satu baris per blok konten) dengan usage identik →
//   dedup per message.id + requestId.
// - baris type=session-owner (accountUuid) → akun pemilik sesi. Hanya ada di sesi CLI versi baru;
//   sesi lama / sesi Claude Desktop tidak punya → akun "tak diketahui".
// - baris type=cost-state → hitungan biaya-setara Claude Code sendiri per sesi (pembanding).
// - plan-usage-history.json Claude Desktop (opsional) → sampel persen limit per organisasi.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

/* ---------------- Konfigurasi ---------------- */
function opsi(CFG) {
  const u = CFG.usage || {};
  let folderLog = Array.isArray(u.folderLog) ? u.folderLog.filter(Boolean) : [];
  if (!folderLog.length) {
    // Bawaan: login default + configDir tiap akun agen (kalau ada).
    folderLog = [path.join(os.homedir(), '.claude', 'projects')];
    for (const a of CFG.akun || []) if (a.configDir) folderLog.push(path.join(a.configDir, 'projects'));
  }
  return {
    folderLog: [...new Set(folderLog)],
    akun: u.akun || {},               // { accountUuid: "Nama akun" }
    org: u.org || {},                 // { organizationUuid: "Nama akun" } — untuk sampel limit
    fileLimit: u.fileLimit || '',     // path plan-usage-history.json Claude Desktop ('' = tidak dibaca)
    vault: CFG.vault || '',
  };
}

/* ---------------- Project dari path ---------------- */
// Nama project dari path: <vault>\code\<nama>\... atau <vault>\projects\<nama>\...
// Path Windows dinormalkan: "/" → "\", "/d/x" (Git Bash) → "d:\x".
const norm = (p) => String(p).replace(/\//g, '\\').replace(/^\\([a-zA-Z])\\/, '$1:\\').replace(/\\+$/, '');
function projDariPath(p, vault) {
  if (!p || !vault) return null;
  const s = norm(p), v = norm(vault) + '\\';
  if (!s.toLowerCase().startsWith(v.toLowerCase())) return null;
  const m = s.slice(v.length).match(/^(?:code|projects)\\([^\\"'\s]+)/i);
  return m ? m[1] : null;
}
function projDariCwd(cwd, vault) {
  if (!cwd) return '(tanpa cwd)';
  const p = projDariPath(cwd, vault); if (p) return p;
  if (vault && norm(cwd).toLowerCase() === norm(vault).toLowerCase()) return '(vault root)';
  return path.basename(cwd) || cwd;
}
// Ambil path dari input alat (Read/Edit/Write/Glob/Grep/Bash/PowerShell).
function pathsAlat(content) {
  const out = [];
  for (const b of content || []) {
    if (!b || b.type !== 'tool_use' || !b.input) continue;
    const i = b.input;
    for (const k of ['file_path', 'path', 'notebook_path']) if (typeof i[k] === 'string') out.push(i[k]);
    if (typeof i.command === 'string') { const m = i.command.match(/[A-Za-z]:[\\/][^"'\n]*?[\\/](?:code|projects)[\\/][A-Za-z0-9._-]+/); if (m) out.push(m[0]); }
  }
  return out;
}

/* ---------------- Parse satu file (streaming, di-cache per mtime+size) ---------------- */
const cache = new Map(); // file -> { key, data }
function tglLokal(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

async function parseFile(file, vault) {
  const sesi = new Map(); // sessionId -> info
  const rec = [];          // satu entri per respons API unik
  const seen = new Set();
  const limitHits = [];
  const getS = (id) => { let s = sesi.get(id); if (!s) { s = { id, file, cwd: null, entry: null, owner: null, org: null, judul: '', t0: null, t1: null, cost: null, projTerakhir: null }; sesi.set(id, s); } return s; };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // Saring murah sebelum JSON.parse: baris blob request bisa ber-MB dan tidak dipakai.
    if (!(line.includes('"assistant"') || line.includes('"session-owner"') || line.includes('"cost-state"') || line.includes('"ai-title"') || line.includes('"quotaLimits"'))) continue;
    let j; try { j = JSON.parse(line); } catch (e) { continue; }
    const sid = j.sessionId || j.session_id; if (!sid) continue;
    const s = getS(sid);
    if (j.type === 'session-owner') { s.owner = j.accountUuid || s.owner; s.org = j.organizationUuid || s.org; continue; }
    if (j.type === 'cost-state') { s.cost = { usd: j.totalCostUSD || 0, modelUsage: j.modelUsage || {} }; continue; }
    if (j.type === 'ai-title') { s.judul = j.aiTitle || s.judul; continue; }
    if (j.quotaLimits && j.quotaLimits.status === 'rejected') limitHits.push({ t: j.timestamp, sesi: sid, jenis: j.quotaLimits.rateLimitType || '?', resetsAt: j.quotaLimits.resetsAt || null });
    if (j.type !== 'assistant' || !j.message) continue;
    if (j.cwd && !s.cwd) s.cwd = j.cwd;
    if (j.entrypoint && !s.entry) s.entry = j.entrypoint;
    if (j.timestamp) { if (!s.t0 || j.timestamp < s.t0) s.t0 = j.timestamp; if (!s.t1 || j.timestamp > s.t1) s.t1 = j.timestamp; }
    // Project tebakan: path alat di pesan ini; kalau tidak ada, project terakhir yang disentuh sesi ini.
    for (const p of pathsAlat(j.message.content)) { const pr = projDariPath(p, vault); if (pr) s.projTerakhir = pr; }
    const u = j.message.usage; if (!u || j.message.model === '<synthetic>') continue;
    const key = (j.message.id || '') + ':' + (j.requestId || '');
    if (seen.has(key)) continue; seen.add(key);
    const cc = u.cache_creation || {};
    rec.push({
      ts: j.timestamp, hari: tglLokal(j.timestamp), sesi: sid, model: j.message.model || '?',
      inp: u.input_tokens || 0, out: u.output_tokens || 0,
      cw: u.cache_creation_input_tokens || 0, cw1h: cc.ephemeral_1h_input_tokens || 0,
      cr: u.cache_read_input_tokens || 0,
      proj: s.projTerakhir, side: !!j.isSidechain,
    });
  }
  return { sesi: [...sesi.values()], rec, limitHits };
}

function daftarFile(root) {
  const out = [];
  const jalan = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) jalan(p); else if (e.name.endsWith('.jsonl')) out.push(p); } };
  jalan(root); return out;
}

let sedangScan = null;
async function scan(o) {
  const files = o.folderLog.flatMap(daftarFile);
  const ada = new Set(files);
  for (const f of [...cache.keys()]) if (!ada.has(f)) cache.delete(f);
  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    const key = st.size + ':' + st.mtimeMs;
    const c = cache.get(f); if (c && c.key === key) continue;
    try { cache.set(f, { key, data: await parseFile(f, o.vault) }); } catch (e) { console.error('usage: gagal baca', f, e.message); }
  }
  return files.length;
}
function scanSekali(o) { if (!sedangScan) sedangScan = scan(o).finally(() => { sedangScan = null; }); return sedangScan; }

/* ---------------- Agregasi ---------------- */
// Bobot harga relatif (satuan "setara-input"): output 5×, tulis cache 5 menit 1,25×, 1 jam 2×, baca cache 0,1×.
// Hanya untuk mengurutkan "termahal"; angka resmi tetap token mentah.
const bobot = (r) => r.inp + 1.25 * (r.cw - r.cw1h) + 2 * r.cw1h + 0.1 * r.cr + 5 * r.out;
const kosong = () => ({ inp: 0, out: 0, cw: 0, cr: 0, panggilan: 0, beban: 0 });
function tambah(a, r) { a.inp += r.inp; a.out += r.out; a.cw += r.cw; a.cr += r.cr; a.panggilan++; a.beban += bobot(r); return a; }
function rasio(a) { const tot = a.inp + a.cw + a.cr; return { total: tot + a.out, rasioCacheRead: tot ? a.cr / tot : 0, konteksRata: a.panggilan ? Math.round(tot / a.panggilan) : 0 }; }
const selesai = (a) => Object.assign(a, rasio(a), { beban: Math.round(a.beban) });

function namaAkun(o, uuid) { if (!uuid) return 'tak diketahui'; return o.akun[uuid] || ('akun ' + uuid.slice(0, 8)); }

function bacaLimit(o) {
  if (!o.fileLimit) return { status: 'tidak dikonfigurasi', akun: [] };
  let j; try { j = JSON.parse(fs.readFileSync(o.fileLimit, 'utf8')); } catch (e) { return { status: 'tidak terbaca: ' + e.message, akun: [] }; }
  const per = {};
  for (const s of j.samples || []) { if (!s || !s.org || !s.u) continue; if (!per[s.org] || s.t > per[s.org].t) per[s.org] = s; }
  return {
    status: 'ok', sumber: o.fileLimit,
    catatan: 'Sampel dari Claude Desktop (hanya saat app desktop terbuka). Tafsiran field: fh = persen jendela 5 jam, sd = persen jendela 7 hari. Format tidak didokumentasikan.',
    akun: Object.values(per).map(s => ({ org: s.org, nama: o.org[s.org] || ('org ' + s.org.slice(0, 8)), t: s.t, persen5Jam: s.u.fh, persen7Hari: s.u.sd })).sort((a, b) => b.t - a.t),
  };
}

async function ringkasan(CFG) {
  const o = opsi(CFG);
  const t0 = Date.now();
  const nFile = await scanSekali(o);
  const sesiMap = new Map(); const rec = []; const limitHits = [];
  for (const { data } of cache.values()) {
    for (const s of data.sesi) { const x = sesiMap.get(s.id); if (!x) sesiMap.set(s.id, Object.assign({}, s)); else { x.owner = x.owner || s.owner; x.org = x.org || s.org; x.judul = x.judul || s.judul; x.cost = s.cost || x.cost; x.cwd = x.cwd || s.cwd; x.entry = x.entry || s.entry; if (s.t0 && (!x.t0 || s.t0 < x.t0)) x.t0 = s.t0; if (s.t1 && (!x.t1 || s.t1 > x.t1)) x.t1 = s.t1; } }
    rec.push(...data.rec); limitHits.push(...data.limitHits);
  }
  const seen = new Set();
  const perAkun = {}, perHari = {}, perProj = {}, perProjCwd = {}, perSesi = {}, perModel = {}, minggu = {}, projSesi = {};
  const batasMinggu = Date.now() - 7 * 864e5;
  const akunDari = (sid) => namaAkun(o, (sesiMap.get(sid) || {}).owner);
  for (const r of rec) {
    const k = r.sesi + ':' + r.ts + ':' + r.inp + ':' + r.out + ':' + r.cr; // jaga-jaga file salinan
    if (seen.has(k)) continue; seen.add(k);
    const s = sesiMap.get(r.sesi) || {};
    const akun = akunDari(r.sesi);
    const pCwd = projDariCwd(s.cwd, o.vault);
    const p = projDariPath(s.cwd, o.vault) || r.proj || pCwd;
    tambah(perAkun[akun] ||= kosong(), r);
    tambah((perHari[r.hari] ||= {})[akun] ||= kosong(), r);
    tambah(perProj[p] ||= kosong(), r);
    tambah(perProjCwd[pCwd] ||= kosong(), r);
    tambah(perSesi[r.sesi] ||= kosong(), r);
    const ps = projSesi[r.sesi] ||= {}; ps[p] = (ps[p] || 0) + bobot(r);
    tambah(perModel[r.model] ||= kosong(), r);
    if (Date.parse(r.ts) >= batasMinggu) tambah(minggu[akun] ||= kosong(), r);
  }
  const sesi = Object.entries(perSesi).map(([id, a]) => { const s = sesiMap.get(id) || {}; return Object.assign(selesai(a), { id, akun: akunDari(id), judul: s.judul || '', cwd: s.cwd, project: Object.entries(projSesi[id] || {}).sort((x, y) => y[1] - x[1]).map(([k]) => k)[0] || projDariCwd(s.cwd, o.vault), entry: s.entry, t0: s.t0, t1: s.t1, biayaClaudeCode: s.cost ? +s.cost.usd.toFixed(2) : null }); });
  sesi.sort((a, b) => b.beban - a.beban);
  const fin = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, selesai(v)]));
  return {
    dibuat: new Date().toISOString(), durasiMs: Date.now() - t0,
    sumber: { folderLog: o.folderLog, file: nFile, respons: seen.size, sesi: sesiMap.size },
    catatan: {
      akun: 'Akun dari baris session-owner (hanya sesi CLI versi baru). Sesi tanpa baris itu = "tak diketahui".',
      project: 'project = folder cwd kalau di bawah code\\ atau projects\\; kalau cwd = vault root, ditebak dari path alat terakhir yang disentuh sesi itu.',
      beban: 'beban = token berbobot harga relatif (input 1, output 5, tulis cache 1,25/2, baca cache 0,1). Untuk urutan saja.',
      minggu: '7 hari terakhir (bergulir), bukan jendela reset resmi.',
    },
    mingguIni: fin(minggu),
    perAkun: fin(perAkun),
    perHari: Object.fromEntries(Object.entries(perHari).sort().map(([h, v]) => [h, fin(v)])),
    perProject: fin(perProj),
    perProjectCwd: fin(perProjCwd),
    perModel: fin(perModel),
    sesiTermahal: sesi.slice(0, 10),
    jumlahSesi: sesi.length,
    limit: bacaLimit(o),
    kenaLimit: limitHits.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 20).map(h => Object.assign(h, { akun: akunDari(h.sesi) })),
  };
}

/* ---------------- Daftar project dari vault ---------------- */
function tabelMd(teks) {
  // Ambil baris tabel markdown (lewati header + garis pemisah).
  const rows = [];
  for (const ln of teks.split(/\r?\n/)) {
    if (!/^\s*\|/.test(ln) || /^\s*\|\s*-/.test(ln)) continue;
    rows.push(ln.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
  }
  return rows.slice(1);
}
const bersih = (s) => String(s || '').replace(/\*\*|`/g, '').trim();
function links(...sel) {
  const out = new Set();
  for (const s of sel) for (const m of String(s || '').matchAll(/(?:https?:\/\/)?(?:github\.com\/[\w.-]+\/[\w.-]+|[\w.-]+\.github\.io(?:\/[\w.-]+)?|[\w.-]+\.vercel\.app)/g)) { const l = m[0].replace(/[.]+$/, ''); out.add(l.startsWith('http') ? l : 'https://' + l); }
  return [...out];
}
function proyek(CFG) {
  const o = opsi(CFG);
  if (!o.vault) return { error: 'vault belum diisi di server/config.json', proyek: [] };
  const baca = (f) => { try { return fs.readFileSync(path.join(o.vault, f), 'utf8'); } catch (e) { return ''; } };
  const index = baca('INDEX.md'), repos = baca('repos.md');
  if (!index) return { error: 'INDEX.md tidak terbaca di ' + o.vault, proyek: [] };
  const map = new Map();
  for (const r of tabelMd(index)) {
    const m = r[0] && r[0].match(/\[([^\]]+)\]\(([^)]+)\)/); if (!m) continue;
    map.set(m[1], { nama: m[1], ringkasan: bersih(r[1]), fase: bersih(r[2]), state: path.join(o.vault, m[2]), folder: null, folderAda: false, remote: '', link: [] });
  }
  for (const r of tabelMd(repos)) {
    const nama = bersih(r[0]); if (!nama) continue;
    const p = map.get(nama) || { nama, ringkasan: '', fase: '', state: null, folder: null, folderAda: false, remote: '', link: [] };
    let f = bersih(r[1]); if (f && !/^</.test(f)) { f = f.replace(/\s*\(.*\)$/, ''); p.folder = path.isAbsolute(f) ? f : path.join(o.vault, f); p.folderAda = fs.existsSync(p.folder); }
    p.remote = bersih(r[2]); p.link = links(r[2], r[3]); p.catatan = bersih(r[3]);
    map.set(nama, p);
  }
  // Folder projects/ yang belum tercatat di INDEX.md.
  try { for (const d of fs.readdirSync(path.join(o.vault, 'projects'), { withFileTypes: true })) if (d.isDirectory() && !map.has(d.name)) map.set(d.name, { nama: d.name, ringkasan: '(belum ada di INDEX.md)', fase: '', state: path.join(o.vault, 'projects', d.name, 'STATE.md'), folder: null, folderAda: false, remote: '', link: [] }); } catch (e) {}
  return { vault: o.vault, proyek: [...map.values()] };
}

module.exports = { ringkasan, proyek, panaskan: (CFG) => scanSekali(opsi(CFG)).catch(() => {}), _parseFile: parseFile };

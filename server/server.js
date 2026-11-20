#!/usr/bin/env node
// Kantor Agen — server lokal (tahap 1)
// Menjalankan agen lewat Claude Code (`claude -p`) di laptop, menyimpan data di folder,
// dan menyajikan web kantor 3D + API ke HP/laptop.
// Tanpa library tambahan: cukup Node.js 18+ dan Claude Code yang sudah login.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const usage = require('./usage');

/* ---------------- Konfigurasi ---------------- */
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const DEFAULT_CONFIG = {
  port: 4321,
  host: '0.0.0.0',
  // Semua data (state, log, memori agen) disimpan di sini:
  folderData: path.join(os.homedir(), 'KantorAgen', 'data'),
  // Tiap workspace dapat folder proyek sendiri di sini:
  folderProyek: path.join(os.homedir(), 'KantorAgen', 'proyek'),
  // Satu entri = satu login Claude Code. configDir kosong = login default (~/.claude).
  akun: [{ nama: 'Akun A', configDir: '' }],
  maxAgenPerAkun: 2,
  model: { manajer: 'opus', staf: 'sonnet' },
  // Alat yang boleh dipakai staf. Bash sengaja belum diizinkan di tahap 1.
  alatStaf: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  // Batas biaya-setara per workspace (USD, dari laporan Claude Code). 0 = tanpa batas.
  batasBiaya: 0,
  // Perintah Claude Code. Ganti kalau `claude` tidak ada di PATH.
  perintahClaude: 'claude',
  // PIN akses. Wajib dikirim oleh web (otomatis lewat link yang dicetak saat server jalan).
  pin: '',
  // Fase 0 (dasbor token): folder vault Obsidian (berisi INDEX.md + repos.md).
  vault: '',
  // folderLog kosong = ~/.claude/projects + configDir tiap akun. akun/org: uuid -> nama tampilan.
  // fileLimit: plan-usage-history.json Claude Desktop (opsional, '' = tidak dibaca).
  usage: { folderLog: [], akun: {}, org: {}, fileLimit: '' },
};
let CFG = DEFAULT_CONFIG;
try { CFG = Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
catch (e) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2)); console.log('config.json dibuat dengan nilai bawaan.'); }
if (!CFG.pin) { CFG.pin = String(crypto.randomInt(100000, 999999)); try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2)); } catch (e) {} }
if (process.env.KANTOR_CLAUDE) CFG.perintahClaude = process.env.KANTOR_CLAUDE;
for (const d of [CFG.folderData, CFG.folderProyek, path.join(CFG.folderData, 'agen'), path.join(CFG.folderData, 'log')]) fs.mkdirSync(d, { recursive: true });

/* ---------------- State ---------------- */
const STATE_PATH = path.join(CFG.folderData, 'state.json');
const DIVS = { backend: 'Backend', frontend: 'Frontend', design: 'Desain' };
const NAMES = { backend: ['Bima', 'Sekar', 'Tegar', 'Nadia'], frontend: ['Dimas', 'Laras', 'Fajar', 'Citra'], design: ['Ayu', 'Gilang', 'Rani', 'Yoga'] };
const uid = () => crypto.randomBytes(4).toString('hex');
let S = { ws: [] };
try { S = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
// Proses yang terputus saat server mati dikembalikan ke antrean.
for (const w of S.ws) {
  for (const a of w.agents) { a.state = 'idle'; a.task = null; a.aktivitas = ''; }
  for (const t of w.tasks) if (t.status === 'kerja' || t.status === 'lapor') { t.status = 'antre'; t.agent = null; t.progress = 0; }
  if (w.status === 'planning' || w.status === 'final') w.status = w.tasks.length ? 'running' : 'idle';
}
let saveTimer = null;
function changed() {
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(STATE_PATH, JSON.stringify(S, null, 1), () => {}); }, 400);
  broadcast();
}
function mkAgents() {
  const ag = [{ id: 'mgr', nama: 'Arya', div: 'manager', akun: 0, state: 'idle', selesai: 0, chat: [] }];
  let k = 0;
  for (const d of Object.keys(DIVS)) for (let i = 0; i < 2; i++) ag.push({ id: d + i, nama: NAMES[d][i], div: d, slot: i, akun: (k++) % CFG.akun.length, state: 'idle', selesai: 0, chat: [] });
  return ag;
}
function slug(s) { return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyek').slice(0, 40); }
function newWs(nama) {
  let dir = path.join(CFG.folderProyek, slug(nama)), n = 2;
  while (fs.existsSync(dir) && S.ws.some(w => w.folder === dir)) dir = path.join(CFG.folderProyek, slug(nama) + '-' + n++);
  fs.mkdirSync(dir, { recursive: true });
  const w = { id: uid(), nama, goal: '', status: 'idle', tasks: [], log: [], agents: mkAgents(), biaya: 0, token: 0, ringkasan: '', laporan: '', folder: dir, t0: Date.now() };
  S.ws.push(w); log(w, 'Sistem', 'Workspace dibuat. Folder proyek: ' + dir); return w;
}
function log(w, who, msg) {
  const e = { t: Date.now(), who, msg };
  w.log.unshift(e); if (w.log.length > 300) w.log.length = 300;
  fs.appendFile(path.join(CFG.folderData, 'log', w.id + '.jsonl'), JSON.stringify(e) + '\n', () => {});
  changed();
}
const agentOf = (w, id) => w.agents.find(a => a.id === id);
function memoriPath(a) { return path.join(CFG.folderData, 'agen', a.nama.toLowerCase() + '.md'); }
function memori(a) { try { return fs.readFileSync(memoriPath(a), 'utf8').slice(-4000); } catch (e) { return ''; } }
function ingat(a, teks) { fs.appendFileSync(memoriPath(a), '- ' + teks.replace(/\n/g, ' ') + '\n'); }

/* ---------------- Menjalankan Claude Code ---------------- */
const running = new Map(); // key -> child process
const akunAktif = () => { const m = new Array(CFG.akun.length).fill(0); for (const r of running.values()) m[r.akun]++; return m; };
function q(s) { return process.platform === 'win32' ? '"' + String(s).replace(/"/g, '\\"') + '"' : s; }

function runClaude({ key, w, akun = 0, model, system, prompt, resume, alat, onEvent }) {
  return new Promise((resolve) => {
    const sysFile = path.join(os.tmpdir(), 'kantor-sys-' + uid() + '.txt');
    fs.writeFileSync(sysFile, system || '');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--append-system-prompt-file', sysFile];
    if (alat && alat.length) { args.push('--permission-mode', 'acceptEdits', '--allowedTools', ...alat); }
    else args.push('--disallowedTools', 'Edit', 'Write', 'Bash', 'NotebookEdit');
    if (resume) args.push('--resume', resume);
    const env = Object.assign({}, process.env);
    const ak = CFG.akun[akun % CFG.akun.length] || {};
    if (ak.configDir) env.CLAUDE_CONFIG_DIR = ak.configDir;
    const win = process.platform === 'win32';
    const child = spawn(win ? CFG.perintahClaude : CFG.perintahClaude, win ? args.map(q) : args, { cwd: w.folder, env, shell: win, windowsHide: true });
    running.set(key, { child, akun });
    let buf = '', out = { text: '', session: resume || null, biaya: 0, token: 0, error: null };
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === 'system' && ev.session_id) out.session = ev.session_id;
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const b of ev.message.content) {
            if (b.type === 'tool_use') onEvent && onEvent({ alat: b.name, file: b.input && (b.input.file_path || b.input.pattern || b.input.path) });
            if (b.type === 'text' && b.text) onEvent && onEvent({ teks: b.text });
          }
        }
        if (ev.type === 'result') {
          out.text = ev.result || ''; out.biaya = ev.total_cost_usd || 0;
          const u = ev.usage || {}; out.token = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (ev.session_id) out.session = ev.session_id;
          if (ev.is_error) out.error = out.text || ev.subtype || 'error';
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', d => { errBuf += d; });
    child.on('error', e => { out.error = 'Tidak bisa menjalankan "' + CFG.perintahClaude + '": ' + e.message; });
    child.on('close', code => {
      running.delete(key); fs.unlink(sysFile, () => {});
      if (!out.error && code !== 0 && !out.text) out.error = (errBuf.trim().split('\n').pop() || ('keluar dengan kode ' + code));
      if (out.error && /limit|quota|usage/i.test(out.error)) out.limit = true;
      w.biaya += out.biaya; w.token += out.token;
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}
function stopAll(w) { for (const [k, r] of running) if (k.startsWith(w.id + ':')) { try { r.child.kill(); } catch (e) {} } }

/* ---------------- Alur kerja ---------------- */
const SYS_MGR = 'Kamu Arya, kepala manajer proyek di Kantor Agen. Timmu: divisi backend, frontend, dan design. Jawab dalam bahasa Indonesia.';
async function plan(w) {
  const m = agentOf(w, 'mgr'); m.state = 'rencana'; m.aktivitas = 'menyusun rencana'; changed();
  const tim = Object.keys(DIVS).map(d => DIVS[d] + ': ' + w.agents.filter(a => a.div === d).length + ' orang').join(', ');
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, system: SYS_MGR + '\n\nMemori:\n' + memori(m),
    prompt: 'Brief dari bos: ' + w.goal + '\nNama proyek: ' + w.nama + '\nTim: ' + tim + '\nFolder kerja saat ini bisa kamu baca bila perlu.\n\n' +
      'Pecah brief menjadi 3 sampai 9 tugas konkret. Tiap tugas dikerjakan satu orang dan menghasilkan file di folder proyek. ' +
      'Balas HANYA dengan JSON valid tanpa teks lain, berbentuk: {"ringkasan":"...","tugas":[{"divisi":"backend|frontend|design","judul":"...","detail":"...","setelah":[indeks tugas lain yang harus selesai dulu]}]}',
    onEvent: ev => { if (ev.alat) { m.aktivitas = 'membaca ' + path.basename(String(ev.file || '')); changed(); } } });
  m.state = 'idle'; m.aktivitas = '';
  if (r.error) { w.status = 'idle'; log(w, 'Sistem', 'Manajer gagal menyusun rencana: ' + r.error); return; }
  let j; try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch (e) { w.status = 'idle'; log(w, 'Sistem', 'Rencana manajer bukan JSON yang valid. Coba kirim brief lagi.'); return; }
  const ids = j.tugas.map(() => uid());
  w.tasks = j.tugas.map((t, i) => ({ id: ids[i], div: DIVS[t.divisi] ? t.divisi : 'frontend', title: t.judul, detail: t.detail, status: 'antre', agent: null, progress: 0, after: (t.setelah || []).map(k => ids[k]).filter(Boolean), revisi: 0, coba: 0, output: '', file: [] }));
  w.ringkasan = j.ringkasan || ''; w.status = 'running';
  log(w, 'Arya', 'Rencana siap: ' + w.tasks.length + ' tugas. ' + w.ringkasan);
}
function depsOk(w, t) { return t.after.every(id => { const x = w.tasks.find(y => y.id === id); return !x || x.status === 'selesai' || x.status === 'gagal'; }); }
async function work(w, a, t) {
  t.status = 'kerja'; t.agent = a.id; t.progress = 0.03; a.state = 'kerja'; a.task = t.id; a.aktivitas = 'membaca tugas';
  log(w, a.nama, (t.revisi ? 'Merevisi' : 'Mulai mengerjakan') + ' "' + t.title + '".');
  const deps = t.after.map(id => w.tasks.find(x => x.id === id)).filter(Boolean).map(x => '- ' + x.title + ' (oleh ' + ((agentOf(w, x.agent) || {}).nama || '-') + '): ' + (x.output || '').slice(0, 1500) + (x.file.length ? '\n  File: ' + x.file.join(', ') : '')).join('\n');
  let langkah = 0;
  const r = await runClaude({ key: w.id + ':' + a.id, w, akun: a.akun, model: CFG.model.staf, alat: CFG.alatStaf,
    system: 'Kamu ' + a.nama + ', anggota divisi ' + DIVS[a.div] + ' di Kantor Agen. Kerjakan tugasmu langsung di folder proyek ini dengan membuat atau mengubah file. Jangan mengerjakan tugas divisi lain. Di akhir, tulis ringkasan singkat (maks 120 kata) tentang apa yang kamu buat dan file mana saja.\n\nMemori:\n' + memori(a),
    prompt: 'Proyek: ' + w.nama + '\nBrief: ' + w.goal + '\nRencana manajer: ' + w.ringkasan + '\n\nTugasmu: ' + t.title + '\n' + t.detail + (deps ? '\n\nHasil rekan yang terkait:\n' + deps : '') + (t.catatan ? '\n\nCatatan dari bos/manajer: ' + t.catatan : ''),
    onEvent: ev => {
      if (ev.alat) { langkah++; t.progress = Math.min(0.9, 0.05 + 0.85 * (1 - Math.exp(-langkah / 8)));
        const f = ev.file ? path.basename(String(ev.file)) : '';
        a.aktivitas = ({ Read: 'membaca ', Edit: 'mengedit ', Write: 'menulis ', Glob: 'mencari ', Grep: 'mencari ' }[ev.alat] || ev.alat + ' ') + f;
        if ((ev.alat === 'Write' || ev.alat === 'Edit') && f && !t.file.includes(f)) t.file.push(f);
        changed(); }
    } });
  if (r.session) a.session = r.session;
  if (r.error) {
    t.coba++; t.progress = 0; t.agent = null; a.state = 'idle'; a.task = null; a.aktivitas = '';
    t.status = (r.limit || t.coba >= 2) ? 'gagal' : 'antre';
    log(w, a.nama, 'Gagal mengerjakan "' + t.title + '": ' + r.error);
    if (r.limit) { w.status = 'idle'; stopAll(w); log(w, 'Sistem', 'Kuota akun habis atau dibatasi. Workspace dijeda.'); }
    return;
  }
  t.output = r.text; t.progress = 1; t.status = 'lapor'; a.state = 'lapor'; a.aktivitas = 'lapor ke manajer';
  log(w, a.nama, 'Selesai "' + t.title + '", menyerahkan ke Manajer.');
  // Tahap 1: review manajer otomatis tanpa memanggil Claude (hemat token). Jeda sebentar supaya terlihat di kantor.
  setTimeout(() => {
    if (t.status !== 'lapor') return;
    t.status = 'selesai'; a.selesai++; a.state = 'kembali'; a.aktivitas = '';
    log(w, 'Arya', 'Menerima "' + t.title + '".');
    setTimeout(() => { if (a.state === 'kembali') { a.state = 'idle'; a.task = null; } changed(); }, 4000);
  }, 5000);
}
async function final(w) {
  w.status = 'final'; const m = agentOf(w, 'mgr'); m.state = 'rangkum'; m.aktivitas = 'menulis laporan';
  log(w, 'Arya', 'Semua tugas masuk. Menyusun laporan akhir.');
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, system: SYS_MGR,
    prompt: 'Brief: ' + w.goal + '\n\nHasil tim:\n' + w.tasks.map(t => '- [' + t.div + '] ' + t.title + ' (' + t.status + '): ' + (t.output || '').slice(0, 800) + (t.file.length ? ' File: ' + t.file.join(', ') : '')).join('\n') +
      '\n\nTulis laporan akhir untuk bos (maks 250 kata): apa yang sudah jadi, file mana yang perlu dibuka, dan langkah berikutnya. Boleh baca file di folder ini untuk mengecek.' });
  w.laporan = r.error ? 'Laporan akhir gagal dibuat: ' + r.error : r.text;
  m.state = 'idle'; m.aktivitas = ''; w.status = 'done';
  log(w, 'Arya', 'Proyek selesai. Laporan akhir siap dibaca.');
}
async function chat(w, a, pesan) {
  a.chat.push({ dari: 'kamu', teks: pesan, t: Date.now() });
  if (/^ingat[:,]/i.test(pesan)) { ingat(a, pesan.replace(/^ingat[:,]\s*/i, '')); a.chat.push({ dari: a.nama, teks: 'Dicatat di memoriku.', t: Date.now() }); changed(); return; }
  const key = w.id + ':' + a.id + ':chat';
  if (running.has(w.id + ':' + a.id) || running.has(key)) {
    const t = a.task && w.tasks.find(x => x.id === a.task);
    if (t) { t.catatan = ((t.catatan || '') + ' ' + pesan).trim(); }
    a.chat.push({ dari: a.nama, teks: 'Aku sedang mengerjakan tugas. Pesanmu kucatat untuk tugas ini/berikutnya.', t: Date.now() }); changed(); return;
  }
  const prevState = a.state; a.state = a.div === 'manager' ? 'review' : 'kerja'; a.aktivitas = 'membalas chat'; changed();
  const r = await runClaude({ key, w, akun: a.akun, model: a.div === 'manager' ? CFG.model.manajer : CFG.model.staf, resume: a.session,
    alat: a.div === 'manager' ? null : CFG.alatStaf,
    system: (a.div === 'manager' ? SYS_MGR : 'Kamu ' + a.nama + ', anggota divisi ' + DIVS[a.div] + ' di Kantor Agen.') + ' Bos sedang mengobrol langsung denganmu. Jawab singkat.\n\nMemori:\n' + memori(a),
    prompt: 'Status proyek: ' + w.status + '. Tugas: ' + w.tasks.map(t => t.title + ' [' + t.status + ']').join('; ') + '\n\nPesan bos: ' + pesan });
  if (r.session) a.session = r.session;
  a.chat.push({ dari: a.nama, teks: r.error ? 'Gagal membalas: ' + r.error : r.text, t: Date.now() });
  if (a.chat.length > 60) a.chat.splice(0, a.chat.length - 60);
  a.state = prevState === 'kerja' ? 'idle' : prevState; a.aktivitas = ''; changed();
}
// Penjadwal: tiap detik, beri tugas ke staf yang kosong selama kuota akun masih ada.
setInterval(() => {
  for (const w of S.ws) {
    if (w.status !== 'running') continue;
    if (CFG.batasBiaya > 0 && w.biaya >= CFG.batasBiaya) { w.status = 'idle'; log(w, 'Sistem', 'Batas biaya workspace tercapai ($' + CFG.batasBiaya + '). Dijeda.'); continue; }
    const aktif = akunAktif();
    for (const a of w.agents) {
      if (a.div === 'manager' || a.state !== 'idle') continue;
      if (aktif[a.akun] >= CFG.maxAgenPerAkun) continue;
      const t = w.tasks.find(t => t.status === 'antre' && t.div === a.div && depsOk(w, t));
      if (t) { aktif[a.akun]++; work(w, a, t); }
    }
    if (w.tasks.length && w.tasks.every(t => t.status === 'selesai' || t.status === 'gagal') && !w.agents.some(a => a.state === 'lapor' || a.state === 'kerja')) final(w);
  }
}, 1000);

/* ---------------- HTTP ---------------- */
const clients = new Set();
let bcTimer = null;
function snapshot() { return JSON.stringify({ ws: S.ws, info: { akun: CFG.akun.map(a => a.nama), aktif: akunAktif(), maxAgenPerAkun: CFG.maxAgenPerAkun, model: CFG.model, folderData: CFG.folderData, folderProyek: CFG.folderProyek, batasBiaya: CFG.batasBiaya } }); }
function broadcast() { if (bcTimer) return; bcTimer = setTimeout(() => { bcTimer = null; const s = 'data: ' + snapshot() + '\n\n'; for (const c of clients) c.write(s); }, 250); }
function body(req) { return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
const WEB = path.join(ROOT, '..', 'index.html');
const DASBOR = path.join(ROOT, '..', 'dashboard.html');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(WEB).pipe(res); }
    if (req.method === 'GET' && u.pathname === '/dashboard.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(DASBOR).pipe(res); }
    if (p[0] !== 'api') { res.writeHead(404); return res.end('Tidak ada'); }
    if ((req.headers['x-pin'] || u.searchParams.get('pin')) !== CFG.pin) return send(res, 401, { error: 'PIN salah' });
    if (p[1] === 'state') return send(res, 200, JSON.parse(snapshot()));
    if (req.method === 'GET' && p[1] === 'usage') return send(res, 200, await usage.ringkasan(CFG));
    if (req.method === 'GET' && p[1] === 'projects') return send(res, 200, usage.proyek(CFG));
    if (p[1] === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: ' + snapshot() + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (req.method !== 'POST') return send(res, 405, { error: 'Pakai POST' });
    const b = await body(req);
    if (p[1] === 'ws' && !p[2]) { const w = newWs(String(b.nama || 'Proyek ' + (S.ws.length + 1)).slice(0, 60)); return send(res, 200, { id: w.id }); }
    const w = S.ws.find(x => x.id === p[2]); if (!w) return send(res, 404, { error: 'Workspace tidak ditemukan' });
    const act = p[3];
    if (act === 'brief') {
      if (w.status === 'planning' || w.status === 'running' || w.status === 'final') return send(res, 409, { error: 'Proyek masih berjalan' });
      w.goal = String(b.goal || '').slice(0, 2000); w.tasks = []; w.laporan = ''; w.ringkasan = ''; w.status = 'planning';
      log(w, 'Arya', 'Menerima brief: "' + w.goal + '". Menyusun rencana kerja.'); plan(w).then(changed); return send(res, 200, { ok: true });
    }
    if (act === 'stop') { w.status = 'idle'; stopAll(w); for (const a of w.agents) { a.state = 'idle'; a.task = null; a.aktivitas = ''; } for (const t of w.tasks) if (t.status === 'kerja' || t.status === 'lapor') { t.status = 'antre'; t.agent = null; t.progress = 0; } log(w, 'Sistem', 'Proyek dihentikan.'); return send(res, 200, { ok: true }); }
    if (act === 'lanjut') { if (w.tasks.length && w.status === 'idle') { w.status = 'running'; log(w, 'Sistem', 'Proyek dilanjutkan.'); } return send(res, 200, { ok: true }); }
    if (act === 'rename') { w.nama = String(b.nama || w.nama).slice(0, 60); changed(); return send(res, 200, { ok: true }); }
    if (act === 'hapus') { stopAll(w); S.ws = S.ws.filter(x => x !== w); changed(); return send(res, 200, { ok: true, catatan: 'Folder proyek tidak ikut dihapus.' }); }
    if (act === 'retry') { const t = w.tasks.find(x => x.id === b.task); if (t) { t.status = 'antre'; t.coba = 0; t.agent = null; if (w.status === 'done' || w.status === 'idle') w.status = 'running'; changed(); } return send(res, 200, { ok: true }); }
    if (act === 'agen') {
      if (w.status === 'running' || w.status === 'planning') return send(res, 409, { error: 'Tunggu proyek selesai atau hentikan dulu' });
      const div = b.div; const list = w.agents.filter(a => a.div === div); if (!DIVS[div]) return send(res, 400, { error: 'Divisi tidak dikenal' });
      if (b.tambah && list.length < 4) { const i = list.length; w.agents.push({ id: div + i, nama: NAMES[div][i], div, slot: i, akun: w.agents.length % CFG.akun.length, state: 'idle', selesai: 0, chat: [] }); }
      if (!b.tambah && list.length > 1) { const a = list[list.length - 1]; w.agents = w.agents.filter(x => x !== a); }
      changed(); return send(res, 200, { ok: true });
    }
    if (act === 'chat') { const a = agentOf(w, b.agent); if (!a) return send(res, 404, { error: 'Agen tidak ditemukan' }); chat(w, a, String(b.pesan || '').slice(0, 4000)); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'Aksi tidak dikenal' });
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
}).listen(CFG.port, CFG.host, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\nKantor Agen jalan.');
  console.log('  Di laptop : http://localhost:' + CFG.port + '/?pin=' + CFG.pin);
  console.log('  Dasbor    : http://localhost:' + CFG.port + '/dashboard.html?pin=' + CFG.pin);
  usage.panaskan(CFG);
  ips.forEach(ip => console.log('  Di HP (wifi yang sama): http://' + ip + ':' + CFG.port + '/?pin=' + CFG.pin));
  console.log('  PIN      : ' + CFG.pin + '  (jangan dibagikan)');
  console.log('  Data     : ' + CFG.folderData);
  console.log('  Proyek   : ' + CFG.folderProyek + '\n');
}).on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error('\nPort ' + CFG.port + ' sudah dipakai. Kemungkinan server agent-office sudah jalan.');
  console.error('  Buka     : http://localhost:' + CFG.port + '/?pin=' + CFG.pin);
  console.error('  Dasbor   : http://localhost:' + CFG.port + '/dashboard.html?pin=' + CFG.pin);
  console.error('  Atau matikan proses lama:');
  console.error('    netstat -ano | findstr :' + CFG.port);
  console.error('    taskkill /PID <pid> /F   (pid = angka di kolom terakhir)\n');
  process.exit(1);
});
process.on('SIGINT', () => { for (const r of running.values()) try { r.child.kill(); } catch (e) {} fs.writeFileSync(STATE_PATH, JSON.stringify(S, null, 1)); process.exit(0); });

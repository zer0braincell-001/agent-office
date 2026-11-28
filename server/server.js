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
  // Chat "penjaga ruang" di ruang proyek (tanpa alat, konteks STATE/NEXT proyek itu saja).
  modelChat: 'sonnet',
  // Batas biaya-setara harian (USD) untuk semua chat ruang proyek. Tercapai = chat ditolak (429) sampai besok. 0 = tanpa batas.
  batasChatHarian: 0.5,
  // Tahap B (Jalankan di ruang proyek): batas biaya-setara per run (USD, --max-budget-usd). 0 = tanpa batas.
  batasJalankan: 1,
  // Folder git worktree agen. Kosong = <induk folderData>/worktree (mis. D:\KantorAgen\worktree). Tidak boleh di dalam repo/vault.
  folderWorktree: '',
  // Alat yang boleh dipakai staf. Bash sengaja belum diizinkan di tahap 1.
  alatStaf: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  // Batas biaya-setara per workspace (USD, dari laporan Claude Code). 0 = tanpa batas.
  // Tiap workspace bisa punya batas sendiri; kosong = pakai angka ini.
  batasBiaya: 0,
  // Batas langkah (--max-turns) per sesi Claude. 0 = tidak dikirim. Solo memakai angka staf.
  maxTurns: { staf: 25, manajer: 10 },
  // Perintah Claude Code. Ganti kalau `claude` tidak ada di PATH.
  perintahClaude: 'claude',
  // PIN akses. Wajib dikirim oleh web (otomatis lewat link yang dicetak saat server jalan).
  pin: '',
  // Fase 0 (dasbor token): folder vault Obsidian (berisi INDEX.md + repos.md).
  vault: '',
  // Fase 3b (lorong proyek): path INDEX.md vault. Hanya file ini yang dibaca (read-only) untuk GET /api/proyek.
  indexVault: '',
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
// Token baca-saja per workspace untuk /hasil/<token>/<path> (128 bit). Bukan PIN: tidak berlaku untuk /api.
const tokenHasil = () => crypto.randomBytes(16).toString('hex');
let S = { ws: [] };
try { S = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
// Proses yang terputus saat server mati dikembalikan ke antrean.
for (const w of S.ws) {
  for (const a of w.agents) { a.state = 'idle'; a.task = null; a.aktivitas = ''; }
  for (const t of w.tasks) if (t.status === 'kerja' || t.status === 'lapor') { t.status = 'antre'; t.agent = null; t.progress = 0; }
  if (w.status === 'planning' || w.status === 'final') w.status = w.tasks.length ? 'running' : 'idle';
  if (!w.aksesHasil) w.aksesHasil = tokenHasil();
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
/* Batas panjang input user (karakter). Lewat batas = ditolak 400 dengan pesan jelas, TIDAK dipotong diam-diam
   (27-11: brief 2.600 karakter terpotong di 2.000, agen kehilangan daftar larangan di akhir brief). Dikirim ke web lewat info. */
const BATAS_INPUT = { brief: 12000, chat: 4000, nama: 60 };
function terlaluPanjang(teks, jenis, label) {
  const n = teks.length, max = BATAS_INPUT[jenis];
  return n > max ? label + ' terlalu panjang: ' + n + ' karakter, batasnya ' + max + '. Tidak ada yang dikirim; pendekkan dulu.' : null;
}
const cuplikan = (s, n = 200) => s.length > n ? s.slice(0, n) + '… (' + s.length + ' karakter)' : s;
function slug(s) { return (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'proyek').slice(0, 40); }
// Folder baru selalu unik: nama yang sudah dipakai workspace lain, atau folder yang sudah ada dan tidak kosong
// (mis. sisa workspace yang dihapus — Hapus sengaja tidak menghapus folder), dilewati → -2, -3, dst.
// Folder lama tidak dihapus/dipindah. Rename workspace tidak memindahkan folder.
const samaPath = (a, b) => { const r = x => path.resolve(x); return process.platform === 'win32' ? r(a).toLowerCase() === r(b).toLowerCase() : r(a) === r(b); };
function folderTerpakai(dir) {
  if (S.ws.some(w => w.folder && samaPath(w.folder, dir))) return true;
  let st; try { st = fs.statSync(dir); } catch (e) { return false; } // belum ada
  if (!st.isDirectory()) return true;
  try { return fs.readdirSync(dir).length > 0; } catch (e) { return true; }
}
function newWs(nama) {
  const dasar = slug(nama); let dir = path.join(CFG.folderProyek, dasar), n = 2;
  while (folderTerpakai(dir)) dir = path.join(CFG.folderProyek, dasar + '-' + n++);
  fs.mkdirSync(dir, { recursive: true });
  const w = { id: uid(), nama, goal: '', status: 'idle', tasks: [], log: [], agents: mkAgents(), biaya: 0, token: 0, ringkasan: '', laporan: '', folder: dir, aksesHasil: tokenHasil(), t0: Date.now() };
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

/* Rincian token: input, output, tulis cache, baca cache, biaya-setara (USD). */
const rincianKosong = () => ({ inp: 0, out: 0, cw: 0, cr: 0, usd: 0, sesi: 0 });
function tambahRincian(a, r) { for (const k of ['inp', 'out', 'cw', 'cr', 'usd', 'sesi']) a[k] = (a[k] || 0) + (r[k] || 0); if (r.sebagian) a.sebagian = true; return a; }
const dariUsage = (u, usd) => ({ inp: u.input_tokens || 0, out: u.output_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0, usd: usd || 0, sesi: 1 });
/* Batas biaya: per workspace (w.batas) atau global (CFG.batasBiaya). 0/kosong = tanpa batas. */
function batasEfektif(w) { const b = w.batas != null && w.batas !== '' ? +w.batas : +CFG.batasBiaya; return b > 0 ? b : 0; }
function lewatBatas(w) { const b = batasEfektif(w); return b > 0 && (w.biaya || 0) >= b; }
function jedaBiaya(w, dari) {
  if (w.status === 'jeda-biaya') return;
  w.status = 'jeda-biaya'; w.jedaDari = dari;
  log(w, 'Sistem', 'Dijeda: batas biaya tercapai ($' + (w.biaya || 0).toFixed(2) + ' dari $' + batasEfektif(w).toFixed(2) + '). Naikkan batas untuk melanjutkan.');
}
/* Rem darurat: matikan seluruh pohon proses (di Windows `claude` jalan lewat cmd.exe karena shell:true). */
function bunuh(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch (e) {} }
  else { try { child.kill('SIGTERM'); } catch (e) {} }
}
// Status akhir tugas. `dihentikan` sengaja TIDAK termasuk: tugas itu belum jadi, turunannya menunggu,
// final() tidak jalan, dan Lanjutkan mengantrekannya ulang. gagal/batas-langkah diulang lewat Coba lagi.
// `dilewati` = tugas dihentikan yang sengaja dilewati user: dihitung selesai seperti gagal (turunannya jalan tanpa hasilnya).
const SELESAI_TUGAS = ['selesai', 'gagal', 'batas-langkah', 'dilewati'];

const ALAT_MANAJER = 'Read,Glob,Grep';
/* Akun agen belum login (2a-2i). Claude Code tanpa kredensial mengembalikan result is_error (subtype bisa "success",
   biaya 0) berisi "Not logged in · Please run /login". Itu bukan error tugas: jangan retry, kembalikan tugas ke antrean,
   workspace "butuh-login" sampai user login lalu menekan "Sudah login, lanjutkan". */
const POLA_LOGIN = /not logged in|please run \/login|invalid api key|oauth token has expired|authentication_error/i;
const dirAkun = (ak) => (ak && ak.configDir) || path.join(os.homedir(), '.claude');
function infoAkun(i) { const ak = CFG.akun[i % CFG.akun.length] || {}; return { nama: ak.nama || ('Akun ' + (i + 1)), configDir: dirAkun(ak) }; }
function butuhLogin(w, akun, dari) {
  if (w.status === 'butuh-login') return; // sesi paralel lain yang gagal login: cukup satu log
  const ak = infoAkun(akun);
  w.status = 'butuh-login'; w.loginDari = dari; w.loginAkun = ak;
  log(w, 'Sistem', 'Akun agen belum login: ' + ak.nama + ' (configDir ' + ak.configDir + '). Tugas dikembalikan ke antrean, tidak ada panggilan Claude baru. ' +
    'Cara login (PowerShell): $env:CLAUDE_CONFIG_DIR="' + ak.configDir + '"; claude  lalu ketik /login. Setelah itu tekan "Sudah login, lanjutkan".');
}
/* Cek awal: hanya keberadaan <configDir>\.credentials.json (isi tidak dibaca). Peringatan saja, tidak memblokir:
   kredensial bisa tersimpan di tempat lain. */
let PERINGATAN_LOGIN = [];
function cekKredensial() {
  PERINGATAN_LOGIN = CFG.akun.map((ak, i) => infoAkun(i)).filter(x => !fs.existsSync(path.join(x.configDir, '.credentials.json')));
  return PERINGATAN_LOGIN;
}
/* Diagnostik biaya (2a-2h): satu baris per sesi Claude di <folderData>/sesi.jsonl. Murni pencatatan, tidak dipakai
   untuk perhitungan apa pun. Tanpa teks prompt/output. Gagal menulis = diam. */
const SESI_LOG = path.join(CFG.folderData, 'sesi.jsonl');
function jumlahStream(usagePesan, nEvent) {
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (const x of usagePesan.values()) for (const k of Object.keys(u)) u[k] += +x[k] || 0;
  return { pesanUnik: usagePesan.size, eventAssistant: nEvent, usage: u };
}
function catatSesi(baris) { try { fs.appendFile(SESI_LOG, JSON.stringify(baris) + '\n', () => {}); } catch (e) {} }
/* Chat ruang proyek memanggil runClaude dengan w = null dan `ruang`: { cwd, sesi } (lihat chatRuang). Bedanya:
   --tools "" (tanpa alat sama sekali) + --disable-slash-commands, --system-prompt-file (MENGGANTI system prompt
   bawaan Claude Code, jadi tidak ada info cwd/env/alat), --no-session-persistence, cwd = folder kosong khusus,
   biaya tidak masuk workspace mana pun. */
function runClaude({ key, w, akun = 0, model, system, prompt, resume, alat, onEvent, maxTurns = 0, peran = '', tugas = null, ruang = null }) {
  // Gerbang batas biaya: dicek sebelum SETIAP panggilan baru. Pemanggil yang memutuskan jeda.
  if (w && lewatBatas(w)) return Promise.resolve({ text: '', session: resume || null, biaya: 0, token: 0, error: 'Batas biaya workspace tercapai', batas: true, rincian: rincianKosong() });
  return new Promise((resolve) => {
    const sysFile = path.join(os.tmpdir(), 'kantor-sys-' + uid() + '.txt');
    fs.writeFileSync(sysFile, system || '');
    // Alat. Staf: --tools MEMBATASI alat bawaan yang tersedia (--allowedTools hanya izin otomatis; di
    // acceptEdits Bash read-only seperti `ls` tetap jalan tanpa --tools). Tanpa alat = jalur manajer (rencana,
    // laporan, chat manajer): --tools Read,Glob,Grep. Dulu cuma --disallowedTools, sehingga manajer membawa ~20 alat
    // (Task, Cron*, RemoteTrigger, ScheduleWakeup, SendMessage, Skill, ...) dan bisa membuat jadwal/trigger (uji 20-11).
    // Opsi variadik dikirim sebagai SATU argumen dipisah koma dan selalu diikuti opsi lain (--output-format),
    // jadi tidak ada argumen berikutnya yang tertelan sebagai nama alat. Prompt dikirim lewat stdin.
    const daftarAlat = (alat || []).filter(Boolean).join(',');
    // Jalankan (ruang.mode 'kerja'): alat staf tanpa Bash; dontAsk = yang tidak ada di --allowedTools otomatis DITOLAK;
    // Edit/Write hanya di dalam worktree; --setting-sources user = izin/hook dari .claude/ repo tidak dimuat.
    const kerja = ruang && ruang.mode === 'kerja';
    const setFile = kerja ? path.join(os.tmpdir(), 'kantor-set-' + uid() + '.json') : null;
    if (setFile) fs.writeFileSync(setFile, JSON.stringify(SETELAN_JALAN));
    const argAlat = kerja ? ['--tools', ALAT_JALAN.join(','), '--allowedTools', ruang.izin.join(','), '--disallowedTools', ruang.tolak.join(','),
        '--permission-mode', 'dontAsk', '--settings', setFile,
        '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence'].concat(ruang.budget > 0 ? ['--max-budget-usd', String(ruang.budget)] : [])
      : ruang ? ['--tools', '', '--disable-slash-commands', '--no-session-persistence']
      : daftarAlat ? ['--tools', daftarAlat, '--allowedTools', daftarAlat, '--permission-mode', 'acceptEdits']
      : ['--tools', ALAT_MANAJER];
    // MCP: agen tidak boleh punya alat MCP apa pun. --strict-mcp-config tanpa --mcp-config = server dari
    // .mcp.json, ~/.claude.json, dan plugin tidak dimuat (CLI reference). Konektor claude.ai tidak disebut
    // di sana; switch resminya ENABLE_CLAUDEAI_MCP_SERVERS=false (docs MCP, "Disable claude.ai connectors").
    const args = ['-p', ...argAlat, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--model', model, ruang && !kerja ? '--system-prompt-file' : '--append-system-prompt-file', sysFile];
    if (maxTurns > 0) args.push('--max-turns', String(maxTurns));
    if (resume) args.push('--resume', resume);
    const env = Object.assign({}, process.env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    const ak = CFG.akun[akun % CFG.akun.length] || {};
    if (ak.configDir) env.CLAUDE_CONFIG_DIR = ak.configDir;
    const win = process.platform === 'win32';
    const child = spawn(win ? CFG.perintahClaude : CFG.perintahClaude, win ? args.map(q) : args, { cwd: ruang ? ruang.cwd : w.folder, env, shell: win, windowsHide: true });
    running.set(key, { child, akun });
    let buf = '', out = { text: '', session: resume || null, biaya: 0, token: 0, error: null, rincian: null, teksTerakhir: '' };
    const usagePesan = new Map(); // message.id -> usage; cadangan kalau sesi dihentikan sebelum ada pesan result
    let nEventAssistant = 0, adaResult = false; const modelStream = new Set(); // diagnostik sesi.jsonl
    const dasarSesi = () => Object.assign({ t: new Date().toISOString(), ws: w ? w.id : null, tugas, peran, model }, ruang ? ruang.sesi : null);
    child.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === 'system' && ev.session_id) out.session = ev.session_id;
        // Diagnostik alat: satu baris per sesi dari event init (SDKSystemMessage: tools string[], mcp_servers {name,status}[]).
        if (ev.type === 'system' && ev.subtype === 'init' && !out.initDicatat) {
          out.initDicatat = true;
          const alatAda = (Array.isArray(ev.tools) ? ev.tools : []).map(x => typeof x === 'string' ? x : (x && x.name) || '?');
          const mcp = (Array.isArray(ev.mcp_servers) ? ev.mcp_servers : []).map(s => typeof s === 'string' ? s : (s && s.name || '?') + (s && s.status ? ' (' + s.status + ')' : ''));
          out.alatInit = { alat: alatAda, mcp };
          if (ruang) { ruang.sesi.alat = alatAda; ruang.sesi.mcp = mcp; console.log('[' + (kerja ? 'jalan ' : 'ruang ') + ruang.sesi.slug + '] Alat tersedia (' + alatAda.length + '): ' + (alatAda.join(', ') || '-') + ' · MCP: ' + (mcp.length ? mcp.join(', ') : 'tidak ada')); }
          else { const [, aid, ekstra] = key.split(':'); const ag = agentOf(w, aid);
          log(w, (ag ? ag.nama : 'Sistem') + (ekstra === 'chat' ? ' (chat)' : ''), 'Alat tersedia (' + alatAda.length + '): ' + (alatAda.join(', ') || '-') + ' · MCP: ' + (mcp.length ? mcp.join(', ') : 'tidak ada')); }
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          if (ev.message.usage) { usagePesan.set(ev.message.id || ('m' + usagePesan.size), ev.message.usage); nEventAssistant++; }
          if (ev.message.model) modelStream.add(ev.message.model);
          for (const b of ev.message.content) {
            if (b.type === 'tool_use') onEvent && onEvent({ alat: b.name, file: b.input && (b.input.file_path || b.input.pattern || b.input.path) });
            if (b.type === 'text' && b.text) { out.teksTerakhir = b.text; onEvent && onEvent({ teks: b.text }); }
          }
        }
        if (ev.type === 'result') {
          out.text = ev.result || ''; out.biaya = ev.total_cost_usd || 0; out.penolakan = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
          out.rincian = dariUsage(ev.usage || {}, out.biaya);
          if (ev.session_id) out.session = ev.session_id;
          if (ev.subtype === 'error_max_turns') { out.maxTurns = true; out.error = 'Batas langkah (--max-turns ' + maxTurns + ') tercapai'; }
          else if (ev.is_error) out.error = out.text || ev.subtype || 'error';
          adaResult = true;
          catatSesi(Object.assign(dasarSesi(), { subtype: ev.subtype, is_error: ev.is_error, num_turns: ev.num_turns, duration_ms: ev.duration_ms,
            session_id: ev.session_id || out.session, total_cost_usd: 'total_cost_usd' in ev ? ev.total_cost_usd : null, total_cost_usd_ada: 'total_cost_usd' in ev,
            usage: 'usage' in ev ? ev.usage : null, modelUsage: ev.modelUsage, stream: Object.assign(jumlahStream(usagePesan, nEventAssistant), { model: [...modelStream] }) }));
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', d => { errBuf += d; });
    child.on('error', e => { out.error = 'Tidak bisa menjalankan "' + CFG.perintahClaude + '": ' + e.message; });
    child.on('close', code => {
      running.delete(key); fs.unlink(sysFile, () => {}); if (setFile) fs.unlink(setFile, () => {});
      if (!adaResult) catatSesi(Object.assign(dasarSesi(), { subtype: 'tanpa-result', exitCode: code, session_id: out.session,
        stream: Object.assign(jumlahStream(usagePesan, nEventAssistant), { model: [...modelStream] }) }));
      if (!out.error && code !== 0 && !out.text) out.error = (errBuf.trim().split('\n').pop() || ('keluar dengan kode ' + code));
      if (out.error && !out.maxTurns && (POLA_LOGIN.test(out.error) || POLA_LOGIN.test(out.text) || POLA_LOGIN.test(errBuf))) out.login = true;
      else if (out.error && !out.maxTurns && /limit|quota|usage/i.test(out.error)) out.limit = true;
      if (!out.rincian) { // tanpa result (mis. dihentikan): pakai usage per pesan yang sudah terbaca; biaya tidak diketahui
        out.rincian = rincianKosong(); out.rincian.sesi = 1; out.rincian.sebagian = true;
        for (const u of usagePesan.values()) tambahRincian(out.rincian, Object.assign(dariUsage(u, 0), { sesi: 0 }));
      }
      const r = out.rincian; out.token = r.inp + r.out + r.cw + r.cr;
      if (w) { w.biaya = (w.biaya || 0) + out.biaya; w.token = (w.token || 0) + out.token;
        w.rincian = tambahRincian(w.rincian || rincianKosong(), r); }
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}
function stopAll(w) { for (const [k, r] of running) if (k.startsWith(w.id + ':')) bunuh(r.child); }
const mt = (peran) => { const v = (CFG.maxTurns || {})[peran]; return v > 0 ? +v : 0; };

/* ---------------- Alur kerja ---------------- */
// Perkiraan kasar biaya-setara (USD) untuk Usulan mode Tim, TANPA memanggil Claude.
// Sumber: uji asli 20-11 (3 tugas nyata 121k token / $0,39; perkiraan token lama 360k terlalu tinggi);
// uji Tim ulang 20-11 setelah manajer --tools Read,Glob,Grep: total $0,23, manajer ~$0,135 → manajer 0,15.
// manajer = rencana + laporan akhir. Ubah angkanya di sini saja.
const PERKIRAAN = { perTugasStaf: 0.04, manajer: 0.15 };
const perkiraanUsd = (nTugas) => Math.round((nTugas * PERKIRAAN.perTugasStaf + PERKIRAAN.manajer) * 100) / 100;
const SYS_MGR = 'Kamu Arya, kepala manajer proyek di Kantor Agen. Timmu: divisi backend, frontend, dan design. Jawab dalam bahasa Indonesia. Sapa pemilik proyek dengan "kamu", jangan "Bapak/Ibu".';
// Mode Solo: satu sesi staf mengerjakan brief langsung, tanpa rencana dan tanpa laporan manajer.
function mulaiSolo(w) {
  const a = w.agents.find(x => x.div !== 'manager' && x.state === 'idle') || w.agents.find(x => x.div !== 'manager');
  w.tasks = [{ id: uid(), div: a.div, title: 'Kerjakan brief (Solo)', detail: w.goal, status: 'antre', agent: null, pinAgent: a.id, solo: true, progress: 0, after: [], revisi: 0, coba: 0, output: '', file: [] }];
  w.ringkasan = 'Mode Solo: dikerjakan ' + a.nama + ' sendirian dalam satu sesi, tanpa manajer.'; w.status = 'running';
  log(w, 'Sistem', 'Mode Solo: ' + a.nama + ' mengerjakan brief langsung (1 sesi Claude, tanpa manajer).');
}
async function plan(w) {
  const m = agentOf(w, 'mgr'); m.state = 'rencana'; m.aktivitas = 'menyusun rencana'; changed();
  const tim = Object.keys(DIVS).map(d => DIVS[d] + ': ' + w.agents.filter(a => a.div === d).length + ' orang').join(', ');
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, maxTurns: mt('manajer'), peran: 'manajer-rencana', system: SYS_MGR + '\n\nMemori:\n' + memori(m),
    prompt: 'Brief dari bos: ' + w.goal + '\nNama proyek: ' + w.nama + '\nTim: ' + tim + '\nFolder kerja saat ini bisa kamu baca bila perlu.\n\n' +
      'Pecah brief menjadi 1 sampai 9 tugas konkret. Tiap tugas dikerjakan satu orang dan menghasilkan file di folder proyek. ' +
      'Aturan: jangan membuat tugas panduan, format, draf, atau review kecuali brief memintanya. Boleh hanya 1 tugas. ' +
      'Pecah hanya kalau bagian-bagiannya memang bisa dikerjakan terpisah; tiap tugas tambahan menambah biaya. ' +
      'Balas HANYA dengan JSON valid tanpa teks lain, berbentuk: {"ringkasan":"...","tugas":[{"divisi":"backend|frontend|design","judul":"...","detail":"...","setelah":[indeks tugas lain yang harus selesai dulu]}]}',
    onEvent: ev => { if (ev.alat) { m.aktivitas = 'membaca ' + path.basename(String(ev.file || '')); changed(); } } });
  m.state = 'idle'; m.aktivitas = '';
  if (r.batas) { jedaBiaya(w, 'plan'); return; }
  if (w.status === 'dihentikan') return; // dihentikan lewat rem darurat saat menyusun rencana
  if (r.login) { butuhLogin(w, 0, 'plan'); return; }
  if (r.error) { w.status = 'idle'; log(w, 'Sistem', 'Manajer gagal menyusun rencana: ' + r.error); return; }
  let j; try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch (e) { w.status = 'idle'; log(w, 'Sistem', 'Rencana manajer bukan JSON yang valid. Coba kirim brief lagi.'); return; }
  const ids = j.tugas.map(() => uid());
  w.tasks = j.tugas.map((t, i) => ({ id: ids[i], div: DIVS[t.divisi] ? t.divisi : 'frontend', title: t.judul, detail: t.detail, status: 'antre', agent: null, progress: 0, after: (t.setelah || []).map(k => ids[k]).filter(Boolean), revisi: 0, coba: 0, output: '', file: [] }));
  w.ringkasan = j.ringkasan || '';
  // Tim: rencana jadi Usulan dulu. Staf baru jalan setelah user menekan Jalankan.
  w.usulan = { tugas: w.tasks.length, perkiraanUsd: perkiraanUsd(w.tasks.length), rumus: PERKIRAAN };
  w.status = 'usulan';
  log(w, 'Arya', 'Usulan siap: ' + w.tasks.length + ' tugas, perkiraan kasar ±$' + w.usulan.perkiraanUsd.toFixed(2).replace('.', ',') + ' biaya-setara. Tekan Jalankan untuk mulai. ' + w.ringkasan);
}
function depsOk(w, t) { return t.after.every(id => { const x = w.tasks.find(y => y.id === id); return !x || SELESAI_TUGAS.includes(x.status); }); }
async function work(w, a, t) {
  if (lewatBatas(w)) { jedaBiaya(w, 'jadwal'); return; }
  t.status = 'kerja'; t.agent = a.id; t.progress = 0.03; a.state = 'kerja'; a.task = t.id; a.aktivitas = 'membaca tugas';
  log(w, a.nama, (t.revisi ? 'Merevisi' : 'Mulai mengerjakan') + ' "' + t.title + '".');
  const deps = t.after.map(id => w.tasks.find(x => x.id === id)).filter(Boolean).map(x => '- ' + x.title + ' (oleh ' + ((agentOf(w, x.agent) || {}).nama || '-') + '): ' + (x.output || '').slice(0, 1500) + (x.file.length ? '\n  File: ' + x.file.join(', ') : '')).join('\n');
  let langkah = 0;
  const r = await runClaude({ key: w.id + ':' + a.id, w, akun: a.akun, model: CFG.model.staf, alat: CFG.alatStaf, maxTurns: mt('staf'), peran: t.solo ? 'solo' : 'staf', tugas: t.id,
    system: t.solo
      ? 'Kamu ' + a.nama + ' di Kantor Agen. Kerjakan brief ini sendirian, langsung di folder proyek ini dengan membuat atau mengubah file. Kerjakan secukupnya sesuai brief, tanpa file panduan/draf tambahan. ' +
        'Di akhir, tulis laporan singkat (maks 150 kata) dalam bahasa Indonesia kasual untuk pemilik proyek, sapa dengan "kamu": apa yang sudah jadi dan langkah berikutnya kalau ada. Sebut setiap file hasil dalam backtick, misalnya `catatan.md`. Hasil web dibuka pemilik proyek lewat link Lihat hasil di web Kantor Agen, jadi jangan menyuruh menjalankan npx atau server lokal; cukup sebut file yang dibuka.\n\nMemori:\n' + memori(a)
      : 'Kamu ' + a.nama + ', anggota divisi ' + DIVS[a.div] + ' di Kantor Agen. Kerjakan tugasmu langsung di folder proyek ini dengan membuat atau mengubah file. Jangan mengerjakan tugas divisi lain. Di akhir, tulis ringkasan singkat (maks 120 kata) tentang apa yang kamu buat dan file mana saja. Hasil web dibuka pemilik proyek lewat link Lihat hasil di web Kantor Agen, jadi jangan menyuruh menjalankan npx atau server lokal; cukup sebut file yang dibuka.\n\nMemori:\n' + memori(a),
    prompt: t.solo
      ? 'Proyek: ' + w.nama + '\nBrief: ' + w.goal + (t.catatan ? '\n\nCatatan dari pemilik proyek: ' + t.catatan : '')
      : 'Proyek: ' + w.nama + '\nBrief: ' + w.goal + '\nRencana manajer: ' + w.ringkasan + '\n\nTugasmu: ' + t.title + '\n' + t.detail + (deps ? '\n\nHasil rekan yang terkait:\n' + deps : '') + (t.catatan ? '\n\nCatatan dari bos/manajer: ' + t.catatan : ''),
    onEvent: ev => {
      if (ev.alat) { langkah++; t.progress = Math.min(0.9, 0.05 + 0.85 * (1 - Math.exp(-langkah / 8)));
        const f = ev.file ? path.basename(String(ev.file)) : '';
        a.aktivitas = ({ Read: 'membaca ', Edit: 'mengedit ', Write: 'menulis ', Glob: 'mencari ', Grep: 'mencari ' }[ev.alat] || ev.alat + ' ') + f;
        if ((ev.alat === 'Write' || ev.alat === 'Edit') && f && !t.file.includes(f)) t.file.push(f);
        changed(); }
    } });
  if (r.session) a.session = r.session;
  if (r.batas) { t.status = 'antre'; t.progress = 0; t.agent = null; a.state = 'idle'; a.task = null; a.aktivitas = ''; jedaBiaya(w, 'jadwal'); return; }
  t.rincian = tambahRincian(t.rincian || rincianKosong(), r.rincian);
  const lepas = () => { a.state = 'idle'; a.task = null; a.aktivitas = ''; changed(); };
  if (t.status === 'dihentikan' || t.status === 'dilewati') { // rem darurat (atau sudah dilewati sebelum proses tertutup): simpan apa yang sempat terbaca, status tidak diubah
    t.output = r.text || r.teksTerakhir || t.output || ''; lepas(); log(w, a.nama, 'Dihentikan saat mengerjakan "' + t.title + '".'); return;
  }
  if (r.login) { // bukan kegagalan tugas: tanpa retry, coba tidak bertambah
    t.status = 'antre'; t.progress = 0; t.agent = null; lepas(); butuhLogin(w, a.akun, 'jadwal'); return;
  }
  if (r.maxTurns) {
    t.status = 'batas-langkah'; t.output = r.text || r.teksTerakhir || ''; t.progress = 1; lepas();
    log(w, a.nama, 'Berhenti: batas langkah (' + mt('staf') + ') tercapai di "' + t.title + '".'); return;
  }
  if (r.error) {
    t.coba++; t.progress = 0; t.agent = null; a.state = 'idle'; a.task = null; a.aktivitas = '';
    t.status = (r.limit || t.coba >= 2) ? 'gagal' : 'antre';
    log(w, a.nama, 'Gagal mengerjakan "' + t.title + '": ' + r.error);
    if (r.limit) { w.status = 'idle'; stopAll(w); log(w, 'Sistem', 'Kuota akun habis atau dibatasi. Workspace dijeda.'); }
    return;
  }
  if (t.solo) { // Solo: tidak ada manajer yang menerima; langsung selesai.
    t.output = r.text; t.progress = 1; t.status = 'selesai'; a.selesai++; a.state = 'idle'; a.task = null; a.aktivitas = '';
    log(w, a.nama, 'Selesai mengerjakan brief.'); return;
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
  if (w.tasks.some(t => t.status === 'dihentikan')) return; // kerja belum jadi: tunggu Lanjutkan
  if (w.mode === 'solo') { // Solo: laporan = output agen itu sendiri, tanpa memanggil manajer.
    const t = w.tasks[0] || {};
    w.laporan = t.status === 'selesai' ? (t.output || '(agen tidak menulis laporan)')
      : t.status === 'dihentikan' ? 'Tugas Solo dihentikan. Tekan Coba lagi di tugasnya untuk mengulang.' + (t.output ? '\n\nOutput terakhir:\n' + t.output : '')
      : t.status === 'dilewati' ? 'Tugas Solo dilewati.' + (t.output ? '\n\nOutput terakhir:\n' + t.output : '')
      : t.status === 'batas-langkah' ? 'Berhenti: batas langkah tercapai. Tekan Coba lagi di tugasnya untuk mengulang.' + (t.output ? '\n\nOutput terakhir:\n' + t.output : '')
      : 'Tugas Solo gagal. Lihat Aktivitas untuk pesan error, lalu tekan Coba lagi di tugasnya.';
    w.status = 'done'; log(w, 'Sistem', 'Solo selesai. Laporan akhir siap dibaca.'); return;
  }
  w.status = 'final'; const m = agentOf(w, 'mgr'); m.state = 'rangkum'; m.aktivitas = 'menulis laporan';
  log(w, 'Arya', 'Semua tugas masuk. Menyusun laporan akhir.');
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, maxTurns: mt('manajer'), peran: 'manajer-laporan', system: SYS_MGR,
    prompt: 'Brief: ' + w.goal + '\n\nHasil tim:\n' + w.tasks.map(t => '- [' + t.div + '] ' + t.title + ' (' + t.status + '): ' + (t.output || '').slice(0, 800) + (t.file.length ? ' File: ' + t.file.join(', ') : '')).join('\n') +
      '\n\nTulis laporan akhir untuk pemilik proyek (maks 250 kata), sapa dengan "kamu": apa yang sudah jadi, file mana yang perlu dibuka (tulis nama file dalam backtick), dan langkah berikutnya. Hasil web dibuka pemilik proyek lewat link Lihat hasil di web Kantor Agen, jadi jangan menyuruh menjalankan npx atau server lokal; cukup sebut file yang dibuka. Boleh baca file di folder ini untuk mengecek.' });
  m.state = 'idle'; m.aktivitas = '';
  if (r.batas) { jedaBiaya(w, 'final'); return; }
  if (w.status === 'dihentikan') return; // rem darurat saat menulis laporan; Lanjutkan akan memanggil final lagi
  if (r.login) { butuhLogin(w, 0, 'final'); return; } // lanjut -> running -> penjadwal memanggil final lagi
  w.laporan = r.error ? 'Laporan akhir gagal dibuat: ' + r.error : r.text;
  w.status = 'done';
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
  const r = await runClaude({ key, w, akun: a.akun, model: a.div === 'manager' ? CFG.model.manajer : CFG.model.staf, resume: a.session, peran: 'chat',
    alat: a.div === 'manager' ? null : CFG.alatStaf,
    system: (a.div === 'manager' ? SYS_MGR : 'Kamu ' + a.nama + ', anggota divisi ' + DIVS[a.div] + ' di Kantor Agen.') + ' Bos sedang mengobrol langsung denganmu. Jawab singkat.\n\nMemori:\n' + memori(a),
    prompt: 'Status proyek: ' + w.status + '. Tugas: ' + w.tasks.map(t => t.title + ' [' + t.status + ']').join('; ') + '\n\nPesan bos: ' + pesan });
  if (r.session) a.session = r.session;
  const akLogin = r.login && infoAkun(a.akun);
  a.chat.push({ dari: a.nama, teks: akLogin ? 'Akun agen belum login: ' + akLogin.nama + ' (' + akLogin.configDir + '). Login dulu: $env:CLAUDE_CONFIG_DIR="' + akLogin.configDir + '"; claude lalu /login.'
    : r.error ? 'Gagal membalas: ' + r.error : r.text, t: Date.now() });
  if (a.chat.length > 60) a.chat.splice(0, a.chat.length - 60);
  a.state = prevState === 'kerja' ? 'idle' : prevState; a.aktivitas = ''; changed();
}
// Penjadwal: tiap detik, beri tugas ke staf yang kosong selama kuota akun masih ada.
setInterval(() => {
  for (const w of S.ws) {
    if (w.status !== 'running') continue;
    const semuaSelesai = w.tasks.length && w.tasks.every(t => SELESAI_TUGAS.includes(t.status)) && !w.agents.some(a => a.state === 'lapor' || a.state === 'kerja');
    if (semuaSelesai && w.mode === 'solo') { final(w); continue; } // laporan Solo tidak memanggil Claude
    // Tidak ada yang bisa dikerjakan selain tugas dihentikan (mis. setelah Coba lagi tugas lain): kembali ke Dihentikan supaya Lanjutkan muncul.
    if (w.tasks.some(t => t.status === 'dihentikan') && !w.tasks.some(t => t.status === 'antre' || t.status === 'kerja' || t.status === 'lapor') && !w.agents.some(a => a.state === 'lapor' || a.state === 'kerja')) {
      w.status = 'dihentikan'; log(w, 'Sistem', 'Antrean habis, masih ada tugas dihentikan. Tekan Lanjutkan untuk mengulangnya.'); continue;
    }
    if (lewatBatas(w)) { jedaBiaya(w, 'jadwal'); continue; } // sesi yang sedang jalan dibiarkan selesai
    const aktif = akunAktif();
    for (const a of w.agents) {
      if (a.div === 'manager' || a.state !== 'idle') continue;
      if (aktif[a.akun] >= CFG.maxAgenPerAkun) continue;
      const t = w.tasks.find(t => t.status === 'antre' && t.div === a.div && (!t.pinAgent || t.pinAgent === a.id) && depsOk(w, t));
      if (t) { aktif[a.akun]++; work(w, a, t); }
    }
    if (semuaSelesai) final(w);
  }
}, 1000);

/* ---------------- HTTP ---------------- */
const clients = new Set();
let bcTimer = null;
function snapshot() { return JSON.stringify({ ws: S.ws, info: { akun: CFG.akun.map(a => a.nama), aktif: akunAktif(), maxAgenPerAkun: CFG.maxAgenPerAkun, model: CFG.model, folderData: CFG.folderData, folderProyek: CFG.folderProyek, batasBiaya: CFG.batasBiaya, maxTurns: CFG.maxTurns, peringatanLogin: PERINGATAN_LOGIN, batasInput: BATAS_INPUT, chatRuang: { model: CFG.modelChat, batasHarian: +CFG.batasChatHarian || 0, hariIni: biayaHarian(), batasJalankan: +CFG.batasJalankan || 0, folderWorktree: folderWorktree() } } }); }
function broadcast() { if (bcTimer) return; bcTimer = setTimeout(() => { bcTimer = null; const s = 'data: ' + snapshot() + '\n\n'; for (const c of clients) c.write(s); }, 250); }
function body(req) { return new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }
function send(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
const WEB = path.join(ROOT, '..', 'index.html');
const DASBOR = path.join(ROOT, '..', 'dashboard.html');

/* ---------------- Lihat hasil: file di folder workspace ---------------- */
const LEWATI = new Set(['.git', 'node_modules']);
function daftarHasil(root, max = 2000) {
  const out = [];
  const jalan = (dir, rel) => {
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of es) {
      if (out.length >= max) return;
      if (e.isSymbolicLink() || LEWATI.has(e.name)) continue; // symlink tidak diikuti
      const p = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) jalan(p, r);
      else if (e.isFile()) { try { const st = fs.statSync(p); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } catch (err) {} }
    }
  };
  jalan(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
// MIME harus benar: dengan nosniff, browser menolak CSS/JS yang disajikan sebagai text/plain.
const TIPE = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
};
// Dokumen hasil di-sandbox TANPA allow-same-origin: origin-nya opaque, jadi tidak bisa membaca localStorage (PIN)
// web kantor. allow-scripts supaya JS halaman jalan. Karena origin opaque, fetch('menu.json') = permintaan
// lintas-origin → respons /hasil ber-token memberi Access-Control-Allow-Origin: * (isinya memang publik bagi
// pemegang token). Referrer dimatikan supaya token tidak bocor ke CDN/situs luar.
const HDR_HASIL = {
  'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals',
  'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'access-control-allow-origin': '*',
};
function tolakHasil(res, code, msg) { res.writeHead(code, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, HDR_HASIL)); res.end(msg); }
// Path relatif → path absolut di dalam folder workspace, atau null kalau keluar folder.
function dalamFolder(folder, rel) {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) return null;
  if (rel.split(/[\\/]+/).includes('..')) return null;
  const root = path.resolve(folder), full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  let rRoot, rFull; try { rRoot = fs.realpathSync(root); rFull = fs.realpathSync(full); } catch (e) { return undefined; } // tidak ada
  if (!rFull.startsWith(rRoot + path.sep)) return null; // symlink/junction keluar folder
  return rFull;
}
// /hasil/<token>/<path>: token baca-saja per workspace di path, jadi URL relatif (style.css, menu.json, gambar,
// fetch) otomatis membawa token tanpa PIN/cookie. Format lama /hasil/<wsId>/<path>?pin= → redirect ke format token.
function sajikanHasil(req, res, pinOk) {
  const m = req.url.split('?')[0].match(/^\/hasil\/([^/]+)\/(.+)$/);
  if (!m) return tolakHasil(res, 404, 'Tidak ada');
  let w = /^[0-9a-f]{32}$/.test(m[1]) && S.ws.find(x => x.aksesHasil === m[1]);
  if (!w) {
    const lama = S.ws.find(x => x.id === m[1]);
    if (!lama) return tolakHasil(res, 404, 'Tidak ada');
    if (!pinOk) return tolakHasil(res, 401, 'PIN salah');
    res.writeHead(302, Object.assign({ location: '/hasil/' + lama.aksesHasil + '/' + m[2] }, HDR_HASIL)); return res.end();
  }
  if (!w.folder) return tolakHasil(res, 404, 'Tidak ada');
  let rel; try { rel = decodeURIComponent(m[2]); } catch (e) { return tolakHasil(res, 400, 'Path tidak valid'); }
  const full = dalamFolder(w.folder, rel);
  if (full === null) return tolakHasil(res, 403, 'Ditolak: path di luar folder workspace');
  let st; try { st = full && fs.statSync(full); } catch (e) {}
  if (!st || !st.isFile()) return tolakHasil(res, 404, 'File tidak ditemukan');
  res.writeHead(200, Object.assign({ 'content-type': TIPE[path.extname(full).toLowerCase()] || 'application/octet-stream', 'content-length': st.size }, HDR_HASIL));
  fs.createReadStream(full).pipe(res);
}

/* ---------------- /api/proyek: daftar proyek untuk lorong (Fase 3b) ----------------
   Membaca HANYA CFG.indexVault (INDEX.md vault), read-only, tidak pernah menulis. Parse tabel di bawah heading
   "## Projects": kolom Project ([nama](projects/<slug>/STATE.md)), Ringkasan, Fase. Markdown dibersihkan jadi teks
   polos. Cache per mtime+ukuran. Masalah apa pun = 200 dengan daftar kosong + alasan (web menampilkan papan alasan). */
let CACHE_PROYEK = null;
const BATAS_TEKS_PROYEK = { nama: 80, ringkasan: 400, fase: 400 };
// Hanya tag HTML yang dikenal yang dibuang. Teks berbentuk <...> lain (mis. http://<IP LAN>:8501, <slug>) dibiarkan:
// semua teks ini ditampilkan lewat textContent, jadi tidak ada risiko markup.
const TAG_HTML = /<\/?(?:a|abbr|b|blockquote|br|center|code|dd|del|details|div|dl|dt|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|tt|u|ul|var|video|audio|source|iframe|picture|figure|figcaption|section|article|nav|header|footer|main|aside|script|style|svg|path)\b(?:\s[^<>]*)?\/?>/g; // huruf kecil saja: <I am>, <A B> bukan tag
function teksPolos(t) {
  return String(t || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')            // gambar
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // link
    .replace(/<!--[\s\S]*?-->/g, '')                         // komentar HTML
    .replace(TAG_HTML, '')                                // tag HTML dikenal; <IP LAN> dsb. tetap utuh
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                   // tebal
    .replace(/`+([^`]*)`+/g, '$1')                        // kode
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2') // miring
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1')           // escape markdown
    .replace(/\s+/g, ' ').trim();
}
function selTabel(baris) {
  const isi = baris.trim().replace(/^\|/, '').replace(/\|$/, '');
  return isi.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}
function parseProyek(teks) {
  const baris = String(teks).split(/\r?\n/);
  const h = baris.findIndex(b => /^##\s+Projects\s*$/i.test(b.trim()));
  if (h < 0) return { proyek: [], alasan: 'Heading "## Projects" tidak ada di INDEX' };
  const tabel = [];
  for (let i = h + 1; i < baris.length; i++) {
    const b = baris[i].trim();
    if (!b) { if (tabel.length) break; continue; }
    if (/^#/.test(b)) break;
    if (!b.startsWith('|')) { if (tabel.length) break; continue; }
    tabel.push(b);
  }
  if (tabel.length < 2) return { proyek: [], alasan: 'Tabel di bawah "## Projects" tidak terbaca' };
  const kepala = selTabel(tabel[0]).map(c => teksPolos(c).toLowerCase());
  const kol = { project: kepala.indexOf('project'), ringkasan: kepala.indexOf('ringkasan'), fase: kepala.indexOf('fase') };
  if (kol.project < 0) return { proyek: [], alasan: 'Kolom "Project" tidak ada di tabel Projects' };
  const proyek = [], dipakai = new Set();
  for (const b of tabel.slice(1)) {
    const c = selTabel(b);
    if (c.every(x => /^:?-{2,}:?$/.test(x) || !x)) continue; // baris pemisah |---|
    const mentah = c[kol.project] || '';
    const link = /\[([^\]]+)\]\(([^)]*)\)/.exec(mentah);
    const nama = teksPolos(link ? link[1] : mentah).slice(0, BATAS_TEKS_PROYEK.nama);
    if (!nama) continue;
    const dariLink = link && /(?:^|\/)projects\/([^/)]+)\//.exec(link[2]);
    let slug = (dariLink ? dariLink[1] : nama).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'proyek';
    while (dipakai.has(slug)) slug += '-2';
    dipakai.add(slug);
    proyek.push({ slug, nama,
      ringkasan: kol.ringkasan >= 0 ? teksPolos(c[kol.ringkasan]).slice(0, BATAS_TEKS_PROYEK.ringkasan) : '',
      fase: kol.fase >= 0 ? teksPolos(c[kol.fase]).slice(0, BATAS_TEKS_PROYEK.fase) : '' });
  }
  return { proyek, alasan: proyek.length ? null : 'Tabel Projects kosong' };
}
function bacaProyek() {
  const f = CFG.indexVault;
  if (!f) return { proyek: [], alasan: 'indexVault belum diisi di server/config.json' };
  if (path.extname(f).toLowerCase() !== '.md') return { proyek: [], alasan: 'indexVault harus menunjuk file .md' };
  let st; try { st = fs.statSync(f); } catch (e) { return { proyek: [], alasan: 'File INDEX tidak ditemukan' }; }
  if (!st.isFile()) return { proyek: [], alasan: 'indexVault bukan file' };
  if (st.size > 1e6) return { proyek: [], alasan: 'File INDEX terlalu besar (> 1 MB)' };
  const kunci = path.resolve(f) + '|' + st.mtimeMs + '|' + st.size;
  if (CACHE_PROYEK && CACHE_PROYEK.kunci === kunci) return CACHE_PROYEK.hasil;
  let teks; try { teks = fs.readFileSync(f, 'utf8'); } catch (e) { return { proyek: [], alasan: 'File INDEX tidak bisa dibaca' }; }
  let hasil; try { hasil = parseProyek(teks); } catch (e) { hasil = { proyek: [], alasan: 'Tabel Projects tidak terbaca' }; }
  CACHE_PROYEK = { kunci, hasil };
  return hasil;
}

/* ---------------- /api/proyek/<slug>/detail: detail proyek baca-saja (ruang proyek, langkah 1) ----------------
   Slug hanya dari daftar INDEX yang sudah di-parse (whitelist). Path dibangun dari folder vault (dirname indexVault),
   tidak pernah dari input. Hanya 3 file yang dibaca: projects/<slug>/STATE.md (bagian "## Status sekarang"),
   projects/<slug>/NEXT.md (butir checklist), repos.md (baris proyek itu: path lokal, remote GitHub, link live).
   Read-only, maks 64 KB per file, cache per mtime+ukuran. Kolom Catatan repos.md tidak pernah dikirim mentah: hanya
   URL live yang diekstrak. Pola token umum disamarkan untuk berjaga-jaga. */
const BATAS_BACA_VAULT = 64 * 1024;
const CACHE_VAULT = new Map(); // path -> { kunci, teks, terpotong }
const sama = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const diDalam = (root, full) => { const r = root.endsWith(path.sep) ? root : root + path.sep; return process.platform === 'win32' ? full.toLowerCase().startsWith(r.toLowerCase()) : full.startsWith(r); };
function folderVault() { return CFG.indexVault ? path.dirname(path.resolve(CFG.indexVault)) : ''; }
// Path absolut di dalam vault (realpath, menolak symlink/junction keluar vault); null = ditolak, undefined = tidak ada.
function dalamVault(full) {
  const root = folderVault(); if (!root) return null;
  let rRoot, rFull; try { rRoot = fs.realpathSync.native(root); } catch (e) { return null; }
  try { rFull = fs.realpathSync.native(full); } catch (e) { return undefined; }
  return diDalam(rRoot, rFull) && !sama(rRoot, rFull) ? rFull : null;
}
function bacaVault(rel) { // rel dibangun server, bukan dari input
  const full = dalamVault(path.join(folderVault(), rel));
  if (full === undefined) return { ada: false };
  if (full === null) return { ada: false, ditolak: true };
  let st; try { st = fs.statSync(full); } catch (e) { return { ada: false }; }
  if (!st.isFile()) return { ada: false };
  const kunci = st.mtimeMs + '|' + st.size, c = CACHE_VAULT.get(full);
  if (c && c.kunci === kunci) return c;
  let teks = '', terpotong = st.size > BATAS_BACA_VAULT;
  try { const fd = fs.openSync(full, 'r'); try { const buf = Buffer.alloc(Math.min(st.size, BATAS_BACA_VAULT)); const n = fs.readSync(fd, buf, 0, buf.length, 0); teks = buf.slice(0, n).toString('utf8'); } finally { fs.closeSync(fd); } }
  catch (e) { return { ada: false }; }
  const hasil = { ada: true, kunci, teks: teks.replace(/^﻿/, ''), terpotong };
  CACHE_VAULT.set(full, hasil); if (CACHE_VAULT.size > 200) CACHE_VAULT.delete(CACHE_VAULT.keys().next().value);
  return hasil;
}
const samarkan = (t) => String(t).replace(/\b(ghp_|gho_|ghu_|ghs_|github_pat_|sk-ant-|sk-|xox[abpr]-|AKIA)[A-Za-z0-9_\-]{8,}/g, '[disamarkan]');
const barisPolos = (b) => samarkan(teksPolos(b.replace(/^\s*[-*+]\s+/, '').replace(/^\s*>\s?/, '')));
// Bagian status: setiap heading level 2 yang teksnya diawali "Status" ("## Status", "## Status sekarang",
// "## Status sekarang (lanjutan)", tidak peka huruf besar/kecil). Lebih dari satu = digabung sesuai urutan file,
// dengan baris pemisah berisi judul heading-nya. Tiap bagian berhenti di heading level 1-2 berikutnya.
function bagianStatus(teks) {
  const baris = teks.split(/\r?\n/), bagian = [];
  for (let h = 0; h < baris.length; h++) {
    const m = /^##\s+(status.*)$/i.exec(baris[h].trim()); if (!m) continue;
    const out = [];
    let i = h + 1;
    for (; i < baris.length; i++) {
      const b = baris[i];
      if (/^#{1,2}\s/.test(b.trim())) break; // heading berikutnya (level 1-2); sub-heading ### ikut sebagai baris
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(b)) continue;
      const butir = /^\s*([-*+]|\d+\.)\s+/.test(b), sub = /^#{3,6}\s+/.test(b.trim());
      const t = barisPolos(sub ? b.trim().replace(/^#+\s+/, '') : b);
      if (!t) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
      out.push((butir ? '• ' : '') + t);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    if (out.length) bagian.push({ judul: barisPolos(m[1]), isi: out.join('\n') });
    h = i - 1;
  }
  if (!bagian.length) return { status: null, alasan: baris.some(b => /^##\s+status/i.test(b.trim())) ? 'Bagian "## Status…" di STATE.md kosong' : 'Tidak ada heading "## Status…" di STATE.md' };
  const isi = bagian.length === 1 ? bagian[0].isi : bagian.map(x => '── ' + x.judul + ' ──\n' + x.isi).join('\n\n');
  return { status: isi.slice(0, 6000), alasan: null };
}
// NEXT: butir checklist "- [ ]" / "- [x]" (jenis "checklist"). Kalau tidak ada satu pun, butir daftar biasa level
// atas ("1." / "-" / "*" / "+", tanpa indentasi) jadi jenis "daftar" tanpa status centang. Blok kode dilewati;
// pada jenis daftar, bagian di bawah heading yang berjudul "Selesai…"/"Done…" dilewati (bukan pekerjaan berikutnya).
function butirNext(teks) {
  const baris = teks.split(/\r?\n/), cek = [], daftar = [];
  let kode = false, lewati = false;
  for (const b of baris) {
    if (/^\s*(```|~~~)/.test(b)) { kode = !kode; continue; }
    if (kode) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(b.trim());
    if (h) { lewati = /^(selesai|done)\b/i.test(teksPolos(h[1]).trim()); continue; }
    const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(b);
    if (m) {
      const t = barisPolos(m[2].replace(/\\n\s*$/, '')).slice(0, 300);
      if (t && cek.length < 200) cek.push({ selesai: m[1] !== ' ', teks: t });
      continue;
    }
    if (lewati || cek.length || daftar.length >= 200 || /^\s*([-*_]\s*){3,}$/.test(b)) continue;
    const d = /^ ?(?:[-*+]|\d+[.)])\s+(.*)$/.exec(b);
    if (d) { const t = barisPolos(d[1]).slice(0, 300); if (t) daftar.push({ selesai: null, teks: t }); }
  }
  if (cek.length) return { jenis: 'checklist', butir: cek };
  if (daftar.length) return { jenis: 'daftar', butir: daftar };
  return { jenis: null, butir: [] };
}
// URL live: http(s) apa pun selain github.com, atau domain *.github.io / *.vercel.app tanpa skema.
function cariLive(...sumber) {
  for (const t of sumber) {
    const teks = String(t || '');
    const cocok = teks.match(/https?:\/\/[^\s)<>\]"'`|]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:github\.io|vercel\.app)(?:\/[^\s)<>\]"'`|]*)?/gi) || [];
    for (let c of cocok) {
      c = c.replace(/[.,;:!?]+$/, ''); if (!/^https?:\/\//i.test(c)) c = 'https://' + c;
      let u; try { u = new URL(c); } catch (e) { continue; }
      if (!/^https?:$/.test(u.protocol) || /(^|\.)github\.com$/i.test(u.hostname)) continue;
      return u.href;
    }
  }
  return null;
}
function barisRepos(slug) {
  const r = bacaVault('repos.md'); if (!r.ada) return null;
  const baris = r.teks.split(/\r?\n/).filter(b => b.trim().startsWith('|'));
  if (baris.length < 2) return null;
  const kepala = selTabel(baris[0]).map(c => teksPolos(c).toLowerCase());
  const kLokal = kepala.findIndex(c => c.includes('path') || c.includes('lokal')), kRemote = kepala.findIndex(c => c.includes('remote'));
  for (const b of baris.slice(1)) {
    const c = selTabel(b);
    if (teksPolos(c[0]).toLowerCase() === slug) return { sel: c, kLokal, kRemote };
  }
  return null;
}
function detailProyek(slug) {
  const p = bacaProyek().proyek.find(x => x.slug === slug);
  if (!p || !/^[a-z0-9][a-z0-9._-]*$/.test(slug) || slug.includes('..')) return null;
  const st = bacaVault(path.join('projects', slug, 'STATE.md'));
  const s = st.ada ? bagianStatus(st.teks) : { status: null, alasan: st.ditolak ? 'STATE.md ditolak (di luar vault)' : 'STATE.md tidak ada' };
  if (st.ada && !s.status && st.terpotong && /Tidak ada/.test(s.alasan)) s.alasan = 'Heading "## Status…" tidak ada di ' + (BATAS_BACA_VAULT / 1024) + ' KB pertama STATE.md (file lebih besar, sisanya tidak dibaca)';
  const nx = bacaVault(path.join('projects', slug, 'NEXT.md'));
  const bn = nx.ada ? butirNext(nx.teks) : { jenis: null, butir: [] };
  const rb = barisRepos(slug);
  let lokal = null, bisaBuka = false, github = null, githubPrivat = false;
  if (rb) {
    const mentah = rb.kLokal >= 0 ? String(rb.sel[rb.kLokal] || '').replace(/`/g, '').trim() : '';
    if (mentah && !/[<>]/.test(mentah) && !mentah.includes('\0')) {
      lokal = path.isAbsolute(mentah) || /^[a-zA-Z]:[\\/]/.test(mentah) ? path.resolve(mentah) : path.resolve(folderVault(), mentah);
      const d = dalamVault(lokal); try { bisaBuka = !!d && fs.statSync(d).isDirectory(); } catch (e) {}
    }
    const remote = rb.kRemote >= 0 ? String(rb.sel[rb.kRemote] || '') : '';
    const g = /(?:https?:\/\/)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(remote);
    if (g) { github = 'https://github.com/' + g[1] + '/' + g[2].replace(/\.git$/i, ''); githubPrivat = /\(\s*private\s*\)/i.test(remote); }
  }
  const live = cariLive(rb ? rb.sel.slice(1).join(' ') : '', p.fase, s.status);
  return { slug, nama: p.nama, fase: p.fase, status: s.status, statusAlasan: s.alasan, statusTerpotong: !!st.terpotong,
    stateMtime: st.ada ? +String(st.kunci).split('|')[0] || null : null, nextMtime: nx.ada ? +String(nx.kunci).split('|')[0] || null : null,
    next: bn.butir, nextJenis: bn.jenis, nextAlasan: nx.ada ? null : 'NEXT.md tidak ada', lokal, bisaBukaFolder: bisaBuka, github, githubPrivat, live };
}
// Slug dari URL: decode lalu cocokkan ke whitelist. Traversal (.., %2e, %2f, \) di URL mentah = 403.
function slugProyek(req, p) {
  const mentah = req.url.split('?')[0];
  if (/\.\.|%2e|%2f|%5c|\\/i.test(mentah)) return { kode: 403 };
  let s; try { s = decodeURIComponent(p[2] || ''); } catch (e) { return { kode: 400 }; }
  return bacaProyek().proyek.some(x => x.slug === s) ? { slug: s } : { kode: 404 };
}

/* ---------------- Chat "penjaga ruang" per proyek (ruang proyek, langkah 2) ----------------
   Keputusan user 28-11: chat hanya tahu isi ruangan itu. Agen TIDAK diberi alat apa pun (--tools ""); server yang
   menyusun konteks (baris INDEX + STATE.md + NEXT.md proyek itu, lewat bacaVault: read-only, realpath di dalam vault)
   dan memasukkannya ke system prompt. Jadi agen secara fisik tidak bisa membaca file lain, dan request tanpa definisi
   alat lebih murah. Riwayat per ruang di <folderData>/ruang/<slug>.json (bukan vault, bukan repo). */
const BATAS_KONTEKS = { state: 24 * 1024, next: 12 * 1024 }; // byte per file; lewat = dipotong di batas baris + ditandai
const RIWAYAT_SIMPAN = 20;   // pesan (tanya + jawab) yang disimpan per ruang
const RIWAYAT_KIRIM = 6;     // giliran terakhir (1 giliran = 1 tanya + 1 jawab) yang dikirim ke model
const MAX_TURNS_RUANG = 2;   // tanpa alat, jawaban selesai dalam 1 langkah; 2 = cadangan
const DIR_RUANG = path.join(CFG.folderData, 'ruang');
const CWD_RUANG = path.join(DIR_RUANG, '_cwd'); // folder kosong khusus: tidak ada CLAUDE.md proyek yang ikut terbaca
const HARIAN_PATH = path.join(DIR_RUANG, '_harian.json');
const tglLokal = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
let HARIAN = { tgl: '', usd: 0 };
try { HARIAN = JSON.parse(fs.readFileSync(HARIAN_PATH, 'utf8')); } catch (e) {}
function biayaHarian() { return HARIAN.tgl === tglLokal() ? +HARIAN.usd || 0 : 0; }
function tambahHarian(usd) {
  HARIAN = { tgl: tglLokal(), usd: biayaHarian() + (+usd || 0) };
  try { fs.mkdirSync(DIR_RUANG, { recursive: true }); fs.writeFileSync(HARIAN_PATH, JSON.stringify(HARIAN)); } catch (e) {}
}
const slugRuangAman = (s) => /^[a-z0-9][a-z0-9._-]*$/.test(s) && !s.includes('..');
const pathRiwayat = (slug) => path.join(DIR_RUANG, slug + '.json');
function bacaRiwayat(slug) { try { const j = JSON.parse(fs.readFileSync(pathRiwayat(slug), 'utf8')); return Array.isArray(j.pesan) ? j.pesan : []; } catch (e) { return []; } }
function simpanRiwayat(slug, pesan) {
  fs.mkdirSync(DIR_RUANG, { recursive: true });
  const f = pathRiwayat(slug), tmp = f + '.' + uid() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ slug, pesan: pesan.slice(-RIWAYAT_SIMPAN) }, null, 1)); fs.renameSync(tmp, f);
}
// Potong di batas baris (tidak pernah di tengah baris/karakter). Hasil <= maxByte.
function potongBaris(teks, maxByte) {
  if (Buffer.byteLength(teks, 'utf8') <= maxByte) return { teks, terpotong: false };
  const out = []; let n = 0;
  for (const b of teks.split('\n')) { const k = Buffer.byteLength(b, 'utf8') + 1; if (n + k > maxByte) break; out.push(b); n += k; }
  return { teks: out.join('\n'), terpotong: true };
}
/* Planner ruang (tahap A, keputusan user 28-11): ruang menjalankan workflow vault sendiri. Agen tetap TANPA alat;
   server menyusun konteks: workflow.md (8 KB) + baris INDEX + STATE.md + NEXT.md + git log -5 repo lokal + mtime.
   Jawaban boleh berisi blok ```prompt-cc``` (prompt untuk Claude Code, disalin manual) dan ```usulan-vault```
   (JSON edit STATE/NEXT). Usulan divalidasi dan disimpan SERVER-SIDE; vault baru ditulis setelah ACC per usulan,
   dan isi yang ditulis selalu dari usulan tersimpan, bukan dari body request web. */
const BATAS_WORKFLOW = 8 * 1024;
const BATAS_FILE_TULIS = 1024 * 1024;   // file STATE/NEXT lebih besar dari ini tidak bisa diubah lewat usulan
const FILE_RUANG = { STATE: 'STATE.md', NEXT: 'NEXT.md' }; // SATU-SATUNYA file vault yang bisa ditulis server
const BATAS_USULAN = { edit: 10, teks: 8000, alasan: 600, simpan: 30 };
const DIR_USULAN = path.join(DIR_RUANG, 'usulan'), DIR_BACKUP = path.join(DIR_RUANG, 'backup'), LOG_RUANG = path.join(DIR_RUANG, 'log.jsonl');
const umurMs = (kunci) => +String(kunci || '').split('|')[0] || null; // kunci bacaVault = mtimeMs|size

// git log repo lokal proyek (path dari repos.md, hanya kalau ada dan di dalam vault). Timeout 5 dtk; gagal = null.
const CACHE_GIT = new Map();
function gitLog(dir, n) {
  if (!dir) return Promise.resolve(null);
  const k = dir + '|' + n, c = CACHE_GIT.get(k);
  if (c && Date.now() - c.t < 30000) return Promise.resolve(c.v);
  return new Promise((resolve) => {
    let out = '', beres = false;
    const selesai = (v) => { if (beres) return; beres = true; CACHE_GIT.set(k, { t: Date.now(), v }); resolve(v); };
    let ch;
    try {
      ch = spawn('git', ['--no-optional-locks', '-C', dir, 'log', '-' + n, '--date=short', '--format=%h %ad %s'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
    } catch (e) { return selesai(null); }
    const tm = setTimeout(() => { bunuh(ch); selesai(null); }, 5000);
    ch.stdout.on('data', (d) => { out += d; if (out.length > 20000) bunuh(ch); });
    ch.on('error', () => { clearTimeout(tm); selesai(null); });
    ch.on('close', (code) => { clearTimeout(tm); selesai(code === 0 ? out.split(/\r?\n/).filter(Boolean).slice(0, n).map(l => samarkan(l).slice(0, 200)) : null); });
  });
}
const parseCommit = (l) => { const m = /^(\S+) (\d{4}-\d{2}-\d{2}) (.*)$/.exec(l || ''); return m ? { hash: m[1], tgl: m[2], pesan: m[3] } : null; };
function repoProyek(slug) { const d = detailProyek(slug); return d && d.bisaBukaFolder ? dalamVault(d.lokal) || null : null; }

function konteksRuang(slug) {
  const p = bacaProyek().proyek.find(x => x.slug === slug); if (!p || !slugRuangAman(slug)) return null;
  const satu = (rel, batas) => {
    const r = bacaVault(rel);
    if (!r.ada) return { ada: false, ditolak: !!r.ditolak, teks: '', byte: 0, asli: 0, terpotong: false, batas, mtime: null };
    const asli = +String(r.kunci).split('|')[1] || 0;
    const t = potongBaris(samarkan(r.teks.replace(/\r\n/g, '\n')).trimEnd(), batas);
    return { ada: true, teks: t.teks, byte: Buffer.byteLength(t.teks, 'utf8'), asli, terpotong: t.terpotong || !!r.terpotong, batas, mtime: umurMs(r.kunci) };
  };
  return { p, workflow: satu('workflow.md', BATAS_WORKFLOW), state: satu(path.join('projects', slug, 'STATE.md'), BATAS_KONTEKS.state),
    next: satu(path.join('projects', slug, 'NEXT.md'), BATAS_KONTEKS.next), git: null };
}
const infoKonteks = (k) => {
  const f = (x) => ({ ada: x.ada, byte: x.byte, asli: x.asli, batas: x.batas, terpotong: x.terpotong, mtime: x.mtime });
  return { workflow: f(k.workflow), state: f(k.state), next: f(k.next), git: k.git ? k.git.length : 0 };
};
function sistemRuang(k) {
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  const tgl = (ms) => ms ? new Date(ms).toISOString().slice(0, 10) : '-';
  const bagian = (label, x) => x.ada
    ? '<' + label + (x.terpotong ? ' terpotong="ya: hanya ' + kb(x.batas) + ' pertama dari ' + kb(x.asli) + ', sisanya tidak kamu lihat"' : '') + '>\n' + x.teks + '\n</' + label + '>'
    : '<' + label + '>\n(file tidak ada)\n</' + label + '>';
  return 'Kamu planner proyek "' + k.p.nama + '" di Kantor Agen, bekerja sesuai workflow.md di bawah (peran Claude App = planner).\n' +
    'Aturan:\n' +
    '- Fakta proyek HANYA dari konteks di bawah (workflow.md, baris INDEX, STATE.md, NEXT.md, git log, tanggal file). Kalau tidak ada di konteks, bilang tidak tahu. Jangan mengarang.\n' +
    '- Kamu tidak punya alat dan tidak bisa membaca kode atau file lain. Kalau butuh fakta dari kode, suruh Claude Code mengecek lewat prompt.\n' +
    '- Ikuti workflow.md: sparring partner yang jujur, SATU prompt Claude Code pada satu waktu, akhiri jawaban dengan prompt Claude Code ATAU aksi user.\n' +
    '- Bahasa Indonesia kasual, ringkas. Sapa pemilik proyek dengan "kamu".\n' +
    (k.state.terpotong || k.next.terpotong || k.workflow.terpotong ? '- Sebagian konteks terpotong (lihat atribut terpotong). Sebutkan kalau jawabannya mungkin ada di bagian yang terpotong.\n' : '') +
    '\nFormat khusus (dibaca server, tulis persis seperti ini):\n' +
    '- Prompt untuk Claude Code: SATU blok berpagar dengan bahasa prompt-cc, yaitu baris ```prompt-cc lalu isi prompt lalu baris ```. Maks satu per jawaban. Jangan pakai ```text atau blockquote untuk prompt.\n' +
    '- Usulan update catatan vault (STATE.md/NEXT.md proyek ini SAJA): SATU blok berpagar dengan bahasa usulan-vault berisi JSON:\n' +
    '  {"alasan":"kenapa diubah","edit":[{"file":"STATE","cari":"teks persis dari file","ganti":"teks baru"}]}\n' +
    '  "file" hanya "STATE" atau "NEXT". "cari" disalin PERSIS dari isi file di konteks (termasuk spasi dan tanda baca) dan cukup panjang supaya muncul tepat sekali; baris utuh paling aman. "cari" kosong hanya untuk NEXT = "ganti" ditambahkan di akhir file. Ikuti aturan bentuk STATE di workflow.md (keputusan + alasan + status sekarang, bukan changelog).\n' +
    '  Usulan baru ditulis setelah pemilik menekan ACC; jangan bilang sudah dicatat sebelum itu. Buat usulan hanya kalau pemilik memintanya atau jelas perlu.\n' +
    '\nHari ini: ' + tglLokal() + '. STATE.md diubah: ' + tgl(k.state.mtime) + '. NEXT.md diubah: ' + tgl(k.next.mtime) + '.\n' +
    '\nKonteks:\n' + bagian('workflow_md', k.workflow) + '\n\n<index>\nProyek: ' + k.p.nama + '\nFase: ' + (k.p.fase || '-') + '\nRingkasan: ' + (k.p.ringkasan || '-') + '\n</index>\n\n' +
    bagian('state_md', k.state) + '\n\n' + bagian('next_md', k.next) + '\n\n' +
    '<git_log_terakhir>\n' + (k.git && k.git.length ? k.git.join('\n') : '(tidak ada: repo lokal tidak tercatat, di luar vault, atau git gagal)') + '\n</git_log_terakhir>';
}
const RE_BLOK = /```([A-Za-z-]*)[^\S\n]*\n([\s\S]*?)\n?```/g;
function ambilBlok(teks) { const out = []; let m; RE_BLOK.lastIndex = 0; while ((m = RE_BLOK.exec(teks))) out.push({ jenis: m[1].toLowerCase(), isi: m[2], mulai: m.index, akhir: RE_BLOK.lastIndex }); return out; }
function promptRuang(riwayat, pesan, usulan) {
  const giliran = riwayat.slice(-RIWAYAT_KIRIM * 2);
  while (giliran.length && giliran[0].dari !== 'kamu') giliran.shift(); // mulai dari pertanyaan
  const status = (id) => { const u = usulan.find(x => x.id === id); return u ? u.status : 'tidak ada'; };
  const ringkas = (m) => m.teks.replace(RE_BLOK, (s, j) => j.toLowerCase() === 'usulan-vault' ? '[usulan-vault ' + (m.usulan || '?') + ': ' + status(m.usulan) + ']' : s);
  const r = giliran.map(m => (m.dari === 'kamu' ? 'Pemilik: ' : m.dari === 'sistem' ? 'Sistem: ' : m.dari === 'agen' ? 'Agen (laporan run ' + (m.jalan || '?') + '): ' : 'Planner: ') + (m.dari === 'penjaga' ? ringkas(m) : m.teks || '(run belum selesai)')).join('\n\n');
  return (r ? 'Obrolan sebelumnya (paling lama di atas):\n\n' + r + '\n\n---\n\n' : '') + 'Pesan baru dari pemilik: ' + pesan;
}
// Folder kerja agen chat: harus ada, kosong, dan tidak ada CLAUDE.md di folder itu maupun induknya.
function siapkanCwdRuang() {
  fs.mkdirSync(CWD_RUANG, { recursive: true });
  const isi = fs.readdirSync(CWD_RUANG); if (isi.length) return 'Folder kerja chat ruang tidak kosong (' + CWD_RUANG + '): ' + isi.slice(0, 3).join(', ');
  for (let d = CWD_RUANG; ; d = path.dirname(d)) {
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) if (fs.existsSync(path.join(d, f))) return 'Ada ' + path.join(d, f) + ' di atas folder kerja chat ruang; chat ditolak supaya file itu tidak ikut terbaca.';
    if (path.dirname(d) === d) break;
  }
  return null;
}

/* ---- File vault yang boleh ditulis: projects/<slug>/STATE.md dan NEXT.md, TIDAK ada yang lain ----
   Path dibangun dari folder vault + slug whitelist + nama dari FILE_RUANG (bukan dari input). Folder proyek dan
   file tidak boleh symlink/junction; realpath harus sama persis dengan path yang dibangun. */
function fileRuang(slug, kunci) {
  if (!Object.prototype.hasOwnProperty.call(FILE_RUANG, kunci) || !slugRuangAman(slug)) return null;
  if (!bacaProyek().proyek.some(x => x.slug === slug)) return null;
  const root = folderVault(); if (!root) return null;
  let rRoot, rDir; try { rRoot = fs.realpathSync.native(root); rDir = fs.realpathSync.native(path.join(root, 'projects', slug)); } catch (e) { return null; }
  if (!sama(rDir, path.join(rRoot, 'projects', slug))) return null;
  const full = path.join(rDir, FILE_RUANG[kunci]);
  let ls; try { ls = fs.lstatSync(full); } catch (e) { return { full, ada: false }; }
  if (ls.isSymbolicLink() || !ls.isFile()) return null;
  let r; try { r = fs.realpathSync.native(full); } catch (e) { return null; }
  if (!sama(r, full)) return null;
  return { full, ada: true, size: ls.size };
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Isi penuh kedua file (bukan versi terpotong konteks). LF dinormalisasi untuk pencocokan; gaya baris + BOM diingat.
function bacaFileRuang(slug) {
  const out = {};
  for (const k of Object.keys(FILE_RUANG)) {
    const f = fileRuang(slug, k);
    if (!f) { out[k] = { ditolak: true, hash: 'ditolak' }; continue; }
    if (!f.ada) { out[k] = { ada: false, hash: 'tidak-ada', full: f.full }; continue; }
    if (f.size > BATAS_FILE_TULIS) { out[k] = { ada: true, besar: true, hash: 'besar:' + f.size, full: f.full }; continue; }
    const buf = fs.readFileSync(f.full); let t = buf.toString('utf8'); const bom = t.charCodeAt(0) === 0xFEFF; if (bom) t = t.slice(1);
    out[k] = { ada: true, full: f.full, buf, hash: sha256(buf), bom, crlf: t.includes('\r\n'), teks: t.replace(/\r\n/g, '\n') };
  }
  return out;
}
function hitungMuncul(teks, cari) { let n = 0, i = -1; while ((i = teks.indexOf(cari, i + 1)) >= 0) { n++; if (n > 1) break; } return n; }
// Diff satu edit: baris sama di awal/akhir dibuang, sisakan 2 baris konteks. j: ' ' konteks, '-' hapus, '+' tambah.
function diffBaris(lama, baru) {
  const a = lama.split('\n'), b = baru.split('\n'); let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const K = 2, MAX = 80, out = [];
  const potong = (arr, j) => { arr.slice(0, MAX).forEach(t => out.push({ j, t })); if (arr.length > MAX) out.push({ j, t: '… (' + (arr.length - MAX) + ' baris lagi)' }); };
  a.slice(Math.max(0, p - K), p).forEach(t => out.push({ j: ' ', t }));
  potong(a.slice(p, a.length - s), '-'); potong(b.slice(p, b.length - s), '+');
  a.slice(a.length - s, Math.min(a.length, a.length - s + K)).forEach(t => out.push({ j: ' ', t }));
  return { mulai: Math.max(0, p - K) + 1, baris: out };
}
// Terapkan daftar edit ke teks (LF) di memori. Tiap "cari" harus muncul PERSIS sekali di teks saat itu.
function jalankanEdit(asal, edit) {
  const hasil = {}, diff = [];
  for (const k of Object.keys(FILE_RUANG)) hasil[k] = asal[k];
  if (!Array.isArray(edit) || !edit.length) return { ok: false, galat: 'Usulan tanpa edit' };
  if (edit.length > BATAS_USULAN.edit) return { ok: false, galat: 'Terlalu banyak edit: ' + edit.length + ' (maks ' + BATAS_USULAN.edit + ')' };
  for (let i = 0; i < edit.length; i++) {
    const e = edit[i] || {}, no = 'Edit #' + (i + 1) + ': ', f = e.file;
    if (typeof f !== 'string' || !Object.prototype.hasOwnProperty.call(FILE_RUANG, f)) return { ok: false, galat: no + 'file "' + String(f).slice(0, 80) + '" tidak diizinkan. Hanya "STATE" atau "NEXT" proyek ini.' };
    if (typeof e.cari !== 'string' || typeof e.ganti !== 'string') return { ok: false, galat: no + '"cari" dan "ganti" harus teks' };
    if (e.cari.length > BATAS_USULAN.teks || e.ganti.length > BATAS_USULAN.teks) return { ok: false, galat: no + 'teks lebih dari ' + BATAS_USULAN.teks + ' karakter' };
    const lama = hasil[f];
    if (typeof lama !== 'string') return { ok: false, galat: no + FILE_RUANG[f] + ' tidak ada, terlalu besar, atau ditolak' };
    const cari = e.cari.replace(/\r\n/g, '\n'), ganti = e.ganti.replace(/\r\n/g, '\n');
    let baru;
    if (!cari) {
      if (f !== 'NEXT') return { ok: false, galat: no + '"cari" kosong hanya boleh untuk NEXT (tambah di akhir file)' };
      if (!ganti.trim()) return { ok: false, galat: no + 'tidak ada teks yang ditambahkan' };
      baru = lama.replace(/\n*$/, '\n') + ganti.replace(/^\n+/, '').replace(/\n*$/, '\n');
    } else {
      const n = hitungMuncul(lama, cari);
      if (n !== 1) return { ok: false, galat: no + 'teks "cari" ' + (n ? 'muncul lebih dari sekali' : 'tidak ada') + ' di ' + FILE_RUANG[f] + ' (harus persis sekali): "' + cuplikan(cari.replace(/\n/g, '⏎'), 80) + '"' };
      const i0 = lama.indexOf(cari); baru = lama.slice(0, i0) + ganti + lama.slice(i0 + cari.length);
    }
    if (baru === lama) return { ok: false, galat: no + 'tidak mengubah apa pun' };
    if (Buffer.byteLength(baru, 'utf8') > BATAS_FILE_TULIS) return { ok: false, galat: no + FILE_RUANG[f] + ' jadi lebih dari 1 MB' };
    diff.push(Object.assign({ file: FILE_RUANG[f] }, diffBaris(lama, baru)));
    hasil[f] = baru;
  }
  return { ok: true, hasil, diff };
}
const pathUsulan = (slug) => path.join(DIR_USULAN, slug + '.json');
function bacaUsulan(slug) { try { const j = JSON.parse(fs.readFileSync(pathUsulan(slug), 'utf8')); return Array.isArray(j.usulan) ? j.usulan : []; } catch (e) { return []; } }
function simpanUsulan(slug, daftar) {
  fs.mkdirSync(DIR_USULAN, { recursive: true });
  const f = pathUsulan(slug), tmp = f + '.' + uid() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ slug, usulan: daftar.slice(-BATAS_USULAN.simpan) }, null, 1)); fs.renameSync(tmp, f);
}
const usulanPublik = (u) => ({ id: u.id, t: u.t, alasan: u.alasan, status: u.status, galat: u.galat || null, diff: u.diff || [], file: u.file || [], tStatus: u.tStatus || null });
function catatLogRuang(baris) { try { fs.mkdirSync(DIR_RUANG, { recursive: true }); fs.appendFileSync(LOG_RUANG, JSON.stringify(Object.assign({ t: new Date().toISOString() }, baris)) + '\n'); } catch (e) {} }
// Dari blok ```usulan-vault``` jawaban planner: validasi terhadap isi file SAAT INI, simpan (valid atau tidak).
function buatUsulan(slug, isiBlok) {
  const u = { id: crypto.randomBytes(8).toString('hex'), t: Date.now(), alasan: '', edit: [], status: 'tidak-valid', galat: null, diff: [], file: [] };
  let j = null; try { j = JSON.parse(isiBlok.trim()); } catch (e) { u.galat = 'JSON usulan tidak terbaca: ' + e.message.slice(0, 120); }
  if (j && (typeof j !== 'object' || Array.isArray(j))) { u.galat = 'Usulan harus objek JSON {"alasan","edit"}'; j = null; }
  if (j) {
    u.alasan = String(j.alasan || '').slice(0, BATAS_USULAN.alasan);
    // Hanya kunci file/cari/ganti yang disimpan; kunci lain (path, dsb.) dibuang.
    u.edit = Array.isArray(j.edit) ? j.edit.slice(0, BATAS_USULAN.edit + 1).map(e => ({ file: e && e.file, cari: e && e.cari, ganti: e && e.ganti })) : [];
    const sekarang = bacaFileRuang(slug), asal = {};
    for (const k of Object.keys(FILE_RUANG)) asal[k] = sekarang[k].teks;
    u.hash = {}; for (const k of Object.keys(FILE_RUANG)) u.hash[k] = sekarang[k].hash;
    const r = jalankanEdit(asal, u.edit);
    if (r.ok) { u.status = 'menunggu'; u.diff = r.diff; u.file = [...new Set(r.diff.map(d => d.file))]; }
    else u.galat = r.galat;
  }
  const daftar = bacaUsulan(slug); daftar.push(u); simpanUsulan(slug, daftar);
  return u;
}
function ubahStatusUsulan(slug, id, status, galat) {
  const daftar = bacaUsulan(slug), u = daftar.find(x => x.id === id); if (!u) return null;
  u.status = status; u.tStatus = Date.now(); if (galat) u.galat = galat; simpanUsulan(slug, daftar); return u;
}
const stempel = () => new Date().toISOString().replace(/[:.]/g, '-');
// ACC: hash kedua file harus sama dengan saat usulan; cadangkan versi lama; tulis ke file sementara lalu rename.
function terapkanUsulan(slug, id, siapa) {
  const u = bacaUsulan(slug).find(x => x.id === id);
  if (!u) return { kode: 404, error: 'Usulan tidak ada' };
  if (u.status !== 'menunggu') return { kode: 409, error: 'Usulan ini sudah ' + u.status + '. Tiap usulan hanya bisa dipakai sekali.', usulan: usulanPublik(u) };
  const sekarang = bacaFileRuang(slug);
  const berubah = Object.keys(FILE_RUANG).filter(k => sekarang[k].hash !== (u.hash || {})[k]);
  if (berubah.length) {
    const v = ubahStatusUsulan(slug, id, 'kedaluwarsa', 'File berubah sejak usulan dibuat (' + berubah.map(k => FILE_RUANG[k]).join(', ') + '). Tidak ada yang ditulis; minta usulan ulang.');
    catatLogRuang(Object.assign({ aksi: 'tolak-409', slug, id, file: berubah.map(k => FILE_RUANG[k]) }, siapa));
    return { kode: 409, error: 'File berubah sejak usulan dibuat (' + berubah.map(k => FILE_RUANG[k]).join(', ') + '). Tidak ada yang ditulis; minta usulan ulang.', usulan: usulanPublik(v) };
  }
  const asal = {}; for (const k of Object.keys(FILE_RUANG)) asal[k] = sekarang[k].teks;
  const r = jalankanEdit(asal, u.edit);
  if (!r.ok) { const v = ubahStatusUsulan(slug, id, 'tidak-valid', r.galat); return { kode: 409, error: r.galat, usulan: usulanPublik(v) }; }
  const kunci = Object.keys(FILE_RUANG).filter(k => r.hasil[k] !== asal[k]);
  const waktu = stempel(), dirB = path.join(DIR_BACKUP, slug), cadangan = [], tmp = {};
  try {
    fs.mkdirSync(dirB, { recursive: true });
    for (const k of kunci) { const b = path.join(dirB, waktu + '-' + FILE_RUANG[k]); fs.writeFileSync(b, sekarang[k].buf, { flag: 'wx' }); cadangan.push(b); }
    for (const k of kunci) {
      const f = fileRuang(slug, k); if (!f || !f.ada || !sama(f.full, sekarang[k].full)) throw new Error(FILE_RUANG[k] + ' ditolak saat menulis');
      let t = r.hasil[k]; if (sekarang[k].crlf) t = t.replace(/\n/g, '\r\n'); if (sekarang[k].bom) t = '﻿' + t;
      tmp[k] = f.full + '.kantor-' + uid() + '.tmp'; fs.writeFileSync(tmp[k], t, { flag: 'wx' });
    }
  } catch (e) {
    for (const k of Object.keys(tmp)) try { fs.unlinkSync(tmp[k]); } catch (x) {}
    return { kode: 500, error: 'Gagal menyiapkan tulisan, vault tidak diubah: ' + e.message };
  }
  const sudah = [];
  try { for (const k of kunci) { fs.renameSync(tmp[k], sekarang[k].full); sudah.push(k); } }
  catch (e) { // semua atau tidak sama sekali: kembalikan file yang sudah diganti dari cadangan
    for (const k of sudah) try { fs.writeFileSync(sekarang[k].full, sekarang[k].buf); } catch (x) {}
    for (const k of kunci) try { fs.unlinkSync(tmp[k]); } catch (x) {}
    return { kode: 500, error: 'Gagal menulis, perubahan dibatalkan: ' + e.message };
  }
  const v = ubahStatusUsulan(slug, id, 'diterapkan');
  const file = kunci.map(k => FILE_RUANG[k]);
  catatLogRuang(Object.assign({ aksi: 'terapkan', slug, id, file, alasan: cuplikan(u.alasan || '', 200), backup: cadangan }, siapa));
  const riw = bacaRiwayat(slug); riw.push({ dari: 'sistem', teks: 'Usulan diterapkan ke ' + file.join(' dan ') + ' (versi lama dicadangkan). ' + (u.alasan ? 'Alasan: ' + cuplikan(u.alasan, 200) : ''), t: Date.now() }); simpanRiwayat(slug, riw);
  return { kode: 200, ok: true, file, backup: cadangan, usulan: usulanPublik(v), riwayat: bacaRiwayat(slug) };
}
function tolakUsulan(slug, id, siapa) {
  const u = bacaUsulan(slug).find(x => x.id === id);
  if (!u) return { kode: 404, error: 'Usulan tidak ada' };
  if (u.status !== 'menunggu') return { kode: 409, error: 'Usulan ini sudah ' + u.status + '.', usulan: usulanPublik(u) };
  const v = ubahStatusUsulan(slug, id, 'ditolak');
  catatLogRuang(Object.assign({ aksi: 'tolak', slug, id, alasan: cuplikan(u.alasan || '', 200) }, siapa));
  return { kode: 200, ok: true, usulan: usulanPublik(v) };
}
function petaUsulan(slug, riwayat) {
  const ids = new Set(riwayat.map(m => m.usulan).filter(Boolean)), out = {};
  for (const u of bacaUsulan(slug)) if (ids.has(u.id)) out[u.id] = usulanPublik(u);
  return out;
}

async function chatRuang(slug, pesan) {
  const key = 'ruang:' + slug;
  if (running.has(key)) return { kode: 409, error: 'Planner ruang ini masih menjawab pesan sebelumnya. Tunggu sebentar.' };
  if (akunAktif()[0] >= CFG.maxAgenPerAkun) return { kode: 409, error: 'Semua slot agen akun ' + infoAkun(0).nama + ' sedang dipakai (maks ' + CFG.maxAgenPerAkun + '). Coba lagi sebentar.' };
  const batas = +CFG.batasChatHarian || 0;
  if (batas > 0 && biayaHarian() >= batas) return { kode: 429, error: 'Batas biaya chat ruang hari ini tercapai ($' + biayaHarian().toFixed(2) + ' dari $' + batas.toFixed(2) + ' biaya-setara). Coba lagi besok, atau naikkan batasChatHarian di config.json.' };
  const k = konteksRuang(slug); if (!k) return { kode: 404, error: 'Proyek tidak ada di INDEX' };
  const cw = siapkanCwdRuang(); if (cw) return { kode: 500, error: cw };
  k.git = await gitLog(repoProyek(slug), 5);
  const riwayat = bacaRiwayat(slug);
  const sesi = { slug };
  const r = await runClaude({ key, w: null, akun: 0, model: CFG.modelChat || 'sonnet', maxTurns: MAX_TURNS_RUANG, peran: 'ruang',
    system: sistemRuang(k), prompt: promptRuang(riwayat, pesan, bacaUsulan(slug)), ruang: { cwd: CWD_RUANG, sesi } });
  tambahHarian(r.biaya); broadcast();
  const dasar = { konteks: infoKonteks(k), alat: sesi.alat || null, mcp: sesi.mcp || null, biaya: r.biaya, hariIni: biayaHarian(), batasHarian: batas };
  if (r.login) { const ak = infoAkun(0); return Object.assign(dasar, { kode: 503, login: true, error: 'Akun agen belum login: ' + ak.nama + ' (configDir ' + ak.configDir + '). Login (PowerShell): $env:CLAUDE_CONFIG_DIR="' + ak.configDir + '"; claude  lalu ketik /login.' }); }
  if (r.error || !r.text) return Object.assign(dasar, { kode: 502, error: 'Planner gagal menjawab: ' + (r.error || 'jawaban kosong') });
  const jawab = { dari: 'penjaga', teks: r.text, t: Date.now(), biaya: r.biaya, token: r.token };
  const blokUsulan = ambilBlok(r.text).find(b => b.jenis === 'usulan-vault');
  if (blokUsulan) jawab.usulan = buatUsulan(slug, blokUsulan.isi).id;
  const baru = bacaRiwayat(slug).concat([{ dari: 'kamu', teks: pesan, t: Date.now() }, jawab]);
  simpanRiwayat(slug, baru);
  const riw = baru.slice(-RIWAYAT_SIMPAN);
  return Object.assign(dasar, { kode: 200, jawaban: r.text, riwayat: riw, usulan: petaUsulan(slug, riw), jalan: petaJalan(slug, riw) });
}
async function infoRuang(slug) {
  const k = konteksRuang(slug); if (!k) return null;
  k.git = await gitLog(repoProyek(slug), 5);
  const riw = bacaRiwayat(slug);
  const ak = runAktif(slug);
  return { riwayat: riw, usulan: petaUsulan(slug, riw), jalan: petaJalan(slug, riw), aktif: ak ? ak.id : null, batasJalankan: batasJalankan(),
    konteks: infoKonteks(k), sibuk: running.has('ruang:' + slug), model: CFG.modelChat || 'sonnet',
    hariIni: biayaHarian(), batasHarian: +CFG.batasChatHarian || 0, simpan: RIWAYAT_SIMPAN, kirim: RIWAYAT_KIRIM };
}


/* ---------------- Jalankan (tahap B = Fase 2c awal) ----------------
   Tombol "Jalankan" di bawah blok prompt-cc: agen (claude -p, alat Read/Edit/Write/Glob/Grep, TANPA Bash) mengerjakan
   prompt itu di git worktree terpisah (<folderWorktree>/<slug>-<id>, branch agen/<slug>-<id> dari HEAD branch aktif).
   Folder kerja user tidak disentuh. Prasyarat: repo di dalam vault, akar repo git, working tree bersih.
   Izin agen: --permission-mode dontAsk (yang tidak diizinkan otomatis DITOLAK, tidak ada prompt) + --allowedTools
   Read,Glob,Grep + Edit/Write HANYA untuk path di dalam worktree; --setting-sources user supaya .claude/settings.json
   di repo tidak bisa menambah izin/hook. Setelah selesai/berhenti: server commit di worktree (tanpa push).
   Merge ke branch asal hanya --ff-only, repo user bersih, ACC. Buang = hapus worktree + branch. */
const ALAT_JALAN = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const MAX_TURNS_JALAN = 25;
const DIR_JALAN = path.join(DIR_RUANG, 'jalan');
const STATUS_AKTIF = ['antre', 'jalan'];
const folderWorktree = () => CFG.folderWorktree ? path.resolve(CFG.folderWorktree) : path.join(path.dirname(path.resolve(CFG.folderData)), 'worktree');
const batasJalankan = () => { const b = +CFG.batasJalankan; return b > 0 ? b : 0; };
/* Izin agen Jalankan (docs permissions Claude Code):
   - "On Windows, paths are normalized to POSIX form before matching. C:\Users\alice becomes /c/Users/alice";
     "//path" = absolut dari root. Pola dibangun dari REALPATH worktree nyata, huruf drive apa pun (D:\x -> //d/x).
   - Read(...) berlaku juga untuk Glob/Grep; Glob(...)/Grep(...) dan Write(...) dengan path TIDAK dicocokkan, jadi
     tulis dibatasi lewat Edit(...) ("Edit rules apply to all built-in tools that edit files").
   - allow: baca + tulis HANYA di worktree. Read/Glob/Grep TIDAK diberi izin tanpa path (dulu: baca di mana saja).
   - deny (dievaluasi lebih dulu dari allow): kredensial di mana pun + file .git worktree.
   - setelan keras: file tools menolak baca/tulis di luar working directory (v2.1.314+). */
function polaAbs(dir) {
  let p; try { p = fs.realpathSync.native(dir); } catch (e) { p = path.resolve(dir); }
  p = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(p);
  return '/' + (m ? '/' + m[1].toLowerCase() + (m[2] || '') : p);
}
const izinJalan = (wt) => { const a = polaAbs(wt) + '/**'; return ['Read(./**)', 'Read(' + a + ')', 'Edit(./**)', 'Edit(' + a + ')']; };
const tolakJalan = () => ['Read(//**/.credentials.json)', 'Read(//**/.env)', 'Edit(./.git)', 'Edit(./.git/**)', 'Edit(//**/.git/**)'];
const SETELAN_JALAN = { permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } };
// git lewat spawn TANPA shell (argumen array). Keluaran dibatasi; timeout = dibunuh.
function git(args, opsi = {}) {
  return new Promise((resolve) => {
    const keluar = [], salah = []; let n = 0, beres = false; const max = opsi.max || 4 * 1024 * 1024;
    const selesai = (v) => { if (!beres) { beres = true; resolve(v); } };
    let ch;
    try { ch = spawn('git', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) }); }
    catch (e) { return selesai({ code: -1, out: '', err: e.message }); }
    const tm = setTimeout(() => { bunuh(ch); selesai({ code: -1, out: Buffer.concat(keluar).toString('utf8'), err: 'git timeout' }); }, opsi.timeout || 30000);
    ch.stdout.on('data', (d) => { if (n < max) { keluar.push(d); n += d.length; } });
    ch.stderr.on('data', (d) => { if (salah.length < 200) salah.push(d); });
    ch.on('error', (e) => { clearTimeout(tm); selesai({ code: -1, out: '', err: e.message }); });
    ch.on('close', (code) => { clearTimeout(tm); selesai({ code, out: Buffer.concat(keluar).toString('utf8'), err: Buffer.concat(salah).toString('utf8'), terpotong: n >= max }); });
  });
}
const pesanGit = (r) => (r.err || r.out || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300);
// Prasyarat repo: path repos.md di dalam vault, akar repo git, ada branch aktif, working tree bersih.
async function infoRepo(slug) {
  const d = detailProyek(slug); if (!d) return { kode: 404, error: 'Proyek tidak ada di INDEX' };
  if (!d.lokal) return { kode: 409, error: 'Path lokal repo belum tercatat di repos.md' };
  const repo = d.bisaBukaFolder ? dalamVault(d.lokal) : null;
  if (!repo) return { kode: 409, error: 'Folder repo tidak ada atau di luar folder vault: ' + d.lokal };
  const top = await git(['-C', repo, 'rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { kode: 409, error: 'Bukan repo git: ' + repo };
  let rTop = ''; try { rTop = fs.realpathSync.native(top.out.trim()); } catch (e) {}
  if (!sama(rTop, repo)) return { kode: 409, error: 'Folder ' + repo + ' bukan akar repo git (akarnya ' + top.out.trim() + ')' };
  const br = await git(['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (br.code !== 0) return { kode: 409, error: 'Repo sedang detached HEAD. Checkout sebuah branch dulu.' };
  const head = await git(['-C', repo, 'rev-parse', 'HEAD']);
  if (head.code !== 0) return { kode: 409, error: 'Repo belum punya commit' };
  const st = await git(['-C', repo, 'status', '--porcelain', '--untracked-files=all']);
  if (st.code !== 0) return { kode: 500, error: 'git status gagal: ' + pesanGit(st) };
  return { kode: 200, d, repo, asal: br.out.trim(), base: head.out.trim(), kotor: st.out.split(/\r?\n/).filter(Boolean).slice(0, 200) };
}
const pesanKotor = (k) => 'Working tree repo tidak bersih (' + k.length + ' file). Commit/stash dulu, lalu Jalankan lagi. Agen bekerja dari commit terakhir; perubahan yang belum di-commit tidak terlihat olehnya dan bakal konflik.';
const pathJalan = (slug) => path.join(DIR_JALAN, slug + '.json');
const pathDiff = (slug, id) => path.join(DIR_JALAN, slug + '-' + id + '.diff');
function bacaRun(slug) { try { const j = JSON.parse(fs.readFileSync(pathJalan(slug), 'utf8')); return Array.isArray(j.run) ? j.run : []; } catch (e) { return []; } }
function simpanRun(slug, daftar) {
  fs.mkdirSync(DIR_JALAN, { recursive: true });
  const f = pathJalan(slug), tmp = f + '.' + uid() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ slug, run: daftar.slice(-30) }, null, 1)); fs.renameSync(tmp, f);
}
function ubahRun(slug, id, fn) { const d = bacaRun(slug), r = d.find(x => x.id === id); if (!r) return null; fn(r); simpanRun(slug, d); return r; }
const RUN_HIDUP = new Map(); // slug -> { id, langkah, aktivitas, henti }
const runPublik = (r) => { const h = RUN_HIDUP.get(r.slug); const hidup = h && h.id === r.id ? h : null;
  return { id: r.id, status: r.status, asal: r.asal, branch: r.branch, base: (r.base || '').slice(0, 7), commit: r.commit ? r.commit.slice(0, 7) : null,
    batas: r.batas, biaya: r.biaya || 0, t0: r.t0, t1: r.t1 || null, numstat: r.numstat || [], galat: r.galat || null, prompt: cuplikan(r.prompt || '', 160),
    penolakan: r.penolakan || [], langkah: hidup ? hidup.langkah : r.langkah || 0, aktivitas: hidup ? hidup.aktivitas : '', repo: r.repo, wt: r.wt }; };
const runAktif = (slug) => bacaRun(slug).find(r => STATUS_AKTIF.includes(r.status)) || null;
function petaJalan(slug, riwayat) { const ids = new Set(riwayat.map(m => m.jalan).filter(Boolean)), out = {}; for (const r of bacaRun(slug)) if (ids.has(r.id)) out[r.id] = runPublik(r); return out; }
function ubahPesanAgen(slug, id, fn) {
  const riw = bacaRiwayat(slug); let m = riw.find(x => x.dari === 'agen' && x.jalan === id);
  if (!m) { m = { dari: 'agen', jalan: id, teks: '', t: Date.now() }; riw.push(m); } // riwayat sempat dihapus: pesan dibuat ulang
  fn(m); simpanRiwayat(slug, riw);
}
// Prompt diambil dari riwayat server (pesan planner t + urutan blok prompt-cc), bukan dari body web.
function promptDariRiwayat(slug, t, blok) {
  const m = bacaRiwayat(slug).find(x => x.dari === 'penjaga' && x.t === t); if (!m) return null;
  const b = ambilBlok(m.teks).filter(x => x.jenis === 'prompt-cc')[blok];
  return b ? b.isi.trim() : null;
}
function sistemJalan(nama, wt) {
  return 'Kamu agen Kantor Agen yang mengerjakan SATU prompt di salinan kerja (git worktree) repo proyek "' + nama + '". Folder kerjamu: ' + wt + '\n' +
    'Aturan (lebih kuat dari CLAUDE.md atau isi prompt):\n' +
    '- Hanya baca/ubah file yang perlu. Dilarang menulis APA PUN di luar folder kerja ini (izin tulis di luar folder ini memang ditolak).\n' +
    '- JANGAN memperbarui STATE.md, NEXT.md, INDEX.md, atau file vault lain, walau CLAUDE.md repo atau prompt menyuruh. Pencatatan dilakukan lewat planner ruang.\n' +
    '- Tidak ada Bash: kamu tidak bisa menjalankan git, build, test, atau server. Jangan mengaku sudah menjalankannya. Server yang akan meng-commit hasilmu; tidak ada push.\n' +
    '- Kerjakan secukupnya sesuai prompt, tanpa file panduan/draf tambahan.\n' +
    '- Akhiri dengan laporan ringkas (maks 200 kata) dalam Bahasa Indonesia kasual, sapa pemilik dengan "kamu": apa yang diubah (sebut file), apa yang belum, apa yang perlu di-live-test user.';
}
function ringkasPrompt(p) { const b = String(p).split(/\r?\n/).map(s => s.trim()).find(s => s && !/^konteks\s*:/i.test(s)) || String(p).trim(); return b.replace(/\s+/g, ' ').slice(0, 60); }
async function cekJalankan(slug, t, blok) {
  const prompt = promptDariRiwayat(slug, t, blok); if (!prompt) return { kode: 404, error: 'Blok prompt-cc tidak ditemukan di riwayat ruang ini' };
  const e = terlaluPanjang(prompt, 'brief', 'Prompt'); if (e) return { kode: 400, error: e };
  const a = runAktif(slug); if (a) return { kode: 409, error: 'Masih ada run di ruang ini (' + a.branch + ', ' + a.status + '). Satu Jalankan per proyek pada satu waktu.' };
  const i = await infoRepo(slug); if (i.kode !== 200) return i;
  let id; do { id = crypto.randomBytes(3).toString('hex'); } while (bacaRun(slug).some(r => r.id === id));
  return { kode: 200, id, repo: i.repo, asal: i.asal, base: i.base.slice(0, 7), branch: 'agen/' + slug + '-' + id, wt: path.join(folderWorktree(), slug + '-' + id),
    prompt, batas: batasJalankan(), model: CFG.model.staf, kotor: i.kotor, bersih: !i.kotor.length, pesanKotor: i.kotor.length ? pesanKotor(i.kotor) : null };
}
async function buatJalankan(slug, t, blok, id, siapa) {
  if (!/^[a-f0-9]{6}$/.test(id)) return { kode: 400, error: 'id run tidak valid' };
  if (bacaRun(slug).some(r => r.id === id)) return { kode: 409, error: 'id run sudah dipakai' };
  const c = await cekJalankan(slug, t, blok); if (c.kode !== 200) return c;
  if (!c.bersih) return { kode: 409, error: c.pesanKotor, kotor: c.kotor };
  const root = folderWorktree(), wt = path.join(root, slug + '-' + id), branch = 'agen/' + slug + '-' + id;
  const vault = folderVault();
  if (diDalam(c.repo, wt) || (vault && diDalam(path.resolve(vault), wt))) return { kode: 500, error: 'folderWorktree tidak boleh di dalam repo atau vault: ' + root };
  if (fs.existsSync(wt)) return { kode: 409, error: 'Folder worktree sudah ada: ' + wt };
  fs.mkdirSync(root, { recursive: true });
  const base = (await git(['-C', c.repo, 'rev-parse', 'HEAD'])).out.trim();
  const add = await git(['-C', c.repo, 'worktree', 'add', wt, '-b', branch, base]);
  if (add.code !== 0) return { kode: 500, error: 'git worktree add gagal: ' + pesanGit(add) };
  let gitFile = null; try { gitFile = fs.readFileSync(path.join(wt, '.git'), 'utf8'); } catch (e) {}
  const run = { id, slug, status: 'antre', repo: c.repo, asal: c.asal, base, branch, wt, gitFile, izin: izinJalan(wt), prompt: c.prompt, batas: c.batas, biaya: 0, t0: Date.now(), dari: t };
  const d = bacaRun(slug); d.push(run); simpanRun(slug, d);
  ubahPesanAgen(slug, id, () => {});
  catatLogRuang(Object.assign({ aksi: 'jalankan', slug, run: id, branch, repo: c.repo, asal: c.asal, base: base.slice(0, 7) }, siapa));
  mulaiAntrean();
  return { kode: 200, run: runPublik(bacaRun(slug).find(r => r.id === id)) };
}
// Antrean: run 'antre' mulai saat slot akun (maxAgenPerAkun, dipakai bersama staf/chat) tersedia.
function mulaiAntrean() {
  let berkas = []; try { berkas = fs.readdirSync(DIR_JALAN).filter(f => /\.json$/.test(f)); } catch (e) { return; }
  for (const f of berkas) {
    const slug = f.replace(/\.json$/, ''); if (running.has('jalan:' + slug)) continue;
    const r = bacaRun(slug).find(x => x.status === 'antre'); if (!r) continue;
    if (akunAktif()[0] >= CFG.maxAgenPerAkun) return;
    kerjakanRun(slug, r.id);
  }
}
setInterval(mulaiAntrean, 2000);
async function kerjakanRun(slug, id) {
  const r0 = ubahRun(slug, id, r => { r.status = 'jalan'; r.tMulai = Date.now(); }); if (!r0) return;
  const hidup = { id, langkah: 0, aktivitas: 'memulai', henti: false }; RUN_HIDUP.set(slug, hidup);
  const p = bacaProyek().proyek.find(x => x.slug === slug) || { nama: slug };
  const sesi = { slug, jalan: id };
  const r = await runClaude({ key: 'jalan:' + slug, w: null, akun: 0, model: CFG.model.staf, maxTurns: MAX_TURNS_JALAN, peran: 'jalan',
    system: sistemJalan(p.nama, r0.wt), prompt: r0.prompt, ruang: { mode: 'kerja', cwd: r0.wt, sesi, izin: izinJalan(r0.wt), tolak: tolakJalan(), budget: r0.batas },
    onEvent: (ev) => { if (ev.alat) { hidup.langkah++; hidup.aktivitas = ev.alat + (ev.file ? ' ' + path.basename(String(ev.file)) : ''); } } });
  hidup.aktivitas = 'commit';
  // Commit semua perubahan di worktree (selesai maupun berhenti). Tanpa push.
  let commit = null, numstat = [], galatCommit = null;
  // Penjaga: file .git worktree (penunjuk gitdir) harus persis seperti saat dibuat. Kalau diubah, git di worktree bisa
  // diarahkan ke repo/branch lain (mis. working tree user). Commit dibatalkan, worktree dibiarkan untuk diperiksa/Buang.
  let gitSekarang = null; try { const ls = fs.lstatSync(path.join(r0.wt, '.git')); if (ls.isFile() && !ls.isSymbolicLink()) gitSekarang = fs.readFileSync(path.join(r0.wt, '.git'), 'utf8'); } catch (e) {}
  const addA = r0.gitFile && gitSekarang === r0.gitFile ? await git(['-C', r0.wt, 'add', '-A']) : null;
  if (!addA) galatCommit = 'File .git worktree berubah atau hilang; commit dibatalkan. Periksa worktree lalu Buang.';
  else if (addA.code !== 0) galatCommit = 'git add gagal: ' + pesanGit(addA);
  else if ((await git(['-C', r0.wt, 'diff', '--cached', '--quiet'])).code === 1) {
    const cm = await git(['-C', r0.wt, '-c', 'user.name=Agen Kantor', '-c', 'user.email=agen-kantor@localhost', 'commit', '-q', '-m', 'agen: ' + ringkasPrompt(r0.prompt)]);
    if (cm.code !== 0) galatCommit = 'git commit gagal: ' + pesanGit(cm);
    else {
      commit = (await git(['-C', r0.wt, 'rev-parse', 'HEAD'])).out.trim();
      const ns = await git(['-C', r0.wt, '-c', 'core.quotepath=false', 'diff', '--numstat', r0.base, commit]);
      numstat = ns.out.split(/\r?\n/).filter(Boolean).slice(0, 200).map(l => { const [a, b, ...f] = l.split('\t'); return { file: f.join('\t'), tambah: a === '-' ? null : +a, hapus: b === '-' ? null : +b }; });
      const df = await git(['-C', r0.wt, '-c', 'core.quotepath=false', 'diff', r0.base, commit], { max: 1024 * 1024 });
      try { fs.writeFileSync(pathDiff(slug, id), df.out + (df.terpotong ? '\n… (diff dipotong di 1 MB)\n' : '')); } catch (e) {}
    }
  }
  const ak = r.login && infoAkun(0);
  const status = hidup.henti ? 'dihentikan' : r.login || r.error || !addA ? 'gagal' : 'selesai';
  const galat = [ak ? 'Akun agen belum login: ' + ak.nama + ' (' + ak.configDir + '). Login: $env:CLAUDE_CONFIG_DIR="' + ak.configDir + '"; claude lalu /login.' : null,
    !hidup.henti && r.error && !r.login ? r.error : null, galatCommit].filter(Boolean).join(' · ') || null;
  const penolakan = (r.penolakan || []).slice(0, 20).map(x => ({ alat: x.tool_name, file: x.tool_input && (x.tool_input.file_path || x.tool_input.path || x.tool_input.pattern) || null }));
  ubahRun(slug, id, x => { x.status = status; x.t1 = Date.now(); x.biaya = r.biaya || 0; x.commit = commit; x.numstat = numstat; x.galat = galat; x.penolakan = penolakan; x.langkah = hidup.langkah; x.alat = sesi.alat || null; });
  RUN_HIDUP.delete(slug);
  ubahPesanAgen(slug, id, m => { m.teks = r.text || r.teksTerakhir || (hidup.henti ? '(dihentikan sebelum agen menulis laporan)' : '(agen tidak menulis laporan)'); m.biaya = r.biaya || 0; m.token = r.token || 0; m.t = Date.now(); });
  catatLogRuang({ aksi: 'run-' + status, slug, run: id, biaya: r.biaya || 0, commit: commit ? commit.slice(0, 7) : null, penolakan: penolakan.length });
  broadcast(); mulaiAntrean();
}
function hentikanRun(slug, id, siapa) {
  const r = bacaRun(slug).find(x => x.id === id); if (!r) return { kode: 404, error: 'Run tidak ada' };
  if (r.status === 'antre') { ubahRun(slug, id, x => { x.status = 'dihentikan'; x.t1 = Date.now(); }); catatLogRuang(Object.assign({ aksi: 'hentikan', slug, run: id }, siapa)); return { kode: 200, run: runPublik(bacaRun(slug).find(x => x.id === id)) }; }
  if (r.status !== 'jalan') return { kode: 409, error: 'Run tidak sedang berjalan (' + r.status + ')' };
  const h = RUN_HIDUP.get(slug); if (h && h.id === id) h.henti = true;
  const p = running.get('jalan:' + slug); if (p) bunuh(p.child);
  catatLogRuang(Object.assign({ aksi: 'hentikan', slug, run: id }, siapa));
  return { kode: 200, run: runPublik(r) };
}
async function bersihkanRun(r, hapusBranch) { // worktree remove + (opsional) branch -D; kembalikan daftar galat
  const g = [];
  // .git worktree diubah agen (penjaga commit) -> git menolak 'worktree remove'. Pulihkan dulu dari isi saat dibuat.
  // Di Windows file .git ber-atribut hidden: tulis lewat 'r+' (mode 'w' gagal EPERM pada file hidden).
  if (r.gitFile && fs.existsSync(r.wt)) {
    const p = path.join(r.wt, '.git'); let kini = null; try { kini = fs.readFileSync(p, 'utf8'); } catch (e) {}
    if (kini !== r.gitFile) {
      try { const ls = fs.lstatSync(p); if (ls.isSymbolicLink() || ls.isDirectory()) fs.rmSync(p, { recursive: true, force: true }); } catch (e) {}
      try { const b = Buffer.from(r.gitFile, 'utf8'); let fd; try { fd = fs.openSync(p, 'r+'); } catch (e) { fd = fs.openSync(p, 'w'); } fs.ftruncateSync(fd, 0); fs.writeSync(fd, b, 0, b.length, 0); fs.closeSync(fd); }
      catch (e) { g.push('pulihkan .git: ' + e.message); }
    }
  }
  if (fs.existsSync(r.wt)) { const rm = await git(['-C', r.repo, 'worktree', 'remove', '--force', r.wt]); if (rm.code !== 0) g.push('worktree remove: ' + pesanGit(rm)); }
  await git(['-C', r.repo, 'worktree', 'prune']);
  if (hapusBranch) { const b = await git(['-C', r.repo, 'branch', hapusBranch, r.branch]); if (b.code !== 0) g.push('branch ' + hapusBranch + ': ' + pesanGit(b)); }
  return g;
}
async function mergeRun(slug, id, siapa) {
  const r = bacaRun(slug).find(x => x.id === id); if (!r) return { kode: 404, error: 'Run tidak ada' };
  if (!['selesai', 'gagal', 'dihentikan'].includes(r.status)) return { kode: 409, error: 'Run ini ' + r.status + '; tidak bisa di-merge.' };
  if (!r.commit) return { kode: 409, error: 'Run tidak menghasilkan commit; tidak ada yang di-merge. Pakai Buang.' };
  const i = await infoRepo(slug); if (i.kode !== 200) return i;
  if (!sama(i.repo, r.repo)) return { kode: 409, error: 'Path repo di repos.md berubah sejak run dibuat' };
  if (i.kotor.length) return { kode: 409, error: pesanKotor(i.kotor) + ' Merge ditolak.', kotor: i.kotor };
  if (i.asal !== r.asal) return { kode: 409, error: 'Branch aktif repo sekarang "' + i.asal + '", bukan branch asal "' + r.asal + '". Checkout ' + r.asal + ' dulu kalau mau merge.' };
  const anc = await git(['-C', r.repo, 'merge-base', '--is-ancestor', r.asal, r.branch]);
  if (anc.code !== 0) return { kode: 409, error: 'Tidak bisa fast-forward: ' + r.asal + ' sudah punya commit baru setelah run ini dibuat. Merge ditolak (tanpa merge commit/rebase otomatis). Buang lalu Jalankan ulang, atau gabungkan manual.', nonff: true };
  const m = await git(['-C', r.repo, 'merge', '--ff-only', r.branch]);
  if (m.code !== 0) return { kode: 409, error: 'git merge --ff-only gagal: ' + pesanGit(m) };
  const g = await bersihkanRun(r, '-d');
  ubahRun(slug, id, x => { x.status = 'merged'; x.tSelesai = Date.now(); x.galatBersih = g.length ? g.join(' · ') : null; });
  catatLogRuang(Object.assign({ aksi: 'merge', slug, run: id, branch: r.branch, ke: r.asal, commit: r.commit.slice(0, 7) }, siapa));
  const riw = bacaRiwayat(slug); riw.push({ dari: 'sistem', teks: 'Run ' + r.branch + ' di-merge (fast-forward) ke ' + r.asal + ' di repo lokal. Tidak ada push. Worktree dan branch agen dibersihkan.' + (g.length ? ' Catatan: ' + g.join(' · ') : ''), t: Date.now() }); simpanRiwayat(slug, riw);
  return { kode: 200, ok: true, run: runPublik(bacaRun(slug).find(x => x.id === id)), riwayat: riw.slice(-RIWAYAT_SIMPAN) };
}
async function buangRun(slug, id, siapa) {
  const r = bacaRun(slug).find(x => x.id === id); if (!r) return { kode: 404, error: 'Run tidak ada' };
  if (STATUS_AKTIF.includes(r.status)) return { kode: 409, error: 'Run masih ' + r.status + '. Hentikan dulu.' };
  if (r.status === 'merged' || r.status === 'dibuang') return { kode: 409, error: 'Run ini sudah ' + r.status + '.' };
  const g = await bersihkanRun(r, '-D');
  if (fs.existsSync(r.wt)) return { kode: 500, error: 'Worktree tidak bisa dihapus: ' + g.join(' · ') };
  ubahRun(slug, id, x => { x.status = 'dibuang'; x.tSelesai = Date.now(); x.galatBersih = g.length ? g.join(' · ') : null; });
  catatLogRuang(Object.assign({ aksi: 'buang', slug, run: id, branch: r.branch }, siapa));
  const riw = bacaRiwayat(slug); riw.push({ dari: 'sistem', teks: 'Run ' + r.branch + ' dibuang: worktree dan branch agen dihapus.' + (g.length ? ' Catatan: ' + g.join(' · ') : ''), t: Date.now() }); simpanRiwayat(slug, riw);
  return { kode: 200, ok: true, run: runPublik(bacaRun(slug).find(x => x.id === id)), riwayat: riw.slice(-RIWAYAT_SIMPAN) };
}
function diffRun(slug, id) {
  const r = bacaRun(slug).find(x => x.id === id); if (!r) return { kode: 404, error: 'Run tidak ada' };
  let t = null; try { t = fs.readFileSync(pathDiff(slug, id), 'utf8'); } catch (e) {}
  if (t == null) return { kode: 404, error: r.commit ? 'Diff tidak tersimpan' : 'Run tidak menghasilkan perubahan' };
  return { kode: 200, diff: t, numstat: r.numstat || [], branch: r.branch, base: (r.base || '').slice(0, 7), commit: (r.commit || '').slice(0, 7) };
}
// Server mati saat run berjalan: proses agen ikut hilang. Tandai dihentikan (worktree tetap, bisa Buang).
try { for (const f of fs.readdirSync(DIR_JALAN).filter(x => /\.json$/.test(x))) { const slug = f.replace(/\.json$/, ''); const d = bacaRun(slug); let ubah = false;
  for (const r of d) if (r.status === 'jalan') { r.status = 'dihentikan'; r.galat = 'Server berhenti saat run berjalan'; ubah = true; }
  if (ubah) simpanRun(slug, d); } } catch (e) {}

/* ---------------- /aset: model & tekstur web (Fase 3a), publik baca-saja ----------------
   Hanya folder <repo>/aset. Tanpa PIN (isinya aset CC0 yang memang ada di repo publik). Path dicek dari URL mentah
   lewat dalamFolder (tolak .., absolut, drive, symlink/junction keluar folder). */
const ASET = path.join(ROOT, '..', 'aset');
const TIPE_ASET = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
function sajikanAset(req, res) {
  const tolak = (code, msg) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); res.end(msg); };
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); return tolak(405, 'Pakai GET'); }
  const m = req.url.split('?')[0].match(/^\/aset\/(.+)$/); if (!m) return tolak(404, 'Tidak ada');
  let rel; try { rel = decodeURIComponent(m[1]); } catch (e) { return tolak(400, 'Path tidak valid'); }
  const full = dalamFolder(ASET, rel);
  if (full === null) return tolak(403, 'Ditolak: path di luar folder aset');
  const tipe = full && TIPE_ASET[path.extname(full).toLowerCase()];
  let st; try { st = full && fs.statSync(full); } catch (e) {}
  if (!st || !st.isFile()) return tolak(404, 'Tidak ada');
  if (!tipe) return tolak(403, 'Jenis file tidak disajikan');
  res.writeHead(200, { 'content-type': tipe, 'content-length': st.size, 'x-content-type-options': 'nosniff', 'cache-control': 'public, max-age=3600' });
  fs.createReadStream(full).pipe(res);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(WEB).pipe(res); }
    if (req.method === 'GET' && u.pathname === '/dashboard.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(DASBOR).pipe(res); }
    if (/^\/aset(\/|\?|$)/.test(req.url)) return sajikanAset(req, res);
    const pinOk = (req.headers['x-pin'] || u.searchParams.get('pin')) === CFG.pin;
    // Dicek dari URL mentah: parser URL melipat "../" dan "%2e%2e" sebelum sampai sini.
    if (/^\/hasil(\/|\?|$)/.test(req.url)) { if (req.method !== 'GET') return tolakHasil(res, 405, 'Pakai GET'); return sajikanHasil(req, res, pinOk); }
    if (p[0] !== 'api') { res.writeHead(404); return res.end('Tidak ada'); }
    // Dot-segment di URL mentah (../, %2e%2e) dilipat parser URL ke rute lain; tolak saja daripada diarahkan diam-diam.
    if (/(^|\/)(\.|%2e){2}(\/|\?|$)/i.test(req.url.split('?')[0])) return send(res, 403, { error: 'Ditolak: path tidak valid' });
    // API hanya dari halaman server sendiri (web kantor/dasbor = same-origin) atau URL yang diketik langsung.
    // Halaman hasil (origin opaque → Origin: null, Sec-Fetch-Site: cross-site) dan situs lain ditolak, termasuk
    // percobaan menebak PIN lewat fetch/img/form.
    const asal = req.headers.origin, sfs = req.headers['sec-fetch-site'];
    let asalAsing = false;
    if (asal) { try { asalAsing = new URL(asal).host !== req.headers.host; } catch (e) { asalAsing = true; } } // termasuk 'null'
    if (asalAsing || (sfs && sfs !== 'same-origin' && sfs !== 'none')) return send(res, 403, { error: 'Ditolak: permintaan API dari luar web Kantor Agen' });
    if (!pinOk) return send(res, 401, { error: 'PIN salah' });
    if (p[1] === 'state') return send(res, 200, JSON.parse(snapshot()));
    if (req.method === 'GET' && p[1] === 'usage') return send(res, 200, await usage.ringkasan(CFG));
    if (req.method === 'GET' && p[1] === 'projects') return send(res, 200, usage.proyek(CFG));
    if (req.method === 'GET' && p[1] === 'proyek' && !p[2]) return send(res, 200, bacaProyek());
    if (p[1] === 'proyek' && p[2]) {
      const RUTE = { detail: 'GET', 'buka-folder': 'POST', chat: 'GET POST', 'chat-hapus': 'POST', terapkan: 'POST', tolak: 'POST',
        'jalankan-cek': 'POST', jalankan: 'POST', hentikan: 'POST', merge: 'POST', buang: 'POST', diff: 'GET' };
      const benar = Object.prototype.hasOwnProperty.call(RUTE, p[3] || '') && RUTE[p[3]].split(' ').includes(req.method);
      if (!benar || p[4]) return send(res, 404, { error: 'Tidak ada' });
      const sl = slugProyek(req, p);
      if (!sl.slug) return send(res, sl.kode, { error: sl.kode === 403 ? 'Ditolak: path tidak valid' : sl.kode === 400 ? 'Slug tidak valid' : 'Proyek tidak ada di INDEX' });
      if (p[3] === 'chat' && req.method === 'GET') { const i = await infoRuang(sl.slug); return i ? send(res, 200, i) : send(res, 404, { error: 'Proyek tidak ada di INDEX' }); }
      if (p[3] === 'chat') {
        const b = await body(req); const pesan = String(b.pesan || '').trim();
        if (!pesan) return send(res, 400, { error: 'Pesan kosong' });
        const e = terlaluPanjang(pesan, 'chat', 'Pesan'); if (e) return send(res, 400, { error: e }); // ditolak, tidak dipotong
        const h = await chatRuang(sl.slug, pesan); const kode = h.kode; delete h.kode; return send(res, kode, h);
      }
      if (p[3] === 'chat-hapus') {
        if (!konteksRuang(sl.slug)) return send(res, 404, { error: 'Proyek tidak ada di INDEX' });
        if (running.has('ruang:' + sl.slug)) return send(res, 409, { error: 'Penjaga sedang menjawab. Hapus riwayat setelah jawabannya masuk.' });
        try { fs.unlinkSync(pathRiwayat(sl.slug)); } catch (e) {}
        return send(res, 200, { ok: true, riwayat: [] });
      }
      if (['jalankan-cek', 'jalankan', 'hentikan', 'merge', 'buang', 'diff'].includes(p[3])) { // Tahap B: run agen di worktree
        const siapa = { siapa: 'web', ip: req.socket.remoteAddress || '' };
        let h;
        if (p[3] === 'diff') { const id = String(u.searchParams.get('id') || ''); h = /^[a-f0-9]{6}$/.test(id) ? diffRun(sl.slug, id) : { kode: 400, error: 'id run tidak valid' }; }
        else {
          const b = await body(req);
          if (p[3] === 'jalankan-cek' || p[3] === 'jalankan') {
            const t = +b.t, blok = +b.blok || 0;
            if (!Number.isFinite(t) || !Number.isInteger(blok) || blok < 0 || blok > 20) h = { kode: 400, error: 'Referensi prompt tidak valid' };
            else h = p[3] === 'jalankan-cek' ? await cekJalankan(sl.slug, t, blok) : await buatJalankan(sl.slug, t, blok, String(b.id || ''), siapa);
          } else {
            const id = String(b.id || '');
            if (!/^[a-f0-9]{6}$/.test(id)) h = { kode: 400, error: 'id run tidak valid' };
            else h = p[3] === 'hentikan' ? hentikanRun(sl.slug, id, siapa) : p[3] === 'merge' ? await mergeRun(sl.slug, id, siapa) : await buangRun(sl.slug, id, siapa);
          }
        }
        const kode = h.kode; delete h.kode; return send(res, kode, h);
      }
      if (p[3] === 'terapkan' || p[3] === 'tolak') { // ACC / Tolak usulan vault. Isi yang ditulis dari usulan tersimpan, body hanya {id}.
        const b = await body(req); const id = String(b.id || '');
        if (!/^[a-f0-9]{16}$/.test(id)) return send(res, 400, { error: 'id usulan tidak valid' });
        const siapa = { siapa: 'web', ip: req.socket.remoteAddress || '' };
        const h = p[3] === 'terapkan' ? terapkanUsulan(sl.slug, id, siapa) : tolakUsulan(sl.slug, id, siapa);
        const kode = h.kode; delete h.kode; return send(res, kode, h);
      }
      const d = detailProyek(sl.slug); if (!d) return send(res, 404, { error: 'Proyek tidak ada di INDEX' });
      if (p[3] === 'detail') { // + commit terakhir repo lokal (hanya kalau path ada dan di dalam vault)
        const g = d.bisaBukaFolder ? await gitLog(dalamVault(d.lokal), 5) : null;
        d.commit = g && g.length ? parseCommit(g[0]) : null;
        d.commitAlasan = d.commit ? null : !d.lokal ? 'Path lokal belum tercatat di repos.md' : !d.bisaBukaFolder ? 'Folder lokal tidak ada atau di luar vault' : 'Bukan repo git, atau git gagal';
        return send(res, 200, d);
      }
      if (!d.lokal) return send(res, 404, { error: 'Path lokal proyek belum tercatat di repos.md' });
      if (!d.bisaBukaFolder) return send(res, 403, { error: 'Folder tidak ada atau di luar folder vault: ' + d.lokal });
      if (process.platform !== 'win32') return send(res, 501, { error: 'Buka folder hanya di Windows. Folder: ' + d.lokal });
      const dir = dalamVault(d.lokal); if (!dir) return send(res, 403, { error: 'Folder di luar folder vault' });
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
      return send(res, 200, { ok: true, pesan: 'Folder dibuka di laptop (jendela Explorer): ' + dir });
    }
    if (p[1] === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: ' + snapshot() + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (req.method === 'GET' && p[1] === 'ws' && p[3] === 'files' && !p[4]) {
      const w = S.ws.find(x => x.id === p[2]); if (!w) return send(res, 404, { error: 'Workspace tidak ditemukan' });
      if (!w.folder || !fs.existsSync(w.folder) || !fs.statSync(w.folder).isDirectory()) return send(res, 404, { error: 'Folder tidak ditemukan: ' + (w.folder || '(kosong)'), folder: w.folder || '', ada: false });
      return send(res, 200, { folder: w.folder, ada: true, files: daftarHasil(w.folder) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Pakai POST' });
    const b = await body(req);
    if (p[1] === 'ws' && !p[2]) {
      const nama = String(b.nama || 'Proyek ' + (S.ws.length + 1)); const e = terlaluPanjang(nama, 'nama', 'Nama workspace'); if (e) return send(res, 400, { error: e });
      const w = newWs(nama); return send(res, 200, { id: w.id });
    }
    const w = S.ws.find(x => x.id === p[2]); if (!w) return send(res, 404, { error: 'Workspace tidak ditemukan' });
    const act = p[3];
    if (act === 'buka-folder') {
      if (!w.folder || !fs.existsSync(w.folder)) return send(res, 404, { error: 'Folder tidak ditemukan: ' + (w.folder || '(kosong)') });
      if (process.platform !== 'win32') return send(res, 501, { error: 'Buka folder hanya di Windows. Folder: ' + w.folder });
      spawn('explorer.exe', [w.folder], { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => {}).unref();
      return send(res, 200, { ok: true, pesan: 'Folder dibuka di laptop (jendela Explorer): ' + w.folder });
    }
    if (act === 'brief') {
      if (w.status === 'planning' || w.status === 'running' || w.status === 'final') return send(res, 409, { error: 'Proyek masih berjalan' });
      const goal = String(b.goal || ''); const e = terlaluPanjang(goal, 'brief', 'Brief'); if (e) return send(res, 400, { error: e }); // state tidak disentuh
      w.goal = goal; w.tasks = []; w.laporan = ''; w.ringkasan = ''; w.usulan = null;
      w.mode = b.mode === 'tim' ? 'tim' : 'solo'; // default Solo
      if (b.batas != null && b.batas !== '') { const n = +b.batas; if (Number.isFinite(n) && n >= 0) w.batas = n; } // kosong = batas lama/config tetap
      if (w.mode === 'solo') { mulaiSolo(w); return send(res, 200, { ok: true, mode: w.mode }); }
      w.status = 'planning';
      log(w, 'Arya', 'Menerima brief (mode Tim): "' + cuplikan(w.goal) + '". Menyusun usulan rencana.'); plan(w).then(changed); return send(res, 200, { ok: true, mode: w.mode });
    }
    if (act === 'jalankan') {
      if (w.status !== 'usulan') return send(res, 409, { error: 'Tidak ada usulan yang menunggu' });
      w.status = 'running'; log(w, 'Sistem', 'Usulan disetujui. Staf mulai bekerja.'); return send(res, 200, { ok: true });
    }
    if (act === 'batal') {
      if (w.status !== 'usulan') return send(res, 409, { error: 'Tidak ada usulan yang menunggu' });
      w.status = 'batal'; log(w, 'Sistem', 'Usulan dibatalkan. Tidak ada staf yang dijalankan. Kirim brief baru kapan saja.'); return send(res, 200, { ok: true });
    }
    // Rem darurat workspace: bunuh semua sesi (seluruh pohon proses), tugas yang sedang jalan = "dihentikan".
    if (act === 'stop') {
      if (!['planning', 'running', 'final', 'jeda-biaya'].includes(w.status)) return send(res, 409, { error: 'Workspace tidak sedang berjalan' });
      for (const t of w.tasks) if (t.status === 'kerja') t.status = 'dihentikan';
      w.status = 'dihentikan'; stopAll(w);
      for (const a of w.agents) if (a.div === 'manager') { a.state = 'idle'; a.aktivitas = ''; }
      log(w, 'Sistem', 'Workspace dihentikan (rem darurat). Tidak ada tugas baru yang dijadwalkan sampai kamu menekan Lanjutkan.'); return send(res, 200, { ok: true });
    }
    // Rem darurat per tugas: hanya tugas itu yang dibunuh; workspace ikut berhenti menjadwalkan.
    // Lewati: tugas dihentikan dianggap selesai tanpa hasil. Status workspace tidak berubah (user tetap menekan Lanjutkan).
    if (act === 'lewati') {
      const t = w.tasks.find(x => x.id === b.task); if (!t || t.status !== 'dihentikan') return send(res, 409, { error: 'Hanya tugas yang dihentikan yang bisa dilewati' });
      t.status = 'dilewati';
      const turunan = w.tasks.filter(x => (x.after || []).includes(t.id)).map(x => x.title);
      log(w, 'Sistem', 'Tugas "' + t.title + '" dilewati.' + (turunan.length ? ' Tugas yang bergantung padanya tetap jalan tanpa hasilnya: ' + turunan.join(', ') + '.' : ''));
      return send(res, 200, { ok: true });
    }
    if (act === 'stop-tugas') {
      const t = w.tasks.find(x => x.id === b.task); if (!t || t.status !== 'kerja') return send(res, 409, { error: 'Tugas tidak sedang berjalan' });
      t.status = 'dihentikan'; const r = running.get(w.id + ':' + t.agent); if (r) bunuh(r.child);
      if (w.status === 'running' || w.status === 'jeda-biaya') w.status = 'dihentikan';
      log(w, 'Sistem', 'Tugas "' + t.title + '" dihentikan (rem darurat). Tekan Lanjutkan untuk meneruskan antrean.'); return send(res, 200, { ok: true });
    }
    if (act === 'lanjut') {
      if (w.status !== 'idle' && w.status !== 'dihentikan') return send(res, 409, { error: 'Workspace tidak sedang berhenti' });
      // Proses yang baru dibunuh belum tertutup: tunggu, supaya hasil run lama tidak menimpa run baru.
      if (w.agents.some(a => a.state === 'kerja' && w.tasks.some(t => t.id === a.task && t.status === 'dihentikan'))) return send(res, 409, { error: 'Proses yang dihentikan masih ditutup. Coba lagi sebentar.' });
      let ulang = 0;
      for (const t of w.tasks) if (t.status === 'dihentikan') { t.status = 'antre'; t.progress = 0; t.agent = null; t.coba = 0; ulang++; }
      if (ulang) log(w, 'Sistem', ulang + ' tugas yang dihentikan diantrekan ulang.');
      if (w.mode === 'tim' && !w.tasks.length && w.goal) { w.status = 'planning'; log(w, 'Sistem', 'Dilanjutkan: manajer menyusun ulang usulan.'); plan(w).then(changed); }
      else if (w.tasks.length) { w.status = 'running'; log(w, 'Sistem', 'Proyek dilanjutkan.'); }
      return send(res, 200, { ok: true });
    }
    // "Sudah login, lanjutkan": kembali ke tahap yang tertahan. Login tidak dicek di sini (bisa tersimpan di luar configDir);
    // kalau masih belum login, panggilan berikutnya kembali ke butuh-login tanpa retry.
    if (act === 'lanjut-login') {
      if (w.status !== 'butuh-login') return send(res, 409, { error: 'Workspace tidak sedang menunggu login' });
      const dari = w.loginDari; w.loginDari = null; w.loginAkun = null; cekKredensial();
      if (dari === 'plan') { w.status = 'planning'; log(w, 'Sistem', 'Login dikonfirmasi. Manajer menyusun ulang usulan.'); plan(w).then(changed); }
      else { w.status = 'running'; log(w, 'Sistem', 'Login dikonfirmasi. Antrean dilanjutkan.'); }
      return send(res, 200, { ok: true });
    }
    // Batas biaya per workspace. lanjut=true dari tombol "Naikkan batas & lanjut" (ACC).
    if (act === 'batas') {
      let n = null; if (b.batas != null && b.batas !== '') { n = +b.batas; if (!Number.isFinite(n) || n < 0) return send(res, 400, { error: 'Batas harus angka ≥ 0 (USD)' }); }
      const lama = w.batas; w.batas = n;
      if (b.lanjut) {
        if (w.status !== 'jeda-biaya') { changed(); return send(res, 200, { ok: true }); }
        if (lewatBatas(w)) { const baru = batasEfektif(w); w.batas = lama; return send(res, 400, { error: 'Batas baru ($' + baru.toFixed(2) + ') belum melebihi terpakai ($' + (w.biaya || 0).toFixed(2) + ')' }); }
        const dari = w.jedaDari; w.jedaDari = null;
        if (dari === 'plan') { w.status = 'planning'; plan(w).then(changed); } else w.status = 'running';
        log(w, 'Sistem', 'Batas dinaikkan ke ' + (batasEfektif(w) ? '$' + batasEfektif(w).toFixed(2) : 'tanpa batas') + '. Dilanjutkan.');
      } else { log(w, 'Sistem', 'Batas biaya workspace: ' + (n == null ? 'ikut config' : n ? '$' + n.toFixed(2) : 'tanpa batas') + '.'); }
      return send(res, 200, { ok: true });
    }
    if (act === 'rename') { const nama = String(b.nama || w.nama); const e = terlaluPanjang(nama, 'nama', 'Nama workspace'); if (e) return send(res, 400, { error: e }); w.nama = nama; changed(); return send(res, 200, { ok: true }); }
    if (act === 'hapus') { stopAll(w); S.ws = S.ws.filter(x => x !== w); changed(); return send(res, 200, { ok: true, catatan: 'Folder proyek tidak ikut dihapus.' }); }
    if (act === 'retry') { const t = w.tasks.find(x => x.id === b.task); if (t) { t.status = 'antre'; t.coba = 0; t.agent = null; if (w.status === 'done' || w.status === 'idle' || w.status === 'dihentikan') w.status = 'running'; changed(); } return send(res, 200, { ok: true }); }
    if (act === 'agen') {
      if (w.status === 'running' || w.status === 'planning') return send(res, 409, { error: 'Tunggu proyek selesai atau hentikan dulu' });
      const div = b.div; const list = w.agents.filter(a => a.div === div); if (!DIVS[div]) return send(res, 400, { error: 'Divisi tidak dikenal' });
      if (b.tambah && list.length < 4) { const i = list.length; w.agents.push({ id: div + i, nama: NAMES[div][i], div, slot: i, akun: w.agents.length % CFG.akun.length, state: 'idle', selesai: 0, chat: [] }); }
      if (!b.tambah && list.length > 1) { const a = list[list.length - 1]; w.agents = w.agents.filter(x => x !== a); }
      changed(); return send(res, 200, { ok: true });
    }
    if (act === 'chat') { const a = agentOf(w, b.agent); if (!a) return send(res, 404, { error: 'Agen tidak ditemukan' }); const pesan = String(b.pesan || ''); const e = terlaluPanjang(pesan, 'chat', 'Pesan chat'); if (e) return send(res, 400, { error: e }); chat(w, a, pesan); return send(res, 200, { ok: true }); }
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
  for (const x of cekKredensial()) {
    console.warn('PERINGATAN: akun ' + x.nama + ' kemungkinan belum login: ' + path.join(x.configDir, '.credentials.json') + ' tidak ada.');
    console.warn('  Login (PowerShell): $env:CLAUDE_CONFIG_DIR="' + x.configDir + '"; claude   lalu ketik /login\n');
  }
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
process.on('SIGINT', () => { for (const r of running.values()) if (r.child.exitCode === null) { try { if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else r.child.kill(); } catch (e) {} } fs.writeFileSync(STATE_PATH, JSON.stringify(S, null, 1)); process.exit(0); });

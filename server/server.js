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
const SELESAI_TUGAS = ['selesai', 'gagal', 'batas-langkah'];

function runClaude({ key, w, akun = 0, model, system, prompt, resume, alat, onEvent, maxTurns = 0 }) {
  // Gerbang batas biaya: dicek sebelum SETIAP panggilan baru. Pemanggil yang memutuskan jeda.
  if (lewatBatas(w)) return Promise.resolve({ text: '', session: resume || null, biaya: 0, token: 0, error: 'Batas biaya workspace tercapai', batas: true, rincian: rincianKosong() });
  return new Promise((resolve) => {
    const sysFile = path.join(os.tmpdir(), 'kantor-sys-' + uid() + '.txt');
    fs.writeFileSync(sysFile, system || '');
    // Alat. Staf: --tools MEMBATASI alat bawaan yang tersedia (--allowedTools hanya izin otomatis; di
    // acceptEdits Bash read-only seperti `ls` tetap jalan tanpa --tools). Tanpa alat (manajer/chat manajer):
    // perilaku lama, Edit/Write/Bash/NotebookEdit diblokir.
    // Opsi variadik dikirim sebagai SATU argumen dipisah koma dan selalu diikuti opsi lain (--output-format),
    // jadi tidak ada argumen berikutnya yang tertelan sebagai nama alat. Prompt dikirim lewat stdin.
    const daftarAlat = (alat || []).filter(Boolean).join(',');
    const argAlat = daftarAlat ? ['--tools', daftarAlat, '--allowedTools', daftarAlat, '--permission-mode', 'acceptEdits']
      : ['--disallowedTools', 'Edit,Write,Bash,NotebookEdit'];
    // MCP: agen tidak boleh punya alat MCP apa pun. --strict-mcp-config tanpa --mcp-config = server dari
    // .mcp.json, ~/.claude.json, dan plugin tidak dimuat (CLI reference). Konektor claude.ai tidak disebut
    // di sana; switch resminya ENABLE_CLAUDEAI_MCP_SERVERS=false (docs MCP, "Disable claude.ai connectors").
    const args = ['-p', ...argAlat, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--model', model, '--append-system-prompt-file', sysFile];
    if (maxTurns > 0) args.push('--max-turns', String(maxTurns));
    if (resume) args.push('--resume', resume);
    const env = Object.assign({}, process.env, { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    const ak = CFG.akun[akun % CFG.akun.length] || {};
    if (ak.configDir) env.CLAUDE_CONFIG_DIR = ak.configDir;
    const win = process.platform === 'win32';
    const child = spawn(win ? CFG.perintahClaude : CFG.perintahClaude, win ? args.map(q) : args, { cwd: w.folder, env, shell: win, windowsHide: true });
    running.set(key, { child, akun });
    let buf = '', out = { text: '', session: resume || null, biaya: 0, token: 0, error: null, rincian: null, teksTerakhir: '' };
    const usagePesan = new Map(); // message.id -> usage; cadangan kalau sesi dihentikan sebelum ada pesan result
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
          const [, aid, ekstra] = key.split(':'); const ag = agentOf(w, aid);
          log(w, (ag ? ag.nama : 'Sistem') + (ekstra === 'chat' ? ' (chat)' : ''), 'Alat tersedia (' + alatAda.length + '): ' + (alatAda.join(', ') || '-') + ' · MCP: ' + (mcp.length ? mcp.join(', ') : 'tidak ada'));
        }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          if (ev.message.usage) usagePesan.set(ev.message.id || ('m' + usagePesan.size), ev.message.usage);
          for (const b of ev.message.content) {
            if (b.type === 'tool_use') onEvent && onEvent({ alat: b.name, file: b.input && (b.input.file_path || b.input.pattern || b.input.path) });
            if (b.type === 'text' && b.text) { out.teksTerakhir = b.text; onEvent && onEvent({ teks: b.text }); }
          }
        }
        if (ev.type === 'result') {
          out.text = ev.result || ''; out.biaya = ev.total_cost_usd || 0;
          out.rincian = dariUsage(ev.usage || {}, out.biaya);
          if (ev.session_id) out.session = ev.session_id;
          if (ev.subtype === 'error_max_turns') { out.maxTurns = true; out.error = 'Batas langkah (--max-turns ' + maxTurns + ') tercapai'; }
          else if (ev.is_error) out.error = out.text || ev.subtype || 'error';
        }
      }
    });
    let errBuf = '';
    child.stderr.on('data', d => { errBuf += d; });
    child.on('error', e => { out.error = 'Tidak bisa menjalankan "' + CFG.perintahClaude + '": ' + e.message; });
    child.on('close', code => {
      running.delete(key); fs.unlink(sysFile, () => {});
      if (!out.error && code !== 0 && !out.text) out.error = (errBuf.trim().split('\n').pop() || ('keluar dengan kode ' + code));
      if (out.error && !out.maxTurns && /limit|quota|usage/i.test(out.error)) out.limit = true;
      if (!out.rincian) { // tanpa result (mis. dihentikan): pakai usage per pesan yang sudah terbaca; biaya tidak diketahui
        out.rincian = rincianKosong(); out.rincian.sesi = 1; out.rincian.sebagian = true;
        for (const u of usagePesan.values()) tambahRincian(out.rincian, Object.assign(dariUsage(u, 0), { sesi: 0 }));
      }
      const r = out.rincian; out.token = r.inp + r.out + r.cw + r.cr;
      w.biaya = (w.biaya || 0) + out.biaya; w.token = (w.token || 0) + out.token;
      w.rincian = tambahRincian(w.rincian || rincianKosong(), r);
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}
function stopAll(w) { for (const [k, r] of running) if (k.startsWith(w.id + ':')) bunuh(r.child); }
const mt = (peran) => { const v = (CFG.maxTurns || {})[peran]; return v > 0 ? +v : 0; };

/* ---------------- Alur kerja ---------------- */
// Perkiraan kasar token untuk Usulan mode Tim, TANPA memanggil Claude.
// Sumber: data patokan 20-11 (brief kecil, 6 sesi = 477k): lantai biaya per sesi Claude Code
// ≈ 20–30k + baca ulang konteks per request. Ubah angkanya di sini saja.
const PERKIRAAN = { perTugasStaf: 100000, laporanManajer: 60000 };
const perkiraanToken = (nTugas) => nTugas * PERKIRAAN.perTugasStaf + PERKIRAAN.laporanManajer;
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
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, maxTurns: mt('manajer'), system: SYS_MGR + '\n\nMemori:\n' + memori(m),
    prompt: 'Brief dari bos: ' + w.goal + '\nNama proyek: ' + w.nama + '\nTim: ' + tim + '\nFolder kerja saat ini bisa kamu baca bila perlu.\n\n' +
      'Pecah brief menjadi 1 sampai 9 tugas konkret. Tiap tugas dikerjakan satu orang dan menghasilkan file di folder proyek. ' +
      'Aturan: jangan membuat tugas panduan, format, draf, atau review kecuali brief memintanya. Boleh hanya 1 tugas. ' +
      'Pecah hanya kalau bagian-bagiannya memang bisa dikerjakan terpisah; tiap tugas tambahan menambah biaya. ' +
      'Balas HANYA dengan JSON valid tanpa teks lain, berbentuk: {"ringkasan":"...","tugas":[{"divisi":"backend|frontend|design","judul":"...","detail":"...","setelah":[indeks tugas lain yang harus selesai dulu]}]}',
    onEvent: ev => { if (ev.alat) { m.aktivitas = 'membaca ' + path.basename(String(ev.file || '')); changed(); } } });
  m.state = 'idle'; m.aktivitas = '';
  if (r.batas) { jedaBiaya(w, 'plan'); return; }
  if (w.status === 'dihentikan') return; // dihentikan lewat rem darurat saat menyusun rencana
  if (r.error) { w.status = 'idle'; log(w, 'Sistem', 'Manajer gagal menyusun rencana: ' + r.error); return; }
  let j; try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch (e) { w.status = 'idle'; log(w, 'Sistem', 'Rencana manajer bukan JSON yang valid. Coba kirim brief lagi.'); return; }
  const ids = j.tugas.map(() => uid());
  w.tasks = j.tugas.map((t, i) => ({ id: ids[i], div: DIVS[t.divisi] ? t.divisi : 'frontend', title: t.judul, detail: t.detail, status: 'antre', agent: null, progress: 0, after: (t.setelah || []).map(k => ids[k]).filter(Boolean), revisi: 0, coba: 0, output: '', file: [] }));
  w.ringkasan = j.ringkasan || '';
  // Tim: rencana jadi Usulan dulu. Staf baru jalan setelah user menekan Jalankan.
  w.usulan = { tugas: w.tasks.length, perkiraanToken: perkiraanToken(w.tasks.length), rumus: PERKIRAAN };
  w.status = 'usulan';
  log(w, 'Arya', 'Usulan siap: ' + w.tasks.length + ' tugas, perkiraan kasar ±' + Math.round(w.usulan.perkiraanToken / 1000) + 'k token. Tekan Jalankan untuk mulai. ' + w.ringkasan);
}
function depsOk(w, t) { return t.after.every(id => { const x = w.tasks.find(y => y.id === id); return !x || SELESAI_TUGAS.includes(x.status); }); }
async function work(w, a, t) {
  if (lewatBatas(w)) { jedaBiaya(w, 'jadwal'); return; }
  t.status = 'kerja'; t.agent = a.id; t.progress = 0.03; a.state = 'kerja'; a.task = t.id; a.aktivitas = 'membaca tugas';
  log(w, a.nama, (t.revisi ? 'Merevisi' : 'Mulai mengerjakan') + ' "' + t.title + '".');
  const deps = t.after.map(id => w.tasks.find(x => x.id === id)).filter(Boolean).map(x => '- ' + x.title + ' (oleh ' + ((agentOf(w, x.agent) || {}).nama || '-') + '): ' + (x.output || '').slice(0, 1500) + (x.file.length ? '\n  File: ' + x.file.join(', ') : '')).join('\n');
  let langkah = 0;
  const r = await runClaude({ key: w.id + ':' + a.id, w, akun: a.akun, model: CFG.model.staf, alat: CFG.alatStaf, maxTurns: mt('staf'),
    system: t.solo
      ? 'Kamu ' + a.nama + ' di Kantor Agen. Kerjakan brief ini sendirian, langsung di folder proyek ini dengan membuat atau mengubah file. Kerjakan secukupnya sesuai brief, tanpa file panduan/draf tambahan. ' +
        'Di akhir, tulis laporan singkat (maks 150 kata) dalam bahasa Indonesia kasual untuk pemilik proyek, sapa dengan "kamu": apa yang sudah jadi dan langkah berikutnya kalau ada. Sebut setiap file hasil dalam backtick, misalnya `catatan.md`.\n\nMemori:\n' + memori(a)
      : 'Kamu ' + a.nama + ', anggota divisi ' + DIVS[a.div] + ' di Kantor Agen. Kerjakan tugasmu langsung di folder proyek ini dengan membuat atau mengubah file. Jangan mengerjakan tugas divisi lain. Di akhir, tulis ringkasan singkat (maks 120 kata) tentang apa yang kamu buat dan file mana saja.\n\nMemori:\n' + memori(a),
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
  if (t.status === 'dihentikan') { // rem darurat: proses sudah dibunuh, simpan apa yang sempat terbaca
    t.output = r.text || r.teksTerakhir || t.output || ''; lepas(); log(w, a.nama, 'Dihentikan saat mengerjakan "' + t.title + '".'); return;
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
      : t.status === 'batas-langkah' ? 'Berhenti: batas langkah tercapai. Tekan Coba lagi di tugasnya untuk mengulang.' + (t.output ? '\n\nOutput terakhir:\n' + t.output : '')
      : 'Tugas Solo gagal. Lihat Aktivitas untuk pesan error, lalu tekan Coba lagi di tugasnya.';
    w.status = 'done'; log(w, 'Sistem', 'Solo selesai. Laporan akhir siap dibaca.'); return;
  }
  w.status = 'final'; const m = agentOf(w, 'mgr'); m.state = 'rangkum'; m.aktivitas = 'menulis laporan';
  log(w, 'Arya', 'Semua tugas masuk. Menyusun laporan akhir.');
  const r = await runClaude({ key: w.id + ':mgr', w, akun: 0, model: CFG.model.manajer, maxTurns: mt('manajer'), system: SYS_MGR,
    prompt: 'Brief: ' + w.goal + '\n\nHasil tim:\n' + w.tasks.map(t => '- [' + t.div + '] ' + t.title + ' (' + t.status + '): ' + (t.output || '').slice(0, 800) + (t.file.length ? ' File: ' + t.file.join(', ') : '')).join('\n') +
      '\n\nTulis laporan akhir untuk pemilik proyek (maks 250 kata), sapa dengan "kamu": apa yang sudah jadi, file mana yang perlu dibuka (tulis nama file dalam backtick), dan langkah berikutnya. Boleh baca file di folder ini untuk mengecek.' });
  m.state = 'idle'; m.aktivitas = '';
  if (r.batas) { jedaBiaya(w, 'final'); return; }
  if (w.status === 'dihentikan') return; // rem darurat saat menulis laporan; Lanjutkan akan memanggil final lagi
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
function snapshot() { return JSON.stringify({ ws: S.ws, info: { akun: CFG.akun.map(a => a.nama), aktif: akunAktif(), maxAgenPerAkun: CFG.maxAgenPerAkun, model: CFG.model, folderData: CFG.folderData, folderProyek: CFG.folderProyek, batasBiaya: CFG.batasBiaya, maxTurns: CFG.maxTurns } }); }
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
const TIPE = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'text/plain; charset=utf-8',
  '.js': 'text/plain; charset=utf-8', '.mjs': 'text/plain; charset=utf-8', '.css': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf',
};
const HDR_HASIL = { 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
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
function sajikanHasil(req, res) {
  const m = req.url.split('?')[0].match(/^\/hasil\/([^/]+)\/(.+)$/);
  if (!m) return tolakHasil(res, 404, 'Tidak ada');
  const w = S.ws.find(x => x.id === m[1]); if (!w || !w.folder) return tolakHasil(res, 404, 'Workspace tidak ditemukan');
  let rel; try { rel = decodeURIComponent(m[2]); } catch (e) { return tolakHasil(res, 400, 'Path tidak valid'); }
  const full = dalamFolder(w.folder, rel);
  if (full === null) return tolakHasil(res, 403, 'Ditolak: path di luar folder workspace');
  let st; try { st = full && fs.statSync(full); } catch (e) {}
  if (!st || !st.isFile()) return tolakHasil(res, 404, 'File tidak ditemukan');
  res.writeHead(200, Object.assign({ 'content-type': TIPE[path.extname(full).toLowerCase()] || 'application/octet-stream', 'content-length': st.size }, HDR_HASIL));
  fs.createReadStream(full).pipe(res);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(WEB).pipe(res); }
    if (req.method === 'GET' && u.pathname === '/dashboard.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(DASBOR).pipe(res); }
    const pinOk = (req.headers['x-pin'] || u.searchParams.get('pin')) === CFG.pin;
    // Dicek dari URL mentah: parser URL melipat "../" dan "%2e%2e" sebelum sampai sini.
    if (/^\/hasil(\/|\?|$)/.test(req.url)) { if (req.method !== 'GET') return tolakHasil(res, 405, 'Pakai GET'); if (!pinOk) return tolakHasil(res, 401, 'PIN salah'); return sajikanHasil(req, res); }
    if (p[0] !== 'api') { res.writeHead(404); return res.end('Tidak ada'); }
    if (!pinOk) return send(res, 401, { error: 'PIN salah' });
    if (p[1] === 'state') return send(res, 200, JSON.parse(snapshot()));
    if (req.method === 'GET' && p[1] === 'usage') return send(res, 200, await usage.ringkasan(CFG));
    if (req.method === 'GET' && p[1] === 'projects') return send(res, 200, usage.proyek(CFG));
    if (p[1] === 'events') { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }); res.write('data: ' + snapshot() + '\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (req.method === 'GET' && p[1] === 'ws' && p[3] === 'files' && !p[4]) {
      const w = S.ws.find(x => x.id === p[2]); if (!w) return send(res, 404, { error: 'Workspace tidak ditemukan' });
      if (!w.folder || !fs.existsSync(w.folder) || !fs.statSync(w.folder).isDirectory()) return send(res, 404, { error: 'Folder tidak ditemukan: ' + (w.folder || '(kosong)'), folder: w.folder || '', ada: false });
      return send(res, 200, { folder: w.folder, ada: true, files: daftarHasil(w.folder) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Pakai POST' });
    const b = await body(req);
    if (p[1] === 'ws' && !p[2]) { const w = newWs(String(b.nama || 'Proyek ' + (S.ws.length + 1)).slice(0, 60)); return send(res, 200, { id: w.id }); }
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
      w.goal = String(b.goal || '').slice(0, 2000); w.tasks = []; w.laporan = ''; w.ringkasan = ''; w.usulan = null;
      w.mode = b.mode === 'tim' ? 'tim' : 'solo'; // default Solo
      if (b.batas != null && b.batas !== '') { const n = +b.batas; if (Number.isFinite(n) && n >= 0) w.batas = n; } // kosong = batas lama/config tetap
      if (w.mode === 'solo') { mulaiSolo(w); return send(res, 200, { ok: true, mode: w.mode }); }
      w.status = 'planning';
      log(w, 'Arya', 'Menerima brief (mode Tim): "' + w.goal + '". Menyusun usulan rencana.'); plan(w).then(changed); return send(res, 200, { ok: true, mode: w.mode });
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
    if (act === 'rename') { w.nama = String(b.nama || w.nama).slice(0, 60); changed(); return send(res, 200, { ok: true }); }
    if (act === 'hapus') { stopAll(w); S.ws = S.ws.filter(x => x !== w); changed(); return send(res, 200, { ok: true, catatan: 'Folder proyek tidak ikut dihapus.' }); }
    if (act === 'retry') { const t = w.tasks.find(x => x.id === b.task); if (t) { t.status = 'antre'; t.coba = 0; t.agent = null; if (w.status === 'done' || w.status === 'idle' || w.status === 'dihentikan') w.status = 'running'; changed(); } return send(res, 200, { ok: true }); }
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
process.on('SIGINT', () => { for (const r of running.values()) if (r.child.exitCode === null) { try { if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/PID', String(r.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else r.child.kill(); } catch (e) {} } fs.writeFileSync(STATE_PATH, JSON.stringify(S, null, 1)); process.exit(0); });

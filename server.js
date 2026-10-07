'use strict';
// Agent Deck — cockpit web : projets à gauche, 4 Claude Code par projet au centre, fichiers à droite.
// Les agents tournent dans des sessions tmux (socket dédié) : ils survivent aux rechargements et aux redémarrages du serveur.

const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const HOME = os.homedir();
const PORT = Number(process.env.PORT) || 7700;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA, 'config.json');
const TOKEN_FILE = path.join(DATA, 'token');
const TMUX_SOCK = 'agentdeck';
const TMUX_CONF = path.join(__dirname, 'tmux.conf');
const SLOTS = 4;
const IGNORE = new Set(['.git', '.agentdeck', 'node_modules', '.next', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', '.cache', '.turbo', 'coverage', '.pnpm-store']);
const PROJECT_MARKERS = ['.git', 'CLAUDE.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'foundry.toml'];
const MAX_FILE = 5 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });

// ---------- config & auth ----------
const DEFAULT_CONFIG = {
  roots: [HOME, path.join(HOME, 'projects')],
  extra: [],
  hidden: [],
  staleDays: 30, // au-delà, le projet passe dans « Anciens » (replié)
  // À l'ouverture d'un projet sans agent : reprend les conversations des N derniers jours (sinon la dernière)
  autoResume: { enabled: true, days: 3, max: 4 },
  parked: [],    // projets envoyés « Au repos », tout en bas
  commands: [
    { key: 'claude', label: 'Claude', cmd: 'claude --append-system-prompt-file ~/agentdeck/agent-prompt.md' },
    { key: 'continue', label: 'Reprendre', cmd: 'claude --continue --append-system-prompt-file ~/agentdeck/agent-prompt.md' },
    { key: 'yolo', label: 'Sans permissions', cmd: 'claude --dangerously-skip-permissions --append-system-prompt-file ~/agentdeck/agent-prompt.md' },
    { key: 'shell', label: 'Shell', cmd: '' },
  ],
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2)); return { ...DEFAULT_CONFIG }; }
}
let config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

let TOKEN;
try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
catch { TOKEN = crypto.randomBytes(24).toString('base64url'); fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); }

const safeEq = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isAuthed = (cookies) => safeEq(cookies && cookies.ad_token, TOKEN);

// ---------- projets ----------
const projId = (p) => crypto.createHash('sha1').update(p).digest('hex').slice(0, 10);
const sessionName = (id, slot) => `ad_${id}_${slot}`;

let projectCache = { at: 0, list: [] };
async function discoverProjects(force) {
  if (!force && Date.now() - projectCache.at < 10000) return projectCache.list;
  const found = new Map();
  const add = (p) => { const abs = path.resolve(p); if (!config.hidden.includes(abs)) found.set(projId(abs), abs); };
  for (const root of config.roots) {
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      if (config.roots.includes(dir)) continue;
      for (const m of PROJECT_MARKERS) {
        if (fs.existsSync(path.join(dir, m))) { add(dir); break; }
      }
    }
  }
  for (const p of config.extra) if (fs.existsSync(p)) add(p);
  const list = await Promise.all([...found].map(async ([id, p]) => ({ id, path: p, name: path.basename(p), parked: config.parked.includes(p), lastActivity: await lastActivity(p) })));
  list.sort((a, b) => b.lastActivity - a.lastActivity);
  projectCache = { at: Date.now(), list };
  return list;
}

// Dernière activité de dev d'un projet : dernier commit, fichiers modifiés/nouveaux non ignorés par git, dernière session Claude.
// Les fichiers gitignorés (data, logs, db écrits par les bots en prod) ne comptent pas.
const activityCache = new Map();
const NOISE = /(^|\/)(logs?|data|tmp)(\/|$)|\.(log|db|sqlite|db-wal|db-shm|jsonl|pid)$/;
async function lastActivity(root) {
  const c = activityCache.get(root);
  if (c && Date.now() - c.at < 120000) return c.ts;
  let ts = 0;
  const bump = async (abs) => { try { ts = Math.max(ts, (await fsp.stat(abs)).mtimeMs); } catch {} };
  let changed = null;
  try {
    ts = Number((await run('git', ['log', '-1', '--format=%ct'], { cwd: root })).trim()) * 1000 || 0;
    changed = (await run('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], { cwd: root })).split('\0').filter(Boolean);
  } catch {}
  if (changed) {
    for (const f of changed.filter((f) => !NOISE.test(f)).slice(0, 3000)) await bump(path.join(root, f));
  } else {
    let budget = 4000; // pas de git : on parcourt l'arbre
    const walk = async (dir, rel, depth) => {
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (budget-- <= 0) return;
        const r = rel ? rel + '/' + e.name : e.name;
        if (IGNORE.has(e.name) || NOISE.test(r)) continue;
        if (e.isDirectory()) { if (depth < 6) await walk(path.join(dir, e.name), r, depth + 1); }
        else if (e.isFile()) await bump(path.join(dir, e.name));
      }
    };
    await walk(root, '', 0);
  }
  await bump(path.join(HOME, '.claude/projects', root.replace(/[^A-Za-z0-9]/g, '-')));
  activityCache.set(root, { at: Date.now(), ts });
  return ts;
}
async function getProject(id) {
  let p = (await discoverProjects()).find((x) => x.id === id);
  if (!p) p = (await discoverProjects(true)).find((x) => x.id === id);
  return p;
}

// Résout un chemin relatif dans le projet en refusant toute sortie de la racine
function resolveIn(root, rel = '') {
  const abs = path.resolve(root, '.' + path.sep + rel);
  const r = path.relative(root, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw Object.assign(new Error('chemin hors projet'), { status: 400 });
  return abs;
}

// ---------- tmux ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve(stdout);
    });
  });
}
const tmux = (...args) => run('tmux', ['-L', TMUX_SOCK, '-f', TMUX_CONF, ...args]);

async function listSessions() {
  try {
    const out = await tmux('list-sessions', '-F', '#{session_name}\t#{session_activity}\t#{session_attached}\t#{pane_current_command}');
    const map = {};
    for (const line of out.trim().split('\n')) {
      const [name, activity, attached, command] = line.split('\t');
      if (name) map[name] = { activity: Number(activity) * 1000, attached: Number(attached), command };
    }
    return map;
  } catch { return {}; } // pas de serveur tmux = aucune session
}

async function hasSession(name) {
  try { await tmux('has-session', '-t', '=' + name); return true; } catch { return false; }
}

// ---------- git & fichiers ----------
async function gitStatus(root) {
  try {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: root })).trim();
    const out = await run('git', ['status', '--porcelain=v1', '-z', '.'], { cwd: root });
    const res = {};
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++; // ignore l'ancien nom
      const rel = path.relative(root, path.join(top, file));
      if (!rel.startsWith('..')) res[rel.replace(/\/$/, '')] = code.trim() || code;
    }
    return { repo: true, files: res };
  } catch { return { repo: false, files: {} }; }
}

const fileListCache = new Map();
async function listAllFiles(root) {
  const c = fileListCache.get(root);
  if (c && Date.now() - c.at < 20000) return c.files;
  const files = [];
  async function walk(dir, rel) {
    if (files.length > 30000) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile() || e.isSymbolicLink()) files.push(r);
    }
  }
  await walk(root, '');
  fileListCache.set(root, { at: Date.now(), files });
  return files;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf' };

// ---------- emplacements persistants ----------
// data/slots.json garde, pour chaque emplacement, le projet, le type de lancement et l'ID de conversation Claude.
// Le hook SessionStart de Claude (hooks/session-start.sh) écrit data/sessions/<emplacement> à chaque nouvelle
// conversation (/clear, /resume…), pour qu'on reprenne toujours la bonne.
const SLOTS_FILE = path.join(DATA, 'slots.json');
const SESS_DIR = path.join(DATA, 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });
let slotsState = {};
try { slotsState = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8')); } catch {}
const saveSlots = () => fs.writeFileSync(SLOTS_FILE, JSON.stringify(slotsState, null, 2));
const writeSessionFile = (name, sid) => fs.writeFileSync(path.join(SESS_DIR, name), sid);
function currentSessionId(name, rec) {
  try { const v = fs.readFileSync(path.join(SESS_DIR, name), 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(v)) return v; } catch {}
  return rec && rec.sessionId;
}
const commandOf = (key) => (config.commands.find((x) => x.key === key) || config.commands[0]).cmd;
const baseCmd = (key) => commandOf(key).replace(/\s--continue\b/, '');
// --resume échoue si la conversation n'a jamais reçu de message (pas de transcript) : on la recrée avec le même ID
const hasTranscript = (project, sid) => fs.existsSync(path.join(HOME, '.claude/projects', project.replace(/[^A-Za-z0-9]/g, '-'), sid + '.jsonl'));
// État de la reprise auto : conversations fermées à la main, projets où tout a été arrêté volontairement
const AUTO_FILE = path.join(DATA, 'autoresume.json');
let autoState = { dismissed: [], suppressed: [] };
try { autoState = { ...autoState, ...JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8')) }; } catch {}
const saveAuto = () => fs.writeFileSync(AUTO_FILE, JSON.stringify(autoState, null, 2));

async function readSlice(file, fromEnd, len) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const n = Math.min(size, len);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, fromEnd ? size - n : 0);
    return { text: buf.toString('utf8'), size };
  } finally { await fh.close(); }
}

// Conversations interactives (pas les `claude -p` des scripts) d'un projet, de la plus récente à la plus ancienne.
// La date vient du dernier message (les fichiers migrés ont tous la date de la migration).
async function resumableConversations(project) {
  const dir = path.join(HOME, '.claude/projects', project.replace(/[^A-Za-z0-9]/g, '-'));
  let files = [];
  try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const live = new Set(Object.entries(slotsState).filter(([, r]) => !r.stopped).map(([n, r]) => currentSessionId(n, r)));
  const out = [];
  for (const f of files) {
    const sid = f.slice(0, -6);
    if (autoState.dismissed.includes(sid) || live.has(sid)) continue;
    const fp = path.join(dir, f);
    try {
      const head = (await readSlice(fp, false, 256 * 1024)).text;
      if (!/"entrypoint":"cli"/.test(head) || !/"type":"user"/.test(head)) continue;
      const tail = (await readSlice(fp, true, 256 * 1024)).text;
      const stamps = [...tail.matchAll(/"timestamp":"([^"]+)"/g)];
      const t = stamps.length ? Date.parse(stamps[stamps.length - 1][1]) : 0;
      out.push({ sid, t });
    } catch {}
  }
  return out.sort((a, b) => b.t - a.t);
}

const resumeCmd = (key, sid, project) => `${baseCmd(key === 'continue' ? 'claude' : key)} ${hasTranscript(project, sid) ? '--resume' : '--session-id'} ${sid}`;

async function spawnSlot(name, cwd, cmd, size = {}) {
  const cols = Math.max(20, Math.min(500, Number(size.cols) || 160));
  const rows = Math.max(5, Math.min(200, Number(size.rows) || 40));
  await tmux('new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), '-e', 'AGENTDECK_SESSION=' + name, 'bash', '-l');
  if (cmd) await tmux('send-keys', '-t', '=' + name + ':', cmd, 'Enter');
}

// Au démarrage (ex. après un reboot du VPS) : relance chaque emplacement qui tournait et reprend sa conversation
async function restoreSlots() {
  const live = await listSessions();
  for (const [name, rec] of Object.entries(live)) {
    // sessions lancées avant cette fonctionnalité : on les adopte
    const m = /^ad_([0-9a-f]{10})_(\d)$/.exec(name);
    if (!m || slotsState[name]) continue;
    const p = (await discoverProjects(true)).find((x) => x.id === m[1]);
    if (p) slotsState[name] = { project: p.path, slot: Number(m[2]), cmdKey: rec.command === 'claude' ? 'continue' : 'shell', sessionId: null, stopped: false };
  }
  for (const [name, rec] of Object.entries(slotsState)) {
    if (rec.stopped || live[name] || !fs.existsSync(rec.project)) continue;
    const sid = currentSessionId(name, rec);
    let cmd = commandOf(rec.cmdKey);
    if (/^claude\b/.test(cmd) && sid) cmd = resumeCmd(rec.cmdKey, sid, rec.project);
    try { await spawnSlot(name, rec.project, cmd); console.log('restauré', name, sid || ''); } catch (e) { console.error('restauration', name, e.message); }
  }
  saveSlots();
}

// Une session qui disparaît pendant que le serveur tourne a été quittée volontairement (exit) : pas de reprise auto
async function watchSlots() {
  const live = await listSessions();
  let changed = false;
  for (const [name, rec] of Object.entries(slotsState)) {
    if (!rec.stopped && !live[name]) { rec.stopped = true; changed = true; }
  }
  if (changed) saveSlots();
}

// ---------- HTTP ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

app.post('/api/login', (req, res) => {
  if (!safeEq(req.body && req.body.token, TOKEN)) return res.status(401).json({ error: 'token invalide' });
  res.cookie('ad_token', TOKEN, { httpOnly: true, sameSite: 'strict', maxAge: 1000 * 3600 * 24 * 90 });
  res.json({ ok: true });
});

// ?token=... dans l'URL connecte directement
app.get('/', (req, res, next) => {
  if (req.query.token && safeEq(req.query.token, TOKEN)) {
    res.cookie('ad_token', TOKEN, { httpOnly: true, sameSite: 'strict', maxAge: 1000 * 3600 * 24 * 90 });
    return res.redirect('/');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') })); // toujours revalider après un déploiement
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/vendor/xterm-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));
app.use('/vendor/xterm-clipboard', express.static(path.join(__dirname, 'node_modules/@xterm/addon-clipboard')));
app.use('/vendor/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor')));

app.use('/api', (req, res, next) => (isAuthed(req.cookies) ? next() : res.status(401).json({ error: 'non authentifié' })));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(e.status || 500).json({ error: e.message }));
const withProject = (fn) => wrap(async (req, res) => {
  const p = await getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'projet inconnu' });
  return fn(req, res, p);
});

app.get('/api/config', (req, res) => res.json({ host: os.hostname(), slots: SLOTS, staleDays: config.staleDays, commands: config.commands.map(({ key, label }) => ({ key, label })) }));

app.get('/api/projects', wrap(async (req, res) => res.json(await discoverProjects(req.query.refresh === '1'))));

app.post('/api/projects', wrap(async (req, res) => {
  let p = String((req.body && req.body.path) || '').trim();
  if (p.startsWith('~')) p = path.join(HOME, p.slice(1));
  p = path.resolve(p);
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) return res.status(400).json({ error: 'dossier introuvable' });
  config.hidden = config.hidden.filter((h) => h !== p);
  if (!config.extra.includes(p)) config.extra.push(p);
  saveConfig();
  await discoverProjects(true);
  res.json({ id: projId(p), path: p, name: path.basename(p) });
}));

app.post('/api/projects/:id/park', withProject(async (req, res, p) => {
  config.parked = config.parked.filter((x) => x !== p.path);
  if (req.body && req.body.parked) config.parked.push(p.path);
  saveConfig();
  await discoverProjects(true);
  res.json({ ok: true });
}));

app.delete('/api/projects/:id', withProject(async (req, res, p) => {
  config.extra = config.extra.filter((e) => e !== p.path);
  if (!config.hidden.includes(p.path)) config.hidden.push(p.path);
  saveConfig();
  await discoverProjects(true);
  res.json({ ok: true });
}));

// État de toutes les sessions, pour les pastilles d'activité
app.get('/api/status', wrap(async (req, res) => {
  const sessions = await listSessions();
  const out = {};
  for (const [name, s] of Object.entries(sessions)) {
    const m = /^ad_([0-9a-f]{10})_(\d)$/.exec(name);
    if (!m) continue;
    (out[m[1]] ||= {})[m[2]] = s;
  }
  const resumable = {};
  for (const [name, rec] of Object.entries(slotsState)) {
    const m = /^ad_([0-9a-f]{10})_(\d)$/.exec(name);
    if (m && !sessions[name] && currentSessionId(name, rec)) (resumable[m[1]] ||= {})[m[2]] = true;
  }
  res.json({ now: Date.now(), sessions: out, resumable });
}));

app.post('/api/projects/:id/slots/:slot/start', withProject(async (req, res, p) => {
  const slot = Number(req.params.slot);
  if (!(slot >= 0 && slot < SLOTS)) return res.status(400).json({ error: 'slot invalide' });
  const name = sessionName(p.id, slot);
  if (await hasSession(name)) return res.json({ ok: true, existing: true });
  let key = (req.body && req.body.cmd) || config.commands[0].key;
  const rec = slotsState[name];
  const prevSid = rec && currentSessionId(name, rec);
  let cmd, sid = null;
  if (key === 'continue' && prevSid) {
    // « Reprendre » : rouvre la conversation de CET emplacement, avec les mêmes options qu'avant
    key = rec.cmdKey === 'continue' ? 'claude' : rec.cmdKey;
    sid = prevSid;
    cmd = resumeCmd(key, sid, p.path);
  } else {
    cmd = commandOf(key);
    if (key !== 'continue' && /^claude\b/.test(cmd)) { sid = crypto.randomUUID(); cmd += ` --session-id ${sid}`; }
  }
  await spawnSlot(name, p.path, cmd, req.body);
  if (autoState.suppressed.includes(p.path)) { autoState.suppressed = autoState.suppressed.filter((x) => x !== p.path); saveAuto(); }
  slotsState[name] ={ project: p.path, slot, cmdKey: key, sessionId: sid, stopped: false, startedAt: Date.now() };
  if (sid) writeSessionFile(name, sid);
  saveSlots();
  res.json({ ok: true });
}));

app.post('/api/projects/:id/slots/:slot/stop', withProject(async (req, res, p) => {
  const name = sessionName(p.id, Number(req.params.slot));
  const rec = slotsState[name];
  if (rec) { rec.stopped = true; saveSlots(); } // arrêt voulu : pas de reprise auto
  try { await tmux('kill-session', '-t', '=' + name); } catch {}
  // Conversation fermée à la main : on ne la relancera plus à l'ouverture du projet.
  // Et si plus rien ne tourne dans le projet, on n'y relance plus rien tant que tu n'y démarres pas un agent toi-même.
  const sid = rec && currentSessionId(name, rec);
  if (sid) autoState.dismissed = [...new Set([...autoState.dismissed, sid])].slice(-500);
  const live = await listSessions();
  if (!Array.from({ length: SLOTS }, (_, i) => sessionName(p.id, i)).some((n) => live[n])) autoState.suppressed = [...new Set([...autoState.suppressed, p.path])];
  saveAuto();
  res.json({ ok: true });
}));

// Ouverture d'un projet sans agent lancé : reprend ses conversations Claude récentes, une par emplacement
const inflight = new Set();
app.post('/api/projects/:id/autoresume', withProject(async (req, res, p) => {
  const ar = config.autoResume;
  if (!ar.enabled || autoState.suppressed.includes(p.path) || inflight.has(p.id)) return res.json({ started: [] });
  inflight.add(p.id);
  try {
    const live = await listSessions();
    const names = Array.from({ length: SLOTS }, (_, i) => sessionName(p.id, i));
    if (names.some((n) => live[n])) return res.json({ started: [] });
    const cands = await resumableConversations(p.path);
    const recent = cands.filter((c) => Date.now() - c.t < ar.days * 86400000);
    const pick = (recent.length ? recent : cands.slice(0, 1)).slice(0, Math.min(ar.max, SLOTS));
    const started = [];
    for (let i = 0; i < pick.length; i++) {
      await spawnSlot(names[i], p.path, resumeCmd('claude', pick[i].sid, p.path), req.body || {});
      slotsState[names[i]] = { project: p.path, slot: i, cmdKey: 'claude', sessionId: pick[i].sid, stopped: false, startedAt: Date.now() };
      writeSessionFile(names[i], pick[i].sid);
      started.push(i);
    }
    saveSlots();
    res.json({ started });
  } finally { inflight.delete(p.id); }
}));

app.get('/api/projects/:id/tree', withProject(async (req, res, p) => {
  const dir = resolveIn(p.path, req.query.dir || '');
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '.git') continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory(); } catch {} }
    out.push({ name: e.name, dir: isDir });
  }
  out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
  res.json(out);
}));

app.get('/api/projects/:id/git', withProject(async (req, res, p) => res.json(await gitStatus(p.path))));

app.get('/api/projects/:id/files', withProject(async (req, res, p) => res.json(await listAllFiles(p.path))));

app.get('/api/projects/:id/stat', withProject(async (req, res, p) => {
  const st = await fsp.stat(resolveIn(p.path, req.query.path)).catch(() => null);
  res.json(st ? { exists: true, mtime: st.mtimeMs, size: st.size } : { exists: false });
}));

// Image collée dans un terminal : Claude Code lit le presse-papiers de la machine où il tourne (ce VPS, sans
// presse-papiers), donc le navigateur envoie l'image ici ; on la range dans le projet et le client tape son chemin.
const PASTE_DIR = '.agentdeck/pastes';
const PASTE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.post('/api/projects/:id/paste', express.raw({ type: Object.keys(PASTE_EXT), limit: '20mb' }), withProject(async (req, res, p) => {
  const ext = PASTE_EXT[(req.headers['content-type'] || '').split(';')[0]];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'image attendue (png, jpeg, gif, webp)' });
  const dir = path.join(p.path, PASTE_DIR);
  await fsp.mkdir(dir, { recursive: true });
  // Exclusion git locale (jamais commitée) pour ne pas polluer le statut du projet
  const exclude = path.join(p.path, '.git/info/exclude');
  if (fs.existsSync(path.dirname(exclude))) {
    const cur = fs.existsSync(exclude) ? await fsp.readFile(exclude, 'utf8') : '';
    if (!cur.split('\n').includes('.agentdeck/')) await fsp.appendFile(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + '.agentdeck/\n');
  }
  // Ménage : on garde une semaine d'images
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    const st = await fsp.stat(path.join(dir, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > 7 * 86400e3) await fsp.unlink(path.join(dir, f)).catch(() => {});
  }
  const name = `paste-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}-${crypto.randomBytes(2).toString('hex')}.${ext}`;
  await fsp.writeFile(path.join(dir, name), req.body);
  res.json({ path: `${PASTE_DIR}/${name}`, size: req.body.length });
}));

app.get('/api/projects/:id/file', withProject(async (req, res, p) => {
  const abs = resolveIn(p.path, req.query.path);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return res.status(400).json({ error: 'est un dossier' });
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (MIME[ext]) return res.json({ kind: 'media', mime: MIME[ext], size: st.size, mtime: st.mtimeMs });
  if (st.size > MAX_FILE) return res.json({ kind: 'large', size: st.size, mtime: st.mtimeMs });
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return res.json({ kind: 'binary', size: st.size, mtime: st.mtimeMs });
  res.json({ kind: 'text', content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs });
}));

app.get('/api/projects/:id/raw', withProject(async (req, res, p) => {
  const abs = resolveIn(p.path, req.query.path);
  const ext = path.extname(abs).slice(1).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); // SVG inertes
  fs.createReadStream(abs).on('error', () => res.status(404).end()).pipe(res);
}));

app.put('/api/projects/:id/file', withProject(async (req, res, p) => {
  const abs = resolveIn(p.path, req.body.path);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, req.body.content, 'utf8');
  fileListCache.delete(p.path);
  const st = await fsp.stat(abs);
  res.json({ ok: true, mtime: st.mtimeMs });
}));

// Version HEAD d'un fichier, pour la vue diff
app.get('/api/projects/:id/head', withProject(async (req, res, p) => {
  const abs = resolveIn(p.path, req.query.path);
  try {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd: p.path })).trim();
    const rel = path.relative(top, abs).split(path.sep).join('/');
    const content = await run('git', ['show', 'HEAD:' + rel], { cwd: p.path });
    res.json({ exists: true, content });
  } catch { res.json({ exists: false, content: '' }); }
}));

// ---------- WebSocket terminal ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws/term' || !isAuthed(cookies)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => onTerminal(ws, url));
});

async function onTerminal(ws, url) {
  const p = await getProject(url.searchParams.get('project'));
  const slot = Number(url.searchParams.get('slot'));
  if (!p || !(slot >= 0 && slot < SLOTS)) return ws.close(4004, 'introuvable');
  const name = sessionName(p.id, slot);
  if (!(await hasSession(name))) return ws.close(4010, 'pas de session');
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const term = pty.spawn('tmux', ['-L', TMUX_SOCK, '-f', TMUX_CONF, 'attach-session', '-t', '=' + name], {
    name: 'xterm-256color', cols, rows, cwd: p.path, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => { if (ws.readyState === 1) ws.close(1000, 'fin'); });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r') { try { term.resize(Math.max(2, msg.c | 0), Math.max(2, msg.r | 0)); } catch {} }
  });
  ws.on('close', () => { try { term.kill(); } catch {} }); // détache seulement, la session tmux continue
}

restoreSlots().finally(() => setInterval(() => watchSlots().catch(() => {}), 5000));

server.listen(PORT, HOST, () => {
  console.log(`Agent Deck sur http://${HOST}:${PORT}/?token=${TOKEN}`);
});

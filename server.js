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
  // Bascule automatique : si le compte prévu dépasse ce % sur une de ses limites, les nouveaux agents prennent le compte suivant
  accountSwitch: { enabled: false, threshold: 80 },
  // Contrôle vocal : modèle du dispatcher (claude -p, sur ton abonnement) et langue de reconnaissance/synthèse
  voice: { model: 'sonnet', lang: 'fr-FR', speak: true },
  parked: [],    // projets envoyés « Au repos », tout en bas
  // Comptes Claude : « default » = ~/.claude ; les autres ont leur propre dossier (CLAUDE_CONFIG_DIR) sous ~/.claude-accounts
  accounts: [{ key: 'default', label: 'Principal' }],
  projectAccounts: {}, // chemin du projet -> clé du compte à utiliser
  // Tous les agents démarrent SANS demande de permission (--dangerously-skip-permissions), c'est le défaut voulu.
  // commandOf() ajoute le drapeau même si une vieille config.json ne l'a pas.
  commands: [
    { key: 'claude', label: 'Claude', cmd: 'claude --dangerously-skip-permissions --append-system-prompt-file ~/agentdeck/agent-prompt.md' },
    { key: 'continue', label: 'Reprendre', cmd: 'claude --dangerously-skip-permissions --continue --append-system-prompt-file ~/agentdeck/agent-prompt.md' },
    { key: 'shell', label: 'Shell', cmd: '' },
  ],
};

function loadConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
  catch { fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2)); return { ...DEFAULT_CONFIG }; }
}
let config = loadConfig();
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

// ---------- comptes Claude ----------
// Chaque compte supplémentaire = un CLAUDE_CONFIG_DIR à lui (identifiants, .claude.json), où l'on partage par lien
// symbolique ce qui doit rester commun : réglages (hooks), skills, plugins, et les transcripts (projects/) pour
// que la reprise de conversation marche quel que soit le compte.
const ACCOUNTS_DIR = path.join(HOME, '.claude-accounts');
const SHARED_ITEMS = ['settings.json', 'skills', 'plugins', 'commands', 'agents', 'projects', 'plans', 'CLAUDE.md'];
if (!Array.isArray(config.accounts) || !config.accounts.some((a) => a.key === 'default')) config.accounts = [{ key: 'default', label: 'Principal' }, ...(config.accounts || []).filter((a) => a.key !== 'default')];
config.projectAccounts ||= {};
const accountDir = (a) => (a.key === 'default' ? path.join(HOME, '.claude') : path.join(ACCOUNTS_DIR, a.key));
const getAccount = (key) => config.accounts.find((a) => a.key === key) || config.accounts[0];
const projectAccount = (projectPath) => getAccount(config.projectAccounts[projectPath] || 'default');
// Variables d'environnement à injecter dans la session tmux d'un compte
const accountEnv = (a) => (a.key === 'default' ? [] : ['-e', 'CLAUDE_CONFIG_DIR=' + accountDir(a)]);

async function createAccount(label) {
  const base = String(label || '').trim();
  if (!base) throw Object.assign(new Error('nom du compte manquant'), { status: 400 });
  let key = base.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'compte';
  if (key === 'default' || config.accounts.some((a) => a.key === key)) key += '-' + crypto.randomBytes(2).toString('hex');
  const a = { key, label: base };
  const dir = accountDir(a);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const item of SHARED_ITEMS) {
    const src = path.join(HOME, '.claude', item), dst = path.join(dir, item);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    await fsp.symlink(src, dst);
  }
  // .claude.json sans le compte connecté : garde l'onboarding fait, les projets approuvés et les serveurs MCP
  try {
    const j = JSON.parse(await fsp.readFile(path.join(HOME, '.claude.json'), 'utf8'));
    for (const k of ['oauthAccount', 'userID', 'passesEligibilityCache', 'overageCreditGrantCache', 'modelAccessCache', 'orgModelDefaultCache', 'cachedExtraUsageDisabledReason']) delete j[k];
    if (!fs.existsSync(path.join(dir, '.claude.json'))) await fsp.writeFile(path.join(dir, '.claude.json'), JSON.stringify(j, null, 2), { mode: 0o600 });
  } catch {}
  config.accounts.push(a);
  saveConfig();
  return a;
}

async function removeAccount(key) {
  const a = config.accounts.find((x) => x.key === key);
  if (!a || key === 'default') throw Object.assign(new Error('compte introuvable ou non supprimable'), { status: 400 });
  const live = await listSessions();
  if (Object.entries(slotsState).some(([n, r]) => r.account === key && live[n])) throw Object.assign(new Error('des agents tournent encore avec ce compte'), { status: 409 });
  try { await tmux('kill-session', '-t', '=' + loginSession(key)); } catch {}
  const dir = accountDir(a);
  if (dir.startsWith(ACCOUNTS_DIR + path.sep)) await fsp.rm(dir, { recursive: true, force: true }); // les liens symboliques sont retirés, pas leurs cibles
  config.accounts = config.accounts.filter((x) => x.key !== key);
  for (const [p, k] of Object.entries(config.projectAccounts)) if (k === key) delete config.projectAccounts[p];
  saveConfig();
}

// Qui est connecté sur ce compte (lu dans son .claude.json, écrit par Claude Code au login)
async function accountIdentity(a) {
  const dir = accountDir(a);
  const out = { loggedIn: false, email: null, org: null, plan: null, tier: null };
  try {
    const j = JSON.parse(await fsp.readFile(a.key === 'default' ? path.join(HOME, '.claude.json') : path.join(dir, '.claude.json'), 'utf8'));
    if (j.oauthAccount) { out.email = j.oauthAccount.emailAddress || null; out.org = j.oauthAccount.organizationName || null; out.plan = j.oauthAccount.organizationType || null; out.tier = j.oauthAccount.organizationRateLimitTier || null; }
  } catch {}
  try {
    const c = JSON.parse(await fsp.readFile(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
    if (c && c.accessToken) { out.loggedIn = true; out.plan = c.subscriptionType || out.plan; out.tier = c.rateLimitTier || out.tier; }
  } catch {}
  return out;
}
const loginSession = (key) => `adlogin_${key}`;

// Choix du compte au lancement : celui prévu, sauf s'il est « chaud » et que la bascule auto est active.
// Chaud = non connecté, ou une de ses limites (session, semaine…) au-dessus du seuil.
async function pickAccount(preferred) {
  const sw = config.accountSwitch || {};
  if (!sw.enabled || config.accounts.length < 2) return { account: preferred, switched: false };
  const thr = Number(sw.threshold) || 80;
  const hot = async (a) => {
    const u = await fetchUsage(a);
    if (!u.data) return true; // pas de token ou API en échec : on évite ce compte
    return u.data.limits.some((l) => l.percent >= thr);
  };
  if (!(await hot(preferred))) return { account: preferred, switched: false };
  const order = config.accounts;
  const i = order.findIndex((a) => a.key === preferred.key);
  for (let k = 1; k < order.length; k++) {
    const a = order[(i + k) % order.length];
    if (!(await hot(a))) return { account: a, switched: true };
  }
  return { account: preferred, switched: false }; // tout le monde est chaud : on garde le compte prévu
}

// ---------- attention (agent qui attend) ----------
// Les hooks Claude (hooks/agent-event.sh, installés dans ~/.claude/settings.json au démarrage) écrivent
// data/events/<emplacement> : « permission » (autorisation ou question posée), « done » (tour terminé, à toi),
// « working » (tu as répondu / un outil tourne). Ça remplace l'heuristique « plus d'activité = a fini ».
const EVENTS_DIR = path.join(DATA, 'events');
fs.mkdirSync(EVENTS_DIR, { recursive: true });
async function readAttention(name) {
  try {
    const j = JSON.parse(await fsp.readFile(path.join(EVENTS_DIR, name), 'utf8'));
    if (!j.kind || j.kind === 'working') return null;
    const out = { kind: j.kind, at: Number(j.at) || 0 };
    if (typeof j.message === 'string' && j.message) out.message = j.message.slice(0, 1200);
    if (voiceTargets.has(name)) out.voice = true;
    return out;
  } catch { return null; }
}
// Emplacements sollicités par la voix : leur fin de tour est lue à voix haute dans le navigateur
const voiceTargets = new Map(); // nom de session -> horodatage
const clearAttention = (name) => fsp.unlink(path.join(EVENTS_DIR, name)).catch(() => {});

const HOOK_SCRIPT = path.join(__dirname, 'hooks/agent-event.sh');
const WANTED_HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: path.join(__dirname, 'hooks/session-start.sh') }] }],
  // async : n'ajoute aucune latence à Claude ; permission_prompt n'est émis qu'après ~6 s d'attente, c'est voulu
  Notification: [
    { matcher: 'permission_prompt|elicitation_dialog|agent_needs_input', hooks: [{ type: 'command', command: `${HOOK_SCRIPT} permission`, async: true, timeout: 10 }] },
    { matcher: 'idle_prompt', hooks: [{ type: 'command', command: `${HOOK_SCRIPT} done`, async: true, timeout: 10 }] },
  ],
  Stop: [{ hooks: [{ type: 'command', command: `${HOOK_SCRIPT} done`, async: true, timeout: 10 }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_SCRIPT} working`, async: true, timeout: 10 }] }],
  PostToolUse: [{ hooks: [{ type: 'command', command: `${HOOK_SCRIPT} working`, async: true, timeout: 10 }] }],
};
// Ajoute nos hooks aux réglages Claude de l'utilisateur s'ils manquent (idempotent, ne touche pas aux autres hooks)
function ensureHooks() {
  const file = path.join(HOME, '.claude/settings.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  st.hooks ||= {};
  let added = 0;
  for (const [ev, groups] of Object.entries(WANTED_HOOKS)) {
    st.hooks[ev] ||= [];
    for (const g of groups) {
      const want = g.hooks[0].command;
      const present = st.hooks[ev].some((x) => (x.hooks || []).some((hk) => hk.command === want) && (x.matcher || '') === (g.matcher || ''));
      if (!present) { st.hooks[ev].push(g); added++; }
    }
  }
  if (!added) return;
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak-agentdeck-hooks');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(st, null, 2) + '\n'); // écriture en place : garde un éventuel lien symbolique
    console.log(`hooks Claude installés (${added}) dans ${file}`);
  } catch (e) { console.error('hooks Claude :', e.message); }
}
ensureHooks();

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
  const list = await Promise.all([...found].map(async ([id, p]) => ({ id, path: p, name: path.basename(p), parked: config.parked.includes(p), account: projectAccount(p).key, lastActivity: await lastActivity(p) })));
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
const SKIP_PERMS = '--dangerously-skip-permissions';
// Toute commande `claude` lancée par le cockpit tourne en bypass permissions, quoi que dise config.json
const withSkipPerms = (cmd) => (/^claude\b/.test(cmd) && !cmd.includes(SKIP_PERMS) ? cmd.replace(/^claude\b/, 'claude ' + SKIP_PERMS) : cmd);
const commandOf = (key) => withSkipPerms((config.commands.find((x) => x.key === key) || config.commands[0]).cmd);
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

async function spawnSlot(name, cwd, cmd, size = {}, account = getAccount('default')) {
  await clearAttention(name);
  const cols = Math.max(20, Math.min(500, Number(size.cols) || 160));
  const rows = Math.max(5, Math.min(200, Number(size.rows) || 40));
  await tmux('new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols), '-y', String(rows), '-e', 'AGENTDECK_SESSION=' + name, '-e', 'AGENTDECK_ACCOUNT=' + account.key, ...accountEnv(account), 'bash', '-l');
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
    try { await spawnSlot(name, rec.project, cmd, {}, getAccount(rec.account || projectAccount(rec.project).key)); console.log('restauré', name, sid || ''); } catch (e) { console.error('restauration', name, e.message); }
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

app.get('/api/config', (req, res) => res.json({ host: os.hostname(), slots: SLOTS, staleDays: config.staleDays, commands: config.commands.map(({ key, label }) => ({ key, label })), accounts: config.accounts, projectAccounts: config.projectAccounts, accountSwitch: config.accountSwitch, cloneRoot: cloneRoot(), voice: config.voice }));

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
    const rec = slotsState[name];
    (out[m[1]] ||= {})[m[2]] = { ...s, account: (rec && rec.account) || 'default', attention: await readAttention(name) };
  }
  const resumable = {};
  for (const [name, rec] of Object.entries(slotsState)) {
    const m = /^ad_([0-9a-f]{10})_(\d)$/.exec(name);
    if (m && !sessions[name] && currentSessionId(name, rec)) (resumable[m[1]] ||= {})[m[2]] = true;
  }
  res.json({ now: Date.now(), sessions: out, resumable });
}));

// ---------- usage Claude (limites du plan) ----------
// Même source que /usage dans Claude Code : l'API OAuth de claude.ai, interrogée avec le token que Claude Code
// garde dans ~/.claude/.credentials.json (il le rafraîchit lui-même tant qu'une session tourne). Endpoint non
// documenté : on reste défensif et on garde la dernière réponse valide si l'appel échoue.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_TTL = 60000;
const usageCaches = new Map(); // clé du compte -> { at, data, error }
const USAGE_LABELS = { session: 'Session · 5 h', weekly_all: 'Semaine', weekly_scoped: 'Semaine' };
async function fetchUsage(account = getAccount('default')) {
  let usageCache = usageCaches.get(account.key) || { at: 0, data: null, error: null };
  if (Date.now() - usageCache.at < USAGE_TTL) return usageCache;
  let creds;
  try { creds = JSON.parse(await fsp.readFile(path.join(accountDir(account), '.credentials.json'), 'utf8')).claudeAiOauth; } catch {}
  if (!creds || !creds.accessToken) {
    usageCache = { at: Date.now(), data: null, error: 'compte non connecté' };
    usageCaches.set(account.key, usageCache);
    return usageCache;
  }
  try {
    const r = await fetch(USAGE_URL, {
      headers: { authorization: 'Bearer ' + creds.accessToken, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(r.status === 401 ? 'token Claude expiré : ouvre un agent pour le rafraîchir' : 'API usage : HTTP ' + r.status);
    const j = await r.json();
    const limits = (Array.isArray(j.limits) ? j.limits : []).map((l) => ({
      kind: l.kind,
      label: l.kind === 'weekly_scoped' && l.scope && l.scope.model ? `${l.scope.model.display_name || 'Modèle'} · semaine` : USAGE_LABELS[l.kind] || l.kind,
      percent: Math.max(0, Math.min(100, Number(l.percent) || 0)),
      resetsAt: l.resets_at ? Date.parse(l.resets_at) : null,
      severity: l.severity || 'normal',
      active: !!l.is_active,
    }));
    // Anciens champs si `limits` est absent
    if (!limits.length) {
      for (const [k, kind] of [['five_hour', 'session'], ['seven_day', 'weekly_all']]) {
        if (j[k]) limits.push({ kind, label: USAGE_LABELS[kind], percent: Math.round(Number(j[k].utilization) || 0), resetsAt: j[k].resets_at ? Date.parse(j[k].resets_at) : null, severity: 'normal', active: false });
      }
    }
    const extra = j.extra_usage && j.extra_usage.is_enabled ? { percent: Number(j.extra_usage.utilization) || 0, used: j.extra_usage.used_credits, limit: j.extra_usage.monthly_limit, currency: j.extra_usage.currency } : null;
    usageCache = { at: Date.now(), error: null, data: { plan: creds.subscriptionType || null, tier: creds.rateLimitTier || null, limits, extra } };
  } catch (e) {
    usageCache = { at: Date.now(), data: usageCache.data, error: e.name === 'TimeoutError' ? 'API usage injoignable' : e.message };
  }
  usageCaches.set(account.key, usageCache);
  return usageCache;
}

app.get('/api/usage', wrap(async (req, res) => {
  const u = await fetchUsage(getAccount(req.query.account || 'default'));
  res.json({ now: Date.now(), at: u.at, stale: !!(u.error && u.data), error: u.error, ...(u.data || { plan: null, limits: [], extra: null }) });
}));

// ---------- comptes : API ----------
// Tous les comptes avec identité, usage et nombre de projets/agents qui s'en servent
app.get('/api/accounts', wrap(async (req, res) => {
  const [live, projects] = await Promise.all([listSessions(), discoverProjects()]);
  const out = await Promise.all(config.accounts.map(async (a) => {
    const [id, u] = await Promise.all([accountIdentity(a), fetchUsage(a)]);
    const usage = u.data || { plan: null, limits: [], extra: null };
    return {
      key: a.key, label: a.label, isDefault: a.key === 'default', ...id,
      plan: usage.plan || id.plan, tier: usage.tier || id.tier,
      usage: { limits: usage.limits, extra: usage.extra, error: u.error, stale: !!(u.error && u.data), at: u.at },
      projects: a.key === 'default' ? projects.filter((p) => !config.projectAccounts[p.path]).length : projects.filter((p) => config.projectAccounts[p.path] === a.key).length,
      agents: Object.entries(slotsState).filter(([n, r]) => live[n] && ((r.account || 'default') === a.key)).length,
      loginOpen: !!live[loginSession(a.key)],
    };
  }));
  res.json({ now: Date.now(), accounts: out, projectAccounts: config.projectAccounts });
}));

app.post('/api/accounts', wrap(async (req, res) => {
  const a = await createAccount(req.body && req.body.label);
  res.json(a);
}));

app.patch('/api/accounts/:key', wrap(async (req, res) => {
  const a = config.accounts.find((x) => x.key === req.params.key);
  if (!a) return res.status(404).json({ error: 'compte inconnu' });
  const label = String((req.body && req.body.label) || '').trim();
  if (label) a.label = label;
  saveConfig();
  res.json(a);
}));

app.delete('/api/accounts/:key', wrap(async (req, res) => {
  await removeAccount(req.params.key);
  usageCaches.delete(req.params.key);
  res.json({ ok: true });
}));

// Connexion : une session tmux dédiée lance `claude auth login` dans l'environnement du compte ; le navigateur s'y
// attache (ws/term?login=<clé>) pour afficher l'URL OAuth et saisir le code. Elle se ferme toute seule à la fin.
app.post('/api/accounts/:key/login', wrap(async (req, res) => {
  const a = config.accounts.find((x) => x.key === req.params.key);
  if (!a) return res.status(404).json({ error: 'compte inconnu' });
  const name = loginSession(a.key);
  if (!(await hasSession(name))) {
    const cols = Math.max(40, Math.min(300, Number(req.body && req.body.cols) || 100));
    const rows = Math.max(10, Math.min(100, Number(req.body && req.body.rows) || 30));
    const script = 'claude auth logout >/dev/null 2>&1; claude auth login; s=$?; echo; if [ $s = 0 ]; then claude auth status --text; echo; echo "✔ Connecté — fermeture dans 4 s"; else echo "✖ Connexion échouée ($s)"; fi; sleep 4';
    await tmux('new-session', '-d', '-s', name, '-c', HOME, '-x', String(cols), '-y', String(rows), ...accountEnv(a), 'bash', '-lc', script);
  }
  usageCaches.delete(a.key);
  res.json({ ok: true, session: name });
}));

app.post('/api/account-switch', wrap(async (req, res) => {
  const b = req.body || {};
  config.accountSwitch = { enabled: !!b.enabled, threshold: Math.max(10, Math.min(100, Number(b.threshold) || 80)) };
  saveConfig();
  res.json(config.accountSwitch);
}));

// ---------- dépôts : GitHub (via gh) et URL git ----------
// Setup « tout simple » : connecte GitHub une fois (gh auth login, dans une fenêtre terminal), puis clone tes
// dépôts dans le dossier des projets d'un clic. gh garde le token et sert d'assistant d'identifiants à git.
function cloneRoot() {
  const pref = config.roots.find((r) => r !== HOME && fs.existsSync(r)) || config.roots.find((r) => r !== HOME) || path.join(HOME, 'projects');
  return pref;
}
let ghCache = { at: 0, data: null };
async function ghStatus() {
  const out = { installed: false, loggedIn: false, user: null, host: 'github.com' };
  try { await run('gh', ['--version']); out.installed = true; } catch { return out; }
  try {
    const j = JSON.parse(await run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}'], { timeout: 8000 }));
    out.loggedIn = true; out.user = j.login;
  } catch {}
  return out;
}
app.get('/api/repos/status', wrap(async (req, res) => res.json({ ...(await ghStatus()), cloneRoot: cloneRoot(), loginOpen: !!(await listSessions())[loginSession('gh')] })));

app.get('/api/repos', wrap(async (req, res) => {
  if (req.query.refresh !== '1' && Date.now() - ghCache.at < 120000 && ghCache.data) return res.json(ghCache.data);
  const fields = 'nameWithOwner,description,updatedAt,isPrivate,url,isFork,isArchived';
  let repos = [];
  try {
    repos = JSON.parse(await run('gh', ['repo', 'list', '--limit', '300', '--json', fields], { timeout: 30000 }));
    // dépôts des organisations aussi, sans bloquer si ça échoue
    try {
      const orgs = JSON.parse(await run('gh', ['api', 'user/orgs', '--jq', '[.[].login]'], { timeout: 8000 }));
      for (const o of orgs.slice(0, 10)) {
        try { repos.push(...JSON.parse(await run('gh', ['repo', 'list', o, '--limit', '200', '--json', fields], { timeout: 20000 }))); } catch {}
      }
    } catch {}
  } catch (e) { return res.status(502).json({ error: 'gh : ' + ((e.stderr || e.message || '').trim().split('\n')[0]) }); }
  const root = cloneRoot();
  const existing = new Set((await discoverProjects()).map((p) => path.basename(p.path).toLowerCase()));
  const data = repos.filter((r) => !r.isArchived).map((r) => ({
    name: r.nameWithOwner, description: r.description || '', updatedAt: Date.parse(r.updatedAt) || 0, private: !!r.isPrivate, fork: !!r.isFork, url: r.url,
    cloned: existing.has(r.nameWithOwner.split('/')[1].toLowerCase()) || fs.existsSync(path.join(root, r.nameWithOwner.split('/')[1])),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
  ghCache = { at: Date.now(), data };
  res.json(data);
}));

const cloning = new Set();
app.post('/api/repos/clone', wrap(async (req, res) => {
  let src = String((req.body && (req.body.repo || req.body.url)) || '').trim();
  if (!src) return res.status(400).json({ error: 'dépôt manquant' });
  const isName = /^[\w.-]+\/[\w.-]+$/.test(src);
  if (!isName && !/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(src)) return res.status(400).json({ error: 'dépôt ou URL git invalide' });
  const base = (isName ? src.split('/')[1] : src.replace(/\/+$/, '').split(/[\/:]/).pop()).replace(/\.git$/, '');
  if (!/^[\w.-]+$/.test(base) || base.startsWith('.')) return res.status(400).json({ error: 'nom de dossier invalide' });
  const root = cloneRoot();
  const dest = path.join(root, base);
  if (fs.existsSync(dest)) return res.status(409).json({ error: `le dossier ${dest} existe déjà` });
  if (cloning.has(dest)) return res.status(409).json({ error: 'clonage déjà en cours' });
  cloning.add(dest);
  try {
    await fsp.mkdir(root, { recursive: true });
    if (isName) await run('gh', ['repo', 'clone', src, dest], { timeout: 600000 });
    else await run('git', ['clone', src, dest], { timeout: 600000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  } catch (e) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    return res.status(502).json({ error: 'clone : ' + ((e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop() || 'échec') });
  } finally { cloning.delete(dest); }
  if (!config.roots.includes(root) && !config.extra.includes(dest)) { config.extra.push(dest); saveConfig(); }
  ghCache.at = 0;
  await discoverProjects(true);
  res.json({ id: projId(dest), path: dest, name: base });
}));

// Connexion GitHub : fenêtre terminal sur `gh auth login` (code à saisir sur github.com), puis git utilise gh pour s'identifier
app.post('/api/repos/login', wrap(async (req, res) => {
  const name = loginSession('gh');
  if (!(await hasSession(name))) {
    const cols = Math.max(40, Math.min(300, Number(req.body && req.body.cols) || 100));
    const rows = Math.max(10, Math.min(100, Number(req.body && req.body.rows) || 30));
    const script = 'gh auth login --hostname github.com --git-protocol https --web; s=$?; echo; if [ $s = 0 ]; then gh auth setup-git; gh auth status; echo; echo "✔ GitHub connecté — fermeture dans 4 s"; else echo "✖ Connexion échouée ($s)"; fi; sleep 4';
    await tmux('new-session', '-d', '-s', name, '-c', HOME, '-x', String(cols), '-y', String(rows), 'bash', '-lc', script);
  }
  res.json({ ok: true, session: name });
}));

// ---------- contrôle vocal ----------
// Une seule entrée (voix ou texte). Un Claude headless (claude -p, abonnement, pas d'outils) reçoit l'état des
// projets et agents et décide : envoyer l'instruction à un agent qui tourne, en démarrer un, ou juste répondre.
const VOICE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['send', 'start', 'reply'] },
    projectId: { type: 'string' },
    slot: { type: 'integer' },
    instruction: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['action', 'reply'],
});
const VOICE_SYSTEM = `Tu es le dispatcher vocal d'Agent Deck, un cockpit qui pilote plusieurs agents Claude Code (jusqu'à 4 par projet, numérotés 1 à 4) sur un serveur.
L'utilisateur parle à voix haute ; sa phrase a été transcrite, elle peut contenir des erreurs de reconnaissance (noms de projets approximatifs, homophones). Devine le projet visé par ressemblance.
Tu reçois l'état des projets et des agents (état + dernières lignes de terminal). Décide :
- "send" : transmettre l'instruction à un agent qui tourne déjà (projectId + slot 0-3). Préfère l'agent dont le terminal montre qu'il travaille sur le sujet, sinon un agent qui attend. Un agent en attente d'autorisation ("perm") attend une réponse comme "oui"/"y" : si l'utilisateur dit d'accepter, envoie "y".
- "start" : démarrer un nouvel agent dans un projet (projectId) avec l'instruction, si aucun agent de ce projet ne convient ou si l'utilisateur le demande.
- "reply" : si la demande est une question sur l'état (qui travaille sur quoi, qui attend) ou si tu ne peux pas déterminer la cible : réponds ou demande une précision, sans rien envoyer.
"instruction" : la consigne reformulée proprement pour l'agent (impérative, claire, en français ou dans la langue de l'utilisateur), pas la transcription brute. Jamais de retour à la ligne.
"reply" : une phrase courte qui sera lue à voix haute : ce que tu as fait ou la réponse. Nomme le projet et le numéro d'agent (1-4, soit slot+1). Pas de markdown.`;

const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
async function paneTail(name, lines = 12) {
  try {
    const out = await tmux('capture-pane', '-p', '-J', '-t', '=' + name + ':', '-S', String(-lines));
    return out.split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).slice(-lines).join('\n').slice(-700);
  } catch { return ''; }
}
async function voiceContext(currentId) {
  const [projects, live] = await Promise.all([discoverProjects(), listSessions()]);
  const now = Date.now();
  const lines = [];
  const withAgents = [], others = [];
  for (const p of projects) {
    const names = Array.from({ length: SLOTS }, (_, i) => sessionName(p.id, i));
    (names.some((n) => live[n]) ? withAgents : others).push(p);
  }
  lines.push(`Projet affiché à l'écran : ${currentId || 'aucun'}`);
  lines.push('', '## Projets avec agents en cours');
  for (const p of withAgents) {
    lines.push(`### ${p.name} (projectId=${p.id}, ${p.path})`);
    for (let i = 0; i < SLOTS; i++) {
      const n = sessionName(p.id, i);
      if (!live[n]) { lines.push(`- agent ${i + 1} (slot ${i}) : libre`); continue; }
      const s = live[n];
      const att = await readAttention(n);
      const state = now - s.activity < 3500 ? 'busy (travaille)' : att ? (att.kind === 'permission' ? 'perm (attend une autorisation / réponse)' : 'done (a fini, attend une consigne)') : 'idle';
      const tail = await paneTail(n);
      lines.push(`- agent ${i + 1} (slot ${i}) : ${state}${s.command && s.command !== 'claude' ? ` [${s.command}]` : ''}`);
      if (tail) lines.push('  terminal :', ...tail.split('\n').map((l) => '    ' + l));
    }
  }
  lines.push('', '## Autres projets (aucun agent lancé, action "start" possible)');
  for (const p of others.filter((p) => !p.parked).slice(0, 40)) lines.push(`- ${p.name} (projectId=${p.id})`);
  return lines.join('\n');
}

async function runDispatcher(text, currentId) {
  const context = await voiceContext(currentId);
  const prompt = `${context}\n\n## Demande de l'utilisateur (transcription vocale)\n${text}`;
  const env = { ...process.env };
  delete env.AGENTDECK_SESSION; delete env.CLAUDE_CONFIG_DIR;
  const args = ['-p', '--no-session-persistence', '--output-format', 'json', '--json-schema', VOICE_SCHEMA, '--model', (config.voice && config.voice.model) || 'sonnet',
    '--tools', '', '--max-turns', '1', '--system-prompt', VOICE_SYSTEM, prompt];
  const raw = await run('claude', args, { cwd: HOME, env, timeout: 90000 });
  let j; try { j = JSON.parse(raw); } catch { throw new Error('dispatcher : réponse illisible'); }
  if (j.is_error) throw new Error('dispatcher : ' + String(j.result || 'erreur').slice(0, 200));
  let d = j.structured_output;
  if (!d) { try { d = JSON.parse(String(j.result).replace(/^```(?:json)?|```$/g, '').trim()); } catch { throw new Error('dispatcher : pas de JSON'); } }
  return d;
}

app.post('/api/voice/dispatch', wrap(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: 'rien entendu' });
  const d = await runDispatcher(text, req.body.current);
  const out = { action: d.action, reply: String(d.reply || '').trim(), instruction: d.instruction || null, projectId: d.projectId || null, slot: Number.isInteger(d.slot) ? d.slot : null };
  const p = d.projectId ? (await discoverProjects()).find((x) => x.id === d.projectId) : null;
  if ((d.action === 'send' || d.action === 'start') && !p) { out.action = 'reply'; out.reply = out.reply || 'Je ne trouve pas ce projet.'; return res.json(out); }
  const instruction = String(d.instruction || '').replace(/\s*\n+\s*/g, ' ').trim();
  if (d.action === 'send') {
    const name = sessionName(p.id, out.slot);
    if (!(out.slot >= 0 && out.slot < SLOTS) || !(await hasSession(name))) { out.action = 'reply'; out.reply = `L'agent ${out.slot + 1} de ${p.name} ne tourne pas.`; return res.json(out); }
    if (!instruction) { out.action = 'reply'; return res.json(out); }
    await tmux('send-keys', '-t', '=' + name + ':', '-l', instruction);
    await new Promise((r) => setTimeout(r, 150)); // laisse le TUI absorber le texte avant Entrée
    await tmux('send-keys', '-t', '=' + name + ':', 'Enter');
    voiceTargets.set(name, Date.now());
    await clearAttention(name);
  } else if (d.action === 'start') {
    const live = await listSessions();
    const slot = Array.from({ length: SLOTS }, (_, i) => i).find((i) => !live[sessionName(p.id, i)]);
    if (slot == null) { out.action = 'reply'; out.reply = `Les 4 agents de ${p.name} sont déjà pris.`; return res.json(out); }
    const name = sessionName(p.id, slot);
    const sid = crypto.randomUUID();
    const cmd = `${commandOf('claude')} --session-id ${sid}${instruction ? ' ' + shq(instruction) : ''}`;
    const { account } = await pickAccount(projectAccount(p.path));
    await spawnSlot(name, p.path, cmd, req.body || {}, account);
    slotsState[name] = { project: p.path, slot, cmdKey: 'claude', sessionId: sid, account: account.key, stopped: false, startedAt: Date.now() };
    writeSessionFile(name, sid); saveSlots();
    if (autoState.suppressed.includes(p.path)) { autoState.suppressed = autoState.suppressed.filter((x) => x !== p.path); saveAuto(); }
    voiceTargets.set(name, Date.now());
    out.slot = slot; out.started = true;
  }
  if (p) { out.projectId = p.id; out.projectName = p.name; }
  res.json(out);
}));

// Compte utilisé par défaut pour les agents d'un projet (les agents déjà lancés ne changent pas)
app.post('/api/projects/:id/account', withProject(async (req, res, p) => {
  const key = req.body && req.body.account;
  if (!config.accounts.some((a) => a.key === key)) return res.status(400).json({ error: 'compte inconnu' });
  if (key === 'default') delete config.projectAccounts[p.path]; else config.projectAccounts[p.path] = key;
  saveConfig();
  await discoverProjects(true);
  res.json({ ok: true, account: key });
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
  // Compte choisi explicitement dans l'emplacement : respecté. Sinon celui du projet, avec bascule auto éventuelle.
  const explicit = req.body && req.body.account && req.body.account !== projectAccount(p.path).key;
  const { account, switched } = explicit ? { account: getAccount(req.body.account), switched: false } : await pickAccount(projectAccount(p.path));
  await spawnSlot(name, p.path, cmd, req.body, account);
  if (autoState.suppressed.includes(p.path)) { autoState.suppressed = autoState.suppressed.filter((x) => x !== p.path); saveAuto(); }
  slotsState[name] = { project: p.path, slot, cmdKey: key, sessionId: sid, account: account.key, stopped: false, startedAt: Date.now() };
  if (sid) writeSessionFile(name, sid);
  saveSlots();
  res.json({ ok: true, account: account.key, switched });
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
      const { account } = await pickAccount(projectAccount(p.path));
      await spawnSlot(names[i], p.path, resumeCmd('claude', pick[i].sid, p.path), req.body || {}, account);
      slotsState[names[i]] = { project: p.path, slot: i, cmdKey: 'claude', sessionId: pick[i].sid, account: account.key, stopped: false, startedAt: Date.now() };
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
  const st = await fsp.stat(abs);
  if (st.isDirectory()) return res.status(400).json({ error: 'est un dossier' });
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'"); // SVG inertes
  // ?download=1 : téléchargement forcé, avec le vrai nom de fichier (même pour les images/PDF que le navigateur afficherait)
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
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
  let name, cwd;
  const loginKey = url.searchParams.get('login');
  if (loginKey) {
    if (loginKey !== 'gh' && !config.accounts.some((a) => a.key === loginKey)) return ws.close(4004, 'introuvable');
    name = loginSession(loginKey); cwd = HOME;
  } else {
    const p = await getProject(url.searchParams.get('project'));
    const slot = Number(url.searchParams.get('slot'));
    if (!p || !(slot >= 0 && slot < SLOTS)) return ws.close(4004, 'introuvable');
    name = sessionName(p.id, slot); cwd = p.path;
  }
  if (!(await hasSession(name))) return ws.close(4010, 'pas de session');
  const cols = Number(url.searchParams.get('cols')) || 120;
  const rows = Number(url.searchParams.get('rows')) || 30;
  const term = pty.spawn('tmux', ['-L', TMUX_SOCK, '-f', TMUX_CONF, 'attach-session', '-t', '=' + name], {
    name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
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

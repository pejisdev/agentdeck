'use strict';
/* Agent Deck — front. Pas de build : xterm (UMD) + Monaco (AMD) servis depuis node_modules. */

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('ad:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ad:' + k, JSON.stringify(v)); } catch {} },
};

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 2600);
}

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body && JSON.stringify(opts.body) });
  if (r.status === 401) { showLogin(); throw new Error('non authentifié'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const P = (id) => `/api/projects/${id}`;
const q = (o) => new URLSearchParams(o).toString();

// ---------------------------------------------------------------- état
const S = {
  cfg: null,
  projects: [],
  current: null,            // id projet
  decks: new Map(),         // id -> Deck
  status: {},               // id -> slot -> {activity, ...}
  resumable: {},            // id -> slot -> true (conversation à reprendre)
  now: Date.now(),
  prevBusy: {},             // `${id}:${slot}` -> bool
  done: new Set(store.get('done', [])),
  layout: store.get('layout', 'grid'),
  focusPane: null,
  showOld: store.get('showOld', false),
  showParked: store.get('showParked', false),
  files: new Map(),         // id -> FileState
};
const BUSY_MS = 3500;

// ---------------------------------------------------------------- login
function showLogin() { $('#login').hidden = false; $('#tokenInput').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: { token: $('#tokenInput').value.trim() } }); location.reload(); }
  catch { $('#loginErr').textContent = 'Token invalide'; }
});

// ---------------------------------------------------------------- sidebar
function slotState(id, slot) {
  const s = S.status[id] && S.status[id][slot];
  if (!s) return 'off';
  return S.now - s.activity < BUSY_MS ? 'busy' : 'idle';
}

function ago(ts) {
  if (!ts) return '';
  const m = (S.now - ts) / 60000;
  if (m < 60) return Math.max(1, Math.round(m)) + ' min';
  if (m < 1440) return Math.round(m / 60) + ' h';
  if (m < 1440 * 60) return Math.round(m / 1440) + ' j';
  return Math.round(m / 43200) + ' mois';
}

function renderProjects() {
  const filter = $('#projFilter').value.trim().toLowerCase();
  const list = $('#projList');
  list.textContent = '';
  const items = S.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter) || p.path.toLowerCase().includes(filter));
  const staleBefore = S.now - S.cfg.staleDays * 86400000;
  const active = items.filter((p) => S.status[p.id]);
  const recent = items.filter((p) => !S.status[p.id] && !p.parked && p.lastActivity >= staleBefore);
  const old = items.filter((p) => !S.status[p.id] && !p.parked && p.lastActivity < staleBefore);
  const parked = items.filter((p) => !S.status[p.id] && p.parked);
  const showOld = filter || S.showOld;
  const row = (p) => {
    const dots = h('div', { class: 'dots' });
    for (let i = 0; i < S.cfg.slots; i++) dots.append(h('i', { class: 'dot ' + slotState(p.id, i) }));
    return h('li', {
      class: (p.id === S.current ? 'active ' : '') + (S.done.has(p.id) ? 'done' : ''),
      title: p.path,
      onclick: () => selectProject(p.id),
    }, dots,
      h('div', { class: 'pname' }, h('b', {}, p.name), h('small', {}, p.path.replace(/^\/home\/[^/]+/, '~'))),
      h('span', { class: 'age', title: p.lastActivity ? new Date(p.lastActivity).toLocaleString('fr-FR') : '' }, ago(p.lastActivity)),
      h('button', { class: 'x', title: p.parked ? 'Sortir du repos' : 'Envoyer au repos (en bas)', onclick: (e) => { e.stopPropagation(); parkProject(p, !p.parked); } }, p.parked ? '⤒' : '⤓'),
      h('button', { class: 'x', title: 'Masquer ce projet', onclick: (e) => { e.stopPropagation(); hideProject(p); } }, '×'));
  };
  if (active.length) { list.append(h('li', { class: 'sep' }, 'Actifs')); active.forEach((p) => list.append(row(p))); }
  if (recent.length) { list.append(h('li', { class: 'sep' }, 'Récents')); recent.forEach((p) => list.append(row(p))); }
  if (old.length) {
    list.append(h('li', { class: 'sep toggle', onclick: () => { S.showOld = !S.showOld; store.set('showOld', S.showOld); renderProjects(); } },
      `${showOld ? '▾' : '▸'} Anciens · ${old.length}`));
    if (showOld) old.forEach((p) => list.append(row(p)));
  }
  if (parked.length) {
    const showParked = filter || S.showParked;
    list.append(h('li', { class: 'sep toggle', onclick: () => { S.showParked = !S.showParked; store.set('showParked', S.showParked); renderProjects(); } },
      `${showParked ? '▾' : '▸'} Au repos · ${parked.length}`));
    if (showParked) parked.forEach((p) => list.append(row(p)));
  }
  const doneCount = S.done.size;
  document.title = (doneCount ? `(${doneCount}) ` : '') + 'Agent Deck';
}

async function loadProjects(refresh) {
  S.projects = await api('/api/projects' + (refresh ? '?refresh=1' : ''));
  renderProjects();
}

async function parkProject(p, parked) {
  await api(`${P(p.id)}/park`, { method: 'POST', body: { parked } });
  await loadProjects();
}

async function hideProject(p) {
  if (!confirm(`Masquer « ${p.name} » de la liste ?\n(${p.path})`)) return;
  await api(P(p.id), { method: 'DELETE' });
  if (S.current === p.id) { S.current = null; store.set('current', null); }
  loadProjects();
}

$('#projFilter').addEventListener('input', renderProjects);
$('#refreshProj').addEventListener('click', () => loadProjects(true).then(() => toast('Projets rescannés')));
$('#addProj').addEventListener('click', async () => {
  const path = prompt('Chemin du dossier sur le VPS (ex : ~/mon-projet)');
  if (!path) return;
  try { const p = await api('/api/projects', { method: 'POST', body: { path } }); await loadProjects(true); selectProject(p.id); }
  catch (e) { toast(e.message, true); }
});

// ---------------------------------------------------------------- terminaux
const TERM_THEME = {
  background: '#0d0e11', foreground: '#d9dce2', cursor: '#d97757', cursorAccent: '#0d0e11',
  selectionBackground: '#33415588', black: '#1b1e24', red: '#ef6b6b', green: '#4cc38a', yellow: '#e2b84b',
  blue: '#5aa9ff', magenta: '#c792ea', cyan: '#56c8d8', white: '#d9dce2', brightBlack: '#5c6370',
  brightRed: '#ff8080', brightGreen: '#6ee7a8', brightYellow: '#f5d06f', brightBlue: '#82bfff',
  brightMagenta: '#dcb0ff', brightCyan: '#7fe0ec', brightWhite: '#ffffff',
};

class Pane {
  constructor(deck, slot) {
    this.deck = deck; this.slot = slot; this.term = null; this.ws = null; this.retry = 0; this.state = 'off';
    this.stateEl = h('span', { class: 'state' }, 'Libre');
    this.cmdEl = h('span', { class: 'cmd' });
    this.killBtn = h('button', { class: 'kill', title: 'Arrêter la session', onclick: () => this.stop() }, '■');
    this.maxBtn = h('button', { title: 'Agrandir (double-clic sur l\'en-tête)', onclick: () => this.toggleMax() }, '⤢');
    this.body = h('div', { class: 'pane-body' });
    this.el = h('div', { class: 'pane' },
      h('div', { class: 'pane-head', ondblclick: () => this.toggleMax() },
        h('span', { class: 'num' }, String(slot + 1)), this.stateEl, this.cmdEl, h('span', { class: 'spacer' }), this.killBtn, this.maxBtn),
      this.body);
    this.el.addEventListener('mousedown', () => this.setFocus(), true);
    new ResizeObserver(() => this.scheduleFit()).observe(this.body);
    this.showPlaceholder();
  }

  setFocus() {
    if (S.focusPane && S.focusPane !== this) S.focusPane.el.classList.remove('focused');
    S.focusPane = this; this.el.classList.add('focused');
  }

  showPlaceholder() {
    this.body.textContent = '';
    this.killBtn.hidden = true;
    // Si l'emplacement a une conversation précédente, « Reprendre » la rouvre et passe en premier
    this.resumable = !!(S.resumable[this.deck.id] && S.resumable[this.deck.id][this.slot]);
    const cmds = this.resumable ? [...S.cfg.commands].sort((a, b) => (b.key === 'continue') - (a.key === 'continue')) : S.cfg.commands;
    const btns = cmds.map((c) => h('button', { onclick: () => this.start(c.key) }, this.resumable && c.key === 'continue' ? 'Reprendre la conversation' : c.label));
    this.body.append(h('div', { class: 'placeholder' }, h('div', {}, `Agent ${this.slot + 1} — libre`), h('div', { class: 'btns' }, btns)));
  }

  async start(cmd) {
    try {
      const r = this.body.getBoundingClientRect();
      await api(`${P(this.deck.id)}/slots/${this.slot}/start`, { method: 'POST', body: { cmd, cols: Math.floor((r.width - 6) / 7.8), rows: Math.floor((r.height - 4) / 17) } });
      this.connect();
      pollStatus();
    } catch (e) { toast(e.message, true); }
  }

  async stop() {
    if (!confirm(`Arrêter l'agent ${this.slot + 1} ? La session tmux sera tuée.`)) return;
    await api(`${P(this.deck.id)}/slots/${this.slot}/stop`, { method: 'POST' });
    this.teardown(); pollStatus();
  }

  toggleMax() {
    const on = !this.el.classList.contains('max');
    this.deck.panes.forEach((p) => p.el.classList.remove('max'));
    this.el.classList.toggle('max', on);
    this.deck.el.classList.toggle('has-max', on);
    this.deck.panes.forEach((p) => p.scheduleFit());
    if (on && this.term) this.term.focus();
  }

  ensureTerm() {
    if (this.term) return;
    this.body.textContent = '';
    this.killBtn.hidden = false;
    const holder = h('div', { class: 'term' });
    this.body.append(holder);
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.15,
      theme: TERM_THEME, cursorBlink: true, allowProposedApi: true, scrollback: 2000, macOptionIsMeta: true,
    });
    this.fit = new FitAddon.FitAddon();
    term.loadAddon(this.fit);
    term.loadAddon(new WebLinksAddon.WebLinksAddon());
    try { term.loadAddon(new ClipboardAddon.ClipboardAddon()); } catch {}
    term.open(holder);
    term.onData((d) => this.send({ t: 'i', d }));
    term.onResize(({ cols, rows }) => this.send({ t: 'r', c: cols, r: rows }));
    term.attachCustomKeyEventHandler((e) => {
      // Laisse passer nos raccourcis globaux
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && ['p', 'b'].includes(e.key.toLowerCase()) && !e.shiftKey) return false;
      if (e.type === 'keydown' && e.altKey && /^[1-4]$/.test(e.key)) return false;
      // Ctrl+Shift+C / V : copier-coller
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') { navigator.clipboard.writeText(term.getSelection()); return false; }
      return true;
    });
    term.textarea && term.textarea.addEventListener('focus', () => this.setFocus());
    this.term = term;
    document.fonts && document.fonts.ready.then(() => this.scheduleFit());
  }

  connect() {
    if (this.ws) return;
    this.ensureTerm();
    this.doFit();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/term?${q({ project: this.deck.id, slot: this.slot, cols: this.term.cols, rows: this.term.rows })}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.term.reset(); this.send({ t: 'r', c: this.term.cols, r: this.term.rows }); };
    ws.onmessage = (e) => this.term.write(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4010 || e.code === 1000) { pollStatus(); return; } // session terminée : le poll mettra à jour
      if (this.retry++ < 20) setTimeout(() => { if (this.isRunning()) this.connect(); }, Math.min(5000, 300 * this.retry));
    };
  }

  isRunning() { return !!(S.status[this.deck.id] && S.status[this.deck.id][this.slot]); }

  teardown() {
    if (this.ws) { const ws = this.ws; this.ws = null; ws.close(); }
    if (this.term) { this.term.dispose(); this.term = null; }
    this.showPlaceholder();
  }

  send(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  scheduleFit() { clearTimeout(this._ft); this._ft = setTimeout(() => this.doFit(), 60); }
  doFit() {
    if (!this.term || !this.body.offsetWidth || !this.body.offsetHeight) return;
    try { this.fit.fit(); } catch {}
  }

  update() {
    const running = this.isRunning();
    const st = running ? slotState(this.deck.id, this.slot) : 'off';
    this.el.classList.remove('st-off', 'st-idle', 'st-busy');
    this.el.classList.add('st-' + st);
    this.stateEl.textContent = st === 'busy' ? 'Travaille…' : st === 'idle' ? 'En attente' : 'Libre';
    const s = running && S.status[this.deck.id][this.slot];
    this.cmdEl.textContent = s && s.command && s.command !== 'bash' ? s.command : running ? 'shell' : '';
    if (running && !this.ws) this.connect();
    if (!running && this.term && !this.ws) this.teardown();
    else if (!running && !this.term && this.resumable !== !!(S.resumable[this.deck.id] && S.resumable[this.deck.id][this.slot])) this.showPlaceholder();
  }
}

class Deck {
  constructor(id) {
    this.id = id;
    this.el = h('div', { class: 'deck', 'data-layout': S.layout });
    this.panes = [];
    for (let i = 0; i < S.cfg.slots; i++) { const p = new Pane(this, i); this.panes.push(p); this.el.append(p.el); }
    $('#decks').append(this.el);
  }
  show(on) { this.el.hidden = !on; if (on) this.panes.forEach((p) => { p.update(); p.scheduleFit(); }); }
}

function setLayout(l) {
  S.layout = l; store.set('layout', l);
  document.querySelectorAll('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === l));
  S.decks.forEach((d) => { d.el.dataset.layout = l; d.panes.forEach((p) => p.scheduleFit()); });
}
document.querySelectorAll('#layoutSeg button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));

// ---------------------------------------------------------------- statut
async function pollStatus() {
  try {
    const r = await api('/api/status');
    S.now = r.now; S.status = r.sessions; S.resumable = r.resumable || {};
    // Détecte les agents qui viennent de finir (busy -> idle) hors du projet affiché
    for (const p of S.projects) {
      for (let i = 0; i < S.cfg.slots; i++) {
        const k = p.id + ':' + i, busy = slotState(p.id, i) === 'busy';
        if (S.prevBusy[k] && !busy && (p.id !== S.current || document.hidden)) notifyDone(p, i);
        S.prevBusy[k] = busy;
      }
    }
    renderProjects();
    const d = S.decks.get(S.current);
    if (d) d.panes.forEach((p) => p.update());
  } catch {}
}

function notifyDone(p, slot) {
  if (!(S.status[p.id] && S.status[p.id][slot])) return;
  if (p.id !== S.current) { S.done.add(p.id); store.set('done', [...S.done]); }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(`${p.name} · agent ${slot + 1}`, { body: 'A terminé, en attente de toi', tag: p.id + slot });
  }
}

// Projet sans agent lancé : le serveur reprend ses conversations Claude récentes dans les emplacements
async function autoResume(id) {
  if (S.status[id]) return;
  const pane = S.decks.get(id).panes[0].body.getBoundingClientRect();
  try {
    const r = await api(`${P(id)}/autoresume`, { method: 'POST', body: { cols: Math.floor((pane.width - 6) / 7.8), rows: Math.floor((pane.height - 4) / 17) } });
    if (r.started.length) { toast(`${r.started.length} conversation${r.started.length > 1 ? 's' : ''} reprise${r.started.length > 1 ? 's' : ''}`); pollStatus(); }
  } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------------- sélection projet
async function selectProject(id) {
  const p = S.projects.find((x) => x.id === id);
  if (!p) return;
  S.current = id; store.set('current', id);
  S.done.delete(id); store.set('done', [...S.done]);
  $('#projTitle').textContent = p.name;
  $('#projPath').textContent = p.path;
  $('.empty-state') && $('.empty-state').remove();
  if (!S.decks.has(id)) S.decks.set(id, new Deck(id));
  S.decks.forEach((d, k) => d.show(k === id));
  renderProjects();
  showFiles(id);
  autoResume(id);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

// ---------------------------------------------------------------- arbre de fichiers
class FileState {
  constructor(id) {
    this.id = id;
    this.expanded = new Set(['']);
    this.listings = new Map();  // dir -> entries
    this.git = { files: {} };
    this.dirtyDirs = new Set();
    this.tabs = [];             // {path, model, savedVersion, mtime, kind, mime}
    this.active = null;
    this.selected = null;
  }
}
const FS = () => S.files.get(S.current);

async function fetchDir(fs, dir) {
  const entries = await api(`${P(fs.id)}/tree?${q({ dir })}`);
  const prev = fs.listings.get(dir);
  fs.listings.set(dir, entries);
  return !prev || JSON.stringify(prev) !== JSON.stringify(entries);
}

async function fetchGit(fs) {
  const g = await api(`${P(fs.id)}/git`);
  const prev = JSON.stringify(fs.git.files);
  fs.git = g;
  fs.dirtyDirs = new Set();
  for (const f of Object.keys(g.files)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) fs.dirtyDirs.add(parts.slice(0, i).join('/'));
  }
  return prev !== JSON.stringify(g.files);
}

function gitCode(fs, rel) {
  const c = fs.git.files[rel];
  if (!c) return null;
  if (c === '??') return 'U';
  return c.replace(/\s/g, '')[0];
}

function renderTree() {
  const fs = FS(); if (!fs) return;
  const tree = $('#tree');
  const scroll = tree.scrollTop;
  tree.textContent = '';
  const walk = (dir, depth) => {
    const entries = fs.listings.get(dir) || [];
    for (const e of entries) {
      const rel = dir ? dir + '/' + e.name : e.name;
      const open = e.dir && fs.expanded.has(rel);
      const code = e.dir ? null : gitCode(fs, rel);
      const cls = ['node', e.dir ? 'dir' : 'file'];
      if (code) cls.push('g-' + code);
      if (e.dir && fs.dirtyDirs.has(rel)) cls.push('g-dirty');
      if (rel === fs.selected) cls.push('sel');
      if (e.name.startsWith('.') || ['node_modules', 'dist', 'build', 'target', '.next', '__pycache__'].includes(e.name)) cls.push('dim');
      tree.append(h('div', {
        class: cls.join(' '), style: `padding-left:${6 + depth * 12}px`, title: rel,
        onclick: () => (e.dir ? toggleDir(rel) : openFile(rel)),
      }, h('span', { class: 'tw' }, e.dir ? (open ? '▾' : '▸') : ''), h('span', { class: 'ic' }, e.dir ? '' : fileIcon(e.name)),
        h('span', { class: 'nm' }, e.name), code ? h('span', { class: 'gs' }, code) : null));
      if (open) walk(rel, depth + 1);
    }
  };
  walk('', 0);
  tree.scrollTop = scroll;
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const m = { js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', tsx: 'TX', jsx: 'JX', py: 'PY', rs: 'RS', go: 'GO', sol: 'SO', md: 'M↓', json: '{}', toml: '⚙', yml: '⚙', yaml: '⚙', sh: '$', css: '#', html: '<>', sql: 'DB', png: '▣', jpg: '▣', jpeg: '▣', svg: '▣', gif: '▣', webp: '▣', lock: '🔒', env: '⚿' };
  const tag = m[ext] || '·';
  return tag.length > 1 ? h('span', { style: 'font-size:8px;font-weight:700;font-family:var(--mono);color:#7c8491' }, tag) : tag;
}

async function toggleDir(rel) {
  const fs = FS();
  if (fs.expanded.has(rel)) fs.expanded.delete(rel);
  else { fs.expanded.add(rel); try { await fetchDir(fs, rel); } catch (e) { toast(e.message, true); } }
  persistExpanded(fs);
  renderTree();
}
function persistExpanded(fs) { store.set('exp:' + fs.id, [...fs.expanded]); }

async function refreshTree(fs, force) {
  if (!fs) return;
  let changed = false;
  for (const dir of [...fs.expanded]) {
    try { changed = (await fetchDir(fs, dir)) || changed; } catch { fs.expanded.delete(dir); changed = true; }
  }
  try { changed = (await fetchGit(fs)) || changed; } catch {}
  if ((changed || force) && fs.id === S.current) renderTree();
}

async function showFiles(id) {
  if (!S.files.has(id)) {
    const fs = new FileState(id);
    store.get('exp:' + id, ['']).forEach((d) => fs.expanded.add(d));
    S.files.set(id, fs);
    await refreshTree(fs, true);
  } else renderTree();
  renderTabs();
  showActive();
}
$('#refreshTree').addEventListener('click', () => refreshTree(FS(), true));

// ---------------------------------------------------------------- éditeur (Monaco)
let monacoReady, editor, diffEditor, diffMode = false;
const monacoP = new Promise((resolve) => (monacoReady = resolve));
require.config({ paths: { vs: location.origin + '/vendor/monaco/min/vs' } }); // URL absolue : requise par les workers
require(['vs/editor/editor.main'], () => {
  // Pas de vrai projet TS côté navigateur : on garde la coloration/syntaxe, sans les faux « module introuvable »
  for (const d of [monaco.languages.typescript.typescriptDefaults, monaco.languages.typescript.javascriptDefaults]) {
    d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
  }
  monaco.editor.defineTheme('deck', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: { 'editor.background': '#121419', 'editorGutter.background': '#121419', 'editor.lineHighlightBackground': '#171a20', 'editorLineNumber.foreground': '#3c424d', 'editorLineNumber.activeForeground': '#9aa1ad', 'editorIndentGuide.background1': '#1e2128', 'minimap.background': '#121419', 'scrollbarSlider.background': '#262a3288' },
  });
  const common = { theme: 'deck', automaticLayout: true, fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12.5, lineHeight: 19, minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, renderWhitespace: 'selection', stickyScroll: { enabled: true }, padding: { top: 6 } };
  editor = monaco.editor.create($('#editor'), { ...common, model: null });
  diffEditor = monaco.editor.createDiffEditor($('#diffEditor'), { ...common, renderSideBySide: false, readOnly: false, originalEditable: false });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openPalette());
  monacoReady();
});

function tabFor(fs, path) { return fs.tabs.find((t) => t.path === path); }

async function openFile(path, { pin = true } = {}) {
  const fs = FS(); if (!fs) return;
  fs.selected = path;
  let tab = tabFor(fs, path);
  if (!tab) {
    let info;
    try { info = await api(`${P(fs.id)}/file?${q({ path })}`); } catch (e) { return toast(e.message, true); }
    tab = { path, kind: info.kind, mime: info.mime, mtime: info.mtime, size: info.size };
    if (info.kind === 'text') {
      await monacoP;
      const uri = monaco.Uri.parse(`file:///${fs.id}/${path}`);
      const old = monaco.editor.getModel(uri); if (old) old.dispose();
      tab.model = monaco.editor.createModel(info.content, undefined, uri);
      tab.savedVersion = tab.model.getAlternativeVersionId();
      tab.model.onDidChangeContent(() => renderTabs());
    }
    fs.tabs.push(tab);
  }
  fs.active = path;
  renderTabs(); renderTree(); showActive();
}

function isDirty(tab) { return tab.model && tab.model.getAlternativeVersionId() !== tab.savedVersion; }

function renderTabs() {
  const fs = FS(); const bar = $('#tabs'); bar.textContent = '';
  if (!fs) return;
  for (const t of fs.tabs) {
    const name = t.path.split('/').pop();
    bar.append(h('div', {
      class: 'tab' + (t.path === fs.active ? ' active' : '') + (isDirty(t) ? ' dirty' : ''), title: t.path,
      onclick: () => { fs.active = t.path; fs.selected = t.path; renderTabs(); renderTree(); showActive(); },
      onauxclick: (e) => { if (e.button === 1) closeTab(t); },
    }, name, h('button', { class: 'close', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, h('span', {}, '×'))));
  }
  const act = bar.querySelector('.tab.active'); if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function closeTab(t) {
  const fs = FS();
  if (isDirty(t) && !confirm(`${t.path} a des modifications non enregistrées. Fermer quand même ?`)) return;
  const i = fs.tabs.indexOf(t);
  fs.tabs.splice(i, 1);
  if (t.model) t.model.dispose();
  if (fs.active === t.path) fs.active = (fs.tabs[i] || fs.tabs[i - 1] || {}).path || null;
  renderTabs(); showActive();
}

async function showActive() {
  const fs = FS();
  const tab = fs && fs.active && tabFor(fs, fs.active);
  $('#editorEmpty').hidden = !!tab;
  $('#editorToolbar').hidden = !tab;
  const prev = $('#preview');
  prev.hidden = true; prev.textContent = '';
  $('#editor').hidden = true; $('#diffEditor').hidden = true;
  if (!tab) return;
  $('#filePathLabel').textContent = tab.path;
  $('#saveBtn').hidden = !tab.model;
  $('#diffBtn').hidden = !tab.model || !fs.git.repo;
  $('#diffBtn').classList.toggle('on', diffMode);
  if (tab.kind === 'text') {
    await monacoP;
    if (diffMode && fs.git.repo) {
      $('#diffEditor').hidden = false;
      const head = await api(`${P(fs.id)}/head?${q({ path: tab.path })}`).catch(() => ({ content: '' }));
      const old = diffEditor.getModel();
      const orig = monaco.editor.createModel(head.content, tab.model.getLanguageId());
      diffEditor.setModel({ original: orig, modified: tab.model });
      if (old && old.original) old.original.dispose();
    } else {
      $('#editor').hidden = false;
      if (editor.getModel() !== tab.model) {
        const cur = editor.getModel() && tabFor(fs, curPathOf(editor.getModel()));
        if (cur) cur.view = editor.saveViewState();
        editor.setModel(tab.model);
        if (tab.view) editor.restoreViewState(tab.view);
      }
      editor.layout();
    }
  } else {
    prev.hidden = false;
    const raw = `${P(fs.id)}/raw?${q({ path: tab.path })}`;
    if (tab.kind === 'media' && tab.mime.startsWith('image/')) prev.append(h('img', { src: raw + '&t=' + tab.mtime }));
    else if (tab.kind === 'media' && tab.mime === 'application/pdf') prev.append(h('iframe', { src: raw }));
    else prev.append(h('div', {}, `${tab.kind === 'large' ? 'Fichier trop volumineux' : 'Fichier binaire'} · ${(tab.size / 1024).toFixed(1)} Ko `, h('a', { href: raw, download: tab.path.split('/').pop(), style: 'color:var(--blue)' }, 'Télécharger')));
  }
}
function curPathOf(model) { return model.uri.path.split('/').slice(2).join('/'); }

$('#diffBtn').addEventListener('click', () => { diffMode = !diffMode; showActive(); });
$('#saveBtn').addEventListener('click', () => saveActive());

async function saveActive() {
  const fs = FS(); const tab = fs && tabFor(fs, fs.active);
  if (!tab || !tab.model) return;
  try {
    const r = await api(`${P(fs.id)}/file`, { method: 'PUT', body: { path: tab.path, content: tab.model.getValue() } });
    tab.savedVersion = tab.model.getAlternativeVersionId(); tab.mtime = r.mtime;
    renderTabs(); toast('Enregistré'); refreshTree(fs);
  } catch (e) { toast(e.message, true); }
}

// Recharge les onglets ouverts quand un agent modifie le fichier (sauf modifs locales non enregistrées)
async function syncOpenTabs() {
  const fs = FS(); if (!fs) return;
  for (const t of fs.tabs) {
    if (!t.model || isDirty(t)) continue;
    const st = await api(`${P(fs.id)}/stat?${q({ path: t.path })}`).catch(() => null);
    if (!st || !st.exists || st.mtime === t.mtime) continue;
    const info = await api(`${P(fs.id)}/file?${q({ path: t.path })}`).catch(() => null);
    if (!info || info.kind !== 'text') continue;
    t.mtime = info.mtime;
    if (info.content !== t.model.getValue()) {
      const view = editor && editor.getModel() === t.model ? editor.saveViewState() : null;
      t.model.pushEditOperations([], [{ range: t.model.getFullModelRange(), text: info.content }], () => null);
      t.savedVersion = t.model.getAlternativeVersionId();
      if (view) editor.restoreViewState(view);
      renderTabs();
    }
  }
}

// ---------------------------------------------------------------- palette Ctrl+P
let palItems = [], palSel = 0;
async function openPalette() {
  const fs = FS(); if (!fs) return;
  $('#palette').hidden = false;
  const inp = $('#paletteInput'); inp.value = ''; inp.focus();
  $('#paletteList').innerHTML = '<li class="muted">Chargement…</li>';
  try { fs.allFiles = await api(`${P(fs.id)}/files`); } catch (e) { return toast(e.message, true); }
  filterPalette();
}
function closePalette() { $('#palette').hidden = true; }
function fuzzy(qs, s) {
  let qi = 0, score = 0, last = -1; const hits = [];
  const ls = s.toLowerCase();
  for (let i = 0; i < ls.length && qi < qs.length; i++) {
    if (ls[i] === qs[qi]) { score += (i === last + 1 ? 3 : 1) + (i === 0 || '/._-'.includes(ls[i - 1]) ? 2 : 0); hits.push(i); last = i; qi++; }
  }
  if (qi < qs.length) return null;
  const base = s.lastIndexOf('/') + 1;
  if (hits[0] >= base) score += 6;
  return { score: score - s.length * 0.02, hits };
}
function filterPalette() {
  const fs = FS(); const qs = $('#paletteInput').value.trim().toLowerCase().replace(/\s+/g, '');
  const files = fs.allFiles || [];
  palItems = qs ? files.map((f) => ({ f, m: fuzzy(qs, f) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).slice(0, 60)
    : files.slice(0, 60).map((f) => ({ f, m: { hits: [] } }));
  palSel = 0; renderPalette();
}
function renderPalette() {
  const ul = $('#paletteList'); ul.textContent = '';
  palItems.forEach((it, i) => {
    const base = it.f.lastIndexOf('/') + 1;
    const name = h('b'); const hs = new Set(it.m.hits);
    for (let j = base; j < it.f.length; j++) name.append(hs.has(j) ? h('mark', {}, it.f[j]) : it.f[j]);
    ul.append(h('li', { class: i === palSel ? 'sel' : '', onclick: () => { closePalette(); openFile(it.f); } }, name, h('small', {}, it.f.slice(0, base))));
  });
  const sel = ul.querySelector('.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}
$('#paletteInput').addEventListener('input', filterPalette);
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { palSel = Math.min(palItems.length - 1, palSel + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palSel = Math.max(0, palSel - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { const it = palItems[palSel]; if (it) { closePalette(); openFile(it.f); } }
  else if (e.key === 'Escape') closePalette();
});
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });
$('#quickOpenBtn').addEventListener('click', openPalette);

// ---------------------------------------------------------------- raccourcis & redimensionnement
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette(); }
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleFiles(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveActive(); }
  else if (e.altKey && /^[1-4]$/.test(e.key)) {
    e.preventDefault();
    const d = S.decks.get(S.current); const p = d && d.panes[Number(e.key) - 1];
    if (p) { p.setFocus(); if (p.term) p.term.focus(); }
  }
}, true);

function toggleFiles() {
  const on = $('#app').classList.toggle('no-files');
  store.set('noFiles', on);
  S.decks.forEach((d) => d.panes.forEach((p) => p.scheduleFit()));
}
$('#toggleFiles').addEventListener('click', toggleFiles);

function dragGutter(el, onMove) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault(); el.classList.add('drag'); document.body.classList.add('dragging');
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove('drag'); document.body.classList.remove('dragging');
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      S.decks.forEach((d) => d.panes.forEach((p) => p.scheduleFit()));
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
dragGutter($('#gutterV'), (e) => {
  const w = Math.max(260, Math.min(window.innerWidth - 600, window.innerWidth - e.clientX));
  document.documentElement.style.setProperty('--files-w', w + 'px'); store.set('filesW', w);
});
dragGutter($('#gutterH'), (e) => {
  const r = $('#files').getBoundingClientRect();
  const pct = Math.max(10, Math.min(85, ((e.clientY - r.top - 38) / (r.height - 38)) * 100));
  document.documentElement.style.setProperty('--tree-h', pct + '%'); store.set('treeH', pct);
});

// ---------------------------------------------------------------- boot
(async function boot() {
  const fw = store.get('filesW'); if (fw) document.documentElement.style.setProperty('--files-w', fw + 'px');
  const th = store.get('treeH'); if (th) document.documentElement.style.setProperty('--tree-h', th + '%');
  if (store.get('noFiles', false)) $('#app').classList.add('no-files');
  try { S.cfg = await api('/api/config'); } catch { return; }
  $('#hostName').textContent = S.cfg.host;
  setLayout(S.layout);
  await loadProjects();
  await pollStatus();
  const last = store.get('current');
  if (last && S.projects.some((p) => p.id === last)) selectProject(last);
  setInterval(pollStatus, 1500);
  setInterval(() => { if (!document.hidden) { refreshTree(FS()); syncOpenTabs(); } }, 4000);
  setInterval(() => loadProjects().catch(() => {}), 60000);
})();

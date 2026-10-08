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
  files: new Map(),         // id -> FileState
  accounts: [],             // comptes Claude (de /api/accounts)
};
const accountLabel = (key) => { const a = (S.accounts.length ? S.accounts : (S.cfg && S.cfg.accounts) || []).find((x) => x.key === key); return a ? a.label : key; };
const multiAccount = () => ((S.cfg && S.cfg.accounts) || []).length > 1;
const BUSY_MS = 3500;

// ---------------------------------------------------------------- login
function showLogin() { $('#login').hidden = false; $('#tokenInput').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/login', { method: 'POST', body: { token: $('#tokenInput').value.trim() } }); location.reload(); }
  catch { $('#loginErr').textContent = 'Token invalide'; }
});

// ---------------------------------------------------------------- sidebar
// off | busy | perm (autorisation ou question en attente) | attn (tour fini, à toi) | idle
function slotState(id, slot) {
  const s = S.status[id] && S.status[id][slot];
  if (!s) return 'off';
  if (S.now - s.activity < BUSY_MS) return 'busy';
  if (s.attention) return s.attention.kind === 'permission' ? 'perm' : 'attn';
  return 'idle';
}
const needsYou = (st) => st === 'perm' || st === 'attn';

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
  const scratch = items.find((p) => p.scratch);
  const active = items.filter((p) => !p.scratch && S.status[p.id]);
  const recent = items.filter((p) => !p.scratch && !S.status[p.id] && p.lastActivity >= staleBefore);
  // Les anciens ne s'affichent plus : la liste ne montre que l'actif et le récent.
  // Ils restent trouvables en tapant leur nom dans le champ de recherche.
  const hidden = filter ? items.filter((p) => !p.scratch && !S.status[p.id] && p.lastActivity < staleBefore) : [];
  const row = (p) => {
    const dots = h('div', { class: 'dots' });
    for (let i = 0; i < S.cfg.slots; i++) dots.append(h('i', { class: 'dot ' + slotState(p.id, i) }));
    return h('li', {
      class: (p.id === S.current ? 'active ' : '') + (S.done.has(p.id) ? 'done' : ''),
      title: p.path,
      onclick: () => selectProject(p.id),
    }, dots,
      h('div', { class: 'pname' }, h('b', {}, p.name, p.account && p.account !== 'default' ? h('span', { class: 'acct-tag', title: 'Compte Claude : ' + accountLabel(p.account) }, accountLabel(p.account)) : null), h('small', {}, p.missing ? '⚠ dossier supprimé — ferme ses agents' : p.path.replace(/^\/home\/[^/]+/, '~'))),
      h('span', { class: 'age', title: p.lastActivity ? new Date(p.lastActivity).toLocaleString('fr-FR') : '' }, ago(p.lastActivity)),
      // La croix arrête les agents du projet, rien d'autre : il retombe dans « Récents »
      S.status[p.id] ? h('button', { class: 'x', title: 'Arrêter les agents de ce projet', onclick: (e) => { e.stopPropagation(); stopProjectAgents(p); } }, '×') : null);
  };
  // Agent libre : toujours en tête, pas de croix, un + pour lancer un agent tout de suite
  if (scratch) {
    const dots = h('div', { class: 'dots' });
    for (let i = 0; i < S.cfg.slots; i++) dots.append(h('i', { class: 'dot ' + slotState(scratch.id, i) }));
    list.append(h('li', { class: 'scratch ' + (scratch.id === S.current ? 'active ' : '') + (S.done.has(scratch.id) ? 'done' : ''), title: 'Agents temporaires pour des demandes générales, hors projet', onclick: () => selectProject(scratch.id) },
      dots, h('div', { class: 'pname' }, h('b', {}, '⚡ Agent libre'), h('small', {}, 'demandes générales, hors projet')),
      h('button', { class: 'x plus', title: 'Lancer un agent libre', onclick: (e) => { e.stopPropagation(); startFreeAgent(scratch); } }, '+')));
  }
  if (active.length) { list.append(h('li', { class: 'sep' }, 'Actifs')); active.forEach((p) => list.append(row(p))); }
  if (recent.length) { list.append(h('li', { class: 'sep' }, 'Récents')); recent.forEach((p) => list.append(row(p))); }
  if (hidden.length) { list.append(h('li', { class: 'sep' }, 'Anciens / au repos')); hidden.forEach((p) => list.append(row(p))); }
  let waiting = 0;
  for (const p of S.projects) for (let i = 0; i < S.cfg.slots; i++) if (needsYou(slotState(p.id, i))) waiting++;
  document.title = (waiting ? `(${waiting}) ` : '') + 'Agent Deck';
}

// Lance un Claude dans le premier emplacement libre de l'agent libre
async function startFreeAgent(p) {
  await selectProject(p.id);
  const d = S.decks.get(p.id);
  const pane = d && d.panes.find((pn, i) => !pn.term && !(S.status[p.id] && S.status[p.id][i]));
  if (!pane) return toast('Les 4 agents libres sont déjà pris', true);
  pane.start('claude');
}

async function loadProjects(refresh) {
  S.projects = await api('/api/projects' + (refresh ? '?refresh=1' : ''));
  renderProjects();
}

async function stopProjectAgents(p) {
  const running = S.status[p.id] ? Object.keys(S.status[p.id]).length : 0;
  if (!running) return;
  if (!confirm(`Arrêter ${running > 1 ? `les ${running} agents` : "l'agent"} de « ${p.name} » ?`)) return;
  try { await api(`${P(p.id)}/stop`, { method: 'POST' }); } catch (e) { return toast(e.message, true); }
  const d = S.decks.get(p.id); if (d) d.panes.forEach((pn) => pn.teardown());
  await Promise.all([loadProjects(), pollStatus()]);
  toast(`Agents de ${p.name} arrêtés`);
}

async function hideProject(p) {
  if (!confirm(`Masquer « ${p.name} » de la liste ?\n(${p.path})`)) return;
  await api(P(p.id), { method: 'DELETE' });
  if (S.current === p.id) { S.current = null; store.set('current', null); }
  loadProjects();
}

$('#projFilter').addEventListener('input', renderProjects);
$('#refreshProj').addEventListener('click', () => loadProjects(true).then(() => toast('Projets rescannés')));
// ---------------------------------------------------------------- ajouter un projet : GitHub, URL git, dossier existant
let repos = [], repoStatus = null;
function openRepoModal() { $('#repoModal').hidden = false; $('#repoFilter').value = ''; refreshRepoStatus(); }
function closeRepoModal() { $('#repoModal').hidden = true; }
async function refreshRepoStatus() {
  try { repoStatus = await api('/api/repos/status'); } catch (e) { return toast(e.message, true); }
  $('#repoRoot').textContent = 'clone dans ' + repoStatus.cloneRoot.replace(/^\/home\/[^/]+/, '~');
  const st = $('#repoGhStatus');
  if (!repoStatus.installed) st.textContent = 'GitHub : gh n\'est pas installé sur le serveur';
  else if (!repoStatus.loggedIn) st.textContent = repoStatus.loginOpen ? 'GitHub : connexion en cours…' : 'GitHub : non connecté';
  else st.textContent = `GitHub : ${repoStatus.user}`;
  $('#repoGhLogin').hidden = !repoStatus.installed || repoStatus.loggedIn;
  $('#repoGhRefresh').hidden = $('#repoFilter').hidden = !repoStatus.loggedIn;
  $('#repoNewGh').hidden = !repoStatus.loggedIn; if (!repoStatus.loggedIn) $('#repoNewGh').value = '';
  $('#repoGh').classList.toggle('off', !repoStatus.loggedIn);
  if (repoStatus.loggedIn) loadRepos(); else { repos = []; renderRepos(); }
}
async function loadRepos(refresh) {
  const ul = $('#repoList'); ul.textContent = ''; ul.append(h('li', { class: 'empty' }, 'Chargement des dépôts…'));
  try { repos = await api('/api/repos' + (refresh ? '?refresh=1' : '')); } catch (e) { repos = []; ul.textContent = ''; ul.append(h('li', { class: 'empty' }, e.message)); return; }
  renderRepos();
}
function renderRepos() {
  const ul = $('#repoList'); ul.textContent = '';
  const f = $('#repoFilter').value.trim().toLowerCase();
  const items = repos.filter((r) => !f || r.name.toLowerCase().includes(f) || r.description.toLowerCase().includes(f));
  if (!items.length && repoStatus && repoStatus.loggedIn) ul.append(h('li', { class: 'empty' }, repos.length ? 'Aucun dépôt ne correspond' : 'Aucun dépôt'));
  for (const r of items.slice(0, 200)) {
    ul.append(h('li', { class: r.cloned ? 'cloned' : '', title: r.cloned ? 'Déjà présent sur le serveur' : 'Cloner ' + r.url, onclick: (e) => { if (!r.cloned) cloneRepo(r.name, e.currentTarget); } },
      h('span', { class: 'rn' }, r.name), r.private ? h('span', { class: 'lock' }, '🔒') : null, h('span', { class: 'rd' }, r.description),
      h('span', { class: 'rt' }, r.cloned ? 'déjà là' : ago(r.updatedAt))));
  }
}
async function cloneRepo(src, li) {
  if (li) { li.classList.add('busy'); li.querySelector('.rt').textContent = 'clonage…'; }
  toast(`Clonage de ${src}…`);
  try {
    const p = await api('/api/repos/clone', { method: 'POST', body: { repo: src } });
    toast(`${p.name} cloné`); closeRepoModal();
    await loadProjects(true); selectProject(p.id);
  } catch (e) { toast(e.message, true); if (li) { li.classList.remove('busy'); li.querySelector('.rt').textContent = ago(0); } }
}
$('#addProj').addEventListener('click', openRepoModal);
$('#repoClose').addEventListener('click', closeRepoModal);
$('#repoModal').addEventListener('mousedown', (e) => { if (e.target.id === 'repoModal') closeRepoModal(); });
$('#repoFilter').addEventListener('input', renderRepos);
$('#repoGhRefresh').addEventListener('click', () => loadRepos(true));
$('#repoGhLogin').addEventListener('click', () => openLogin({ key: 'gh', label: 'github.com' }));
$('#repoUrlForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#repoUrl').value.trim(); if (v) { cloneRepo(v); $('#repoUrl').value = ''; } });
$('#repoNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#repoNew').value.trim(); if (!name) return;
  const github = $('#repoNewGh').value || null;
  const btn = $('#repoNewForm button'); btn.disabled = true; btn.textContent = 'Création…';
  toast(`Création de ${name}…`);
  try {
    const p = await api('/api/repos/new', { method: 'POST', body: { name, github } });
    toast(p.warning ? `${p.name} créé en local, mais ${p.warning}` : `${p.name} créé${github ? ' et poussé sur GitHub' : ''}`, !!p.warning);
    closeRepoModal(); $('#repoNew').value = ''; await loadProjects(true); selectProject(p.id);
  } catch (err) { toast(err.message, true); }
  finally { btn.disabled = false; btn.textContent = 'Créer'; }
});
$('#repoPathForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const path = $('#repoPath').value.trim(); if (!path) return;
  try { const p = await api('/api/projects', { method: 'POST', body: { path } }); closeRepoModal(); $('#repoPath').value = ''; await loadProjects(true); selectProject(p.id); }
  catch (err) { toast(err.message, true); }
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
    this.acctEl = h('span', { class: 'acct-tag', hidden: '' });
    this.killBtn = h('button', { class: 'kill', title: 'Arrêter la session', onclick: () => this.stop() }, '■');
    this.maxBtn = h('button', { title: 'Agrandir (double-clic sur l\'en-tête)', onclick: () => this.toggleMax() }, '⤢');
    this.body = h('div', { class: 'pane-body' });
    this.el = h('div', { class: 'pane' },
      h('div', { class: 'pane-head', ondblclick: () => this.toggleMax() },
        h('span', { class: 'num' }, String(slot + 1)), this.stateEl, this.cmdEl, this.acctEl, h('span', { class: 'spacer' }), this.killBtn, this.maxBtn),
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
    this.accPick = null;
    let pick = null;
    if (multiAccount()) {
      const proj = S.projects.find((x) => x.id === this.deck.id);
      this.accPick = h('select', { class: 'acc-select' }, S.cfg.accounts.map((a) => h('option', { value: a.key }, a.label)));
      this.accPick.value = (proj && proj.account) || 'default';
      pick = h('label', { class: 'acc-pick' }, 'Compte', this.accPick);
    }
    this.body.append(h('div', { class: 'placeholder' }, h('div', {}, `Agent ${this.slot + 1} — libre`), h('div', { class: 'btns' }, btns), pick));
  }

  async start(cmd) {
    try {
      const r = this.body.getBoundingClientRect();
      const account = this.accPick ? this.accPick.value : undefined;
      const res = await api(`${P(this.deck.id)}/slots/${this.slot}/start`, { method: 'POST', body: { cmd, account, cols: Math.floor((r.width - 6) / 7.8), rows: Math.floor((r.height - 4) / 17) } });
      if (res.switched) toast(`Compte prévu saturé : agent lancé sur « ${accountLabel(res.account)} »`);
      this.connect();
      pollStatus();
    } catch (e) { toast(e.message, true); }
  }

  async stop() {
    if (!confirm(`Arrêter l'agent ${this.slot + 1} ? La session tmux sera tuée.`)) return;
    await api(`${P(this.deck.id)}/slots/${this.slot}/stop`, { method: 'POST' });
    this.teardown(); pollStatus();
  }

  async pasteFiles(files) {
    if (!files.length) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return toast('Terminal non connecté', true);
    for (const file of files) {
      toast(`Envoi de ${file.name || 'l\'image'} (${fmtSize(file.size)})…`);
      try {
        // Corps en binaire brut : avec le vrai type (ex. application/json) le parseur JSON global d'Express l'avalerait avant nous
        const r = await fetch(`${P(this.deck.id)}/paste?${q({ name: file.name || '', type: file.type || '' })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || r.statusText);
        this.send({ t: 'i', d: j.path + ' ' });
      } catch (e) { toast('Envoi impossible : ' + e.message, true); }
    }
    this.term && this.term.focus();
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
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'Space') return false;
      if (e.type === 'keydown' && e.altKey && /^[1-4]$/.test(e.key)) return false;
      // Shift+Entrée : nouvelle ligne dans Claude Code. xterm.js enverrait un simple CR (indistinguable d'Entrée).
      // On envoie la touche encodée « CSI 13;2u » (protocole kitty, Shift+Entrée sans ambiguïté), que tmux
      // (extended-keys on) transmet à Claude. ESC+CR, l'ancien choix, pouvait être lu comme Échap puis Entrée.
      // On bloque aussi keypress/keyup : sinon xterm envoie encore un CR nu sur le keypress, et le message part.
      if (e.shiftKey && e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) { if (e.type === 'keydown') this.send({ t: 'i', d: '\x1b[13;2u' }); return false; }
      // Ctrl+V : xterm.js enverrait ^V au pty (et bloquerait le collage natif) ; on laisse le navigateur coller,
      // ce qui déclenche l'événement paste (texte → xterm, fichier → pasteFiles)
      if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'v') return false;
      // Ctrl+Shift+C : copier (Ctrl+Shift+V colle déjà nativement)
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') { navigator.clipboard.writeText(term.getSelection()); return false; }
      return true;
    });
    // Collage de fichier (image, PDF, n'importe quoi) : Claude Code ne voit pas le presse-papiers du navigateur, on
    // envoie le fichier au serveur puis on tape son chemin dans le terminal (Claude le lit comme un fichier).
    holder.addEventListener('paste', (e) => {
      const items = [...(e.clipboardData && e.clipboardData.items || [])].filter((it) => it.kind === 'file');
      if (!items.length) return; // texte : xterm gère
      e.preventDefault(); e.stopPropagation();
      this.pasteFiles(items.map((it) => it.getAsFile()).filter(Boolean));
    }, true);
    // Glisser-déposer de fichiers sur le terminal : même chose
    this.el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); this.el.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => { this.el.classList.remove('drop'); if (!hasFiles(e)) return; e.preventDefault(); this.pasteFiles([...e.dataTransfer.files]); });
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
    this.el.classList.remove('st-off', 'st-idle', 'st-busy', 'st-attn', 'st-perm');
    this.el.classList.add('st-' + st);
    this.stateEl.textContent = { busy: 'Travaille…', idle: 'En attente', attn: 'A terminé — à toi', perm: 'Attend ton autorisation', off: 'Libre' }[st];
    const s = running && S.status[this.deck.id][this.slot];
    this.cmdEl.textContent = s && s.command && s.command !== 'bash' ? s.command : running ? 'shell' : '';
    const acct = s && s.account;
    this.acctEl.hidden = !(acct && (multiAccount() || acct !== 'default'));
    if (!this.acctEl.hidden) { this.acctEl.textContent = accountLabel(acct); this.acctEl.title = 'Compte Claude : ' + accountLabel(acct); }
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
    // Agents qui passent en « à toi » (hook Stop / permission) hors du projet affiché : point bleu + notification
    for (const p of S.projects) {
      for (let i = 0; i < S.cfg.slots; i++) {
        const k = p.id + ':' + i, st = slotState(p.id, i), s = S.status[p.id] && S.status[p.id][i];
        const stamp = needsYou(st) && s.attention ? s.attention.kind + s.attention.at : null;
        if (stamp && S.prevBusy[k] !== stamp && (p.id !== S.current || document.hidden || (s.attention && s.attention.voice))) notifyDone(p, i, st);
        S.prevBusy[k] = stamp;
      }
    }
    renderProjects();
    const d = S.decks.get(S.current);
    if (d) d.panes.forEach((p) => p.update());
  } catch {}
}

function notifyDone(p, slot, st) {
  const s = S.status[p.id] && S.status[p.id][slot];
  if (!s) return;
  if (s.attention && s.attention.voice) voiceAgentDone(p, slot, st, s.attention.message);
  if (p.id !== S.current) { S.done.add(p.id); store.set('done', [...S.done]); }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(`${p.name} · agent ${slot + 1}`, { body: st === 'perm' ? 'Demande ton autorisation' : 'A terminé, en attente de toi', tag: p.id + slot });
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

// ---------------------------------------------------------------- usage Claude (limites du plan)
function untilReset(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - S.now) / 60000));
  if (m < 60) return `${m} min`;
  if (m < 36 * 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { weekday: 'short' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

const planName = (a) => a.plan ? a.plan.replace(/^claude_/, '').toUpperCase() + (a.tier && /(\d+)x/.test(a.tier) ? ' ' + a.tier.match(/(\d+)x/)[1] + '×' : '') : '';

function usageBars(u) {
  const bars = h('div', { class: 'ubars' });
  const rank = (l) => ({ session: 0, weekly_all: 1 })[l.kind] ?? 2;
  const limits = [...(u.limits || [])].sort((a, b) => rank(a) - rank(b));
  for (const l of limits) {
    const cls = l.percent >= 100 ? 'full' : l.percent >= 80 ? 'hot' : l.percent >= 50 ? 'warn' : '';
    bars.append(h('div', { class: 'ubar ' + cls, title: l.resetsAt ? `Réinitialisation ${new Date(l.resetsAt).toLocaleString('fr-FR')}` : '' },
      h('span', { class: 'ul' }, l.label),
      h('span', { class: 'ur' }, l.resetsAt ? '↻ ' + untilReset(l.resetsAt) : ''),
      h('span', { class: 'up' }, `${Math.round(l.percent)} %`),
      h('div', { class: 'ut' }, h('div', { class: 'uf', style: `width:${Math.min(100, l.percent)}%` }))));
  }
  if (u.extra) {
    bars.append(h('div', { class: 'ubar ' + (u.extra.percent >= 80 ? 'hot' : ''), title: 'Crédits supplémentaires (extra usage)' },
      h('span', { class: 'ul' }, 'Crédits extra'), h('span', { class: 'ur' }, u.extra.limit != null ? `${u.extra.used ?? 0} / ${u.extra.limit} ${u.extra.currency || ''}` : ''),
      h('span', { class: 'up' }, `${Math.round(u.extra.percent)} %`),
      h('div', { class: 'ut' }, h('div', { class: 'uf', style: `width:${Math.min(100, u.extra.percent)}%` }))));
  }
  return bars;
}

// Un bloc par compte : connecté ou non, plan, usage, nombre de projets/agents qui s'en servent
function renderAccounts() {
  const list = $('#accountList');
  list.textContent = '';
  for (const a of S.accounts) {
    const u = a.usage || {};
    const el = h('div', { class: 'acct ' + (a.loggedIn ? 'on' : 'off') },
      h('div', { class: 'acct-head' },
        h('i', { class: 'acc-dot', title: a.loggedIn ? 'Connecté' : 'Non connecté' }),
        h('b', { title: a.label }, a.label),
        h('span', { class: 'plan' }, planName(a)),
        h('span', { class: 'spacer' }),
        h('span', { class: 'cnt', title: `${a.projects} projet(s) · ${a.agents} agent(s) en cours` }, `${a.projects}p · ${a.agents}a`),
        a.loggedIn ? h('button', { class: 'x', title: 'Actualiser l\'usage', onclick: () => pollUsage(true) }, '↻') : null,
        a.loggedIn ? h('button', { class: 'x', title: 'Changer de compte : déconnecte ce compte sur le VPS puis relance la connexion', onclick: () => switchAccount(a) }, '⇄') : null,
        a.isDefault ? null : h('button', { class: 'x', title: 'Retirer ce compte', onclick: () => removeAccount(a) }, '×')),
      a.email ? h('small', { class: 'email', title: a.org || '' }, a.email) : null);
    if (!a.loggedIn) el.append(h('button', { class: 'connect', onclick: () => openLogin(a) }, a.loginOpen ? 'Connexion en cours…' : 'Se connecter'));
    else if (a.loginOpen) el.append(h('button', { class: 'connect', title: 'Une fenêtre de connexion attend encore un code', onclick: () => openLogin(a) }, 'Connexion en cours…'));
    else {
      el.append(usageBars(u));
      if (u.error) el.append(h('div', { class: 'note' }, '⚠ ' + u.error + (u.stale ? ' (dernière valeur connue)' : '')));
    }
    list.append(el);
  }
  // Sélecteur de compte du projet courant
  const sel = $('#projAccount');
  sel.hidden = !multiAccount() || !S.current;
  if (!sel.hidden) {
    const p = S.projects.find((x) => x.id === S.current);
    sel.textContent = '';
    S.cfg.accounts.forEach((a) => sel.append(h('option', { value: a.key }, a.label)));
    sel.value = (p && p.account) || 'default';
  }
}

function renderSwitch() {
  const box = $('#switchBox');
  box.hidden = !multiAccount();
  const sw = (S.cfg && S.cfg.accountSwitch) || { enabled: false, threshold: 80 };
  $('#switchOn').checked = !!sw.enabled;
  if (document.activeElement !== $('#switchThr')) $('#switchThr').value = sw.threshold;
}
async function saveSwitch() {
  try {
    S.cfg.accountSwitch = await api('/api/account-switch', { method: 'POST', body: { enabled: $('#switchOn').checked, threshold: Number($('#switchThr').value) } });
    renderSwitch();
    toast(S.cfg.accountSwitch.enabled ? `Bascule auto au-delà de ${S.cfg.accountSwitch.threshold} %` : 'Bascule auto désactivée');
  } catch (e) { toast(e.message, true); }
}
$('#switchOn').addEventListener('change', saveSwitch);
$('#switchThr').addEventListener('change', saveSwitch);

let usageTimer;
async function pollUsage(refresh) {
  clearTimeout(usageTimer);
  usageTimer = setTimeout(pollUsage, 60000);
  let r;
  try { r = await api('/api/accounts' + (refresh === true ? '?refresh=1' : '')); } catch { return; }
  S.now = r.now; S.accounts = r.accounts;
  if (S.cfg) S.cfg.accounts = r.accounts.map(({ key, label }) => ({ key, label }));
  renderAccounts(); renderSwitch();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollUsage(); });

$('#projAccount').addEventListener('change', async (e) => {
  if (!S.current) return;
  try {
    await api(`${P(S.current)}/account`, { method: 'POST', body: { account: e.target.value } });
    const p = S.projects.find((x) => x.id === S.current); if (p) p.account = e.target.value;
    toast(`Nouveaux agents de ce projet : compte « ${accountLabel(e.target.value)} »`);
    renderProjects(); pollUsage();
    const d = S.decks.get(S.current); if (d) d.panes.forEach((pn) => { if (!pn.term) pn.showPlaceholder(); });
  } catch (err) { toast(err.message, true); }
});

$('#addAccount').addEventListener('click', async () => {
  const label = prompt('Nom du compte (ex : Perso, Boulot, Max 2)');
  if (!label) return;
  try { const a = await api('/api/accounts', { method: 'POST', body: { label } }); await pollUsage(); openLogin(a); }
  catch (e) { toast(e.message, true); }
});

async function switchAccount(a) {
  if (!confirm(`Changer de compte pour « ${a.label} » ?\nLe compte actuel (${a.email || 'connecté'}) sera déconnecté sur le VPS, puis une fenêtre de connexion s'ouvrira. Les agents déjà lancés continuent.`)) return;
  openLogin(a);
}
async function removeAccount(a) {
  if (!confirm(`Retirer le compte « ${a.label} » ?\nSes identifiants seront supprimés du VPS ; les projets qui l'utilisaient repassent sur le compte principal.`)) return;
  try { await api(`/api/accounts/${a.key}`, { method: 'DELETE' }); await loadProjects(); await pollUsage(); }
  catch (e) { toast(e.message, true); }
}

// Fenêtre de connexion : terminal attaché à la session tmux qui lance `claude auth login` pour ce compte
let loginTerm = null, loginWs = null;
function closeLogin() {
  $('#loginModal').hidden = true;
  if (loginWs) { const w = loginWs; loginWs = null; w.close(); }
  if (loginTerm) { loginTerm.dispose(); loginTerm = null; }
  pollUsage();
  if (!$('#repoModal').hidden) refreshRepoStatus();
}
async function openLogin(a) {
  const gh = a.key === 'gh';
  loginKey = a.key;
  $('#loginAccountName').textContent = a.label;
  $('#loginCode').value = '';
  $('#loginModal .title').textContent = gh ? 'Connexion GitHub' : 'Connexion Claude';
  $('#loginModal p').textContent = gh ? 'Note le code affiché, ouvre le lien github.com/login/device dans ton navigateur et saisis-le. Appuie sur Entrée ici quand c\'est demandé.'
    : 'Ouvre le lien affiché dans ton navigateur, connecte-toi avec le compte voulu, puis colle le code ici.';
  $('#loginModal').hidden = false;
  const holder = $('#loginTerm'); holder.textContent = '';
  const term = new Terminal({ fontFamily: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.15, theme: TERM_THEME, cursorBlink: true, scrollback: 500 });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon());
  try { term.loadAddon(new ClipboardAddon.ClipboardAddon()); } catch {}
  term.open(holder); fit.fit(); loginTerm = term;
  try { await api(gh ? '/api/repos/login' : `/api/accounts/${a.key}/login`, { method: 'POST', body: { cols: term.cols, rows: term.rows } }); }
  catch (e) { toast(e.message, true); return closeLogin(); }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term?${q({ login: a.key, cols: term.cols, rows: term.rows })}`);
  loginWs = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
  ws.onmessage = (e) => term.write(e.data);
  ws.onclose = () => { if (loginWs === ws) { loginWs = null; setTimeout(closeLogin, 600); } };
  term.onData((d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d })); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') return false; // collage natif du code OAuth
    return true;
  });
  term.focus();
}
$('#loginClose').addEventListener('click', closeLogin);
let loginKey = null;
$('#loginCancel').addEventListener('click', async () => {
  if (loginKey) { try { await api(`/api/accounts/${loginKey}/login`, { method: 'DELETE' }); toast('Connexion annulée'); } catch (e) { toast(e.message, true); } }
  closeLogin();
});
// Le collage dans le terminal peut échouer selon le navigateur : ce champ envoie le code (et Entrée) à la session
$('#loginCodeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#loginCode').value.trim(); if (!code) return;
  if (!loginWs || loginWs.readyState !== 1) return toast('Fenêtre de connexion non attachée', true);
  loginWs.send(JSON.stringify({ t: 'i', d: code + '\r' }));
  $('#loginCode').value = ''; if (loginTerm) loginTerm.focus();
});
$('#loginModal').addEventListener('mousedown', (e) => { if (e.target.id === 'loginModal') closeLogin(); });

// ---------------------------------------------------------------- contrôle vocal
// Une seule entrée (micro ou texte) → /api/voice/dispatch → un Claude headless envoie la consigne au bon agent
// et répond en une phrase, lue à voix haute. Quand cet agent finit, son dernier message est lu aussi.
const Voice = {
  rec: null, listening: false, busy: false, spoken: new Set(),
  get lang() { return (S.cfg && S.cfg.voice && S.cfg.voice.lang) || 'fr-FR'; },
  get canSpeak() { return 'speechSynthesis' in window && !(S.cfg && S.cfg.voice && S.cfg.voice.speak === false); },
};
// Enregistrement micro (MediaRecorder) → /api/voice/transcribe (gpt-4o-transcribe côté serveur, prompt = noms des
// projets). Arrêt automatique après ~1,4 s de silence une fois qu'on a parlé, ou au second clic, 30 s max.
const REC_MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
function voiceOpen() { $('#voiceBar').hidden = false; $('#voiceInput').focus(); }
function voiceClose() { voiceStop(true); if (Voice.audio) { Voice.audio.pause(); Voice.audio = null; } $('#voiceBar').hidden = true; }
$('#voiceFeedToggle').addEventListener('click', () => { const on = $('#voiceBar').classList.toggle('expanded'); $('#voiceFeedToggle').textContent = on ? '▾' : '▴'; });
function voiceSetState(st) {
  $('#voiceState').className = 'vs ' + (st || '');
  $('#micBtn').className = 'ghost icon ' + (st === 'listening' || st === 'thinking' ? st : '');
  $('#voiceInput').placeholder = st === 'listening' ? 'Je t\'écoute… (clic sur le micro ou Ctrl+Shift+Espace pour envoyer)' : st === 'thinking' ? 'Transcription…' : 'Parle, ou tape une consigne : « dis à cabal de lancer les tests »…';
}
function voiceLog(who, text, cls, link) {
  const ul = $('#voiceFeed');
  const txt = h('span', { class: 'txt' }, text);
  if (link) txt.append(' ', h('a', { onclick: () => { selectProject(link.id); const d = S.decks.get(link.id); const pn = d && d.panes[link.slot]; if (pn) { pn.setFocus(); pn.term && pn.term.focus(); } } }, '→ voir'));
  ul.append(h('li', { class: cls }, h('span', { class: 'who' }, who), txt));
  while (ul.children.length > 30) ul.firstChild.remove();
  ul.scrollTop = ul.scrollHeight;
}
// Voix : TTS serveur (OpenAI, style Jarvis) joué en mp3 ; la voix système du navigateur ne sert que de secours
let speakSeq = 0;
function speakFallback(clean) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = Voice.lang;
  const v = speechSynthesis.getVoices().find((x) => x.lang.replace('_', '-').toLowerCase() === Voice.lang.toLowerCase());
  if (v) u.voice = v;
  u.onstart = () => voiceSetState('speaking'); u.onend = () => voiceSetState(Voice.listening ? 'listening' : '');
  speechSynthesis.speak(u);
}
async function speak(text) {
  if (!(S.cfg && S.cfg.voice && S.cfg.voice.speak !== false) || !text) return;
  const clean = String(text).replace(/[`*_#>]+/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!clean) return;
  const seq = ++speakSeq;
  if (Voice.audio) { Voice.audio.pause(); Voice.audio = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (!S.cfg.voice.tts) return speakFallback(clean);
  try {
    const r = await fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: clean }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const url = URL.createObjectURL(await r.blob());
    if (seq !== speakSeq) return URL.revokeObjectURL(url);
    const a = new Audio(url); Voice.audio = a;
    a.onplay = () => voiceSetState('speaking');
    a.onended = a.onerror = () => { URL.revokeObjectURL(url); if (Voice.audio === a) { Voice.audio = null; voiceSetState(Voice.listening ? 'listening' : ''); } };
    await a.play();
  } catch (e) { console.warn('TTS', e); speakFallback(clean); }
}
async function voiceStart() {
  if (Voice.listening) return voiceStop(); // second appui : on arrête et on envoie
  voiceOpen();
  if (!(S.cfg && S.cfg.voice && S.cfg.voice.stt)) return toast('Transcription non configurée sur le serveur (OPENAI_API_KEY dans data/secrets.env) : tape ta consigne', true);
  if (!navigator.mediaDevices || !REC_MIME) return toast('Micro indisponible dans ce navigateur : tape ta consigne', true);
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
  catch (e) { return toast('Micro refusé : ' + e.message, true); }
  const rec = new MediaRecorder(stream, { mimeType: REC_MIME, audioBitsPerSecond: 48000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  // Détection de silence : RMS sur un AnalyserNode toutes les 100 ms
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream); const an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let spoke = false, silentSince = 0, noise = 0.004;
  const startedAt = Date.now();
  const tick = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (!spoke) noise = Math.max(0.002, noise * 0.9 + rms * 0.1); // bruit de fond estimé avant la parole
    const thr = Math.max(0.012, noise * 3);
    if (rms > thr) { spoke = true; silentSince = 0; }
    else if (spoke) { silentSince ||= Date.now(); if (Date.now() - silentSince > 1400) voiceStop(); }
    if (Date.now() - startedAt > 30000) voiceStop();
    if (!spoke && Date.now() - startedAt > 8000) voiceStop(true); // rien dit : on abandonne
  }, 100);
  Voice.rec = rec; Voice.listening = true; Voice.cleanup = () => { clearInterval(tick); stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); };
  Voice.onstop = async (cancel) => {
    Voice.cleanup(); Voice.listening = false; Voice.rec = null;
    if (cancel || !chunks.length) { voiceSetState(''); return; }
    const blob = new Blob(chunks, { type: REC_MIME.split(';')[0] });
    if (blob.size < 1500) { voiceSetState(''); return; }
    voiceSetState('thinking');
    try {
      const r = await fetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      if (!j.text) { voiceSetState(''); return toast('Rien compris, réessaie'); }
      $('#voiceInput').value = j.text;
      voiceSend(j.text);
    } catch (e) { voiceSetState(''); toast(e.message, true); }
  };
  rec.onstop = () => Voice.onstop(Voice.cancelled);
  $('#voiceInput').value = '';
  voiceSetState('listening');
  rec.start(250);
}
function voiceStop(cancel) {
  if (!Voice.rec) return;
  Voice.cancelled = !!cancel;
  try { Voice.rec.stop(); } catch { Voice.onstop && Voice.onstop(true); }
}
async function voiceSend(text) {
  if (Voice.busy || !text) return;
  Voice.busy = true; voiceSetState('thinking');
  voiceLog('toi', text, 'me');
  $('#voiceInput').value = '';
  try {
    const r = await api('/api/voice/dispatch', { method: 'POST', body: { text, current: S.current } });
    const where = r.projectName ? `${r.projectName} · agent ${(r.slot ?? 0) + 1}` : null;
    const link = r.projectId && r.slot != null ? { id: r.projectId, slot: r.slot } : null;
    voiceLog('deck', (r.action === 'send' ? `→ ${where} : « ${r.instruction} »  ` : r.action === 'start' ? `▶ ${where} démarré : « ${r.instruction} »  ` : '') + r.reply, 'bot', link);
    speak(r.reply);
    if (r.action !== 'reply') pollStatus();
  } catch (e) { voiceLog('deck', '⚠ ' + e.message, 'bot'); toast(e.message, true); }
  finally { Voice.busy = false; if (!Voice.listening) voiceSetState(''); }
}
// Un agent sollicité par la voix a fini : on affiche et on lit son dernier message
function voiceAgentDone(p, slot, st, message) {
  const key = p.id + ':' + slot + ':' + (S.status[p.id][slot].attention.at || 0);
  if (Voice.spoken.has(key)) return;
  Voice.spoken.add(key);
  const who = `${p.name} · agent ${slot + 1}`;
  const full = message ? message.replace(/\s+/g, ' ').trim() : '';
  voiceOpen();
  voiceLog(who, st === 'perm' ? 'demande ton autorisation' : (full || 'a terminé'), 'agent', { id: p.id, slot });
  // À l'oreille : la cible et les deux premières phrases, sans dépasser ~220 caractères (le détail est dans le fil)
  const sentences = full.replace(/[`*_#>]+/g, '').replace(/^[-•]\s*/gm, '').split(/(?<=[.!?])\s+/).filter(Boolean);
  let brief = sentences.slice(0, 2).join(' ');
  if (brief.length > 220) brief = brief.slice(0, 217).replace(/\s+\S*$/, '') + '…';
  speak(st === 'perm' ? `${p.name}, agent ${slot + 1} demande ton autorisation.` : `${p.name}, agent ${slot + 1} a terminé.${brief ? ' ' + brief : ''}`);
}
$('#micBtn').addEventListener('click', voiceStart);
$('#voiceClose').addEventListener('click', voiceClose);
$('#voiceForm').addEventListener('submit', (e) => { e.preventDefault(); voiceStop(true); voiceSend($('#voiceInput').value.trim()); });
if ('speechSynthesis' in window) speechSynthesis.getVoices();

// ---------------------------------------------------------------- sélection projet
async function selectProject(id) {
  const p = S.projects.find((x) => x.id === id);
  if (!p) return;
  S.current = id; store.set('current', id);
  S.done.delete(id); store.set('done', [...S.done]);
  $('#projTitle').textContent = p.name;
  $('#projPath').textContent = p.path;
  renderAccounts();
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
        h('span', { class: 'nm' }, e.name),
        e.dir ? null : h('button', { class: 'dl', title: 'Télécharger', onclick: (ev) => { ev.stopPropagation(); downloadFile(rel); } }, '⤓'),
        code ? h('span', { class: 'gs' }, code) : null));
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

// ---------------------------------------------------------------- upload de fichiers dans le projet
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const fmtSize = (n) => n < 1024 ? n + ' o' : n < 1048576 ? (n / 1024).toFixed(0) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo';
// Dossier cible : le dossier sélectionné dans l'arbre, ou le dossier du fichier sélectionné, sinon la racine
function uploadDir(fs) {
  const sel = fs.selected || '';
  if (!sel) return '';
  const parent = sel.split('/').slice(0, -1).join('/');
  const entry = (fs.listings.get(parent) || []).find((e) => e.name === sel.split('/').pop());
  return entry && entry.dir ? sel : parent;
}
async function uploadFiles(files, dir) {
  const fs = FS(); if (!fs || !files.length) return;
  if (dir == null) dir = uploadDir(fs);
  let ok = 0;
  for (const file of files) {
    const send = async (overwrite) => {
      const r = await fetch(`${P(fs.id)}/upload?${q({ dir, name: file.name, overwrite: overwrite ? 1 : 0 })}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
      const j = await r.json().catch(() => ({}));
      if (r.status === 409) { if (confirm(`${file.name} existe déjà dans ${dir || 'la racine'}. Remplacer ?`)) return send(true); return false; }
      if (!r.ok) throw new Error(j.error || r.statusText);
      return true;
    };
    try { if (await send(false)) ok++; } catch (e) { toast(`${file.name} : ${e.message}`, true); }
  }
  if (ok) toast(`${ok} fichier${ok > 1 ? 's' : ''} envoyé${ok > 1 ? 's' : ''} dans ${dir || 'la racine'}`);
  if (!fs.expanded.has(dir)) fs.expanded.add(dir);
  await refreshTree(fs, true);
}
$('#uploadBtn').addEventListener('click', () => { if (FS()) $('#uploadInput').click(); });
$('#uploadInput').addEventListener('change', async (e) => { await uploadFiles([...e.target.files]); e.target.value = ''; });
$('#tree').addEventListener('dragover', (e) => { if (hasFiles(e) && FS()) { e.preventDefault(); $('#tree').classList.add('drop'); } });
$('#tree').addEventListener('dragleave', () => $('#tree').classList.remove('drop'));
$('#tree').addEventListener('drop', (e) => { $('#tree').classList.remove('drop'); if (!hasFiles(e)) return; e.preventDefault(); uploadFiles([...e.dataTransfer.files]); });

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
    else prev.append(h('div', {}, `${tab.kind === 'large' ? 'Fichier trop volumineux' : 'Fichier binaire'} · ${(tab.size / 1024).toFixed(1)} Ko `, h('a', { href: raw + '&download=1', download: tab.path.split('/').pop(), style: 'color:var(--blue)' }, 'Télécharger')));
  }
}
// Téléchargement via un lien éphémère : le serveur force l'attachement et le nom de fichier
function downloadFile(rel) {
  const fs = FS(); if (!fs) return;
  const a = h('a', { href: `${P(fs.id)}/raw?${q({ path: rel, download: 1 })}`, download: rel.split('/').pop() });
  document.body.append(a); a.click(); a.remove();
}
function curPathOf(model) { return model.uri.path.split('/').slice(2).join('/'); }

$('#diffBtn').addEventListener('click', () => { diffMode = !diffMode; showActive(); });
$('#dlBtn').addEventListener('click', () => { const fs = FS(); if (fs && fs.active) downloadFile(fs.active); });
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
  else if (e.ctrlKey && e.shiftKey && e.code === 'Space') { e.preventDefault(); voiceStart(); }
  else if (e.key === 'Escape' && !$('#voiceBar').hidden && document.activeElement === $('#voiceInput')) { voiceClose(); }
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
  renderSwitch();
  setLayout(S.layout);
  await loadProjects();
  await pollStatus();
  pollUsage();
  const last = store.get('current');
  if (last && S.projects.some((p) => p.id === last)) selectProject(last);
  setInterval(pollStatus, 1500);
  setInterval(() => { if (!document.hidden) { refreshTree(FS()); syncOpenTabs(); } }, 4000);
  setInterval(() => loadProjects().catch(() => {}), 60000);
})();

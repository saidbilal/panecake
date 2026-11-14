// Claude Deck client: sidebar plus one xterm.js terminal per live `claude` process.
'use strict';
const TOKEN = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const api = async (route, body) => {
  const r = await fetch('/api/' + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-deck-token': TOKEN, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};
const native = (msg) => { try { window.webkit?.messageHandlers?.deck?.postMessage(msg); } catch {} };

const PREF_DEFAULTS = {
  fontSize: 13.5, lineHeight: 1.3, fontFamily: 'system', optionMeta: false, showAutomated: false, showHidden: false,
  maxLive: 10, sidebarWidth: 300, sidebarHidden: false, collapsed: {}, expanded: {}, folds: {}, lastSession: null, layout: null, lastCwd: null,
};
const FONTS = {
  system: 'ui-monospace, "SF Mono", Menlo, monospace',
  menlo: 'Menlo, monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, Menlo, monospace',
  fira: '"Fira Code", ui-monospace, Menlo, monospace',
  plex: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
};
let prefs = { ...PREF_DEFAULTS };
let prefTimer;
function savePrefs(patch) {
  Object.assign(prefs, patch);
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => api('prefs', prefs), 250);
}

const terms = new Map(); // termId -> client terminal
let data = { projects: [], ready: false, hiddenAutomated: 0 };
let external = {};
let currentTerm = null; // terminal in the active pane
let currentSession = null; // chat in the active pane, whether or not a process is live
let unread = new Set();
let history = [];
let histPos = -1;
let contentHits = null;
let visibleRows = [];
let cursorId = null;

// ---------- socket ----------
let ws;
let connectedResolve;
const connected = new Promise((r) => { connectedResolve = r; });
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${TOKEN}`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'out') terms.get(m.id)?.term.write(m.d);
    else if (m.t === 'replay') replayInto(m.id, m.d);
    else if (m.t === 'exit') onExit(m);
    else if (m.t === 'live') onLive(m);
    else if (m.t === 'changed') scheduleRefresh();
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onopen = async () => {
    const live = await api('terms');
    for (const t of live.terms) if (!terms.has(t.termId)) { createTerm(t.termId, t); wsSend({ t: 'replay', id: t.termId }); }
    onLive(live);
    sendVisible();
    connectedResolve?.();
  };
}
const wsSend = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };
const sendInput = (id, d) => wsSend({ t: 'input', id, d });

// ---------- terminals ----------
function createTerm(termId, info) {
  const host = el('div', 'termhost');
  const box = el('div', 'fitbox');
  host.append(box);
  $('terms').append(host);
  let t;
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: false,
    fontFamily: FONTS[prefs.fontFamily] || FONTS.system,
    fontSize: prefs.fontSize,
    lineHeight: prefs.lineHeight,
    scrollback: 20000,
    macOptionIsMeta: !!prefs.optionMeta,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    theme: {
      background: '#1a1a1a', foreground: '#e2e2e0', cursor: '#e2e2e0', cursorAccent: '#1a1a1a',
      selectionBackground: '#4a5a78', selectionInactiveBackground: '#3a4252',
      black: '#2a2a2a', red: '#e5766e', green: '#8fc27e', yellow: '#dcb56a', blue: '#7aa7e8', magenta: '#c69ae0', cyan: '#6fc0c4', white: '#d6d6d2',
      brightBlack: '#6f6f6b', brightRed: '#f28b82', brightGreen: '#a8d695', brightYellow: '#ecc987', brightBlue: '#97bdf2', brightMagenta: '#d7b3ec', brightCyan: '#8bd4d7', brightWhite: '#f4f4f0',
    },
    // Links written with terminal hyperlink codes follow the same Cmd+click rule.
    linkHandler: { activate: (e, uri) => { if (e.metaKey) openUri(uri, t); }, allowNonHttpProtocols: true },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(search);
  search.onDidChangeResults((r) => { if (find?.termId === termId) showFindCount(r.resultIndex, r.resultCount); });
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  t = { termId, term, fit, search, host, box, sessionId: info.sessionId || null, cwd: info.cwd, pid: info.pid, status: info.status, kind: info.kind || 'claude', project: info.project, label: info.label || null, startedAt: info.startedAt || Date.now(), muted: false, opened: false };
  terms.set(termId, t);

  term.onData((d) => { if (!t.muted) sendInput(termId, d); });
  term.onBinary((d) => { if (!t.muted) sendInput(termId, d); });
  term.attachCustomKeyEventHandler((e) => handleTermKey(e, t));

  // The TUI copies its own selections with OSC 52, which needs a clipboard bridge.
  term.parser.registerOscHandler(52, (payload) => {
    const b64 = payload.split(';')[1];
    if (b64 && b64 !== '?') {
      try {
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        api('clipboard', { text });
      } catch {}
    }
    return true;
  });
  return t;
}

function ensureOpened(t) {
  if (t.opened) return;
  t.term.open(t.box);
  t.opened = true;
  setupLinks(t);
  // An image on the clipboard goes to the CLI's own paste shortcut, which reads the
  // system clipboard itself. Plain text uses the terminal's normal paste.
  t.box.addEventListener('paste', (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const hasText = items.some((i) => i.type === 'text/plain');
    if (!hasText && items.some((i) => i.type.startsWith('image/'))) {
      e.preventDefault();
      e.stopPropagation();
      sendInput(t.termId, '\x16');
    }
  }, true);
}

function replayInto(id, d) {
  const t = terms.get(id);
  if (!t) return;
  // Replayed output would make the terminal re-answer old queries as if typed.
  t.muted = true;
  if (!t.opened) ensureOpened(t);
  t.term.write(d, () => {
    t.muted = false;
    fitTerm(t, true);
  });
}

function fitTerm(t, nudge) {
  if (!t.opened || !t.host.classList.contains('show')) return;
  try {
    t.fit.fit();
    const { cols, rows } = t.term;
    if (nudge) wsSend({ t: 'resize', id: t.termId, cols, rows: Math.max(2, rows - 1) });
    wsSend({ t: 'resize', id: t.termId, cols, rows });
  } catch {}
}

// ---------- grid ----------
// The right side is a tree of splits whose leaves are panes. A pane shows one
// terminal, or a notice or placeholder. Terminals not in a pane keep running.
let nextPaneId = 1;
const newLeaf = () => ({ type: 'leaf', id: nextPaneId++, termId: null, sessionId: null, notice: null, ended: null, mdPath: null });
const isEmptyPane = (p) => !p.termId && !p.notice && !p.ended && !p.mdPath;
const CONTENT_KEYS = ['termId', 'sessionId', 'notice', 'ended', 'mdPath'];
let root = newLeaf();
let activePane = root;

const leaves = (n = root) => (n.type === 'leaf' ? [n] : [...leaves(n.a), ...leaves(n.b)]);
function parentOf(target, n = root) {
  if (n.type === 'leaf') return null;
  if (n.a === target || n.b === target) return n;
  return parentOf(target, n.a) || parentOf(target, n.b);
}
function replaceNode(target, node, parent = parentOf(target)) {
  if (!parent) root = node;
  else if (parent.a === target) parent.a = node;
  else parent.b = node;
}
const paneShowingTerm = (termId) => leaves().find((p) => p.termId === termId);
const paneShowingChat = (id) => leaves().find((p) => p.sessionId === id);
const isAttached = (p) => leaves().includes(p);

function splitLeaf(target, zone) {
  const fresh = newLeaf();
  const parent = parentOf(target);
  const mk = (dir, a, b) => ({ type: 'split', dir, ratio: 0.5, a, b });
  const nodes = {
    left: () => mk('h', fresh, target),
    right: () => mk('h', target, fresh),
    top: () => mk('v', fresh, target),
    bottom: () => mk('v', target, fresh),
    // A corner gives the new item a quarter and leaves an empty slot beside it.
    tl: () => mk('h', mk('v', fresh, newLeaf()), target),
    bl: () => mk('h', mk('v', newLeaf(), fresh), target),
    tr: () => mk('h', target, mk('v', fresh, newLeaf())),
    br: () => mk('h', target, mk('v', newLeaf(), fresh)),
  };
  replaceNode(target, nodes[zone](), parent);
  return fresh;
}

function clearPane(p) { for (const k of CONTENT_KEYS) p[k] = null; }

// Takes a pane out of the grid. The last pane stays and simply empties.
function removeLeaf(p) {
  const parent = parentOf(p);
  if (!parent) { clearPane(p); return; }
  const sibling = parent.a === p ? parent.b : parent.a;
  replaceNode(parent, sibling);
  if (activePane === p) activePane = leaves(sibling)[0];
}

function ensurePaneEls(p) {
  if (p.el) return;
  p.el = el('div', 'pane');
  p.head = el('div', 'pane-head');
  p.titleEl = el('span', 'pane-title');
  const x = el('button', 'icon');
  x.title = 'Remove from grid (⌘W). It keeps running and stays in the sidebar.';
  x.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  x.onclick = (e) => { e.stopPropagation(); closePane(p); };
  x.onmousedown = (e) => e.stopPropagation();
  p.head.append(p.titleEl, x);
  p.head.addEventListener('mousedown', (e) => {
    if (leaves().length > 1) beginDrag(e, { type: 'pane', pane: p, title: paneTitle(p) });
  });
  p.stage = el('div', 'pane-stage');
  p.stage.pane = p;
  p.el.append(p.head, p.stage);
  p.el.addEventListener('mousedown', () => { if (activePane !== p) setActive(p, false); }, true);
  p.el.addEventListener('focusin', () => { if (activePane !== p) setActive(p, false); });
  stageObserver.observe(p.stage);
}

const stageObserver = new ResizeObserver((entries) => {
  for (const en of entries) {
    const p = en.target.pane;
    clearTimeout(p.fitTimer);
    p.fitTimer = setTimeout(() => { const t = terms.get(p.termId); if (t) fitTerm(t); }, 40);
  }
});

function paneTitle(p) {
  if (p.mdPath) return baseName(p.mdPath);
  const t = terms.get(p.termId);
  if (t?.kind === 'shell') return shellTitle(t);
  const row = p.sessionId ? findRow(p.sessionId) : null;
  if (row) return row.title;
  return t ? 'New session' : 'Empty';
}

function panelFor(p) {
  if (p.notice) {
    const n = el('div', 'panel');
    n.append(el('h2', '', p.notice.title), el('p', '', p.notice.body));
    const btns = el('div', 'btns');
    for (const [label, fn, primary] of p.notice.buttons) {
      const b = el('button', 'btn' + (primary ? ' primary-btn' : ''), label);
      b.onclick = fn;
      btns.append(b);
    }
    n.append(btns);
    return n;
  }
  if (p.mdPath) return mdViewFor(p);
  if (p.termId && terms.has(p.termId)) return null;
  if (p.ended) {
    const n = el('div', 'panel');
    const row = findRow(p.ended);
    n.append(el('h2', '', row?.title || 'Chat'), el('p', '', 'This chat’s process ended. Resume to continue where it left off.'));
    const b = el('button', 'btn primary-btn', 'Resume');
    b.onclick = () => openSession(p.ended, { pane: p });
    n.append(b);
    return n;
  }
  const n = el('div', 'panel');
  if (leaves().length > 1) {
    n.append(el('p', 'drop-hint', 'Drag a chat here'));
    return n;
  }
  n.append(el('h1', '', 'Claude Deck'), el('p', '', 'Pick a chat on the left, or start a new one. Every chat runs the real claude CLI.'));
  const keys = el('dl', 'keys');
  for (const [k, v] of [
    ['⌘N', 'New chat'], ['⌘J', 'New terminal in the active folder'], ['⌘K', 'Search chats'], ['⌘F', 'Find in this pane'],
    ['Drag a chat', 'Onto this area to build a grid'], ['⌘⌥↑ ⌘⌥↓', 'Previous or next chat in the sidebar'],
    ['⌘+click', 'A path or link in a terminal: Finder, browser, or .md preview'], ['⌘⌥← ⌘⌥→', 'Move between panes'], ['⌘[ ⌘]', 'Back or forward through what you opened'], ['⌘B', 'Toggle sidebar'],
  ]) keys.append(el('dt', '', k), el('dd', '', v));
  n.append(keys);
  return n;
}

function renderPane(p) {
  ensurePaneEls(p);
  p.titleEl.textContent = paneTitle(p);
  p.el.classList.toggle('active', p === activePane);
  const t = terms.get(p.termId);
  const panel = panelFor(p);
  // Leaving a kept element in place preserves its scroll position.
  for (const c of [...p.stage.children]) if (c !== t?.host && c !== panel && c !== find?.bar) c.remove();
  if (t) {
    if (t.host.parentNode !== p.stage) p.stage.append(t.host);
    t.host.classList.add('show');
    ensureOpened(t);
  }
  if (panel && panel.parentNode !== p.stage) p.stage.append(panel);
}

function renderGrid() {
  const build = (n) => {
    if (n.type === 'leaf') { ensurePaneEls(n); n.el.style.flex = ''; return n.el; }
    const box = el('div', `split ${n.dir}`);
    const a = build(n.a);
    const b = build(n.b);
    a.style.flex = `${n.ratio} 1 0`;
    b.style.flex = `${1 - n.ratio} 1 0`;
    const div = el('div', 'divider');
    div.addEventListener('mousedown', (e) => beginResize(e, n, box, a, b, div));
    box.append(a, div, b);
    return box;
  };
  const all = leaves();
  document.body.classList.toggle('multi', all.length > 1);
  const shown = new Set(all.map((p) => p.termId).filter(Boolean));
  // Terminals leaving the grid park off-screen so they keep their state.
  for (const t of terms.values()) {
    if (!shown.has(t.termId)) {
      t.host.classList.remove('show');
      if (t.host.parentNode !== $('terms')) $('terms').append(t.host);
    }
  }
  $('grid').replaceChildren(build(root));
  all.forEach(renderPane);
  if (!isAttached(activePane)) activePane = all[0];
  syncActive();
  sendVisible();
  saveLayout();
  // A find bar only makes sense while its pane still shows the same thing.
  if (find && (!isAttached(find.pane) || find.pane.termId !== find.termId || find.pane.mdPath !== find.mdPath)) closeFind(false);
  requestAnimationFrame(() => { for (const p of leaves()) { const t = terms.get(p.termId); if (t) fitTerm(t); } });
  updateHeader();
  renderList();
}

function sendVisible() { wsSend({ t: 'visible', ids: leaves().map((p) => p.termId).filter(Boolean) }); }

function syncActive() {
  currentTerm = activePane.termId;
  currentSession = activePane.sessionId;
  for (const p of leaves()) p.el?.classList.toggle('active', p === activePane);
}

function activeKey() {
  if (activePane.mdPath) return null;
  if (activePane.sessionId) return activePane.sessionId;
  return activePane.termId ? 'term:' + activePane.termId : null;
}

function setActive(p, focus = true, fromHistory = false) {
  activePane = p;
  syncActive();
  if (p.sessionId) { unread.delete(p.sessionId); savePrefs({ lastSession: p.sessionId }); }
  if (p.termId) unread.delete('term:' + p.termId);
  const key = activeKey();
  if (key && !fromHistory && history[histPos] !== key) {
    history = history.slice(0, histPos + 1);
    history.push(key);
    histPos = history.length - 1;
  }
  const cwd = activeCwd();
  if (cwd && cwd !== prefs.lastCwd) savePrefs({ lastCwd: cwd });
  updateHeader();
  renderList();
  renderSummary();
  if (focus) refocus();
}

// Puts a terminal in a pane. If another pane already shows it, that pane goes away.
function displayIn(p, t, opts = {}) {
  // A pane may also show this chat as ended, with no process behind it.
  for (const other of leaves()) {
    if (other === p) continue;
    if (other.termId === t.termId || (t.sessionId && other.sessionId === t.sessionId)) removeLeaf(other);
  }
  if (!isAttached(p)) p = activePane;
  p.termId = t.termId;
  p.sessionId = t.sessionId;
  p.notice = null;
  p.ended = null;
  p.mdPath = null;
  activePane = p;
  renderGrid();
  setActive(p, true, opts.fromHistory);
}

function closePane(p) {
  if (leaves().length < 2) return;
  removeLeaf(p);
  renderGrid();
  refocus();
}

function serializeLayout(n = root) {
  if (n.type === 'split') return { d: n.dir, r: n.ratio, a: serializeLayout(n.a), b: serializeLayout(n.b) };
  if (n.mdPath) return { md: n.mdPath };
  const t = terms.get(n.termId);
  return t?.kind === 'shell' ? { t: t.termId } : { s: n.sessionId || null };
}
let layoutTimer;
function saveLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => savePrefs({ layout: serializeLayout() }), 200);
}

// Rebuilds the saved grid. Slots whose chat is gone or open elsewhere collapse.
async function restoreLayout() {
  const usable = (n) => {
    if (n.d || n.md) return true;
    if (n.t) return terms.has(n.t);
    if (!n.s) return false;
    return !!(findRow(n.s) || liveTermFor(n.s)) && !external[n.s];
  };
  const build = (n) => {
    if (n.d) {
      const a = build(n.a);
      const b = build(n.b);
      if (!a || !b) return a || b;
      return { type: 'split', dir: n.d, ratio: n.r, a, b };
    }
    if (!usable(n)) return null;
    const leaf = newLeaf();
    leaf.want = n;
    return leaf;
  };
  const saved = prefs.layout || (prefs.lastSession ? { s: prefs.lastSession } : null);
  const tree = saved && build(saved);
  if (!tree) { renderGrid(); return; }
  root = tree;
  activePane = leaves()[0];
  renderGrid();
  await Promise.all(leaves().map(async (leaf) => {
    const w = leaf.want;
    delete leaf.want;
    if (w.md) { leaf.mdPath = w.md; return; }
    if (w.t) { const t = terms.get(w.t); if (t) displayIn(leaf, t); return; }
    await openSession(w.s, { pane: leaf });
  }));
  activePane = leaves()[0];
  renderGrid();
  setActive(activePane);
}

// ---------- Cmd+click links in terminals ----------
// The fullscreen TUI takes mouse clicks for itself, so Deck finds the text under
// the pointer and intercepts Cmd+click before the terminal sees it. Only text that
// names something real on disk, or a web address, gets underlined.
let metaHeld = false;
let pointer = null;
const PATH_CHAR = /^[\p{L}\p{N}\p{M}_\-./~@+%=#:&?*$!\\]$/u;

function cellUnder(t, x, y) {
  const screen = t.term.element?.querySelector('.xterm-screen');
  if (!screen) return null;
  const r = screen.getBoundingClientRect();
  const col = Math.floor(((x - r.left) / r.width) * t.term.cols);
  const row = Math.floor(((y - r.top) / r.height) * t.term.rows);
  if (col < 0 || row < 0 || col >= t.term.cols || row >= t.term.rows) return null;
  return { col, row };
}

function readCells(t, y) {
  const line = t.term.buffer.active.getLine(y);
  const out = [];
  if (!line) return out;
  for (let x = 0; x < t.term.cols; x++) {
    const c = line.getCell(x);
    if (c && c.getWidth() !== 0) out.push({ ch: c.getChars() || ' ', x, y });
  }
  return out;
}

// A soft-wrapped line reads as one line.
function logicalLine(t, absY) {
  const b = t.term.buffer.active;
  let y = absY;
  while (y > 0 && b.getLine(y)?.isWrapped) y--;
  let cells = readCells(t, y);
  for (let n = y + 1; b.getLine(n)?.isWrapped; n++) cells = cells.concat(readCells(t, n));
  return cells;
}

function runAround(cells, i) {
  if (!cells[i] || !isPathCell(cells, i)) return null;
  let a = i;
  let b = i;
  while (a > 0 && isPathCell(cells, a - 1)) a--;
  while (b < cells.length - 1 && isPathCell(cells, b + 1)) b++;
  return [a, b];
}
function isPathCell(cells, i) {
  const ch = cells[i].ch;
  if (PATH_CHAR.test(ch)) return true;
  // An escaped space, as in my\ folder.
  return ch === ' ' && cells[i - 1]?.ch === '\\';
}

// Turns a stretch of cells into a candidate, dropping punctuation around it.
function candidate(cells, a, b) {
  while (a <= b && /[:*!?=]/.test(cells[a].ch)) a++;
  while (b >= a && /[.,:;!?*=]/.test(cells[b].ch)) b--;
  if (a > b) return null;
  const text = cells.slice(a, b + 1).map((c) => c.ch).join('').replace(/\\ /g, ' ');
  if (text.length < 2 && text !== '~' && text !== '.') return null;
  return { text, cells: cells.slice(a, b + 1) };
}

function tokenAt(t, x, y) {
  const cell = cellUnder(t, x, y);
  if (!cell) return null;
  const absY = t.term.buffer.active.viewportY + cell.row;
  const cells = logicalLine(t, absY);
  const i = cells.findIndex((c) => c.x === cell.col && c.y === absY);
  if (i < 0) return null;
  const list = [];
  // Quotes and backticks let a path contain spaces.
  for (const q of ['`', '"', "'"]) {
    let l = i;
    while (l >= 0 && cells[l].ch !== q) l--;
    let r = i;
    while (r < cells.length && cells[r].ch !== q) r++;
    if (l >= 0 && r < cells.length && l < i && i < r) {
      const c = candidate(cells, l + 1, r - 1);
      if (c) list.push(c);
    }
  }
  const run = runAround(cells, i);
  if (!run) return list.length ? { list, key: list[0].text } : null;
  const whole = candidate(cells, run[0], run[1]);
  if (whole) {
    const web = /^https?:\/\/\S+/.test(whole.text);
    if (web) return { web: whole.text, list: [whole], key: whole.text };
    list.push(whole);
    if (whole.text.startsWith('file://')) return { list, key: whole.text };
    // The TUI breaks long lines itself, so a path may carry on across a real line break.
    const cols = t.term.cols;
    const last = whole.cells[whole.cells.length - 1];
    if (last.x >= cols - 5) {
      const next = readCells(t, last.y + 1);
      const first = next.findIndex((c) => c.ch !== ' ');
      const r2 = first >= 0 && runAround(next, first);
      const tail = r2 && candidate(next, r2[0], r2[1]);
      if (tail) list.push({ text: whole.text + tail.text, cells: whole.cells.concat(tail.cells) });
    }
    const head = whole.cells[0];
    if (head.y > 0 && head.x < 8 && cells[0].y === head.y) {
      const prev = readCells(t, head.y - 1);
      let endAt = prev.length - 1;
      while (endAt >= 0 && prev[endAt].ch === ' ') endAt--;
      if (endAt >= 0 && prev[endAt].x >= cols - 5) {
        const r3 = runAround(prev, endAt);
        const before = r3 && candidate(prev, r3[0], r3[1]);
        if (before) list.push({ text: before.text + whole.text, cells: before.cells.concat(whole.cells) });
      }
    }
    // --out=docs/report.md
    const eq = whole.text.lastIndexOf('=');
    if (eq > 0) list.push({ text: whole.text.slice(eq + 1), cells: whole.cells.slice(eq + 1) });
  }
  return list.length ? { list, key: list.map((c) => c.text).join('\n') } : null;
}

async function resolveToken(t, tok) {
  if (tok.web) return { web: tok.web, cells: tok.list[0].cells };
  t.linkCache ||= new Map();
  const hit = t.linkCache.get(tok.key);
  let match;
  if (hit && Date.now() - hit.at < 3000) match = await hit.res;
  else {
    const res = api('resolve-path', { termId: t.termId, candidates: tok.list.map((c) => c.text) }).then((r) => r.match);
    t.linkCache.set(tok.key, { at: Date.now(), res });
    match = await res;
  }
  return match ? { ...match, cells: tok.list[match.index].cells } : null;
}

function clearLinkHover(t) {
  t.hoverKey = null;
  t.hoverSeq = (t.hoverSeq || 0) + 1;
  t.linkOverlay?.replaceChildren();
  t.host.classList.remove('link-hover');
}

async function updateLinkHover(t) {
  if (!pointer || pointer.t !== t) return;
  const tok = tokenAt(t, pointer.x, pointer.y);
  const key = tok ? tok.key : null;
  if (key === t.hoverKey) return;
  clearLinkHover(t);
  t.hoverKey = key;
  if (!tok) return;
  const seq = t.hoverSeq;
  const res = await resolveToken(t, tok);
  if (seq !== t.hoverSeq || !metaHeld || !res) return;
  drawLinkUnderline(t, res.cells);
}

function drawLinkUnderline(t, cells) {
  const screen = t.term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const host = t.host.getBoundingClientRect();
  const cw = screen.width / t.term.cols;
  const ch = screen.height / t.term.rows;
  const top = t.term.buffer.active.viewportY;
  const rows = new Map();
  for (const c of cells) {
    const r = rows.get(c.y) || { min: c.x, max: c.x };
    r.min = Math.min(r.min, c.x);
    r.max = Math.max(r.max, c.x);
    rows.set(c.y, r);
  }
  const bars = [];
  for (const [y, r] of rows) {
    const bar = el('div');
    bar.style.left = screen.left - host.left + r.min * cw + 'px';
    bar.style.top = screen.top - host.top + (y - top + 1) * ch - 2 + 'px';
    bar.style.width = (r.max - r.min + 1) * cw + 'px';
    bars.push(bar);
  }
  t.linkOverlay.replaceChildren(...bars);
  t.host.classList.add('link-hover');
}

function setupLinks(t) {
  t.linkOverlay = el('div', 'link-overlay');
  t.host.append(t.linkOverlay);
  t.box.addEventListener('mousemove', (e) => {
    pointer = { t, x: e.clientX, y: e.clientY };
    metaHeld = e.metaKey;
    if (e.metaKey) updateLinkHover(t);
    else if (t.hoverKey !== undefined && t.hoverKey !== null) clearLinkHover(t);
  }, true);
  t.box.addEventListener('mouseleave', () => {
    if (pointer?.t === t) pointer = null;
    clearLinkHover(t);
  });
  t.box.addEventListener('mousedown', (e) => {
    if (!e.metaKey || e.button !== 0) return;
    const tok = tokenAt(t, e.clientX, e.clientY);
    if (!tok) return; // terminal hyperlinks and everything else carry on as normal
    // A plain word only counts once hover has confirmed it names something real.
    const bare = !tok.web && tok.list.every((c) => !/[./~]/.test(c.text));
    if (bare && !t.linkOverlay.children.length) return;
    e.preventDefault();
    e.stopPropagation();
    t.swallowUp = true;
    activateToken(t, tok);
  }, true);
  t.box.addEventListener('mouseup', (e) => {
    if (t.swallowUp) { t.swallowUp = false; e.stopPropagation(); }
  }, true);
  const again = () => {
    if (!metaHeld || pointer?.t !== t) return;
    t.hoverKey = undefined; // the text under the pointer may have changed
    updateLinkHover(t);
  };
  t.term.onScroll(again);
  let writeTimer;
  t.term.onWriteParsed(() => {
    if (!metaHeld || pointer?.t !== t) return;
    clearTimeout(writeTimer);
    writeTimer = setTimeout(again, 120);
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Meta') { metaHeld = true; if (pointer) { pointer.t.hoverKey = undefined; updateLinkHover(pointer.t); } }
}, true);
window.addEventListener('keyup', (e) => {
  if (e.key === 'Meta') { metaHeld = false; if (pointer) clearLinkHover(pointer.t); }
}, true);
window.addEventListener('blur', () => {
  metaHeld = false;
  if (pointer) clearLinkHover(pointer.t);
});

async function activateToken(t, tok) {
  const res = await resolveToken(t, tok);
  if (res) openTarget(res, paneShowingTerm(t.termId));
}
function openTarget(res, fromPane) {
  if (res.web) api('open-url', { url: res.web });
  else if (res.kind === 'md') openMd(res.path, fromPane);
  else api('reveal', { path: res.path });
}
async function openUri(uri, t) {
  if (/^https?:/i.test(uri)) return api('open-url', { url: uri });
  if (!/^file:/i.test(uri)) return;
  const { match } = await api('resolve-path', { termId: t.termId, candidates: [uri] });
  if (match) openTarget(match, paneShowingTerm(t.termId));
}

// ---------- Markdown preview ----------
// Opens beside the pane it was clicked in and reuses an existing preview. Focus
// stays in the terminal so typing can carry on.
function openMd(path, fromPane) {
  const existing = leaves().find((p) => p.mdPath);
  if (existing) existing.mdPath = path;
  else {
    const from = fromPane && isAttached(fromPane) ? fromPane : activePane;
    const dest = splitLeaf(from, 'right');
    dest.mdPath = path;
  }
  renderGrid();
  refocus();
}

function mdViewFor(p) {
  if (!p.mdView) {
    p.mdView = el('div', 'md-view');
    p.mdBody = el('article', 'md-body');
    p.mdView.append(p.mdBody);
    p.mdBody.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      followMdLink(a.getAttribute('href') || '', p);
    });
  }
  if (p.mdShown !== p.mdPath) {
    p.mdShown = p.mdPath;
    p.mdMtime = null;
    p.mdBody.replaceChildren();
    p.mdView.scrollTop = 0;
    loadMd(p);
  }
  return p.mdView;
}

async function loadMd(p) {
  const path = p.mdPath;
  if (!path) return;
  const r = await api('md', { path, since: p.mdMtime });
  if (p.mdPath !== path || r.unchanged) return;
  if (r.missing || r.error) {
    p.mdMtime = null;
    p.mdBody.replaceChildren(el('div', 'md-missing', r.error || 'This file no longer exists.'));
    return;
  }
  p.mdMtime = r.mtime;
  const scroll = p.mdView.scrollTop;
  const text = r.text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = DOMPurify.sanitize(marked.parse(text, { gfm: true }), { FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'] });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = dirName(path);
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:)/i.test(src)) {
      // Local previews make no network requests, so remote images stay as links.
      if (/^https?:/i.test(src)) {
        const a = doc.createElement('a');
        a.setAttribute('href', src);
        a.textContent = img.getAttribute('alt') || src;
        img.replaceWith(a);
      }
      continue;
    }
    img.setAttribute('src', `/local-image?token=${TOKEN}&path=${encodeURIComponent(resolveFrom(base, src))}`);
  }
  p.mdBody.replaceChildren(...doc.body.childNodes);
  p.mdView.scrollTop = scroll;
  if (find?.pane === p) runFind('refresh');
}

function resolveFrom(base, rel) {
  let clean = rel.split(/[?#]/)[0];
  try { clean = decodeURIComponent(clean); } catch {}
  if (clean.startsWith('/')) return clean;
  const parts = base.split('/');
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/') || '/';
}

function followMdLink(href, p) {
  if (href.startsWith('#')) {
    const id = decodeURIComponent(href.slice(1));
    const target = [...p.mdBody.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((h) => slug(h.textContent) === id);
    target?.scrollIntoView({ block: 'start' });
    return;
  }
  if (/^https?:/i.test(href)) { api('open-url', { url: href }); return; }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // mailto: and the like stay inert
  const target = resolveFrom(dirName(p.mdPath), href);
  if (/\.(md|markdown|mdx)$/i.test(target)) { p.mdPath = target; renderGrid(); }
  else api('reveal', { path: target });
}
const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

// Shows edits to the file as they happen, such as Claude writing to it.
setInterval(() => { for (const p of leaves()) if (p.mdPath && p.mdShown === p.mdPath) loadMd(p); }, 2000);

// ---------- find in a pane (Cmd+F) ----------
// Terminals use xterm's search add-on, which also covers scrollback. A chat's
// fullscreen TUI keeps its own history, so there only the visible screen is
// searchable. Markdown previews are searched here and highlighted without
// touching the page, so matches can span formatting like **bold** text.
let find = null;
let lastFindQuery = '';
let findCase = false;
const FIND_DECOR = {
  matchBackground: '#5c4d24', matchBorder: '#7a6630', matchOverviewRuler: '#e0b050',
  activeMatchBackground: '#d97757', activeMatchBorder: '#f0a080', activeMatchColorOverviewRuler: '#d97757',
};

function findKind(p) {
  if (p.mdPath && p.mdView) return 'md';
  if (p.termId && terms.get(p.termId)?.opened) return 'term';
  return null;
}

function openFind() {
  const p = activePane;
  const kind = findKind(p);
  if (!kind) return;
  if (find && find.pane === p) { find.input.focus(); find.input.select(); return; }
  closeFind(false);
  const bar = el('div', 'findbar');
  const input = el('input');
  input.placeholder = 'Find';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const count = el('span', 'find-count');
  const btn = (label, title, fn) => {
    const b = el('button', 'icon', label);
    b.title = title;
    b.onmousedown = (e) => e.preventDefault(); // keep typing focus in the box
    b.onclick = fn;
    return b;
  };
  // In a terminal the newest output is at the bottom, so Enter searches upward,
  // as in VS Code's terminal. In a document it reads downward.
  const upFirst = kind === 'term';
  const caseBtn = btn('Aa', 'Match case', () => {
    findCase = !findCase;
    caseBtn.classList.toggle('on', findCase);
    runFind('recase');
  });
  caseBtn.classList.add('case');
  caseBtn.classList.toggle('on', findCase);
  const up = btn('', upFirst ? 'Previous match, older (Enter)' : 'Previous match (Shift+Enter)', () => runFind(upFirst ? 'forward' : 'back'));
  up.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4"/></svg>';
  const down = btn('', upFirst ? 'Next match, newer (Shift+Enter)' : 'Next match (Enter)', () => runFind(upFirst ? 'back' : 'forward'));
  down.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 6l4 4 4-4"/></svg>';
  const close = btn('', 'Close (Esc)', () => closeFind());
  close.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  bar.append(input, count, caseBtn, up, down, close);
  find = { pane: p, kind, termId: p.termId, mdPath: p.mdPath, bar, input, count, index: -1, ranges: [], upFirst };
  input.addEventListener('input', () => runFind('type'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
    else if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey ? 'back' : 'forward'); }
  });
  p.stage.append(bar);
  input.value = lastFindQuery;
  input.focus();
  input.select();
  if (input.value) runFind('type');
}

function closeFind(refocusAfter = true) {
  if (!find) return;
  const f = find;
  find = null;
  if (f.kind === 'term') {
    const t = terms.get(f.termId);
    if (t) { try { t.search.clearDecorations(); } catch {} t.term.clearSelection(); }
  } else if (window.CSS?.highlights) {
    CSS.highlights.delete('deck-find');
    CSS.highlights.delete('deck-find-active');
  }
  f.bar.remove();
  if (refocusAfter) refocus();
}

function showFindCount(index, total) {
  if (!find) return;
  const q = find.input.value;
  find.count.classList.toggle('none', !!q && total === 0);
  if (!q) find.count.textContent = '';
  else if (total === 0) find.count.textContent = 'No results';
  else if (index < 0) find.count.textContent = `${total}+`;
  else find.count.textContent = `${index + 1} of ${total}`;
}

// mode: 'type' (query changed), 'recase', 'forward' (Enter), 'back' (Shift+Enter), 'refresh'.
function runFind(mode) {
  if (!find) return;
  const q = find.input.value;
  lastFindQuery = q;
  if (find.kind === 'term') {
    const t = terms.get(find.termId);
    if (!t) return;
    if (!q) { t.search.clearDecorations(); t.term.clearSelection(); showFindCount(-1, 0); return; }
    const opts = { caseSensitive: findCase, decorations: FIND_DECOR };
    // The add-on keeps its last results and does not notice an options change.
    if (mode === 'recase') { t.search.clearDecorations(); mode = 'type'; }
    // Upward is findPrevious; typing starts from the newest output.
    const upward = mode === 'back' ? !find.upFirst : find.upFirst;
    if (mode === 'type') t.search.findPrevious(q, { ...opts, incremental: true });
    else if (upward) t.search.findPrevious(q, opts);
    else t.search.findNext(q, opts);
    return;
  }
  if (mode === 'recase') mode = 'type';
  const p = find.pane;
  find.ranges = q ? mdRanges(p.mdBody, q, findCase) : [];
  const n = find.ranges.length;
  if (!n) find.index = -1;
  else if (mode === 'type' || find.index < 0) find.index = firstVisibleRange(p, find.ranges);
  else if (mode === 'forward') find.index = (find.index + 1) % n;
  else if (mode === 'back') find.index = (find.index - 1 + n) % n;
  else find.index = Math.min(find.index, n - 1);
  if (window.CSS?.highlights && window.Highlight) {
    CSS.highlights.set('deck-find', new Highlight(...find.ranges));
    if (n) CSS.highlights.set('deck-find-active', new Highlight(find.ranges[find.index]));
    else CSS.highlights.delete('deck-find-active');
  }
  if (n && mode !== 'refresh') revealRange(p, find.ranges[find.index]);
  showFindCount(find.index, n);
}

// Lowercases one character at a time so positions stay put. Turkish İ would
// otherwise become two characters.
function foldCase(s) {
  let out = '';
  for (const ch of s) {
    if (ch === 'İ') { out += 'i'; continue; }
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

function mdRanges(body, q, caseSensitive) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ n, start: text.length });
    text += n.nodeValue;
  }
  const hay = caseSensitive ? text : foldCase(text);
  const needle = caseSensitive ? q : foldCase(q);
  const out = [];
  let k = 0;
  // Matches come in order, so one pointer walks the text nodes.
  const at = (pos, isEnd) => {
    while (k < nodes.length - 1 && (isEnd ? nodes[k + 1].start < pos : nodes[k + 1].start <= pos)) k++;
    return nodes[k];
  };
  for (let i = hay.indexOf(needle); i >= 0 && needle && out.length < 5000; i = hay.indexOf(needle, i + needle.length)) {
    const a = at(i, false);
    const r = document.createRange();
    r.setStart(a.n, i - a.start);
    const b = at(i + needle.length, true);
    r.setEnd(b.n, i + needle.length - b.start);
    out.push(r);
  }
  return out;
}

function firstVisibleRange(p, ranges) {
  const top = p.mdView.getBoundingClientRect().top;
  const i = ranges.findIndex((r) => r.getBoundingClientRect().top >= top);
  return i < 0 ? 0 : i;
}

function revealRange(p, r) {
  const rect = r.getBoundingClientRect();
  const view = p.mdView.getBoundingClientRect();
  if (rect.top < view.top + 48 || rect.bottom > view.bottom - 24) {
    p.mdView.scrollTop += rect.top - view.top - view.height / 3;
  }
}

// ---------- dragging chats into the grid ----------
let drag = null;
function beginDrag(e, payload) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const move = (ev) => {
    if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 5) startDrag(payload);
    if (drag) updateDrag(ev);
  };
  const up = (ev) => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    if (drag) finishDrag(ev);
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
}
function startDrag(payload) {
  drag = { payload, target: null, zone: null };
  closeMenus();
  $('drop-layer').hidden = false;
  $('drag-ghost').textContent = payload.title;
  $('drag-ghost').hidden = false;
}
function zoneAt(rect, x, y, leaf) {
  if (isEmptyPane(leaf)) return 'center';
  const rx = (x - rect.left) / rect.width;
  const ry = (y - rect.top) / rect.height;
  const left = rx < 0.3;
  const right = rx > 0.7;
  const top = ry < 0.3;
  const bottom = ry > 0.7;
  if (top && left) return 'tl';
  if (top && right) return 'tr';
  if (bottom && left) return 'bl';
  if (bottom && right) return 'br';
  if (left) return 'left';
  if (right) return 'right';
  if (top) return 'top';
  if (bottom) return 'bottom';
  return 'center';
}
const ZONES = {
  center: [0, 0, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5],
  tl: [0, 0, 0.5, 0.5], tr: [0.5, 0, 0.5, 0.5], bl: [0, 0.5, 0.5, 0.5], br: [0.5, 0.5, 0.5, 0.5],
};
function updateDrag(ev) {
  const g = $('drag-ghost');
  g.style.left = ev.clientX + 12 + 'px';
  g.style.top = ev.clientY + 10 + 'px';
  let hit = null;
  for (const p of leaves()) {
    const r = p.el.getBoundingClientRect();
    if (ev.clientX >= r.left && ev.clientX < r.right && ev.clientY >= r.top && ev.clientY < r.bottom) { hit = { p, r }; break; }
  }
  const prev = $('drop-preview');
  const src = drag.payload.pane;
  // A lone pane has nowhere to go, and a pane onto itself means nothing.
  if (!hit || hit.p === src) {
    drag.target = null;
    prev.hidden = true;
    return;
  }
  const zone = zoneAt(hit.r, ev.clientX, ev.clientY, hit.p);
  drag.target = hit.p;
  drag.zone = zone;
  const [fx, fy, fw, fh] = ZONES[zone];
  prev.style.left = hit.r.left + fx * hit.r.width + 3 + 'px';
  prev.style.top = hit.r.top + fy * hit.r.height + 3 + 'px';
  prev.style.width = fw * hit.r.width - 6 + 'px';
  prev.style.height = fh * hit.r.height - 6 + 'px';
  const empty = isEmptyPane(hit.p);
  prev.firstElementChild.textContent = zone === 'center' ? (empty ? 'Open here' : src ? 'Swap' : 'Replace') : 'Split here';
  prev.hidden = false;
}
function endDragUi() {
  drag = null;
  $('drop-layer').hidden = true;
  $('drop-preview').hidden = true;
  $('drag-ghost').hidden = true;
}
function finishDrag() {
  const { payload, target, zone } = drag;
  endDragUi();
  if (!target) { refocus(); return; }
  if (payload.type === 'pane') {
    const src = payload.pane;
    if (zone === 'center') {
      // Dropping on a pane's middle swaps the two.
      for (const k of CONTENT_KEYS) [src[k], target[k]] = [target[k], src[k]];
      activePane = target;
      renderGrid();
      setActive(target);
      return;
    }
    const content = Object.fromEntries(CONTENT_KEYS.map((k) => [k, src[k]]));
    removeLeaf(src);
    const dest = splitLeaf(target, zone);
    Object.assign(dest, content);
    activePane = dest;
    renderGrid();
    setActive(dest);
    return;
  }
  const dest = zone === 'center' ? target : splitLeaf(target, zone);
  activePane = dest;
  renderGrid();
  openRow(payload.row, { pane: dest });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); endDragUi(); refocus(); }
}, true);

function beginResize(e, node, box, aEl, bEl, div) {
  e.preventDefault();
  e.stopPropagation();
  div.classList.add('dragging');
  $('drop-layer').hidden = false;
  $('drop-layer').style.cursor = node.dir === 'h' ? 'col-resize' : 'row-resize';
  const move = (ev) => {
    const r = box.getBoundingClientRect();
    const f = node.dir === 'h' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    node.ratio = Math.max(0.15, Math.min(0.85, f));
    aEl.style.flex = `${node.ratio} 1 0`;
    bEl.style.flex = `${1 - node.ratio} 1 0`;
  };
  const up = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    div.classList.remove('dragging');
    $('drop-layer').hidden = true;
    $('drop-layer').style.cursor = '';
    saveLayout();
    refocus();
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
}

function onExit(m) {
  const t = terms.get(m.id);
  if (!t) return;
  terms.delete(m.id);
  const p = paneShowingTerm(m.id);
  try { t.term.dispose(); } catch {}
  t.host.remove();
  if (p) {
    const row = m.sessionId ? findRow(m.sessionId) : null;
    p.termId = null;
    if (m.kind === 'shell' || !row || row.pending) {
      // Nothing to resume: a closed terminal, or a chat that never got a message.
      p.sessionId = null;
      removeLeaf(p);
      scheduleRefresh();
    } else if (!m.evicted) {
      p.sessionId = m.sessionId;
      p.ended = m.sessionId;
    }
    renderGrid();
    refocus();
  } else {
    renderList();
    renderSummary();
  }
}

function onLive(m) {
  external = m.external || {};
  let retitled = false;
  for (const info of m.terms || []) {
    const t = terms.get(info.termId);
    if (!t) continue;
    const was = t.status;
    t.status = info.status;
    t.pid = info.pid;
    if (t.label !== info.label) {
      // A program finishing in a terminal nobody is looking at is worth flagging.
      if (t.kind === 'shell' && t.label && !info.label && !paneShowingTerm(t.termId)) unread.add('term:' + t.termId);
      t.label = info.label;
      retitled = true;
    }
    if (info.sessionId && info.sessionId !== t.sessionId) {
      // /clear, /resume and forks move a process onto a new session id.
      t.sessionId = info.sessionId;
      const p = paneShowingTerm(t.termId);
      if (p) { p.sessionId = info.sessionId; retitled = true; if (p === activePane) setActive(p, false); }
      saveLayout();
    }
    if (t.kind !== 'shell' && !paneShowingTerm(t.termId) && t.sessionId && ((was === 'busy' && info.status === 'idle') || info.status === 'waiting')) {
      unread.add(t.sessionId);
    }
  }
  if (retitled) {
    for (const p of leaves()) if (p.titleEl) p.titleEl.textContent = paneTitle(p);
    updateHeader();
  }
  renderList();
  renderSummary();
}

// ---------- keys ----------
function handleTermKey(e, t) {
  if (e.type !== 'keydown') return true;
  if (e.metaKey && !e.ctrlKey) {
    const k = e.key;
    if (k === 'c' && t.term.hasSelection()) {
      api('clipboard', { text: t.term.getSelection() });
      t.term.clearSelection();
      return false;
    }
    if (k === 'Backspace') { sendInput(t.termId, '\x15'); return false; }
    if (k === 'ArrowLeft' && !e.altKey) { sendInput(t.termId, '\x01'); return false; }
    if (k === 'ArrowRight' && !e.altKey) { sendInput(t.termId, '\x05'); return false; }
    return false; // other Cmd shortcuts belong to the app and the menu bar
  }
  if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) {
    sendInput(t.termId, '\x1b\r'); // newline in the prompt
    e.preventDefault();
    return false;
  }
  if (e.altKey && !e.ctrlKey && !prefs.optionMeta) {
    if (e.key === 'ArrowLeft') { sendInput(t.termId, '\x1bb'); return false; }
    if (e.key === 'ArrowRight') { sendInput(t.termId, '\x1bf'); return false; }
    if (e.key === 'Backspace') { sendInput(t.termId, '\x17'); return false; }
  }
  return true;
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('menu').hidden || !$('popover').hidden) { closeMenus(); e.preventDefault(); refocus(); return; }
  }
  if (!e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); newChatMenu($('btn-new')); }
  else if (k === 'k') { e.preventDefault(); if (prefs.sidebarHidden) toggleSidebar(); $('search').focus(); $('search').select(); }
  else if (k === 'j') { e.preventDefault(); newTerminal(); }
  else if (k === 'f') { e.preventDefault(); openFind(); }
  else if (k === 'g' && find) { e.preventDefault(); runFind(e.shiftKey ? 'back' : 'forward'); }
  else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (k === 'w') { e.preventDefault(); closePane(activePane); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); stepPane(-1); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); stepPane(1); }
  else if (e.key === '[') { e.preventDefault(); goHistory(-1); }
  else if (e.key === ']') { e.preventDefault(); goHistory(1); }
  else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); stepChat(-1); }
  else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); stepChat(1); }
}, true);

function refocus() {
  const t = terms.get(activePane.termId);
  if (t?.opened) t.term.focus();
}
function stepPane(dir) {
  const all = leaves();
  if (all.length < 2) return;
  setActive(all[(all.indexOf(activePane) + dir + all.length) % all.length]);
}

// ---------- sidebar ----------
let refreshTimer;
let refreshing = false;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    if (refreshing) return scheduleRefresh();
    refreshing = true;
    try { await refreshSessions(); } finally { refreshing = false; }
  }, 300);
}
async function refreshSessions() {
  const q = new URLSearchParams();
  if (prefs.showAutomated) q.set('automated', '1');
  if (prefs.showHidden) q.set('hidden', '1');
  data = await api('sessions?' + q);
  renderList();
  updateHeader();
  renderSummary();
}

function findRow(id) {
  for (const g of data.projects) for (const s of g.sessions) if (s.id === id) return s;
  return null;
}
function liveTermFor(id) {
  for (const t of terms.values()) if (t.sessionId === id) return t;
  return null;
}

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / (86400 * 30)) + 'mo';
}

function matches(row, g, q) {
  if (!q) return true;
  if (contentHits && contentHits.has(row.id)) return true;
  const hay = `${row.title} ${row.preview || ''} ${g.name} ${row.worktree || ''} ${row.branch || ''}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function renderList() {
  const list = $('list');
  const scroll = list.scrollTop;
  list.replaceChildren();
  visibleRows = [];
  const q = $('search').value.trim().toLowerCase();
  if (!data.ready && !data.projects.length) {
    list.append(el('div', 'empty', 'Indexing your chats…'));
    return;
  }
  const buildGroup = (g) => {
    const rows = g.sessions.filter((s) => matches(s, g, q));
    const shells = [...terms.values()]
      .filter((t) => t.kind === 'shell' && t.project === g.path && (!q || 'terminal'.includes(q) || shellTitle(t).toLowerCase().includes(q)))
      .sort((a, b) => a.startedAt - b.startedAt);
    if (!rows.length && !shells.length) return null;
    const box = el('div', 'group');
    const collapsed = !q && prefs.collapsed[g.path];
    if (collapsed) box.classList.add('collapsed');

    const head = el('div', 'group-head');
    head.title = g.path;
    head.append(el('span', 'name', g.name), el('span', 'caret'));
    const add = el('button', 'icon add');
    add.title = `New chat in ${g.name}`;
    add.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>';
    add.onclick = (e) => { e.stopPropagation(); newChat(g.path); };
    head.append(add);
    head.onclick = () => {
      const next = { ...prefs.collapsed };
      if (next[g.path]) delete next[g.path]; else next[g.path] = true;
      savePrefs({ collapsed: next });
      renderList();
    };
    head.oncontextmenu = (e) => { e.preventDefault(); projectMenu(e, g); };
    box.append(head);

    if (!collapsed) {
      for (const t of shells) box.append(renderShellRow(t));
      renderGroupRows(box, g, rows, !!q);
    }
    return box;
    };
  for (const g of data.projects) {
    if (g.issue || g.path === data.home) continue;
    const box = buildGroup(g);
    if (box) list.append(box);
  }
  // Home and the issue folders sit together below the real projects.
  const bottom = el('div', 'bottom-groups');
  const home = data.projects.find((g) => g.path === data.home && !g.issue);
  const homeBox = home && buildGroup(home);
  if (homeBox) bottom.append(homeBox);
  renderIssues(bottom, q, buildGroup);
  if (bottom.children.length) list.append(bottom);
  if (!list.children.length) list.append(el('div', 'empty', q ? 'No matching chats.' : 'No chats yet.'));
  list.scrollTop = scroll;
}

// issue-N folders sit in their own section at the bottom, closed until wanted.
function renderIssues(list, q, buildGroup) {
  const groups = data.projects.filter((g) => g.issue);
  if (!groups.length) return;
  const ids = new Set(groups.flatMap((g) => g.sessions.map((s) => s.id)));
  const inside = (t) => t.project && groups.some((g) => g.path === t.project);
  const live = [...terms.values()].filter((t) => (t.sessionId && ids.has(t.sessionId)) || inside(t));
  const showing = leaves().some((p) => (p.sessionId && ids.has(p.sessionId)) || live.some((t) => t.termId === p.termId));
  const open = !!q || prefs.issuesOpen || (prefs.issuesOpen === undefined && showing);
  const section = el('div', 'issues' + (open ? '' : ' collapsed'));
  const head = el('div', 'issues-head');
  head.append(el('span', 'name', 'Issues'), el('span', 'count', String(groups.length)), el('span', 'caret'));
  // A closed section still shows that something inside is working or waiting.
  const status = el('span', 'status');
  if (live.some((t) => t.status === 'busy' || t.status === 'starting')) status.append(el('span', 'spin'));
  else if (live.some((t) => t.status === 'waiting')) status.append(el('span', 'dot waiting'));
  else if ([...ids].some((id) => unread.has(id))) status.append(el('span', 'dot unread'));
  else if (live.some((t) => t.kind === 'shell' && t.label)) status.append(el('span', 'dot running'));
  else if (live.length) status.append(el('span', 'dot live'));
  head.append(status);
  head.onclick = () => { savePrefs({ issuesOpen: !open }); renderList(); };
  section.append(head);
  let shown = 0;
  if (open) {
    for (const g of groups) {
      const box = buildGroup(g);
      if (box) { section.append(box); shown++; }
    }
    if (q && !shown) return;
  }
  list.append(section);
}

function renderGroupRows(box, g, rows, searching) {
  // Forks nest under the chat they came from, as in the desktop app.
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map();
  const roots = [];
  for (const r of rows) {
    if (r.parent && ids.has(r.parent) && r.parent !== r.id) {
      if (!kids.has(r.parent)) kids.set(r.parent, []);
      kids.get(r.parent).push(r);
    } else roots.push(r);
  }
  const limit = searching || prefs.expanded[g.path] ? Infinity : 8;
  const active = (r) => paneShowingChat(r.id) || liveTermFor(r.id) || unread.has(r.id);
  let shown = 0;
  let hiddenCount = 0;
  for (const r of roots) {
    if (shown >= limit && !active(r)) { hiddenCount++; continue; }
    shown++;
    renderBranch(box, r, kids, 0, false, searching);
  }
  if (hiddenCount) {
    const m = el('button', 'more', `Show ${hiddenCount} more`);
    m.onclick = () => { savePrefs({ expanded: { ...prefs.expanded, [g.path]: true } }); renderList(); };
    box.append(m);
  } else if (prefs.expanded[g.path] && roots.length > 8 && !searching) {
    const m = el('button', 'more', 'Show less');
    m.onclick = () => { const x = { ...prefs.expanded }; delete x[g.path]; savePrefs({ expanded: x }); renderList(); };
    box.append(m);
  }
}

function renderBranch(box, r, kids, depth, hasNext, searching) {
  const children = kids.get(r.id) || [];
  const open = searching || prefs.folds[r.id] !== false;
  box.append(renderRow(r, depth, hasNext, children.length ? open : null));
  if (children.length && open) {
    children.forEach((c, i) => renderBranch(box, c, kids, depth + 1, i < children.length - 1, searching));
  }
}

function renderRow(r, depth, hasNext, fold) {
  const row = el('div', 'row');
  if (depth) { row.classList.add('child'); row.style.marginLeft = 13 * Math.min(depth, 3) + 'px'; }
  if (hasNext) row.classList.add('has-next');
  if (r.id === activePane.sessionId) row.classList.add('active');
  else if (paneShowingChat(r.id)) row.classList.add('shown');
  if (r.id === cursorId) row.classList.add('cursor');
  row.dataset.id = r.id;
  visibleRows.push(r);
  const tipParts = [r.preview, r.worktree ? `worktree: ${r.worktree}` : (r.branch ? `branch: ${r.branch}` : '')].filter(Boolean);
  row.title = tipParts.join('\n');

  row.append(el('span', 'label', r.title), el('span', 'when', relTime(r.mtime)));
  if (fold !== null) {
    const f = el('span', 'fold' + (fold ? '' : ' closed'));
    f.append(el('span', 'caret'));
    f.onclick = (e) => {
      e.stopPropagation();
      savePrefs({ folds: { ...prefs.folds, [r.id]: !fold } });
      renderList();
    };
    row.append(f);
  }
  // The status column is always there, so every row's status lines up.
  const status = el('span', 'status');
  const t = liveTermFor(r.id);
  const ext = external[r.id];
  if (t && (t.status === 'busy' || t.status === 'starting')) status.append(el('span', 'spin'));
  else if (t && t.status === 'waiting') status.append(el('span', 'dot waiting'));
  else if (unread.has(r.id)) status.append(el('span', 'dot unread'));
  else if (t) status.append(el('span', 'dot live'));
  else if (ext) {
    status.append(el('span', ext.status === 'busy' ? 'spin' : 'dot elsewhere'));
    row.title = `Running in ${ext.where}\n` + row.title;
  }
  row.append(status);
  row.onclick = () => openSession(r.id);
  row.addEventListener('mousedown', (e) => beginDrag(e, { type: 'row', row: { id: r.id }, title: r.title }));
  row.oncontextmenu = (e) => { e.preventDefault(); rowMenu(e, r); };
  return row;
}

function shellTitle(t) {
  const same = [...terms.values()].filter((o) => o.kind === 'shell' && o.project === t.project).sort((a, b) => a.startedAt - b.startedAt);
  const n = same.indexOf(t);
  const base = n > 0 ? `Terminal ${n + 1}` : 'Terminal';
  return t.label ? `${base} · ${t.label}` : base;
}

function renderShellRow(t) {
  const row = el('div', 'row shell');
  const id = 'term:' + t.termId;
  row.dataset.id = id;
  if (t.termId === activePane.termId) row.classList.add('active');
  else if (paneShowingTerm(t.termId)) row.classList.add('shown');
  if (id === cursorId) row.classList.add('cursor');
  row.title = t.cwd;
  const title = shellTitle(t);
  visibleRows.push({ id, title, shell: true, termId: t.termId });
  const icon = el('span');
  icon.style.display = 'inline-flex';
  icon.innerHTML = '<svg class="row-icon" viewBox="0 0 16 16"><path d="M2.5 4l4 4-4 4M8 12.5h5.5"/></svg>';
  const x = el('button', 'row-close');
  x.title = 'Close terminal';
  x.innerHTML = '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  x.onclick = (e) => { e.stopPropagation(); api('close', { termId: t.termId }); };
  x.onmousedown = (e) => e.stopPropagation();
  const status = el('span', 'status');
  // Static, because a dev server can run for days. Spinners mean a chat is working.
  if (t.label) status.append(el('span', 'dot running'));
  else if (unread.has(id)) status.append(el('span', 'dot unread'));
  else status.append(el('span', 'dot live'));
  if (t.label) row.title = `Running ${t.label}\n${t.cwd}`;
  row.append(icon, el('span', 'label', title), x, status);
  row.onclick = () => openRow({ id, shell: true, termId: t.termId });
  row.addEventListener('mousedown', (e) => beginDrag(e, { type: 'row', row: { id, shell: true, termId: t.termId }, title }));
  row.oncontextmenu = (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: 'Open folder in Finder', fn: () => api('reveal', { path: t.cwd }) },
      { label: 'Close terminal', fn: () => api('close', { termId: t.termId }) },
    ]);
  };
  return row;
}

function renderSummary() {
  const all = [...terms.values()];
  const live = all.filter((t) => t.kind !== 'shell');
  const shells = all.length - live.length;
  const busy = live.filter((t) => t.status === 'busy').length;
  const waiting = live.filter((t) => t.status === 'waiting').length;
  const parts = [];
  if (live.length) parts.push(`${live.length} open`);
  if (shells) parts.push(`${shells} terminal${shells > 1 ? 's' : ''}`);
  if (busy) parts.push(`${busy} working`);
  if (waiting) parts.push(`${waiting} waiting on you`);
  $('live-summary').textContent = parts.join(' · ');
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

function activeCwd() {
  if (activePane.mdPath) return dirName(activePane.mdPath);
  const t = terms.get(activePane.termId);
  const row = activePane.sessionId ? findRow(activePane.sessionId) : null;
  return row?.cwd || t?.cwd || null;
}

function updateHeader() {
  const t = terms.get(activePane.termId);
  const isShell = t?.kind === 'shell';
  const row = activePane.sessionId ? findRow(activePane.sessionId) : null;
  const md = activePane.mdPath;
  const title = md ? baseName(md) : isShell ? shellTitle(t) : row?.title || (t ? 'New session' : '');
  $('title').textContent = title;
  const cwd = activeCwd() || '';
  const home = data.home || '';
  const short = cwd.startsWith(home) && home ? '~' + cwd.slice(home.length) : cwd;
  $('subtitle').textContent = [short, row?.branch].filter(Boolean).join('  ·  ');
  $('actions').hidden = !cwd;
  // A chat with no messages has no transcript to fork from yet.
  $('btn-fork').hidden = !activePane.sessionId || !row || !!row.pending;
  $('btn-close-term').hidden = !t && !md;
  $('btn-back').disabled = histPos <= 0;
  $('btn-forward').disabled = histPos >= history.length - 1;
  document.title = title ? `${title} · Claude Deck` : 'Claude Deck';
}

// ---------- opening chats ----------
function termSize(p = activePane) {
  // A sensible first size; the terminal corrects it as soon as it is shown.
  const w = (p.stage?.clientWidth || $('stage').clientWidth) - 24;
  const h = (p.stage?.clientHeight || $('stage').clientHeight) - 16;
  const cw = prefs.fontSize * 0.602;
  const ch = prefs.fontSize * 1.2 * prefs.lineHeight;
  return { cols: Math.max(20, Math.floor(w / cw)), rows: Math.max(6, Math.floor(h / ch)) };
}

function openRow(r, opts = {}) {
  if (r.shell) {
    const t = terms.get(r.termId);
    if (!t) return;
    const pane = opts.pane || paneShowingTerm(r.termId) || activePane;
    displayIn(pane, t, opts);
    return;
  }
  return openSession(r.id, opts);
}

function setNotice(p, title, body, buttons) {
  p.notice = { title, body, buttons };
  activePane = p;
  renderGrid();
}
function dismissNotice(p) {
  p.notice = null;
  renderGrid();
  refocus();
}

async function openSession(id, opts = {}) {
  closeMenus();
  const pane = opts.pane || paneShowingChat(id) || activePane;
  const live = liveTermFor(id);
  if (live && !opts.fork) {
    displayIn(pane, live, opts);
    return;
  }
  // Clicking the chat a pane already shows only needs to focus it.
  if (!opts.fork && paneShowingChat(id) === pane && pane.ended !== id && !opts.force && !opts.mkdir && !opts.pane) {
    setActive(pane, true, opts.fromHistory);
    return;
  }
  const r = await api('open', { sessionId: id, ...termSize(pane), fork: opts.fork, force: opts.force, mkdir: opts.mkdir });
  const target = isAttached(pane) ? pane : activePane;
  if (r.error) return setNotice(target, 'Could not open this chat', r.error, [['OK', () => dismissNotice(target)]]);
  if (r.missingCwd) {
    return setNotice(
      target,
      'This chat’s folder no longer exists',
      `${r.missingCwd} was removed, probably with its worktree. Claude Code resumes a chat from its original folder, so opening it means recreating that folder empty. The files the chat worked on will not come back.`,
      [['Recreate folder and open', () => openSession(id, { ...opts, pane: target, mkdir: true }), true], ['Cancel', () => dismissNotice(target)]],
    );
  }
  if (r.conflict) {
    return setNotice(
      target,
      `This chat is open in ${r.conflict.where}`,
      'Opening it here too would put two processes on the same chat, and their messages can diverge. Close it there first, or work in a separate copy here.',
      [['Open a copy here', () => openSession(id, { pane: target, fork: true }), true], ['Open here anyway', () => openSession(id, { pane: target, force: true })], ['Cancel', () => dismissNotice(target)]],
    );
  }
  const created = terms.get(r.termId) || createTerm(r.termId, { ...r, status: 'starting' });
  displayIn(target, created, opts);
  scheduleRefresh();
}

async function newChat(cwd) {
  closeMenus();
  const pane = activePane;
  const r = await api('open', { cwd, ...termSize(pane) });
  const target = isAttached(pane) ? pane : activePane;
  if (r.error) return setNotice(target, 'Could not start a chat', r.error, [['OK', () => dismissNotice(target)]]);
  const created = terms.get(r.termId) || createTerm(r.termId, { ...r, cwd, status: 'starting' });
  displayIn(target, created);
  scheduleRefresh();
}

async function newTerminal() {
  closeMenus();
  const cwd = activeCwd() || prefs.lastCwd || data.home;
  if (!cwd) return;
  const pane = activePane;
  const r = await api('shell', { cwd, ...termSize(pane) });
  const target = isAttached(pane) ? pane : activePane;
  if (r.error) return setNotice(target, 'Could not open a terminal', r.error, [['OK', () => dismissNotice(target)]]);
  const t = terms.get(r.termId) || createTerm(r.termId, { ...r, status: 'shell' });
  if (prefs.collapsed[t.project]) {
    const next = { ...prefs.collapsed };
    delete next[t.project];
    savePrefs({ collapsed: next });
  }
  await refreshSessions();
  displayIn(target, t);
}

function goHistory(dir) {
  let next = histPos + dir;
  while (next >= 0 && next < history.length) {
    const key = history[next];
    if (key.startsWith('term:')) {
      const termId = key.slice(5);
      if (terms.has(termId)) {
        histPos = next;
        openRow({ shell: true, termId }, { fromHistory: true });
        return;
      }
    } else {
      histPos = next;
      openSession(key, { fromHistory: true });
      return;
    }
    next += dir;
  }
}

function stepChat(dir) {
  if (!visibleRows.length) return;
  const key = activeKey();
  const i = visibleRows.findIndex((r) => r.id === key);
  const next = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, (i < 0 ? -1 : i) + dir))];
  if (next && next.id !== key) {
    openRow(next);
    requestAnimationFrame(() => document.querySelector(`.row[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  }
}

function toggleSidebar() {
  savePrefs({ sidebarHidden: !prefs.sidebarHidden });
  applyChrome();
}
function applyChrome() {
  document.body.classList.toggle('no-sidebar', !!prefs.sidebarHidden);
  $('btn-sidebar-2').hidden = !prefs.sidebarHidden;
  document.documentElement.style.setProperty('--side-w', prefs.sidebarWidth + 'px');
}

// ---------- menus ----------
function closeMenus() { $('menu').hidden = true; $('popover').hidden = true; menuKeys = null; }
let menuKeys = null;

function showMenu(x, y, items) {
  const m = $('menu');
  m.replaceChildren();
  const buttons = [];
  for (const it of items) {
    if (it === '-') { m.append(el('div', 'msep')); continue; }
    if (it.head) { m.append(el('div', 'mhead', it.head)); continue; }
    const b = el('button', 'mi', it.label);
    if (it.note) b.append(el('small', '', it.note));
    b.onclick = () => { closeMenus(); it.fn(); };
    m.append(b);
    buttons.push(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  let pos = -1;
  menuKeys = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pos = (pos + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons.forEach((b, i) => b.classList.toggle('cursor', i === pos));
      buttons[pos].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && pos >= 0) {
      e.preventDefault();
      buttons[pos].click();
    }
  };
  document.activeElement?.blur?.();
}
window.addEventListener('keydown', (e) => { if (menuKeys && !$('menu').hidden) menuKeys(e); }, true);
window.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#menu') && !e.target.closest('#popover')) closeMenus();
});

function rowMenu(e, r) {
  const t = liveTermFor(r.id);
  showMenu(e.clientX, e.clientY, [
    { label: 'Rename…', fn: () => renamePrompt(r) },
    { label: 'Fork into a new copy', fn: () => openSession(r.id, { fork: true }) },
    { label: 'Open in Terminal.app', fn: () => openInTerminal(r.id) },
    { label: 'Open folder in Finder', fn: () => api('reveal', { path: r.cwd }) },
    { label: 'Copy session ID', fn: () => api('clipboard', { text: r.id }) },
    ...(t ? [{ label: 'Close process', fn: () => api('close', { termId: t.termId }) }] : []),
    '-',
    r.hidden
      ? { label: 'Show in sidebar again', fn: () => api('hide', { id: r.id, hidden: false }) }
      : { label: 'Hide from sidebar', fn: () => api('hide', { id: r.id, hidden: true }) },
  ]);
}
function projectMenu(e, g) {
  const hidden = data.hiddenProjects?.[g.path];
  showMenu(e.clientX, e.clientY, [
    { label: `New chat in ${g.name}`, fn: () => newChat(g.path) },
    { label: 'Open folder in Finder', fn: () => api('reveal', { path: g.path }) },
    '-',
    { label: hidden ? 'Show project again' : 'Hide project from sidebar', fn: () => api('hide-project', { path: g.path, hidden: !hidden }) },
  ]);
}
function renamePrompt(r) {
  const pop = $('popover');
  const input = el('input');
  input.id = 'rename-input';
  input.value = r.title;
  pop.replaceChildren(input);
  pop.hidden = false;
  const rowEl = document.querySelector(`.row[data-id="${r.id}"]`)?.getBoundingClientRect();
  pop.style.left = (rowEl ? rowEl.left : 20) + 'px';
  pop.style.top = (rowEl ? rowEl.bottom + 4 : 80) + 'px';
  input.focus();
  input.select();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { api('rename', { id: r.id, title: input.value.trim() }); closeMenus(); refocus(); }
    e.stopPropagation();
  };
}
async function openInTerminal(id) {
  const t = liveTermFor(id);
  const pane = activePane;
  if (t) {
    setNotice(pane, 'Close it here first?', 'This chat is running in Claude Deck. Opening it in Terminal too would put two processes on the same chat.', [
      ['Close here and open in Terminal', async () => { await api('close', { termId: t.termId }); pane.notice = null; renderGrid(); setTimeout(() => api('open-terminal', { sessionId: id }), 500); }, true],
      ['Cancel', () => dismissNotice(pane)],
    ]);
    return;
  }
  const r = await api('open-terminal', { sessionId: id });
  if (r.error) setNotice(pane, 'Could not open Terminal', r.error, [['OK', () => dismissNotice(pane)]]);
}

function newChatMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const projects = data.projects.filter((g) => g.path !== '(unknown)' && !g.issue).slice(0, 12);
  showMenu(r.left, r.bottom + 4, [
    { head: 'Start a new chat in' },
    ...projects.map((g) => ({ label: g.name, fn: () => newChat(g.path) })),
    '-',
    { label: 'Choose a folder…', fn: async () => { const p = await api('pick-folder', {}); if (p.path) newChat(p.path); else refocus(); } },
  ]);
}

function settingsPopover() {
  const pop = $('popover');
  pop.replaceChildren();
  const num = (label, key, min, max, step, after) => {
    const f = el('label', 'field', label);
    const i = el('input');
    i.type = 'number'; i.min = min; i.max = max; i.step = step; i.value = prefs[key];
    i.onchange = () => { const v = Number(i.value); if (v >= min && v <= max) { savePrefs({ [key]: v }); after?.(); } };
    f.append(i);
    pop.append(f);
  };
  const check = (label, key, hint, after) => {
    const f = el('label', 'field', label);
    const i = el('input');
    i.type = 'checkbox'; i.checked = !!prefs[key];
    i.onchange = () => { savePrefs({ [key]: i.checked }); after?.(); };
    f.append(i);
    pop.append(f);
    if (hint) pop.append(el('div', 'hint', hint));
  };
  const f = el('label', 'field', 'Font');
  const sel = el('select');
  for (const [k, label] of [['system', 'SF Mono'], ['menlo', 'Menlo'], ['jetbrains', 'JetBrains Mono'], ['fira', 'Fira Code'], ['plex', 'IBM Plex Mono']]) {
    const o = el('option', '', label); o.value = k; sel.append(o);
  }
  sel.value = prefs.fontFamily;
  sel.onchange = () => { savePrefs({ fontFamily: sel.value }); applyTermPrefs(); };
  f.append(sel);
  pop.append(f);
  pop.append(el('div', 'hint', 'Terminals need a fixed-width font. Fonts you have not installed fall back to SF Mono.'));
  num('Font size', 'fontSize', 10, 22, 0.5, applyTermPrefs);
  num('Line spacing', 'lineHeight', 1, 1.8, 0.05, applyTermPrefs);
  check('Option key sends Alt', 'optionMeta', 'Off keeps Option typing characters such as @ and # on a Turkish keyboard. On enables shortcuts like Option+P.', applyTermPrefs);
  check('Show automated runs', 'showAutomated', data.hiddenAutomated ? `${data.hiddenAutomated} scripted or SDK runs are hidden.` : null, refreshSessions);
  check('Show hidden and archived', 'showHidden', null, refreshSessions);
  num('Max open processes', 'maxLive', 2, 40, 1);
  pop.append(el('div', 'hint', 'Idle chats past this limit close their process and resume when clicked.'));
  pop.hidden = false;
  const r = $('btn-settings').getBoundingClientRect();
  pop.style.left = '10px';
  pop.style.top = 'auto';
  pop.style.bottom = (innerHeight - r.top + 6) + 'px';
}
function applyTermPrefs() {
  for (const t of terms.values()) {
    t.term.options.fontFamily = FONTS[prefs.fontFamily] || FONTS.system;
    t.term.options.fontSize = prefs.fontSize;
    t.term.options.lineHeight = prefs.lineHeight;
    t.term.options.macOptionIsMeta = !!prefs.optionMeta;
  }
  for (const p of leaves()) { const t = terms.get(p.termId); if (t) fitTerm(t); }
}

// ---------- search ----------
let searchTimer;
$('search').addEventListener('input', () => {
  contentHits = null;
  cursorId = null;
  renderList();
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  $('search-status').hidden = q.length < 3;
  if (q.length < 3) return;
  $('search-status').textContent = 'Searching inside chats…';
  searchTimer = setTimeout(async () => {
    const r = await api('search?q=' + encodeURIComponent(q));
    if ($('search').value.trim() !== q) return;
    contentHits = new Set(r.ids);
    $('search-status').textContent = `${visibleMatchCount()} chats match`;
    renderList();
    $('search-status').textContent = `${visibleRows.length} chats match`;
  }, 350);
});
function visibleMatchCount() { renderList(); return visibleRows.length; }
$('search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!visibleRows.length) return;
    const i = visibleRows.findIndex((r) => r.id === cursorId);
    const n = (i + (e.key === 'ArrowDown' ? 1 : -1) + visibleRows.length) % visibleRows.length;
    cursorId = visibleRows[n].id;
    renderList();
    document.querySelector(`.row[data-id="${cursorId}"]`)?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const r = visibleRows.find((v) => v.id === cursorId) || visibleRows[0];
    if (r) { clearSearch(); openRow(r); }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    clearSearch();
    refocus();
  }
});
function clearSearch() {
  $('search').value = '';
  contentHits = null;
  cursorId = null;
  $('search-status').hidden = true;
  renderList();
}

// ---------- chrome wiring ----------
$('btn-new').onclick = (e) => { e.stopPropagation(); newChatMenu($('btn-new')); };
$('btn-settings').onclick = (e) => {
  e.stopPropagation();
  if (!$('popover').hidden) closeMenus(); else settingsPopover();
};
$('btn-sidebar-1').onclick = toggleSidebar;
$('btn-sidebar-2').onclick = toggleSidebar;
$('btn-back').onclick = () => goHistory(-1);
$('btn-forward').onclick = () => goHistory(1);
$('btn-fork').onclick = () => activePane.sessionId && openSession(activePane.sessionId, { fork: true, pane: activePane });
$('btn-terminal').onclick = newTerminal;
$('btn-finder').onclick = () => { const p = activePane.mdPath || activeCwd(); if (p) api('reveal', { path: p }); };
$('btn-close-term').onclick = () => {
  if (activePane.mdPath) { removeLeaf(activePane); renderGrid(); refocus(); }
  else if (activePane.termId) api('close', { termId: activePane.termId });
};

// The title bar is web content, so the native shell moves the window on request.
for (const area of document.querySelectorAll('.drag')) {
  area.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('button')) native('drag');
  });
  area.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) native('zoom'); });
}

// Sidebar resize.
$('resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const move = (ev) => {
    const w = Math.max(200, Math.min(520, ev.clientX));
    document.documentElement.style.setProperty('--side-w', w + 'px');
    prefs.sidebarWidth = w;
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    savePrefs({ sidebarWidth: prefs.sidebarWidth });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// Hooks for the native shell.
window.deckBusyCount = () => [...terms.values()].filter((t) => t.status === 'busy' || t.status === 'waiting').length;
window.deckDrop = (paths) => {
  const t = terms.get(activePane.termId);
  if (!t) return;
  const quoted = paths.map((p) => (/[^\w@%+=:,./-]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)).join(' ');
  t.term.paste(quoted + ' ');
  t.term.focus();
};

// Keep relative times and live marks fresh.
setInterval(renderList, 60000);

(async function start() {
  const s = await api('state');
  prefs = { ...PREF_DEFAULTS, ...s.prefs };
  applyChrome();
  await refreshSessions();
  connect();
  await connected;
  await restoreLayout();
  const wait = setInterval(() => { if (data.ready) clearInterval(wait); else refreshSessions(); }, 1000);
})();

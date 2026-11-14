// Panecake server: indexes Claude Code's transcripts for the sidebar and runs
// the real `claude` binary in pseudo-terminals. It never writes inside ~/.claude;
// renames and hides live in Panecake's own state file.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const HOME = os.homedir();
const ROOT = import.meta.dirname;
const PROJECTS = path.join(HOME, '.claude/projects');
const REGISTRY = path.join(HOME, '.claude/sessions');
const DESKTOP_META = path.join(HOME, 'Library/Application Support/Claude/claude-code-sessions');
const APP_DIR = process.env.PANECAKE_DATA_DIR || path.join(HOME, 'Library/Application Support/Panecake');
const STATE_FILE = path.join(APP_DIR, 'state.json');
const CACHE_FILE = path.join(APP_DIR, 'index-cache.json');
const TOKEN = crypto.randomBytes(24).toString('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RING_BYTES = 2 * 1024 * 1024;

// Before the rename, settings lived under "Claude Deck". Carry them over once.
const OLD_APP_DIR = path.join(HOME, 'Library/Application Support/Claude Deck');
if (!process.env.PANECAKE_DATA_DIR && !fs.existsSync(APP_DIR) && fs.existsSync(OLD_APP_DIR)) {
  try { fs.cpSync(OLD_APP_DIR, APP_DIR, { recursive: true }); } catch {}
}
fs.mkdirSync(APP_DIR, { recursive: true });

// ---------- environment ----------
// Launched from Finder, an app gets a bare environment. Borrow the user's real
// shell environment so `claude` and its Bash tool behave as in a terminal.
function loginEnv() {
  const marker = '__PANECAKE_ENV__';
  const r = spawnSync('/bin/zsh', ['-ilc', `printf ${marker}; /usr/bin/env -0`], {
    encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
  });
  const env = { ...process.env };
  const at = (r.stdout || '').indexOf(marker);
  if (at >= 0) {
    for (const kv of r.stdout.slice(at + marker.length).split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  // Variables a parent Claude Code session would leak into its children.
  for (const k of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT', 'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'PANECAKE_PARENT']) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'Panecake';
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}
const ENV = loginEnv();

function findClaude() {
  const local = path.join(HOME, '.local/bin/claude');
  if (fs.existsSync(local)) return local;
  for (const dir of (ENV.PATH || '').split(':')) {
    const p = path.join(dir, 'claude');
    if (dir && fs.existsSync(p)) return p;
  }
  return 'claude';
}
const CLAUDE = findClaude();

// ---------- persisted state ----------
const DEFAULT_STATE = { titles: {}, hidden: {}, hiddenProjects: {}, prefs: {} };
let state = DEFAULT_STATE;
try { state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
let saveTimer;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(state, null, 1), (e) => {
      if (!e) fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {});
    });
  }, 300);
}

// ---------- transcript index ----------
const HEAD = 128 * 1024;
const TAIL = 128 * 1024;
const FRONT_MAX = 16 * 1024 * 1024;
const INDEX_VERSION = 4; // raise when parsing changes, so old results are redone
const index = new Map(); // sessionId -> parsed row
let indexReady = false;
let cache = {};
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (saved.version === INDEX_VERSION) cache = saved.rows;
} catch {}

// "/model", or "/clear clear" as older versions recorded it, says nothing about a
// chat. A command with real arguments, like "/shape-task #478", is kept.
const bareCommand = (t) => /^\/(\S+)(\s+\1)?$/u.test(String(t || '').trim());

function cleanPrompt(content) {
  let text = typeof content === 'string' ? content
    : Array.isArray(content) ? (content.find((b) => b && b.type === 'text') || {}).text : '';
  if (!text) return '';
  // Pasted text arrives wrapped in a tag; the words inside are what matter.
  text = text.replace(/<\/?pasted_content[^>]*>/g, ' ').trim();
  if (/^<(command-|local-command|system-reminder|task-notification|teammate-|bash-|user-memory|session-)/.test(text)) return '';
  if (bareCommand(text)) return '';
  if (text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return '';
  return text.replace(/\s+/g, ' ').slice(0, 240);
}

const firstMatch = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };
function lastMatch(s, re) {
  let m, v = null;
  while ((m = re.exec(s))) v = m[1];
  return v;
}
const unescape = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };

// Claude Code names each project's transcript folder after its path.
const encodeDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

function firstPromptIn(text) {
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const o = JSON.parse(line);
      if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;
      const p = cleanPrompt(o.message?.content);
      if (p) return p;
    } catch {}
  }
  return '';
}

async function parseSession(file, st) {
  const fh = await fsp.open(file, 'r');
  try {
    const readFront = async (want) => {
      const len = Math.min(want, st.size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      const text = buf.toString('utf8');
      return st.size > len ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    };
    let head = await readFront(HEAD);
    let tail = head;
    if (st.size > HEAD) {
      const tailLen = Math.min(TAIL, st.size - HEAD);
      const tailBuf = Buffer.alloc(tailLen);
      await fh.read(tailBuf, 0, tailLen, st.size - tailLen);
      tail = tailBuf.toString('utf8');
      tail = tail.slice(tail.indexOf('\n') + 1);
    }
    const row = {
      id: path.basename(file, '.jsonl'), mtime: st.mtimeMs, size: st.size,
      cwd: null, entrypoint: null, branch: null, parent: null, customTitle: null, aiTitle: null, firstPrompt: '', lastPrompt: '',
    };
    row.entrypoint = firstMatch(head, /"entrypoint":"([^"]+)"/) || firstMatch(tail, /"entrypoint":"([^"]+)"/);
    const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;
    row.firstPrompt = firstPromptIn(head);

    // A pasted screenshot can make the first message far bigger than the usual read.
    // People's chats get a longer look; scripted runs are too numerous to afford it.
    if (row.entrypoint === 'cli' || row.entrypoint === 'claude-desktop') {
      for (const want of [2 * 1024 * 1024, FRONT_MAX]) {
        if ((row.firstPrompt && CWD.test(head)) || st.size <= HEAD) break;
        head = await readFront(want);
        row.firstPrompt = firstPromptIn(head);
        if (st.size <= want) break;
      }
    }

    // The chat's own folder is what resuming needs. The newest working directory can
    // differ, because commands inside the chat move it, so check it against the
    // transcript's folder name.
    const dirName = path.basename(path.dirname(file));
    const seen = [...head.matchAll(new RegExp(CWD, 'g')), ...tail.matchAll(new RegExp(CWD, 'g'))].map((m) => unescape(m[1]));
    row.cwd = seen.find((c) => encodeDir(c) === dirName) || seen[0] || null;

    const br = lastMatch(tail, /"gitBranch":"((?:[^"\\]|\\.)*)"/g);
    row.branch = br ? unescape(br) : null;
    row.parent = firstMatch(head, /"forkedFrom":\{"sessionId":"([0-9a-f-]+)"/);

    for (const line of (tail + (tail === head ? '' : '\n' + head)).split('\n')) {
      if (line.includes('"type":"custom-title"') && !row.customTitle) {
        try { row.customTitle = JSON.parse(line).customTitle || null; } catch {}
      }
    }
    // custom-title may recur; the newest occurrence in the tail wins.
    for (const line of tail.split('\n')) {
      if (line.includes('"type":"custom-title"')) {
        try { row.customTitle = JSON.parse(line).customTitle || row.customTitle; } catch {}
      }
      if (line.includes('"type":"ai-title"')) {
        try { row.aiTitle = JSON.parse(line).aiTitle || row.aiTitle; } catch {}
      }
      if (line.includes('"type":"last-prompt"')) {
        try { row.lastPrompt = cleanPrompt(JSON.parse(line).lastPrompt) || row.lastPrompt; } catch {}
      }
    }
    // Claude Code keeps rewriting its automatic title; the newest one wins.
    if (!row.aiTitle && tail !== head) {
      for (const line of head.split('\n')) {
        if (line.includes('"type":"ai-title"')) {
          try { row.aiTitle = JSON.parse(line).aiTitle || row.aiTitle; } catch {}
        }
      }
    }
    return row;
  } finally {
    await fh.close();
  }
}

async function refreshFile(file) {
  try {
    const st = await fsp.stat(file);
    const id = path.basename(file, '.jsonl');
    const prev = index.get(id);
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) return false;
    const c = cache[id];
    if (c && c.mtime === st.mtimeMs && c.size === st.size) { index.set(id, c); return true; }
    index.set(id, await parseSession(file, st));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return index.delete(path.basename(file, '.jsonl'));
    return false;
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function fullScan() {
  const files = [];
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch {}
  await pool(dirs, 32, async (d) => {
    try {
      for (const f of await fsp.readdir(path.join(PROJECTS, d))) {
        if (f.endsWith('.jsonl') && UUID.test(f.slice(0, -6))) files.push(path.join(PROJECTS, d, f));
      }
    } catch {}
  });
  const seen = new Set(files.map((f) => path.basename(f, '.jsonl')));
  for (const id of [...index.keys()]) if (!seen.has(id)) index.delete(id);
  await pool(files, 24, refreshFile);
  await loadDesktopMeta();
  indexReady = true;
  fs.writeFile(CACHE_FILE, JSON.stringify({ version: INDEX_VERSION, rows: Object.fromEntries(index) }), () => {});
  announceChanged();
}

// Claude Desktop keeps its own titles and archive flags. Read-only use.
const desktopMeta = new Map();
const desktopFileCache = new Map();
const localToCli = new Map();
async function loadDesktopMeta() {
  const stack = [DESKTOP_META];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.name.startsWith('local_') && e.name.endsWith('.json')) files.push(path.join(dir, e.name));
    }
  }
  await pool(files, 24, async (f) => {
    try {
      const st = await fsp.stat(f);
      const c = desktopFileCache.get(f);
      if (c && c.mtime === st.mtimeMs) return;
      const o = JSON.parse(await fsp.readFile(f, 'utf8'));
      desktopFileCache.set(f, { mtime: st.mtimeMs });
      if (!o.cliSessionId) return;
      desktopMeta.set(o.cliSessionId, {
        title: o.title || null, titleSource: o.titleSource || null, archived: !!o.isArchived,
        forkedFromLocal: o.forkedFromSessionId || o.spawnedFrom?.sessionId || null,
      });
      if (o.sessionId) localToCli.set(o.sessionId, o.cliSessionId);
    } catch {}
  });
}

// Worktrees of a repo belong under the repo in the sidebar.
function projectOf(cwd) {
  if (!cwd) return { path: '(unknown)', worktree: null };
  // Every issue-N folder is its own group, listed in the Issues section.
  const issue = /^(.*?\/issue-\d+[^/]*)(?:\/|$)/.exec(cwd);
  if (issue) return { path: issue[1], worktree: null, issue: true };
  const m = /^(.*?)(?:\/\.claude\/worktrees|\/\.worktrees|\/worktrees|-worktrees)\/([^/]+)/.exec(cwd);
  return m ? { path: m[1], worktree: m[2] } : { path: cwd, worktree: null };
}

function titleOf(row) {
  // Names a person chose come first, then Claude Code's automatic title.
  const named = (t) => (t && t !== 'New session' && !bareCommand(t) ? t : null);
  const meta = desktopMeta.get(row.id);
  const chosen = meta?.titleSource && meta.titleSource !== 'auto' ? named(meta.title) : null;
  return state.titles[row.id] || named(row.customTitle) || chosen || named(row.aiTitle) || named(meta?.title)
    || row.firstPrompt || row.lastPrompt || 'New session';
}

function sidebarData(includeAutomated, includeHidden) {
  const liveIds = new Map();
  for (const t of terms.values()) if (t.sessionId) liveIds.set(t.sessionId, t);
  const rows = [];
  let hiddenAutomated = 0;
  for (const row of index.values()) {
    const meta = desktopMeta.get(row.id);
    const live = liveIds.has(row.id);
    // Scratch folders under the temp directory are throwaway agent runs.
    const scratch = /^\/(private\/)?tmp\//.test(row.cwd || '');
    const interactive = !scratch && (row.entrypoint === 'cli' || row.entrypoint === 'claude-desktop' || !!meta);
    const hasContent = row.firstPrompt || row.lastPrompt || row.customTitle || row.aiTitle || meta?.title || state.titles[row.id];
    // A chat running anywhere right now always belongs in the list.
    if (!hasContent && !live && !registry.has(row.id)) continue;
    if (!live && !includeHidden && (state.hidden[row.id] || meta?.archived)) continue;
    if (!interactive && !live && !state.opened?.[row.id]) {
      hiddenAutomated++;
      if (!includeAutomated) continue;
    }
    rows.push(row);
  }
  const groups = new Map();
  const groupFor = (p) => {
    if (!groups.has(p.path)) {
      const name = p.path === HOME ? 'Home' : path.basename(p.path) || p.path;
      groups.set(p.path, { path: p.path, name, last: 0, sessions: [], issue: !!p.issue });
    }
    return groups.get(p.path);
  };
  const add = (r) => {
    const p = projectOf(r.cwd);
    if (state.hiddenProjects[p.path] && !includeHidden && !liveIds.has(r.id)) return;
    const g = groupFor(p);
    g.last = Math.max(g.last, r.mtime);
    g.sessions.push(r);
  };
  for (const r of rows) {
    add({
      id: r.id, title: titleOf(r), preview: r.lastPrompt || r.firstPrompt, cwd: r.cwd, branch: r.branch,
      worktree: projectOf(r.cwd).worktree, mtime: r.mtime, entrypoint: r.entrypoint,
      parent: r.parent || localToCli.get(desktopMeta.get(r.id)?.forkedFromLocal) || null,
      hidden: !!state.hidden[r.id] || !!desktopMeta.get(r.id)?.archived,
    });
  }
  // A brand-new chat has no transcript until its first message.
  for (const t of terms.values()) {
    if (t.kind !== 'shell' && t.sessionId && !index.has(t.sessionId)) {
      add({
        id: t.sessionId, title: state.titles[t.sessionId] || 'New session', preview: '', cwd: t.cwd, branch: null,
        worktree: projectOf(t.cwd).worktree, mtime: t.startedAt, parent: null, entrypoint: 'cli', pending: true,
      });
    }
  }
  // A terminal keeps its folder listed even when that folder has no chats yet.
  for (const t of terms.values()) {
    if (t.kind !== 'shell') continue;
    const g = groupFor(projectOf(t.cwd));
    g.last = Math.max(g.last, t.startedAt);
  }
  const projects = [...groups.values()].sort((a, b) => b.last - a.last);
  for (const g of projects) g.sessions.sort((a, b) => b.mtime - a.mtime);
  return { ready: indexReady, projects, hiddenAutomated, home: HOME, hiddenProjects: state.hiddenProjects };
}

// ---------- live session registry ----------
// Claude Code records every running process in sessions/<pid>.json, including its
// current session id (which changes on /clear or /resume) and busy/idle status.
let registry = new Map(); // sessionId -> { pid, status, entrypoint }
let registryByPid = new Map();
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function readRegistry() {
  const next = new Map();
  const byPid = new Map();
  let names = [];
  try { names = await fsp.readdir(REGISTRY); } catch {}
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const o = JSON.parse(await fsp.readFile(path.join(REGISTRY, n), 'utf8'));
      if (!o.sessionId || !pidAlive(o.pid) || o.kind === 'background-task') continue;
      const e = { pid: o.pid, status: o.status || 'idle', entrypoint: o.entrypoint || 'cli', cwd: o.cwd };
      byPid.set(o.pid, { ...e, sessionId: o.sessionId });
      if (!next.has(o.sessionId) || o.pid > next.get(o.sessionId).pid) next.set(o.sessionId, e);
    } catch {}
  }
  registry = next;
  registryByPid = byPid;
}

let lastLive = '';
async function tickLive() {
  await readRegistry();
  let moved = false;
  for (const t of terms.values()) {
    if (t.kind === 'shell') {
      // Names the program in the foreground, such as vim or node.
      let fg = null;
      try { fg = t.proc.process; } catch {}
      const shellName = path.basename(t.shell);
      t.label = fg && fg.replace(/^-/, '') !== shellName ? path.basename(fg) : null;
      continue;
    }
    const r = registryByPid.get(t.pid);
    if (r) {
      t.status = r.status;
      if (r.sessionId !== t.sessionId) { t.sessionId = r.sessionId; moved = true; }
    }
  }
  const payload = JSON.stringify({ terms: termList(), external: externalLive() });
  if (payload !== lastLive) {
    lastLive = payload;
    broadcast({ t: 'live', ...JSON.parse(payload) });
  }
  if (moved) announceChanged();
}
function externalLive() {
  const mine = new Set([...terms.values()].map((t) => t.pid));
  const out = {};
  for (const [id, e] of registry) {
    if (!mine.has(e.pid)) out[id] = { pid: e.pid, status: e.status, where: whereLabel(e.entrypoint) };
  }
  return out;
}
const whereLabel = (ep) => (ep === 'claude-desktop' ? 'Claude Desktop' : ep === 'cli' ? 'a terminal' : 'another process');

// ---------- pseudo-terminals ----------
const terms = new Map();
const termList = () => [...terms.values()].map((t) => ({
  termId: t.termId, sessionId: t.sessionId, pid: t.pid, cwd: t.cwd, status: t.status,
  kind: t.kind, label: t.label || null, project: projectOf(t.cwd).path, startedAt: t.startedAt,
}));

function startTerm({ sessionId, cwd, fork, cols, rows }) {
  const isNew = !sessionId;
  const args = [];
  let id = sessionId;
  if (isNew) { id = crypto.randomUUID(); args.push('--session-id', id); }
  else { args.push('--resume', sessionId); if (fork) args.push('--fork-session'); }
  const p = pty.spawn(CLAUDE, args, {
    name: 'xterm-256color', cols: cols || 110, rows: rows || 34, cwd,
    env: ENV,
  });
  const t = registerTerm(p, { kind: 'claude', cwd, status: 'starting', sessionId: fork ? null : id });
  evict();
  return t;
}

// A plain login shell in the chat's folder, for the New Terminal button.
function startShell({ cwd, cols, rows }) {
  const shell = ENV.SHELL || '/bin/zsh';
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color', cols: cols || 110, rows: rows || 34, cwd, env: { ...ENV, PWD: cwd },
  });
  return registerTerm(p, { kind: 'shell', cwd, status: 'shell', sessionId: null, shell });
}

function registerTerm(p, fields) {
  const termId = crypto.randomUUID();
  const t = {
    termId, pid: p.pid, proc: p, startedAt: Date.now(), lastViewed: Date.now(),
    chunks: [], ringSize: 0, evicted: false, ...fields,
  };
  terms.set(termId, t);
  p.onData((d) => {
    t.chunks.push(d);
    t.ringSize += d.length;
    while (t.ringSize > RING_BYTES && t.chunks.length > 1) t.ringSize -= t.chunks.shift().length;
    broadcast({ t: 'out', id: termId, d });
  });
  p.onExit(({ exitCode }) => {
    terms.delete(termId);
    broadcast({ t: 'exit', id: termId, code: exitCode, evicted: t.evicted, sessionId: t.sessionId, kind: t.kind });
    announceChanged();
  });
  announceChanged();
  return t;
}

// Each claude process holds memory, so idle chats beyond the limit are closed.
// Their transcript is on disk; clicking one resumes it.
function evict() {
  const max = Number(state.prefs.maxLive) || 10;
  const chats = [...terms.values()].filter((t) => t.kind !== 'shell');
  const idle = chats
    .filter((t) => t.status === 'idle' && !visibleTerms.has(t.termId))
    .sort((a, b) => a.lastViewed - b.lastViewed);
  let excess = chats.length - max;
  for (const t of idle) {
    if (excess-- <= 0) break;
    t.evicted = true;
    t.proc.kill();
  }
}
let visibleTerms = new Set();

function cwdForSession(id) {
  return index.get(id)?.cwd || [...terms.values()].find((t) => t.sessionId === id)?.cwd || null;
}

// ---------- change notifications ----------
const clients = new Set();
function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
let changedTimer;
function announceChanged() {
  if (changedTimer) return;
  changedTimer = setTimeout(() => { changedTimer = null; broadcast({ t: 'changed' }); }, 800);
}

const dirty = new Set();
let dirtyTimer;
function watchProjects() {
  try {
    fs.watch(PROJECTS, { recursive: true }, (_ev, name) => {
      if (!name || !name.endsWith('.jsonl')) return;
      const parts = name.split(path.sep);
      if (parts.length !== 2) return; // subagent transcripts live deeper
      dirty.add(path.join(PROJECTS, name));
      clearTimeout(dirtyTimer);
      dirtyTimer = setTimeout(async () => {
        const files = [...dirty];
        dirty.clear();
        let any = false;
        await pool(files, 8, async (f) => { if (await refreshFile(f)) any = true; });
        if (any) announceChanged();
      }, 700);
    });
  } catch (e) {
    console.error('watch failed', e.message);
  }
}

// ---------- content search ----------
let searchProc = null;
function searchContent(q) {
  return new Promise((resolve) => {
    if (searchProc) searchProc.kill();
    const finish = (out) => {
      resolve([...new Set(out.split('\n').filter(Boolean).map((f) => path.basename(f, '.jsonl')))]);
    };
    // Claude Code bundles ripgrep: the same binary behaves as rg when argv0 is rg.
    const rg = spawn(CLAUDE, ['-il', '-F', '--glob', '*.jsonl', '--max-depth', '2', '--', q, PROJECTS], { argv0: 'rg', env: ENV });
    searchProc = rg;
    let out = '';
    rg.stdout.on('data', (d) => { out += d; });
    rg.stderr.on('data', () => {});
    rg.on('error', () => resolve([]));
    rg.on('close', () => { if (searchProc === rg) searchProc = null; finish(out); });
  });
}

// ---------- HTTP ----------
let PORT = 0;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const hostOk = (req) => req.headers.host === `127.0.0.1:${PORT}`;
const tokenEq = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 2e6) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { env: ENV }, (err, stdout) => resolve({ err, stdout })));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const asq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const MD_EXT = /\.(md|markdown|mdx)$/i;
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
};

// The shell may have moved with cd, so ask the OS where it is now.
function liveCwd(pid) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 1500 }, (err, stdout) => {
      const line = (stdout || '').split('\n').find((l) => l.startsWith('n'));
      resolve(err || !line ? null : line.slice(1));
    });
  });
}

// Finds the first candidate text from the terminal that names a real file or folder.
async function resolvePath(t, candidates) {
  if (!t) return null;
  const bases = [];
  if (t.kind === 'shell') { const c = await liveCwd(t.pid); if (c) bases.push(c); }
  bases.push(t.cwd, projectOf(t.cwd).path);
  for (let index = 0; index < candidates.length; index++) {
    let raw = String(candidates[index] || '');
    if (!raw || raw.length > 1024) continue;
    if (raw.startsWith('file://')) { try { raw = decodeURIComponent(new URL(raw).pathname); } catch { continue; } }
    for (const form of new Set([raw, raw.replace(/:\d+(:\d+)?$/, '')])) {
      const expanded = form === '~' ? HOME : form.startsWith('~/') ? path.join(HOME, form.slice(2)) : form;
      const tries = path.isAbsolute(expanded) ? [expanded] : bases.map((b) => path.resolve(b, expanded));
      for (const p of new Set(tries)) {
        try {
          const st = await fsp.stat(p);
          return { index, path: p, kind: st.isDirectory() ? 'dir' : MD_EXT.test(p) ? 'md' : 'file' };
        } catch {}
      }
    }
  }
  return null;
}

async function api(req, res, url) {
  const route = url.pathname.slice(5);
  const body = req.method === 'POST' ? await readBody(req) : {};
  switch (route) {
    case 'sessions':
      return send(res, 200, sidebarData(url.searchParams.get('automated') === '1', url.searchParams.get('hidden') === '1'));
    case 'terms':
      return send(res, 200, { terms: termList(), external: externalLive() });
    case 'state':
      return send(res, 200, { prefs: state.prefs, hiddenProjects: state.hiddenProjects });
    case 'prefs':
      state.prefs = { ...state.prefs, ...body };
      saveState();
      return send(res, 200, { ok: true });
    case 'open': {
      const { sessionId, fork, force, mkdir, cols, rows } = body;
      if (sessionId && !UUID.test(sessionId)) return send(res, 400, { error: 'bad session id' });
      const already = !fork && [...terms.values()].find((t) => t.sessionId === sessionId && sessionId);
      if (already) return send(res, 200, { termId: already.termId, sessionId: already.sessionId, pid: already.pid, kind: already.kind, project: projectOf(already.cwd).path, cwd: already.cwd });
      const cwd = sessionId ? (cwdForSession(sessionId) || body.cwd) : body.cwd;
      if (!cwd || !path.isAbsolute(cwd)) return send(res, 400, { error: 'no folder for this chat' });
      if (!fs.existsSync(cwd)) {
        if (!mkdir) return send(res, 200, { missingCwd: cwd });
        fs.mkdirSync(cwd, { recursive: true });
      }
      const ext = sessionId && !fork && !force ? registry.get(sessionId) : null;
      if (ext) return send(res, 200, { conflict: { where: whereLabel(ext.entrypoint), pid: ext.pid, status: ext.status } });
      const t = startTerm({ sessionId, cwd, fork, cols, rows });
      // Anything opened here stays in the sidebar, whatever kind of run started it.
      const mark = t.sessionId || sessionId;
      if (mark && !state.opened?.[mark]) { (state.opened ||= {})[mark] = 1; saveState(); }
      return send(res, 200, { termId: t.termId, sessionId: t.sessionId, pid: t.pid, kind: t.kind, project: projectOf(t.cwd).path, cwd: t.cwd });
    }
    case 'shell': {
      const { cwd, cols, rows } = body;
      if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return send(res, 200, { error: `Folder not found: ${cwd}` });
      const t = startShell({ cwd, cols, rows });
      return send(res, 200, { termId: t.termId, pid: t.pid, cwd: t.cwd, kind: t.kind, project: projectOf(cwd).path, startedAt: t.startedAt });
    }
    case 'close': {
      const t = terms.get(body.termId);
      if (t) t.proc.kill();
      return send(res, 200, { ok: true });
    }
    case 'rename':
      if (!UUID.test(body.id || '')) return send(res, 400, {});
      if (body.title) state.titles[body.id] = String(body.title).slice(0, 200); else delete state.titles[body.id];
      saveState(); announceChanged();
      return send(res, 200, { ok: true });
    case 'hide':
      if (!UUID.test(body.id || '')) return send(res, 400, {});
      if (body.hidden) state.hidden[body.id] = 1; else delete state.hidden[body.id];
      saveState(); announceChanged();
      return send(res, 200, { ok: true });
    case 'hide-project':
      if (body.hidden) state.hiddenProjects[body.path] = 1; else delete state.hiddenProjects[body.path];
      saveState(); announceChanged();
      return send(res, 200, { ok: true });
    case 'search': {
      const q = url.searchParams.get('q') || '';
      return send(res, 200, { ids: q.length >= 2 ? await searchContent(q) : [] });
    }
    case 'pick-folder': {
      const { stdout, err } = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for the new chat")']);
      return send(res, 200, { path: err ? null : stdout.trim().replace(/\/$/, '') });
    }
    case 'reveal': {
      // Paths can come from terminal output, so nothing here may launch. A plain
      // folder opens; a file, or a folder with an extension such as Foo.app, is only
      // selected in Finder.
      let st;
      try { st = await fsp.stat(body.path); } catch { return send(res, 200, { error: 'not found' }); }
      const plainFolder = st.isDirectory() && !path.extname(body.path);
      await run('/usr/bin/open', plainFolder ? [body.path] : ['-R', body.path]);
      return send(res, 200, { ok: true });
    }
    case 'resolve-path': {
      const t = terms.get(body.termId);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 6) : [];
      return send(res, 200, { match: await resolvePath(t, candidates) });
    }
    case 'md': {
      if (!MD_EXT.test(body.path || '')) return send(res, 400, { error: 'not a markdown file' });
      let st;
      try { st = await fsp.stat(body.path); } catch { return send(res, 200, { missing: true }); }
      if (st.size > 5 * 1024 * 1024) return send(res, 200, { error: 'File is too large to preview (over 5 MB).' });
      if (body.since === st.mtimeMs) return send(res, 200, { unchanged: true });
      return send(res, 200, { mtime: st.mtimeMs, text: await fsp.readFile(body.path, 'utf8') });
    }
    case 'open-terminal': {
      if (!UUID.test(body.sessionId || '')) return send(res, 400, {});
      const cwd = cwdForSession(body.sessionId);
      if (!cwd || !fs.existsSync(cwd)) return send(res, 200, { error: 'folder not found' });
      const cmd = `cd ${shq(cwd)} && ${shq(CLAUDE)} --resume ${body.sessionId}`;
      const { err } = await run('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script ${asq(cmd)}`, '-e', 'tell application "Terminal" to activate']);
      return send(res, 200, { error: err ? err.message : null });
    }
    case 'clipboard': {
      const pb = spawn('/usr/bin/pbcopy', [], { env: ENV });
      pb.stdin.end(String(body.text ?? ''));
      return send(res, 200, { ok: true });
    }
    case 'open-url': {
      // Links come from terminal output, so only web links open directly.
      // A file link is revealed in Finder rather than launched.
      let u;
      try { u = new URL(body.url); } catch { return send(res, 400, {}); }
      if (u.protocol === 'http:' || u.protocol === 'https:') await run('/usr/bin/open', [u.href]);
      else if (u.protocol === 'file:') await run('/usr/bin/open', ['-R', decodeURIComponent(u.pathname)]);
      return send(res, 200, { ok: true });
    }
    default:
      return send(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  if (!hostOk(req)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!tokenEq(req.headers['x-panecake-token'])) return send(res, 403, { error: 'forbidden' });
      return await api(req, res, url);
    }
    if (url.pathname === '/local-image') {
      // Images inside a Markdown preview. Image types only, behind the launch token.
      const p = url.searchParams.get('path') || '';
      const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
      if (!tokenEq(url.searchParams.get('token')) || !mime || !path.isAbsolute(p)) { res.writeHead(403); return res.end(); }
      const data = await fsp.readFile(p);
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      return res.end(data);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(ROOT, 'public', rel);
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403); return res.end(); }
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; frame-ancestors 'none'",
    });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end(); }
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

// The socket can type into a shell-capable process, so it requires the launch
// token and an exact Origin match. Other sites cannot connect to it.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (!hostOk(req) || req.headers.origin !== `http://127.0.0.1:${PORT}` || !tokenEq(url.searchParams.get('token'))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      const t = terms.get(m.id);
      if (m.t === 'input' && t) t.proc.write(m.d);
      else if (m.t === 'resize' && t && m.cols > 1 && m.rows > 1) {
        try { t.proc.resize(m.cols, m.rows); } catch {}
      } else if (m.t === 'visible') {
        visibleTerms = new Set(m.ids || []);
        for (const id of visibleTerms) { const v = terms.get(id); if (v) v.lastViewed = Date.now(); }
      } else if (m.t === 'replay' && t) {
        ws.send(JSON.stringify({ t: 'replay', id: t.termId, d: t.chunks.join('') }));
      }
    });
  });
});

function shutdown() {
  for (const t of terms.values()) { try { t.proc.kill(); } catch {} }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.env.PANECAKE_PARENT) {
  process.stdin.resume();
  process.stdin.on('end', shutdown);
}

server.listen(Number(process.env.PANECAKE_PORT) || 0, '127.0.0.1', async () => {
  PORT = server.address().port;
  console.log(`PANECAKE_READY http://127.0.0.1:${PORT}/#${TOKEN}`);
  watchProjects();
  setInterval(tickLive, 1000);
  setInterval(() => fullScan().catch(() => {}), 5 * 60 * 1000);
  await readRegistry();
  fullScan().catch((e) => { console.error(e); indexReady = true; announceChanged(); });
});

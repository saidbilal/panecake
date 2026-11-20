// Release notes live in CHANGELOG.md, one "## x.y.z" section per release. The
// server shows the section for a new version in the What's New popup after an
// update, and /release previews and publishes the same text.
//
//   node scripts/notes.mjs print [x.y.z]   print one release's notes
//   node scripts/notes.mjs preview         open the popup for package.json's version
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(import.meta.dirname);
const MAX_NOTES = 20000;

// Newest first, as [{ version, text }]. Sections without text are left out.
export function parseNotes(text) {
  const sections = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^##\s+v?(\d{1,6}\.\d{1,6}\.\d{1,6})\s*$/.exec(line);
    if (m) { cur = { version: m[1], lines: [] }; sections.push(cur); continue; }
    if (/^#{1,2}\s/.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  const num = (v) => v.split('.').map(Number);
  return sections
    .map((s) => ({ version: s.version, text: s.lines.join('\n').trim().slice(0, MAX_NOTES) }))
    .filter((s) => s.text)
    .sort((a, b) => { const x = num(a.version), y = num(b.version); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
}

export function readNotes(root = ROOT) {
  try { return parseNotes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')); } catch { return []; }
}

function main() {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');
  const [cmd, arg] = args.filter((a) => !a.startsWith('--'));
  const version = arg || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const found = readNotes().find((n) => n.version === version);
  if (cmd !== 'print' && cmd !== 'preview') {
    console.error('Usage: node scripts/notes.mjs print [x.y.z] | preview [--no-open]');
    process.exit(2);
  }
  if (!found) {
    console.error(`CHANGELOG.md has no "## ${version}" section with text.`);
    process.exit(1);
  }
  if (cmd === 'print') { console.log(found.text); return; }

  // A separate server on throwaway settings, so the running app is left alone.
  // It shows the popup on every load and never records it as seen.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panecake-preview-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { ...process.env, PANECAKE_DATA_DIR: dataDir, PANECAKE_NO_UPDATE_CHECK: '1', PANECAKE_WHATS_NEW: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stop = () => { try { child.kill(); } catch {} };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', () => process.exit(0));
  // This server can start shells, so a forgotten preview does not stay up.
  setTimeout(stop, 15 * 60 * 1000);
  let out = '';
  child.stdout.on('data', (d) => {
    if (out === null) return;
    out += d;
    const m = /PANECAKE_READY (\S+)/.exec(out);
    if (!m) return;
    out = null;
    console.log(`Previewing the What's New popup for ${version}: ${m[1]}`);
    console.log('Reload the page after editing CHANGELOG.md. Stops on Ctrl+C or after 15 minutes.');
    if (!noOpen) spawn('/usr/bin/open', [m[1]], { stdio: 'ignore' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

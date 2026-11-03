// Copies the browser files out of node_modules and restores the execute bit on
// node-pty's helper binary (npm strips it when install scripts are not run).
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'public/vendor');
fs.mkdirSync(out, { recursive: true });
for (const f of [
  '@xterm/xterm/lib/xterm.js', '@xterm/xterm/css/xterm.css',
  '@xterm/addon-fit/lib/addon-fit.js',
  '@xterm/addon-unicode11/lib/addon-unicode11.js',
  'marked/lib/marked.umd.js', 'dompurify/dist/purify.min.js',
]) fs.copyFileSync(path.join(root, 'node_modules', f), path.join(out, path.basename(f)));
const pre = path.join(root, 'node_modules/node-pty/prebuilds');
for (const d of fs.readdirSync(pre)) {
  const helper = path.join(pre, d, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
console.log('vendor ok');

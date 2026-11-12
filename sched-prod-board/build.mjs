// Builds the board for one deploy: writes app/config.js from the current session and stamps the build
// id into the page (plan R6). Run it before serving or deploying.
//
//   node build.mjs                  # session from ../.runs/show-me-when/session.txt
//   SESSION_FILE=<path> node build.mjs
//
// The build id is the starter repo's short commit, or a hash of app/ when it has no commit yet.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const appDir = join(root, 'app');
const sessionFile = process.env.SESSION_FILE ?? join(root, '..', '.runs', 'show-me-when', 'session.txt');

/** The two places R6 puts the build id, matched so the stamp can be replaced and normalised. */
const BUILD_META = /<meta name="build" content="[^"]*" \/>/;
const BUILD_SPAN = /(<span data-testid="build-sha">)[^<]*(<\/span>)/;

/** One `key: value` line out of the session record. */
function setting(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (!match) throw new Error(`session record has no ${key}`);
  return match[1].trim();
}

function buildId() {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    // Only this folder's own repo counts: the workspace repo above it says nothing about this build.
    if (top && resolve(top) === root) {
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      if (sha) return sha;
    }
  } catch {
    // no repo, no commit yet: fall through to a content hash
  }
  const hash = createHash('sha256');
  for (const name of readdirSync(appDir).sort()) {
    const file = join(appDir, name);
    if (!statSync(file).isFile()) continue;
    // config.js holds the night's key and the recordings are payload, not build: neither names the build.
    if (name === 'config.js' || name.endsWith('.webm')) continue;
    // The stamp itself is not part of the build, so hashing it would move the id on every build.
    hash.update(name).update(readFileSync(file, 'utf8').replace(BUILD_META, '<meta name="build" content="dev" />').replace(BUILD_SPAN, '$1dev$2'));
  }
  return hash.digest('hex').slice(0, 7);
}

const record = readFileSync(sessionFile, 'utf8');
const api = setting(record, 'api');
const session = setting(record, 'session');

writeFileSync(
  join(appDir, 'config.js'),
  [
    '// Written by build.mjs from the current session. Not committed: it holds the night\'s key.',
    `export const API = ${JSON.stringify(api)};`,
    `export const SESSION = ${JSON.stringify(session)};`,
    '',
  ].join('\n'),
);

const sha = buildId();
const indexPath = join(appDir, 'index.html');
const html = readFileSync(indexPath, 'utf8')
  .replace(BUILD_META, `<meta name="build" content="${sha}" />`)
  .replace(BUILD_SPAN, `$1${sha}$2`);
writeFileSync(indexPath, html);

for (const [what, present] of [
  ['meta build', html.includes(`<meta name="build" content="${sha}" />`)],
  ['footer build-sha', html.includes(`<span data-testid="build-sha">${sha}</span>`)],
]) {
  if (!present) throw new Error(`R6: ${what} is missing from app/index.html`);
}

console.log(`built ${sha} -> app/config.js (api ${api})`);

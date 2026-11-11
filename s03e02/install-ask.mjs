#!/usr/bin/env node
// s03e02 install-ask: writes the `ask` skill the course handed over, straight from the artifact
// reply, and checks every file against the sha256 the reply carries.
//
// The reply reaches this session through the client's own message log, which keeps the tool result
// whole; the rendered copy in the conversation is cut in the middle. This script reads that log, so
// the bytes written are the bytes the course sent, not a retyped version of them.
//
// Usage:
//   node s03e02/install-ask.mjs                    # report only: files, sizes, target folder
//   node s03e02/install-ask.mjs --write            # create the folder and write the files
//   node s03e02/install-ask.mjs --session <id>     # pick a session folder by hand
//
// The target is `.agents/skills/<folder>`, the skills folder this harness reads. Nothing outside
// that folder is touched: no other file, no other folder, no removal of anything that was there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SKILLS = path.join(ROOT, '.agents', 'skills');
const SESSIONS = path.join(os.homedir(), '.cline', 'data', 'sessions');
const VERSION = '3c51fd6aad28';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;

/** Every string in a parsed log, however deeply it sits. */
function* strings(node) {
  if (typeof node === 'string') yield node;
  else if (Array.isArray(node)) for (const item of node) yield* strings(item);
  else if (node && typeof node === 'object') for (const value of Object.values(node)) yield* strings(value);
}

/** The reply may arrive as JSON text inside JSON text: dig through each layer. */
function findInstall(node, depth = 0) {
  if (depth > 16) return null;
  if (node && typeof node === 'object') {
    if (!Array.isArray(node) && node.status === 'install' && node.version === VERSION && Array.isArray(node.files)) {
      return node;
    }
    for (const value of Object.values(node)) {
      const hit = findInstall(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'string' || !node.includes(VERSION)) return null;
  const candidates = [node];
  const from = node.indexOf('{');
  const to = node.lastIndexOf('}');
  if (from >= 0 && to > from) candidates.push(node.slice(from, to + 1));
  for (const candidate of candidates) {
    try {
      const hit = findInstall(JSON.parse(candidate), depth + 1);
      if (hit) return hit;
    } catch {
      // not JSON at this layer; the next candidate may be
    }
  }
  return null;
}

/** The artifact reply for this version, from the newest message log that carries it. */
function artifactReply() {
  const dirs = (sessionArg ? [sessionArg] : fs.readdirSync(SESSIONS).sort().reverse()).map((name) =>
    path.join(SESSIONS, name)
  );
  for (const dir of dirs) {
    const log = path.join(dir, `${path.basename(dir)}.messages.json`);
    if (!fs.existsSync(log)) continue;
    const raw = fs.readFileSync(log, 'utf-8');
    if (!raw.includes(VERSION)) continue;
    const reply = findInstall(JSON.parse(raw));
    if (reply) return { dir: path.basename(dir), reply };
  }
  return null;
}

const found = artifactReply();
if (!found) {
  console.error(`no artifact reply for version ${VERSION} in ${SESSIONS}`);
  process.exit(1);
}

const reply = found.reply;
const folder = path.join(SKILLS, reply.folder);
console.log(JSON.stringify({ session: found.dir, name: reply.name, version: reply.version, files: reply.files.length, folder }, null, 2));

let bad = 0;
for (const file of reply.files) {
  const target = path.join(folder, file.path);
  const bytes = Buffer.from(file.content, 'utf-8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const report = { path: file.path, bytes: bytes.length, sha256Matches: sha === file.sha256 };
  if (!report.sha256Matches) bad++;
  if (WRITE && report.sha256Matches) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    report.written = true;
    report.onDiskMatches = createHash('sha256').update(fs.readFileSync(target)).digest('hex') === file.sha256;
    if (!report.onDiskMatches) bad++;
  }
  console.log(`${report.written ? 'written' : 'ready  '} ${file.path}  ${report.bytes} bytes  ${report.sha256Matches ? 'sha ok' : 'SHA MISMATCH'}`);
}

if (bad) {
  console.error(`\n${bad} problem(s).`);
  process.exitCode = 1;
} else if (!WRITE) {
  console.log('\nreport only; run with --write to create the folder and the files');
} else {
  console.log(`\ninstalled ${reply.name} version ${reply.version} into ${folder}`);
}


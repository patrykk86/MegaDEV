#!/usr/bin/env node
/**
 * tools/kb-check.mjs - Support knowledge base structure and contract validator
 *
 * Guards support-kb notes before their content reaches a session:
 * - frontmatter carries title, owner, status and a YYYY-MM-DD reviewed date, and the status is known.
 * - a note opens with its BLUF paragraph, never with a subheading, and no two notes share a title.
 * - internal /kb links resolve, and a note unreachable from /kb is reported as a warning.
 */

import fs from 'node:fs';
import path from 'node:path';

const VALID_STATUSES = new Set(['draft', 'living', 'known', 'open', 'accepted', 'superseded', 'resolved', 'monitoring', 'archived']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function walkNotes(dir, fileList = []) {
  if (!fs.existsSync(dir)) {
    return fileList;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkNotes(full, fileList);
    } else if (entry.name.endsWith('.svx') || entry.name.endsWith('.md')) {
      fileList.push(full);
    }
  }
  return fileList;
}

export function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: null, body: raw };
  }
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) {
      data[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, body: raw.slice(match[0].length) };
}

function stripScriptsAndComponents(svxBody) {
  return svxBody
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .trim();
}

function checkBLUF(proseBody) {
  const lines = proseBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('<'));
  if (lines.length === 0) {
    return 'Note has no prose body (missing BLUF opening paragraph).';
  }
  const firstIdx = lines[0].startsWith('# ') ? 1 : 0;
  const firstBlock = lines[firstIdx];
  if (!firstBlock) {
    return 'Missing BLUF paragraph after title.';
  }
  if (/^#{2,6}\s/.test(firstBlock)) {
    return `Violation of Rule 1 (BLUF): Note starts with subheading "${firstBlock}" before stating purpose and conclusion.`;
  }
  return null;
}

function toRouteSlug(routesKbDir, filePath) {
  const rel = path.relative(routesKbDir, filePath).replace(/\\/g, '/');
  if (rel === '+page.svx' || rel === 'index.md') {
    return '/kb';
  }
  if (rel.endsWith('/+page.svx')) {
    return `/kb/${rel.slice(0, -'/+page.svx'.length)}`;
  }
  return `/kb/${rel.replace(/\.(svx|md)$/, '')}`;
}

function checkRequiredFrontmatter(data, body, relPath, errors) {
  for (const reqField of ['title', 'owner', 'status', 'reviewed']) {
    if (!data[reqField]) {
      errors.push(`${relPath}: Missing required frontmatter property "${reqField}".`);
    }
  }
  if (data.status && !VALID_STATUSES.has(data.status)) {
    errors.push(`${relPath}: Unknown status "${data.status}". Expected one of: ${[...VALID_STATUSES].join(', ')}`);
  }
  if (data.reviewed && !DATE_RE.test(data.reviewed)) {
    errors.push(`${relPath}: Frontmatter "reviewed" (${data.reviewed}) must be YYYY-MM-DD.`);
  }
  if (data.signature && !/<RenderStamp\s+\{?signature\}?/.test(body)) {
    errors.push(`${relPath}: Frontmatter defines signature but note is missing <RenderStamp {signature} />.`);
  }
}

function resolveInternalTarget(target, slug) {
  if (!target || /^https?:|^mailto:/.test(target)) {
    return null;
  }
  let resolved = target;
  if (target.startsWith('.')) {
    const baseDir = slug === '/kb' ? '/kb' : path.posix.dirname(slug);
    resolved = path.posix.normalize(path.posix.join(baseDir, target));
  }
  resolved = resolved.replace(/\/+$/, '') || '/kb';
  return resolved.startsWith('/kb') ? resolved : null;
}

function extractKbLinks(raw, slug, slugToFile, adjacency, relPath, errors) {
  const linkMatches = raw.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
  for (const m of linkMatches) {
    const rawTarget = m[2].trim().split('#')[0].split('?')[0];
    const resolved = resolveInternalTarget(rawTarget, slug);
    if (!resolved) {
      continue;
    }
    if (!slugToFile.has(resolved)) {
      errors.push(`${relPath}: Broken internal link to "${resolved}".`);
    } else {
      adjacency.get(slug).add(resolved);
    }
  }
}

function checkNoteIntegrity(file, kbRoot, ctx, errors) {
  const relPath = path.relative(kbRoot, file).replace(/\\/g, '/');
  const slug = ctx.fileToSlug.get(file);
  const isArchived = relPath.includes('/archive/');
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);

  if (!data) {
    errors.push(`${relPath}: Missing YAML frontmatter block.`);
    return;
  }
  checkRequiredFrontmatter(data, body, relPath, errors);

  if (data.title && !isArchived) {
    const norm = data.title.toLowerCase().trim();
    if (ctx.titleToFile.has(norm)) {
      errors.push(`${relPath}: Duplicate note title "${data.title}" (already in ${ctx.titleToFile.get(norm)}).`);
    } else {
      ctx.titleToFile.set(norm, relPath);
    }
  }

  const prose = stripScriptsAndComponents(body);
  const blufErr = checkBLUF(prose);
  if (blufErr && !isArchived) {
    errors.push(`${relPath}: ${blufErr}`);
  }
  extractKbLinks(raw, slug, ctx.slugToFile, ctx.adjacency, relPath, errors);
}

function runReachabilityBfs(adjacency, slugToFile, kbRoot, warnings) {
  if (!slugToFile.has('/kb')) {
    return;
  }
  const visited = new Set(['/kb']);
  const queue = ['/kb'];
  while (queue.length > 0) {
    const curr = queue.shift();
    for (const next of adjacency.get(curr) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  for (const [slug, file] of slugToFile.entries()) {
    const relPath = path.relative(kbRoot, file).replace(/\\/g, '/');
    if (!relPath.includes('/archive/') && !visited.has(slug) && !slug.endsWith('/index')) {
      warnings.push(`${relPath} (${slug}): Unlinked directly from /kb navigation graph.`);
    }
  }
}

export function validateSupportKb(kbRoot = path.resolve('support-kb')) {
  const errors = [];
  const warnings = [];
  const routesKbDir = path.join(kbRoot, 'src', 'routes', 'kb');
  if (!fs.existsSync(routesKbDir)) {
    return { ok: true, errors, warnings, skipped: true };
  }
  const files = walkNotes(routesKbDir);
  const ctx = {
    slugToFile: new Map(),
    fileToSlug: new Map(),
    titleToFile: new Map(),
    adjacency: new Map(),
  };
  for (const file of files) {
    const slug = toRouteSlug(routesKbDir, file);
    ctx.slugToFile.set(slug, file);
    ctx.fileToSlug.set(file, slug);
    ctx.adjacency.set(slug, new Set());
  }
  for (const file of files) {
    checkNoteIntegrity(file, kbRoot, ctx, errors);
  }
  runReachabilityBfs(ctx.adjacency, ctx.slugToFile, kbRoot, warnings);
  return { ok: errors.length === 0, errors, warnings, skipped: false };
}

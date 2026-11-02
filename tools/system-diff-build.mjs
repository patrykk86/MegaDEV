#!/usr/bin/env node
// tools/system-diff-build.mjs
// Builds and validates self-contained HTML decision reports adhering to .agents/skills/system-diff

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const LOCKFILE_RE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|uv\.lock|poetry\.lock)$|\.min\.(?:js|css)$|\.snap$/;

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseHunkLine(line, current) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    current.lines.push({ type: 'add', text: line.slice(1) });
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    current.lines.push({ type: 'del', text: line.slice(1) });
  } else if (line.startsWith(' ')) {
    current.lines.push({ type: 'ctx', text: line.slice(1) });
  }
}

export function parseUnifiedDiffHunks(rawDiff) {
  const lines = rawDiff.split(/\r?\n/);
  const hunks = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      parseHunkLine(line, current);
    }
  }
  return hunks;
}

export function gatherDiffRange(baseRef, headRef, cwd = process.cwd()) {
  const baseSha = git(['rev-parse', baseRef], cwd).trim();
  const headSha = git(['rev-parse', headRef], cwd).trim();
  const range = `${baseSha}...${headSha}`;
  const repo = path.basename(git(['rev-parse', '--show-toplevel'], cwd).trim());
  const nameOnly = git(['diff', '--name-only', range], cwd).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const numstatRaw = git(['diff', '--numstat', range], cwd).split(/\r?\n/).filter(Boolean);

  const stats = new Map();
  for (const line of numstatRaw) {
    const [added, removed, filePath] = line.split('\t');
    stats.set(filePath, {
      added: added === '-' ? 0 : Number(added),
      removed: removed === '-' ? 0 : Number(removed),
      binary: added === '-',
    });
  }

  const files = nameOnly.map((filePath) => {
    const st = stats.get(filePath) ?? { added: 0, removed: 0, binary: false };
    const omit = LOCKFILE_RE.test(filePath) || st.binary;
    const hunks = omit ? [] : parseUnifiedDiffHunks(git(['diff', '-U3', range, '--', filePath], cwd));
    return { path: filePath, added: st.added, removed: st.removed, binary: st.binary, omitHunks: omit, hunks };
  });

  return { repo, baseSha, headSha, base7: baseSha.slice(0, 7), head7: headSha.slice(0, 7), date: new Date().toISOString().slice(0, 10), files };
}

function renderDecisionsHtml(decisions) {
  return decisions.map((d) => {
    const opts = d.options
      .map((opt) => `<li>${opt.star ? '★ ' : ''}<strong>${escapeHtml(opt.letter)})</strong> ${escapeHtml(opt.text)}</li>`)
      .join('');
    return `<li><strong>${escapeHtml(d.title)}</strong> — <span class="gloss-note">${escapeHtml(d.gloss)}</span><ul class="options">${opts}</ul></li>`;
  }).join('');
}

function renderSvgMap(nodes) {
  const boxWidth = 220;
  const boxHeight = 72;
  const cols = Math.min(3, Math.max(1, nodes.length));
  const svgWidth = cols * boxWidth + (cols - 1) * 32 + 40;
  const svgHeight = Math.ceil(nodes.length / cols) * boxHeight + (Math.ceil(nodes.length / cols) - 1) * 32 + 40;

  const svgBoxes = nodes.map((n, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 20 + col * (boxWidth + 32);
    const y = 20 + row * (boxHeight + 32);
    const isCode = n.state === 'changed-code';
    const isBehavior = n.state === 'changed-behavior';
    const fill = isCode ? '#f5f5f5' : '#ffffff';
    const stroke = isCode || isBehavior ? '#111111' : '#888888';
    const dash = isBehavior ? 'stroke-dasharray="6,4"' : '';
    const textFill = isCode || isBehavior ? '#111111' : '#555555';

    return `<g><rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="${isCode || isBehavior ? '2' : '1'}" ${dash} /><text x="${x + 12}" y="${y + 26}" fill="${textFill}" font-weight="600" font-size="14">${escapeHtml(n.name)}</text><text x="${x + 12}" y="${y + 48}" fill="#555555" font-size="12">${escapeHtml(n.gloss)}</text></g>`;
  }).join('\n');

  return `<svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">${svgBoxes}</svg>`;
}

function renderFileEntry(f) {
  let hunksHtml = '';
  if (!f.omitHunks && f.hunks.length > 0) {
    const hunkLines = f.hunks.map((h) => {
      const inner = h.lines.map((l) => {
        let sym = ' ';
        if (l.type === 'add') { sym = '+'; }
        else if (l.type === 'del') { sym = '−'; }
        return `<div class="diff-line diff-${l.type}">${escapeHtml(sym)} ${escapeHtml(l.text)}</div>`;
      }).join('');
      return `<div class="hunk"><div class="hunk-hdr">${escapeHtml(h.header)}</div>${inner}</div>`;
    }).join('');
    hunksHtml = `<div class="file-hunks">${hunkLines}</div>`;
  }
  return `<div class="file-entry"><div class="file-hdr"><span class="file-path">${escapeHtml(f.path)}</span><span class="file-stat">+${f.added} / −${f.removed}</span></div>${hunksHtml}</div>`;
}

function renderPartsAndFiles(parts, files) {
  const partsHtml = parts.map((p) => {
    return `<section class="part" id="part-${escapeHtml(p.slug || p.name.toLowerCase().replace(/\s+/g, '-'))}"><h3>${escapeHtml(p.name)}</h3><p class="part-notice">${escapeHtml(p.notice)}</p><dl class="part-grid"><dt>Before</dt><dd>${escapeHtml(p.before)}</dd><dt>After</dt><dd>${escapeHtml(p.after)}</dd><dt>Why</dt><dd>${escapeHtml(p.why)}</dd><dt>Risk</dt><dd>${escapeHtml(p.risk)}</dd></dl></section>`;
  }).join('');

  const filesByPart = parts.map((p) => {
    const partFiles = files.filter((f) => (p.files || []).includes(f.path));
    return `<div class="file-group"><h4>${escapeHtml(p.name)}</h4>${partFiles.map(renderFileEntry).join('')}</div>`;
  }).join('');

  return { partsHtml, filesByPart };
}

export function renderSystemDiffHtml(diffData, spec) {
  const { repo, base7, head7, date, files } = diffData;
  const rangeLabel = spec.pr ? `PR #${spec.pr}` : `${base7}...${head7}`;

  const upperText = JSON.stringify({ title: spec.title, answer: spec.answer, decisions: spec.decisions, map: spec.map, parts: spec.parts.map(({ files: _f, ...r }) => r) });
  for (const f of files) {
    if (upperText.includes(f.path)) {
      throw new Error(`Layer violation: File path "${f.path}" leaked above #files.`);
    }
  }

  const nodes = spec.map?.nodes ?? spec.parts.map((p) => ({ name: p.name, gloss: p.gloss, state: p.state ?? 'changed-code' }));
  const svgMap = renderSvgMap(nodes);
  const decisionsHtml = renderDecisionsHtml(spec.decisions);
  const { partsHtml, filesByPart } = renderPartsAndFiles(spec.parts, files);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(spec.title)} — ${escapeHtml(repo)} ${escapeHtml(rangeLabel)}</title><style>:root { color-scheme: light; } * { box-sizing: border-box; } body { margin: 0; padding: 32px 20px 64px; background: #ffffff; color: #111111; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 15px; line-height: 1.55; } .col { max-width: 72ch; margin: 0 auto; } .map-wrap { max-width: 960px; margin: 28px auto; } h1 { font-size: 22px; margin: 0 0 6px; } .meta { color: #555555; font-size: 13px; margin-bottom: 20px; } .answer { font-size: 16px; margin: 0 0 24px; } h2 { font-size: 17px; margin: 32px 0 12px; padding-top: 16px; border-top: 1px solid #dddddd; } ol.decisions { margin: 0 0 24px; padding-left: 20px; } ul.options { list-style: none; padding-left: 0; } .part { margin-bottom: 24px; border-bottom: 1px solid #dddddd; padding-bottom: 16px; } dl.part-grid { display: grid; grid-template-columns: 72px 1fr; gap: 6px 12px; margin: 0; } dl.part-grid dt { color: #555555; font-weight: 600; } dl.part-grid dd { margin: 0; } #files { margin-top: 36px; } .file-entry { margin-bottom: 16px; border: 1px solid #dddddd; } .file-hdr { padding: 8px 12px; background: #f5f5f5; display: flex; justify-content: space-between; font-family: ui-monospace, monospace; } .file-hunks { font-family: ui-monospace, monospace; font-size: 12px; border-top: 1px solid #dddddd; } .hunk-hdr { padding: 4px 12px; background: #f5f5f5; color: #555555; } .diff-line { padding: 2px 12px; } .diff-add { background: #f5f5f5; color: #111111; } .diff-del { background: #f5f5f5; color: #555555; text-decoration: line-through; } .diff-ctx { color: #555555; }</style></head><body><div class="col"><h1>${escapeHtml(spec.title)}</h1><div class="meta">${escapeHtml(repo)} · ${escapeHtml(rangeLabel)} · ${escapeHtml(date)}</div><p class="answer">${escapeHtml(spec.answer)}</p><h2>Decisions</h2><ol class="decisions">${decisionsHtml}</ol></div><div class="map-wrap"><h2>System Map</h2>${svgMap}</div><div class="col"><h2>Parts</h2>${partsHtml}<div id="files"><h2>Files</h2>${filesByPart}</div></div></body></html>`;
}

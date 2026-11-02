import fs from 'node:fs';
import path from 'node:path';

const RESERVED = new Set(['skill-creator', 'create-skill', 'skill', 'skills']);
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'metadata', 'disable-model-invocation', 'allowed-tools']);

const DESC_RULES = [
  { lvl: 'error', re: /use this skill (whenever|any ?time|for any|for all)/i, msg: 'over-triggering phrase' },
  { lvl: 'error', re: /whenever (the )?user (asks|wants|mentions|says)/i, msg: 'over-triggering phrase' },
  { lvl: 'error', re: /^(?:use|invoke|call|load)\b/i, msg: 'description must be third person' },
  { lvl: 'error', re: /(?:\.(?:mp3|mp4|wav|m4a|flac|ogg|pdf|docx?|xlsx?|csv|tsv|json|ya?ml|md|txt|html?|png|jpe?g|gif|svg|zip|tar|gz)\b[\s,;/|)]*){2,}/i, msg: 'no lists of file extensions' },
  { lvl: 'error', re: /\bI (?:can|will|am)\b/, msg: 'first person' },
];

function handleKeyMatch(key, rest, state, fm) {
  if (state.key && state.isScalar) {
    fm[state.key] = state.lines.join(' ').trim();
    state.isScalar = false;
    state.lines = [];
  }
  state.key = key;
  if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
    state.isScalar = true;
    state.lines = [];
  } else if (rest === '') {
    fm[key] = {};
  } else {
    fm[key] = rest.replace(/^["']|["']$/g, '').trim();
  }
}

function processFrontmatterLine(line, state, fm) {
  if (!line.trim() || line.trim().startsWith('#')) {
    return;
  }
  const km = line.match(/^([\w-]+):\s*(.*)$/);
  if (km) {
    handleKeyMatch(km[1], km[2], state, fm);
    return;
  }
  if (state.isScalar) {
    if (/^\s+/.test(line)) {
      state.lines.push(line.trim());
    } else {
      fm[state.key] = state.lines.join(' ').trim();
      state.isScalar = false;
      state.lines = [];
    }
    return;
  }
  const sub = line.match(/^\s+([\w-]+):\s*(.*)$/);
  if (sub && state.key && typeof fm[state.key] === 'object') {
    fm[state.key][sub[1]] = sub[2].replace(/^["']|["']$/g, '').trim();
  }
}

export function parseFrontmatter(raw) {
  if (raw.charCodeAt(0) === 0xfeff) {
    throw new Error('BOM before frontmatter');
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) {
    throw new Error('frontmatter must start at byte 0 with "---" and terminate with "---"');
  }
  const block = m[1];
  const body = raw.slice(m[0].length);
  const fm = {};
  const state = { key: null, isScalar: false, lines: [] };

  for (const line of block.split(/\r?\n/)) {
    processFrontmatterLine(line, state, fm);
  }
  if (state.key && state.isScalar) {
    fm[state.key] = state.lines.join(' ').trim();
  }
  return { fm, body };
}

function checkName(name, folder, rel, problems) {
  if (!name) {
    problems.push(`${rel}: missing "name"`);
    return;
  }
  if (!NAME_RE.test(name) || name.length > 64) {
    problems.push(`${rel}: name "${name}" must match ${NAME_RE} and be ≤64 chars`);
  }
  if (name !== folder) {
    problems.push(`${rel}: name "${name}" ≠ folder "${folder}"`);
  }
  if (RESERVED.has(name)) {
    problems.push(`${rel}: name "${name}" is reserved`);
  }
}

function checkDescription(d, rel, problems) {
  if (typeof d !== 'string' || !d.trim()) {
    problems.push(`${rel}: missing "description"`);
    return;
  }
  if (d.length > 1024) {
    problems.push(`${rel}: description ${d.length} chars > 1024`);
  } else if (d.length > 300) {
    problems.push(`${rel}: description ${d.length} chars > 300 target limit`);
  }
  if (/[<>]/.test(d)) {
    problems.push(`${rel}: description contains XML`);
  }
  if (/not for/i.test(d) && !/use [`']?[a-z0-9-]+/i.test(d)) {
    problems.push(`${rel}: "Not for X" must name the owning skill ("use Y")`);
  }
  for (const r of DESC_RULES) {
    if (r.lvl === 'error' && r.re.test(d)) {
      problems.push(`${rel}: description — ${r.msg}`);
    }
  }
}

function checkBody(body, rel, skillDir, problems) {
  if (/<insert|TODO|TBD|FIXME|XXX>/.test(body)) {
    problems.push(`${rel}: placeholder text in body`);
  }
  const lines = body.split(/\r?\n/).length;
  if (lines > 800) {
    problems.push(`${rel}: body ${lines} lines > 800`);
  }
  for (const m of body.matchAll(/\]\(([^)#]+)\)/g)) {
    const target = m[1];
    if (!/^https?:/.test(target) && !fs.existsSync(path.resolve(skillDir, target))) {
      problems.push(`${rel}: broken link "${target}"`);
    }
  }
}

export function validateSkill(skillDir, problems) {
  const rel = path.relative(process.cwd(), skillDir).replace(/\\/g, '/');
  const file = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(file)) {
    problems.push(`${rel}: missing SKILL.md`);
    return;
  }
  let parsed = null;
  try {
    parsed = parseFrontmatter(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    problems.push(`${rel}/SKILL.md: ${e.message}`);
    return;
  }
  const { fm, body } = parsed;
  checkName(fm.name, path.basename(skillDir), rel, problems);
  checkDescription(fm.description, rel, problems);
  checkBody(body, rel, skillDir, problems);

  for (const k of Object.keys(fm)) {
    if (!ALLOWED_KEYS.has(k)) {
      problems.push(`${rel}: unknown frontmatter key "${k}" (portability)`);
    }
  }
  if (fm.metadata?.version && !SEMVER_RE.test(fm.metadata.version)) {
    problems.push(`${rel}: metadata.version "${fm.metadata.version}" not semver`);
  }
}

export function checkSkillOverlap(skills, problems) {
  const STOP = new Set(['the','a','an','and','or','for','to','of','in','on','with','when','use','this','that','is','are','it','as','by','from','not']);
  const toks = (s) => new Set(s.toLowerCase().match(/[a-z0-9-]+/g)?.filter((t) => !STOP.has(t)) ?? []);
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = toks(skills[i].description);
      const b = toks(skills[j].description);
      const inter = [...a].filter((t) => b.has(t)).length;
      const jac = inter / (a.size + b.size - inter || 1);
      if (jac > 0.6) {
        problems.push(`skills "${skills[i].name}" and "${skills[j].name}" overlap (Jaccard ${jac.toFixed(2)}) — add "Not for X; use Y".`);
      }
    }
  }
}

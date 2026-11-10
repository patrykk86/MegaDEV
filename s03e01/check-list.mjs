// s03e01 check-list: validates the claim's list before it is sent — every tag exactly once, every
// conflict naming another tag or a record id, every source carrying a citation.
//
// Usage: node s03e01/check-list.mjs [requirements.json]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(DIR, 'requirements.json');
const { list } = JSON.parse(fs.readFileSync(file, 'utf-8'));

const problems = [];
const entries = [...(list.accepted ?? []), ...(list.conflicts ?? [])];
const tags = entries.map((entry) => entry.tag);
const duplicates = tags.filter((tag, index) => tags.indexOf(tag) !== index);

if (duplicates.length > 0) {
  problems.push(`tag listed twice: ${[...new Set(duplicates)].join(', ')}`);
}
for (const entry of entries) {
  if (!entry.source?.file) {
    problems.push(`${entry.tag}: no source file`);
  }
  if (entry.source && !entry.source.at && !entry.source.region && !/^https?:/.test(entry.source.file)) {
    problems.push(`${entry.tag}: source has neither at, region nor a link`);
  }
  if (entry.ownerQuestion && !/R-[A-Z0-9]{3}|^\d+$/.test(String(entry.with))) {
    problems.push(`${entry.tag}: with is neither a tag nor a record id (${entry.with})`);
  }
}

const expected = ['R-H5X', 'R-L9M', 'R-Z2X', 'R-K2L', 'R-M4X', 'R-H6X', 'R-L5X', 'R-Z3L', 'R-H9X', 'R-M9H', 'R-L2Z', 'R-K5Z', 'R-Z2L', 'R-K8X', 'R-K4H'];
const missing = expected.filter((tag) => !tags.includes(tag));

console.log(
  JSON.stringify(
    {
      accepted: (list.accepted ?? []).length,
      conflicts: (list.conflicts ?? []).length,
      tags: tags.length,
      uniqueTags: new Set(tags).size,
      missing,
      problems,
    },
    null,
    2,
  ),
);

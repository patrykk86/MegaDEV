// s03e01 pdf-cite: reads pdftotext's -bbox-layout XHTML and turns each R-XXX tag into a citation
// region (0-1 fractions of its page), so a requirement points at where it actually sits.
//
// Usage: node s03e01/pdf-cite.mjs s03e01/spec-bbox.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(DIR, 'spec-bbox.html');
const html = fs.readFileSync(file, 'utf-8');

const decode = (value) =>
  value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const pages = [...html.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)];
const results = [];

pages.forEach((page, index) => {
  const width = Number(page[1]);
  const height = Number(page[2]);
  const words = [...page[3].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map(
    (word) => ({
      xMin: Number(word[1]),
      yMin: Number(word[2]),
      xMax: Number(word[3]),
      yMax: Number(word[4]),
      text: decode(word[5]),
    }),
  );

  for (const word of words) {
    if (!/^R-[A-Z0-9]{3}$/.test(word.text)) {
      continue;
    }
    const line = words.filter((other) => Math.abs(other.yMin - word.yMin) < 3 && other.xMin >= word.xMin - 1);
    const xMin = Math.min(...line.map((item) => item.xMin));
    const xMax = Math.max(...line.map((item) => item.xMax));
    const yMin = Math.min(...line.map((item) => item.yMin));
    const yMax = Math.max(...line.map((item) => item.yMax));
    results.push({
      tag: word.text,
      page: index + 1,
      text: line.map((item) => item.text).join(' '),
      region: {
        page: index + 1,
        x: Number((xMin / width).toFixed(3)),
        y: Number((yMin / height).toFixed(3)),
        w: Number(((xMax - xMin) / width).toFixed(3)),
        h: Number(((yMax - yMin) / height).toFixed(3)),
      },
    });
  }
});

console.log(JSON.stringify(results, null, 2));

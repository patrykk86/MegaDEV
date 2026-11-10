// s03e01 pdf probe: reports the structure of spec.pdf before any text is extracted, so the
// extractor is chosen from what the file actually uses (compression, fonts, page count).
//
// Usage: node s03e01/pdf-probe.mjs s03e01/pack/spec.pdf

import fs from 'node:fs';

const file = process.argv[2] ?? 's03e01/pack/spec.pdf';
const raw = fs.readFileSync(file);
const text = raw.toString('latin1');
const count = (pattern) => (text.match(pattern) ?? []).length;

console.log(
  JSON.stringify(
    {
      bytes: raw.length,
      header: text.slice(0, 9),
      objects: count(/\d+\s+0\s+obj/g),
      flateStreams: count(/\/FlateDecode/g),
      pages: count(/\/Type\s*\/Page[^s]/g),
      baseFonts: [...new Set(text.match(/\/BaseFont\s*\/[A-Za-z0-9+#-]+/g) ?? [])].slice(0, 12),
      encodings: [...new Set(text.match(/\/Encoding\s*\/[A-Za-z0-9-]+/g) ?? [])].slice(0, 6),
      toUnicodeMaps: count(/\/ToUnicode/g),
      images: count(/\/Subtype\s*\/Image/g),
      hasObjStreams: /\/ObjStm/.test(text),
      hasXrefStream: /\/Type\s*\/XRef/.test(text),
    },
    null,
    2,
  ),
);

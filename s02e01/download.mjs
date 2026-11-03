import fs from 'node:fs';
import path from 'node:path';

async function fetchAsset(url, outputPath) {
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buf);
  console.log(`Saved ${outputPath} (${buf.length} bytes)`);
  return buf;
}

async function main() {
  const zipUrl = 'https://hq.mega.dev/media/found-out-late/starter-bb9964a5.zip';
  const sessionsUrl = 'https://hq.mega.dev/challenges/found-out-late/archive/v1.eyJzdWIiOiIxNTM2IiwiYXVkIjoiZm91bmQtb3V0LWxhdGU6YXJjaGl2ZSIsImlhdCI6MTc5MzY0NTkyOCwiZXhwIjoxNzk4ODI5OTI4fQ.t-RAd7iadM2WH2AboyTD04odVRI1YILm5bT9S0RN3aM';

  await fetchAsset(zipUrl, path.join('s02e01', 'starter.zip'));
  const sessionsBuf = await fetchAsset(sessionsUrl, path.join('s02e01', 'sessions-archive.json'));
  console.log('Sessions response:', sessionsBuf.toString('utf-8').slice(0, 500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


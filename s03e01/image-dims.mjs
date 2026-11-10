// s03e01 image-dims: prints the real pixel size of each image, so citation regions are computed
// against the file rather than against however a viewer scaled it.
//
// Usage: node s03e01/image-dims.mjs <image> [image...]

import fs from 'node:fs';
import path from 'node:path';

function dimensions(buffer) {
  if (buffer.subarray(1, 4).toString('latin1') === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrame) {
        return { format: 'jpeg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return { format: 'unknown' };
}

for (const file of process.argv.slice(2)) {
  const buffer = fs.readFileSync(file);
  console.log(JSON.stringify({ file: path.basename(file), ...dimensions(buffer) }));
}

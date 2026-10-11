/**
 * Draws media/icon.png with no image dependencies: three quota bars on a dark
 * rounded square, which is what the status bar item shows in miniature.
 *
 * Run with `npm run icon` after changing anything here.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'media', 'icon.png');

const BACKGROUND = [29, 31, 43, 255];
const TRACK = [55, 59, 79, 255];
const BARS = [
  { color: [110, 231, 183, 255], fill: 0.78 },
  { color: [251, 191, 36, 255], fill: 0.46 },
  { color: [96, 165, 250, 255], fill: 0.2 },
];

const pixels = Buffer.alloc(SIZE * SIZE * 4);

const put = (x, y, [r, g, b, a]) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const offset = (y * SIZE + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
};

const insideRounded = (x, y, left, top, right, bottom, radius) => {
  if (x < left || x > right || y < top || y > bottom) return false;
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius + radius;
};

// Background plate.
const plateRadius = Math.round(SIZE * 0.22);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    if (insideRounded(x, y, 0, 0, SIZE - 1, SIZE - 1, plateRadius)) put(x, y, BACKGROUND);
  }
}

// Three bars, each a dim track with a brighter filled portion.
const marginX = Math.round(SIZE * 0.16);
const barHeight = Math.round(SIZE * 0.13);
const gap = Math.round(SIZE * 0.085);
const totalHeight = BARS.length * barHeight + (BARS.length - 1) * gap;
let top = Math.round((SIZE - totalHeight) / 2);
const barRadius = Math.round(barHeight / 2);

for (const bar of BARS) {
  const left = marginX;
  const right = SIZE - marginX;
  const bottom = top + barHeight;
  const fillRight = left + Math.round((right - left) * bar.fill);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (!insideRounded(x, y, left, top, right, bottom, barRadius)) continue;
      put(x, y, x <= fillRight ? bar.color : TRACK);
    }
  }
  top = bottom + gap;
}

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, encodePng(pixels, SIZE, SIZE));
console.log(`wrote ${target} (${SIZE}x${SIZE})`);

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

// `var` so the lazy table is reachable from calls made earlier in the module.
var crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}


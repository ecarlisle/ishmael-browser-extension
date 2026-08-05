// Generates the extension icons as solid PNGs with no external dependencies.
//
// Icons are a rounded-square calm-teal tile with four white audio "bars",
// drawn with deterministic pixel math so the output is reproducible.
// Run with: pnpm icons
//
// This script only needs to be re-run if the icon design changes; the
// generated files under public/icons are committed.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'icons');

// --- Minimal PNG encoder (RGBA, 8-bit, non-interlaced) ---------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // IDAT: each scanline prefixed with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Icon drawing -----------------------------------------------------------

const BG = [15, 118, 110]; // calm teal (#0f766e)
const FG = [255, 255, 255]; // white bars

function roundedRectContains(x, y, size, radius) {
  const min = radius;
  const max = size - radius;
  if (x < min || x > max || y < min || y > max) {
    const cx = x < min ? min : x > max ? max : x;
    const cy = y < min ? min : y > max ? max : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }
  return true;
}

// Four vertical audio bars; returns [x, y, width, height] rects in pixels.
function barsFor(size) {
  const count = 4;
  const barWidth = Math.max(1, Math.round(size * 0.13));
  const gap = Math.max(1, Math.round(size * 0.09));
  const heights = [0.5, 0.85, 0.62, 0.38];
  const totalWidth = count * barWidth + (count - 1) * gap;
  const x0 = Math.round((size - totalWidth) / 2);
  const baseline = Math.round(size * 0.62);
  return heights.map((h, i) => {
    const x = x0 + i * (barWidth + gap);
    const barHeight = Math.max(1, Math.round(size * h));
    return { x, y: baseline - barHeight, width: barWidth, height: barHeight };
  });
}

function drawIcon(size) {
  const radius = size * 0.24;
  const bars = barsFor(size);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      let color = null;
      if (roundedRectContains(x + 0.5, y + 0.5, size, radius)) {
        color = BG;
        for (const bar of bars) {
          if (x >= bar.x && x < bar.x + bar.width && y >= bar.y && y < bar.y + bar.height) {
            color = FG;
            break;
          }
        }
      }
      if (color) {
        rgba[offset] = color[0];
        rgba[offset + 1] = color[1];
        rgba[offset + 2] = color[2];
        rgba[offset + 3] = 255;
      } else {
        rgba[offset + 3] = 0;
      }
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}

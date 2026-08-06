// Generates the extension icons from the committed design master PNG.
//
// The editable source is design/ishmael-icon.svg (an original white-whale
// mark). design/ishmael-icon-master.png is its 512px rasterization, committed
// so this step stays dependency-free and deterministic: the script only
// decodes the master, area-averages it down to each required size, and
// encodes optimized PNGs (zlib level 9). Downsampling with a box filter is
// the intentional simplification for small sizes — the artwork has no thin
// details to blur away.
//
// Run with: pnpm icons
//
// This script only needs to be re-run if the icon design changes; the
// generated files under public/icons are committed.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png-encode.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(ROOT, 'design', 'ishmael-icon-master.png');
const OUT_DIR = join(ROOT, 'public', 'icons');
const SIZES = [16, 32, 48, 128];

// --- PNG decoder (8-bit RGBA, non-interlaced) ------------------------------

function decodePng(path) {
  const buf = readFileSync(path);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`master PNG must be 8-bit RGBA (got depth ${bitDepth}, type ${colorType})`);
  }
  if (width !== height) throw new Error(`master PNG must be square (got ${width}x${height})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = line[i];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[i] = v;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, rgba: out };
}

// --- Area-average downsampling (box filter) --------------------------------

/**
 * Downsamples an RGBA buffer from `src` to `dst` (both square) with a box
 * filter. Colors are accumulated premultiplied so translucent edges keep
 * correct colors, then unpremultiplied per output pixel.
 */
function downsample(rgba, src, dst) {
  const out = Buffer.alloc(dst * dst * 4);
  const scale = src / dst;
  for (let oy = 0; oy < dst; oy++) {
    const yStart = oy * scale;
    const yEnd = (oy + 1) * scale;
    const y0 = Math.floor(yStart);
    const y1 = Math.min(src - 1, Math.ceil(yEnd) - 1);
    for (let ox = 0; ox < dst; ox++) {
      const xStart = ox * scale;
      const xEnd = (ox + 1) * scale;
      const x0 = Math.floor(xStart);
      const x1 = Math.min(src - 1, Math.ceil(xEnd) - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let w = 0;
      for (let y = y0; y <= y1; y++) {
        const wy = Math.min(y + 1, yEnd) - Math.max(y, yStart);
        for (let x = x0; x <= x1; x++) {
          const wx = Math.min(x + 1, xEnd) - Math.max(x, xStart);
          const weight = wx * wy;
          const o = (y * src + x) * 4;
          const alpha = rgba[o + 3];
          r += rgba[o] * alpha * weight;
          g += rgba[o + 1] * alpha * weight;
          b += rgba[o + 2] * alpha * weight;
          a += alpha * weight;
          w += weight;
        }
      }
      const oo = (oy * dst + ox) * 4;
      if (a > 0) {
        out[oo] = Math.round(r / a);
        out[oo + 1] = Math.round(g / a);
        out[oo + 2] = Math.round(b / a);
        out[oo + 3] = Math.round(a / w);
      } else {
        out[oo + 3] = 0;
      }
    }
  }
  return out;
}

// --- Generation ------------------------------------------------------------

const { width: masterSize, rgba } = decodePng(MASTER);
mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(size, downsample(rgba, masterSize, size)));
  console.log(`wrote ${file}`);
}

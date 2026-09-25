#!/usr/bin/env node
/**
 * Generate the PWA app icons with zero native dependencies (Node + zlib only).
 *
 *   node tools/gen-icons.mjs
 *
 * Writes public/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon,favicon-32}.png
 * The mark is a stylised white "π" on the webui accent colour; maskable and
 * apple-touch icons are full-bleed, the rest are a rounded square.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'icons');

const BG = [76, 154, 255, 255];   // --accent (#4c9aff)
const FG = [255, 255, 255, 255];

/* ---- minimal PNG (RGBA, 8-bit) encoder ---- */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- drawing ---- */

/** Point-in-rounded-rect (x,y in [0,1]); radius 0 => full square. */
function inShape(x, y, r) {
  if (r <= 0) return true;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Stylised "π" made of three bars. */
function inGlyph(x, y) {
  const bar = (x0, x1, y0, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  return bar(0.28, 0.72, 0.30, 0.40)   // top bar
      || bar(0.35, 0.44, 0.30, 0.72)   // left leg
      || bar(0.56, 0.65, 0.30, 0.72);  // right leg
}

function render(size, radius) {
  const SS = 4; // supersampling for smooth edges
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let c;
          if (inShape(x, y, radius) && inGlyph(x, y)) c = FG;
          else if (inShape(x, y, radius)) c = BG;
          else c = [0, 0, 0, 0];
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
      out[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, out);
}

fs.mkdirSync(OUT, { recursive: true });
const jobs = [
  ['icon-192.png', 192, 0.22],
  ['icon-512.png', 512, 0.22],
  ['icon-maskable-512.png', 512, 0],
  ['apple-touch-icon.png', 180, 0],
  ['favicon-32.png', 32, 0.22],
];
for (const [name, size, radius] of jobs) {
  fs.writeFileSync(path.join(OUT, name), render(size, radius));
  console.log('wrote', path.join('public/icons', name));
}

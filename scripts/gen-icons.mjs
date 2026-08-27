/**
 * Generate every app icon from one drawing.
 *
 * The launcher exe and the browser tab share a single design so the terminal
 * looks like one product wherever it shows up: an amber candlestick chart on
 * the terminal's near-black background.
 *
 *   node scripts/gen-icons.mjs
 *
 * Outputs:
 *   tools/launcher/app.ico   16/32/48/256 - exe + tray icon
 *   app/favicon.ico          16/32/48     - browser tab (Next App Router picks
 *                                           this up automatically)
 *   app/icon.png             512          - high-dpi / PWA
 *   app/apple-icon.png       180          - iOS home screen
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const BG = [10, 10, 10]; // terminal black
const FG = [255, 153, 0]; // bloomberg amber

/** Candles on a 32x32 design grid: [x, width, low, high, wickLow, wickHigh]. */
const CANDLES = [
  [6, 4, 6, 16, 3, 19],
  [13, 4, 10, 26, 7, 29],
  [20, 4, 4, 20, 1, 23],
  [26, 4, 8, 14, 5, 17],
];
const GRID = 32;
const CORNER = 4 / GRID; // corner radius as a fraction of the icon

/**
 * Render the icon at `size` px. Returns RGBA rows, top row first.
 * Drawn at 4x and box-filtered down so the small sizes stay legible.
 */
function render(size) {
  const SS = 4;
  const n = size * SS;
  const s = n / GRID; // design units -> supersampled px
  const hi = new Uint8Array(n * n * 4);

  const r = CORNER * n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = Math.min(x, n - 1 - x);
      const cy = Math.min(y, n - 1 - y);
      // Rounded corners: outside the corner arc stays transparent.
      if (cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r) continue;
      const i = (y * n + x) * 4;
      hi[i] = BG[0];
      hi[i + 1] = BG[1];
      hi[i + 2] = BG[2];
      hi[i + 3] = 255;
    }
  }

  const fill = (x0, x1, y0, y1) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(n, Math.round(y1)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(n, Math.round(x1)); x++) {
        const i = (y * n + x) * 4;
        if (hi[i + 3] === 0) continue; // never paint outside the rounded corner
        hi[i] = FG[0];
        hi[i + 1] = FG[1];
        hi[i + 2] = FG[2];
      }
    }
  };

  for (const [bx, bw, lo, high, wlo, whi] of CANDLES) {
    // y is measured from the bottom in the design grid, so flip it.
    fill(bx * s, (bx + bw) * s, (GRID - high) * s, (GRID - lo) * s);
    const wickW = Math.max(1, Math.round(s));
    const wickX = (bx + bw / 2) * s - wickW / 2;
    fill(wickX, wickX + wickW, (GRID - whi) * s, (GRID - wlo) * s);
  }

  // Box filter SSxSS -> 1px.
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r2 = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const i = ((y * SS + dy) * n + (x * SS + dx)) * 4;
          const al = hi[i + 3];
          r2 += hi[i] * al;
          g += hi[i + 1] * al;
          b += hi[i + 2] * al;
          a += al;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r2 / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / (SS * SS));
    }
  }
  return out;
}

/* ── PNG ──────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Filter byte 0 per scanline - the images are tiny, filtering buys nothing.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ── ICO ──────────────────────────────────────────────────────────────── */

/** One BMP (DIB) entry: bottom-up BGRA + an (unused, all-zero) AND mask. */
function dib(size, rgba) {
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8); // height counts image + mask
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = ((size - 1 - y) * size + x) * 4; // flip vertically
      const o = (y * size + x) * 4;
      px[o] = rgba[i + 2];
      px[o + 1] = rgba[i + 1];
      px[o + 2] = rgba[i];
      px[o + 3] = rgba[i + 3];
    }
  }
  // AND mask: 1 bit per pixel, each row padded to a 4-byte boundary. Decoders that
  // check the DIB length (Next's image pipeline does) reject an unpadded mask.
  const maskStride = Math.ceil(size / 8 / 4) * 4;
  const mask = Buffer.alloc(maskStride * size);
  hdr.writeUInt32LE(px.length + mask.length, 20);
  return Buffer.concat([hdr, px, mask]);
}

function ico(sizes) {
  const images = sizes.map((s) => (s >= 256 ? png(s, render(s)) : dib(s, render(s))));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);

  let offset = 6 + sizes.length * 16;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; // 0 means 256
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return e;
  });

  return Buffer.concat([dir, ...entries, ...images]);
}

/* ── write ────────────────────────────────────────────────────────────── */

const targets = [
  ["tools/launcher/app.ico", ico([16, 32, 48, 256])],
  ["app/favicon.ico", ico([16, 32, 48])],
  ["app/icon.png", png(512, render(512))],
  ["app/apple-icon.png", png(180, render(180))],
];

for (const [rel, buf] of targets) {
  const path = join(ROOT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  console.log(`wrote ${rel} (${buf.length.toLocaleString()} bytes)`);
}

console.log("\nRebuild the launcher to pick up the new exe icon: tools\\launcher\\build.bat");

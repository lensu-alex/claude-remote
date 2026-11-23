// Draws the app icon (a terminal prompt mark) and writes the PNG sizes the site needs.
// Run with `npm run icons`. No dependencies: the PNG is encoded by hand.
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const BACKGROUND = [0x2a, 0x1a, 0x0f];
const MARK = [0xf6, 0xea, 0xd9];
const ACCENT = [0xd2, 0xa1, 0x71];

// Shapes in a 0..1 square: a ">" chevron and a short cursor bar.
const STROKES = [
  { from: [0.3, 0.33], to: [0.49, 0.5], color: MARK },
  { from: [0.49, 0.5], to: [0.3, 0.67], color: MARK },
  { from: [0.57, 0.67], to: [0.72, 0.67], color: ACCENT },
];
const HALF_WIDTH = 0.046;

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const row = size * 3 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      let color = BACKGROUND;
      for (const stroke of STROKES) {
        const edge = (distanceToSegment(px, py, stroke.from, stroke.to) - HALF_WIDTH) * size;
        const coverage = Math.max(0, Math.min(1, 0.5 - edge));
        if (coverage > 0) color = color.map((c, i) => Math.round(c + (stroke.color[i] - c) * coverage));
      }
      raw.set(color, y * row + 1 + x * 3);
    }
  }
  return raw;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, check]);
}

function png(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(render(size), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outputs = [
  ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512],
  ["app/apple-icon.png", 180],
  ["app/icon.png", 96],
];

for (const [path, size] of outputs) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(size));
  console.log(`${path} (${size}px)`);
}

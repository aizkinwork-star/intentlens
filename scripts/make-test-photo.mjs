// scripts/make-test-photo.mjs — generate a deterministic test photo for the
// upload -> capture smoke test. No dependencies: raw RGB scanlines + zlib.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1280;
const H = 720;

const px = Buffer.alloc(W * H * 3);
function set(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
}
function rect(x0, y0, x1, y1, r, g, b) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x += 1) set(x, y, r, g, b);
  }
}
function circle(cx, cy, rad, r, g, b) {
  for (let y = cy - rad; y <= cy + rad; y += 1) {
    for (let x = cx - rad; x <= cx + rad; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) set(x, y, r, g, b);
    }
  }
}
function line(x0, y0, x1, y1, r, g, b, width = 5) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let s = 0; s <= steps; s += 1) {
    const x = Math.round(x0 + ((x1 - x0) * s) / steps);
    const y = Math.round(y0 + ((y1 - y0) * s) / steps);
    circle(x, y, Math.floor(width / 2), r, g, b);
  }
}

// Desk (dark), breadboard (light), Arduino-ish board (teal), parts.
rect(0, 0, W, H, 34, 36, 40);
rect(120, 150, 900, 620, 224, 224, 218);          // breadboard body
for (let x = 150; x < 890; x += 16) {
  for (let y = 175; y < 600; y += 16) set(x, y, 150, 150, 146); // hole grid
}
rect(950, 100, 1230, 330, 20, 92, 108);            // Arduino board
rect(960, 110, 1220, 320, 18, 120, 132);
rect(1050, 340, 1210, 400, 30, 30, 34);            // USB-ish block
const led = { x: 300, y: 300 };
circle(led.x, led.y, 26, 220, 45, 45);             // red LED dome
circle(led.x - 8, led.y - 8, 8, 255, 160, 160);    // specular
line(led.x - 9, led.y + 26, led.x - 9, led.y + 90, 190, 190, 190, 6); // legs
line(led.x + 9, led.y + 26, led.x + 9, led.y + 100, 190, 190, 190, 6);
rect(430, 330, 610, 366, 214, 190, 140);           // resistor body
rect(455, 330, 470, 366, 120, 60, 30);             // bands
rect(490, 330, 500, 366, 20, 20, 20);
rect(520, 330, 535, 366, 240, 200, 40);
line(410, 348, 430, 348, 190, 190, 190, 5);
line(610, 348, 640, 348, 190, 190, 190, 5);
line(300, 400, 700, 520, 230, 60, 60, 6);          // jumper wires
line(320, 430, 760, 200, 60, 220, 90, 6);
line(360, 460, 820, 460, 60, 140, 230, 6);
rect(1010, 150, 1150, 240, 12, 12, 14);            // MCU chip
for (let i = 0; i < 12; i += 1) {
  line(1010 + i * 12, 140, 1010 + i * 12, 150, 200, 200, 200, 2);
  line(1010 + i * 12, 240, 1010 + i * 12, 250, 200, 200, 200, 2);
}

// PNG chunks.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // colour type: truecolour
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y += 1) {
  raw[y * (1 + W * 3)] = 0; // filter: none
  px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = process.argv[2] || join(process.env.TEMP, 'il-test-photo.png');
writeFileSync(out, png);
console.log(`wrote ${out} (${W}x${H}, ${png.length} bytes)`);

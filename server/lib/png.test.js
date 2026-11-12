import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePngMask, isPng, parsePngHeader } from './png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // This decoder does not validate CRC.
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, crc]);
}

function encodePng({ width, height, colorType = 0, bitDepth = 8, interlace = 0, raw }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function rowsToRaw(rows) {
  return Buffer.concat(rows.map((row) => Buffer.from([0, ...row])));
}

test('a PNG header is read without decoding pixels', () => {
  const png = encodePng({
    width: 4,
    height: 3,
    raw: rowsToRaw([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]),
  });
  assert.equal(isPng(png), true);
  const header = parsePngHeader(png);
  assert.equal(header.width, 4);
  assert.equal(header.height, 3);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colorType, 0);
  assert.equal(header.interlaced, false);
});

test('an 8-bit grayscale mask reports area, bbox and centroid', () => {
  const rows = [
    [0, 0, 0, 0],
    [0, 255, 255, 0],
    [0, 255, 255, 0],
    [0, 0, 0, 0],
  ];
  const stats = decodePngMask(encodePng({ width: 4, height: 4, raw: rowsToRaw(rows) }));
  assert.equal(stats.decoded, true);
  assert.equal(stats.areaPixels, 4);
  assert.deepEqual(stats.bbox, { x: 1, y: 1, width: 2, height: 2 });
  assert.deepEqual(stats.centroid, { x: 1.5, y: 1.5 });
  assert.equal(stats.coverage, 0.25);
});

test('an RGBA mask uses alpha, even when RGB is black', () => {
  const row = [];
  for (let x = 0; x < 3; x += 1) row.push(0, 0, 0, x === 1 ? 255 : 0);
  const stats = decodePngMask(encodePng({ width: 3, height: 1, colorType: 6, raw: rowsToRaw([row]) }));
  assert.equal(stats.decoded, true);
  assert.equal(stats.areaPixels, 1);
  assert.deepEqual(stats.bbox, { x: 1, y: 0, width: 1, height: 1 });
});

test('Sub filtering is undone before pixels are counted', () => {
  // Filter 1 (Sub): each byte is the difference from the pixel to its left.
  const raw = Buffer.from([1, 200, 10, 10]);
  const stats = decodePngMask(encodePng({ width: 3, height: 1, raw }));
  assert.equal(stats.decoded, true);
  assert.equal(stats.areaPixels, 3);
});

test('an empty mask is reported as zero area, not a fabricated box', () => {
  const stats = decodePngMask(encodePng({
    width: 2,
    height: 2,
    raw: rowsToRaw([Buffer.alloc(2), Buffer.alloc(2)]),
  }));
  assert.equal(stats.decoded, true);
  assert.equal(stats.areaPixels, 0);
  assert.equal(stats.bbox, null);
  assert.equal(stats.centroid, null);
});

test('unsupported PNG variants are refused instead of guessed at', () => {
  const png = encodePng({
    width: 2,
    height: 2,
    bitDepth: 16,
    raw: rowsToRaw([Buffer.alloc(4), Buffer.alloc(4)]),
  });
  const stats = decodePngMask(png);
  assert.equal(stats.decoded, false);
  assert.equal(stats.reason, 'unsupported_png_format');
  assert.equal(stats.width, 2);
});

test('a PNG that would decompress into an enormous buffer is refused', () => {
  const png = encodePng({
    width: 20_000,
    height: 20_000,
    raw: Buffer.alloc(0),
  });
  const stats = decodePngMask(png);
  assert.equal(stats.decoded, false);
  assert.equal(stats.reason, 'image_too_large');
});

test('non-PNG bytes never parse', () => {
  assert.equal(isPng(Buffer.from('not a png')), false);
  assert.equal(parsePngHeader(Buffer.from('not a png')), null);
  assert.equal(decodePngMask(Buffer.from('not a png')), null);
});

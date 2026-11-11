// cli.test.js — header-only image size parsing used by the headless CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from './cli/intentlens.mjs';

test('PNG dimensions are read from the IHDR header', () => {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(buffer, 'image/png'), { width: 640, height: 480 });
});

test('GIF dimensions are read from the logical screen descriptor', () => {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(320, 6);
  buffer.writeUInt16LE(240, 8);
  assert.deepEqual(imageSize(buffer, 'image/gif'), { width: 320, height: 240 });
});

test('JPEG dimensions are found at the first SOF marker', () => {
  const buffer = Buffer.alloc(20);
  buffer[0] = 0xff; buffer[1] = 0xd8;      // SOI
  buffer[2] = 0xff; buffer[3] = 0xc0;      // SOF0
  buffer.writeUInt16BE(17, 4);             // segment length
  buffer[6] = 8;                           // precision
  buffer.writeUInt16BE(720, 7);            // height
  buffer.writeUInt16BE(1280, 9);           // width
  assert.deepEqual(imageSize(buffer, 'image/jpeg'), { width: 1280, height: 720 });
});

test('unsupported or truncated headers return null instead of a guess', () => {
  assert.equal(imageSize(Buffer.alloc(0), 'image/png'), null);
  assert.equal(imageSize(Buffer.alloc(12), 'image/webp'), null);
  assert.equal(imageSize(null, 'image/jpeg'), null);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(imageSize(jpeg, 'image/jpeg'), null);
});

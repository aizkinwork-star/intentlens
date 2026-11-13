// server/lib/png.js — minimal, dependency-free PNG inspection for SAM masks.
//
// Replicate's SAM 2 model returns masks as PNG URLs. The server needs only three
// facts about each mask: its dimensions, its foreground area and its bounding
// box. Those are used to rank masks against a user's box/point prompt and to
// report mask quality. We deliberately do not re-encode or resample images.
//
// Scope: 8-bit, non-interlaced PNG in grayscale, RGB, grayscale+alpha or RGBA.
// Anything else is reported as metadata-only (`decoded: false`) instead of being
// guessed at. A SAM mask outside that scope is unusual, and refusing to decode
// it is safer than producing a wrong bounding box.

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DIMENSION = 20_000;
const MAX_RAW_BYTES = 64 * 1024 * 1024;

export function isPng(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= SIGNATURE.length
    && buffer.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

function readChunks(buffer) {
  const chunks = [];
  let offset = SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > 0x7fffffff || dataEnd + 4 > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4; // skip CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

export function parsePngHeader(buffer) {
  if (!isPng(buffer) || buffer.length < 33) return null;
  const length = buffer.readUInt32BE(8);
  if (length !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return {
    width,
    height,
    bitDepth: buffer[24],
    colorType: buffer[25],
    compression: buffer[26],
    filter: buffer[27],
    interlaced: buffer[28] === 1,
    bytes: buffer.length,
  };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decode an 8-bit PNG and describe its foreground. `foreground` is pixels whose
 * luma is above `lumaThreshold`; for images with an alpha channel the pixel must
 * also be non-transparent.
 *
 * Returns null for a non-PNG. Returns `{ decoded: false, ...header }` for a PNG
 * outside the supported subset.
 */
export function decodePngMask(buffer, { lumaThreshold = 127, alphaThreshold = 0 } = {}) {
  const header = parsePngHeader(buffer);
  if (!header) return null;
  if (header.bitDepth !== 8 || header.interlaced || header.compression !== 0 || header.filter !== 0) {
    return { ...header, decoded: false, reason: 'unsupported_png_format' };
  }
  const channels = CHANNELS[header.colorType];
  if (!channels) return { ...header, decoded: false, reason: 'unsupported_color_type' };

  const chunks = readChunks(buffer);
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  if (!idat.length) return { ...header, decoded: false, reason: 'missing_image_data' };

  let raw;
  const { width, height } = header;
  const stride = width * channels;
  const expectedRaw = height * (stride + 1);
  if (expectedRaw > MAX_RAW_BYTES) {
    return { ...header, decoded: false, reason: 'image_too_large' };
  }
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return { ...header, decoded: false, reason: 'invalid_compressed_data' };
  }

  if (raw.length < expectedRaw) {
    return { ...header, decoded: false, reason: 'truncated_image_data' };
  }

  let previous = null;
  let area = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let sumX = 0;
  let sumY = 0;
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[pos];
    pos += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value = raw[pos];
      pos += 1;
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += Math.floor((left + up) / 2);
      else if (filterType === 4) value += paeth(left, up, upLeft);
      else if (filterType !== 0) {
        return { ...header, decoded: false, reason: `unsupported_filter_${filterType}` };
      }
      row[x] = value & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const i = x * channels;
      let foreground;
      if (header.colorType === 4) {
        // Masks with an alpha channel use alpha as the mask. Luma is irrelevant.
        foreground = row[i + 1] > alphaThreshold;
      } else if (header.colorType === 6) {
        foreground = row[i + 3] > alphaThreshold;
      } else if (header.colorType === 0) {
        foreground = row[i] >= lumaThreshold;
      } else {
        foreground = (0.299 * row[i] + 0.587 * row[i + 1] + 0.114 * row[i + 2]) >= lumaThreshold;
      }
      if (!foreground) continue;
      area += 1;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    previous = row;
  }

  const bbox = area > 0
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return {
    ...header,
    decoded: true,
    areaPixels: area,
    coverage: width && height ? Number((area / (width * height)).toFixed(6)) : 0,
    bbox,
    centroid: area > 0
      ? { x: Number((sumX / area).toFixed(2)), y: Number((sumY / area).toFixed(2)) }
      : null,
  };
}

export default { isPng, parsePngHeader, decodePngMask, decodePngRgba };

/**
 * Decode an 8-bit PNG to RGBA pixels. Returns null for a non-PNG or an
 * unsupported encoding. Used by the local component recogniser, which needs
 * real pixels rather than a mask summary.
 */
export function decodePngRgba(buffer) {
  const header = parsePngHeader(buffer);
  if (!header) return null;
  if (header.bitDepth !== 8 || header.interlaced || header.compression !== 0 || header.filter !== 0) {
    return { ...header, decoded: false, reason: 'unsupported_png_format' };
  }
  const channels = CHANNELS[header.colorType];
  if (!channels) return { ...header, decoded: false, reason: 'unsupported_color_type' };
  const chunks = readChunks(buffer);
  const idat = chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data);
  if (!idat.length) return { ...header, decoded: false, reason: 'missing_image_data' };

  const { width, height } = header;
  const stride = width * channels;
  const expectedRaw = height * (stride + 1);
  if (expectedRaw > MAX_RAW_BYTES) return { ...header, decoded: false, reason: 'image_too_large' };

  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return { ...header, decoded: false, reason: 'invalid_compressed_data' };
  }
  if (raw.length < expectedRaw) return { ...header, decoded: false, reason: 'truncated_image_data' };

  const data = new Uint8ClampedArray(width * height * 4);
  let previous = null;
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[pos];
    pos += 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value = raw[pos];
      pos += 1;
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += Math.floor((left + up) / 2);
      else if (filterType === 4) value += paeth(left, up, upLeft);
      else if (filterType !== 0) return { ...header, decoded: false, reason: `unsupported_filter_${filterType}` };
      row[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      if (header.colorType === 0 || header.colorType === 4) {
        const luma = row[src];
        data[dst] = luma;
        data[dst + 1] = luma;
        data[dst + 2] = luma;
        data[dst + 3] = header.colorType === 4 ? row[src + 1] : 255;
      } else if (header.colorType === 2 || header.colorType === 6) {
        data[dst] = row[src];
        data[dst + 1] = row[src + 1];
        data[dst + 2] = row[src + 2];
        data[dst + 3] = header.colorType === 6 ? row[src + 3] : 255;
      }
    }
    previous = row;
  }
  return { ...header, decoded: true, data };
}

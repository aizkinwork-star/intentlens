#!/usr/bin/env node
// cli/intentlens.mjs — headless control for a running IntentLens server.
//
// The desktop server owns provider keys, SQLite and the cost ledger. This CLI
// talks to that same local server; it never reads provider keys itself.
//
// Usage:
//   node cli/intentlens.mjs health
//   node cli/intentlens.mjs providers
//   node cli/intentlens.mjs models --provider openrouter
//   node cli/intentlens.mjs budget get
//   node cli/intentlens.mjs budget set --daily 1 --monthly 10 --request 0.25
//   node cli/intentlens.mjs budget reset
//   node cli/intentlens.mjs analyze --image photo.jpg --command "what is this part?"
//   node cli/intentlens.mjs sync
//
// Connection:
//   --server http://127.0.0.1:8000   (default)
//   --token <session token>          (or INTENTLENS_TOKEN)
//
// The session token is a local capability, not a provider API key. If it is not
// passed, the CLI reads intentlens-data/.session-token written by the server.

import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_SERVER = process.env.INTENTLENS_SERVER || 'http://127.0.0.1:8000';

function usage() {
  console.log(`IntentLens CLI

  node cli/intentlens.mjs health
  node cli/intentlens.mjs providers
  node cli/intentlens.mjs models [--provider <id>]
  node cli/intentlens.mjs budget get
  node cli/intentlens.mjs budget set [--daily N] [--monthly N] [--request N]
  node cli/intentlens.mjs budget reset
  node cli/intentlens.mjs analyze --image <file> --command "<text>" [--width N --height N]
  node cli/intentlens.mjs sync

Options: --server <url>  --token <session token>  --json`);
}

function readToken(explicit) {
  if (explicit) return explicit;
  if (process.env.INTENTLENS_TOKEN) return process.env.INTENTLENS_TOKEN;
  try {
    const file = resolve(process.env.DATA_DIR || './intentlens-data', '.session-token');
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(token)) return token;
    }
  } catch { /* no local token */ }
  return null;
}

function mimeFor(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

/** Minimal header-only size reader for PNG, GIF and JPEG. */
export function imageSize(buffer, mime) {
  if (!buffer || buffer.length < 12) return null;
  if (mime === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/gif') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

async function request(server, path, { method = 'GET', token, body, timeoutMs = 180_000 } = {}) {
  const headers = {};
  if (token) headers['x-intentlens-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(path, server), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const message = data?.error?.message || `HTTP ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      error.payload = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (typeof value === 'string') { console.log(value); return; }
  console.log(JSON.stringify(value, null, 2));
}

function money(n) {
  const value = Number(n);
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : '—';
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      server: { type: 'string' },
      token: { type: 'string' },
      image: { type: 'string' },
      command: { type: 'string' },
      provider: { type: 'string' },
      daily: { type: 'string' },
      monthly: { type: 'string' },
      request: { type: 'string' },
      width: { type: 'string' },
      height: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const [group, action] = positionals;
  if (values.help || !group) { usage(); return; }
  const server = String(values.server || DEFAULT_SERVER).replace(/\/+$/, '');
  const token = readToken(values.token);
  const json = values.json === true;

  if (group === 'health') {
    print(await request(server, '/api/health'), json);
    return;
  }
  if (group === 'providers') {
    const data = await request(server, '/api/providers', { token });
    if (json) { print(data, true); return; }
    const rows = (data.providers || []).map((p) => ({
      id: p.id,
      configured: p.configured ? 'yes' : (p.hasKey ? 'key saved (unusable)' : 'no'),
      model: p.modelId || '—',
      modality: p.modality || '—',
    }));
    console.table(rows);
    console.log(`\nFailover: ${(data.priority || []).join(' -> ') || '—'}`);
    if (data.budget) {
      console.log(`Budget: today ${money(data.budget.todayUsd)} / ${money(data.budget.budget?.dailyUsd)}, month ${money(data.budget.monthUsd)} / ${money(data.budget.budget?.monthlyUsd)}`);
    }
    return;
  }
  if (group === 'models') {
    const data = await request(server, '/api/providers', { token });
    const catalog = data.catalog || {};
    const providers = values.provider ? [String(values.provider)] : Object.keys(catalog);
    const rows = [];
    for (const provider of providers) {
      for (const [id, model] of Object.entries(catalog[provider]?.models || {})) {
        rows.push({ provider, id, modality: model.modality, tier: model.tier || 'free', verified: model.verified ? 'yes' : 'no' });
      }
    }
    if (json) { print(rows, true); return; }
    console.table(rows);
    return;
  }
  if (group === 'budget') {
    if (action === 'get' || !action) {
      const data = await request(server, '/api/budget', { token });
      if (json) { print(data, true); return; }
      console.log(`Today:   ${money(data.todayUsd)} of ${money(data.budget?.dailyUsd)} (${data.dayPercent ?? '—'}%)`);
      console.log(`Month:   ${money(data.monthUsd)} of ${money(data.budget?.monthlyUsd)} (${data.monthPercent ?? '—'}%)`);
      console.log(`Remaining: ${money(data.remainingUsd)} · per-request cap ${money(data.budget?.maxRequestUsd)} · ${data.requests || 0} request(s) this month`);
      console.log('Estimates only. Provider invoices are authoritative.');
      return;
    }
    if (action === 'set') {
      const budget = {};
      if (values.daily != null) budget.dailyUsd = Number(values.daily);
      if (values.monthly != null) budget.monthlyUsd = Number(values.monthly);
      if (values.request != null) budget.maxRequestUsd = Number(values.request);
      if (!Object.keys(budget).length) throw new Error('Pass at least one of --daily, --monthly or --request.');
      const data = await request(server, '/api/budget', { method: 'POST', token, body: { budget } });
      print(json ? data : `Budget saved: ${money(data.budget?.dailyUsd)}/day, ${money(data.budget?.monthlyUsd)}/month, ${money(data.budget?.maxRequestUsd)}/request.`, json);
      return;
    }
    if (action === 'reset') {
      const data = await request(server, '/api/budget/reset', { method: 'POST', token, body: { reset: true, entriesOnly: true } });
      print(json ? data : 'Recorded usage cleared. Budget caps are unchanged.', json);
      return;
    }
    throw new Error(`Unknown budget action "${action}". Use get, set or reset.`);
  }
  if (group === 'analyze') {
    const file = values.image ? resolve(String(values.image)) : '';
    if (!file) throw new Error('Pass --image <file>.');
    if (!existsSync(file)) throw new Error(`Image not found: ${file}`);
    const command = String(values.command || '').trim();
    if (!command) throw new Error('Pass --command "<question>".');
    const mime = mimeFor(file);
    const buffer = readFileSync(file);
    const size = imageSize(buffer, mime);
    const width = Number(values.width) || size?.width;
    const height = Number(values.height) || size?.height;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('Could not read the image size. Pass --width and --height.');
    }
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const payload = {
      requestId: `cli_${Date.now()}`,
      sessionId: 'cli',
      projectId: 'cli',
      command,
      frame: {
        frameId: `cli_${Date.now()}`,
        dataUrl,
        mimeType: mime,
        width,
        height,
        capturedAt: new Date().toISOString(),
      },
      allowWebSearch: false,
    };
    const result = await request(server, '/api/analyze', { method: 'POST', token, body: payload, timeoutMs: 240_000 });
    if (json) { print(result, true); return; }
    const target = result.target || result.result?.target || null;
    if (target) {
      console.log(`Target: ${target.name || target.componentId || 'unnamed'}`);
      if (target.cellId) console.log(`Cell:   ${target.cellId}`);
      if (target.confidence != null) console.log(`Confidence: ${target.confidence}`);
    }
    const instruction = result.instruction || result.result?.instruction || result.answer;
    if (instruction) console.log(`\n${instruction}`);
    console.log(`\nProvider: ${result.meta?.provider || '—'} · model: ${result.meta?.model || '—'} · ${result.meta?.latencyMs ?? '—'} ms`);
    return;
  }
  if (group === 'sync') {
    const data = await request(server, '/api/sync/code', { method: 'POST', token, body: {} });
    if (json) { print(data, true); return; }
    console.log(`Upload code: ${data.code}  (expires in ${data.ttlSeconds}s)`);
    for (const entry of data.urls || []) console.log(`  ${entry.label}: ${entry.url}?code=${data.code}`);
    console.log('Open the URL on a phone on the same Wi-Fi and send a gallery photo.');
    return;
  }

  usage();
  throw new Error(`Unknown command "${group}".`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) {
  main().catch((err) => {
    if (err?.status === 401) {
      console.error('Unauthorized: pass --token, set INTENTLENS_TOKEN, or run this from the folder that contains intentlens-data/.session-token.');
    } else {
      console.error(err?.message || String(err));
      if (err?.payload?.error?.code) console.error(`Code: ${err.payload.error.code}`);
    }
    process.exitCode = 1;
  });
}
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

function req(port, path, opts = {}) {
  return new Promise((resolve) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let body = '';
      res.on('data', (d) => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function startServer(port) {
  const srv = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  return srv;
}

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A fixed sleep made these tests fail whenever the SQLite store opened slowly
 * (for example while other test files ran in parallel). Poll the public health
 * endpoint instead and stop as soon as the server answers.
 */
async function waitForReady(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await req(port, '/api/health');
    if (r.status === 200) return;
    await wait(150);
  }
  throw new Error(`server on port ${port} did not become ready within ${timeoutMs}ms`);
}

async function stopServer(srv) {
  if (!srv || srv.exitCode !== null) return;
  srv.kill();
  await wait(300);
  if (srv.exitCode === null) srv.kill('SIGKILL');
  await wait(200);
}

async function withServer(port, fn) {
  const srv = startServer(port);
  try {
    await waitForReady(port);
    return await fn();
  } finally {
    await stopServer(srv);
  }
}

test('auth: missing token returns 401', async () => {
  await withServer(8201, async () => {
    const r = await req(8201, '/api/objects?projectId=x');
    assert.equal(r.status, 401);
  });
});

test('auth: health endpoint is public', async () => {
  await withServer(8202, async () => {
    const r = await req(8202, '/api/health');
    assert.equal(r.status, 200);
  });
});

test('auth: invalid token returns 401', async () => {
  await withServer(8203, async () => {
    const r = await req(8203, '/api/objects?projectId=x', { headers: { 'x-intentlens-token': 'badtoken' } });
    assert.equal(r.status, 401);
  });
});

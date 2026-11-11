// pwa/camera.test.js — pure camera constraint and capability helpers.
//
// A mocked mediaDevices object proves that the fallback ladder behaves, not that
// a physical phone camera works. Hardware still has to be tested on hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCameraConstraintLadder,
  cameraCapabilities,
  openCameraWithFallback,
  setTorch,
  setZoom,
} from './camera.js';

function errorWithName(name) {
  const error = new Error(name);
  error.name = name;
  return error;
}

test('constraint ladder starts with the selected camera and always ends unconstrained', () => {
  const ladder = buildCameraConstraintLadder({ deviceId: 'cam-2' });
  assert.equal(ladder.length, 7);
  assert.deepEqual(ladder[0].video.deviceId, { exact: 'cam-2' });
  assert.equal(ladder[0].video.width.ideal, 1920);
  assert.equal(ladder[0].audio, false);
  assert.equal(ladder[3].video.facingMode.ideal, 'environment');
  assert.equal(ladder[ladder.length - 1].video, true);
  for (const step of ladder) {
    assert.equal(step.audio, false);
    assert.ok(step.reason.length > 0);
  }
});

test('without a chosen camera the ladder never sends an empty exact deviceId', () => {
  const ladder = buildCameraConstraintLadder();
  assert.equal(ladder.length, 4);
  assert.ok(ladder.every((step) => JSON.stringify(step.video).includes('deviceId') === false));
  assert.equal(ladder[0].video.facingMode.ideal, 'environment');
  assert.equal(ladder[ladder.length - 1].video, true);
});

test('fallback retries only constraint failures and reports what worked', async () => {
  const calls = [];
  const stream = { id: 'stream' };
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls.push(constraints);
      if (calls.length <= 2) throw errorWithName('OverconstrainedError');
      return stream;
    },
  };
  const ladder = buildCameraConstraintLadder({ deviceId: 'cam-1' });
  const result = await openCameraWithFallback(mediaDevices, ladder);
  assert.equal(result.stream, stream);
  assert.equal(result.step, ladder[2]);
  assert.equal(calls.length, 3);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].name, 'OverconstrainedError');
});

test('permission denial is not retried against every constraint', async () => {
  let calls = 0;
  const mediaDevices = {
    async getUserMedia() {
      calls += 1;
      throw errorWithName('NotAllowedError');
    },
  };
  await assert.rejects(
    () => openCameraWithFallback(mediaDevices, buildCameraConstraintLadder()),
    (error) => error.name === 'NotAllowedError',
  );
  assert.equal(calls, 1);
});

test('all-constraint failure carries the attempt trail', async () => {
  const mediaDevices = {
    async getUserMedia() { throw errorWithName('NotFoundError'); },
  };
  await assert.rejects(
    () => openCameraWithFallback(mediaDevices, buildCameraConstraintLadder()),
    (error) => {
      assert.equal(error.name, 'NotFoundError');
      assert.equal(error.attempts.length, 4);
      return true;
    },
  );
});

test('a browser without getUserMedia is refused before any call', async () => {
  await assert.rejects(
    () => openCameraWithFallback({}, buildCameraConstraintLadder()),
    /does not expose getUserMedia/,
  );
});

test('capabilities report torch and a usable zoom range', () => {
  const track = {
    getCapabilities: () => ({
      torch: true,
      zoom: { min: 1, max: 5, step: 0.5 },
      focusMode: ['manual', 'continuous'],
    }),
    getSettings: () => ({ width: 1920, height: 1080, frameRate: 30, zoom: 2, facingMode: 'environment' }),
  };
  const caps = cameraCapabilities(track);
  assert.equal(caps.torch, true);
  assert.equal(caps.continuousFocus, true);
  assert.deepEqual(caps.zoom, { min: 1, max: 5, step: 0.5, current: 2 });
  assert.deepEqual(caps.settings, { width: 1920, height: 1080, frameRate: 30, facingMode: 'environment' });
});

test('a camera without capability APIs reports unsupported instead of guessing', () => {
  const caps = cameraCapabilities({});
  assert.equal(caps.torch, false);
  assert.equal(caps.zoom, null);
  assert.equal(caps.continuousFocus, false);
  assert.deepEqual(caps.settings, { width: null, height: null, frameRate: null, facingMode: null });

  assert.equal(cameraCapabilities(null).torch, false);
});

test('torch applies an advanced constraint and reports failure without throwing', async () => {
  const calls = [];
  const track = { async applyConstraints(value) { calls.push(value); } };
  const on = await setTorch(track, true);
  assert.deepEqual(on, { applied: true, enabled: true });
  assert.deepEqual(calls[0], { advanced: [{ torch: true }] });

  const failing = { async applyConstraints() { throw new Error('nope'); } };
  const off = await setTorch(failing, false);
  assert.equal(off.applied, false);
  assert.equal(off.error, 'nope');
  assert.equal((await setTorch(null, true)).applied, false);
});

test('zoom is clamped to the hardware range and reported from the device', async () => {
  let applied = null;
  const track = {
    getCapabilities: () => ({ zoom: { min: 1, max: 4, step: 1 } }),
    getSettings: () => ({ zoom: applied ?? 1 }),
    async applyConstraints(value) {
      applied = value.advanced[0].zoom;
    },
  };
  const high = await setZoom(track, 99);
  assert.equal(high.applied, true);
  assert.equal(high.zoom, 4);

  const low = await setZoom(track, -3);
  assert.equal(low.zoom, 1);

  const missing = await setZoom({ getCapabilities: () => ({}) }, 2);
  assert.equal(missing.applied, false);
  assert.match(missing.error, /not supported/);

  const notANumber = await setZoom(track, 'wide');
  assert.equal(notANumber.applied, false);
});

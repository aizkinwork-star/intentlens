import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IDENTITY_STATES, canTransition, createObservation, setClassification,
  confirmIdentity, markLost, buildSharedContext, createClassificationCache,
  buildExportSample,
} from './observationContext.js';

test('identity states include required', () => {
  for (const s of ['DETECTED','CANDIDATE','UNCONFIRMED','USER_CONFIRMED','VERIFIED','LOST']) {
    assert.ok(IDENTITY_STATES[s]);
  }
});

test('transition rules', () => {
  assert.ok(canTransition('DETECTED','CANDIDATE'));
  assert.ok(!canTransition('DETECTED','USER_CONFIRMED'));
  assert.ok(canTransition('CANDIDATE','USER_CONFIRMED'));
});

test('observation without identity', () => {
  const o = createObservation({ trackId: 't1', bbox: [0,0,10,10], gridCell: 'R1C1' });
  assert.equal(o.state, IDENTITY_STATES.DETECTED);
  assert.equal(o.classification, null);
});

test('candidate prediction sets state', () => {
  const o = createObservation({ trackId: 't2' });
  setClassification(o, [{label:'Resistor',score:0.5,distance:10}], 'hash1');
  assert.equal(o.state, IDENTITY_STATES.CANDIDATE);
  // second classification -> unconfirmed
  setClassification(o, [{label:'Resistor',score:0.5,distance:10}], 'hash1');
  assert.equal(o.state, IDENTITY_STATES.UNCONFIRMED);
});

test('user confirmation', () => {
  const o = createObservation({ trackId: 't3' });
  setClassification(o, [{label:'Resistor',score:0.5,distance:10}], 'h');
  confirmIdentity(o, 'Capacitor', 'note');
  assert.equal(o.state, IDENTITY_STATES.USER_CONFIRMED);
  assert.equal(o.userCorrection.label, 'Capacitor');
});

test('mark lost', () => {
  const o = createObservation({ trackId: 't4' });
  markLost(o);
  assert.equal(o.state, IDENTITY_STATES.LOST);
});

test('shared context hash deterministic', () => {
  const o = createObservation({ trackId: 't5', gridCell: 'R2C2' });
  const c1 = buildSharedContext({ sessionId: 's', observations: [o] });
  const c2 = buildSharedContext({ sessionId: 's', observations: [o] });
  assert.equal(c1.contextHash, c2.contextHash);
  assert.ok(Array.isArray(c1.observedFacts));
  assert.ok(Array.isArray(c1.predictions));
  assert.ok(Array.isArray(c1.confirmedInformation));
});

test('context distinguishes prediction vs confirmed', () => {
  const o = createObservation({ trackId: 't6' });
  setClassification(o, [{label:'Resistor',score:0.5,distance:10}], 'h');
  confirmIdentity(o, 'Capacitor');
  const c = buildSharedContext({ sessionId: 's', observations: [o] });
  assert.equal(c.predictions[0].uncertainty, 'model_prediction');
  assert.equal(c.confirmedInformation[0].userConfirmed, 'Capacitor');
});

test('classification cache', () => {
  const cache = createClassificationCache();
  assert.equal(cache.get('t','h'), null);
  cache.set('t','h',{label:'X'});
  assert.equal(cache.get('t','h').label, 'X');
  cache.invalidate('t');
  assert.equal(cache.get('t','h'), null);
});

test('export sample metadata', () => {
  const o = createObservation({ trackId: 't7', gridCell: 'R1C1', cropHash: 'abc' });
  const s = buildExportSample({ observation: o, session: 'sess', imageQuality: {w:10,h:10} });
  assert.equal(s.trackId, 't7');
  assert.equal(s.cropHash, 'abc');
  assert.equal(s.sessionId, 'sess');
});

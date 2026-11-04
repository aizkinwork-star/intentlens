import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectFromIntent,
  detectComponents,
  detectAvailableMaterials,
  advanceProjectStep,
  currentStepOf,
  serializeProject,
  deserializeProject,
  addObjectToProject,
  confirmProjectObject,
  projectContextForAI,
} from './projectPlanner.js';

test('creates a structured beginner project from one natural-language request', () => {
  const project = createProjectFromIntent(
    'I want to build a blinking LED with an Arduino Uno. I have an Arduino Uno, a breadboard, two LEDs and resistors.',
  );
  assert.match(project.projectId, /^proj_/);
  assert.equal(project.skillLevel, 'beginner');
  assert.match(project.title, /blinking LED/i);
  assert.ok(project.componentsExpected.includes('Arduino board'));
  assert.ok(project.componentsExpected.includes('breadboard'));
  assert.ok(project.componentsExpected.includes('LED'));
  assert.ok(project.availableMaterials.includes('Arduino board'));
  assert.ok(project.availableMaterials.includes('LED'));
  assert.ok(project.orderedSteps.length >= 4);
  assert.equal(project.currentStep, project.orderedSteps[0].stepId);
  assert.ok(project.safetyNotes.length >= 3);
  assert.equal(project.conversationHistory[0].role, 'user');
  assert.equal(project.conversationHistory[0].text, project.userGoal);
});

test('mentioned parts are not silently treated as available', () => {
  const project = createProjectFromIntent('Build a light theremin with an LED and a sensor. I need a battery.');
  assert.ok(project.componentsExpected.includes('LED'));
  assert.ok(!project.availableMaterials.includes('LED'));
  assert.equal(project.componentAvailability.LED, 'mentioned_not_confirmed');
});

test('detects explicit availability only from availability sentences', () => {
  assert.deepEqual(detectAvailableMaterials('I have a servo motor. I need a battery.'), ['servo motor']);
  assert.deepEqual(detectComponents('A servo motor and a battery.'), ['battery', 'servo motor']);
});

test('recognises an LDR / photoresistor as a part', () => {
  assert.ok(detectComponents('A night-light with an LDR and a resistor.').includes('photoresistor (LDR)'));
  assert.ok(detectComponents('Use a light sensor and a relay.').includes('photoresistor (LDR)'));
});

test('project state round-trips and resumes on the same step', () => {
  const project = createProjectFromIntent('I want to build a simple LED circuit with a resistor.');
  const secondStep = project.orderedSteps[1].stepId;
  const advanced = advanceProjectStep(project, project.currentStep);
  assert.equal(currentStepOf(advanced).stepId, secondStep);

  const restored = deserializeProject(serializeProject(advanced));
  assert.equal(restored.projectId, advanced.projectId);
  assert.equal(restored.currentStep, secondStep);
  assert.equal(currentStepOf(restored).status, 'current');
});

test('object confirmation is explicit and records the corrected name', () => {
  const project = createProjectFromIntent('Build an LED circuit.');
  const withObject = addObjectToProject(project, {
    id: 'obj_1',
    name: 'LED (candidate)',
    identityStatus: 'ai_candidate',
    confirmed: false,
  });
  const confirmed = confirmProjectObject(withObject, 'obj_1', 'Red 5mm LED');
  assert.equal(confirmed.objects[0].name, 'Red 5mm LED');
  assert.equal(confirmed.objects[0].identityStatus, 'confirmed_by_user');
  assert.equal(confirmed.objects[0].confirmed, true);
  assert.deepEqual(confirmed.confirmedComponents, ['Red 5mm LED']);
});

test('project context sent to the AI separates expected from available and confirmed', () => {
  const project = createProjectFromIntent('Build a blinking LED. I have an Arduino Uno and a breadboard.');
  const ctx = projectContextForAI(project);
  assert.equal(ctx.skillLevel, 'beginner');
  assert.ok(ctx.expectedComponents || ctx.componentsExpected);
  assert.ok(ctx.availableMaterials.length > 0);
  assert.deepEqual(ctx.confirmedComponents, []);
  assert.ok(ctx.currentStep.stepId);
  assert.ok(ctx.safetyNotes.length > 0);
  assert.ok(!('conversationHistory' in ctx));
});

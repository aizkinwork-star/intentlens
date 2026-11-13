// projectPlanner.js — structured beginner project state.
//
// The product is not a chat transcript. A project has a goal, a skill level,
// expected (but not assumed) parts, an ordered plan, a current step, safety
// notes, captures and confirmed component objects. Everything here is pure so
// it can be persisted, tested, and sent to the vision model as context.
//
// Important honesty rule: parts are "expected" because the user mentioned them.
// Nothing is "available" unless the user said they have it, and nothing is
// "confirmed" until the user confirms it in the app.

const MAX_TEXT = 600;
const MAX_GOAL = 1200;

const clean = (value, max = MAX_TEXT) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const COMPONENT_LEXICON = [
  { name: 'Arduino board', re: /\barduino(?:\s+(?:uno|nano|mega|leonardo))?\b/i },
  { name: 'Raspberry Pi', re: /\braspberry\s*pi\b/i },
  { name: 'ESP32 board', re: /\besp32\b/i },
  { name: 'ESP8266 board', re: /\besp8266\b/i },
  { name: 'breadboard', re: /\bbreadboards?\b/i },
  { name: 'LED', re: /\bleds?\b/i },
  { name: 'resistor', re: /\bresistors?\b/i },
  { name: 'photoresistor (LDR)', re: /\b(?:ldrs?|photoresistors?|light[- ]dependent\s+resistors?|light[- ]sensors?)\b/i },
  { name: 'capacitor', re: /\bcapacitors?\b/i },
  { name: 'transistor', re: /\btransistors?\b/i },
  { name: 'diode', re: /\bdiodes?\b/i },
  { name: 'battery', re: /\bbatter(?:y|ies)\b/i },
  { name: 'battery holder', re: /\bbattery\s*(?:holder|clip)\b/i },
  { name: 'jumper wires', re: /\bjumper\s*wires?\b/i },
  { name: 'USB cable', re: /\busb\s*(?:cable|lead)\b/i },
  { name: 'sensor module', re: /\bsensor(?:\s+module)?s?\b/i },
  { name: 'servo motor', re: /\bservo(?:\s+motor)?\b/i },
  { name: 'DC motor', re: /\bdc\s*motor\b/i },
  { name: 'switch', re: /\bswitch(?:es)?\b/i },
  { name: 'potentiometer', re: /\bpotentiometer\b/i },
  { name: 'buzzer', re: /\bbuzzer\b/i },
  { name: 'relay module', re: /\brelay(?:\s+module)?\b/i },
  { name: 'solar panel', re: /\bsolar\s*panel\b/i },
  { name: 'multimeter', re: /\bmultimeter\b/i },
  { name: 'soldering iron', re: /\bsoldering\s*iron\b/i },
];

const AVAILABILITY_RE = /\b(i have|i've got|i got|i already have|with me|available|using|i am using|i'm using|i will use)\b/i;
const REQUIREMENT_RE = /\b(need|needs|required?|must|should|want to|would like to|goal is)\b/i;
const BEGINNER_RE = /\b(beginner|first[- ]time|new to|no experience|never (?:built|made|used)|student|learning)\b/i;
const INTERMEDIATE_RE = /\b(intermediate|some experience|have built|comfortable with)\b/i;
const ADVANCED_RE = /\b(advanced|experienced|expert|professional)\b/i;

function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function detectComponents(text) {
  const source = String(text ?? '');
  const found = [];
  for (const item of COMPONENT_LEXICON) {
    if (item.re.test(source)) found.push(item.name);
  }
  return [...new Set(found)];
}

export function detectAvailableMaterials(text) {
  const source = String(text ?? '');
  const available = new Set();
  for (const sentence of splitSentences(source)) {
    if (!AVAILABILITY_RE.test(sentence)) continue;
    for (const name of detectComponents(sentence)) available.add(name);
  }
  return [...available];
}

export function detectRequirements(text) {
  const out = [];
  for (const sentence of splitSentences(text)) {
    if (REQUIREMENT_RE.test(sentence)) out.push(clean(sentence, 240));
  }
  return [...new Set(out)].slice(0, 8);
}

export function detectSkillLevel(text) {
  const source = String(text ?? '');
  if (ADVANCED_RE.test(source)) return 'advanced';
  if (INTERMEDIATE_RE.test(source)) return 'intermediate';
  if (BEGINNER_RE.test(source)) return 'beginner';
  return 'beginner';
}

export function makeProjectTitle(text) {
  const sentence = splitSentences(text)[0] || clean(text, 90) || 'Untitled project';
  const title = sentence
    .replace(/^(please\s+)?(help me\s+)?(i\s+(want|would like|need)\s+to\s+)/i, '')
    .replace(/^(build|make|create|design)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return clean(title || sentence, 90);
}

function step(id, action, instructionText, riskClass = 'observational') {
  return {
    stepId: `step_${id}`,
    action,
    instructionText,
    spokenText: instructionText,
    riskClass,
    requiresUserConfirmation: true,
    status: 'pending',
  };
}

export function deriveStarterPlan({ componentsExpected = [], availableMaterials = [] } = {}) {
  const parts = [...new Set([...componentsExpected, ...availableMaterials])];
  const partsLine = parts.length
    ? `Lay out these parts: ${parts.join(', ')}. Check each one against the project goal and put aside anything you do not recognize.`
    : 'Lay out the parts you have. If you are not sure what a part is, capture a photo of it before connecting anything.';

  return [
    step(1, 'inspect', 'Confirm the goal and list every part you have. Do not assume a part is available if you cannot find it.'),
    step(2, 'inspect', partsLine),
    step(3, 'place', 'Place the parts on the breadboard or work surface with the power disconnected.'),
    step(4, 'inspect', 'Compare every connection with a diagram or the project instructions before applying power.'),
    step(5, 'capture', 'Capture a clear photo of the component or connection you are unsure about.'),
    step(6, 'inspect', 'Apply power only after the wiring is checked, then note what happens.'),
  ].map((item, index) => ({ ...item, status: index === 0 ? 'current' : 'pending' }));
}

export function buildSafetyNotes(text) {
  const source = String(text ?? '').toLowerCase();
  const notes = [
    'Keep power disconnected while wiring or moving parts.',
    'Check polarity and orientation before connecting a power source.',
    'Do not work on mains voltage. Ask an adult or qualified person for anything connected to wall power.',
  ];
  if (/solder|soldering/.test(source)) {
    notes.push('Soldering is hot work. Use a stand, ventilation, eye protection and adult supervision.');
  }
  if (/battery|lipo| lithium|rechargeable/.test(source)) {
    notes.push('Do not short, puncture, overcharge or reverse a battery. Stop if a battery gets hot or swells.');
  }
  return notes;
}

export function newProjectId(now = Date.now()) {
  return `proj_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Create the structured project from one natural-language description.
 */
export function createProjectFromIntent(intentText, { now = new Date(), id = null } = {}) {
  const userGoal = clean(intentText, MAX_GOAL);
  if (!userGoal) throw new Error('Describe what you want to build first.');

  const skillLevel = detectSkillLevel(userGoal);
  const componentsExpected = detectComponents(userGoal);
  const availableMaterials = detectAvailableMaterials(userGoal);
  const requirements = detectRequirements(userGoal);
  const orderedSteps = deriveStarterPlan({ componentsExpected, availableMaterials });
  const currentStep = orderedSteps[0]?.stepId || null;
  const projectId = id || newProjectId(now.getTime());
  const iso = now.toISOString();

  const componentAvailability = Object.fromEntries(
    componentsExpected.map((name) => [
      name,
      availableMaterials.includes(name) ? 'available' : 'mentioned_not_confirmed',
    ]),
  );

  return {
    schemaVersion: 2,
    projectId,
    title: makeProjectTitle(userGoal),
    userGoal,
    skillLevel,
    requirements,
    availableMaterials,
    componentsExpected,
    componentAvailability,
    confirmedComponents: [],
    currentStep,
    orderedSteps,
    safetyNotes: buildSafetyNotes(userGoal),
    capturedImages: [],
    objects: [],
    conversationHistory: [{ role: 'user', text: userGoal, at: iso }],
    createdAt: iso,
    updatedAt: iso,
  };
}

export function currentStepOf(project) {
  if (!project || !Array.isArray(project.orderedSteps)) return null;
  return project.orderedSteps.find((s) => s.stepId === project.currentStep) || project.orderedSteps[0] || null;
}

export function advanceProjectStep(project, stepId = null, now = new Date()) {
  if (!project || !Array.isArray(project.orderedSteps)) return project;
  const target = stepId || project.currentStep;
  const index = project.orderedSteps.findIndex((s) => s.stepId === target);
  if (index < 0) return project;

  const steps = project.orderedSteps.map((s, i) => ({
    ...s,
    status: i < index ? 'done' : i === index ? 'done' : s.status,
  }));
  const next = steps[index + 1];
  if (next) next.status = 'current';
  return {
    ...project,
    orderedSteps: steps,
    currentStep: next ? next.stepId : null,
    updatedAt: now.toISOString(),
  };
}

export function setProjectStep(project, stepId, now = new Date()) {
  if (!project || !Array.isArray(project.orderedSteps)) return project;
  if (!project.orderedSteps.some((s) => s.stepId === stepId)) return project;
  const index = project.orderedSteps.findIndex((s) => s.stepId === stepId);
  return {
    ...project,
    orderedSteps: project.orderedSteps.map((s, i) => ({
      ...s,
      status: i < index ? 'done' : i === index ? 'current' : 'pending',
    })),
    currentStep: stepId,
    updatedAt: now.toISOString(),
  };
}

export function addCaptureToProject(project, capture, now = new Date()) {
  if (!project || !capture) return project;
  const record = {
    captureId: capture.captureId,
    projectId: project.projectId,
    width: capture.width,
    height: capture.height,
    capturedAt: capture.capturedAt,
    originalUrl: capture.originalUrl || null,
    localOnly: Boolean(capture.localOnly),
  };
  return {
    ...project,
    capturedImages: [...(project.capturedImages || []), record].slice(-20),
    updatedAt: now.toISOString(),
  };
}

export function addObjectToProject(project, object, now = new Date()) {
  if (!project || !object) return project;
  return {
    ...project,
    objects: [...(project.objects || []), object].slice(-30),
    updatedAt: now.toISOString(),
  };
}

export function updateProjectObject(project, objectId, patch, now = new Date()) {
  if (!project || !Array.isArray(project.objects)) return project;
  return {
    ...project,
    objects: project.objects.map((obj) => (obj.id === objectId ? { ...obj, ...patch } : obj)),
    updatedAt: now.toISOString(),
  };
}

export function confirmProjectObject(project, objectId, correctedName = null, now = new Date()) {
  if (!project || !Array.isArray(project.objects)) return project;
  const object = project.objects.find((obj) => obj.id === objectId);
  if (!object) return project;
  const name = clean(correctedName || object.name, 120);
  const confirmed = new Set([...(project.confirmedComponents || []), name]);
  return {
    ...project,
    objects: project.objects.map((obj) => (obj.id === objectId
      ? {
        ...obj,
        name,
        identityStatus: 'confirmed_by_user',
        confirmed: true,
        uncertainty: 'low',
        updatedAt: now.toISOString(),
      }
      : obj)),
    confirmedComponents: [...confirmed],
    updatedAt: now.toISOString(),
  };
}

/**
 * The compact project block sent to the model. It deliberately separates
 * mentioned parts from available and user-confirmed parts.
 */
export function projectContextForAI(project, { currentObject = null } = {}) {
  if (!project) return null;
  const step = currentStepOf(project);
  return {
    projectId: project.projectId,
    title: clean(project.title, 120),
    userGoal: clean(project.userGoal, 800),
    skillLevel: project.skillLevel || 'beginner',
    requirements: (project.requirements || []).slice(0, 6),
    availableMaterials: (project.availableMaterials || []).slice(0, 12),
    componentsExpected: (project.componentsExpected || []).slice(0, 12),
    confirmedComponents: (project.confirmedComponents || []).slice(0, 12),
    componentAvailability: project.componentAvailability || {},
    currentStep: step ? { stepId: step.stepId, instruction: clean(step.instructionText, 240) } : null,
    orderedSteps: (project.orderedSteps || []).slice(0, 10).map((s) => ({
      stepId: s.stepId,
      instruction: clean(s.instructionText, 180),
      status: s.status,
      riskClass: s.riskClass,
    })),
    safetyNotes: (project.safetyNotes || []).slice(0, 6),
    currentObject: currentObject ? {
      id: currentObject.id,
      name: currentObject.name,
      identityStatus: currentObject.identityStatus,
    } : null,
  };
}

export function serializeProject(project) {
  if (!project) return null;
  return JSON.parse(JSON.stringify(project));
}

export function deserializeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.projectId !== 'string' || !raw.projectId) return null;
  if (typeof raw.userGoal !== 'string' || !raw.userGoal.trim()) return null;
  const steps = Array.isArray(raw.orderedSteps) ? raw.orderedSteps : [];
  return {
    ...raw,
    title: clean(raw.title || makeProjectTitle(raw.userGoal), 120),
    skillLevel: ['beginner', 'intermediate', 'advanced'].includes(raw.skillLevel) ? raw.skillLevel : 'beginner',
    requirements: Array.isArray(raw.requirements) ? raw.requirements.slice(0, 8) : [],
    availableMaterials: Array.isArray(raw.availableMaterials) ? raw.availableMaterials.slice(0, 20) : [],
    componentsExpected: Array.isArray(raw.componentsExpected) ? raw.componentsExpected.slice(0, 20) : [],
    confirmedComponents: Array.isArray(raw.confirmedComponents) ? raw.confirmedComponents.slice(0, 20) : [],
    orderedSteps: steps.slice(0, 12),
    safetyNotes: Array.isArray(raw.safetyNotes) ? raw.safetyNotes.slice(0, 8) : [],
    capturedImages: Array.isArray(raw.capturedImages) ? raw.capturedImages.slice(-20) : [],
    objects: Array.isArray(raw.objects) ? raw.objects.slice(-30) : [],
    conversationHistory: Array.isArray(raw.conversationHistory) ? raw.conversationHistory.slice(-40) : [],
  };
}

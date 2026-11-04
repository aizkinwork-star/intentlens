// server/services/instructionValidator.js — validates multi-step instruction plans.
export function validateInstructionPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] };
  if (!plan.taskId || typeof plan.taskId !== 'string') errors.push('taskId required');
  if (!Array.isArray(plan.steps)) errors.push('steps must be an array');
  const steps = plan.steps || [];
  const ids = new Set();
  for (const s of steps) {
    if (!s || typeof s !== 'object') { errors.push('step must be object'); continue; }
    if (!s.stepId || typeof s.stepId !== 'string') errors.push('stepId required');
    else if (ids.has(s.stepId)) errors.push(`duplicate stepId ${s.stepId}`);
    else ids.add(s.stepId);
    if (!s.instructionText || typeof s.instructionText !== 'string') errors.push(`step ${s.stepId}: instructionText required`);
    if (!s.spokenText || typeof s.spokenText !== 'string') errors.push(`step ${s.stepId}: spokenText required`);
    if (!['inspect','align','place','remove','capture','ask_user','request_measurement','stop'].includes(s.action)) errors.push(`step ${s.stepId}: invalid action`);
    if (!['observational','low_voltage_guided','measurement_required','out_of_scope'].includes(s.riskClass)) errors.push(`step ${s.stepId}: invalid riskClass`);
    if (typeof s.requiresUserConfirmation !== 'boolean') errors.push(`step ${s.stepId}: requiresUserConfirmation must be boolean`);
  }
  if (plan.currentStepId && !ids.has(plan.currentStepId)) errors.push('currentStepId not in steps');
  if (!['present_step','clarify','block'].includes(plan.nextAction)) errors.push('invalid nextAction');
  return { ok: errors.length === 0, errors, stepCount: steps.length };
}

export function normalizeInstructionPlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const plan = raw.plan || raw;
  if (!plan || typeof plan !== 'object') return null;
  const v = validateInstructionPlan(plan);
  if (!v.ok) return { ...plan, _validationErrors: v.errors };
  return plan;
}
// Multi-step work instruction schema (audit §8.2).
// The model proposes; the backend validates IDs, bounds, enumerations and evidence.
export const INSTRUCTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'frameId', 'observation', 'plan', 'currentStepId', 'nextAction'],
  properties: {
    requestId: { type: 'string' },
    frameId: { type: 'string' },
    observation: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'imageQuality', 'uncertainties', 'targets'],
      properties: {
        summary: { type: 'string' },
        imageQuality: { type: 'string', enum: ['good', 'poor', 'insufficient'] },
        uncertainties: { type: 'array', items: { type: 'string' } },
        targets: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['candidateId', 'targetKind', 'label', 'anchor01', 'box01', 'visualMatchScore', 'identityStatus'],
            properties: {
              candidateId: { type: 'string' },
              targetKind: { type: 'string', enum: ['component', 'pin', 'pad', 'connector', 'landmark'] },
              designator: { type: ['string', 'null'] },
              label: { type: 'string' },
              anchor01: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } },
              box01: { type: 'object', required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
              visualMatchScore: { type: 'number', minimum: 0, maximum: 1 },
              identityStatus: { type: 'string', enum: ['candidate', 'user-confirmed', 'source-confirmed'] },
            },
          },
        },
      },
    },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'steps'],
      properties: {
        taskId: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['stepId', 'action', 'instructionText', 'spokenText', 'riskClass', 'requiresUserConfirmation'],
            properties: {
              stepId: { type: 'string' },
              targetCandidateId: { type: ['string', 'null'] },
              action: { type: 'string', enum: ['inspect', 'align', 'place', 'remove', 'capture', 'ask_user', 'request_measurement', 'stop'] },
              instructionText: { type: 'string' },
              spokenText: { type: 'string' },
              riskClass: { type: 'string', enum: ['observational', 'low_voltage_guided', 'measurement_required', 'out_of_scope'] },
              prerequisites: { type: 'array', items: { type: 'string' } },
              evidenceIds: { type: 'array', items: { type: 'string' } },
              observableCompletionCriterion: { type: ['string', 'null'] },
              requiresUserConfirmation: { type: 'boolean' },
              stopConditions: { type: 'array', items: { type: 'string' } },
              measurementRequired: { type: 'boolean' },
            },
          },
        },
      },
    },
    currentStepId: { type: ['string', 'null'] },
    nextAction: { type: 'string', enum: ['present_step', 'clarify', 'block'] },
  },
};
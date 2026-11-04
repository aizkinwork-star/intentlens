// JSON Schema handed to Meta as `text.format` (Responses API structured output).
//
// Deliberate choices:
// - Coordinates are 0..1000 INTEGERS, because that is the grid Muse Spark actually
//   grounds on (dev.meta.ai/docs/image-understanding). The server converts to 0..1.
// - Everything is required and nullable instead of optional, so the schema satisfies
//   the strict subset (additionalProperties:false, required lists every key).
// - No evidence fields: citations are read from real url_citation annotations, never
//   from the model's own prose. The model cannot invent a source this way.
// - Flat and non-recursive, as required.
export const GROUNDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'resultStatus',
    'answerShort',
    'target',
    'uncertaintyNote',
    'needsConfirmation',
    'requestedClarification',
    'plan',
  ],
  properties: {
    resultStatus: {
      type: 'string',
      enum: ['target_found', 'needs_clarification', 'no_target'],
      description:
        'target_found when you can point at the thing asked for. needs_clarification when the request or view is ambiguous. no_target when the object is genuinely not in the image.',
    },
    answerShort: {
      type: 'string',
      description:
        'The user-facing answer, one or two short sentences, ideally under 160 characters. Plain language.',
    },
    target: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['targetId', 'label', 'x', 'y', 'box', 'confidence'],
      description: 'null unless resultStatus is target_found.',
      properties: {
        targetId: {
          type: 'string',
          description: 'Short reference for this object, e.g. U2, J1, OBJ_03. Reuse an id from the scene map when it is the same object.',
        },
        label: {
          type: 'string',
          description: 'What the object appears to be, marked as a guess when it is one.',
        },
        x: {
          type: 'integer',
          minimum: 0,
          maximum: 1000,
          description: 'Horizontal coordinate of the point you are pointing at: 0 = left edge, 1000 = right edge.',
        },
        y: {
          type: 'integer',
          minimum: 0,
          maximum: 1000,
          description: 'Vertical coordinate: 0 = top edge, 1000 = bottom edge.',
        },
        box: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['x_min', 'y_min', 'x_max', 'y_max'],
          description: 'Optional bounding box around the object, same 0..1000 grid. null when a point alone is honest.',
          properties: {
            x_min: { type: 'integer', minimum: 0, maximum: 1000 },
            y_min: { type: 'integer', minimum: 0, maximum: 1000 },
            x_max: { type: 'integer', minimum: 0, maximum: 1000 },
            y_max: { type: 'integer', minimum: 0, maximum: 1000 },
          },
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Your own certainty that this is the right object. Not a calibrated probability.',
        },
      },
    },
    uncertaintyNote: {
      type: ['string', 'null'],
      description: 'One short sentence on what is uncertain, or null when nothing is.',
    },
    needsConfirmation: {
      type: 'boolean',
      description: 'True when the user should confirm the target before acting on it.',
    },
    requestedClarification: {
      type: ['string', 'null'],
      description: 'When resultStatus is needs_clarification, the exact question or view change you need. Otherwise null.',
    },
    plan: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['taskId', 'steps', 'currentStepId', 'nextAction'],
      description: 'Optional multi-step instruction plan. Null when not applicable.',
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
        currentStepId: { type: ['string', 'null'] },
        nextAction: { type: 'string', enum: ['present_step', 'clarify', 'block'] },
      },
    },
  },
};

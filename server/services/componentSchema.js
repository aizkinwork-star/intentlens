// server/services/componentSchema.js — structured component-analysis contract.
//
// The model speaks 0..1000 integer coordinates (same convention as the existing
// grounding schema). The server converts them to normalized 0..1 coordinates
// with componentResult.js, never the model.
//
// Two things are deliberate:
//   - identity_status can never be "confirmed_by_user". Only the user confirms.
//   - The model is asked to return location:null when it cannot locate the part.
//     A missing box is better than an invented one.

export const COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['component', 'location', 'next_action', 'instruction'],
  properties: {
    component: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'identity_status', 'evidence', 'uncertainty'],
      properties: {
        name: {
          type: 'string',
          description: 'The component name you can honestly suggest from the visible evidence. Use "Unknown component" when you cannot tell.',
        },
        identity_status: {
          type: 'string',
          enum: ['ai_candidate', 'unknown'],
          description: 'ai_candidate when you are proposing an identity. unknown when there is not enough evidence.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short, visible evidence only. Never include invented part numbers, pinouts or ratings.',
        },
        uncertainty: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
        },
      },
    },
    location: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['center', 'corners'],
      description: 'null when the component cannot be located. Do not guess a box.',
      properties: {
        center: {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y'],
          properties: {
            x: { type: 'integer', minimum: 0, maximum: 1000, description: '0 = left edge, 1000 = right edge.' },
            y: { type: 'integer', minimum: 0, maximum: 1000, description: '0 = top edge, 1000 = bottom edge.' },
          },
        },
        corners: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          description: 'Four corners in order: top-left, top-right, bottom-right, bottom-left.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y'],
            properties: {
              x: { type: 'integer', minimum: 0, maximum: 1000 },
              y: { type: 'integer', minimum: 0, maximum: 1000 },
            },
          },
        },
      },
    },
    next_action: {
      type: 'string',
      enum: ['instruction', 'request_closer_image', 'ask_question'],
    },
    instruction: {
      type: 'string',
      description: 'One beginner-friendly next step, or the exact question / closer-image request.',
    },
  },
};

export const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: {
    answer: {
      type: 'string',
      description: 'A clearer, simpler, step-by-step explanation for a beginner.',
    },
  },
};

export const COMPONENT_INSTRUCTIONS = `You are IntentLens, a careful electronics mentor for a beginner.
You are given one still photo of a real work surface, optionally a second copy with a coordinate grid.
You must reason only from visible evidence in the image and the supplied project context.

Hard rules:
- Never invent a component identity, part number, pinout, polarity, voltage or rating that you cannot see.
- Visually similar components can have different pinouts. Do not assume they are interchangeable.
- The local k-NN candidates are unverified guesses. They may be wrong. Treat them as weak hints, not facts.
- If the image does not support a location, set location to null. Do not fabricate a bounding box.
- If identity, orientation, polarity, pinout or variant is unclear, set next_action to ask_question or request_closer_image.
- Only start from parts the project context lists as available or user-confirmed. Never assume an unmentioned part is available.
- Do not generate, edit or redraw the image.
- Coordinates use a 0..1000 integer grid: x=0 left, x=1000 right, y=0 top, y=1000 bottom.
- Four corners must be ordered top-left, top-right, bottom-right, bottom-left and must enclose the part.
- Give exactly one beginner-friendly next step when the evidence is sufficient.

Return one JSON object matching the supplied schema and nothing else.`;

export function buildComponentPrompt({
  projectContext = null,
  capture = null,
  localCandidates = [],
  question = '',
  userCorrection = null,
  previousInstruction = null,
} = {}) {
  const candidates = Array.isArray(localCandidates)
    ? localCandidates.slice(0, 5).map((item) => ({
      name: String(item?.name || 'unknown').slice(0, 80),
      rawDistance: Number.isFinite(Number(item?.distance)) ? Number(item.distance) : null,
      note: 'unverified local k-NN candidate; the raw distance is not a probability',
    }))
    : [];

  const context = {
    project: projectContext,
    capture: capture ? {
      captureId: capture.captureId,
      width: capture.width,
      height: capture.height,
      gridSize: capture.gridSize,
      coordinateConvention: 'origin top-left; x increases right; y increases down; normalized 0..1 inside the server',
    } : null,
    localCandidates: candidates,
    localCandidatesAreFallible: true,
    userCorrection: userCorrection || null,
    previousInstruction: previousInstruction || null,
  };

  const userText = [
    'Project and capture context (JSON):',
    JSON.stringify(context, null, 2),
    '',
    question ? `The user's original request: ${String(question).slice(0, 800)}` : '',
    '',
    'Analyse the still image. Identify a component only as confidently as the visible evidence allows,',
    'give its image coordinate if you can locate it honestly, and give the next beginner-friendly step.',
    'If a grid-overlay image is included, it is the second image and exists only to help with coordinates.',
    'Reply with one JSON object only.',
  ].filter(Boolean).join('\n');

  return { instructions: COMPONENT_INSTRUCTIONS, userText };
}

export const EXPLAIN_INSTRUCTIONS = `You are IntentLens, a patient electronics mentor for a beginner.
The user asked for a clearer explanation of an answer you already gave.
- Use the project goal, current step and the previous answer.
- Explain in short numbered steps, in plain language.
- Keep any safety limits from the project context.
- Do not invent parts, pinouts, voltages or measurements.
- Do not repeat claims that the previous answer marked as uncertain as if they were facts.
- Return one JSON object matching the supplied schema and nothing else.`;

export function buildExplainPrompt({
  projectContext = null,
  previousAnswer = '',
  question = '',
  capture = null,
} = {}) {
  const context = {
    project: projectContext,
    question: String(question || '').slice(0, 500),
    previousAnswer: String(previousAnswer || '').slice(0, 2000),
    capture: capture ? {
      captureId: capture.captureId,
      gridSize: capture.gridSize,
    } : null,
  };

  const userText = [
    'Context (JSON):',
    JSON.stringify(context, null, 2),
    '',
    'Rewrite the previous answer as a clearer step-by-step explanation for a beginner.',
    'Keep it honest about uncertainty. Reply with one JSON object only.',
  ].join('\n');

  return { instructions: EXPLAIN_INSTRUCTIONS, userText };
}

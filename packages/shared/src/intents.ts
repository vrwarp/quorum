import { z } from 'zod';

/** Structured output of the listener. */
export const IntentPositionSchema = z.object({
  userId: z.string(),
  claim: z.string(),
});

export const IntentSchema = z.object({
  type: z.enum(['edit_request', 'divergence', 'question', 'none']),
  confidence: z.number().min(0).max(1),
  /** document paths (file names) the intent concerns; empty when unclear */
  documents: z.array(z.string()),
  summary: z.string(),
  messageIds: z.array(z.string()),
  positions: z.array(IntentPositionSchema).default([]),
  /** for question: does it need web research? */
  needsResearch: z.boolean().default(false),
});

export const IntentBatchSchema = z.object({
  intents: z.array(IntentSchema),
});

export type Intent = z.infer<typeof IntentSchema>;
export type IntentBatch = z.infer<typeof IntentBatchSchema>;

/** JSON schema equivalent, for the Messages API structured output. Keep in sync with the zod schema. */
export const IntentBatchJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intents'],
  properties: {
    intents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'type',
          'confidence',
          'documents',
          'summary',
          'messageIds',
          'positions',
          'needsResearch',
        ],
        properties: {
          type: { type: 'string', enum: ['edit_request', 'divergence', 'question', 'none'] },
          confidence: { type: 'number' },
          documents: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
          messageIds: { type: 'array', items: { type: 'string' } },
          positions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['userId', 'claim'],
              properties: { userId: { type: 'string' }, claim: { type: 'string' } },
            },
          },
          needsResearch: { type: 'boolean' },
        },
      },
    },
  },
} as const;

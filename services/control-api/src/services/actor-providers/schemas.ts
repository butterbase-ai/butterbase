// services/control-api/src/services/actor-providers/schemas.ts
import { z } from 'zod';

const MAX_METADATA_VALUE_LEN = 500;

const safeMetadata = z.record(
  z.string().regex(/^(?!bb_)/, 'metadata keys may not start with bb_'),
  z.string().max(MAX_METADATA_VALUE_LEN),
).optional();

export const startMeetingsRequestSchema = z.object({
  meetingUrl: z.string().url(),
  transcript: z.boolean().default(true),
  recording: z.union([z.literal('mp4'), z.literal('audio_only'), z.literal(false)]).default('mp4'),
  metadata: safeMetadata,
});

export const listMeetingsRequestSchema = z.object({
  status: z.enum([
    'joining','waiting_room','in_call','recording','ended','done','fatal',
  ]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().nullable().optional(),
});

export type StartMeetingsRequest = z.infer<typeof startMeetingsRequestSchema>;
export type ListMeetingsRequest = z.infer<typeof listMeetingsRequestSchema>;

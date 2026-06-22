// services/control-api/src/services/actor-providers/schemas.ts
import { z } from 'zod';

const MAX_METADATA_VALUE_LEN = 500;

const safeMetadata = z.record(
  z.string().regex(/^(?!bb_)/, 'metadata keys may not start with bb_'),
  z.string().max(MAX_METADATA_VALUE_LEN),
).optional();

// Recall enforces a 24h hard ceiling; we mirror that and require positive ints.
const timeoutSec = z.number().int().positive().max(86400);

const automaticLeaveSchema = z.object({
  /** Leave if the bot is still in the waiting room after N seconds. */
  waitingRoomTimeoutSec: timeoutSec.optional(),
  /** Leave if no participants joined within N seconds of the bot joining. */
  noOneJoinedTimeoutSec: timeoutSec.optional(),
  /** Leave N seconds after the last participant leaves. */
  everyoneLeftTimeoutSec: timeoutSec.optional(),
  /** Leave if the bot is in-call but not recording for N seconds. */
  inCallNotRecordingTimeoutSec: timeoutSec.optional(),
}).strict().optional();

export const startMeetingsRequestSchema = z.object({
  meetingUrl: z.string().url(),
  transcript: z.boolean().default(true),
  recording: z.union([z.literal('mp4'), z.literal('audio_only'), z.literal(false)]).default('mp4'),
  metadata: safeMetadata,
  botName: z.string().trim().min(1).max(64).optional(),
  automaticLeave: automaticLeaveSchema,
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

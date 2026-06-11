// packages/sdk/src/ai/meetings-types.ts

export type MeetingStatus =
  | 'joining' | 'waiting_room' | 'in_call' | 'recording'
  | 'ended' | 'done' | 'fatal';

export interface StartMeetingRequest {
  meetingUrl: string;
  transcript?: boolean;
  recording?: 'mp4' | 'audio_only' | false;
  metadata?: Record<string, string>;
}

export interface MeetingBot {
  id: string;
  status: MeetingStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  metadata: Record<string, string>;
}

export interface ListMeetingsOptions {
  status?: MeetingStatus;
  limit?: number;
  cursor?: string | null;
}

export interface ListMeetingsResult {
  bots: MeetingBot[];
  nextCursor: string | null;
}

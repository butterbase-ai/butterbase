// packages/sdk/src/ai/meetings-types.ts

export type MeetingStatus =
  | 'joining' | 'waiting_room' | 'in_call' | 'recording'
  | 'ended' | 'done' | 'fatal';

export interface StartMeetingRequest {
  meetingUrl: string;
  transcript?: boolean;
  recording?: 'mp4' | 'audio_only' | false;
  metadata?: Record<string, string>;
  /** Display name the bot uses when it joins. 1-64 chars. Defaults to 'Butterbase Notetaker'. */
  botName?: string;
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
  /** Display name the bot used when joining. 'Butterbase Notetaker' for legacy bots created
   *  before this field was supported. */
  botName: string;
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

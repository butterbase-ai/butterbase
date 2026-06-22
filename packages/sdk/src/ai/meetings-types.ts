// packages/sdk/src/ai/meetings-types.ts

export type MeetingStatus =
  | 'joining' | 'waiting_room' | 'in_call' | 'recording'
  | 'ended' | 'done' | 'fatal';

export interface AutomaticLeaveConfig {
  /** Leave if the bot is still in the waiting room after N seconds. */
  waitingRoomTimeoutSec?: number;
  /** Leave if no participants joined within N seconds of the bot joining. */
  noOneJoinedTimeoutSec?: number;
  /** Leave N seconds after the last participant leaves. */
  everyoneLeftTimeoutSec?: number;
  /** Leave if the bot is in-call but not recording for N seconds. */
  inCallNotRecordingTimeoutSec?: number;
}

export interface StartMeetingRequest {
  meetingUrl: string;
  transcript?: boolean;
  recording?: 'mp4' | 'audio_only' | false;
  metadata?: Record<string, string>;
  /** Display name the bot uses when it joins. 1-64 chars. Defaults to 'Butterbase Notetaker'. */
  botName?: string;
  /** Per-bot overrides for vendor automatic-leave timers. Any field omitted uses the vendor default. */
  automaticLeave?: AutomaticLeaveConfig;
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

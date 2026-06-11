// services/control-api/src/services/actor-providers/types.ts

/**
 * Tenant context every adapter call receives. The adapter MUST inject
 * these into vendor-side metadata so webhooks can be attributed.
 */
export interface ActorTenantContext {
  appId: string;
  userId: string;
  leaseId: string;
}

export interface StartActorRequest {
  meetingUrl: string;
  transcript: boolean;          // true → opt into vendor's built-in transcription
  recording: 'mp4' | 'audio_only' | false;
  /** App-supplied metadata. Merged into an `app.*` keyspace; bb_* keys rejected. */
  metadata?: Record<string, string>;
}

export type ActorStatus =
  | 'joining' | 'waiting_room' | 'in_call' | 'recording'
  | 'ended' | 'done' | 'fatal';

export interface ActorBot {
  id: string;
  status: ActorStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  transcriptUrl: string | null;
  metadata: Record<string, string>;
}

export interface ListActorBotsRequest {
  status?: ActorStatus;
  limit?: number;
  cursor?: string | null;
}

export interface ListActorBotsResult {
  bots: ActorBot[];
  nextCursor: string | null;
}

/**
 * Implemented by each actor-style provider (Phase 2 = Recall; future = ...).
 * The pricing pair drives both lease-time estimates and settle-time charges.
 */
export interface ActorProvider {
  /** Stable key — externally observable as the provider for `ctx.ai.meetings`. */
  readonly key: 'meetings';
  /** USD/sec for recording. Used for lease + settlement. */
  recordingUsdPerSecond: number;
  /** USD/sec for transcription. 0 if `transcript:false`. */
  transcriptionUsdPerSecond: number;

  start(ctx: ActorTenantContext, req: StartActorRequest): Promise<ActorBot>;
  get(ctx: ActorTenantContext, botId: string): Promise<ActorBot>;
  stop(ctx: ActorTenantContext, botId: string): Promise<void>;
  list(ctx: ActorTenantContext, req: ListActorBotsRequest): Promise<ListActorBotsResult>;
  /** Compute the estimated USD cost for a meeting of the given duration. */
  estimateCost(req: { durationMinutes: number; transcript: boolean; markupPct: number }): { usd: number };
}

/** Thrown when no adapter is registered for the key. */
export class ProviderUnavailableError extends Error {
  constructor(public readonly key: string) {
    super(`provider_unavailable: no adapter registered for ${key}`);
    this.name = 'ProviderUnavailableError';
  }
}

/** Adapter-side surfacing of vendor errors. Status code controls the gateway HTTP code. */
export class ActorProviderError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActorProviderError';
  }
}

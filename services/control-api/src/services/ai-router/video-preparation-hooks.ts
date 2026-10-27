import type pg from 'pg';
import type { PreparationRow, AttemptRow, TerminalOutcome } from './video-preparations.js';
import type { AssetScope } from './reference-assets.js';
import type { LoadedReferenceImage } from './reference-image.js';
export interface PreparationContext { runtimePool: pg.Pool; platformPool: pg.Pool; region: string }
export interface PreparationScope { appId: string; organizationId: string; userId: string; endUserSub: string | null }
export interface PreparationSelection { providerSlot: string; credentialNamespace: string; billingContext: Record<string, unknown> }
/** Trusted server policy evidence, pinned in the immutable selection, never accepted in a public body. */
export interface TemporaryReferencePolicy { policyId: string; confirmationId: string; expiresAt: string; expectedSha256: Record<string,string> }
export interface ReferenceProgress { sha256: string; referenceId?: string; assetId?: string; nextAction?: 'ensure_with_image' | 'poll'; nextPollAt?: string }
export type ReferenceResult =
 | { status: 'processing'; referenceId: string; nextPollAt: Date; nextAction: 'ensure_with_image' | 'poll' }
 | { status: 'active'; referenceId: string; assetId: string }
 | { status: 'failed'; errorCode: string };
export type PreparationProviderResult =
 | { status: 'accepted'; handle: Record<string, unknown> }
 | { status: 'pending'; nextPollAt?: Date }
 | { status: 'uncertain' }
 | { status: 'terminal'; outcome: TerminalOutcome };
/** Only a timely submit result proving no provider dispatch may authorize retry. */
export type PreparationSubmitResult = PreparationProviderResult
 | { status: 'not_submitted'; reason: 'provider_capacity'; nextPollAt?: Date };
/** Private implementation owns provider eligibility, credentials and ALL money policy.
 * Transport exceptions/unknown responses are ambiguous, never automatic resends.
 * retryPaths is permitted ONLY for a verified structured input-face/privacy failure.
 */
export interface VideoPreparationHooks {
 /** Metadata-only enrichment after authentication; default absent. */
 enrichRequest?(ctx: PreparationContext, scope: PreparationScope, request: Record<string,unknown>): Promise<{ request: Record<string,unknown>; policy?: TemporaryReferencePolicy }>;
 /** Bounded provider cleanup/reconciliation and local source retention. */
 maintainReferences?(ctx: PreparationContext): Promise<void>;
 /** Independent retained-output cleanup; must not depend on provider credentials. */
 maintainOutputs?(ctx: PreparationContext): Promise<void>;
 quote(ctx: PreparationContext, scope: PreparationScope, request: Record<string, unknown>): Promise<PreparationSelection | null>;
 authorize(ctx: PreparationContext, job: PreparationRow): Promise<'allowed' | 'cancelled' | 'region_mismatch'>;
 loadImage?(scope: AssetScope, source: string): Promise<LoadedReferenceImage>;
 prepareReference(ctx: PreparationContext, job: PreparationRow, path: string, progress: ReferenceProgress, image?: LoadedReferenceImage): Promise<ReferenceResult>;
 reserve(ctx: PreparationContext, attempt: AttemptRow, job: PreparationRow): Promise<{ ok: true } | { ok: false; error: string }>;
 submit(ctx: PreparationContext, attempt: AttemptRow, job: PreparationRow, assets: Record<string, string>): Promise<PreparationSubmitResult>;
 poll(ctx: PreparationContext, attempt: AttemptRow, job: PreparationRow): Promise<PreparationProviderResult>;
 reconcile(ctx: PreparationContext, attempt: AttemptRow, job: PreparationRow): Promise<PreparationProviderResult>;
 readReceipt(ctx: PreparationContext, attempt: AttemptRow): Promise<Record<string, unknown> | null>;
 settle(ctx: PreparationContext, attempt: AttemptRow, job: PreparationRow): Promise<Record<string, unknown>>;
 /** SQL only, awaited within SAME runtime transaction as acknowledgement. */
 writeUsage(tx: pg.PoolClient, job: PreparationRow, attempt: AttemptRow, receipt: Record<string, unknown>): Promise<void>;
 content(ctx: PreparationContext, attempt: AttemptRow, index: number, options?: { range?: string }): Promise<{
  stream: ReadableStream<Uint8Array>; contentType: string; statusCode?: 200 | 206; contentLength?: number; contentRange?: string;
 }>;
}
let hooks: VideoPreparationHooks | null = null;
export function setVideoPreparationHooks(value: VideoPreparationHooks | null): void { hooks = value; }
export function getVideoPreparationHooks(): VideoPreparationHooks | null { return hooks; }

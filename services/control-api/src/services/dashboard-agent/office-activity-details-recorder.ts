import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { OfficeActivityStep, OfficeActivityStepV2 } from '@butterbase/shared';
import { createOfficeActivityProjector, officeActivityCall } from './office-activity.js';
import { previewOfficeToolValue } from './office-activity-preview.js';
import { allocateOfficeActivityInvocation, saveOfficeActivityObservation, unavailablePreview, type OfficePreviewPhase } from './office-activity-details-store.js';

export type OfficeActivityObservation = { invocationId: string; phase: OfficePreviewPhase; step: OfficeActivityStepV2 };
const observation = Symbol('officeToolObservation');
export function attachOfficeActivityObservation<T extends object>(event: T, value: OfficeActivityObservation): T {
  Object.defineProperty(event, observation, { value, enumerable: false }); return event;
}
export function readOfficeActivityObservation(event: object): OfficeActivityObservation | null { return (event as any)[observation] ?? null; }
type Active = { id: string; providerId: string; toolName: string; action?: string; step: OfficeActivityStep; projector: ReturnType<typeof createOfficeActivityProjector> };

export function createOfficeActivityDetailRecorder({ pool, conversationId, resumeApprovalId }: { pool: pg.Pool; conversationId: string; resumeApprovalId?: string }) {
  let anchor: string | null = null; let count = 0;
  const active = new Map<string, Active>(); const ambiguous = new Set<string>();
  return {
    async start(userMessageId: string): Promise<void> {
      try {
        const { rows } = resumeApprovalId
          ? await pool.query('SELECT user_message_id AS id FROM dashboard_agent_office_turns WHERE conversation_id=$1 AND approval_id=$2', [conversationId, resumeApprovalId])
          : await pool.query("SELECT id FROM dashboard_agent_messages WHERE conversation_id=$1 AND id=$2 AND role='user'", [conversationId, userMessageId]);
        anchor = rows[0]?.id ?? null;
      } catch { anchor = null; }
    },
    async observe(raw: unknown): Promise<OfficeActivityObservation | null> {
      if (!anchor || !raw || typeof raw !== 'object') return null;
      const event = raw as Record<string, any>;
      try {
        if (event.type === 'tool_call') {
          if (typeof event.id !== 'string' || !event.id.length || event.id.length > 256 || ++count > 512) return null;
          if (active.has(event.id)) {
            const prior = active.get(event.id)!;
            await saveOfficeActivityObservation(pool, { id: prior.id, step: { ...prior.step, status: 'unknown', summary: 'Result correlation unavailable' } });
            ambiguous.add(event.id); active.delete(event.id);
          }
          const id = randomUUID(); const projector = createOfficeActivityProjector();
          const step = projector.observe({ ...event, id }); if (!step) return null;
          if (ambiguous.has(event.id)) { step.status = 'unknown'; step.summary = 'Result correlation unavailable'; }
          await allocateOfficeActivityInvocation(pool, { id, conversationId, userMessageId: anchor, providerCallId: event.id, step,
            preview: previewOfficeToolValue(event.args, { toolName: step.tool_name, action: step.action, phase: 'input' }) });
          const entry = { id, providerId: event.id, toolName: step.tool_name, action: step.action, step, projector };
          if (!ambiguous.has(event.id)) active.set(event.id, entry);
          return { invocationId: id, phase: 'call', step: { ...step, detail_ref: id } };
        }
        if (event.type === 'approval_required') {
          const call = officeActivityCall(event);
          const matches = [...active.values()].filter(x => x.toolName === event.tool_name);
          let entry = call?.id ? active.get(call.id) : matches.length === 1 ? matches[0] : undefined;
          if (!entry) {
            const start = await this.observe({ type: 'tool_call', id: call?.id ?? `approval:${event.approval_id}`, name: call?.name ?? event.tool_name, args: call?.args ?? event.args });
            if (!start) return null;
            entry = active.get(call?.id ?? `approval:${event.approval_id}`);
          }
          if (!entry || ambiguous.has(entry.providerId)) return null;
          const step = { ...entry.step, status: 'awaiting_approval' as const, summary: 'Awaiting approval' };
          await saveOfficeActivityObservation(pool, { id: entry.id, step, approvalId: event.approval_id, phase: 'tool_result',
            preview: previewOfficeToolValue({ status: 'awaiting_approval', requires_approval: true }, { toolName: entry.toolName, action: entry.action, phase: 'result' }) });
          active.delete(entry.providerId);
          return { invocationId: entry.id, phase: 'tool_result', step: { ...step, detail_ref: entry.id } };
        }
        if (event.type === 'tool_result') {
          if (ambiguous.has(event.id)) return null;
          let entry = active.get(event.id);
          if (!entry) {
            const call = officeActivityCall(event);
            if (call?.name) { await this.observe({ type: 'tool_call', id: call.id, name: call.name, args: call.args }); entry = active.get(call.id); }
          }
          if (!entry) return null;
          const step = entry.projector.observe({ ...event, id: entry.id }); if (!step) return null;
          const value = Object.prototype.hasOwnProperty.call(event, 'result') ? event.result : event.error !== undefined ? { error: event.error } : undefined;
          try {
            await saveOfficeActivityObservation(pool, { id: entry.id, step, phase: 'tool_result', preview: value === undefined ? unavailablePreview() : previewOfficeToolValue(value, { toolName: entry.toolName, action: entry.action, phase: 'result' }) });
            active.delete(event.id);
          } catch {
            // Retain terminal safe metadata for the final best-effort settlement.
            // The business call is never retried, and the UI keeps its UUID.
            entry.step = step;
          }
          return { invocationId: entry.id, phase: 'tool_result', step: { ...step, detail_ref: entry.id } };
        }
        if (['done','error','blocked'].includes(event.type)) {
          let last: OfficeActivityObservation | null = null;
          for (const entry of active.values()) {
            const step = entry.step.status !== 'running' ? entry.step : entry.projector.observe(event);
            if (step) {
              await saveOfficeActivityObservation(pool, { id: entry.id, step });
              last = { invocationId: entry.id, phase: 'tool_result', step: { ...step, detail_ref: entry.id } };
            }
          }
          active.clear();
          return last;
        }
      } catch { /* Never retry execution or fail a turn for optional diagnostics. */ }
      return null;
    },
  };
}
export type OfficeActivityDetailRecorder = ReturnType<typeof createOfficeActivityDetailRecorder>;

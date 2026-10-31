import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().datetime({ offset: true });
export const officeMemoryEvidenceRefSchema = z.object({
  kind: z.enum(['source_artifact', 'office_message', 'decision', 'commitment', 'learning']), id: text(256),
}).strict();
export const officeRecordAgentMemorySchema = z.object({ title: text(160), relevance_summary: text(320), body: text(16000),
  sources: z.array(officeMemoryEvidenceRefSchema).max(20).default([]),
  capture_origin: z.enum(['owner_request', 'agent_finding', 'explicit_promotion']),
  expires_at: date.nullable().optional(),
  verification: z.object({ evidence: z.array(officeMemoryEvidenceRefSchema).min(1).max(20) }).strict().optional(),
}).strict();
export const officeAmendAgentMemorySchema = officeRecordAgentMemorySchema.partial().extend({ memory_id: text(256),
  expected_revision: z.number().int().positive() }).strict()
  .refine(p => Object.keys(p).some(key => !['memory_id', 'expected_revision'].includes(key)), 'No changes supplied');
export const officeArchiveAgentMemorySchema = z.object({ memory_id: text(256), expected_revision: z.number().int().positive() }).strict();
export const agentMemorySummarySchema = z.object({ id: text(256), title: text(160), relevance_summary: text(320),
  revision: z.number().int().positive(), status: z.enum(['active', 'archived']), created_at: date, updated_at: date,
  last_verified_at: date.nullable(), expires_at: date.nullable() }).strict();
export const agentMemoryRecordSchema = agentMemorySummarySchema.extend({ organization_id: z.string().uuid(),
  body: text(16000), sources: z.array(officeMemoryEvidenceRefSchema), verification_evidence: z.array(officeMemoryEvidenceRefSchema),
  capture_origin: officeRecordAgentMemorySchema.shape.capture_origin, created_by: text(256), updated_by: text(256),
  evidence_snapshots: z.array(z.object({ ref: officeMemoryEvidenceRefSchema, organization_id: z.string().uuid(),
    excerpt: z.string().max(4000), sha256: z.string().regex(/^[a-f0-9]{64}$/), checked_at: date }).strict()),
}).strict();
export type AgentMemorySummary = z.infer<typeof agentMemorySummarySchema>;
export type AgentMemoryRecord = z.infer<typeof agentMemoryRecordSchema>;
export type OfficeRecordAgentMemoryInput = z.input<typeof officeRecordAgentMemorySchema>;
export type OfficeAmendAgentMemoryInput = z.input<typeof officeAmendAgentMemorySchema>;
export type OfficeArchiveAgentMemoryInput = z.input<typeof officeArchiveAgentMemorySchema>;

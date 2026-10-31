/** Public skill records use ISO timestamps; full archives stay in the native store. */
export interface OfficeSkillRecord {
  id: string; organizationId: string; name: string; displayName: string; description: string;
  currentVersionId: string | null; scheduleCron: string | null; timezone: string;
  nextRunAt: string | null; lastRunAt: string | null; lastRunOutcome: string | null;
  enabled: boolean; deletedAt: string | null; createdBy: string | null; createdAt: string; updatedAt: string;
}
export interface OfficeSkillTestResult {
  status: 'passed' | 'failed' | 'blocked'; reason?: string | null; read?: string[]; produced?: string[]; actions?: string[];
  startedAt: string; finishedAt: string; conversationId?: string | null;
}
export interface OfficeSkillVersionRecord {
  id: string; skillId: string; version: number; packageObjectId: string; status: 'draft' | 'approved' | 'rejected' | 'superseded';
  displayName?: string | null; description?: string | null; summary: string; changeSummary: string | null;
  scheduleCron: string | null; timezone: string | null; testResult: OfficeSkillTestResult | null;
  createdBy: string | null; createdAt: string; approvedBy: string | null; approvedAt: string | null;
  rejectedBy: string | null; rejectedAt: string | null; supersededBy: string | null;
}
export interface OfficeSkillRunRecord {
  id: string; skillId: string; versionId: string | null; trigger: 'scheduled' | 'manual' | 'test';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'approval_pending';
  reason: string | null; conversationId: string | null; messageId: string | null; scheduledFor: string;
  startedAt: string | null; finishedAt: string | null; approvalId: string | null; errorCode: string | null; createdAt: string;
}
export interface OfficeSkillDetail { skill: OfficeSkillRecord; current_version: OfficeSkillVersionRecord | null; }

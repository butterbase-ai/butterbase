/**
 * Office skill seams for the operator loop.
 *
 * These are executors, not tools the loop implements: the OSS build has no
 * skill store and no organization integrations, so each capability exists only
 * when the Office overlay supplies its executor for the turn. A missing
 * executor means the tool is ABSENT from the model's catalog — never a host
 * fallback, and never an MCP dispatch under the same name.
 */

/** The skill version pinned by the run currently executing. */
export interface ActiveSkillContext {
  skillId: string;
  versionId: string;
  runId: string;
  entrypoint: string;
}

/** What the creator returns to the model; the card is rendered from it. */
export interface SkillCreatorToolResult {
  skill_id: string;
  version_id: string;
  version: number;
  summary: string;
  change_summary: string | null;
  test_run_id: string;
  status: 'testing';
}

export type SkillCreatorExecutor = (input: {
  args: {
    request: string;
    target_skill_id?: string;
    draft_version_id?: string;
    timezone?: string;
  };
  organizationId: string;
  userId: string;
  jwt: string;
  model: string;
}) => Promise<SkillCreatorToolResult>;

export type SkillScriptExecutor = (input: {
  skill: ActiveSkillContext;
  args: { entrypoint?: string; input?: unknown };
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/**
 * Runs one allowlisted read against the organization's own connection. It
 * never receives an `app_id`, and it never returns credentials.
 */
export type IntegrationReader = (input: {
  organizationId: string;
  toolSlug: string;
  params?: Record<string, unknown>;
  readOnly: boolean;
}) => Promise<{ content: unknown }>;

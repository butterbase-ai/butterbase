import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { validateLocalOperation, validateProposalOperation, createProposalToolValidator } from '../proposal-validation.js';

describe('proposal executable validation', () => {
  it('validates explicit cloud overlay registration without runtime startup', async () => {
    const handler = vi.fn();
    const validator = await createProposalToolValidator(async server => {
      server.tool('synthetic_cloud_tool', 'Synthetic', { count: z.number().default(7) }, handler);
    });
    expect(await validator('synthetic_cloud_tool', {})).toEqual({ toolName: 'synthetic_cloud_tool', args: { count: 7 } });
    expect(handler).not.toHaveBeenCalled();
  });
  it('requires the exact local contract and an available executor without MCP fallback', () => {
    expect(validateLocalOperation('deploy_frontend', { app_id: 'app_example' }, new Set(['deploy_frontend']))).toEqual({ toolName: 'deploy_frontend', args: { app_id: 'app_example' } });
    expect(() => validateLocalOperation('deploy_frontend', {}, new Set(['deploy_frontend']))).toThrow('tool_arguments_invalid');
    expect(() => validateLocalOperation('deploy_frontend', { app_id: 'app_example' }, new Set())).toThrow('tool_unavailable');
    expect(() => validateLocalOperation('deploy_function_from_workspace', { app_id: 'app_example', function_name: '../other' }, new Set(['deploy_function_from_workspace']))).toThrow('tool_arguments_invalid');
    expect(() => validateLocalOperation('deploy_frontend', { app_id: 'app_example', secretly: true }, new Set(['deploy_frontend']))).toThrow('tool_arguments_invalid');
  });
  it('does not fall through local tools or allow recursive/control operations', async () => {
    const registered = vi.fn();
    const context = { effectiveToolNames: new Set(['deploy_frontend', 'propose_action', 'manage_substrate']), availableExecutors: new Set<string>(), validateRegistered: registered };
    await expect(validateProposalOperation('deploy_frontend', { app_id: 'app_example' }, context)).rejects.toThrow('tool_unavailable');
    await expect(validateProposalOperation('propose_action', {}, context)).rejects.toThrow('proposal_invalid');
    for (const action of ['approve', 'reject', 'resolve_policy_conflict']) await expect(validateProposalOperation('manage_substrate', { action, action_id: 'act_example' }, context)).rejects.toThrow('proposal_invalid');
    expect(registered).not.toHaveBeenCalled();
  });
  it('uses finalized registered defaults only for names offered on this turn', async () => {
    const registered = vi.fn(async (name: string) => ({ toolName: name, args: { action: 'read', limit: 10 } }));
    const context = { effectiveToolNames: new Set(['manage_app']), availableExecutors: new Set<string>(), validateRegistered: registered };
    await expect(validateProposalOperation('unknown', {}, context)).rejects.toThrow('tool_unavailable');
    expect(registered).not.toHaveBeenCalled();
    expect(await validateProposalOperation('manage_app', { action: 'read' }, context)).toEqual({ toolName: 'manage_app', args: { action: 'read', limit: 10 } });
  });
});

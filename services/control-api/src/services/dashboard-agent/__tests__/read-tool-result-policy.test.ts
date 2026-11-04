import { describe, expect, it } from 'vitest';
import { getToolCatalog, READ_TOOL_RESULT_TOOL, isReadToolResultTool } from '../tool-catalog.js';
import {
  operatorPolicyFor, isOperatorToolAllowed, OPERATOR_LOCAL_TOOLS, OPERATOR_TOOL_TIERS,
} from '../operator-policy.js';

describe('read_tool_result availability', () => {
  it('is advertised to both agents, not operator-only', () => {
    const spec = getToolCatalog().find((t) => t.name === READ_TOOL_RESULT_TOOL);
    expect(spec).toBeDefined();
    expect(spec?.operatorOnly).toBeUndefined();
    expect(isReadToolResultTool('read_tool_result')).toBe(true);
    expect(isReadToolResultTool('something_else')).toBe(false);
  });

  it('is an allow-tier local tool for the operator', () => {
    expect(operatorPolicyFor(READ_TOOL_RESULT_TOOL, {})).toBe('allow');
    expect(isOperatorToolAllowed(READ_TOOL_RESULT_TOOL)).toBe(true);
    expect(OPERATOR_LOCAL_TOOLS.has(READ_TOOL_RESULT_TOOL)).toBe(true);
    expect(OPERATOR_TOOL_TIERS.get(READ_TOOL_RESULT_TOOL)).toBe('allow');
  });
});

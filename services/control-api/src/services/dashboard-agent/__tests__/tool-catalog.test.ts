import { describe, it, expect } from 'vitest';
import { getToolCatalog } from '../tool-catalog.js';

describe('Tool Catalog', () => {
  it('getToolCatalog() returns manage_app with correct shape', () => {
    const catalog = getToolCatalog();

    expect(catalog).toHaveLength(1);
    const tool = catalog[0];

    // Tool must have name, description, and parameters
    expect(tool).toHaveProperty('name', 'manage_app');
    expect(tool).toHaveProperty('description');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);

    // Parameters must be a valid JSON schema
    const params = tool.parameters;
    expect(params).toHaveProperty('type', 'object');
    expect(params).toHaveProperty('properties');
    expect(params).toHaveProperty('required');

    // Properties must include action and params
    const properties = (params as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    expect(properties).toHaveProperty('action');
    expect(properties).toHaveProperty('params');

    // action must be an enum
    const actionSchema = properties.action as Record<string, unknown>;
    expect(actionSchema).toHaveProperty('type', 'string');
    expect(actionSchema).toHaveProperty('enum');
    expect(Array.isArray(actionSchema.enum)).toBe(true);
    expect((actionSchema.enum as string[]).length).toBeGreaterThan(0);

    // params must allow additional properties
    const paramsSchema = properties.params as Record<string, unknown>;
    expect(paramsSchema).toHaveProperty('type', 'object');
    expect(paramsSchema).toHaveProperty('additionalProperties', true);

    // required must include action
    const required = (params as Record<string, unknown>).required as string[];
    expect(required).toContain('action');
  });
});

import { describe, it, expect } from 'vitest';
import { getToolCatalog } from '../tool-catalog.js';

describe('Tool Catalog', () => {
  it('getToolCatalog() returns manage_app with flat schema (no params wrapper)', () => {
    const catalog = getToolCatalog();

    expect(catalog).toHaveLength(1);
    const tool = catalog[0];

    // Tool must have name, description, and parameters
    expect(tool).toHaveProperty('name', 'manage_app');
    expect(tool).toHaveProperty('description');
    expect(typeof tool.description).toBe('string');
    expect(tool.description.length).toBeGreaterThan(0);

    // Parameters must be a valid JSON schema
    const params = tool.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('type', 'object');
    expect(params).toHaveProperty('properties');
    expect(params).toHaveProperty('required');
    expect(params).toHaveProperty('additionalProperties', true);

    // Properties must include action but NOT params (flat schema)
    const properties = params.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('action');
    expect(properties).not.toHaveProperty('params');

    // action must be an enum with all 20+ actions
    const actionSchema = properties.action as Record<string, unknown>;
    expect(actionSchema).toHaveProperty('type', 'string');
    expect(actionSchema).toHaveProperty('enum');
    expect(Array.isArray(actionSchema.enum)).toBe(true);
    const enumValues = actionSchema.enum as string[];
    expect(enumValues.length).toBeGreaterThan(0);
    expect(enumValues).toContain('list');
    expect(enumValues).toContain('get_config');
    expect(enumValues).toContain('clone');

    // required must include only action
    const required = params.required as string[];
    expect(required).toContain('action');
  });
});

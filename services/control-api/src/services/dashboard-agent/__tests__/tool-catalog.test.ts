import { describe, it, expect } from 'vitest';
import { getToolCatalog, isFileOpTool, isDeployTool } from '../tool-catalog.js';

describe('Tool Catalog', () => {
  it('getToolCatalog() returns manage_app with flat schema (no params wrapper)', () => {
    const catalog = getToolCatalog();

    const tool = catalog.find(t => t.name === 'manage_app');
    expect(tool).toBeDefined();

    // Tool must have name, description, and parameters
    expect(tool).toHaveProperty('name', 'manage_app');
    expect(tool).toHaveProperty('description');
    expect(typeof tool!.description).toBe('string');
    expect(tool!.description.length).toBeGreaterThan(0);

    // Parameters must be a valid JSON schema
    const params = tool!.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('type', 'object');
    expect(params).toHaveProperty('properties');
    expect(params).toHaveProperty('required');
    expect(params).toHaveProperty('additionalProperties', true);

    // Properties must include action but NOT params (flat schema)
    const properties = params.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('action');
    expect(properties).not.toHaveProperty('params');
  });

  it('getToolCatalog() includes all four file-op tools', () => {
    const catalog = getToolCatalog();
    const names = catalog.map(t => t.name);

    expect(names).toContain('write_file');
    expect(names).toContain('read_file');
    expect(names).toContain('list_files');
    expect(names).toContain('delete_file');
  });

  it('write_file tool descriptor has correct required fields', () => {
    const catalog = getToolCatalog();
    const tool = catalog.find(t => t.name === 'write_file');
    expect(tool).toBeDefined();
    const params = tool!.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('type', 'object');
    const required = params.required as string[];
    expect(required).toContain('app_id');
    expect(required).toContain('path');
    expect(required).toContain('content');
  });

  it('read_file tool descriptor has app_id and path required', () => {
    const catalog = getToolCatalog();
    const tool = catalog.find(t => t.name === 'read_file');
    expect(tool).toBeDefined();
    const params = tool!.parameters as Record<string, unknown>;
    const required = params.required as string[];
    expect(required).toContain('app_id');
    expect(required).toContain('path');
  });

  it('list_files tool descriptor has app_id required', () => {
    const catalog = getToolCatalog();
    const tool = catalog.find(t => t.name === 'list_files');
    expect(tool).toBeDefined();
    const params = tool!.parameters as Record<string, unknown>;
    const required = params.required as string[];
    expect(required).toContain('app_id');
  });

  it('delete_file tool descriptor has app_id and path required', () => {
    const catalog = getToolCatalog();
    const tool = catalog.find(t => t.name === 'delete_file');
    expect(tool).toBeDefined();
    const params = tool!.parameters as Record<string, unknown>;
    const required = params.required as string[];
    expect(required).toContain('app_id');
    expect(required).toContain('path');
  });

  describe('isFileOpTool', () => {
    it('returns true for the four file-op tool names', () => {
      expect(isFileOpTool('write_file')).toBe(true);
      expect(isFileOpTool('read_file')).toBe(true);
      expect(isFileOpTool('list_files')).toBe(true);
      expect(isFileOpTool('delete_file')).toBe(true);
    });

    it('returns false for manage_app, deploy_frontend, and arbitrary strings', () => {
      expect(isFileOpTool('manage_app')).toBe(false);
      expect(isFileOpTool('deploy_frontend')).toBe(false);
      expect(isFileOpTool('create_frontend_deployment')).toBe(false);
      expect(isFileOpTool('')).toBe(false);
      expect(isFileOpTool('write_files')).toBe(false); // typo variant
    });
  });

  it('getToolCatalog() includes deploy_frontend', () => {
    const catalog = getToolCatalog();
    const names = catalog.map(t => t.name);
    expect(names).toContain('deploy_frontend');
  });

  it('deploy_frontend tool descriptor has app_id required', () => {
    const catalog = getToolCatalog();
    const tool = catalog.find(t => t.name === 'deploy_frontend');
    expect(tool).toBeDefined();
    const params = tool!.parameters as Record<string, unknown>;
    expect(params).toHaveProperty('type', 'object');
    const required = params.required as string[];
    expect(required).toContain('app_id');
  });

  describe('isDeployTool', () => {
    it('returns true for deploy_frontend', () => {
      expect(isDeployTool('deploy_frontend')).toBe(true);
    });

    it('returns false for other tool names', () => {
      expect(isDeployTool('manage_app')).toBe(false);
      expect(isDeployTool('write_file')).toBe(false);
      expect(isDeployTool('create_frontend_deployment')).toBe(false);
      expect(isDeployTool('')).toBe(false);
    });
  });
});

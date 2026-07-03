import { describe, it, expect, vi } from 'vitest';
import { resolveOrgFromApp } from '../services/app-org-resolver.js';
import { resolveOrgFromApiKey } from '../services/api-key-org-resolver.js';

describe('MCP tool call organization attribution', () => {
  describe('with app_id present', () => {
    it('resolves organization from app', async () => {
      const mockRuntimeDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ organization_id: 'org_from_app' }],
        }),
      };

      const result = await resolveOrgFromApp(mockRuntimeDb, 'app_123');
      expect(result).toBe('org_from_app');
      expect(mockRuntimeDb.query).toHaveBeenCalledWith(
        'SELECT organization_id FROM apps WHERE id = $1',
        ['app_123'],
      );
    });
  });

  describe('without app_id, using api_key', () => {
    it('resolves organization from api_key', async () => {
      const mockControlDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ organization_id: 'org_from_api_key' }],
        }),
      };

      const result = await resolveOrgFromApiKey(mockControlDb, 'key_abc123');
      expect(result).toBe('org_from_api_key');
      expect(mockControlDb.query).toHaveBeenCalledWith(
        'SELECT organization_id FROM api_keys WHERE id = $1',
        ['key_abc123'],
      );
    });

    it('throws when api_key not found', async () => {
      const mockControlDb = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
      };

      await expect(resolveOrgFromApiKey(mockControlDb, 'missing')).rejects.toThrow(
        /api_key/i,
      );
    });

    it('throws when api_key organization_id is NULL', async () => {
      const mockControlDb = {
        query: vi.fn().mockResolvedValue({
          rows: [{ organization_id: null }],
        }),
      };

      await expect(resolveOrgFromApiKey(mockControlDb, 'key_null')).rejects.toThrow(
        /has no organization_id/,
      );
    });
  });
});

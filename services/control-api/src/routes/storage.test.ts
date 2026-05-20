import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { databasePlugin } from '../plugins/database.js';
import { dataPlanePlugin } from '../plugins/data-plane.js';
import authPlugin from '../plugins/auth.js';
import { initRoutes } from './init.js';
import { storageRoutes } from './storage.js';
import { ApiKeyService } from '../services/api-key-service.js';
import * as s3Service from '../services/s3.js';
import { config } from '../config.js';

// Test constants
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const STORAGE_LIMIT_BYTES = 1024 * 1024 * 1024; // 1GB
const UPLOAD_URL_EXPIRY_SECONDS = 300;
const DOWNLOAD_URL_EXPIRY_SECONDS = 3600;
const PAGINATION_LIMIT = 100;
const LARGE_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

// Mock S3 service
vi.mock('../services/s3.js', () => ({
  generatePresignedUploadUrl: vi.fn(),
  generatePresignedDownloadUrl: vi.fn(),
  deleteObject: vi.fn(),
  S3Error: class S3Error extends Error {
    constructor(message: string, public code?: string) {
      super(message);
      this.name = 'S3Error';
    }
  },
}));

// Mock end-user auth for publicReadEnabled tests
vi.mock('../services/end-user-auth.js', () => ({
  verifyEndUserJwt: vi.fn(),
}));

import * as endUserAuth from '../services/end-user-auth.js';

describe('Storage Routes', () => {
  const app = Fastify();
  let testUserId: string;
  let validApiKey: string;
  let appId: string;
  let objectId: string;
  const nestedResources: { appIds: string[]; userIds: string[] } = { appIds: [], userIds: [] };

  beforeAll(async () => {
    // Enable auth for these tests
    process.env.AUTH_ENABLED = 'true';

    app.register(databasePlugin);
    app.register(dataPlanePlugin);
    app.register(authPlugin);
    app.register(initRoutes);
    app.register(storageRoutes);
    await app.ready();

    // Create test user
    const userResult = await app.controlDb.query(
      `INSERT INTO platform_users (email, cognito_sub)
       VALUES ('storage-test@example.com', 'storage-test-sub')
       RETURNING id`
    );
    testUserId = userResult.rows[0].id;

    // Generate valid API key
    const { key } = await ApiKeyService.generateApiKey(
      app.controlDb,
      testUserId,
      'Storage Test Key'
    );
    validApiKey = key;

    // Create test app
    const initRes = await app.inject({
      method: 'POST',
      url: '/init',
      headers: {
        'Authorization': `Bearer ${validApiKey}`,
      },
      payload: { name: `storage-test-${Date.now()}` },
    });
    appId = initRes.json().app_id;
  });

  afterEach(async () => {
    // Clean up nested test resources
    for (const nestedAppId of nestedResources.appIds) {
      try {
        await app.controlDb.query(
          'DELETE FROM storage_objects WHERE app_id = $1',
          [nestedAppId]
        );
        await app.controlDb.query(
          'DELETE FROM apps WHERE id = $1',
          [nestedAppId]
        );
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    for (const nestedUserId of nestedResources.userIds) {
      try {
        await app.controlDb.query(
          'DELETE FROM platform_users WHERE id = $1',
          [nestedUserId]
        );
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    nestedResources.appIds = [];
    nestedResources.userIds = [];
  });

  afterAll(async () => {
    // Clean up storage objects
    await app.controlDb.query(
      'DELETE FROM storage_objects WHERE app_id = $1',
      [appId]
    );
    // Clean up apps
    await app.controlDb.query(
      'DELETE FROM apps WHERE id = $1',
      [appId]
    );
    // Clean up users
    await app.controlDb.query(
      'DELETE FROM platform_users WHERE id = $1',
      [testUserId]
    );
    await app.close();
    delete process.env.AUTH_ENABLED;
  });

  describe('POST /storage/:appId/upload', () => {
    it('generates presigned upload URL successfully', async () => {
      const mockUploadUrl = 'https://s3.example.com/presigned-upload-url';
      const mockObjectKey = `${appId}/${testUserId}/uuid_test.txt`;

      vi.mocked(s3Service.generatePresignedUploadUrl).mockResolvedValueOnce({
        uploadUrl: mockUploadUrl,
        objectKey: mockObjectKey,
        expiresIn: 300,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'test.txt',
          contentType: 'text/plain',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.uploadUrl).toBe(mockUploadUrl);
      expect(body.objectKey).toBe(mockObjectKey);
      expect(body.expiresIn).toBe(UPLOAD_URL_EXPIRY_SECONDS);
    });

    it('rejects file exceeding size limit', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'large.bin',
          contentType: 'application/octet-stream',
          sizeBytes: LARGE_FILE_SIZE_BYTES,
        },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error).toBe('quota_exceeded');
      expect(body.reason).toContain('exceeds limit');
    });

    it('rejects invalid content types', async () => {
      // Create app with restricted content types
      const restrictedAppRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: { name: `storage-restricted-${Date.now()}` },
      });
      const restrictedAppId = restrictedAppRes.json().app_id;
      nestedResources.appIds.push(restrictedAppId);

      // Update app to only allow text files
      await app.controlDb.query(
        `UPDATE apps SET storage_config = $1 WHERE id = $2`,
        [JSON.stringify({ storageLimitBytes: STORAGE_LIMIT_BYTES, maxFileSizeMb: 10, allowedContentTypes: ['text/*'] }), restrictedAppId]
      );

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${restrictedAppId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'test.exe',
          contentType: 'application/x-msdownload',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error).toBe('quota_exceeded');
      expect(body.reason).toContain('not allowed');
    });

    it('accepts valid content types', async () => {
      const mockUploadUrl = 'https://s3.example.com/presigned-upload-url';
      const mockObjectKey = `${appId}/${testUserId}/uuid_test.json`;

      vi.mocked(s3Service.generatePresignedUploadUrl).mockResolvedValueOnce({
        uploadUrl: mockUploadUrl,
        objectKey: mockObjectKey,
        expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'data.json',
          contentType: 'application/json',
          sizeBytes: 2048,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.uploadUrl).toBe(mockUploadUrl);
    });

    it('returns 400 for invalid request body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: '', // Empty filename
          contentType: 'text/plain',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('validation_error');
    });

    it('returns 404 for non-existent app', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/storage/nonexistent-app/upload',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'test.txt',
          contentType: 'text/plain',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('App not found');
    });

    it('returns 503 when S3 service fails', async () => {
      vi.mocked(s3Service.generatePresignedUploadUrl).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('S3 service unavailable', 'SERVICE_UNAVAILABLE')
      );

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'test.txt',
          contentType: 'text/plain',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        payload: {
          filename: 'test.txt',
          contentType: 'text/plain',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /storage/:appId/objects', () => {
    beforeAll(async () => {
      // Insert test storage objects
      const insertRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [appId, config.s3.bucket, `${appId}/${testUserId}/uuid_file1.txt`, 'file1.txt', 'text/plain', 1024]
      );
      objectId = insertRes.rows[0].id;

      await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [appId, config.s3.bucket, `${appId}/${testUserId}/uuid_file2.txt`, 'file2.txt', 'text/plain', 2048]
      );
    });

    it('lists storage objects for app', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/objects`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.objects).toBeDefined();
      expect(Array.isArray(body.objects)).toBe(true);
      expect(body.objects.length).toBeGreaterThanOrEqual(2);
      expect(body.objects[0]).toHaveProperty('id');
      expect(body.objects[0]).toHaveProperty('key');
      expect(body.objects[0]).toHaveProperty('filename');
      expect(body.objects[0]).toHaveProperty('content_type');
      expect(body.objects[0]).toHaveProperty('size_bytes');
    });

    it('respects pagination limit', async () => {
      // Create another app for pagination testing
      const paginationAppRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: { name: `storage-pagination-${Date.now()}` },
      });
      const paginationAppId = paginationAppRes.json().app_id;
      nestedResources.appIds.push(paginationAppId);

      // Insert 101 objects to exceed pagination limit
      for (let i = 0; i < 101; i++) {
        await app.controlDb.query(
          `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [paginationAppId, config.s3.bucket, `${paginationAppId}/${testUserId}/file_${i}.txt`, `file_${i}.txt`, 'text/plain', 1024]
        );
      }

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${paginationAppId}/objects`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.objects.length).toBe(PAGINATION_LIMIT);
    });

    it('returns empty list for app with no objects', async () => {
      // Create another app
      const initRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: { name: `storage-test-empty-${Date.now()}` },
      });
      const emptyAppId = initRes.json().app_id;
      nestedResources.appIds.push(emptyAppId);

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${emptyAppId}/objects`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.objects).toEqual([]);
    });

    it('returns 404 for non-existent app', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/storage/nonexistent-app/objects',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('App not found');
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/objects`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /storage/:appId/download/:objectId', () => {
    it('generates presigned download URL successfully', async () => {
      const mockDownloadUrl = 'https://s3.example.com/presigned-download-url';

      vi.mocked(s3Service.generatePresignedDownloadUrl).mockResolvedValueOnce(
        mockDownloadUrl
      );

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${objectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.downloadUrl).toBe(mockDownloadUrl);
      expect(body.filename).toBe('file1.txt');
      expect(body.expiresIn).toBe(DOWNLOAD_URL_EXPIRY_SECONDS);
    });

    it('returns 404 for non-existent object', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/00000000-0000-0000-0000-000000000000`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Object not found');
    });

    it('returns 404 for object in different app', async () => {
      // Create another app and user
      const userResult = await app.controlDb.query(
        `INSERT INTO platform_users (email, cognito_sub)
         VALUES ($1, $2)
         RETURNING id`,
        [`storage-test-2-${Date.now()}@example.com`, `storage-test-sub-2-${Date.now()}`]
      );
      const otherUserId = userResult.rows[0].id;
      nestedResources.userIds.push(otherUserId);

      const { key: otherKey } = await ApiKeyService.generateApiKey(
        app.controlDb,
        otherUserId,
        'Other User Key'
      );

      const initRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${otherKey}`,
        },
        payload: { name: `storage-test-other-${Date.now()}` },
      });
      const otherAppId = initRes.json().app_id;
      nestedResources.appIds.push(otherAppId);

      // Try to access object from first app using second user's key
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${otherAppId}/download/${objectId}`,
        headers: {
          'Authorization': `Bearer ${otherKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when S3 service fails', async () => {
      vi.mocked(s3Service.generatePresignedDownloadUrl).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('S3 service unavailable', 'SERVICE_UNAVAILABLE')
      );

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${objectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');
    });

    it('handles S3 access denied error', async () => {
      vi.mocked(s3Service.generatePresignedDownloadUrl).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('Access denied', 'AccessDenied')
      );

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${objectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');
      expect(body.code).toBe('AccessDenied');
    });

    it('handles S3 not found error', async () => {
      vi.mocked(s3Service.generatePresignedDownloadUrl).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('Object not found in S3', 'NoSuchKey')
      );

      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${objectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');
      expect(body.code).toBe('NoSuchKey');
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${objectId}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('DELETE /storage/:appId/:objectId', () => {
    let deleteTestObjectId: string;

    beforeAll(async () => {
      // Insert test object for deletion
      const insertRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [appId, config.s3.bucket, `${appId}/${testUserId}/uuid_delete_test.txt`, 'delete_test.txt', 'text/plain', 512]
      );
      deleteTestObjectId = insertRes.rows[0].id;
    });

    it('deletes storage object successfully', async () => {
      vi.mocked(s3Service.deleteObject).mockResolvedValueOnce(undefined);

      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${deleteTestObjectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(204);

      // Verify object is deleted from database
      const checkRes = await app.controlDb.query(
        'SELECT id FROM storage_objects WHERE id = $1',
        [deleteTestObjectId]
      );
      expect(checkRes.rows.length).toBe(0);
    });

    it('returns 404 for non-existent object', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/00000000-0000-0000-0000-000000000000`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Object not found');
    });

    it('returns 404 for object in different app', async () => {
      // Create another app and user
      const userResult = await app.controlDb.query(
        `INSERT INTO platform_users (email, cognito_sub)
         VALUES ($1, $2)
         RETURNING id`,
        [`storage-test-3-${Date.now()}@example.com`, `storage-test-sub-3-${Date.now()}`]
      );
      const otherUserId = userResult.rows[0].id;
      nestedResources.userIds.push(otherUserId);

      const { key: otherKey } = await ApiKeyService.generateApiKey(
        app.controlDb,
        otherUserId,
        'Other User Key 2'
      );

      const initRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${otherKey}`,
        },
        payload: { name: `storage-test-other-2-${Date.now()}` },
      });
      const otherAppId = initRes.json().app_id;
      nestedResources.appIds.push(otherAppId);

      // Try to delete object from first app using second user's key
      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${otherAppId}/${objectId}`,
        headers: {
          'Authorization': `Bearer ${otherKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when S3 deletion fails', async () => {
      // Insert another test object
      const insertRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [appId, config.s3.bucket, `${appId}/${testUserId}/uuid_s3_fail.txt`, 's3_fail.txt', 'text/plain', 256]
      );
      const failTestObjectId = insertRes.rows[0].id;

      vi.mocked(s3Service.deleteObject).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('S3 service unavailable', 'SERVICE_UNAVAILABLE')
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${failTestObjectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');

      // Verify object still exists in database
      const checkRes = await app.controlDb.query(
        'SELECT id FROM storage_objects WHERE id = $1',
        [failTestObjectId]
      );
      expect(checkRes.rows.length).toBe(1);

      // Clean up
      await app.controlDb.query(
        'DELETE FROM storage_objects WHERE id = $1',
        [failTestObjectId]
      );
    });

    it('handles S3 access denied error on delete', async () => {
      // Insert test object
      const insertRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [appId, config.s3.bucket, `${appId}/${testUserId}/uuid_access_denied.txt`, 'access_denied.txt', 'text/plain', 256]
      );
      const accessDeniedObjectId = insertRes.rows[0].id;

      vi.mocked(s3Service.deleteObject).mockRejectedValueOnce(
        new (s3Service.S3Error as any)('Access denied', 'AccessDenied')
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${accessDeniedObjectId}`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
      });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.error).toBe('s3_error');
      expect(body.code).toBe('AccessDenied');

      // Clean up
      await app.controlDb.query(
        'DELETE FROM storage_objects WHERE id = $1',
        [accessDeniedObjectId]
      );
    });

    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${objectId}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('Storage Quota Service', () => {
    it('enforces total storage quota', async () => {
      // Create app with small quota
      const quotaAppRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: { name: `storage-quota-${Date.now()}` },
      });
      const quotaAppId = quotaAppRes.json().app_id;
      nestedResources.appIds.push(quotaAppId);

      // Update app with small storage limit
      await app.controlDb.query(
        `UPDATE apps SET storage_config = $1 WHERE id = $2`,
        [JSON.stringify({ storageLimitBytes: 5000, maxFileSizeMb: 10, allowedContentTypes: ['*/*'] }), quotaAppId]
      );

      // Insert object that uses most of quota
      await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [quotaAppId, config.s3.bucket, `${quotaAppId}/${testUserId}/large_file.bin`, 'large_file.bin', 'application/octet-stream', 4000]
      );

      // Try to upload file that exceeds quota
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${quotaAppId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'another.bin',
          contentType: 'application/octet-stream',
          sizeBytes: 2000,
        },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error).toBe('quota_exceeded');
      expect(body.currentUsageBytes).toBe(4000);
      expect(body.limitBytes).toBe(5000);
    });

    it('allows upload within quota', async () => {
      const mockUploadUrl = 'https://s3.example.com/presigned-upload-url';
      const mockObjectKey = `${appId}/${testUserId}/uuid_within_quota.txt`;

      vi.mocked(s3Service.generatePresignedUploadUrl).mockResolvedValueOnce({
        uploadUrl: mockUploadUrl,
        objectKey: mockObjectKey,
        expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'small.txt',
          contentType: 'text/plain',
          sizeBytes: 512,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.uploadUrl).toBe(mockUploadUrl);
    });

    it('rejects files with disallowed content types', async () => {
      // Create app with restricted content types
      const restrictedAppRes = await app.inject({
        method: 'POST',
        url: '/init',
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: { name: `storage-restricted-${Date.now()}` },
      });
      const restrictedAppId = restrictedAppRes.json().app_id;
      nestedResources.appIds.push(restrictedAppId);

      // Update app to only allow text files
      await app.controlDb.query(
        `UPDATE apps SET storage_config = $1 WHERE id = $2`,
        [JSON.stringify({ storageLimitBytes: STORAGE_LIMIT_BYTES, maxFileSizeMb: 10, allowedContentTypes: ['text/*'] }), restrictedAppId]
      );

      // Try to upload binary file
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${restrictedAppId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'image.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error).toBe('quota_exceeded');
      expect(body.reason).toContain('not allowed');
    });

    it('allows wildcard content type matching', async () => {
      const mockUploadUrl = 'https://s3.example.com/presigned-upload-url';
      const mockObjectKey = `${appId}/${testUserId}/uuid_wildcard.json`;

      vi.mocked(s3Service.generatePresignedUploadUrl).mockResolvedValueOnce({
        uploadUrl: mockUploadUrl,
        objectKey: mockObjectKey,
        expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'data.json',
          contentType: 'application/json',
          sizeBytes: 1024,
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('handles StorageQuotaError in upload route', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/storage/${appId}/upload`,
        headers: {
          'Authorization': `Bearer ${validApiKey}`,
        },
        payload: {
          filename: 'test.txt',
          contentType: 'text/plain',
          sizeBytes: 0, // Invalid size
        },
      });

      // Should fail validation before reaching quota check
      expect(res.statusCode).toBe(400);
    });
  });

  describe('publicReadEnabled behavior', () => {
    let otherUserId: string;
    let userAObjectId: string;
    let publicObjectId: string;

    /**
     * Creates a fake end-user JWT that the auth plugin will recognize as
     * an end-user token (issuer starts with 'butterbase:app:').
     * Actual verification is mocked via vi.mock('../services/end-user-auth.js').
     */
    function fakeEndUserJwt(forAppId: string, sub: string): string {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: `butterbase:app:${forAppId}`,
        sub,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      })).toString('base64url');
      const signature = 'fake-signature';
      return `${header}.${payload}.${signature}`;
    }

    function mockEndUserClaims(userId: string) {
      vi.mocked(endUserAuth.verifyEndUserJwt).mockResolvedValueOnce({
        sub: userId,
        iss: `butterbase:app:${appId}`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      } as any);
    }

    beforeAll(async () => {
      // Create an app user to own storage objects ("User A" — the uploader)
      const appUserRes = await app.controlDb.query(
        `INSERT INTO app_users (app_id, provider, provider_user_id, email)
         VALUES ($1, 'test', 'provider-a', 'user-a@example.com')
         RETURNING id`,
        [appId]
      );
      const userAId = appUserRes.rows[0].id;

      // Create another app user ("User B" — the viewer)
      const otherUserRes = await app.controlDb.query(
        `INSERT INTO app_users (app_id, provider, provider_user_id, email)
         VALUES ($1, 'test', 'provider-b', 'user-b@example.com')
         RETURNING id`,
        [appId]
      );
      otherUserId = otherUserRes.rows[0].id;

      // Insert a storage object owned by User A (private)
      const objRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes, user_id, public)
         VALUES ($1, 'default', $2, 'photo.jpg', 'image/jpeg', 1024, $3, false)
         RETURNING id`,
        [appId, `${appId}/${userAId}/photo.jpg`, userAId]
      );
      userAObjectId = objRes.rows[0].id;

      // Insert a public storage object owned by User A
      const pubObjRes = await app.controlDb.query(
        `INSERT INTO storage_objects (app_id, bucket, key, filename, content_type, size_bytes, user_id, public)
         VALUES ($1, 'default', $2, 'avatar.jpg', 'image/jpeg', 512, $3, true)
         RETURNING id`,
        [appId, `${appId}/${userAId}/avatar.jpg`, userAId]
      );
      publicObjectId = pubObjRes.rows[0].id;
    });

    afterAll(async () => {
      await app.controlDb.query(
        `DELETE FROM storage_objects WHERE id = ANY($1::uuid[])`,
        [[userAObjectId, publicObjectId]]
      );
      await app.controlDb.query(
        `DELETE FROM app_users WHERE app_id = $1 AND provider = 'test'`,
        [appId]
      );
    });

    afterEach(async () => {
      // Always reset publicReadEnabled to false to prevent state leaks on test failure
      await app.controlDb.query(
        `UPDATE apps SET storage_config = jsonb_set(
          COALESCE(storage_config, '{}')::jsonb,
          '{publicReadEnabled}', 'false'
        ) WHERE id = $1`,
        [appId]
      );
    });

    it('end-user cannot download another user\'s object by default', async () => {
      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${userAObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('end-user CAN download another user\'s object when publicReadEnabled is true', async () => {
      // Enable publicReadEnabled on the app
      await app.controlDb.query(
        `UPDATE apps SET storage_config = jsonb_set(
          COALESCE(storage_config, '{}')::jsonb,
          '{publicReadEnabled}', 'true'
        ) WHERE id = $1`,
        [appId]
      );

      const mockDownloadUrl = 'https://s3.example.com/presigned-public-read';
      vi.mocked(s3Service.generatePresignedDownloadUrl).mockResolvedValueOnce(mockDownloadUrl);

      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${userAObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.downloadUrl).toBe(mockDownloadUrl);
      expect(body.filename).toBe('photo.jpg');
    });

    it('publicReadEnabled does NOT allow end-user to delete another user\'s object', async () => {
      // Enable publicReadEnabled on the app
      await app.controlDb.query(
        `UPDATE apps SET storage_config = jsonb_set(
          COALESCE(storage_config, '{}')::jsonb,
          '{publicReadEnabled}', 'true'
        ) WHERE id = $1`,
        [appId]
      );

      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${userAObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      // Delete should still enforce user isolation
      expect(res.statusCode).toBe(404);

      // Verify the object still exists
      const checkRes = await app.controlDb.query(
        'SELECT id FROM storage_objects WHERE id = $1',
        [userAObjectId]
      );
      expect(checkRes.rows.length).toBe(1);
    });

    it('end-user CAN download another user\'s object when object.public is true', async () => {
      // publicReadEnabled is false (reset by afterEach), but the object itself is public
      const mockDownloadUrl = 'https://s3.example.com/presigned-public-object';
      vi.mocked(s3Service.generatePresignedDownloadUrl).mockResolvedValueOnce(mockDownloadUrl);

      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${publicObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.downloadUrl).toBe(mockDownloadUrl);
      expect(body.filename).toBe('avatar.jpg');
    });

    it('end-user cannot download another user\'s private object (both flags false)', async () => {
      // publicReadEnabled is false, object.public is false
      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'GET',
        url: `/storage/${appId}/download/${userAObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it('object.public does NOT allow end-user to delete the object', async () => {
      mockEndUserClaims(otherUserId);

      const token = fakeEndUserJwt(appId, otherUserId);
      const res = await app.inject({
        method: 'DELETE',
        url: `/storage/${appId}/${publicObjectId}`,
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      // Delete should still enforce user isolation even for public objects
      expect(res.statusCode).toBe(404);

      // Verify the object still exists
      const checkRes = await app.controlDb.query(
        'SELECT id FROM storage_objects WHERE id = $1',
        [publicObjectId]
      );
      expect(checkRes.rows.length).toBe(1);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor.js';

const row = { created_at: '2026-11-03T13:19:07.363Z', id: '15192533-11bd-46a0-9757-4930247767f7' };

describe('audit cursor codec', () => {
  it('round-trips a timestamp and id', () => {
    expect(decodeAuditCursor(encodeAuditCursor(row))).toEqual({ createdAt: row.created_at, id: row.id });
  });

  it('rejects a value that is not a cursor', () => {
    expect(decodeAuditCursor('not-a-cursor')).toBeNull();
  });

  it('rejects an unsupported version', () => {
    const value = Buffer.from(JSON.stringify({ v: 2, at: row.created_at, id: row.id })).toString('base64url');
    expect(decodeAuditCursor(value)).toBeNull();
  });

  it('rejects a non-uuid id', () => {
    const value = Buffer.from(JSON.stringify({ v: 1, at: row.created_at, id: '../../etc' })).toString('base64url');
    expect(decodeAuditCursor(value)).toBeNull();
  });

  it('rejects a non-iso timestamp', () => {
    const value = Buffer.from(JSON.stringify({ v: 1, at: 'yesterday', id: row.id })).toString('base64url');
    expect(decodeAuditCursor(value)).toBeNull();
  });
});

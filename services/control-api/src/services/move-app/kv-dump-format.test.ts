import { describe, it, expect } from 'vitest';
import {
  KvDumpRecord,
  serializeRecord,
  parseRecord,
  payloadFromBuffer,
  payloadToBuffer,
} from './kv-dump-format.js';

describe('kv-dump-format', () => {
  describe('round-trip with binary payload', () => {
    it('serializes and parses a record with binary payload', () => {
      const originalBuffer = Buffer.from([0, 1, 2, 254, 255]);
      const record: KvDumpRecord = {
        db: 0,
        key: 'app_123:session:abc',
        ttl_ms: 3600000,
        payload_b64: payloadFromBuffer(originalBuffer),
      };

      // Serialize
      const line = serializeRecord(record);
      expect(typeof line).toBe('string');

      // Parse
      const parsed = parseRecord(line);
      expect(parsed).toEqual(record);

      // Verify binary payload round-trip
      const restoredBuffer = payloadToBuffer(parsed.payload_b64);
      expect(restoredBuffer.equals(originalBuffer)).toBe(true);
    });
  });

  describe('malformed record rejection', () => {
    it('throws on invalid JSON', () => {
      expect(() => parseRecord('not json')).toThrow();
    });

    it('throws on bad db value', () => {
      expect(() => parseRecord('{"db":2,"key":"a","ttl_ms":0,"payload_b64":""}')).toThrow(
        /bad db/
      );
    });

    it('throws on bad key type', () => {
      expect(() => parseRecord('{"db":0,"key":1,"ttl_ms":0,"payload_b64":""}')).toThrow(/bad key/);
    });

    it('throws on non-object input', () => {
      expect(() => parseRecord('null')).toThrow(/bad record/);
      expect(() => parseRecord('[]')).toThrow(/bad record/);
    });

    it('throws on missing ttl_ms', () => {
      expect(() => parseRecord('{"db":0,"key":"a","payload_b64":""}')).toThrow(/bad ttl_ms/);
    });

    it('throws on bad ttl_ms type', () => {
      expect(() => parseRecord('{"db":0,"key":"a","ttl_ms":"100","payload_b64":""}')).toThrow(
        /bad ttl_ms/
      );
    });

    it('throws on missing payload_b64', () => {
      expect(() => parseRecord('{"db":0,"key":"a","ttl_ms":0}')).toThrow(/bad payload_b64/);
    });

    it('throws on bad payload_b64 type', () => {
      expect(() => parseRecord('{"db":0,"key":"a","ttl_ms":0,"payload_b64":123}')).toThrow(
        /bad payload_b64/
      );
    });
  });

  describe('ttl_ms handling', () => {
    it('handles ttl_ms=-1 (no expiry) round-trip', () => {
      const record: KvDumpRecord = {
        db: 1,
        key: 'app_456:config:main',
        ttl_ms: -1,
        payload_b64: 'dGVzdA==',
      };

      const line = serializeRecord(record);
      const parsed = parseRecord(line);
      expect(parsed).toEqual(record);
      expect(parsed.ttl_ms).toBe(-1);
    });

    it('handles positive ttl_ms', () => {
      const record: KvDumpRecord = {
        db: 0,
        key: 'app_789:cache:key',
        ttl_ms: 1000,
        payload_b64: 'dGVzdA==',
      };

      const line = serializeRecord(record);
      const parsed = parseRecord(line);
      expect(parsed.ttl_ms).toBe(1000);
    });

    it('handles ttl_ms=0', () => {
      const record: KvDumpRecord = {
        db: 0,
        key: 'app_000:temp:data',
        ttl_ms: 0,
        payload_b64: 'dGVzdA==',
      };

      const line = serializeRecord(record);
      const parsed = parseRecord(line);
      expect(parsed.ttl_ms).toBe(0);
    });
  });

  describe('buffer conversion', () => {
    it('converts buffer to base64 and back', () => {
      const originalBuffer = Buffer.from('hello world');
      const b64 = payloadFromBuffer(originalBuffer);
      const restored = payloadToBuffer(b64);
      expect(restored.equals(originalBuffer)).toBe(true);
    });

    it('handles empty buffer', () => {
      const originalBuffer = Buffer.from([]);
      const b64 = payloadFromBuffer(originalBuffer);
      const restored = payloadToBuffer(b64);
      expect(restored.equals(originalBuffer)).toBe(true);
    });

    it('handles large binary data', () => {
      const originalBuffer = Buffer.from(Array.from({ length: 10000 }, (_, i) => i % 256));
      const b64 = payloadFromBuffer(originalBuffer);
      const restored = payloadToBuffer(b64);
      expect(restored.equals(originalBuffer)).toBe(true);
    });
  });

  describe('db field validation', () => {
    it('accepts db=0', () => {
      const record: KvDumpRecord = {
        db: 0,
        key: 'test',
        ttl_ms: 0,
        payload_b64: '',
      };
      const line = serializeRecord(record);
      const parsed = parseRecord(line);
      expect(parsed.db).toBe(0);
    });

    it('accepts db=1', () => {
      const record: KvDumpRecord = {
        db: 1,
        key: 'test',
        ttl_ms: 0,
        payload_b64: '',
      };
      const line = serializeRecord(record);
      const parsed = parseRecord(line);
      expect(parsed.db).toBe(1);
    });

    it('rejects db=-1', () => {
      expect(() => parseRecord('{"db":-1,"key":"a","ttl_ms":0,"payload_b64":""}')).toThrow(
        /bad db/
      );
    });

    it('rejects db=3', () => {
      expect(() => parseRecord('{"db":3,"key":"a","ttl_ms":0,"payload_b64":""}')).toThrow(
        /bad db/
      );
    });
  });
});

export interface KvDumpRecord {
  db: 0 | 1;
  key: string;
  ttl_ms: number;       // -1 means no expiry; never serialize -2
  payload_b64: string;  // base64 of the DUMP-format binary blob
}

export function serializeRecord(rec: KvDumpRecord): string {
  return JSON.stringify(rec);
}

export function parseRecord(line: string): KvDumpRecord {
  const obj = JSON.parse(line);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('bad record');
  if (obj.db !== 0 && obj.db !== 1) throw new Error(`bad db: ${obj.db}`);
  if (typeof obj.key !== 'string') throw new Error('bad key');
  if (typeof obj.ttl_ms !== 'number') throw new Error('bad ttl_ms');
  if (typeof obj.payload_b64 !== 'string') throw new Error('bad payload_b64');
  return obj as KvDumpRecord;
}

export function payloadFromBuffer(buf: Buffer): string {
  return buf.toString('base64');
}

export function payloadToBuffer(b64: string): Buffer {
  return Buffer.from(b64, 'base64');
}

// services/control-api/src/services/rag-worker-paused.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The claim SQL is the contract: a structural test, plus the live check in Step 4.
const src = readFileSync(fileURLToPath(new URL('./rag-worker.ts', import.meta.url)), 'utf8');

describe('rag-worker claim', () => {
  it('skips jobs whose app is paused, inside the SKIP LOCKED subquery', () => {
    const claim = /WHERE id = \(([^]*?)FOR UPDATE SKIP LOCKED/.exec(src)?.[1] ?? '';
    expect(claim).toMatch(/NOT EXISTS \(SELECT 1 FROM apps a WHERE a\.id = rag_ingestion_queue\.app_id AND a\.paused\)/);
  });
});

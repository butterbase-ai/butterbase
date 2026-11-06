import type pg from 'pg';
import { mintOrganizationLockedApiKeyInTransaction } from '../api-key-service.js';
import { assertOperatorCredentialKeyReady, setOperatorCredential } from './operator-credential.js';
import { upsertOperatorSweepInTransaction } from './operator-store.js';

export async function provisionOperatorInTransaction(
  client: pg.PoolClient,
  input: {
    organizationId: string;
    userId: string;
    instructions: string;
    intervalSeconds: number;
    now: Date;
  },
): Promise<{ keyId: string }> {
  assertOperatorCredentialKeyReady();
  const { keyId } = await mintOrganizationLockedApiKeyInTransaction(client, {
    userId: input.userId,
    organizationId: input.organizationId,
    name: 'Office operator',
  }, (key) => setOperatorCredential(client, input.organizationId, key));
  await upsertOperatorSweepInTransaction(
    client, input.organizationId, input.instructions, input.intervalSeconds, input.now,
  );
  return { keyId };
}

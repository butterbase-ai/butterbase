import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { controlDb, setupTestDb, seedUser } from '../../__tests__/test-helpers/control-db.js';
import { recordPlatformUserLogin, recordPlatformUserAction } from '../activity-service.js';

describe('activity-service', () => {
  beforeEach(setupTestDb);

  it("recordPlatformUserLogin sets both timestamps and creates today's daily row", async () => {
    const user = await seedUser('login-test@x.com');
    await recordPlatformUserLogin(controlDb, user.id);

    const { rows: userRows } = await controlDb.query<{
      last_login_at: Date | null;
      last_activity_at: Date | null;
    }>(
      `SELECT last_login_at, last_activity_at FROM platform_users WHERE id = $1`,
      [user.id],
    );
    expect(userRows.length).toBe(1);
    const { last_login_at, last_activity_at } = userRows[0]!;
    expect(last_login_at).not.toBeNull();
    expect(last_activity_at).not.toBeNull();
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    expect(last_login_at!.getTime()).toBeGreaterThan(fiveSecondsAgo.getTime());
    expect(last_activity_at!.getTime()).toBeGreaterThan(fiveSecondsAgo.getTime());

    const { rows: dailyRows } = await controlDb.query<{ action_count: number }>(
      `SELECT action_count FROM platform_user_activity_daily
       WHERE user_id = $1 AND day = CURRENT_DATE`,
      [user.id],
    );
    expect(dailyRows.length).toBe(1);
    expect(dailyRows[0]!.action_count).toBe(1);
  });

  it('recordPlatformUserAction increments count and updates only last_activity_at', async () => {
    const user = await seedUser('action-test@x.com');
    await recordPlatformUserAction(controlDb, user.id);
    await recordPlatformUserAction(controlDb, user.id);

    const { rows: dailyRows } = await controlDb.query<{ action_count: number }>(
      `SELECT action_count FROM platform_user_activity_daily
       WHERE user_id = $1 AND day = CURRENT_DATE`,
      [user.id],
    );
    expect(dailyRows.length).toBe(1);
    expect(dailyRows[0]!.action_count).toBe(2);

    const { rows: userRows } = await controlDb.query<{
      last_login_at: Date | null;
      last_activity_at: Date | null;
    }>(
      `SELECT last_login_at, last_activity_at FROM platform_users WHERE id = $1`,
      [user.id],
    );
    expect(userRows[0]!.last_login_at).toBeNull();
    expect(userRows[0]!.last_activity_at).not.toBeNull();
  });

  it('recordPlatformUserAction is a silent no-op when the user does not exist', async () => {
    const nonExistentId = randomUUID();
    await expect(recordPlatformUserAction(controlDb, nonExistentId)).resolves.toBeUndefined();

    const { rows } = await controlDb.query(
      `SELECT 1 FROM platform_user_activity_daily WHERE user_id = $1`,
      [nonExistentId],
    );
    expect(rows.length).toBe(0);
  });

  it('recordPlatformUserLogin twice in one day yields action_count = 2', async () => {
    const user = await seedUser('double-login@x.com');
    await recordPlatformUserLogin(controlDb, user.id);
    await recordPlatformUserLogin(controlDb, user.id);

    const { rows } = await controlDb.query<{ action_count: number }>(
      `SELECT action_count FROM platform_user_activity_daily
       WHERE user_id = $1 AND day = CURRENT_DATE`,
      [user.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_count).toBe(2);
  });
});

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { controlDb, runtimeDb, setupTestDb, seedUser } from '../../__tests__/test-helpers/control-db.js';
import { recordPlatformUserLogin, recordPlatformUserAction, recordAppUserAction } from '../activity-service.js';
import { logAuditEvent } from '../audit/audit-events-service.js';

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

  it('logAuditEvent records platform-user action on successful insert', async () => {
    const user = await seedUser('audit-hook@x.com');
    await logAuditEvent(controlDb, {
      appId: randomUUID(),
      category: 'admin',
      eventType: 'test.hook',
      actorType: 'platform_user',
      actorId: user.id,
      success: true,
    });

    const { rows: dailyRows } = await controlDb.query<{ action_count: number }>(
      `SELECT action_count FROM platform_user_activity_daily
       WHERE user_id = $1 AND day = CURRENT_DATE`,
      [user.id],
    );
    expect(dailyRows.length).toBe(1);
    expect(dailyRows[0]!.action_count).toBe(1);

    const { rows: userRows } = await controlDb.query<{ last_activity_at: Date | null }>(
      `SELECT last_activity_at FROM platform_users WHERE id = $1`,
      [user.id],
    );
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    expect(userRows[0]!.last_activity_at).not.toBeNull();
    expect(userRows[0]!.last_activity_at!.getTime()).toBeGreaterThan(fiveSecondsAgo.getTime());
  });

  it('logAuditEvent does NOT record activity when actor is not a platform_user', async () => {
    const user = await seedUser('non-platform-actor@x.com');
    await logAuditEvent(controlDb, {
      appId: randomUUID(),
      category: 'admin',
      eventType: 'test.system',
      actorType: 'system',
      actorId: null,
      success: true,
    });

    const { rows } = await controlDb.query(
      `SELECT 1 FROM platform_user_activity_daily WHERE user_id = $1`,
      [user.id],
    );
    expect(rows.length).toBe(0);
  });
});

describe('recordAppUserAction', () => {
  afterAll(async () => {
    await runtimeDb.query(
      "DELETE FROM app_user_activity_daily WHERE app_id LIKE 'test-activity-%' OR app_id LIKE 'test-hook-%'",
    );
    await runtimeDb.query(
      "DELETE FROM app_users WHERE app_id LIKE 'test-activity-%' OR app_id LIKE 'test-hook-%'",
    );
    await runtimeDb.query(
      "DELETE FROM apps WHERE id LIKE 'test-activity-%' OR id LIKE 'test-hook-%'",
    );
  });

  it("sets last_activity_at and creates today's daily row", async () => {
    const appId = `test-activity-${randomUUID()}`;
    const appUserId = randomUUID();
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
      [appId, randomUUID()],
    );
    await runtimeDb.query(
      `INSERT INTO app_users (id, app_id, email) VALUES ($1, $2, $3)`,
      [appUserId, appId, `user-${appUserId}@test.invalid`],
    );

    await recordAppUserAction(runtimeDb, appUserId);

    const { rows: userRows } = await runtimeDb.query<{ last_activity_at: Date | null }>(
      `SELECT last_activity_at FROM app_users WHERE id = $1`,
      [appUserId],
    );
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.last_activity_at).not.toBeNull();
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    expect(userRows[0]!.last_activity_at!.getTime()).toBeGreaterThan(fiveSecondsAgo.getTime());

    const { rows: dailyRows } = await runtimeDb.query<{ action_count: number }>(
      `SELECT action_count FROM app_user_activity_daily WHERE app_user_id = $1 AND day = CURRENT_DATE`,
      [appUserId],
    );
    expect(dailyRows.length).toBe(1);
    expect(dailyRows[0]!.action_count).toBe(1);
  });

  it('two calls increment action_count to 2 in one day', async () => {
    const appId = `test-activity-${randomUUID()}`;
    const appUserId = randomUUID();
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
      [appId, randomUUID()],
    );
    await runtimeDb.query(
      `INSERT INTO app_users (id, app_id, email) VALUES ($1, $2, $3)`,
      [appUserId, appId, `user-${appUserId}@test.invalid`],
    );

    await recordAppUserAction(runtimeDb, appUserId);
    await recordAppUserAction(runtimeDb, appUserId);

    const { rows } = await runtimeDb.query<{ action_count: number }>(
      `SELECT action_count FROM app_user_activity_daily WHERE app_user_id = $1 AND day = CURRENT_DATE`,
      [appUserId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.action_count).toBe(2);
  });

  it('is a silent no-op for a missing app_user — no log, no daily row', async () => {
    const nonExistentId = randomUUID();
    const consoleSpy = vi.spyOn(console, 'error');

    await expect(recordAppUserAction(runtimeDb, nonExistentId)).resolves.toBeUndefined();

    const { rows } = await runtimeDb.query(
      `SELECT 1 FROM app_user_activity_daily WHERE app_user_id = $1`,
      [nonExistentId],
    );
    expect(rows.length).toBe(0);
    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('logAuditEvent records app-user action on successful insert', async () => {
    const appId = `test-hook-${randomUUID()}`;
    const appUserId = randomUUID();
    await runtimeDb.query(
      `INSERT INTO apps (id, name, owner_id, db_name) VALUES ($1, $1, $2, $1)`,
      [appId, randomUUID()],
    );
    await runtimeDb.query(
      `INSERT INTO app_users (id, app_id, email) VALUES ($1, $2, $3)`,
      [appUserId, appId, `user-${appUserId}@test.invalid`],
    );

    await logAuditEvent(runtimeDb, {
      appId,
      category: 'auth',
      eventType: 'login',
      actorType: 'app_user',
      actorId: appUserId,
      success: true,
    });

    // logAuditEvent fires recordAppUserAction as void (fire-and-forget); wait a tick
    await new Promise((r) => setTimeout(r, 50));

    const { rows: dailyRows } = await runtimeDb.query<{ action_count: number }>(
      `SELECT action_count FROM app_user_activity_daily WHERE app_user_id = $1 AND day = CURRENT_DATE`,
      [appUserId],
    );
    expect(dailyRows.length).toBe(1);
    expect(dailyRows[0]!.action_count).toBe(1);

    const { rows: userRows } = await runtimeDb.query<{ last_activity_at: Date | null }>(
      `SELECT last_activity_at FROM app_users WHERE id = $1`,
      [appUserId],
    );
    const fiveSecondsAgo = new Date(Date.now() - 5000);
    expect(userRows[0]!.last_activity_at).not.toBeNull();
    expect(userRows[0]!.last_activity_at!.getTime()).toBeGreaterThan(fiveSecondsAgo.getTime());
  });
});

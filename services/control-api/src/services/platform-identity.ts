import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { UserClaims } from './auth-provider.js';

export interface PlatformIdentity {
  userId: string;
  personalOrgId: string;
  isNewUser: boolean;
}

function personalOrgName(email: string): string {
  const at = email.indexOf('@');
  return at <= 0 || at === email.length - 1 ? `${email}'s org` : `${email.slice(0, at)}'s org`;
}

/** Resolve verified claims freshly; callers still perform current access checks. */
export async function resolvePlatformIdentity(
  pool: pg.Pool,
  claims: UserClaims,
  attribution: { signupSource: string | null; signupReferrer: string | null },
): Promise<PlatformIdentity> {
  const { rows: [existing] } = await pool.query<{
    id: string; personal_organization_id: string | null; email: string; email_verified: boolean | null;
  }>(`SELECT id,personal_organization_id,email,email_verified
      FROM platform_users WHERE cognito_sub=$1`, [claims.sub]);
  if (existing?.personal_organization_id) {
    if (existing.email !== claims.email || existing.email_verified !== claims.email_verified) {
      // The SQL predicate also avoids redundant updates when requests converge.
      await pool.query(`UPDATE platform_users SET email=$2,email_verified=$3,updated_at=now()
        WHERE id=$1 AND (email IS DISTINCT FROM $2 OR email_verified IS DISTINCT FROM $3)`,
      [existing.id, claims.email, claims.email_verified]);
    }
    return { userId: existing.id, personalOrgId: existing.personal_organization_id, isNewUser: false };
  }

  // First touch, or a legacy identity without a personal organization. Only this
  // uncommon path allocates a candidate organization and needs a transaction.
  let candidateUserId: string = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (existing) {
      const locked = (await client.query<{ id: string; personal_organization_id: string | null }>(
        'SELECT id,personal_organization_id FROM platform_users WHERE id=$1 FOR UPDATE', [existing.id],
      )).rows[0];
      if (locked) {
        candidateUserId = locked.id;
        const ownedOrg = locked.personal_organization_id ?? (await client.query<{ id: string }>(
          'SELECT id FROM organizations WHERE owner_id=$1 AND personal=true', [locked.id],
        )).rows[0]?.id;
        if (ownedOrg) {
          await client.query(`UPDATE platform_users SET personal_organization_id=$2,email=$3,email_verified=$4,updated_at=now()
            WHERE id=$1 AND (personal_organization_id IS DISTINCT FROM $2 OR email IS DISTINCT FROM $3 OR email_verified IS DISTINCT FROM $4)`,
          [locked.id, ownedOrg, claims.email, claims.email_verified]);
          await client.query('COMMIT');
          // Reattaching an existing org does not grant or repair its membership.
          return { userId: locked.id, personalOrgId: ownedOrg, isNewUser: false };
        }
      }
    }
    const org = (await client.query<{ id: string }>(`INSERT INTO organizations
      (owner_id,name,personal,plan_id,account_status)
      VALUES ($1,$2,true,'playground','active') RETURNING id`, [candidateUserId, personalOrgName(claims.email)])).rows[0];
    const user = (await client.query<{ id: string; personal_organization_id: string; is_new_signup: boolean }>(
      `INSERT INTO platform_users (id,cognito_sub,email,email_verified,signup_source,signup_referrer,personal_organization_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (cognito_sub)
       DO UPDATE SET email=EXCLUDED.email,email_verified=EXCLUDED.email_verified,updated_at=now(),
         personal_organization_id=COALESCE(platform_users.personal_organization_id,EXCLUDED.personal_organization_id)
       RETURNING id,personal_organization_id,(xmax=0) AS is_new_signup`,
      [candidateUserId, claims.sub, claims.email, claims.email_verified,
        attribution.signupSource, attribution.signupReferrer, org.id])).rows[0];
    if (user.personal_organization_id === org.id) {
      if (user.id !== candidateUserId) await client.query('UPDATE organizations SET owner_id=$2 WHERE id=$1', [org.id, user.id]);
      await client.query(`INSERT INTO organization_members (organization_id,user_id,role)
        VALUES ($1,$2,'owner') ON CONFLICT (organization_id,user_id) DO NOTHING`, [org.id, user.id]);
    } else {
      await client.query('DELETE FROM organizations WHERE id=$1', [org.id]);
    }
    await client.query('COMMIT');
    return { userId: user.id, personalOrgId: user.personal_organization_id, isNewUser: user.is_new_signup };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

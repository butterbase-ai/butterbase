import type pg from 'pg';
import { resolveAssistantModel } from './assistant-model.js';

type Scope = { userId: string; organizationId?: string };
type Db = Pick<pg.Pool, 'query'>;
const forbidden = () => Object.assign(new Error('You do not have permission to change or view this model setting.'), { statusCode: 403 });

export async function readModelPreference(db: Db, scope: Scope): Promise<string | null> {
  const { rows } = scope.organizationId
    ? await db.query(`SELECT o.operator_model AS model FROM organizations o
        JOIN organization_members m ON m.organization_id=o.id
        WHERE m.user_id=$1 AND o.id=$2`, [scope.userId, scope.organizationId])
    : await db.query('SELECT assistant_model AS model FROM platform_users WHERE id=$1', [scope.userId]);
  if (!rows[0]) throw forbidden();
  return rows[0].model ?? null;
}

export async function saveModelPreference(db: Db, scope: Scope, model: string | null): Promise<string | null> {
  const { rows } = scope.organizationId
    ? await db.query(`UPDATE organizations o SET operator_model=$3 WHERE o.id=$2
        AND EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=o.id AND m.user_id=$1 AND m.role='owner')
        RETURNING operator_model AS model`, [scope.userId, scope.organizationId, model])
    : await db.query('UPDATE platform_users SET assistant_model=$2 WHERE id=$1 RETURNING assistant_model AS model', [scope.userId, model]);
  if (!rows[0]) throw forbidden();
  return rows[0].model ?? null;
}

export async function readPersonalAssistantModel(db: Db, userId: string): Promise<string> {
  return resolveAssistantModel(await readModelPreference(db, { userId }));
}

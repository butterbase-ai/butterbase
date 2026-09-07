/**
 * Pure payload-shape validators shared by `startClone` (authenticated,
 * `POST /v1/templates/:source_app_id/clone`) and the anonymous clone-intent
 * route (`POST /v1/templates/:source_app_id/clone-intent`).
 *
 * Deliberately their own module, separate from `start-clone.ts`: the
 * clone-intent route test suite mocks `services/start-clone.js` wholesale
 * (it only needs `startClone` itself, stubbed, for Task 5 forward
 * compatibility) — a real function living under that same module specifier
 * would resolve to `undefined` through that mock. Living here keeps these
 * validators real (not test-doubled) for every caller while `startClone`
 * stays mockable as a unit for callers that only care about its outcome.
 *
 * No auth, no DB, no reply — pure functions so both callers can apply the
 * identical rule and message text without one duplicating the other.
 */

export function validateEnvVarValues(
  v: unknown,
): { ok: true } | { ok: false; message: string } {
  if (v === undefined) return { ok: true };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return {
      ok: false,
      message: 'env_var_values must be an object mapping function names to {key: value} objects.',
    };
  }
  for (const [fn, vars] of Object.entries(v as Record<string, unknown>)) {
    if (typeof vars !== 'object' || vars === null || Array.isArray(vars)) {
      return {
        ok: false,
        message: `env_var_values["${fn}"] must be an object of {key: value} strings.`,
      };
    }
    for (const [k, val] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof val !== 'string') {
        return {
          ok: false,
          message: `env_var_values["${fn}"]["${k}"] must be a string.`,
        };
      }
    }
  }
  return { ok: true };
}

export function validateAutoMintRequests(
  v: unknown,
): { ok: true } | { ok: false; message: string } {
  if (v === undefined) return { ok: true };
  if (!Array.isArray(v)) {
    return {
      ok: false,
      message: 'auto_mint_api_key must be an array of {fn_name, key} objects.',
    };
  }
  for (const r of v) {
    if (typeof r?.fn_name !== 'string' || typeof r?.key !== 'string') {
      return {
        ok: false,
        message: 'auto_mint_api_key entries must have string fn_name and key.',
      };
    }
  }
  return { ok: true };
}

/**
 * Encoding of request values before they are bound as query parameters.
 *
 * node-pg serialises a JavaScript array into a Postgres ARRAY literal — `{}` for an
 * empty one, `{"a","b"}` otherwise — regardless of the column it is bound to. That is
 * correct for `text[]` and wrong for `json` / `jsonb`, where Postgres then tries to
 * read the array literal as JSON:
 *
 *   ["a","b"]  ->  {"a","b"}  ->  22P02: Expected ":", but found ","   (rejected, 400)
 *   []         ->  {}         ->  a valid, EMPTY JSON OBJECT           (accepted, wrong)
 *
 * The second case is the dangerous one: an empty list was stored as an empty object
 * with no error. Plain objects were unaffected because node-pg JSON-encodes those.
 *
 * So values headed for a JSON column are encoded here rather than left to the driver.
 */

const JSON_COLUMN_TYPES = new Set(['json', 'jsonb']);

export interface ColumnTypeInfo {
  type: string;
}

/** True when this column stores JSON and needs an encoded string rather than a raw value. */
export function isJsonColumn(column: ColumnTypeInfo | undefined): boolean {
  if (!column) return false;
  return JSON_COLUMN_TYPES.has(String(column.type).trim().toLowerCase());
}

/**
 * Map `[column, value]` pairs to the values to bind, JSON-encoding anything bound for
 * a json/jsonb column. Order and arity are preserved so the result lines up with the
 * `$1, $2, …` placeholders built from the same entries.
 *
 * Values are left untouched when the column is unknown, the column is not JSON, the
 * value is null/undefined, or the caller already passed encoded text.
 */
export function encodeValuesForColumns(
  entries: Array<[string, unknown]>,
  columns: Record<string, ColumnTypeInfo>
): unknown[] {
  return entries.map(([key, value]) => {
    if (!isJsonColumn(columns[key])) return value;
    if (value === null || value === undefined) return value;
    // A string is taken as already-encoded JSON; re-encoding would double-quote it.
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  });
}

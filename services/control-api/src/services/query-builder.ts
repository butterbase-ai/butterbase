export interface BuiltQuery {
  text: string;
  values: unknown[];
  invalidFilters?: string[];
}

const OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
  is: 'IS',
};

export function buildSelectQuery(
  table: string,
  validColumns: Set<string>,
  query: Record<string, string | undefined>
): BuiltQuery {
  const values: unknown[] = [];
  let paramIndex = 1;
  const invalidFilters: string[] = [];

  // SELECT clause
  const selectCols = query.select
    ? query.select
        .split(',')
        .filter((c) => validColumns.has(c.trim()))
        .map((c) => `"${c.trim()}"`)
    : ['*'];

  if (selectCols.length === 0) selectCols.push('*');

  let sql = `SELECT ${selectCols.join(', ')} FROM "${table}"`;

  // WHERE clause from filters
  const conditions: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (
      !value ||
      ['select', 'order', 'limit', 'offset'].includes(key)
    )
      continue;

    if (!validColumns.has(key)) {
      invalidFilters.push(`${key}: column does not exist in table "${table}"`);
      continue;
    }

    const dotIdx = value.indexOf('.');
    if (dotIdx === -1) {
      invalidFilters.push(`${key}=${value}: filter must be in format "column=operator.value" (e.g., "id=eq.123")`);
      continue;
    }

    const op = value.substring(0, dotIdx);
    const val = value.substring(dotIdx + 1);

    if (op === 'in') {
      // in.(val1,val2,val3)
      const inner = val.replace(/^\(/, '').replace(/\)$/, '');
      const items = inner.split(',').map((s) => s.trim());
      const placeholders = items.map(() => `$${paramIndex++}`);
      conditions.push(`"${key}" IN (${placeholders.join(', ')})`);
      values.push(...items);
    } else if (op === 'is') {
      // is.null or is.true or is.false
      if (val === 'null') {
        conditions.push(`"${key}" IS NULL`);
      } else if (val === 'true') {
        conditions.push(`"${key}" IS TRUE`);
      } else if (val === 'false') {
        conditions.push(`"${key}" IS FALSE`);
      }
    } else if (op === 'fts') {
      // Full-text search: column=fts.search terms
      conditions.push(`to_tsvector('english', "${key}") @@ plainto_tsquery('english', $${paramIndex++})`);
      values.push(val);
    } else if (OPERATORS[op]) {
      conditions.push(`"${key}" ${OPERATORS[op]} $${paramIndex++}`);
      values.push(val);
    } else {
      invalidFilters.push(`${key}=${value}: unknown operator "${op}". Valid operators: ${Object.keys(OPERATORS).join(', ')}, in, is, fts`);
    }
  }

  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`;
  }

  // ORDER BY
  if (query.order) {
    const parts = query.order.split(',').map((part) => {
      const [col, dir] = part.trim().split('.');
      if (!validColumns.has(col)) return null;
      const direction = dir === 'desc' ? 'DESC' : 'ASC';
      return `"${col}" ${direction}`;
    }).filter(Boolean);
    if (parts.length > 0) {
      sql += ` ORDER BY ${parts.join(', ')}`;
    }
  }

  // LIMIT & OFFSET
  if (query.limit) {
    const limit = parseInt(query.limit, 10);
    if (!isNaN(limit) && limit > 0) {
      sql += ` LIMIT $${paramIndex++}`;
      values.push(limit);
    }
  }

  if (query.offset) {
    const offset = parseInt(query.offset, 10);
    if (!isNaN(offset) && offset >= 0) {
      sql += ` OFFSET $${paramIndex++}`;
      values.push(offset);
    }
  }

  return {
    text: sql,
    values,
    ...(invalidFilters.length > 0 && { invalidFilters })
  };
}

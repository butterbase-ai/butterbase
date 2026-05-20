import type { IntrospectedSchema } from './schema-introspector.js';
import type { SchemaDSL } from './schema-validator.js';
import { normalizeFKRef } from './schema-validator.js';

export interface DDLStatement {
  sql: string;
  description: string;
  destructive: boolean;
  authorized: boolean; // true if user explicitly opted in
}

export function diffSchema(
  current: IntrospectedSchema,
  desired: SchemaDSL
): DDLStatement[] {
  const statements: DDLStatement[] = [];

  const dropTables = new Set(desired._drop ?? []);

  // 1. Drop tables (only if explicitly listed in _drop)
  for (const tableName of dropTables) {
    if (current.tables[tableName]) {
      statements.push({
        sql: `DROP TABLE IF EXISTS "${tableName}" CASCADE`,
        description: `Drop table "${tableName}"`,
        destructive: true,
        authorized: true,
      });
    }
  }

  // 2. Create new tables (topologically sorted by FK dependencies)
  const newTables = Object.entries(desired.tables)
    .filter(([name]) => !current.tables[name]);

  const newTableNames = new Set(newTables.map(([name]) => name));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const [name] of newTables) {
    inDegree.set(name, 0);
    dependents.set(name, new Set());
  }

  for (const [name, def] of newTables) {
    for (const col of Object.values(def.columns)) {
      if (!col.references) continue;
      const refTable = normalizeFKRef(col.references).table;
      if (refTable === name || !newTableNames.has(refTable)) continue;
      dependents.get(refTable)!.add(name);
      inDegree.set(name, inDegree.get(name)! + 1);
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, d]) => d === 0).map(([n]) => n);
  const sorted: string[] = [];
  while (queue.length) {
    const t = queue.shift()!;
    sorted.push(t);
    for (const dep of dependents.get(t)!) {
      const nd = inDegree.get(dep)! - 1;
      inDegree.set(dep, nd);
      if (nd === 0) queue.push(dep);
    }
  }
  if (sorted.length !== newTables.length) {
    throw Object.assign(
      new Error('Circular foreign key dependency detected among new tables'),
      { statusCode: 400 }
    );
  }

  const newTableMap = new Map(newTables);
  for (const tableName of sorted) {
    const tableDef = newTableMap.get(tableName)!;

    const colDefs: string[] = [];
    const constraints: string[] = [];

    for (const [colName, col] of Object.entries(tableDef.columns)) {
      let def = `"${colName}" ${col.type}`;
      if (col.primaryKey) def += ' PRIMARY KEY';
      if (col.nullable === false && !col.primaryKey) def += ' NOT NULL';
      if (col.unique) def += ' UNIQUE';
      if (col.default !== undefined) def += ` DEFAULT ${col.default}`;
      colDefs.push(def);

      if (col.references) {
        const fk = normalizeFKRef(col.references);
        let fkSql = `FOREIGN KEY ("${colName}") REFERENCES "${fk.table}"("${fk.column}")`;
        if (fk.onDelete !== 'NO ACTION') fkSql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate !== 'NO ACTION') fkSql += ` ON UPDATE ${fk.onUpdate}`;
        constraints.push(fkSql);
      }
    }

    const allDefs = [...colDefs, ...constraints].join(', ');
    statements.push({
      sql: `CREATE TABLE "${tableName}" (${allDefs})`,
      description: `Create table "${tableName}"`,
      destructive: false,
      authorized: true,
    });

    if (tableDef.indexes) {
      for (const [idxName, idx] of Object.entries(tableDef.indexes)) {
        statements.push(buildCreateIndex(tableName, idxName, idx));
      }
    }
  }

  // 3. Alter existing tables
  for (const [tableName, tableDef] of Object.entries(desired.tables)) {
    const currentTable = current.tables[tableName];
    if (!currentTable) continue; // New table, already handled above

    const dropColumns = new Set(tableDef._dropColumns ?? []);

    // Drop columns (only if authorized)
    for (const colName of dropColumns) {
      if (currentTable.columns[colName]) {
        statements.push({
          sql: `ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`,
          description: `Drop column "${tableName}"."${colName}"`,
          destructive: true,
          authorized: true,
        });
      }
    }

    // Add new columns
    for (const [colName, col] of Object.entries(tableDef.columns)) {
      if (currentTable.columns[colName]) continue; // Exists, handle alterations below

      let def = `"${colName}" ${col.type}`;
      if (col.nullable === false) def += ' NOT NULL';
      if (col.unique) def += ' UNIQUE';
      if (col.default !== undefined) def += ` DEFAULT ${col.default}`;

      statements.push({
        sql: `ALTER TABLE "${tableName}" ADD COLUMN ${def}`,
        description: `Add column "${tableName}"."${colName}"`,
        destructive: false,
        authorized: true,
      });

      if (col.references) {
        const fk = normalizeFKRef(col.references);
        let fkSql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "fk_${tableName}_${colName}" FOREIGN KEY ("${colName}") REFERENCES "${fk.table}"("${fk.column}")`;
        if (fk.onDelete !== 'NO ACTION') fkSql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate !== 'NO ACTION') fkSql += ` ON UPDATE ${fk.onUpdate}`;
        statements.push({
          sql: fkSql,
          description: `Add foreign key "${tableName}"."${colName}" -> "${fk.table}.${fk.column}"`,
          destructive: false,
          authorized: true,
        });
      }
    }

    // Alter existing columns (type, nullable, default changes)
    for (const [colName, desiredCol] of Object.entries(tableDef.columns)) {
      const currentCol = currentTable.columns[colName];
      if (!currentCol) continue; // New column, already handled

      // Type change
      if (
        desiredCol.type.toLowerCase() !== currentCol.type.toLowerCase()
      ) {
        statements.push({
          sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${desiredCol.type}`,
          description: `Change type of "${tableName}"."${colName}" from ${currentCol.type} to ${desiredCol.type}`,
          destructive: true,
          authorized: false, // Type changes are risky, not auto-authorized
        });
      }

      // Nullable change
      const desiredNullable = desiredCol.nullable !== false;
      const currentNullable = currentCol.nullable !== false;
      if (desiredNullable !== currentNullable) {
        if (desiredNullable) {
          statements.push({
            sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP NOT NULL`,
            description: `Make "${tableName}"."${colName}" nullable`,
            destructive: false,
            authorized: true,
          });
        } else {
          statements.push({
            sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET NOT NULL`,
            description: `Make "${tableName}"."${colName}" not nullable`,
            destructive: false,
            authorized: true,
          });
        }
      }

      // Default change
      if (desiredCol.default !== undefined && desiredCol.default !== currentCol.default) {
        statements.push({
          sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET DEFAULT ${desiredCol.default}`,
          description: `Change default of "${tableName}"."${colName}"`,
          destructive: false,
          authorized: true,
        });
      } else if (desiredCol.default === undefined && currentCol.default !== undefined) {
        statements.push({
          sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP DEFAULT`,
          description: `Drop default of "${tableName}"."${colName}"`,
          destructive: false,
          authorized: true,
        });
      }

      // FK reference behavior changes
      const desiredRef = desiredCol.references;
      const currentRef = currentCol.references;

      if (desiredRef && currentRef) {
        const desiredNorm = normalizeFKRef(desiredRef);
        const currentNorm = normalizeFKRef(currentRef);

        const fkChanged =
          desiredNorm.table !== currentNorm.table ||
          desiredNorm.column !== currentNorm.column ||
          desiredNorm.onDelete !== currentNorm.onDelete ||
          desiredNorm.onUpdate !== currentNorm.onUpdate;

        if (fkChanged) {
          const constraintName =
            current._fkConstraints?.[`${tableName}.${colName}`] ??
            `fk_${tableName}_${colName}`;

          statements.push({
            sql: `ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}"`,
            description: `Drop foreign key "${tableName}"."${colName}" (changing behavior)`,
            destructive: false,
            authorized: true,
          });

          let fkSql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "fk_${tableName}_${colName}" FOREIGN KEY ("${colName}") REFERENCES "${desiredNorm.table}"("${desiredNorm.column}")`;
          if (desiredNorm.onDelete !== 'NO ACTION') fkSql += ` ON DELETE ${desiredNorm.onDelete}`;
          if (desiredNorm.onUpdate !== 'NO ACTION') fkSql += ` ON UPDATE ${desiredNorm.onUpdate}`;
          statements.push({
            sql: fkSql,
            description: `Add foreign key "${tableName}"."${colName}" -> "${desiredNorm.table}.${desiredNorm.column}" (ON DELETE ${desiredNorm.onDelete})`,
            destructive: false,
            authorized: true,
          });
        }
      } else if (desiredRef && !currentRef) {
        const fk = normalizeFKRef(desiredRef);
        let fkSql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "fk_${tableName}_${colName}" FOREIGN KEY ("${colName}") REFERENCES "${fk.table}"("${fk.column}")`;
        if (fk.onDelete !== 'NO ACTION') fkSql += ` ON DELETE ${fk.onDelete}`;
        if (fk.onUpdate !== 'NO ACTION') fkSql += ` ON UPDATE ${fk.onUpdate}`;
        statements.push({
          sql: fkSql,
          description: `Add foreign key "${tableName}"."${colName}" -> "${fk.table}.${fk.column}"`,
          destructive: false,
          authorized: true,
        });
      }
    }

    // Detect tables removed from desired but present in current (not in _drop)
    // These are flagged as unauthorized destructive operations
    // (handled at the end)

    // Index changes
    const desiredIndexes = tableDef.indexes ?? {};
    const currentIndexes = currentTable.indexes ?? {};

    // Drop indexes not in desired
    for (const idxName of Object.keys(currentIndexes)) {
      if (!desiredIndexes[idxName]) {
        statements.push({
          sql: `DROP INDEX IF EXISTS "${idxName}"`,
          description: `Drop index "${idxName}" on "${tableName}"`,
          destructive: false,
          authorized: true,
        });
      }
    }

    // Add new indexes
    for (const [idxName, idx] of Object.entries(desiredIndexes)) {
      if (!currentIndexes[idxName]) {
        statements.push(buildCreateIndex(tableName, idxName, idx));
      }
    }
  }

  // 4. Detect tables in current but not in desired (and not in _drop)
  for (const tableName of Object.keys(current.tables)) {
    if (!desired.tables[tableName] && !dropTables.has(tableName)) {
      statements.push({
        sql: `DROP TABLE IF EXISTS "${tableName}" CASCADE`,
        description: `Table "${tableName}" is not in the schema — use _drop to remove it`,
        destructive: true,
        authorized: false, // Not authorized — user must add to _drop
      });
    }
  }

  return statements;
}

function buildCreateIndex(
  tableName: string,
  idxName: string,
  idx: { columns: string[]; unique?: boolean; method?: string; opclass?: string }
): DDLStatement {
  const unique = idx.unique ? 'UNIQUE ' : '';
  const method = idx.method ? ` USING ${idx.method}` : '';
  const cols = idx.columns
    .map((c) => {
      let col = `"${c}"`;
      if (idx.opclass) col += ` ${idx.opclass}`;
      return col;
    })
    .join(', ');

  return {
    sql: `CREATE ${unique}INDEX "${idxName}" ON "${tableName}"${method} (${cols})`,
    description: `Create index "${idxName}" on "${tableName}"`,
    destructive: false,
    authorized: true,
  };
}

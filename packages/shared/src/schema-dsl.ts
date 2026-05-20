/**
 * Schema DSL types for Butterbase declarative schema management.
 * These types represent the desired state of an app's database schema.
 */

export interface ColumnDef {
  type: string;
  primaryKey?: boolean;
  nullable?: boolean;
  default?: string;
  unique?: boolean;
  references?: string;
}

export interface IndexDef {
  columns: string[];
  unique?: boolean;
  method?: string;
  opclass?: string;
}

export interface TableDef {
  columns: Record<string, ColumnDef>;
  indexes?: Record<string, IndexDef>;
  _dropColumns?: string[];
}

export interface SchemaDSL {
  tables: Record<string, TableDef>;
  _drop?: string[];
}

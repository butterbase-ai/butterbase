import type { ButterbaseClient } from './butterbase-client.js';
import type { ButterbaseResponse, OrderByOptions } from '../types/index.js';
import { InsertBuilder, UpdateBuilder, DeleteBuilder } from './mutation-builders.js';

export class QueryBuilder<T = any> {
  private table: string;
  private selectCols: string = '*';
  private filters: Array<{ column: string; op: string; value: any }> = [];
  private orderByList: Array<{ column: string; ascending: boolean }> = [];
  private limitValue?: number;
  private offsetValue?: number;
  private client: ButterbaseClient;
  private _modifier: 'single' | 'maybeSingle' | null = null;

  constructor(table: string, client: ButterbaseClient) {
    this.table = table;
    this.client = client;
  }

  /**
   * Select specific columns
   */
  select(columns: string = '*'): this {
    this.selectCols = columns;
    return this;
  }

  /**
   * Equal to
   */
  eq(column: string, value: any): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  /**
   * Not equal to
   */
  neq(column: string, value: any): this {
    this.filters.push({ column, op: 'neq', value });
    return this;
  }

  /**
   * Greater than
   */
  gt(column: string, value: any): this {
    this.filters.push({ column, op: 'gt', value });
    return this;
  }

  /**
   * Greater than or equal to
   */
  gte(column: string, value: any): this {
    this.filters.push({ column, op: 'gte', value });
    return this;
  }

  /**
   * Less than
   */
  lt(column: string, value: any): this {
    this.filters.push({ column, op: 'lt', value });
    return this;
  }

  /**
   * Less than or equal to
   */
  lte(column: string, value: any): this {
    this.filters.push({ column, op: 'lte', value });
    return this;
  }

  /**
   * Pattern matching (case-sensitive)
   */
  like(column: string, pattern: string): this {
    this.filters.push({ column, op: 'like', value: pattern });
    return this;
  }

  /**
   * Pattern matching (case-insensitive)
   */
  ilike(column: string, pattern: string): this {
    this.filters.push({ column, op: 'ilike', value: pattern });
    return this;
  }

  /**
   * Value is in array
   */
  in(column: string, values: any[]): this {
    this.filters.push({ column, op: 'in', value: `(${values.join(',')})` });
    return this;
  }

  /**
   * Value is null, true, or false
   */
  is(column: string, value: null | boolean): this {
    this.filters.push({ column, op: 'is', value });
    return this;
  }

  /**
   * Order results by column
   */
  order(column: string, options?: OrderByOptions): this {
    this.orderByList.push({
      column,
      ascending: options?.ascending ?? true,
    });
    return this;
  }

  /**
   * Limit number of results
   */
  limit(count: number): this {
    this.limitValue = count;
    return this;
  }

  /**
   * Skip number of results
   */
  offset(count: number): this {
    this.offsetValue = count;
    return this;
  }

  /**
   * Return a single row. Errors if 0 or 2+ rows match.
   */
  single(): this {
    this._modifier = 'single';
    return this;
  }

  /**
   * Return a single row or null. No error if 0 rows match.
   */
  maybeSingle(): this {
    this._modifier = 'maybeSingle';
    return this;
  }

  /**
   * Pagination by range (inclusive). Sugar for .limit(to - from + 1).offset(from).
   */
  range(from: number, to: number): this {
    this.limitValue = to - from + 1;
    this.offsetValue = from;
    return this;
  }

  /**
   * Generic filter method. Escape hatch for any operator the server supports.
   */
  filter(column: string, operator: string, value: any): this {
    this.filters.push({ column, op: operator, value });
    return this;
  }

  /**
   * Execute the query
   */
  async execute(): Promise<ButterbaseResponse<any>> {
    try {
      const params = new URLSearchParams();

      if (this.selectCols !== '*') {
        params.set('select', this.selectCols);
      }

      for (const filter of this.filters) {
        params.set(filter.column, `${filter.op}.${filter.value}`);
      }

      if (this.orderByList.length > 0) {
        const orderStr = this.orderByList
          .map((o) => `${o.column}.${o.ascending ? 'asc' : 'desc'}`)
          .join(',');
        params.set('order', orderStr);
      }

      // For single/maybeSingle, fetch at most 2 rows to detect ambiguity
      const effectiveLimit = this._modifier ? 2 : this.limitValue;
      if (effectiveLimit !== undefined) {
        params.set('limit', String(effectiveLimit));
      }

      if (this.offsetValue !== undefined) {
        params.set('offset', String(this.offsetValue));
      }

      const queryString = params.toString();
      const path = `/v1/${this.client.appId}/${this.table}${queryString ? `?${queryString}` : ''}`;

      const data = await this.client.request<T[]>('GET', path);

      if (this._modifier === 'single') {
        if (!data || data.length === 0) {
          return { data: null, error: new Error('Row not found: query returned 0 rows') };
        }
        if (data.length > 1) {
          return { data: null, error: new Error('Multiple rows found: query returned more than 1 row') };
        }
        return { data: data[0] as T, error: null };
      }

      if (this._modifier === 'maybeSingle') {
        if (!data || data.length === 0) {
          return { data: null, error: null };
        }
        if (data.length > 1) {
          return { data: null, error: new Error('Multiple rows found: query returned more than 1 row') };
        }
        return { data: data[0] as T, error: null };
      }

      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Make the query builder thenable for await syntax
   */
  then<TResult1 = ButterbaseResponse<T[]>, TResult2 = never>(
    onfulfilled?: ((value: ButterbaseResponse<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  /**
   * Insert new records
   */
  insert(values: Partial<T> | Partial<T>[]): InsertBuilder<T> {
    return new InsertBuilder(this.table, this.client, values);
  }

  /**
   * Update records matching filters
   */
  update(values: Partial<T>): UpdateBuilder<T> {
    return new UpdateBuilder(this.table, this.client, values, this.filters);
  }

  /**
   * Delete records matching filters
   */
  delete(): DeleteBuilder<T> {
    return new DeleteBuilder(this.table, this.client, this.filters);
  }
}

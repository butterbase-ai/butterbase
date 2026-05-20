import type { ButterbaseClient } from './butterbase-client.js';
import type { ButterbaseResponse } from '../types/index.js';

/**
 * Builder for INSERT operations
 */
export class InsertBuilder<T = any> {
  private table: string;
  private client: ButterbaseClient;
  private values: Partial<T> | Partial<T>[];
  private _returning: string | null = null;

  constructor(table: string, client: ButterbaseClient, values: Partial<T> | Partial<T>[]) {
    this.table = table;
    this.client = client;
    this.values = values;
  }

  /**
   * Request that the inserted row(s) be returned in the response.
   */
  select(columns: string = '*'): this {
    this._returning = columns;
    return this;
  }

  async execute(): Promise<ButterbaseResponse<T | T[]>> {
    try {
      const params = new URLSearchParams();
      if (this._returning) {
        params.set('select', this._returning);
      }
      const queryString = params.toString();
      const path = `/v1/${this.client.appId}/${this.table}${queryString ? `?${queryString}` : ''}`;
      const data = await this.client.request<T | T[]>('POST', path, this.values);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  then<TResult1 = ButterbaseResponse<T | T[]>, TResult2 = never>(
    onfulfilled?: ((value: ButterbaseResponse<T | T[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/**
 * Builder for UPDATE operations
 */
export class UpdateBuilder<T = any> {
  private table: string;
  private client: ButterbaseClient;
  private values: Partial<T>;
  private filters: Array<{ column: string; op: string; value: any }>;

  constructor(
    table: string,
    client: ButterbaseClient,
    values: Partial<T>,
    filters: Array<{ column: string; op: string; value: any }>
  ) {
    this.table = table;
    this.client = client;
    this.values = values;
    this.filters = filters;
  }

  /**
   * Add filter condition
   */
  eq(column: string, value: any): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  async execute(): Promise<ButterbaseResponse<T>> {
    try {
      // Detect single id filter for path param usage
      const idFilter = this.filters.find(f => f.column === 'id' && f.op === 'eq');

      let path: string;
      if (idFilter && this.filters.length === 1) {
        // Use path param for single id: PATCH /v1/:app/:table/:id
        path = `/v1/${this.client.appId}/${this.table}/${idFilter.value}`;
      } else {
        // Use query string for complex filters
        const params = new URLSearchParams();
        for (const filter of this.filters) {
          params.set(filter.column, `${filter.op}.${filter.value}`);
        }
        const queryString = params.toString();
        path = `/v1/${this.client.appId}/${this.table}${queryString ? `?${queryString}` : ''}`;
      }

      const data = await this.client.request<T>('PATCH', path, this.values);
      return { data, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  then<TResult1 = ButterbaseResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: ButterbaseResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

/**
 * Builder for DELETE operations
 */
export class DeleteBuilder<T = any> {
  private table: string;
  private client: ButterbaseClient;
  private filters: Array<{ column: string; op: string; value: any }>;

  constructor(
    table: string,
    client: ButterbaseClient,
    filters: Array<{ column: string; op: string; value: any }>
  ) {
    this.table = table;
    this.client = client;
    this.filters = filters;
  }

  /**
   * Add filter condition
   */
  eq(column: string, value: any): this {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  async execute(): Promise<ButterbaseResponse<void>> {
    try {
      // Detect single id filter for path param usage
      const idFilter = this.filters.find(f => f.column === 'id' && f.op === 'eq');

      let path: string;
      if (idFilter && this.filters.length === 1) {
        // Use path param for single id: DELETE /v1/:app/:table/:id
        path = `/v1/${this.client.appId}/${this.table}/${idFilter.value}`;
      } else {
        // Use query string for complex filters
        const params = new URLSearchParams();
        for (const filter of this.filters) {
          params.set(filter.column, `${filter.op}.${filter.value}`);
        }
        const queryString = params.toString();
        path = `/v1/${this.client.appId}/${this.table}${queryString ? `?${queryString}` : ''}`;
      }

      await this.client.request<void>('DELETE', path);
      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  then<TResult1 = ButterbaseResponse<void>, TResult2 = never>(
    onfulfilled?: ((value: ButterbaseResponse<void>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

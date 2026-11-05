import { describe, it, expect } from 'vitest';
import { kvMgetValues } from '../kv-batch.js';

describe('kvMgetValues', () => {
  it('returns values in key order', () => {
    expect(kvMgetValues(['a', 'b'], [{ value: 1 }, { value: 2 }])).toEqual([1, 2]);
    expect(kvMgetValues(['a'], [{ value: null }])).toEqual([null]);
  });

  it('throws a named error instead of nulling a decode failure', () => {
    expect(() => kvMgetValues(['a', 'bad'], [{ value: 'v' }, { error: 'redis_error' }]))
      .toThrow(/bad/);
    try {
      kvMgetValues(['bad'], [{ error: 'redis_error' }]);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toMatchObject({ name: 'KvError', code: 'redis_error' });
    }
  });
});

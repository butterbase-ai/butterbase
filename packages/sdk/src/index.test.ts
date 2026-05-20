import { describe, it, expect } from 'vitest';
import * as sdk from './index';

describe('SDK public surface', () => {
  it('exports AdminDurableObjectsClient', () => {
    expect(sdk.AdminDurableObjectsClient).toBeDefined();
    expect(typeof sdk.AdminDurableObjectsClient).toBe('function'); // class constructor
  });

  it('exports AdminEdgeSsrClient', () => {
    expect(sdk.AdminEdgeSsrClient).toBeDefined();
    expect(typeof sdk.AdminEdgeSsrClient).toBe('function');
  });

  it('exports Order type (no runtime value to check, but compile-time succeeds)', () => {
    type _AssertOrderExported = import('./index').Order;
    expect(true).toBe(true);
  });
});

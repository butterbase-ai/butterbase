import { describe, it, expect } from 'vitest';
import { encodeValuesForColumns } from '../pg-json-values.js';

/**
 * node-pg serialises a JS array as a Postgres ARRAY literal ("{}", "{\"a\",\"b\"}")
 * whatever the target column is. Bound to a json/jsonb column, Postgres then parses
 * that literal as JSON — so ["a","b"] became {"a","b"} and failed with
 * `Expected ":", but found ","`, while [] became {} and was stored, silently, as an
 * empty OBJECT instead of an empty array.
 *
 * Values for json/jsonb columns must therefore be JSON-encoded text before binding.
 */
const columns = {
  id: { type: 'uuid' },
  title: { type: 'text' },
  filters: { type: 'jsonb' },
  legacy_doc: { type: 'json' },
  tags: { type: 'text[]' },
  count: { type: 'integer' },
};

const encode = (row: Record<string, unknown>) =>
  Object.fromEntries(
    encodeValuesForColumns(Object.entries(row), columns).map((v, i) => [Object.keys(row)[i], v])
  );

describe('encodeValuesForColumns', () => {
  it('JSON-encodes a non-empty array bound for a jsonb column', () => {
    expect(encode({ filters: ['a', 'b'] }).filters).toBe('["a","b"]');
  });

  it('JSON-encodes an EMPTY array so it stays an array, not an object', () => {
    // The silent-corruption case: [] bound raw became {} in the database.
    expect(encode({ filters: [] }).filters).toBe('[]');
  });

  it('JSON-encodes arrays of objects and of numbers', () => {
    expect(encode({ filters: [{ k: 1 }] }).filters).toBe('[{"k":1}]');
    expect(encode({ filters: [1, 2] }).filters).toBe('[1,2]');
  });

  it('encodes json columns the same way as jsonb', () => {
    expect(encode({ legacy_doc: ['x'] }).legacy_doc).toBe('["x"]');
  });

  it('JSON-encodes objects for jsonb columns too, rather than relying on the driver', () => {
    expect(encode({ filters: { a: 1 } }).filters).toBe('{"a":1}');
  });

  it('leaves text[] arrays alone — the array literal is correct for that type', () => {
    expect(encode({ tags: ['a', 'b'] }).tags).toEqual(['a', 'b']);
  });

  it('leaves scalars and null untouched', () => {
    expect(encode({ title: 'hello' }).title).toBe('hello');
    expect(encode({ count: 3 }).count).toBe(3);
    expect(encode({ filters: null }).filters).toBeNull();
  });

  it('passes a string through unchanged, so a client that already encoded still works', () => {
    expect(encode({ filters: '["a"]' }).filters).toBe('["a"]');
  });

  it('ignores columns it knows nothing about', () => {
    expect(encodeValuesForColumns([['mystery', ['a']]], columns)).toEqual([['a']]);
  });

  it('preserves order and arity of the entries it is given', () => {
    const entries: [string, unknown][] = [['title', 't'], ['filters', ['a']], ['count', 1]];
    expect(encodeValuesForColumns(entries, columns)).toEqual(['t', '["a"]', 1]);
  });
});

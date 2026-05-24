import { describe, it, expect } from 'vitest';
import {
  creditCostForOp,
  opsCountForOp,
  classifyRequest,
  type KvOp,
} from './credits.js';

describe('creditCostForOp', () => {
  const ops: KvOp[] = [
    { kind: 'read' },
    { kind: 'write' },
    { kind: 'atomic_write' },
    { kind: 'mget', n: 1 },
    { kind: 'mget', n: 100 },
    { kind: 'mset', n: 1 },
    { kind: 'mset', n: 100 },
  ];
  for (const op of ops) {
    it(`${op.kind}${'n' in op ? `(${op.n})` : ''} = 0 credits`, () => {
      expect(creditCostForOp(op)).toBe(0);
    });
  }
});

describe('opsCountForOp', () => {
  it('read = 1 op', () => {
    expect(opsCountForOp({ kind: 'read' })).toBe(1);
  });

  it('write = 1 op', () => {
    expect(opsCountForOp({ kind: 'write' })).toBe(1);
  });

  it('atomic_write = 1 op', () => {
    expect(opsCountForOp({ kind: 'atomic_write' })).toBe(1);
  });

  it('mget(1) = 1 op', () => {
    expect(opsCountForOp({ kind: 'mget', n: 1 })).toBe(1);
  });

  it('mget(5) = 5 ops', () => {
    expect(opsCountForOp({ kind: 'mget', n: 5 })).toBe(5);
  });

  it('mget(100) = 100 ops', () => {
    expect(opsCountForOp({ kind: 'mget', n: 100 })).toBe(100);
  });

  it('mset(1) = 1 op', () => {
    expect(opsCountForOp({ kind: 'mset', n: 1 })).toBe(1);
  });

  it('mset(5) = 5 ops', () => {
    expect(opsCountForOp({ kind: 'mset', n: 5 })).toBe(5);
  });

  it('mset(100) = 100 ops', () => {
    expect(opsCountForOp({ kind: 'mset', n: 100 })).toBe(100);
  });
});

describe('classifyRequest', () => {
  describe('HTTP method classification', () => {
    it('GET → read', () => {
      const op = classifyRequest('GET', null);
      expect(op).toEqual({ kind: 'read' });
    });

    it('PUT → write', () => {
      const op = classifyRequest('PUT', null);
      expect(op).toEqual({ kind: 'write' });
    });

    it('DELETE → write', () => {
      const op = classifyRequest('DELETE', null);
      expect(op).toEqual({ kind: 'write' });
    });
  });

  describe('Action-based classification', () => {
    it('action=ttl → read', () => {
      const op = classifyRequest('POST', 'ttl');
      expect(op).toEqual({ kind: 'read' });
    });

    it('action=exists → read', () => {
      const op = classifyRequest('POST', 'exists');
      expect(op).toEqual({ kind: 'read' });
    });

    it('action=expire → write', () => {
      const op = classifyRequest('POST', 'expire');
      expect(op).toEqual({ kind: 'write' });
    });

    it('action=incr → atomic_write', () => {
      const op = classifyRequest('POST', 'incr');
      expect(op).toEqual({ kind: 'atomic_write' });
    });

    it('action=decr → atomic_write', () => {
      const op = classifyRequest('POST', 'decr');
      expect(op).toEqual({ kind: 'atomic_write' });
    });

    it('action=setnx → atomic_write', () => {
      const op = classifyRequest('POST', 'setnx');
      expect(op).toEqual({ kind: 'atomic_write' });
    });

    it('action=cas → atomic_write', () => {
      const op = classifyRequest('POST', 'cas');
      expect(op).toEqual({ kind: 'atomic_write' });
    });
  });

  describe('Batch operations classification', () => {
    it('_batch with all get → mget', () => {
      const batchOps = [{ op: 'get' }, { op: 'get' }, { op: 'get' }];
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mget', n: 3 });
    });

    it('_batch with single get → mget(1)', () => {
      const batchOps = [{ op: 'get' }];
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mget', n: 1 });
    });

    it('_batch with all set → mset', () => {
      const batchOps = [{ op: 'set' }, { op: 'set' }];
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mset', n: 2 });
    });

    it('_batch with all del → mset (conservative)', () => {
      const batchOps = [{ op: 'del' }, { op: 'del' }];
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mset', n: 2 });
    });

    it('_batch with mixed ops → mset (conservative)', () => {
      const batchOps = [{ op: 'get' }, { op: 'set' }, { op: 'del' }];
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mset', n: 3 });
    });

    it('_batch with 100 ops → mset(100)', () => {
      const batchOps = Array(100).fill({ op: 'set' });
      const op = classifyRequest('POST', null, batchOps);
      expect(op).toEqual({ kind: 'mset', n: 100 });
    });
  });

  describe('Invalid/unknown cases', () => {
    it('unknown action → null', () => {
      const op = classifyRequest('POST', 'unknown_action');
      expect(op).toBeNull();
    });

    it('unknown method without action or batch → null', () => {
      const op = classifyRequest('PATCH', null);
      expect(op).toBeNull();
    });

    it('empty batch ops array → null', () => {
      const op = classifyRequest('POST', null, []);
      expect(op).toBeNull();
    });

    it('undefined batch ops → null', () => {
      const op = classifyRequest('POST', null, undefined);
      expect(op).toBeNull();
    });
  });

  describe('Action takes precedence over method', () => {
    it('action=ttl with GET method → read (action wins)', () => {
      const op = classifyRequest('GET', 'ttl');
      expect(op).toEqual({ kind: 'read' });
    });

    it('action=incr with PUT method → atomic_write (action wins)', () => {
      const op = classifyRequest('PUT', 'incr');
      expect(op).toEqual({ kind: 'atomic_write' });
    });
  });

  describe('Combined cost + ops validation', () => {
    it('read has 0 credits and 1 op', () => {
      const op = classifyRequest('GET', null);
      expect(op).not.toBeNull();
      expect(creditCostForOp(op!)).toBe(0);
      expect(opsCountForOp(op!)).toBe(1);
    });

    it('write has 0 credits and 1 op', () => {
      const op = classifyRequest('PUT', null);
      expect(op).not.toBeNull();
      expect(creditCostForOp(op!)).toBe(0);
      expect(opsCountForOp(op!)).toBe(1);
    });

    it('mget(5) has 0 credits and 5 ops', () => {
      const batchOps = Array(5).fill({ op: 'get' });
      const op = classifyRequest('POST', null, batchOps);
      expect(op).not.toBeNull();
      expect(creditCostForOp(op!)).toBe(0);
      expect(opsCountForOp(op!)).toBe(5);
    });

    it('mset(5) has 0 credits and 5 ops', () => {
      const batchOps = Array(5).fill({ op: 'set' });
      const op = classifyRequest('POST', null, batchOps);
      expect(op).not.toBeNull();
      expect(creditCostForOp(op!)).toBe(0);
      expect(opsCountForOp(op!)).toBe(5);
    });
  });
});

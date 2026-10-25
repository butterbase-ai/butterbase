// singleFork intentionally reuses a process. Some legacy tests directly assign
// global.fetch without restoring it. Capture the native implementation before
// suites load so real HTTP regression tests remain independent of their order.
const key = Symbol.for('butterbase.test.nativeFetch');
const saved = globalThis as typeof globalThis & { [key: symbol]: typeof fetch };
export const nativeFetch = saved[key] ??= globalThis.fetch;

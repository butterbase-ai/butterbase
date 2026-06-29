import type { PeopleAdapter } from './types.js';

let adapter: PeopleAdapter | null = null;

export function setPeopleAdapter(a: PeopleAdapter | null): void {
  adapter = a;
}

export function getPeopleAdapter(): PeopleAdapter | null {
  return adapter;
}

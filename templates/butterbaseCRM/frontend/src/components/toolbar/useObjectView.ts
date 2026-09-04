import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSavedViews } from '@/hooks/useSavedViews';
import { useCustomFields } from '@/hooks/useCustomFields';
import { fieldsForObject } from '@/lib/filterDsl';
import type { Filter, SortSpec, FieldSpec } from '@/lib/filterDsl';
import type { ObjectTypeSlug, SavedView } from '@/lib/types';

interface ObjectViewState {
  activeView: SavedView | null;
  filters: Filter[];
  sort: SortSpec | null;
  visibleFields: string[];
  fields: FieldSpec[];
  customFields: ReturnType<typeof useCustomFields>['data'];
  setActiveView: (v: SavedView | null) => void;
  setFilters: (next: Filter[]) => void;
  setSort: (next: SortSpec | null) => void;
  setVisibleFields: (next: string[]) => void;
  isDirty: boolean;
}

const DEFAULT_VISIBLE: Record<ObjectTypeSlug, string[]> = {
  people: ['first_name', 'email', 'title', 'phone', 'updated_at'],
  companies: ['name', 'domain', 'industry', 'location', 'employee_count'],
  deals: ['name', 'stage', 'amount_cents', 'currency', 'close_date'],
  meetings: ['title', 'starts_at', 'location'],
};

const EMPTY_FILTERS: Filter[] = [];

const PERSIST_KEYS = ['f', 's', 'vf', 'view'] as const;
const STORAGE_PREFIX = 'objectView:';

function tryParse<T>(raw: string | null): T | undefined {
  if (raw == null) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

export function useObjectView(objectType: ObjectTypeSlug): ObjectViewState {
  const [params, setParams] = useSearchParams();
  const { data: views } = useSavedViews(objectType);
  const { data: customs } = useCustomFields(objectType);

  const allFields = useMemo(() => fieldsForObject(objectType, customs ?? []), [objectType, customs]);

  const viewIdParam = params.get('view');
  const activeView = useMemo(() => {
    if (!viewIdParam) return null;
    return (views ?? []).find((v) => v.id === viewIdParam) ?? null;
  }, [viewIdParam, views]);

  // Overrides live in URL search params so every consumer of useObjectView on
  // the same route reads the same state. Empty-array/null values are encoded
  // explicitly (e.g. f=[]) so the user can clear filters that came from an
  // activeView. Param missing means "inherit from activeView".
  const filtersParam = params.get('f');
  const sortParam = params.get('s');
  const visibleParam = params.get('vf');

  // Hydrate from localStorage on mount when URL has no view-state params.
  // This makes filters/sort/visible-fields/saved-view survive navigating away
  // and back. Writes below mirror URL changes into the same storage key.
  useEffect(() => {
    if (PERSIST_KEYS.some((k) => params.has(k))) return;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + objectType);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, string>;
      if (!saved || typeof saved !== 'object') return;
      const p = new URLSearchParams(params);
      let changed = false;
      for (const k of PERSIST_KEYS) {
        if (typeof saved[k] === 'string') { p.set(k, saved[k]); changed = true; }
      }
      if (changed) setParams(p, { replace: true });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectType]);

  useEffect(() => {
    try {
      const saved: Record<string, string> = {};
      for (const k of PERSIST_KEYS) {
        const v = params.get(k);
        if (v !== null) saved[k] = v;
      }
      const key = STORAGE_PREFIX + objectType;
      if (Object.keys(saved).length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(saved));
    } catch { /* ignore */ }
  }, [objectType, filtersParam, sortParam, visibleParam, viewIdParam, params]);

  const overrideFilters = useMemo(() => tryParse<Filter[]>(filtersParam), [filtersParam]);
  // For sort, "" (empty string) means explicit null (sort cleared); missing means inherit.
  const overrideSort = useMemo<SortSpec | null | undefined>(() => {
    if (sortParam == null) return undefined;
    if (sortParam === '') return null;
    return tryParse<SortSpec>(sortParam) ?? undefined;
  }, [sortParam]);
  const overrideVisible = useMemo(() => tryParse<string[]>(visibleParam), [visibleParam]);

  const filters = overrideFilters ?? (activeView?.filters as Filter[] | undefined) ?? EMPTY_FILTERS;
  const sort = overrideSort === undefined ? (activeView?.sort ?? null) : overrideSort;
  const visibleFields = overrideVisible ?? activeView?.visible_fields ?? DEFAULT_VISIBLE[objectType];

  function patch(mut: (p: URLSearchParams) => void) {
    const p = new URLSearchParams(params);
    mut(p);
    setParams(p, { replace: true });
  }

  function setActiveView(v: SavedView | null) {
    patch((p) => {
      if (v) p.set('view', v.id); else p.delete('view');
      p.delete('f'); p.delete('s'); p.delete('vf');
    });
  }

  function setFilters(next: Filter[]) {
    patch((p) => { p.set('f', JSON.stringify(next)); });
  }

  function setSort(next: SortSpec | null) {
    patch((p) => { p.set('s', next ? JSON.stringify(next) : ''); });
  }

  function setVisibleFields(next: string[]) {
    patch((p) => { p.set('vf', JSON.stringify(next)); });
  }

  return {
    activeView,
    filters,
    sort,
    visibleFields,
    fields: allFields,
    customFields: customs,
    setActiveView,
    setFilters,
    setSort,
    setVisibleFields,
    isDirty: overrideFilters !== undefined || overrideSort !== undefined || overrideVisible !== undefined,
  };
}

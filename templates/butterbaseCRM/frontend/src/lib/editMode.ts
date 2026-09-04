import { useEffect, useState } from 'react';

// Detail-page edit UX preference. See CompanyDetail.tsx / PersonDetail.tsx for
// how each mode is rendered.
//
//   'hover'  (default) — every field is always clickable to edit inline, and
//            URL fields (domain, LinkedIn) render as real links with a small
//            pencil affordance on hover so users can navigate without
//            accidentally entering edit mode.
//   'toggle' — a single "Edit" button at the top of the page unlocks all
//            fields at once; while off, everything renders as read-only.

export type EditMode = 'hover' | 'toggle';

const KEY = 'crm.editMode';
const EVENT = 'crm.editMode.change';

export function getEditMode(): EditMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'toggle' ? 'toggle' : 'hover';
  } catch {
    return 'hover';
  }
}

export function setEditMode(mode: EditMode): void {
  try {
    localStorage.setItem(KEY, mode);
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* ignore */
  }
}

export function useEditMode(): [EditMode, (m: EditMode) => void] {
  const [mode, setModeState] = useState<EditMode>(() => getEditMode());
  useEffect(() => {
    const onChange = () => setModeState(getEditMode());
    window.addEventListener(EVENT, onChange);
    // Also react to cross-tab changes.
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return [mode, (m: EditMode) => { setEditMode(m); setModeState(m); }];
}

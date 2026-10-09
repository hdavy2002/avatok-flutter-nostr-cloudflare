/* [HF-HOST-ONBOARD-1] Draft persistence. All browser storage lives here, always in try/catch. */
import { EMPTY_DRAFT } from './data';
import type { Draft } from './types';

const KEY = 'hf_host_onboarding_draft_v1';

export function loadDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<Draft>;
    if (!j || typeof j !== 'object') return null;
    return {
      ...EMPTY_DRAFT, ...j,
      hours: { ...EMPTY_DRAFT.hours, ...(j.hours || {}) },
      voice: { ...EMPTY_DRAFT.voice, ...(j.voice || {}) },
      agreements: { ...EMPTY_DRAFT.agreements, ...(j.agreements || {}) },
    };
  } catch { return null; }
}

export function saveDraft(d: Draft): void {
  try { window.localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* storage blocked */ }
}

export function clearDraft(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

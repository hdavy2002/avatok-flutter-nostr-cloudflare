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
      selfie: { ...EMPTY_DRAFT.selfie, ...(j.selfie || {}) },
      payout: { ...EMPTY_DRAFT.payout, ...(j.payout || {}), },
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

/* [HF-KYC-DIGILOCKER-1] "A DigiLocker sign-in is in progress" flag. The host leaves this page for DigiLocker and comes back,
 * so the page must remember it. Expires after 30 minutes. */
const DL_KEY = 'hf_host_digilocker_pending_v1';
const DL_TTL_MS = 30 * 60_000;

/** Was this page opened with ?dl=return? Read once when the module loads, before the shell rewrites the URL. */
const DL_RETURN_IN_URL: boolean = (() => {
  try { return new URLSearchParams(window.location.search).get('dl') === 'return'; } catch { return false; }
})();

export function markDigilockerPending(): void {
  try { window.localStorage.setItem(DL_KEY, String(Date.now())); } catch { /* storage blocked */ }
}
export function clearDigilockerPending(): void {
  try { window.localStorage.removeItem(DL_KEY); } catch { /* storage blocked */ }
}
/** True when the URL says we just came back, or a recent attempt is still flagged. */
export function digilockerReturning(): boolean {
  if (DL_RETURN_IN_URL) return true;
  try {
    const t = Number(window.localStorage.getItem(DL_KEY));
    return !!t && Date.now() - t < DL_TTL_MS;
  } catch { return false; }
}
/** Remove ?dl= from the address bar, keep the rest. */
export function stripDlParam(): void {
  try {
    const u = new URL(window.location.href);
    if (!u.searchParams.has('dl')) return;
    u.searchParams.delete('dl');
    window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
  } catch { /* ignore */ }
}

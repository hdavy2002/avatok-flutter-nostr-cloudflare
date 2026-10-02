/* kit — [AUMFE-CONSULT-F4-1] Small shared pieces for the three Real Consultants admin screens.
 * Look = the approved mockup (styles/consultants.css, scoped under .consult-ui). No green; min font 13px.
 * Confirmations are in-page dialogs (never window.confirm / alert). */
import { useEffect, useState, type ReactNode } from 'react';
import { capture, captureException } from '../../../lib/analytics';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from '../../../components/ui/alert-dialog';
import { errMessage } from '../adminApi';
import type { BookingStatus, ConsultantStatus } from '../../../lib/consultTypes';
import '../../../styles/consultants.css';

/** Wraps a screen in the consultants look. */
export function ConsultShell({ children }: { children: ReactNode }) {
  return <div className="consult-ui" style={{ borderRadius: 16, padding: '4px 0 24px', background: 'transparent' }}>{children}</div>;
}

export const rupees = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
export const dateIST = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
export const minutesOf = (a: number, b: number) => Math.max(0, Math.round((b - a) / 60000));

export const STATUS_CHIP: Record<ConsultantStatus, string> = { draft: 'chip gold', live: 'chip neel', paused: 'chip red' };
export const STATUS_LABEL: Record<ConsultantStatus, string> = { draft: 'Draft', live: 'Live', paused: 'Paused' };

export const BOOKING_LABEL: Record<BookingStatus, string> = {
  held: 'Held', awaiting_review: 'Awaiting review', confirmed: 'Confirmed', in_call: 'In call', completed: 'Completed',
  no_show_consultant: 'Consultant no-show', no_show_customer: 'Customer no-show', cancelled: 'Cancelled', expired: 'Expired',
};
export function bookingChip(s: BookingStatus): string {
  if (s === 'awaiting_review' || s === 'no_show_consultant') return 'chip red';
  if (s === 'held' || s === 'cancelled' || s === 'expired' || s === 'no_show_customer') return 'chip gold';
  if (s === 'confirmed' || s === 'in_call') return 'chip neel';
  return 'chip';
}

/** consult_admin_ui {action} — one event per admin action, success or not (ok says which). */
export function track(action: string, props: Record<string, unknown> = {}) { capture('consult_admin_ui', { action, ...props }); }
export function fail(action: string, err: unknown, props: Record<string, unknown> = {}): string {
  captureException(err, { where: 'consult_admin_ui', action, ...props });
  track(action, { ok: false, ...props });
  return errMessage(err, 'That did not work. Please try again.');
}

export function Banner({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className="card" style={{ padding: '12px 16px', fontWeight: 800, color: tone === 'error' ? '#9a1f19' : 'var(--teal)', background: tone === 'error' ? '#fbe1dc' : '#f6ead0', borderColor: tone === 'error' ? '#e9b5ad' : '#e2cf9f' }}>
      {children}
    </div>
  );
}

/** In-page confirmation. `children` carries any extra field (reason, UTR…); onConfirm may throw to keep it open. */
export function ConfirmDialog({ open, title, body, confirmLabel, danger, busy, error, disabled, children, onConfirm, onCancel }: {
  open: boolean; title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; error?: string | null; disabled?: boolean;
  children?: ReactNode; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <AlertDialogContent className="consult-ui" style={{ maxWidth: 460 }}>
        <AlertDialogHeader>
          <AlertDialogTitle style={{ fontFamily: 'Comfortaa, sans-serif', color: 'var(--teal)', fontSize: 20 }}>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild><div style={{ fontSize: 15, color: 'var(--ink)' }}>{body}</div></AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        {error && <div role="alert" style={{ color: '#9a1f19', fontWeight: 800, fontSize: 14 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 6 }}>
          <button type="button" className="btn ghost small" onClick={onCancel} disabled={busy}>Go back</button>
          <button type="button" className={`btn small${danger ? ' red' : ''}`} onClick={onConfirm} disabled={busy || disabled}>{busy ? 'Working…' : confirmLabel}</button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Debounced value (search boxes). */
export function useDebounced<T>(v: T, ms = 350): T {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function Spinner({ label }: { label: string }) {
  return <div className="card muted" role="status" style={{ fontWeight: 800 }}>{label}</div>;
}

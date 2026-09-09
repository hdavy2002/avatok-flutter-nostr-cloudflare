/* A commercial ticket/appointment row shared by customer and creator schedules. */
import { useState } from 'react';
import { Card } from '../../components/Card';
import { Pill } from '../../components/Pill';
import { ApiError } from '../../lib/apiClient';
import { cfImage } from '../../lib/config';
import { livePath, sessionPath } from '../../lib/urls';
import type { CommercialScheduleSession, ConfirmationDeliveryStatus } from '../../lib/commercialSessions';

export interface DashboardBooking {
  id: string;
  creator_id?: string;
  buyer_id?: string;
  listing_id?: string;
  kind?: string;
  starts_at?: number;
  ends_at?: number;
  price?: number;
  status?: string;
  title?: string | null;
}

function fmtWhen(ms?: number | null): string | null {
  if (!ms) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
  } catch { return new Date(ms).toUTCString(); }
}

function isCancelled(s: CommercialScheduleSession): boolean {
  const values = [s.entitlement_state, s.order_status, s.booking_status, s.listing_status, s.session_state].filter(Boolean).map((v) => String(v).toLowerCase());
  return values.some((v) => v.includes('cancel') || v === 'refunded' || v === 'revoked' || v.includes('no_show')) || Boolean(s.refund_receipt_id);
}

function statusText(s: CommercialScheduleSession, past?: boolean): { label: string; tone: 'ok' | 'no' | 'hint' | 'plain' } {
  if (isCancelled(s)) return { label: s.entitlement_state === 'refunded' || s.refund_receipt_id ? 'Refunded' : 'Cancelled', tone: 'no' };
  if (s.session_state === 'backstage') return { label: s.role === 'host' || s.role === 'creator' ? 'Backstage' : 'Waiting for creator', tone: 'hint' };
  if (s.session_state === 'live' || s.listing_status === 'live') return { label: 'Live now', tone: 'ok' };
  if (s.session_state === 'ended' || s.booking_status === 'completed' || s.listing_status === 'completed' || past) return { label: 'Ended', tone: 'hint' };
  if (s.order_status === 'pending') return { label: 'Processing', tone: 'hint' };
  return { label: 'Scheduled', tone: 'plain' };
}

function actionFor(s: CommercialScheduleSession, past?: boolean): { href: string; label: string } | null {
  const action = String(s.action ?? s.allowed_actions?.[0] ?? s.actions?.[0] ?? '').toLowerCase();
  if (past || isCancelled(s) || !action || action === 'ended' || action === 'none') return null;
  if (s.role === 'host' || s.role === 'creator') {
    if (s.kind === 'live_event') return { href: `/live/${encodeURIComponent(s.listing_id)}/host`, label: action === 'start' ? 'Start live' : 'Rejoin controls' };
    if (s.booking_id) return { href: sessionPath(s.booking_id), label: 'Join appointment' };
  }
  if (s.kind === 'live_event') return { href: livePath(s.listing_id), label: 'Watch event' };
  if (s.booking_id) return { href: sessionPath(s.booking_id), label: 'Join appointment' };
  return null;
}

export interface TicketCardProps {
  booking?: DashboardBooking;
  session?: CommercialScheduleSession;
  past?: boolean;
  onResend?: (orderId: string) => Promise<{ delivery_status?: ConfirmationDeliveryStatus | null }>;
}

export function TicketCard({ booking, session: supplied, past, onResend }: TicketCardProps) {
  const session: CommercialScheduleSession = supplied ?? {
    kind: booking?.kind ?? 'consult_1to1', listing_id: booking?.listing_id ?? '', booking_id: booking?.id,
    title: booking?.title, starts_at: booking?.starts_at, ends_at: booking?.ends_at, booking_status: booking?.status,
    price: booking?.price, role: 'buyer',
  };
  const viewer = actionFor(session, past);
  const status = statusText(session, past);
  const [resendState, setResendState] = useState<ConfirmationDeliveryStatus | 'sending' | null>(null);
  const canResend = Boolean(onResend && session.order_id && session.role !== 'host' && session.role !== 'creator' && !isCancelled(session));

  async function resend() {
    if (!onResend || !session.order_id || resendState === 'sending') return;
    setResendState('sending');
    try { const result = await onResend(session.order_id); setResendState(result.delivery_status ?? 'unavailable'); }
    catch (e) { setResendState(e instanceof ApiError ? 'failed' : 'unavailable'); }
  }

  return (
    <Card shadow="sm" fillClassName={past ? 'bg-paper2' : 'bg-card'}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {session.counterparty_avatar_url && <img src={cfImage(session.counterparty_avatar_url, { width: 72 })} alt="" className="mt-0.5 h-10 w-10 shrink-0 rounded-full border-zine border-ink object-cover" loading="lazy" />}
          <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-display font-semibold text-[17px] text-ink">{session.title ?? (session.kind === 'live_event' ? 'Live event' : 'AvaTOK appointment')}</span>
          {session.starts_at && <span className="font-mono text-[13px] font-bold uppercase tracking-[0.04em] text-inkSoft">{fmtWhen(session.starts_at)}</span>}
          {session.counterparty_name && <span className="font-body text-[13px] font-bold text-inkSoft">{session.role === 'host' || session.role === 'creator' ? 'Customer: ' : 'Creator: '}{session.counterparty_name}</span>}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Pill kind={status.tone}>{status.label}</Pill>
            {session.price != null && <Pill kind="plain">{Number(session.price).toLocaleString()} Tokens</Pill>}
            <Pill kind="hint">{session.kind === 'live_event' ? 'Live event' : '1:1'}</Pill>
          </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <a href={`/l/${encodeURIComponent(session.listing_id)}`} className="font-body text-[13px] font-bold text-inkSoft underline">View details</a>
          {canResend && <button type="button" onClick={() => void resend()} disabled={resendState === 'sending'} className="rounded-full border-zine border-ink bg-paper px-3 py-2 font-mono text-[12px] font-bold uppercase tracking-[0.04em] text-inkSoft shadow-zine-xs disabled:opacity-50">{resendState === 'sending' ? 'Sending…' : resendState ? `Email ${resendState.replace('_', ' ')}` : 'Resend email'}</button>}
          {viewer && <a href={viewer.href} className="inline-flex items-center gap-1.5 rounded-full border-zine border-ink bg-lime px-4 py-2.5 font-display font-semibold text-[15px] text-ink no-underline shadow-zine-sm active:translate-x-[2px] active:translate-y-[2px] transition-transform duration-zine">{viewer.label} →</a>}
        </div>
      </div>
    </Card>
  );
}

export default TicketCard;

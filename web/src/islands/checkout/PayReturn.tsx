/* [WEB-PAY-RETURN-1] PayReturn — the browser-return landing page for a gateway that
 * redirects the buyer AWAY from avatok.ai to pay (Paytm's Show Payment Page today;
 * any future redirect-based gateway lands here too).
 *
 * The buyer arrives here COLD: they left the site, paid (or didn't) on the gateway's
 * own page, and the WORKER's `payWebhook` browser-callback wrapper (pay.ts:263-294)
 * 303-redirects them back to:
 *
 *     /pay/return?gateway=<id>&order_id=<ORDERID>&ok=1|0
 *
 * `ok` is a hint the worker computed from its own webhook handling — a comment in
 * pay.ts says plainly it is "a hint for the first paint only", never proof money
 * moved. This component treats it exactly that way: it seeds the FIRST paint's
 * copy ("Confirming your payment…" either way) and nothing else. The only thing
 * that ever says "you're booked" is `GET /api/pay/:gateway/status` returning
 * `status: 'paid'` — the same authoritative endpoint GatewayPicker.tsx already
 * polls, so this file reuses its poll cadence (2.5s × 24 ≈ 60s) rather than
 * inventing a second timing scheme.
 *
 * `onRedirecting` in gatewaySheet.ts stashes `{ gateway, orderId, listingId }` into
 * sessionStorage right before the Paytm form submits, keyed by orderId once the
 * order response is known. That is a NICE-TO-HAVE, not a dependency: sessionStorage
 * for a cross-domain redirect survives in every real browser, but this component
 * must still render something correct if it comes back empty (private tab, a
 * gateway that clears storage, etc.) — the query string is the source of truth for
 * `gateway`/`order_id`; sessionStorage only ever fills in `listingId` as a nicety
 * for the "back to the listing" link on a failure.
 */
import { useEffect, useRef, useState } from 'react';
import { request } from '../../lib/apiClient';
import { getActiveTokenWaited } from '../../lib/clerk';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { inr } from '../../lib/money';
import { capture } from '../../lib/analytics';
import type { GatewayId, PayStatusResponse } from './types';
import type { Listing } from '../../lib/types';

const POLL_MS = 2500;
const POLL_ATTEMPTS = 24; // ~60s — same budget GatewayPicker.tsx polls with.

// Anchor-styled CTA — mirrors Confirmation.tsx's `ctaClass`. A real <a>, not a
// <Button> wrapped in an <a>: this page's actions are all navigations (to a
// viewer route, to My Bookings, back to /book/:id), and nesting an interactive
// <button> inside an <a> is invalid HTML that Confirmation.tsx already avoids.
function ctaClass(variant: 'lime' | 'blue' = 'lime'): string {
  const fill = variant === 'lime' ? 'bg-lime text-ink' : 'bg-blue text-ink';
  return [
    'inline-flex items-center justify-center gap-2.5 select-none no-underline',
    'rounded-full border-zine border-ink shadow-zine-sm',
    fill,
    'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed',
    'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[-0.2px]',
  ].join(' ');
}

/** What onRedirecting persists in gatewaySheet.ts, read back here. Every field is
 *  optional on read — an empty or missing blob must degrade gracefully. */
interface StashedReturn {
  gateway?: string;
  orderId?: string;
  listingId?: string;
}

const STASH_KEY = 'avatok_pay_return';

function readStash(): StashedReturn {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STASH_KEY) : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StashedReturn) : {};
  } catch {
    return {};
  }
}

type Phase = 'confirming' | 'confirmed' | 'failed' | 'timeout' | 'unmatched';

function fmtWhen(ms?: number | null): string | null {
  if (!ms) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toUTCString();
  }
}

function viewerFor(listing: Listing | null, orderId: string): { href: string; label: string } {
  // The status endpoint never returns a booking id (see PayStatusResponse's header
  // in types.ts) — for a consult there is nothing to build a direct room link from
  // here, so send them to their bookings list, where the confirmed session appears.
  void orderId;
  if (listing && (listing.kind === 'live' || listing.kind === 'live_event')) {
    return { href: `/watch/${encodeURIComponent(listing.id)}`, label: 'Watch live' };
  }
  return { href: '/dashboard/bookings', label: 'View in My Bookings' };
}

export interface PayReturnProps {
  /** `gateway` query param, already validated server-side by the Astro page. */
  gateway: GatewayId | null;
  /** `order_id` query param — may be empty if the worker couldn't recover it. */
  orderId: string;
}

export function PayReturn({ gateway, orderId }: PayReturnProps) {
  const stash = useRef<StashedReturn>(readStash());
  const [phase, setPhase] = useState<Phase>(gateway && orderId ? 'confirming' : 'unmatched');
  const [status, setStatus] = useState<PayStatusResponse | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [authError, setAuthError] = useState(false);

  const listingIdHint = stash.current.listingId ?? null;

  // [WEB-POSTHOG-1] §2.5 checkout_return — fires once, whichever way this page
  // resolves (including the 'unmatched' case seeded at mount).
  useEffect(() => {
    if (phase === 'unmatched') {
      try {
        capture('checkout_return', { gateway: gateway ?? 'unknown', outcome: 'unmatched' });
      } catch {
        /* best-effort */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!gateway || !orderId) return; // 'unmatched' — nothing to poll
    let cancelled = false;

    async function run() {
      // The buyer authenticated before leaving for the gateway (GatewayPicker requires
      // a session to create the order), so the same session — Clerk or guest — should
      // still be live in this browser. Wait briefly for it rather than opening any gate;
      // a payment return page must never block on a fresh sign-in.
      const token = await getActiveTokenWaited(6000);
      if (cancelled) return;
      if (!token) {
        setAuthError(true);
        setPhase('timeout');
        try {
          capture('checkout_return', { gateway, outcome: 'no_session' });
        } catch {
          /* best-effort */
        }
        return;
      }

      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        if (cancelled) return;
        try {
          const s = await request<PayStatusResponse>(`/api/pay/${gateway}/status`, {
            auth: token,
            query: { order_id: orderId },
          });
          if (cancelled) return;
          setStatus(s);
          if (s.status === 'paid') {
            setPhase('confirmed');
            try {
              capture('checkout_return', { gateway, outcome: 'confirmed' });
            } catch {
              /* best-effort */
            }
            if (s.listing_id) {
              request<Listing>(`/api/listings/${encodeURIComponent(s.listing_id)}`)
                .then((l) => !cancelled && setListing(l))
                .catch(() => {
                  /* the confirmed state still works without the extra detail */
                });
            }
            return;
          }
          if (s.status === 'failed' || s.status === 'refunded') {
            setPhase('failed');
            try {
              capture('checkout_return', { gateway, outcome: s.status });
            } catch {
              /* best-effort */
            }
            return;
          }
        } catch {
          /* transient — keep polling until the attempt budget runs out, same
           * discipline as GatewayPicker.tsx's pollStatus */
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      if (!cancelled) {
        setPhase('timeout');
        try {
          capture('checkout_return', { gateway, outcome: 'timeout' });
        } catch {
          /* best-effort */
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, orderId]);

  // ── unmatched: no order_id the worker could recover ──────────────────────
  if (phase === 'unmatched') {
    return (
      <Card fillClassName="bg-paper2" shadow="sm">
        <div className="flex flex-col gap-3">
          <span className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">Payment return</span>
          <p className="font-body font-bold text-[15px] text-ink">
            We couldn’t match this payment to a booking. If money left your account, it will still show up on your
            account shortly — check My Bookings. If you’re not sure, that’s the safest place to look first.
          </p>
          <div className="mt-1">
            <a href="/dashboard/bookings" className={ctaClass('blue')}>
              Go to My Bookings
            </a>
          </div>
        </div>
      </Card>
    );
  }

  // ── confirming: poll in flight ────────────────────────────────────────────
  if (phase === 'confirming') {
    return (
      <Card fillClassName="bg-paper2" shadow="sm">
        <div className="flex items-center gap-3 p-2">
          <Spinner size={22} />
          <span className="font-body font-bold text-[15px] text-inkSoft">Confirming your payment…</span>
        </div>
      </Card>
    );
  }

  // ── confirmed ──────────────────────────────────────────────────────────────
  if (phase === 'confirmed') {
    const viewer = viewerFor(listing, orderId);
    const when = fmtWhen(listing?.starts_at ?? null);
    const title = listing?.title ?? 'your booking';
    return (
      <Card fillClassName="bg-mint" shadow="lg">
        <div className="flex flex-col gap-3">
          <span className="font-mono font-bold uppercase text-[14px] tracking-[0.1em] text-ink">Confirmed</span>
          <h2 className="font-display font-semibold text-[24px] leading-tight text-ink">You’re booked: {title}</h2>
          {when && <p className="font-body font-bold text-[15px] text-ink/80">{when}</p>}
          {status?.total_amount != null && (
            <p className="font-body font-bold text-[14px] text-ink/70">Paid {inr(status.total_amount)}.</p>
          )}
          <p className="font-body font-bold text-[14px] text-ink/70">
            We emailed your confirmation and reminders.
          </p>
          <div className="mt-1 flex flex-col gap-2">
            <a href={viewer.href} className={`${ctaClass('lime')} w-full`}>
              {viewer.label} →
            </a>
            <a
              href="/dashboard/bookings"
              className="text-center font-mono font-bold uppercase text-[14px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
            >
              All my bookings
            </a>
          </div>
        </div>
      </Card>
    );
  }

  // ── failed ─────────────────────────────────────────────────────────────────
  if (phase === 'failed') {
    const retryHref = listingIdHint ? `/book/${encodeURIComponent(listingIdHint)}` : status?.listing_id ? `/book/${encodeURIComponent(status.listing_id)}` : '/dashboard/bookings';
    return (
      <Card fillClassName="bg-paper2" shadow="sm">
        <div className="flex flex-col gap-3">
          <span className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-coral">Payment didn’t go through</span>
          <p className="font-body font-bold text-[15px] text-ink">
            That payment did not go through. You have not been charged — no money left your account for this
            attempt.
          </p>
          <div className="mt-1">
            <a href={retryHref} className={ctaClass('lime')}>
              Try again
            </a>
          </div>
        </div>
      </Card>
    );
  }

  // ── timeout — honest ambiguity ───────────────────────────────────────────
  const timeoutRetryListingId = listingIdHint ?? status?.listing_id ?? null;
  return (
    <Card fillClassName="bg-paper2" shadow="sm">
      <div className="flex flex-col gap-3">
        <span className="font-mono font-bold uppercase text-[13px] tracking-[0.08em] text-inkSoft">Still confirming</span>
        <p className="font-body font-bold text-[14px] text-ink">
          {authError
            ? 'We couldn’t confirm your session in this browser, so we can’t check this payment’s status here. '
            : 'This is taking longer than usual. '}
          If the money left your account, your booking will confirm shortly — check My Bookings. If nothing was
          charged, it’s safe to try again — please don’t pay twice for the same booking.
        </p>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <a href="/dashboard/bookings" className={ctaClass('blue')}>
            Check My Bookings
          </a>
          {timeoutRetryListingId && (
            <a href={`/book/${encodeURIComponent(timeoutRetryListingId)}`} className={ctaClass('lime')}>
              Try again
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}

export default PayReturn;

// Re-exported for gatewaySheet.ts's onRedirecting handler — keeps the sessionStorage
// key and shape in exactly one place rather than duplicating the string literal.
export function stashPayReturn(v: StashedReturn): void {
  try {
    sessionStorage?.setItem(STASH_KEY, JSON.stringify(v));
  } catch {
    /* private mode / storage full — the return page still works without it */
  }
}
export { STASH_KEY as PAY_RETURN_STASH_KEY };

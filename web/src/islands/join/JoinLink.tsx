/* [JOIN-LINK-1] /j/<token> — the link in the confirmation email.
 *
 * THE RULE (owner, 2026-09-12; RULEBOOK-PAID-SESSIONS §7): "He clicks the link
 * in his confirmation email, a browser opens on phone, iPad or desktop, he is
 * asked for camera/mic permission... He never logs into a dashboard."
 *
 * WHAT THIS PAGE USED TO DO, AND WHY IT WAS WRONG. `/j/[token].astro` resolved
 * the token server-side and 302'd to /live/<id> or /session/<id>. Those pages
 * gate on `requireGuestAuth()`, which knows nothing about the token that just
 * brought him there — so the customer, who had already paid and whose identity
 * was sitting in the link he clicked, was met by an email-code form on the way
 * into his own session. The redirect carried the destination and dropped the
 * identity.
 *
 * WHAT IT DOES NOW. It POSTs the token to the Worker, which verifies the
 * signature, re-checks the live entitlement, and mints a Clerk SIGN-IN TICKET
 * for that account (worker/src/lib/clerk_ticket.ts explains why a ticket and
 * not a JWT: the Worker holds no Clerk signing key). Redeeming the ticket here
 * produces the very same Clerk session the email-code gate would have produced,
 * in the same place — so `getActiveToken()` / `freshAppJwt()` in the room island
 * find it without knowing this page exists. Then we navigate to the room.
 *
 * ALREADY SIGNED IN AS SOMEONE ELSE. Redeeming replaces the active session with
 * the account the link belongs to. That is the correct answer for a link that a
 * specific person was emailed: the alternative — refusing, or joining as the
 * wrong account — is the `not_yours` dead end this whole change exists to
 * remove. The masked address is shown while it happens so nobody is switched
 * silently.
 */
import { useEffect, useRef, useState } from 'react';
import { useSignIn } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { IslandBoundary } from '../../components/IslandBoundary';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { request, ApiError } from '../../lib/apiClient';
import { capture, captureException } from '../../lib/analytics';
import { bootstrapAccount } from '../auth/passwordless';

interface JoinLinkResponse {
  ticket: string;
  ticket_kind?: string;
  destination: string;
  destination_kind?: 'live' | 'consult';
  account_email_masked?: string | null;
}

type Phase = 'opening' | 'expired' | 'invalid' | 'error';

/** Only ever navigate to a room path on this origin (same rule as urls.ts). */
function safeDestination(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v || v.startsWith('//')) return null;
  return /^\/(?:live|session|consult)\/[A-Za-z0-9._~:-]{1,128}$/.test(v) ? v : null;
}

const ctaClass =
  'inline-flex items-center justify-center gap-2.5 select-none no-underline w-full ' +
  'rounded-zine border-zine border-ink shadow-zine-sm bg-lime text-ink ' +
  'transition-transform duration-zine ease-out active:translate-x-[2px] active:translate-y-[2px] active:shadow-zine-pressed ' +
  'px-6 py-3.5 font-display font-semibold text-[19px] leading-none tracking-[0.02em]';

function Inner({ token }: { token: string }) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [phase, setPhase] = useState<Phase>('opening');
  const [masked, setMasked] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (!isLoaded || ran.current) return;
    ran.current = true;
    let cancelled = false;

    (async () => {
      let res: JoinLinkResponse;
      try {
        res = await request<JoinLinkResponse>(
          `/api/join-link/${encodeURIComponent(token)}/session`, { method: 'POST' },
        );
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        // 410 is the ONLY "this was yours and it is over" answer. Everything
        // else is either a link that is not ours (404) or our own fault (5xx) —
        // saying "expired" for those would send someone hunting for a booking
        // that was never the problem.
        const outcome = status === 410 ? 'expired' : status === 404 ? 'invalid' : 'error';
        if (!cancelled) setPhase(outcome as Phase);
        capture('join_link_opened', { kind: 'unknown', outcome: outcome === 'error' ? 'invalid' : outcome, status });
        if (outcome === 'error') captureException(e, { code: 'join_link_failed', status });
        return;
      }

      const destination = safeDestination(res.destination);
      if (!destination) {
        setPhase('error');
        capture('join_link_opened', { kind: 'unknown', outcome: 'invalid', reason: 'bad_destination' });
        return;
      }
      const kind = res.destination_kind ?? (destination.startsWith('/live/') ? 'live' : 'consult');
      if (!cancelled) setMasked(res.account_email_masked ?? null);

      try {
        if (!signIn) throw new Error('clerk_not_ready');
        const attempt = await signIn.create({ strategy: 'ticket', ticket: res.ticket } as never) as unknown as
          { status?: string | null; createdSessionId?: string | null };
        if (!attempt.createdSessionId) throw new Error(`ticket_status_${attempt.status ?? 'unknown'}`);
        await setActive?.({ session: attempt.createdSessionId });
        // Same tail as the email-code gate: make sure the avaTOK-side row exists
        // before the room asks the Worker anything. Never throws.
        await bootstrapAccount();
      } catch (e) {
        if (!cancelled) setPhase('error');
        capture('join_link_opened', { kind, outcome: 'invalid', reason: 'ticket_redeem_failed' });
        captureException(e, { code: 'join_link_ticket_redeem_failed' });
        return;
      }

      capture('join_link_opened', { kind, outcome: 'joined' });
      // `replace`, not `assign`: Back from the room should return to wherever he
      // came from (his mail client), never re-run a one-shot ticket redemption.
      location.replace(destination);
    })();

    return () => { cancelled = true; };
  }, [isLoaded, signIn, setActive, token]);

  if (phase === 'opening') {
    return (
      <Card fillClassName="bg-card" shadow="lg">
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <Spinner size={22} />
          <p className="font-body font-bold text-[15px] text-inkSoft">Opening your session…</p>
          {masked && (
            <p className="font-body font-bold text-[13px] text-inkMute">Joining as {masked}</p>
          )}
        </div>
      </Card>
    );
  }

  const copy = phase === 'expired'
    ? {
      title: 'This link has expired',
      body: 'Join links stay open until 24 hours after the session ends. Sign in to see your bookings and receipts.',
    }
    : phase === 'invalid'
      ? {
        title: 'This link isn’t valid',
        body: 'It may have been copied incompletely. Sign in to see your bookings and open the session from there.',
      }
      : {
        title: 'We couldn’t open your session',
        body: 'Something went wrong on our end. Sign in to see your bookings, or try the link again in a moment.',
      };

  return (
    <Card fillClassName="bg-card" shadow="lg">
      <div className="flex flex-col gap-4">
        <h1 className="font-display font-semibold text-[24px] leading-tight text-ink">{copy.title}</h1>
        <p className="font-body font-bold text-[15px] text-inkSoft">{copy.body}</p>
        <a href="/dashboard/bookings" className={ctaClass}>Sign in to see your bookings →</a>
      </div>
    </Card>
  );
}

export function JoinLink({ token }: { token: string }) {
  return (
    <IslandBoundary island="join-link">
      <ClerkIsland>
        <Inner token={token} />
      </ClerkIsland>
    </IslandBoundary>
  );
}

export default JoinLink;

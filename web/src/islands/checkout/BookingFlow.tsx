/* Phase B — BookingFlow: the guest-checkout state machine.
 *
 *   pick → identify → pay → confirm
 *
 * • pick:     SlotPicker chooses a calendar slot (consult/event/live) or an
 *             agent session. Browsing here is still free; the email gate has
 *             NOT fired yet.
 * • identify: the gate fires HERE (MASTER-PROMPT §4b) via the shared
 *             requireGuestAuth() — email → OTP → silent guest account → JWT.
 *             If a session already exists we skip straight to pay.
 * • pay:      PayStep tops up via existing Stripe if needed, then books.
 * • confirm:  Confirmation shows the booking + the correct viewer deep-link.
 *
 * The whole tree is wrapped in <ClerkIsland> so requireGuestAuth() has its gate
 * host mounted. This is the ONE island the /book/[id].astro page hydrates.
 */
import { useState } from 'react';
import { ClerkIsland, getActiveToken } from '../../lib/clerk';
import { EmailCodeSignIn } from '../auth/EmailCodeSignIn';
import type { Listing } from '../../lib/types';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';
import { SlotPicker } from './SlotPicker';
import { PayStep } from './PayStep';
import { Confirmation } from './Confirmation';
import type { BookSelection, BookingResult, Step } from './types';

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ['pick', 'identify', 'pay', 'confirm'];
  const labels: Record<Step, string> = { pick: 'Choose', identify: 'You', pay: 'Pay', confirm: 'Done' };
  const i = order.indexOf(step);
  return (
    <div className="mb-5 flex items-center gap-2">
      {order.map((s, idx) => (
        <div key={s} className="flex items-center gap-2">
          <span
            className={[
              'flex h-7 items-center rounded-full border-zine border-ink px-3 font-mono font-bold uppercase text-[11px] tracking-[0.06em]',
              idx < i ? 'bg-mint text-ink' : idx === i ? 'bg-lime text-ink shadow-zine-xs' : 'bg-card text-inkMute',
            ].join(' ')}
          >
            {labels[s]}
          </span>
          {idx < order.length - 1 && <span className="h-[2.5px] w-4 bg-inkMute" />}
        </div>
      ))}
    </div>
  );
}

function FlowInner({ listing }: { listing: Listing }) {
  const [step, setStep] = useState<Step>('pick');
  const [token, setToken] = useState<string | null>(null);
  const [selection, setSelection] = useState<BookSelection | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [working, setWorking] = useState(false);

  // [BUY-OTP-1] `requireGuestAuth()` is GONE from this flow.
  //
  // It resolved the HMAC guest token from /api/identity/guest and handed it to
  // /api/id/email/{start,verify} — routes that call requireUser, which only accepts a
  // Clerk RS256 JWT. Every new visitor got a 401 and checkout could not complete, with
  // or without a payment gateway. The sign-in step is now Clerk's own email-code flow
  // (EmailCodeSignIn), which ends with a real session, so getActiveToken() returns a
  // token the Worker actually accepts.
  //
  // Called by SlotPicker when it needs the slots endpoint (which requires auth).
  async function ensureAuth(): Promise<string> {
    const existing = await getActiveToken();
    if (existing) {
      setToken(existing);
      return existing;
    }
    // No session yet: send them through the identify step rather than throwing. The
    // picker's auth-only reads simply wait until there is a session.
    setStep('identify');
    throw new Error('sign-in required');
  }

  /** Pull the freshly-minted Clerk token and move on. */
  async function afterSignIn() {
    setWorking(true);
    try {
      const t = await getActiveToken();
      if (!t) { setStep('pick'); return; }
      setToken(t);
      setStep(selection ? 'pay' : 'pick');
    } finally { setWorking(false); }
  }

  async function onSelect(sel: BookSelection) {
    setSelection(sel);
    const existing = await getActiveToken();
    if (existing) { setToken(existing); setStep('pay'); return; }
    // No session — show the email/code step inline. No modal, no redirect out of
    // checkout, and no password field.
    setStep('identify');
  }

  return (
    <div className="mx-auto w-full max-w-md">
      <StepDots step={step} />

      {step === 'pick' && (
        <SlotPicker listing={listing} token={token} onNeedAuth={ensureAuth} onSelect={onSelect} />
      )}

      {step === 'identify' && (
        <Card>
          {working ? (
            <div className="flex items-center gap-3">
              <Spinner size={22} />
              <span className="font-body font-bold text-[15px] text-inkSoft">One moment…</span>
            </div>
          ) : (
            <EmailCodeSignIn
              reason="so we can send your booking"
              onAuthed={() => void afterSignIn()}
              onCancel={() => setStep('pick')}
            />
          )}
        </Card>
      )}

      {step === 'pay' && selection && token && (
        <PayStep
          selection={selection}
          token={token}
          onBack={() => setStep('pick')}
          onBooked={(r) => {
            setResult(r);
            setStep('confirm');
          }}
        />
      )}

      {step === 'confirm' && selection && result && (
        <Confirmation listing={listing} selection={selection} result={result} />
      )}
    </div>
  );
}

export interface BookingFlowProps {
  listing: Listing;
}

/** The hydrated checkout island. Wraps the flow in the Clerk/GuestGate host. */
export function BookingFlow({ listing }: BookingFlowProps) {
  return (
    <ClerkIsland>
      <FlowInner listing={listing} />
    </ClerkIsland>
  );
}

export default BookingFlow;

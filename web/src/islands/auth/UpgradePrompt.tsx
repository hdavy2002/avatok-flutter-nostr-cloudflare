/* Phase B — UpgradePrompt.
 *
 * A *quiet, never-blocking* nudge to turn the silent guest account into a full
 * account (set a password / sign in with Clerk). Per MASTER-PROMPT §4b the
 * guest is already a valid authenticated user — upgrading is optional and only
 * adds password recovery + higher identity tiers.
 *
 * Flow (ladder.ts guestUpgrade):
 *   1. user authenticates a full Clerk identity (SignInButton),
 *   2. with the new Clerk session JWT we call
 *        POST /api/identity/upgrade { guest_token }
 *      which re-keys the reserved handle onto the Clerk uid.
 *
 * The guest_token lives in localStorage under the shared key written by
 * lib/clerk.tsx (`avatok_guest_jwt`). We read it directly here; Phase Z may
 * promote a small accessor onto lib/clerk.tsx (noted in the Graphiti episode).
 */
import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { SignInButton } from '../../lib/clerk';
import { request, ApiError } from '../../lib/apiClient';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';

const GUEST_JWT_KEY = 'avatok_guest_jwt'; // mirrors lib/clerk.tsx

export interface UpgradePromptProps {
  /** Short reason shown to the user (e.g. "This room needs a verified account"). */
  reason?: string;
  /** Called after a successful upgrade (or when the user is already full-account). */
  onUpgraded?: () => void;
  /** Called if the user dismisses — booking never blocks on upgrade. */
  onDismiss?: () => void;
  compact?: boolean;
}

export function UpgradePrompt({ reason, onUpgraded, onDismiss, compact }: UpgradePromptProps) {
  const { isSignedIn, getToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function finishUpgrade() {
    setBusy(true);
    setError(null);
    try {
      const clerkJwt = await getToken();
      if (!clerkJwt) {
        setError('Sign in first, then we’ll link your bookings.');
        return;
      }
      const guestToken =
        typeof localStorage !== 'undefined' ? localStorage.getItem(GUEST_JWT_KEY) : null;
      // If there is no guest to upgrade, the Clerk account already stands alone.
      if (guestToken) {
        await request('/api/identity/upgrade', {
          method: 'POST',
          auth: clerkJwt,
          body: { guest_token: guestToken },
        });
      }
      setDone(true);
      onUpgraded?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.error : 'Could not link your account. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card fillClassName="bg-mint" shadow={compact ? 'sm' : 'lg'}>
        <p className="font-display font-semibold text-[16px] text-ink">
          ✓ Account secured. You can sign in from any device now.
        </p>
      </Card>
    );
  }

  return (
    <Card fillClassName="bg-lilac" shadow={compact ? 'sm' : 'lg'}>
      <div className="flex flex-col gap-3">
        <div>
          <span className="font-mono font-bold uppercase text-[11px] tracking-[0.1em] text-ink">
            Optional
          </span>
          <h3 className="mt-1 font-display font-semibold text-[19px] leading-tight text-ink">
            Save a password?
          </h3>
          <p className="mt-1 font-body font-bold text-[14px] text-ink/80">
            {reason ??
              'Keep your bookings and wallet if you switch devices. Takes a few seconds — totally optional.'}
          </p>
        </div>

        {error && (
          <p className="font-mono font-bold uppercase text-[12px] tracking-[0.04em] text-coral">
            ⚠ {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {isSignedIn ? (
            <Button variant="lime" loading={busy} label="Link my account" onClick={finishUpgrade} />
          ) : (
            <SignInButton mode="modal">
              <Button variant="lime" label="Set a password" />
            </SignInButton>
          )}
          {onDismiss && (
            <button
              type="button"
              className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
              onClick={onDismiss}
            >
              Maybe later
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

export default UpgradePrompt;

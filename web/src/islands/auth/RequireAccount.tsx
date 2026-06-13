/* RequireAccount — a client-side gate for CREATE/manage surfaces (listing
 * creation, the vision/voice studio). Mirrors the app's AccountGate: browsing is
 * free, but creating anything needs a session.
 *
 * Renders its children only when a session (Clerk or guest) exists. Otherwise it
 * shows a sign-in prompt and (optionally) opens the guest gate. Wrap any island
 * whose content must be account-gated, e.g.:
 *   <RequireAccount label="Create a vision agent"><StudioFlow/></RequireAccount>
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ClerkIsland, getActiveToken, requireGuestAuth, SignInButton } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Spinner } from '../../components/Spinner';

function Gate({ label, children }: { label: string; children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void (async () => {
      setToken(await getActiveToken());
      setChecked(true);
    })();
  }, []);

  if (!checked) {
    return (
      <div className="flex items-center gap-3 p-6">
        <Spinner size={22} />
      </div>
    );
  }

  if (token) return <>{children}</>;

  return (
    <Card shadow="lg">
      <div className="flex flex-col gap-3">
        <h2 className="font-display font-semibold text-[22px] text-ink">Sign in to continue</h2>
        <p className="font-body font-bold text-[15px] text-inkSoft">
          {label} needs an account. It's quick — your email gets you in, and you can finish setting up your
          creator profile after.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {CLERK_PUBLISHABLE_KEY ? (
            <SignInButton mode="modal" forceRedirectUrl={typeof location !== 'undefined' ? location.pathname : '/dashboard'}>
              <Button variant="lime" label="Sign in / sign up" />
            </SignInButton>
          ) : (
            <Button
              variant="lime"
              label="Continue with email"
              onClick={async () => {
                try {
                  const t = await requireGuestAuth();
                  setToken(t);
                } catch {
                  /* cancelled */
                }
              }}
            />
          )}
          <a
            href="/marketplace"
            className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
          >
            Browse instead
          </a>
        </div>
      </div>
    </Card>
  );
}

export function RequireAccount({ label = 'This', children }: { label?: string; children: ReactNode }) {
  return (
    <ClerkIsland>
      <Gate label={label}>{children}</Gate>
    </ClerkIsland>
  );
}

export default RequireAccount;

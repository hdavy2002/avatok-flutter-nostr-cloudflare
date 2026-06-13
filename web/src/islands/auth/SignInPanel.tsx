/* Phase B — SignInPanel: the island behind /sign-in.
 *
 * Most fans never reach this page (guest checkout captures email at the gate).
 * It exists for the full-account path: Clerk's hosted <SignIn/> rendered inside
 * Phase 0's ClerkProvider (ClerkIsland). When no Clerk key is configured yet we
 * fall back to a friendly note + a link back to browsing.
 */
import { SignIn, ClerkLoading, ClerkLoaded } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { clerkAppearance } from '../../lib/clerkAppearance';
import { Card } from '../../components/Card';
import { AuthPanelSkeleton } from './AuthPanelSkeleton';

export function SignInPanel() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <Card shadow="lg">
        <div className="flex flex-col gap-3">
          <h2 className="font-display font-semibold text-[20px] text-ink">Sign-in isn’t set up yet</h2>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            You don’t need an account to book — just your email at checkout.
          </p>
          <a
            href="/explore"
            className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
          >
            Browse the marketplace →
          </a>
        </div>
      </Card>
    );
  }
  // Honour ?next=<path> appended by the dashboard guard; default to /dashboard.
  let next = '/dashboard';
  try {
    const n = new URLSearchParams(location.search).get('next');
    if (n && n.startsWith('/')) next = n;
  } catch {
    /* SSR / no location */
  }
  return (
    <ClerkIsland>
      <div className="flex justify-center">
        <ClerkLoading>
          <AuthPanelSkeleton />
        </ClerkLoading>
        <ClerkLoaded>
          <SignIn routing="hash" signUpUrl="/sign-up" forceRedirectUrl={next} signInForceRedirectUrl={next} appearance={clerkAppearance} />
        </ClerkLoaded>
      </div>
    </ClerkIsland>
  );
}

export default SignInPanel;

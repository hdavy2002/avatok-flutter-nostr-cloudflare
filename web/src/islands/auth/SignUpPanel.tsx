/* SignUpPanel — the island behind /sign-up. Clerk's hosted <SignUp/> inside the
 * shared ClerkProvider. When no Clerk key is configured we fall back to a note +
 * a link back to browsing (guest checkout still covers most fans). Honours
 * ?next= for post-signup redirect, defaulting to /dashboard.
 */
import { SignUp } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';
import { clerkAppearance } from '../../lib/clerkAppearance';
import { Card } from '../../components/Card';

export function SignUpPanel() {
  if (!CLERK_PUBLISHABLE_KEY) {
    return (
      <Card shadow="lg">
        <div className="flex flex-col gap-3">
          <h2 className="font-display font-semibold text-[20px] text-ink">Sign-up isn’t set up yet</h2>
          <p className="font-body font-bold text-[15px] text-inkSoft">
            You don’t need an account to book — just your email at checkout.
          </p>
          <a
            href="/marketplace"
            className="font-mono font-bold uppercase text-[12px] tracking-[0.06em] text-blueInk underline decoration-blue decoration-2 underline-offset-2"
          >
            Browse the marketplace →
          </a>
        </div>
      </Card>
    );
  }
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
        <SignUp routing="hash" signInUrl="/sign-in" forceRedirectUrl={next} signUpForceRedirectUrl={next} appearance={clerkAppearance} />
      </div>
    </ClerkIsland>
  );
}

export default SignUpPanel;

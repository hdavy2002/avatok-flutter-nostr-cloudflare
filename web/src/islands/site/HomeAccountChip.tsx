/* HomeAccountChip — the signed-in affordance for the STATIC home page.
 *
 * The home page (`src/pages/index.astro`) is a self-contained, prerendered HTML
 * document injected via `set:html`. It has its own stylesheet and does NOT load
 * Tailwind or `Base.astro`, so the regular `HeaderCtas` island cannot be reused
 * here — its zine utility classes would resolve to nothing. Hence a small,
 * fully self-styled island using the landing document's own CSS custom
 * properties (`--av-paper`, `--av-ink`, `--av-display`, `--av-body`) with hard
 * fallbacks for the hero region, which sits above where those are declared.
 *
 * DESIGN CONTRACT — this island is purely additive:
 *   • Signed OUT it renders NOTHING. The poster, the hotspots and every CTA are
 *     byte-for-byte what the designer shipped. No flash, no layout shift.
 *   • Signed IN it adds a fixed chip (top-right) and rewrites ONLY the two
 *     explicit auth entries in the `.mobile-actions` nav ("Log in" → Dashboard,
 *     "Sign up" → Sign out). The invisible poster hotspots and the marketing
 *     "Create free" CTAs are deliberately left alone: a signed-in creator can
 *     still create, so those links stay correct as-is.
 *
 * Session source is the same `ClerkIsland` every other island uses, so this
 * reads the SAME session the Flutter app and the dashboard use. A guest session
 * (`avatok_guest_jwt`, minted by POST /api/identity/guest) also counts as
 * signed in — that mirrors HeaderCtas and keeps guest checkout coherent.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { ClerkIsland } from '../../lib/clerk';
import { CLERK_PUBLISHABLE_KEY } from '../../lib/config';

const chipWrap: React.CSSProperties = {
  position: 'fixed',
  top: '12px',
  right: '12px',
  zIndex: 60,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontFamily: 'var(--av-body, Arial, Helvetica, sans-serif)',
};

const chipBase: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '8px 14px',
  borderRadius: '999px',
  border: '2px solid var(--av-ink, #171717)',
  background: 'var(--av-paper, #f3e5c9)',
  color: 'var(--av-ink, #171717)',
  font: 'inherit',
  fontSize: '13px',
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '0.02em',
  textDecoration: 'none',
  cursor: 'pointer',
  boxShadow: '2px 2px 0 var(--av-ink, #171717)',
};

/**
 * Rewrite the two auth entries in the poster's `.mobile-actions` list so a
 * signed-in visitor isn't told to log in again. Runs once on mount and restores
 * nothing on unmount — the island only unmounts on navigation away.
 */
function retargetNavLinks(): void {
  try {
    const nav = document.querySelector('.mobile-actions');
    if (!nav) return;

    const login = nav.querySelector<HTMLAnchorElement>('a[href="/sign-in"]');
    if (login) {
      login.href = '/dashboard';
      login.textContent = 'Dashboard';
    }

    // The nav's "Sign up" entry becomes the sign-out affordance. "Create free"
    // (also /sign-up) is a separate marketing CTA and is intentionally skipped —
    // we match on the visible label, not the href.
    const signUp = Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[href="/sign-up"]')).find(
      (a) => a.textContent?.trim().toLowerCase() === 'sign up',
    );
    if (signUp) {
      signUp.href = '/dashboard';
      signUp.textContent = 'My account';
    }
  } catch {
    /* DOM shape changed — the chip alone is still a correct signed-in cue. */
  }
}

function Inner() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const [hasGuest, setHasGuest] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    try {
      setHasGuest(!!localStorage.getItem('avatok_guest_jwt'));
    } catch {
      /* private mode — treat as anonymous */
    }
    setChecked(true);
  }, []);

  const authed = (isLoaded && isSignedIn) || hasGuest;

  useEffect(() => {
    if (authed) retargetNavLinks();
  }, [authed]);

  // Signed out (or still resolving): render nothing at all. The static design
  // is the default state, so there is no skeleton and no reserved space.
  if (!checked || !isLoaded || !authed) return null;

  async function handleSignOut() {
    try {
      localStorage.removeItem('avatok_guest_jwt');
    } catch {
      /* ignore */
    }
    try {
      await signOut();
    } catch {
      /* ignore */
    }
    location.href = '/';
  }

  return (
    <div style={chipWrap}>
      <a href="/dashboard" style={chipBase}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" />
        </svg>
        Dashboard
      </a>
      <button type="button" onClick={handleSignOut} style={chipBase} aria-label="Sign out">
        Sign out
      </button>
    </div>
  );
}

export function HomeAccountChip() {
  // No Clerk key configured → no session can be read, so render nothing and
  // leave the static page exactly as designed.
  if (!CLERK_PUBLISHABLE_KEY) return null;
  return (
    <ClerkIsland>
      <Inner />
    </ClerkIsland>
  );
}

export default HomeAccountChip;

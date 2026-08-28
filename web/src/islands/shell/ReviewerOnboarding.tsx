/* ReviewerOnboarding — first-sign-in onboarding + terms acceptance for accounts
 * in REVIEWER MODE (payment-gateway or app-store reviewers).
 *
 * [REVIEWER-ONBOARD-1 2026-08-28] A reviewer arriving at avatok.ai has no
 * context: they land on a marketplace that is mid-pivot, half-populated with
 * test data, with payments switched off. This screen is the honest briefing —
 * what the product is, what stage it is at, what they will and will not be able
 * to do — followed by an explicit acceptance of the terms.
 *
 * ── WHAT THIS COMPONENT IS NOT ───────────────────────────────────────────────
 * It is NOT an auth mechanism and grants NOTHING. It renders after Clerk has
 * already authenticated the session, and dismissing it changes no permission.
 * Sign-in for a reviewer is ordinary Clerk sign-in, identical to every other
 * user's — there is no bypass, no shared secret, and no credential anywhere in
 * this repo, which is PUBLIC. Reviewer accounts are identified by an email
 * allowlist held in KV remote config (`reviewerEmails`), never in source.
 *
 * ── MOUNTING ────────────────────────────────────────────────────────────────
 * Rendered from INSIDE SidebarUser's Clerk tree. @clerk/clerk-react throws
 * "multiple <ClerkProvider>" if two providers mount on one page and the React
 * root then renders nothing, so this must never bring its own ClerkIsland on
 * /dashboard — SidebarUser already owns the page's single provider.
 *
 * Acceptance is stored per-browser (localStorage), keyed by the terms version
 * from remote config, so changing the copy re-shows the screen. Per the owner's
 * 2026-08-28 decision this gate is REVIEWER-ONLY and acceptance is NOT recorded
 * server-side; a product-wide, server-recorded acceptance is a separate piece
 * of work and is what a compliance audit would actually want.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { setReviewerMode } from '../../lib/reviewer';

const ACCEPT_KEY_PREFIX = 'avatok_reviewer_terms_';

interface ReviewerConfig {
  reviewerModeEnabled?: boolean;
  reviewerEmails?: string;
  reviewerTermsVersion?: string;
}

/** True when `email` is on the KV allowlist AND reviewer mode is switched on. */
function isReviewer(cfg: ReviewerConfig | null, email: string | null): boolean {
  if (!cfg?.reviewerModeEnabled || !email) return false;
  return String(cfg.reviewerEmails ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

export interface ReviewerOnboardingProps {
  /** Primary email of the signed-in account, or null when not yet known. */
  email: string | null;
}

export function ReviewerOnboarding({ email }: ReviewerOnboardingProps) {
  const [cfg, setCfg] = useState<ReviewerConfig | null>(null);
  const [accepted, setAccepted] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);
  // [REVIEWER-ONBOARD-2 2026-08-28] Needed for the portal below: document does
  // not exist during SSR, so the portal can only be created after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // Remote config is public and unauthenticated; a failure here must leave the
  // product usable, so every error path ends with "not a reviewer".
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('https://api.avatok.ai/api/config');
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as ReviewerConfig;
        if (alive) setCfg(j);
      } catch {
        if (alive) setCfg({});
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const version = cfg?.reviewerTermsVersion || 'v1';
  const show = isReviewer(cfg, email);

  // Publish the verdict for money-affordance hiding elsewhere on the surface.
  // Only once config has actually loaded (cfg != null), so a slow fetch never
  // clears the flag for a real reviewer mid-session.
  useEffect(() => {
    if (cfg != null) setReviewerMode(show);
  }, [cfg, show]);

  useEffect(() => {
    if (!show) return;
    try {
      setAccepted(localStorage.getItem(ACCEPT_KEY_PREFIX + version) === 'yes');
    } catch {
      // Storage blocked (private window, site data off) — show the screen. The
      // safe default for a disclosure is to display it, not to skip it.
      setAccepted(false);
    }
  }, [show, version]);

  if (!show || accepted !== false || !mounted) return null;

  const accept = () => {
    try {
      localStorage.setItem(ACCEPT_KEY_PREFIX + version, 'yes');
    } catch {
      /* acceptance simply won't persist; the screen reappears next visit */
    }
    setAccepted(true);
  };

  // [REVIEWER-ONBOARD-2 2026-08-28] PORTALLED TO <body>, and it has to be.
  // This component renders inside SidebarUser, which lives in the dashboard's
  // left sidebar — a narrow, scrolling, transformed container. `position: fixed`
  // is NOT relative to the viewport when any ancestor has a transform, filter or
  // container-type: it is relative to that ancestor. So the "full-screen" modal
  // rendered as a ~180px-wide column INSIDE the sidebar, with the terms text
  // wrapping one or two words per line. Moving the node to document.body takes
  // it out of that containing block and it covers the viewport as intended.
  //
  // Do NOT "fix" this by giving the sidebar a higher z-index or by making the
  // scrim absolute — neither addresses the containing block, which is the actual
  // cause.
  return createPortal(
    <div className="ro-scrim" role="dialog" aria-modal="true" aria-labelledby="ro-title">
      <div className="ro-card">
        <p className="ro-kicker">Welcome to avaTOK</p>
        <h2 className="ro-title" id="ro-title">Before you start</h2>

        <p className="ro-lead">
          avaTOK is a creator marketplace for paid live events, private 1:1 sessions
          and AI voice agents. Thank you for taking the time to review it.
        </p>

        <ul className="ro-list">
          <li>
            <strong>We are an early-stage startup.</strong> avaTOK is built and operated
            by an independent founding team in India. We are currently an{' '}
            <strong>unregistered business</strong>; registration of a company in Mumbai
            is in process. <a href="/terms#status" target="_blank" rel="noreferrer">Read our full status</a>.
          </li>
          <li>
            <strong>The site is not fully operational.</strong> We are at the ideation
            and testing stage. Features may change or be paused, and test data may be
            reset. Access is invite-only.
          </li>
          <li>
            <strong>Payments are not live.</strong> Our payment gateway application is
            under review, so no real money can move on this account and no charge will
            be made to you. Prices shown are indicative.
          </li>
          <li>
            <strong>Tokens are our in-app unit.</strong> 1 token = ₹1, fixed. See{' '}
            <a href="/tokens" target="_blank" rel="noreferrer">Tokens &amp; Wallet</a> and{' '}
            <a href="/pricing-fees" target="_blank" rel="noreferrer">Pricing &amp; Fees</a>.
          </li>
        </ul>

        <label className="ro-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.currentTarget.checked)}
          />
          <span>
            I have read and accept the{' '}
            <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>,{' '}
            <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> and{' '}
            <a href="/refunds" target="_blank" rel="noreferrer">Refunds &amp; Cancellations</a> policy.
          </span>
        </label>

        <button type="button" className="ro-btn" disabled={!checked} onClick={accept}>
          Accept and continue
        </button>

        <p className="ro-foot">
          Questions during your review? <a href="mailto:support@avatok.ai">support@avatok.ai</a> ·
          Ekta Vihar, Sahastradhara Road, Dehradun, Uttarakhand, India
        </p>
      </div>

      <style>{`
        .ro-scrim {
          position: fixed; inset: 0; z-index: 9999;
          display: flex; align-items: center; justify-content: center;
          padding: 20px; background: rgba(22, 22, 20, 0.72);
          overflow-y: auto;
        }
        .ro-card {
          width: min(100%, 620px); max-height: 92vh; overflow-y: auto;
          padding: clamp(22px, 4vw, 36px);
          background: #fffdf7; border: 2px solid #161614; border-radius: 22px;
          box-shadow: 10px 10px 0 #4f5cff;
          font-family: 'Instrument Sans', system-ui, sans-serif; color: #161614;
        }
        .ro-kicker {
          margin: 0 0 6px; font-family: 'Nunito', system-ui, sans-serif;
          font-size: 12px; font-weight: 900; text-transform: uppercase;
          letter-spacing: 0.14em; color: #1e5f66;
        }
        .ro-title {
          margin: 0 0 14px; font-family: 'Anton', Impact, sans-serif; font-weight: 400;
          font-size: clamp(30px, 5vw, 42px); line-height: 1.02;
          letter-spacing: 0.055em; word-spacing: 0.2em; text-transform: uppercase;
        }
        .ro-lead { margin: 0 0 16px; font-size: 16px; line-height: 1.55; }
        .ro-list { margin: 0 0 20px; padding-left: 20px; display: grid; gap: 10px; }
        .ro-list li { font-size: 15px; line-height: 1.55; }
        .ro-list a, .ro-foot a, .ro-check a { color: #1e5f66; text-underline-offset: 3px; }
        .ro-check {
          display: flex; gap: 11px; align-items: flex-start;
          padding: 14px; margin-bottom: 18px;
          border: 1px solid #161614; border-radius: 14px; background: #f6e4cd;
          font-size: 14px; line-height: 1.5; cursor: pointer;
        }
        .ro-check input { margin-top: 3px; width: 18px; height: 18px; flex: none; cursor: pointer; }
        .ro-btn {
          width: 100%; padding: 14px 22px; cursor: pointer;
          font-family: 'Nunito', system-ui, sans-serif; font-size: 15px; font-weight: 900;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: #161614; background: #ffd95e;
          border: 2px solid #161614; border-radius: 999px; box-shadow: 4px 4px 0 #161614;
          transition: transform .12s ease, box-shadow .12s ease;
        }
        .ro-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: 2px 2px 0 #161614; }
        .ro-btn:not(:disabled):hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 #161614; }
        .ro-foot {
          margin: 16px 0 0; font-size: 12.5px; line-height: 1.5; color: #5c584d;
        }
      `}</style>
    </div>,
    document.body,
  );
}

export default ReviewerOnboarding;

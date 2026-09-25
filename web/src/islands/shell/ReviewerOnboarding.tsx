import { useTranslation as useUiTranslation } from "../../lib/i18n/react";
import { UiText } from "../../lib/i18n/react";
/* ReviewerOnboarding — first-sign-in onboarding + terms acceptance for accounts
 * in REVIEWER MODE (payment-gateway or app-store reviewers).
 *
 * [REVIEWER-ONBOARD-1 2026-08-28] A reviewer arriving at saathum.com has no
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
 * ── HOW OFTEN IT SHOWS ──────────────────────────────────────────────────────
 * [REVIEWER-ONBOARD-3 2026-08-28, owner decision] ONCE PER LOGIN. Acceptance is
 * keyed by the Clerk SESSION ID and held in sessionStorage, so signing out and
 * back in produces a new session id and the screen returns. It was previously
 * keyed only by terms version in localStorage, which meant one dismissal
 * silenced it on that browser forever — the opposite of what a per-visit
 * disclosure is for.
 *
 * Changing the copy still re-shows it too: the key carries the version from
 * remote config as well as the session id.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Per the owner's 2026-08-28 decision this gate is REVIEWER-ONLY by default
 * (`reviewerTermsForAll` opens it to everyone) and acceptance is NOT recorded
 * server-side. Nothing here can be produced as evidence that a given user
 * accepted a given version — it is a disclosure, not a consent record. A
 * product-wide, server-recorded acceptance is separate work and is what a
 * compliance audit would actually want.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { setReviewerMode } from '../../lib/reviewer';

const ACCEPT_KEY_PREFIX = 'avatok_reviewer_terms_';

interface ReviewerConfig {
  reviewerModeEnabled?: boolean;
  reviewerEmails?: string;
  reviewerTermsVersion?: string;
  reviewerTermsForAll?: boolean;
}

/**
 * Who sees the screen: everyone when `reviewerTermsForAll` is on, otherwise the
 * `reviewerEmails` allowlist. Both are gated by `reviewerModeEnabled`, so one
 * flag still switches the whole feature off.
 */
function shouldShow(cfg: ReviewerConfig | null, email: string | null): boolean {
  if (!cfg?.reviewerModeEnabled) return false;
  if (cfg.reviewerTermsForAll) return true;
  if (!email) return false;
  return String(cfg.reviewerEmails ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

export interface ReviewerOnboardingProps {
  /** Primary email of the signed-in account, or null when not yet known. */
  email: string | null;
  /**
   * Clerk session id. This is what makes the screen appear ONCE PER LOGIN:
   * acceptance is stored against it, and a new sign-in mints a new one.
   */
  sessionId?: string | null;
}

export function ReviewerOnboarding({ email, sessionId }: ReviewerOnboardingProps) {
 const {t:uiT}=useUiTranslation("web-dashboard");

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
  const show = shouldShow(cfg, email);
  // Version AND session: new copy re-shows it, and so does a new login.
  const acceptKey = `${ACCEPT_KEY_PREFIX}${version}_${sessionId ?? 'nosession'}`;

  // Publish the verdict for money-affordance hiding elsewhere on the surface.
  // Only once config has actually loaded (cfg != null), so a slow fetch never
  // clears the flag for a real reviewer mid-session.
  useEffect(() => {
    if (cfg != null) setReviewerMode(show);
  }, [cfg, show]);

  useEffect(() => {
    if (!show) return;
    try {
      // sessionStorage, NOT localStorage: it dies with the tab, which is the
      // right lifetime for something that must reappear on the next login.
      setAccepted(sessionStorage.getItem(acceptKey) === 'yes');
    } catch {
      // Storage blocked (private window, site data off) — show the screen. The
      // safe default for a disclosure is to display it, not to skip it.
      setAccepted(false);
    }
  }, [show, acceptKey]);

  if (!show || accepted !== false || !mounted) return null;

  const accept = () => {
    try {
      sessionStorage.setItem(acceptKey, 'yes');
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
        <p className="ro-kicker"><UiText id="web-dashboard.721feaa18450b1e6" source="Welcome to Saathum" /></p>
        <h2 className="ro-title" id="ro-title"><UiText id="web-dashboard.74e492d5d0df0bab" source="Before you start" /></h2>

        <p className="ro-lead"><UiText id="web-dashboard.0cbbe6459d3b69c9" source="Saathum is a creator marketplace for paid live events, private 1:1 sessions and AI voice agents. Thank you for taking the time to review it." />{" "}</p>

        <ul className="ro-list">
          <li>
            <strong><UiText id="web-dashboard.63daeb29abfbc2cc" source="We are an early-stage startup." /></strong>{" "}<UiText id="web-dashboard.aac0944d09bd4cd8" source="Saathum is built and operated by an independent founding team in India. We are currently an" />{' '}
            <strong><UiText id="web-dashboard.2cc9b827c20aa0f9" source="unregistered business" /></strong><UiText id="web-dashboard.0a984f1d42a2293b" source="; registration of a company in Mumbai is in process." />{" "}<a href="/terms#status" target="_blank" rel="noreferrer"><UiText id="web-dashboard.1e7c107176e052c9" source="Read our full status" /></a>.
          </li>
          <li>
            <strong><UiText id="web-dashboard.90a8d5b8ab6bac9c" source="The site is not fully operational." /></strong>{" "}<UiText id="web-dashboard.26ccffac20aa876b" source="We are at the ideation and testing stage. Features may change or be paused, and test data may be reset. Access is invite-only." />{" "}</li>
          <li>
            <strong><UiText id="web-dashboard.098ae124bfa76cda" source="Payments are not live." /></strong>{" "}<UiText id="web-dashboard.2575660644382cf5" source="Our payment gateway application is under review, so no real money can move on this account and no charge will be made to you. Prices shown are indicative." />{" "}</li>
          <li>
            <strong><UiText id="web-dashboard.d5bc5cba6e5c4741" source="Tokens are our in-app unit." /></strong>{" "}<UiText id="web-dashboard.a040c2235e0891bd" source="1 token = ₹1, fixed. See" />{' '}
            <UiText id="web-dashboard.4f40c430b4aba8c5" source="Tokens & Wallet" />{" "}<UiText id="web-dashboard.6201111b83a0cb5b" source="and" />{' '}
            <UiText id="web-dashboard.39f57a6e5029c0fc" source="Pricing & Fees" />.
          </li>
        </ul>

        <label className="ro-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.currentTarget.checked)}
          />
          <span><UiText id="web-dashboard.e0d4704374a7ee84" source="I have read and accept the" />{' '}
            <a href="/terms" target="_blank" rel="noreferrer"><UiText id="web-dashboard.4afa55bf7aec7ddc" source="Terms of Service" /></a>,{' '}
            <a href="/privacy" target="_blank" rel="noreferrer"><UiText id="web-dashboard.506ff394621596dd" source="Privacy Policy" /></a>{" "}<UiText id="web-dashboard.6201111b83a0cb5b" source="and" />{' '}
            <a href="/refunds" target="_blank" rel="noreferrer"><UiText id="web-dashboard.7f529853635b4f28" source="Refunds & Cancellations" /></a>{" "}<UiText id="web-dashboard.fb60318f422ee917" source="policy." />{" "}</span>
        </label>

        <button type="button" className="ro-btn" disabled={!checked} onClick={accept}><UiText id="web-dashboard.ea9ac3e0bdc36386" source="Accept and continue" />{" "}</button>

        <p className="ro-foot"><UiText id="web-dashboard.20c3460dedcec159" source="Questions during your review?" />{" "}<a href="mailto:support@saathum.com">support@saathum.com</a>{" "}<UiText id="web-dashboard.9ee6e0114bdad18a" source="· Mumbai, India" />{" "}</p>
      </div>

      <style>{uiT("web-dashboard.01c64cb9f55255f8","\n        .ro-scrim {\n          position: fixed; inset: 0; z-index: 9999;\n          display: flex; align-items: center; justify-content: center;\n          padding: 20px; background: rgba(22, 22, 20, 0.72);\n          overflow-y: auto;\n        }\n        .ro-card {\n          width: min(100%, 620px); max-height: 92vh; overflow-y: auto;\n          padding: clamp(22px, 4vw, 36px);\n          background: #fffdf7; border: 2px solid #161614; border-radius: 22px;\n          box-shadow: 10px 10px 0 #4f5cff;\n          font-family: 'Instrument Sans', system-ui, sans-serif; color: #161614;\n        }\n        .ro-kicker {\n          margin: 0 0 6px; font-family: 'Nunito', system-ui, sans-serif;\n          font-size: 12px; font-weight: 900; text-transform: uppercase;\n          letter-spacing: 0.14em; color: #1e5f66;\n        }\n        .ro-title {\n          margin: 0 0 14px; font-family: 'Comfortaa', 'Baloo 2', sans-serif; font-weight: 400;\n          font-size: clamp(30px, 5vw, 42px); line-height: 1.02;\n          letter-spacing: 0.055em; word-spacing: 0.2em; text-transform: uppercase;\n        }\n        .ro-lead { margin: 0 0 16px; font-size: 16px; line-height: 1.55; }\n        .ro-list { margin: 0 0 20px; padding-left: 20px; display: grid; gap: 10px; }\n        .ro-list li { font-size: 15px; line-height: 1.55; }\n        .ro-list a, .ro-foot a, .ro-check a { color: #1e5f66; text-underline-offset: 3px; }\n        .ro-check {\n          display: flex; gap: 11px; align-items: flex-start;\n          padding: 14px; margin-bottom: 18px;\n          border: 1px solid #161614; border-radius: 14px; background: #f6e4cd;\n          font-size: 14px; line-height: 1.5; cursor: pointer;\n        }\n        .ro-check input { margin-top: 3px; width: 18px; height: 18px; flex: none; cursor: pointer; }\n        .ro-btn {\n          width: 100%; padding: 14px 22px; cursor: pointer;\n          font-family: 'Nunito', system-ui, sans-serif; font-size: 15px; font-weight: 900;\n          letter-spacing: 0.06em; text-transform: uppercase;\n          color: #161614; background: #ffd95e;\n          border: 2px solid #161614; border-radius: 999px; box-shadow: 4px 4px 0 #161614;\n          transition: transform .12s ease, box-shadow .12s ease;\n        }\n        .ro-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: 2px 2px 0 #161614; }\n        .ro-btn:not(:disabled):hover { transform: translate(-2px, -2px); box-shadow: 6px 6px 0 #161614; }\n        .ro-foot {\n          margin: 16px 0 0; font-size: 12.5px; line-height: 1.5; color: #5c584d;\n        }\n      ",{})}</style>
    </div>,
    document.body,
  );
}

export default ReviewerOnboarding;

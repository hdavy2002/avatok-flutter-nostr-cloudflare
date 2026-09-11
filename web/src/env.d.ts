/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE?: string;
  readonly PUBLIC_CLERK_PUBLISHABLE_KEY?: string;
  /** [WEB-POSTHOG-1] PostHog project API key. Public by design (client-side key). */
  readonly PUBLIC_POSTHOG_KEY?: string;
  /** [WEB-POSTHOG-1] PostHog ingest host, e.g. https://eu.i.posthog.com. */
  readonly PUBLIC_POSTHOG_HOST?: string;
  /** [WEB-POSTHOG-1] Git SHA of the build, stamped as the `release` super property. */
  readonly PUBLIC_RELEASE_SHA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Server-only runtime env for the Cloudflare Pages Functions (api/contact,
// api/careers-apply, api/waitlist), read via `context.locals.runtime.env`.
// See src/lib/sendMail.ts and
// Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md §3.4.
interface Env {
  /** Cloudflare account id — public, committed in wrangler.toml [vars]. */
  CF_ACCOUNT_ID?: string;
  /** Pages secret. Token scope: Account -> Email Sending: Edit only. */
  CF_EMAIL_API_TOKEN?: string;
  /** Brevo transactional API key — fallback transport + waitlist contacts list-add. */
  BREVO_API_KEY?: string;
  BREVO_SENDER_NAME?: string;
  BREVO_SENDER_EMAIL?: string;
  /** Comma-separated Brevo contact-list id(s) for the waitlist. */
  BREVO_LIST_ID?: string;
  /** "cloudflare_then_brevo" (default when CF_EMAIL_API_TOKEN is set) | "brevo" | "cloudflare". */
  EMAIL_PROVIDER?: string;
}

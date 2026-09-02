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

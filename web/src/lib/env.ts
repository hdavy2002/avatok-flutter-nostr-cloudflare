// [WEB-PERF-1 2026-09-30] Tiny runtime values every island needs (API base,
// Clerk key, store links) — split out of lib/config.ts on purpose.
//
// lib/config.ts imports publicImageManifest.json (~80 KB) for its image
// helpers. Because apiClient/clerk/preetiApi imported API_BASE from config, that
// manifest rode along into EVERY page's shared JS chunk, image helpers or not.
// Client code that only needs these values imports from HERE; config.ts
// re-exports them so existing `from '../lib/config'` imports keep working.
// Do not import anything heavy into this file (brand.ts is a tiny generated mirror).

import { BRAND } from './brand';

/** Base URL for every API call. Defaults to prod; override via PUBLIC_API_BASE. */
export const API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? BRAND.apiOrigin;

/** Clerk publishable key for web auth/session. May be undefined until set in env. */
export const CLERK_PUBLISHABLE_KEY: string | undefined = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * Native-app store links for the "get the app to watch" CTAs. Env-driven so a
 * button only renders once its store listing is actually public — set
 * PUBLIC_PLAY_STORE_URL when the Android listing goes live (package
 * com.saathum.app) and PUBLIC_APP_STORE_URL when iOS ships. Until then the
 * CTA shows web-viewing only, with no dead store links.
 */
export const PLAY_STORE_URL: string | undefined = import.meta.env.PUBLIC_PLAY_STORE_URL || undefined;
export const APP_STORE_URL: string | undefined = import.meta.env.PUBLIC_APP_STORE_URL || undefined;

/** True when at least one native app store listing is live and linkable. */
export const HAS_NATIVE_APP: boolean = Boolean(PLAY_STORE_URL || APP_STORE_URL);

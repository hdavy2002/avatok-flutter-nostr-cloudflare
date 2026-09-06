// [FAV-WIRE-1 2026-09-05] Makes a Clerk session reachable from an inline script.
//
// ListingDetailsComp.astro renders its interactivity as one non-module inline
// `<script define:vars>` — deliberately, so the page has no build dependency and
// cannot be broken by a bundler change. That script now has to make an
// AUTHENTICATED request (the heart writes a favourite), and it cannot import
// from lib/clerk.
//
// Mounting this island `client:load` puts a ClerkProvider on the page, whose
// ClerkBridge installs `window.__avatokToken()`. Without it the getter is never
// defined on a public listing page — the only other Clerk island there is
// MessageHost, which sits inside a `display:none` panel, so its `client:visible`
// would never fire and the heart would treat every visitor as signed out.
//
// It renders nothing. The provider IS the feature.
import { ClerkIsland } from '../../lib/clerk';

export default function AuthBridge() {
  return <ClerkIsland><span hidden /></ClerkIsland>;
}

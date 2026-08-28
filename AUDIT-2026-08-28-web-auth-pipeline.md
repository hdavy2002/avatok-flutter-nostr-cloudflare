# Web auth pipeline audit — sign-in to sign-out

**Date:** 2026-08-28 · **Issue:** `[WEB-AUTH-STATE-1]` · **Scope:** `web/` only (the Flutter app is not covered)

Written because the owner signed out and the header still said "Dashboard / Sign out".
That symptom had two causes, and chasing it surfaced a structural problem worth
recording: **the site had four independent implementations of "is this visitor
signed in", and they disagreed.**

---

## 1. What was actually wrong

### Bug A — sign-out did not sign out (severity: high)

`/sign-out` redirected to the home page and left the session **alive**.

`SignOutIsland` called `clerk.signOut()` on mount and started a 4-second timer that
redirected home regardless of the outcome. `useClerk()` returns the Clerk instance
immediately, but that instance is **not loaded yet** — the SDK is still fetching its
environment and client. `signOut()` on an unloaded instance does not end the session;
it rejects or no-ops. The rejection went into a bare `catch`, the timer fired, and the
visitor landed on `/` still authenticated.

So the header was **telling the truth**. It said "Sign out" because the visitor was
still signed in.

Proven live, in this order:

| Call | Result |
|---|---|
| `/sign-out` route as shipped | redirected to `/`, `sessions: ["active"]`, `__session` cookie intact |
| `await Clerk.load()` then `Clerk.signOut()` | `sessions: []`, header flipped to Log in / Sign up |

**Fix:** gate the effect on `useAuth().isLoaded`, `await` the sign-out, redirect only
after it settles. The backstop now starts *after* Clerk loads and is 12s, long enough
that it cannot pre-empt a sign-out in flight. Leaving early was the entire bug.

### Bug B — four sources of truth for auth state (severity: medium, systemic)

| # | Implementation | Where | How it was wrong |
|---|---|---|---|
| 1 | `HeaderAuth.tsx` — Clerk React island | `auth="auto"` pages | Correct, but only on some pages |
| 2 | `auth` prop on `SiteHeader.astro` | `"in"` / `"static"` pages | The **page asserts** the answer at build time. A signed-out visitor on a dashboard URL saw "Sign out"; a signed-in visitor on a `static` page saw "Log in" |
| 3 | Mobile panel in the same header | every page | Rendered signed-**out** links unconditionally. **A signed-in user on a phone saw "Log in / Sign up" with no route to their dashboard or sign-out** |
| 4 | `mockupPage.ts` injected script | `/marketplace`, listing comps | A credentialed `fetch` to Clerk's API — correct, but a fourth implementation, and the buttons could not settle until a round trip finished |

Why #2 and #3 existed at all: `@clerk/clerk-react` throws **"multiple `<ClerkProvider>`"**
if two mount on one page, and the React root then renders nothing. 15 pages mount their
own Clerk island, so most pages could not afford to *ask*. They guessed instead.

---

## 2. The replacement — one mechanism

`web/src/lib/authState.ts`.

Clerk publishes a **non-httpOnly** cookie, `__client_uat`, specifically so a server or a
script can know the answer without loading the SDK. `"0"` = signed out, a unix timestamp
= signed in. It is the same signal Clerk's own SSR/edge helpers use.

Verified on avatok.ai:

```
signed in   __client_uat = <timestamp>   __session present
signed out  __client_uat = "0"            __session absent
```

Because it is a cookie read, the check is **synchronous and network-free**, so it runs
before first paint. Consequences:

- No flash of the wrong buttons.
- No `<ClerkProvider>` needed for the header, which **removes the reason `auth="static"`
  and `auth="in"` had to exist**.
- The same check works on the static design comps, which have no island at all.

**How it drives the UI:** an `is:inline` pre-paint script stamps
`html[data-avatok-auth="in"|"out"]`. The header renders **both** CTA sets and CSS shows
one. Default with the attribute absent (JS disabled) is **signed out** — offering "Log in"
to someone signed in is a mild annoyance; offering "Dashboard / Sign out" to an anonymous
visitor is a broken page.

> **This is a display hint, never a security boundary.** Anyone can forge the cookie and
> see a "Dashboard" link; clicking it hits a page whose real Clerk guard bounces them to
> `/sign-in`. Never gate data, money, or a protected route on it. The server verifies the
> session, exactly as before.

---

## 3. What must show at each stage

| Stage | Header (desktop + mobile) | Dashboard sidebar | Notes |
|---|---|---|---|
| **Anonymous** | Log in · Sign up | n/a — `/dashboard` bounces to `/sign-in?next=…` | Default when the attribute is absent |
| **Signing in** | Log in · Sign up | n/a | Cookie is not set until the session is created |
| **Signed in** | Dashboard · Sign out | profile card + Sign out | `?next=` honoured, else `/dashboard` |
| **Signing out** | (on `/sign-out`, chrome hidden) | n/a | Must wait for Clerk to load before signing out |
| **Signed out** | Log in · Sign up | n/a | `location.replace('/')` so Back does not return to `/sign-out` |

Surfaces that must obey this, all now on the one mechanism:

- `SiteHeader.astro` desktop bar
- `SiteHeader.astro` mobile panel (below 1100px)
- `/marketplace` and `/<creator>/<listing>` design comps
- `SidebarUser` profile card (unchanged; it has a real Clerk provider)

---

## 4. Verified after deploy

| Check | Result |
|---|---|
| Signed out, desktop | Log in · Sign up |
| Signed out, mobile panel | Log in · Sign up |
| Signed in, desktop | Dashboard · Sign out |
| Signed in, mobile panel | Dashboard · Sign out |
| Both sets present in DOM | 4 `.avh-auth-in`, 4 `.avh-auth-out` |
| Deployed sign-out bundle | contains the `isLoaded` gate |
| Comps | use the cookie check; no Clerk API call |

The one step not verified end to end by an agent is the **real** sign-out round trip,
because that needs an authenticated session and agents do not enter passwords. The
underlying mechanism was proven live (`Clerk.load()` → `signOut()` → `sessions: []`).

---

## 5. Traps worth remembering

1. **A cached tab is not a stale deploy.** During verification the tab showed no
   `data-avatok-auth` at all while the *served* HTML had it. Always compare
   `fetch(url, {cache:'reload'})` against the DOM before concluding a deploy failed.
2. **Never swallow an auth provider's error.** The bare `catch` around `signOut()` is
   what made this take a whole session: the failure was invisible and the symptom
   pointed at the wrong component.
3. **Do not race a redirect against an async auth call.** A "safety" timeout that fires
   during the operation it is protecting turns a working call into a silent no-op.
4. **`useClerk()` / `useAuth()` return before Clerk is loaded.** Gate on `isLoaded` for
   anything that mutates session state.

---

## 6. Follow-ups not done here

- **Remove the dead `auth` prop.** It is accepted and ignored so the ~15 pages passing it
  still compile. Delete those call sites, then the prop.
- **`islands/site/HeaderAuth.tsx` is no longer rendered.** Kept in case another surface
  wants a React-side signal; delete it if nothing claims it.
- **`/marketplace` is still a design comp on mock data** (`[DEMO-MARKET-1]`). The header
  is honest there now, but the content is not real. The live grid is
  `/dashboard/marketplace`, and `GET /api/explore` returns zero listings in production.
- **Server-recorded terms acceptance.** The onboarding gate stores acceptance in
  `sessionStorage` only; it cannot prove who accepted what. See `[REVIEWER-ONBOARD-3]`.

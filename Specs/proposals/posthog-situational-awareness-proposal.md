# Proposal: Full-Funnel Product Telemetry for AI Situational Awareness

**Project:** avaTOK-2-Flutter (avatok.ai apps + website)
**Author:** prepared with Claude (Cowork)
**Date:** 2026-06-07
**PostHog project:** `Default project` — id `139917`, region **EU** (`https://eu.posthog.com/project/139917`)

---

## 1. Goal

When you describe a problem ("a user can't finish signup", "onboarding drops on step 4", "the website isn't converting"), I should be able to pull the exact event stream for that user or that step from PostHog and tell you what actually happened — instead of guessing.

That requires three things, in order:

1. **Capture every consequential moment** — signup, every onboarding step, every screen/page a user visits, and key product actions — with a consistent schema, on both client (Flutter app + website) and server (Workers).
2. **Stitch it to one identity** so a person's whole journey (web → app → backend) is a single timeline.
3. **A repeatable troubleshooting workflow** so I (or your `brain` agent) can query that timeline on demand via the PostHog MCP.

This document covers all three, grounded in what your codebase and PostHog project actually look like today.

---

## 2. What exists today (verified)

I inspected the live PostHog project and the repo. Here is the real picture, not assumptions.

### 2.1 Capture is server-side only

All product events are emitted from the **Workers backend**, never from the client:

```
worker/src/hooks.ts  track()  ──►  env.Q_ANALYTICS.send(...)
                                        │  (Cloudflare Queue)
                                        ▼
consumers/src/index.ts  captureBatch()  ──►  POST {POSTHOG_HOST}/batch/
                                                  distinct_id = npub
```

`track()` already standardizes the "5 required fields" on every event: `trace_id`, `user_id` (the npub), `app_name`, `app_version`, `service_name`. That is a good foundation — we keep it.

### 2.2 There is no client-side SDK

- `app/pubspec.yaml` has **no `posthog_flutter`** dependency (no analytics SDK at all).
- The marketing site (`marketing/`) has **no `posthog-js` snippet**.

Consequence: nothing the user does *inside the app or on the website* is captured unless it happens to hit a backend route that calls `track()`. Screen navigation, onboarding step progression, button taps, form abandons, and most of the signup flow are **invisible today**. This is the core gap relative to what you asked for.

### 2.3 Event volume confirms the gap

Last 30 days, top events by count: `$autocapture` (604), `$identify` (125), `$pageleave` (90), `$pageview` (35), several `$ai_*` cluster/summary events, `marketplace_ai_turn` (7), `ava_turn` (1). The web autocapture/pageview volume is incidental (test/admin traffic); there are **no signup, onboarding, or screen events at all**, and product events (`ava_turn`, `marketplace_ai_turn`) barely fire.

### 2.4 An AI-investigate path already exists — with a region bug

`worker/src/do/user_brain.ts → investigate()` already does what you want at the agent level: given a user complaint, it runs HogQL to pull that npub's last 24h of events and asks an LLM for the root cause. Two problems:

- It defaults `POSTHOG_QUERY_HOST` to **`https://us.posthog.com`**, and `consumers` defaults `POSTHOG_HOST` similarly. **Your data lives on EU** (`eu.posthog.com`, project 139917). If those env vars aren't explicitly set to the EU host in every environment, events are written to / queried from the wrong region and silently disappear. **This is the highest-priority fix.**
- It only sees 24h and only events that were captured server-side — so today it's mostly blind. Once client capture (Section 5) lands, this same function becomes genuinely useful.

### 2.5 Identity model

Identity is the **nostr npub** (derived after Clerk auth + key generation in onboarding). Server events already use npub as `distinct_id`. The client SDKs must use the *same* npub so client and server events merge into one person.

### 2.6 Dashboards

- `Acquisition & Activation (Internal)` (id 680379, pinned) — describes a signup + booking funnel, but built on events that largely don't fire yet.
- `My App Dashboard` (id 565092) — empty default.

---

## 3. Target architecture

One event schema, three emitters, one person timeline:

```
  Marketing site (posthog-js)  ─┐
  Flutter app (posthog_flutter) ─┼──►  PostHog EU project 139917  ◄── HogQL / MCP ──  Claude + brain agent
  Workers backend (existing hooks)─┘            (one person per npub)
```

- **Website** → `posthog-js`: landing pageviews, CTA clicks, signup-started, plus autocapture.
- **App** → `posthog_flutter`: screen views (automatic via navigator observer), onboarding steps, signup completion, core product actions, captured exceptions.
- **Backend** → keep `hooks.ts` (already correct), just standardize event names to match the taxonomy and fix the region host.
- **Identity**: anonymous before login → `identify(npub)` the instant npub exists → all three streams stitch together.

---

## 4. Event taxonomy

### 4.1 Naming rules

- `snake_case`, `object_action` order: `onboarding_step_completed`, `signup_started`, `call_ended`.
- Reserve PostHog's auto events (`$pageview`, `$screen`, `$autocapture`, `$identify`, `$exception`) — don't redefine them.
- **Every custom event carries the 5 required props** already enforced server-side: `trace_id`, `app_name`, `app_version`, `service_name`, and identity via `distinct_id`. Client events add: `platform` (`ios`/`android`/`web`), `app_version`, `screen`/`route`.

### 4.2 Person properties (set on `identify`)

`account_kind` (single/parent/enterprise), `handle`, `display_name_set` (bool), `signup_completed_at`, `platform_first_seen`, `app_version`, `notifications_enabled`, `keys_backed_up` (bool).

**Demographics & geography (for segmentation):**

- `$geoip_country_name` / `$geoip_country_code`, `$geoip_subdivision_1_name` (state/region), `$geoip_city_name` — **automatic** from GeoIP on the client SDK; for the server `/batch/` path, forward the user's IP as `properties.$ip` so backend events geo-locate to the user, not the Cloudflare edge.
- `age_group` — bucketed (`13-17`, `18-24`, `25-34`, `35-44`, `45-54`, `55-64`, `65+`) from a new onboarding age field. Bucket only, never raw DOB.
- `phone_verified`, `email_verified` (bool), `liveness_status` (`not_started`/`started`/`passed`/`failed`/`abandoned`).

**Never** set PII beyond handle/display name — no email, no phone number, no DOB, no private key (consistent with the "npub only, never PII" comment already in `consumers`). For minors (`13-17`), treat per your child-safety policy.

### 4.2a Verification events

Phone (OTP), email, and the future video/liveness check each get their own mini-funnel and standardized error events. Full list in `posthog-capture-catalog-by-screen.md` §3A–3C. Error domains: `otp`, `email_verification`, `liveness`. The liveness section is wired now (even before the feature ships) specifically so we can measure **"started liveness → never passed → never came back"** via a long-window funnel plus a "Liveness abandoners" cohort.

### 4.3 Core event catalog

| Stage | Event | Where | Key properties |
|---|---|---|---|
| Acquisition | `$pageview`, `$autocapture` | web | (auto) referrer, utm_* |
| Acquisition | `marketing_cta_clicked` | web | `cta` (get_app/sign_up), `location` |
| Signup | `signup_started` | web/app | `method` (clerk), `entry` |
| Signup | `auth_completed` | app | `method`, `is_new_user` |
| Signup | `identity_created` | app | npub generated |
| Onboarding | `onboarding_started` | app | `account_kind` (once chosen) |
| Onboarding | `onboarding_step_viewed` | app | `step_index` (0–6), `step_name` |
| Onboarding | `onboarding_step_completed` | app | `step_index`, `step_name` |
| Onboarding | `onboarding_account_kind_selected` | app | `account_kind` |
| Onboarding | `onboarding_notifications_choice` | app | `enabled` (bool) |
| Onboarding | `onboarding_keys_backed_up` | app | `pub`, `priv` saved flags |
| Onboarding | `onboarding_profile_saved` | app | `has_handle`, `has_name` |
| Onboarding | `onboarding_completed` | app | `account_kind`, `apps_enabled[]` |
| Activation | `screen_viewed` (or `$screen`) | app | `screen`, `previous_screen` |
| Product | `ava_turn`, `marketplace_ai_turn` | server (exists) | keep |
| Product | `call_started` / `call_ended` | app/server | `duration_s`, `peer` |
| Product | `content_posted`, `upload_completed` | server (exists) | keep |
| Reliability | `$exception` | app/web | auto + manual capture |
| Lifecycle | `account_deleted` | server (exists) | keep |

The 7 onboarding steps map directly to `_steps = 7` in `app/lib/features/onboarding/onboarding_flow.dart` (account kind → notifications → terms → key backup → profile → apps → done), so `step_index`/`step_name` are unambiguous.

---

## 5. Implementation

### 5.1 Flutter app — add the SDK

`app/pubspec.yaml`:

```yaml
dependencies:
  posthog_flutter: ^4.10.0   # check pub.dev for latest 4.x at implementation time
```

Initialize against the **EU** host. Disable autocapture of sensitive widgets; enable screen + lifecycle tracking.

```dart
// app/lib/core/analytics.dart  (new)
import 'package:posthog_flutter/posthog_flutter.dart';

class Analytics {
  static Future<void> init() async {
    final config = PostHogConfig('phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5')
      ..host = 'https://eu.i.posthog.com'        // EU ingestion — must match project region
      ..captureApplicationLifecycleEvents = true  // Application opened/installed/backgrounded
      ..debug = false;
    await Posthog().setup(config);
  }

  /// Call the moment the npub exists (after Clerk auth + key gen).
  static Future<void> identify(String npub, {required String accountKind, String? handle}) =>
      Posthog().identify(userId: npub, userProperties: {
        'account_kind': accountKind,
        if (handle != null) 'handle': handle,
      });

  static Future<void> capture(String event, [Map<String, Object>? props]) =>
      Posthog().capture(eventName: event, properties: {
        'platform': 'app',
        'service_name': 'avatok-app',
        ...?props,
      });

  static Future<void> reset() => Posthog().reset(); // on logout
}
```

Wire init in `main()` before `runApp`, and add the **navigator observer** so every screen is captured automatically:

```dart
// main.dart
await Analytics.init();
runApp(MaterialApp(
  navigatorObservers: [PosthogObserver()], // automatic $screen events per route
  // ...
));
```

### 5.2 Flutter — onboarding & signup events

In `onboarding_flow.dart`, fire one event per step transition. Minimal, surgical additions:

```dart
// when the flow opens
Analytics.capture('onboarding_started');

// in the step setter / whenever _step changes
void _goTo(int next) {
  Analytics.capture('onboarding_step_completed',
      {'step_index': _step, 'step_name': _stepName(_step)});
  setState(() => _step = next);
  Analytics.capture('onboarding_step_viewed',
      {'step_index': next, 'step_name': _stepName(next)});
}

// account kind chosen
Analytics.capture('onboarding_account_kind_selected', {'account_kind': _selectedKind!.name});

// on completion (widget.onComplete)
Analytics.capture('onboarding_completed', {
  'account_kind': _selectedKind?.name ?? 'unknown',
  'apps_enabled': _enabled.toList(),
});
```

Call `Analytics.identify(npub, accountKind: ...)` at the point the identity/npub is created during onboarding so all subsequent app + server events attach to the same person.

### 5.3 Marketing website — add posthog-js

The site is React/Vite (`marketing/src/`). Add the snippet in `index.html` (or init in `main.jsx`), EU host:

```html
<!-- marketing/index.html, before </head> -->
<script>
  !function(t,e){/* standard posthog-js loader snippet */}(document,window);
  posthog.init('phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5', {
    api_host: 'https://eu.i.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
  });
</script>
```

On the "Get the app / Sign up" CTA: `posthog.capture('marketing_cta_clicked', { cta: 'sign_up', location: 'hero' })` and `posthog.capture('signup_started', { entry: 'web' })`. Because the website and app share the same project token, a person who clicks on web and then signs up in the app is one timeline once `identify(npub)` runs.

### 5.4 Backend — two changes only

1. **Fix the region (highest priority).** Set, in every Workers environment (`worker` and `consumers`):

   ```
   POSTHOG_HOST            = https://eu.i.posthog.com
   POSTHOG_QUERY_HOST      = https://eu.posthog.com
   POSTHOG_PROJECT_ID      = 139917
   POSTHOG_API_KEY         = phc_hmYMsHQEYjQU4bYXNdqA4VZVsfHEIkBQdQL0Kv7FIc5   # ingest (capture)
   POSTHOG_PERSONAL_API_KEY= <personal API key>                                # query (brain investigate)
   ```

   These can be set with `wrangler secret put` / `[vars]` in `wrangler.toml`. Until `POSTHOG_QUERY_HOST` points at EU, `user_brain.investigate()` queries an empty US project.

2. **Align event names** emitted by `hooks.ts` `track()` calls to the taxonomy in Section 4 (e.g., emit `call_ended`, `content_posted` with the documented props). The plumbing already works; this is just naming consistency so client + server events line up in funnels.

### 5.5 PII guardrails

Keep the existing discipline: `distinct_id` = npub only; never send email, phone, or private key as properties. On the website use `person_profiles: 'identified_only'` so anonymous browsers don't create person records until they sign up. The `consumers/src/deletion.ts` path already deletes a person from PostHog on account deletion — keep it and point it at the EU host too.

---

## 6. What I'll set up live in PostHog now

To give you (and the brain agent) standing situational awareness, I'm provisioning:

- **Dashboard: "AvaTok — AI Situational Awareness"** — the single place to glance at health.
- **Signup funnel** — `signup_started` → `auth_completed` → `onboarding_started` → `onboarding_completed`. Shows where new users drop. (Populates as Section 5 ships; zero-volume steps render as 0 until then.)
- **Onboarding step funnel** — `onboarding_step_viewed` across step_index 0→6, to see the exact step where people quit.
- **Active users trend** — DAU/WAU over time.
- **Errors trend** — `$exception` over time, to catch regressions.
- **Top events table** — what's actually firing, for sanity-checking instrumentation.
- **AI turns trend** — `ava_turn` + `marketplace_ai_turn`.

(Insights that reference not-yet-emitted events are intentional scaffolding — they light up automatically the moment the client code from Section 5 is deployed.)

---

## 7. The AI troubleshooting workflow

Once capture is in place, here's how I turn a vague report into a precise answer. You tell me the situation; I run the matching query via the PostHog MCP (all scoped to project 139917, EU).

**"User X is stuck / complaining"** — pull their whole recent timeline:

```sql
SELECT timestamp, event, properties.screen, properties.step_name,
       properties.$exception_message, properties.trace_id
FROM events
WHERE distinct_id = '{npub}'
  AND timestamp > now() - INTERVAL 3 DAY
ORDER BY timestamp DESC
LIMIT 200
```

**"Where do people drop in onboarding?"** — a funnel query on `onboarding_step_viewed`/`onboarding_step_completed` broken down by `step_name`.

**"Signups are down"** — trend of `signup_started` vs `onboarding_completed` with conversion %, broken down by `platform` and `utm_source`.

**"Something broke after the last release"** — `$exception` trend broken down by `app_version`, then drill into the offending version's exception messages.

**"Is the website converting?"** — funnel `$pageview` (landing) → `marketing_cta_clicked` → `signup_started` → `onboarding_completed`.

This is the same pattern your `user_brain.investigate()` already implements — so the dashboards serve you, and the HogQL templates serve the in-product brain agent. Both read the one EU project.

When you bring me a problem, give me **the npub** (or the handle / approximate time window) and I'll pull the exact stream rather than speculate.

---

## 8. Rollout plan

**Phase 0 — Fix the foundation (½ day).** Set EU host/region env vars in `worker` + `consumers`; confirm `track()` events land in project 139917 and `investigate()` can read them. *Highest priority — without this, nothing else is trustworthy.*

**Phase 1 — App capture (1–2 days).** Add `posthog_flutter`, `Analytics` helper, `PosthogObserver`, `identify(npub)` at key creation, `reset()` on logout. Verify `$screen` events appear.

**Phase 2 — Onboarding & signup events (1 day).** Instrument the 7-step flow + signup. Verify the signup and onboarding funnels populate.

**Phase 3 — Website capture (½ day).** Add posthog-js + CTA/signup_started events to the marketing site.

**Phase 4 — Standardize server events + dashboards (½ day).** Align `hooks.ts` event names; confirm the live dashboard tiles fill in.

**Phase 5 — Operationalize the agent (ongoing).** Point `user_brain.investigate()` at EU, widen its window, and let it (and me) use the Section 7 templates.

### Acceptance checklist

- [ ] EU host set in all Worker environments; a test `track()` event is visible in project 139917.
- [ ] App `$screen` events fire on navigation; person is identified by npub.
- [ ] Signup funnel and onboarding step funnel show real data end to end.
- [ ] Website pageviews + `signup_started` attribute to the same person after app identify.
- [ ] `user_brain.investigate()` returns a real timeline for a known npub.
- [ ] No PII (email/phone/private key) present on any event or person property.
```

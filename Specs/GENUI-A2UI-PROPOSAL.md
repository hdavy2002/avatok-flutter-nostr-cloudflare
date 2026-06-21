# Proposal: Generative in-chat UI for Ava via Flutter GenUI + A2UI

**Status:** Draft for discussion · **Date:** 2026-06-21 · **Owner:** davy
**Scope:** Replace hard-coded per-tool chat UIs (e.g. the email cards) with
agent-composed, design-token-native UI rendered by the Flutter **GenUI SDK**
using the **A2UI** format, driven by **Composio** results.

---

## 1. TL;DR

Today every Composio surface needs a hand-built Flutter widget (we just did this
for Gmail: `EmailInboxCards` + `EmailViewerScreen`). That doesn't scale to
Calendar, Drive, Sheets, Stripe, etc. — one design + one widget per app.

GenUI flips it: the **agent emits a UI description (A2UI JSON)**, the Flutter
client renders it through **our own widget catalog** styled by **our tokens**.
New Composio app → usually **zero new Flutter**. Your mental model is right, with
one precision:

| Your term | GenUI term | What it is for us |
| --- | --- | --- |
| Transport = A2UI | **A2UI messages** | The JSON UI spec carried inside our existing Ava message envelope |
| Catalog = design tokens | **Catalog** (widgets) + **Theme** (tokens) | Our Zine widgets registered as `CatalogItem`s; tokens applied via Flutter `Theme` |
| DataModel = Composio output | **DataModel** | Observable store the cards bind to; hydrated from Composio results, and the source of events sent back to the agent |

Precision: the **Catalog is the set of widgets** the agent may use; the **tokens
are how those widgets look**. A2UI also natively splits **structure**
(`createSurface` / `updateComponents`) from **data** (`updateDataModel`) — which
gives us the template-cache you wanted almost for free.

**Recommendation:** adopt the **A2UI format + GenUI renderer against our own Zine
catalog**, drive it from our worker (no A2A server, no client-side LLM required),
pilot on one new tool (Calendar), keep the hand-built email cards as the hero
flow and the reference catalog entry.

---

## 2. What GenUI / A2UI actually are (grounded)

- **A2UI**: open (Apache-2), public Dec 2025, format **v0.9**. A *declarative*
  component tree + data model as JSON — **not** code. The client owns a catalog
  of trusted components; the agent can only request those. Client owns styling.
- **Flutter GenUI SDK** (`github.com/flutter/genui`, **"highly experimental — API
  will change"**): renders A2UI through *your* widget catalog. Requires Flutter
  **≥3.35.7** — our CI is on **3.41.x**, so we're fine.
- Packages: `genui` (core: `SurfaceController`, `Surface`, `CatalogItem`,
  `A2uiTransportAdapter`, `Conversation`, data binding), `genui_a2a`
  (`A2uiAgentConnector` for A2A servers — *we likely don't need it*),
  `genai_primitives`, `json_schema_builder` (`S.object(...)` schemas).
- Key capability for us: it can be driven **without an LLM and without an A2A
  server** — feed a structured `A2uiMessage` straight into
  `SurfaceController.handleMessage(...)`. That means our worker can emit A2UI JSON
  in the Ava envelope and the client just renders it.

---

## 3. Target architecture

```
User: "what's on my calendar today"
        │
        ▼
Worker (ava_agent.ts turn)
  1. intent + Composio call (GOOGLECALENDAR_EVENTS_LIST)         ← DataModel source
  2. resolve UI:
       • cache HIT  → reuse cached A2UI component tree (template)
       • cache MISS → Gemini composes A2UI from {catalog, tokens, result schema}
                      → lint against _adherence rules → cache the template
  3. emit A2UI messages in the Ava envelope:
       { t:'ava', a2ui:[ createSurface, updateComponents, updateDataModel ] }
        │
        ▼
Flutter (chat_thread Ava bubble)
  A2uiTransportAdapter.addMessage(...) → SurfaceController(catalogs:[ZineCatalog])
        │                                         │
        ▼                                         ▼
  Surface(surfaceId) renders our Zine widgets     onSubmit stream (button/form events)
        │                                                 │
        ▼                                                 ▼
  user taps "Spam" / "Reply" / "RSVP"            POST /api/ava/email|calendar/<action>
                                                          │
                                                          ▼
                                                    Composio executeTool
```

Two things to note:

- **No new transport.** A2UI JSON rides in the Ava envelope we already fan out via
  the InboxDO. We parse it into `A2uiMessage` and call
  `SurfaceController.handleMessage`. We do **not** need `genui_a2a`'s HTTP
  connector (that's for remote A2A servers).
- **Actions stay server-side.** A generated button emits a `SurfaceController.onSubmit`
  event; we map it to our existing action routes (`/api/ava/email/spam`, etc.).
  GenUI replaces *presentation*, not the Composio plumbing.

---

## 4. The catalog (one-time build)

Register each Zine component as a `CatalogItem` with a JSON schema. The widget
builder binds to the data model and uses our `Zine` tokens, so everything the
agent composes is automatically on-brand.

```dart
final emailCard = CatalogItem(
  name: 'EmailCard',
  dataSchema: S.object(properties: {
    'from': S.string(), 'addr': S.string(), 'subject': S.string(),
    'snippet': S.string(), 'flag': S.string(), 'accent': S.string(),
  }, required: ['from', 'subject']),
  widgetBuilder: (context) {
    final subject = context.dataContext.subscribeToString(context.data['subject']);
    // …render with Zine.card / Zine.ink / Zine.lime etc.
  },
);

final zineCatalog = Catalog([
  // primitives
  cardItem, buttonItem, chipItem, fieldItem, toggleItem,
  avatarItem, iconBadgeItem, listItem, rowItem, columnItem, textItem,
  // domain widgets (reuse what we built)
  emailCard, emailViewer, /* later: calendarEvent, driveFile, … */
]);
```

We already have the design-side definitions to mirror: `theme/design/gmail/
components/` (Button, Chip, Field, Toggle, Avatar, Card, IconBadge, Pressable,
Sticker, Icon) each with a `.d.ts` (schema) and `.prompt.md` (usage). These map
almost 1:1 to `CatalogItem`s, and the `.prompt.md` files become the per-widget
guidance we feed the composing model.

**Tokens** (`tokens/colors.css`, `spacing.css`, `typography.css`, `shadows.css`,
`effects.css`, `fonts.css`) are already encoded in `app/lib/core/ui/zine.dart`;
the catalog widgets reference `Zine.*`, so the agent never picks colors — it only
picks **components and layout**. This is the safety wall.

---

## 5. Generation modes + caching (the speed story)

A2UI separates **structure** from **data**, which maps cleanly onto two modes:

1. **Deterministic templates (default, fast):** for known result shapes (emails,
   calendar events) the worker emits a fixed A2UI component tree (the "template")
   + an `updateDataModel` with the Composio values. No model call. This is how
   we'd reimplement today's email cards.
2. **LLM-composed (the long tail):** for a shape we've never rendered, Gemini
   composes the A2UI tree from {catalog summary, token summary, Composio result
   schema}. We **lint it** against `_adherence.oxlintrc.json`, render, and
   **cache the tree**.

**Caching** (your idea, refined):

- **Cache the template, not the data.** Key = `hash(toolName + resultSchema +
  catalogVersion + tokenVersion)`.
- **Hit** → send cached `createSurface`/`updateComponents` + a fresh
  `updateDataModel`. Sub-100ms, deterministic, no PII cached.
- **Miss** → compose once with Gemini, lint, cache the tree.
- Store in Workers KV (shared) and/or on device. Bump `catalogVersion` /
  `tokenVersion` to invalidate after a redesign.

> Net effect: the *first* time anyone asks for a Drive listing we pay one model
> call; every subsequent Drive listing (for any user) is template-fast.

---

## 6. How it answers the original question

- "What's in my inbox" → emails shape → **cached email template** + data.
- "Show me the email from jack@gmail.com" → **same shape**, same template, different
  data. Zero new design. (This was the case that worried you — it's free.)
- "What's on my calendar / find my file / my latest Stripe payouts" → **new shape**
  → composed once, cached, on-brand. **No new Flutter widget** unless we want a
  bespoke one for a hero flow.

---

## 7. Phased plan

**Phase 0 — Spike (½–1 day).** Add `genui` to `app/`, build a 3-widget catalog
(Card, Text, Button) with Zine tokens, feed one hand-written A2UI message into a
`SurfaceController`, render in a throwaway screen. Proves the renderer + tokens.

**Phase 1 — Catalog (2–3 days).** Promote the Zine components to `CatalogItem`s
(primitives + EmailCard/EmailViewer). Wire `onSubmit` → action dispatcher →
existing `/api/ava/email/*` routes. Re-render the **existing** email flow through
GenUI behind a kill-switch flag; A/B against the hand-built cards.

**Phase 2 — Pilot a new tool (2 days).** Calendar ("what's on today") with **no
new Flutter** — worker emits a deterministic A2UI template; if we skip the
template, Gemini composes it. This is the proof of "new app, zero UI work".

**Phase 3 — Generative + cache (3–4 days).** Add the Gemini compose path + lint
gate + template cache (KV). Open it to the long tail of Composio apps. Keep 2–3
hero flows hand-tuned.

Flag-gated throughout (`genuiEnabled` in `routes/config.ts`), fallback = today's
hard-coded widgets / plain text.

---

## 8. Telemetry (extends what we added for email)

- `genui_render` { surface, shape_key, mode: template|composed|cache_hit, ms }
- `genui_compose` { shape_key, ms, lint_ok, lint_errors, model } — design speed +
  quality
- `genui_action` { surface, action, ok, ms, error } — Composio action outcome
- `genui_fallback` { surface, reason } — when we drop to plain text / hard-coded
- All email-stamped via `trackUserContact`, same as the email routes.

This directly gives you "track design, speed, Composio errors" across every
generated surface, not just email.

---

## 9. Security & safety

- **Declarative, catalog-gated:** the agent can only instantiate components we
  registered; it cannot run code or pick raw colors. Tokens are fixed in-app.
- **Lint gate:** every composed tree is checked against `_adherence` before render.
- **Actions are server-validated:** `onSubmit` payloads hit our authed, premium-gated
  routes; the client never trusts an agent-supplied URL or action target.
- **No PII in cache:** only the structural template is cached; data is hydrated
  per-request.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| A2UI **v0.9** + GenUI "highly experimental"; API will churn | Wrap GenUI behind our own `AvaGenUi` adapter; pin versions; keep hard-coded fallbacks; upgrade deliberately |
| LLM layout quality varies | Lint gate + deterministic templates for hero flows + fallback to text |
| First-render latency on cache miss | Template cache (once per shape, shared across users) |
| Action wiring still per-tool | Generic action dispatcher + per-tool route map; small, server-side |
| Bundle size / new deps | Measure in Phase 0; GenUI is pure Dart/Flutter |
| Streaming UI not yet first-class | Render on completion now; adopt streaming when the SDK stabilizes it |

---

## 11. Open decisions

1. **Drive path:** worker emits A2UI directly into the Ava envelope (recommended —
   no A2A server, full control) vs. stand up an A2A endpoint + `genui_a2a`
   connector (more "standard", more moving parts).
2. **Compose model:** reuse the current Gemini apps model for layout composition,
   or a cheaper/faster one for UI-only generation.
3. **Pilot tool:** Calendar (recommended), Drive, or Sheets.
4. **Email flow:** migrate it onto GenUI now (dogfood) or leave it hand-built and
   only use GenUI for new tools first.

---

## 12. Recommendation

Adopt **A2UI as the format + GenUI as the renderer against our Zine catalog**,
driven from the worker (no A2A server, no client LLM needed). Do **Phase 0 spike →
Phase 1 catalog + re-render email behind a flag** before committing further. Keep
hard-coded widgets as fallbacks for hero flows. This gets us to "new Composio app
= no new Flutter" while staying on-brand, fast (template cache), and safe
(catalog + lint gated).

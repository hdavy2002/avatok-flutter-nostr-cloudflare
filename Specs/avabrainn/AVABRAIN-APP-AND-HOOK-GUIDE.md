# AvaBrain App + Hook Reference Guide

Two documents in one:
1. **AvaBrain App** — a standalone Flutter app (chatbox with the AI brain)
2. **Hook Reference Guide** — instructions for adding brain hooks to any Ava app (used when building each app, not preemptively)

---

# PART 1: AVABRAIN APP

AvaBrain is a standalone app in the Ava ecosystem. It's the user's window into
everything their AI brain knows. It does NOT live inside AvaChat — it's its own
app, its own icon on the home screen.

### What it does

The user opens AvaBrain and chats with their AI. The brain knows everything
from every Ava app the user has used (AvaChat messages, AvaDate matches, AvaMail
emails — whatever apps have the brain hook enabled). The user asks questions,
gets daily briefings, browses what the brain remembers, and manages their memory.

### Screens

**1. Chat (home screen)**

A clean chat interface. User types, brain responds.

- Standard chat bubbles (user right, brain left)
- Text input at bottom with send button
- Brain responses show a subtle "Sources" line underneath listing which
  entities/facts were used
- Loading state: pulsing brain icon while Workers AI processes (1-3 seconds)

API: `POST /api/brain/ask { question }`

Suggested questions on empty state:
- "What happened today?"
- "Who should I reply to?"
- "What deadlines do I have?"
- "Tell me about Jeff"
- "What did I talk about this week?"

**2. Briefing**

Daily summary cards, most recent first.

- Each card: date, AI-generated summary, highlight chips (entity names)
- Tapping a chip navigates to that entity's detail
- Pull-to-refresh generates fresh briefing for today

API: `POST /api/brain/briefing`

Card layout:
```
┌──────────────────────────────────┐
│  📅 Today — June 5, 2026        │
│                                  │
│  You had 3 conversations today.  │
│  Jeff mentioned the property     │
│  deal closes Thursday. You       │
│  promised to call Amit back.     │
│                                  │
│  [Jeff] [Property Deal] [Amit]   │
└──────────────────────────────────┘
```

**3. Memory**

Browse everything the brain knows. Two sub-tabs: **People** and **All**.

- People tab: person entities sorted by recency (last_seen)
- All tab: all entities grouped by type (people, projects, places, tasks, etc.)
- Each row: name, type icon, one-line summary, last seen
- Swipe left to delete (forget)
- Search bar filters locally by name

API: `GET /api/brain/entities`

Entity detail screen (tap any entity):
```
┌──────────────────────────────────┐
│  👤 Jeff                         │
│  Person · Last seen 2h ago       │
│                                  │
│  Summary:                        │
│  Close contact, discussed        │
│  property deal multiple times.   │
│                                  │
│  Connected to:                   │
│  [Property Deal] [Amit]          │
│                                  │
│  Facts:                          │
│  • Property deal closes Thu      │
│  • Prefers morning calls         │
│  • Works at Acme Corp            │
│                                  │
│  [🗑️ Forget Jeff]                │
└──────────────────────────────────┘
```

API: `DELETE /api/brain/forget { entity_id }`

**4. Investigate (in settings or a help icon)**

User describes a problem, brain checks PostHog logs and explains what went wrong.

- Text input with pre-filled suggestions: "I can't log in", "Messages not sending",
  "Call dropped", "Push not working"
- Response shows as a diagnosis card
- If PostHog personal key isn't set: "Diagnostics not available yet"

API: `POST /api/brain/investigate { complaint }`

**5. Settings (within AvaBrain app)**

```
AvaBrain Settings
├── Daily Briefing Notifications   [Toggle: ON]
├── What the Brain Knows           [→ Memory screen]
├── Clear All Memory               [Destructive, confirmation dialog]
│   "Permanently delete everything AvaBrain has learned
│    across all your Ava apps."
└── Help & Diagnostics             [→ Investigate screen]
```

Note: the brain ON/OFF toggle is NOT here. It's in each individual app's
settings (AvaChat settings, AvaDate settings, etc.). AvaBrain itself is just
the viewer — the apps decide what to capture.

### Auth

Same as every Ava app: NIP-98 + Clerk JWT (dual auth). The user's npub
identifies their brain — all API calls route to their personal UserBrain DO.

### Push notifications

When the daily briefing cron runs:
```
Title: "Your daily briefing 🧠"
Body: "3 conversations, 1 deadline, 2 things to follow up"
Tap action: Opens AvaBrain → Briefing screen
```

---

# PART 2: HOOK REFERENCE GUIDE

**When to use this:** When Davy says "add the brain hook to this app" while
building a new Ava app. Do NOT add hooks preemptively. Each app gets its hook
when it's being built.

**When NOT to use this:** Media-only apps (AvaLive, AvaTube) that are pure
content streaming may not need brain hooks — Davy will decide per-app.

### How the hook works

Every Ava app has a settings page. On that settings page:

```
AvaBrain Learning                [Toggle: ON by default]
"AvaBrain learns from your activity in this app to help
 you remember things. You can manage what it knows in
 the AvaBrain app."
```

When ON: the app captures both public and private content for the brain.
When OFF: nothing is captured. No Q_BRAIN dispatch, no remember() calls.

### Adding the hook — server side (public content)

If the app's Worker handles public content that the user creates:

**Step 1:** Add Q_BRAIN producer to the app's `wrangler.toml`:
```toml
[[queues.producers]]
binding = "Q_BRAIN"
queue = "brain-events"
```

**Step 2:** In the Worker, after saving public content, dispatch to Q_BRAIN:
```typescript
// Only if user has brain enabled (check user settings in DB_META)
const settings = await env.DB_META.prepare(
  'SELECT brain_enabled FROM user_settings WHERE npub = ?'
).bind(npub).first();

if (settings?.brain_enabled !== 0) {  // ON by default, 0 = explicitly disabled
  await env.Q_BRAIN.send({
    type: '<event_type>',       // e.g. 'post_created', 'profile_updated'
    npub: npub,
    content: '<the public content>',
    sourceApp: '<app_name>',    // e.g. 'avachat', 'avadate'
    sourceId: '<unique_event_id>',
    createdAt: Date.now(),
  });
}
```

**Step 3:** The brain consumer (`consumers/src/brain.ts`) already handles
extraction. If the new app has event types the consumer doesn't recognize,
add a case for them. The consumer extracts entities/facts with the 8B model
and stores them — no changes needed for standard text content.

### Adding the hook — client side (private/E2E content)

If the app handles E2E encrypted content that the user can see but the server
cannot:

**Step 1:** Add BrainExtractor (or reuse the shared one) in the app:
```dart
// Use regex-based extraction for v1
// Extracts: dates/deadlines, action items, preferences, contact info
final facts = BrainExtractor.extract(
  decryptedText,
  senderName: senderName,
  senderNpub: senderNpub,
);
```

**Step 2:** After extracting, send to the brain if enabled:
```dart
final brainEnabled = prefs.getBool('brain_learning_enabled') ?? true; // ON by default

if (brainEnabled && facts.isNotEmpty) {
  // Fire and forget — never block UI
  BrainApi.remember(
    facts: facts,
    sourceApp: '<app_name>',
    sourceId: eventId,
    scope: 'private',
  ).catchError((e) => debugPrint('Brain sync failed: $e'));
}
```

**Step 3:** Add the toggle to the app's settings page:
```dart
SwitchListTile(
  title: Text('AvaBrain Learning'),
  subtitle: Text('Let AvaBrain learn from your activity in this app'),
  value: brainEnabled,  // default true
  onChanged: (val) {
    prefs.setBool('brain_learning_enabled', val);
    // Also sync to server so the Worker knows
    api.updateSettings({ brain_enabled: val });
  },
),
```

### What each app type typically captures

| App | Public (server hook) | Private (client hook) |
|---|---|---|
| **AvaChat** | Public posts (kind 1) | DM text — dates, names, action items |
| **AvaDate** | Published dating profile | Match conversations, preferences shared in chat |
| **AvaMail** | n/a (email is private) | Email subjects, senders, deadlines, action items |
| **AvaCalendar** | Public events | Private events, attendees, reminders |
| **AvaTweet** | Public tweets | DM conversations |
| **AvaBook** | Public posts | Private posts, journal entries |
| **AvaLive** | Stream metadata (title, duration) | Usually not needed |
| **AvaTube** | Video metadata (title, description) | Usually not needed |

### The toggle controls BOTH paths

When the user turns OFF brain learning in any app:
- **Server side:** The Worker checks `brain_enabled` before dispatching to Q_BRAIN.
  If disabled, no dispatch. The check is a single DB_META lookup (cached in the
  request context).
- **Client side:** The app checks `SharedPreferences` before calling `remember()`.
  If disabled, no extraction, no API call.

When the user turns it back ON, capture resumes from that point. Past content
is NOT retroactively processed.

### Adding the brain_enabled setting to DB_META

If `user_settings` doesn't already have a `brain_enabled` column:

```sql
ALTER TABLE user_settings ADD COLUMN brain_enabled INTEGER DEFAULT 1;
-- 1 = ON (default), 0 = OFF
```

This is a per-user, cross-app setting. Each app reads the same column. If a
user wants brain OFF in one app but ON in another, extend to per-app settings
later (e.g., `brain_enabled_avachat`, `brain_enabled_avadate`). For v1, one
global toggle is fine.

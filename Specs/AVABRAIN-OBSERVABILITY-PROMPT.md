# AvaBrain + Observability — Build Prompt

**Purpose:** Build two interconnected systems in one session:
1. **AvaBrain** — the universal AI intelligence layer for every Ava app
2. **Observability** — PostHog + Analytics Engine instrumentation so AvaBrain can self-diagnose

These are not separate features. AvaBrain USES the observability data to debug problems. The observability system FEEDS AvaBrain's awareness of what's happening. Build them together.

**CRITICAL RULES:**
- Cloudflare-only. No Mem0, no external AI, no external memory service. D1 + Vectorize + Workers AI handles everything Mem0 would do.
- Follow the AvaTalk Rulebook v1.1. D1 is the database. Queues for async. Workers AI for inference. Cache API before KV.
- Do NOT rebuild existing Workers/schemas. Add to them.
- PostHog MCP is connected — use it for dashboard creation and verification.
- Cloudflare MCP is connected — use it for infrastructure provisioning.

---

## PART 1: AVABRAIN

### Concept (one paragraph, for context)

Every user has exactly one AvaBrain. It persists across all apps, all devices, all time. Apps are temporary interfaces — the brain is permanent. When something happens in any app (message received, date matched, meeting created, stream started), the brain learns from it. When the user asks a question in AvaChat, the brain reasons across everything it knows. When something breaks, the brain investigates using PostHog data.

### 1A. Infrastructure additions

**New Queue:**

```toml
# Add to worker/wrangler.toml
[[queues.producers]]
binding = "Q_BRAIN"
queue = "brain-events"
```

**New Durable Object:**

```toml
# Add to worker/wrangler.toml
[[durable_objects.bindings]]
name = "USER_BRAIN"
class_name = "UserBrain"

# Update migrations tag
[[migrations]]
tag = "v2"
new_sqlite_classes = ["UserBrain"]
```

The UserBrain DO is per-user (keyed by npub), uses WebSocket Hibernation, and handles reasoning requests from AvaChat. It is separate from the relay inbox DO — different concerns, different compute profiles.

**New D1 tables (add to DB_META via new migration `brain.sql`):**

### 1B. Knowledge Graph Schema

The knowledge graph stores entities (people, projects, places, events, tasks) and relationships between them. This is structured memory — queryable, not just searchable.

```sql
-- brain.sql — AvaBrain knowledge graph + memory
-- Apply: wrangler d1 execute avatok-meta --file=worker/migrations/brain.sql

-- Entities: people, projects, companies, places, tasks, goals, interests, events
CREATE TABLE IF NOT EXISTS brain_entities (
  id          TEXT PRIMARY KEY,
  npub        TEXT NOT NULL,           -- the user who owns this entity
  entity_type TEXT NOT NULL,           -- 'person'|'project'|'company'|'place'|'task'|'goal'|'interest'|'event'|'community'
  name        TEXT NOT NULL,           -- "Jeff", "Property Deal", "Dehradun"
  summary     TEXT,                    -- AI-generated summary, updated over time
  metadata    TEXT,                    -- JSON: email, phone, role, status, dates, etc.
  importance  REAL DEFAULT 0.5,        -- 0-1, updated by brain based on interaction frequency
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_ent_user ON brain_entities(npub, entity_type);
CREATE INDEX IF NOT EXISTS idx_brain_ent_name ON brain_entities(npub, name);
CREATE INDEX IF NOT EXISTS idx_brain_ent_importance ON brain_entities(npub, importance DESC);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS brain_relationships (
  id              TEXT PRIMARY KEY,
  npub            TEXT NOT NULL,
  from_entity_id  TEXT NOT NULL,
  to_entity_id    TEXT NOT NULL,
  relationship    TEXT NOT NULL,        -- 'knows'|'works_on'|'works_at'|'lives_in'|'interested_in'|'matched_with'|'scheduled_with'|'manages'|'reports_to'
  strength        REAL DEFAULT 0.5,     -- 0-1, increases with interaction
  context         TEXT,                 -- AI-generated: "discussed property deal on June 4"
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_rel_user ON brain_relationships(npub);
CREATE INDEX IF NOT EXISTS idx_brain_rel_from ON brain_relationships(from_entity_id);
CREATE INDEX IF NOT EXISTS idx_brain_rel_to ON brain_relationships(to_entity_id);

-- Structured facts (Layer 1 memory)
-- These are discrete, queryable facts the brain has extracted from events
CREATE TABLE IF NOT EXISTS brain_facts (
  id          TEXT PRIMARY KEY,
  npub        TEXT NOT NULL,
  fact_type   TEXT NOT NULL,           -- 'preference'|'habit'|'goal'|'deadline'|'decision'|'reminder'|'insight'
  content     TEXT NOT NULL,           -- "User prefers morning meetings"
  source_app  TEXT,                    -- 'avachat'|'avadate'|'avalive'|...
  source_id   TEXT,                    -- event_id or message_id that produced this fact
  confidence  REAL DEFAULT 0.8,        -- how confident the AI is in this fact
  expires_at  INTEGER,                 -- optional TTL for temporary facts
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_facts_user ON brain_facts(npub, fact_type);
CREATE INDEX IF NOT EXISTS idx_brain_facts_recent ON brain_facts(npub, updated_at DESC);

-- Daily summaries (AI-generated, one per user per day)
CREATE TABLE IF NOT EXISTS brain_daily_summaries (
  id          TEXT PRIMARY KEY,
  npub        TEXT NOT NULL,
  date        TEXT NOT NULL,           -- 'YYYY-MM-DD'
  summary     TEXT NOT NULL,           -- AI-generated: "Today you..."
  highlights  TEXT,                    -- JSON array of key events
  created_at  INTEGER NOT NULL,
  UNIQUE(npub, date)
);
CREATE INDEX IF NOT EXISTS idx_brain_daily ON brain_daily_summaries(npub, date DESC);

-- Event log (raw events the brain has processed — source of truth)
CREATE TABLE IF NOT EXISTS brain_events (
  id          TEXT PRIMARY KEY,
  npub        TEXT NOT NULL,
  event_type  TEXT NOT NULL,           -- 'message_received'|'match_received'|'stream_started'|...
  source_app  TEXT NOT NULL,
  payload     TEXT NOT NULL,           -- JSON: the event data
  processed   INTEGER DEFAULT 0,       -- 1 = brain has extracted facts/entities from this
  trace_id    TEXT,                    -- links to observability
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brain_events_user ON brain_events(npub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_events_unprocessed ON brain_events(processed, created_at)
  WHERE processed = 0;
```

### 1C. Event Bus — Q_BRAIN Consumer

Create `consumers/src/brain.ts` — the brain event consumer.

**Event types the brain processes:**

| Event type | Source app | What the brain extracts |
|---|---|---|
| `message_received` | AvaChat | Person entity, conversation topic, sentiment, action items |
| `message_sent` | AvaChat | Same + tracks who the user actively communicates with |
| `match_received` | AvaDate | Person entity, interests, compatibility notes |
| `stream_started/ended` | AvaLive | Event entity, viewer count, duration, topics |
| `email_received` | AvaMail | Person entity, subject matter, action items, deadlines |
| `calendar_created` | AvaCalendar | Event entity, attendees, deadline, reminders |
| `post_created` | AvaTweet/AvaBook | Interest tracking, content themes |
| `friend_added` | Any | Person entity, relationship |
| `call_completed` | AvaChat | Person entity, call duration, notes |
| `upload_completed` | Any | Media entity, context |
| `task_completed` | Any | Task entity, project relationship |

**Consumer logic (per event):**

```
1. Receive event from Q_BRAIN
2. Store raw event in brain_events (source of truth, never lost)
3. Call Workers AI (llama-3.3-70b) with the event + existing entities for this user:
   System prompt: "You are a personal memory assistant. Extract structured facts,
   entities (people, projects, places), and relationships from this event.
   Return JSON with: entities[], relationships[], facts[]"
4. Upsert entities in brain_entities (merge if entity already exists — update summary, last_seen, importance)
5. Upsert relationships in brain_relationships (update strength, context, last_seen)
6. Insert new facts in brain_facts
7. Embed the event summary in Vectorize (for semantic search later)
8. Mark event as processed
```

**Importance scoring:** Every time an entity is referenced in a new event, increment its importance. An entity you interact with daily has importance ~0.9. An entity from 6 months ago with no recent activity decays toward 0.1. Run importance decay in the 6-hour cron.

**Deduplication:** Before creating a new entity, check if one with the same name + type already exists for this user. If yes, merge — update the summary, last_seen, and importance. Don't create duplicate "Jeff" entities.

### 1D. UserBrain DO — Reasoning Engine

Create `worker/src/do/user_brain.ts`.

The UserBrain DO handles reasoning requests from AvaChat. It's a per-user DO (keyed by npub) with WebSocket Hibernation.

**Endpoints (via WebSocket or HTTP):**

| Method | What it does |
|---|---|
| `ask(question)` | Natural language query: "What happened today?" "Who should I reply to?" |
| `briefing()` | Generate daily briefing — summarize today's events, pending tasks, upcoming meetings, unread important messages |
| `investigate(complaint)` | Debug a problem: "My messages aren't sending" — queries PostHog via API |
| `remember(fact)` | Manually tell the brain something: "Jeff's birthday is March 15" |
| `forget(entity_id)` | Remove an entity/fact from memory |

**`ask()` reasoning flow:**

```
1. Receive question from AvaChat
2. Query brain_entities for this user (top entities by importance, filtered by question context)
3. Query brain_relationships for connections between relevant entities
4. Query brain_facts for relevant recent facts
5. Query Vectorize for semantically similar past events/summaries
6. Query brain_daily_summaries for recent days
7. Send all context to Workers AI (llama-3.3-70b):
   System: "You are the user's personal AI. Answer using ONLY the provided context.
   If you don't know, say so. Never hallucinate."
   User: "{question}"
   Context: "{entities, relationships, facts, vector_results, summaries}"
8. Return answer to AvaChat
```

**`investigate()` — the PostHog integration:**

```
1. Receive complaint: "My messages aren't sending"
2. Determine relevant PostHog events: message_failed, relay_error, system_error
3. Call PostHog API: query events for this user_id in last 24 hours
   (Use the PostHog project API key from env.POSTHOG_API_KEY)
4. Analyze the events with Workers AI:
   "Given these error events, what is the root cause?
   Events: {posthog_events}
   User complaint: {complaint}"
5. Return diagnosis to AvaChat:
   "Your messages failed because the relay connection timed out.
   This happened 3 times in the last hour. The issue appears to be
   resolved now — try sending again."
```

### 1E. AvaChat Integration

AvaChat is already the primary app. Add a brain mode:

**In the Flutter app (`app/lib/`):**
- Add a brain query UI in AvaChat (a special chat thread or a dedicated tab).
- When the user sends a message in brain mode, it goes to the UserBrain DO (via WebSocket or HTTP POST to `/api/brain/ask`).
- The response streams back from Workers AI and displays in the chat.

**New API routes (add to `worker/src/routes/api.ts`):**

```
POST /api/brain/ask        — { question: "What happened today?" }
POST /api/brain/briefing   — no body, returns today's briefing
POST /api/brain/remember   — { fact: "Jeff's birthday is March 15" }
POST /api/brain/investigate — { complaint: "My messages aren't sending" }
DELETE /api/brain/forget    — { entity_id: "..." }
GET /api/brain/entities     — list the user's knowledge graph entities
GET /api/brain/timeline     — recent brain events for this user
```

All routes require NIP-98 + Clerk JWT (dual auth). The route handler gets the user's npub from auth, then routes to their UserBrain DO.

### 1F. Relay → Brain Event Hook

The relay's `onEventSaved` hook already dispatches to Q_PUSH. Add Q_BRAIN dispatch for relevant event kinds:

```
onEventSaved(event):
  → Q_PUSH (existing — push notification)
  → Q_BRAIN (new — brain processing)
     Only for kinds the brain cares about:
     kind 1 (post), kind 14 (DM), kind 7 (reaction),
     kind 30023 (article), kind 30311 (live stream),
     kind 34235 (video), kind 9735 (zap)
     Skip: kind 3 (follows list), kind 0 (profile metadata),
     kind 10002 (relay list) — metadata, not events worth remembering
```

### 1G. Daily Briefing Cron

Add to the 6-hour cron in `avatok-consumers`:

- At the first cron run after midnight (user's timezone, or default UTC+5:30 for India):
  - Query brain_events for the previous day
  - Query brain_entities with high importance
  - Query upcoming calendar events (if AvaCalendar is built)
  - Generate daily summary via Workers AI
  - Store in brain_daily_summaries
  - Optionally push notification: "Your daily briefing is ready"

- At every cron run:
  - Decay entity importance: `importance = importance * 0.995` for entities not seen today
  - Clean expired facts: `DELETE FROM brain_facts WHERE expires_at < now()`
  - Process any unprocessed brain_events (catch-up for queue failures)

---

## PART 2: OBSERVABILITY

### 2A. The Three-System Split

**This is non-negotiable. Do not send everything to PostHog.**

| Destination | What | Volume target | Cost |
|---|---|---|---|
| **PostHog** | User-facing events, errors, journeys, AI diagnostics | 5-15 per user per day | Free up to 1M/month |
| **Analytics Engine** | Operational metrics (latency, throughput, queue depth, neurons) | Thousands per second | $0.25/million |
| **Workers Logs** | Raw request/response, stack traces, detailed debug | Everything | Free (7-day retention) |

### 2B. Trace ID Implementation

Generate a trace ID at the entry point of every request. Pass it through every layer.

**In the API Worker (`worker/src/index.ts`):**

```typescript
// Generate at request entry
const traceId = request.headers.get('X-Trace-Id') || crypto.randomUUID();

// Pass to every function, every D1 query context, every queue message
// Attach to PostHog events and Analytics Engine data points
```

**In the Flutter app (`app/lib/core/api_auth.dart`):**

```dart
// Generate per-request, send as header
final traceId = Uuid().v4();
headers['X-Trace-Id'] = traceId;
// Store locally for error reporting
```

**In Queue messages:**

```typescript
await env.Q_BRAIN.send({
  type: 'message_received',
  traceId: traceId,
  userId: npub,
  // ...
});
```

**Standard properties on EVERY PostHog event:**

```typescript
const standardProps = {
  trace_id: traceId,
  user_id: npub,
  device_id: deviceId,        // from client header
  session_id: sessionId,      // from client header
  app_name: appName,          // 'avachat'|'avatweet'|...
  app_version: appVersion,    // '1.2.3'
  service_name: 'avatok-api', // which Worker
};
```

### 2C. PostHog Event Catalog (ONLY these events)

**Authentication (4 events):**

| Event | Key properties |
|---|---|
| `login_success` | provider, device_type, app_version |
| `login_failed` | provider, failure_reason, device_type |
| `session_expired` | session_duration_minutes |
| `logout` | — |

**Messaging (4 events):**

| Event | Key properties |
|---|---|
| `message_sent` | recipient_npub, message_type (text/image/audio), app_name |
| `message_delivered` | delivery_latency_ms |
| `message_failed` | error_reason, retry_count |
| `message_read` | time_to_read_seconds |

**Calls + Streaming (4 events):**

| Event | Key properties |
|---|---|
| `call_started` | call_type (1:1/group), participants_count |
| `call_ended` | duration_seconds, quality_score |
| `stream_started` | title |
| `stream_ended` | duration_seconds, peak_viewers |

**Uploads + Media (2 events):**

| Event | Key properties |
|---|---|
| `upload_completed` | media_type, size_bytes, path (public/private), moderation_result |
| `upload_failed` | error_reason, media_type |

**AI / AvaBrain (5 events):**

| Event | Key properties |
|---|---|
| `brain_query` | question_length, entities_found, vectors_searched, model, latency_ms |
| `brain_response` | response_length, sources_used, confidence |
| `brain_memory_created` | entity_type, fact_type, source_app |
| `brain_briefing_opened` | highlights_count |
| `brain_investigate` | complaint_type, root_cause_found (bool), events_analyzed |

**Push (2 events):**

| Event | Key properties |
|---|---|
| `push_sent` | platform (fcm/apns), notification_type (message/call/match) |
| `push_failed` | platform, error_reason |

**User Journey Milestones (7 events):**

| Event | Key properties |
|---|---|
| `signup_completed` | provider, device_type |
| `phone_verified` | — |
| `profile_completed` | has_avatar (bool) |
| `first_message_sent` | — |
| `first_reply_received` | time_to_first_reply_hours |
| `first_stream_started` | — |
| `first_match_received` | — |

**Errors (1 event, critical):**

| Event | Key properties |
|---|---|
| `system_error` | service, app_name, severity (critical/high/medium/low), error_message, error_code, stack_trace_short (first 500 chars), affected_feature |

**Total: ~29 event types.** At 5-15 events per user per day, 10K users = 50K-150K events/month. Well within PostHog's 1M free tier.

### 2D. Analytics Engine Instrumentation

**These are high-volume operational metrics. NOT in PostHog.**

Add `writeDataPoint` calls via `ctx.waitUntil` (never blocking):

**API Worker:**
```typescript
ctx.waitUntil(env.ANALYTICS.writeDataPoint({
  blobs: [routeName, method, String(status)],
  doubles: [latencyMs],
  indexes: ['api_request']
}));
```

**Relay DO:**
```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [String(event.kind), 'publish'],
  doubles: [1],
  indexes: ['relay_event']
});
```

**Moderation Consumer:**
```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [model, result],
  doubles: [latencyMs, neuronCount],
  indexes: ['ai_inference']
});
```

**Push Consumer:**
```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [platform, success ? 'delivered' : 'failed'],
  doubles: [1],
  indexes: ['push_delivery']
});
```

**Queue Consumer (all queues):**
```typescript
env.ANALYTICS.writeDataPoint({
  blobs: [queueName, success ? 'completed' : 'failed'],
  doubles: [processingMs],
  indexes: ['queue_job']
});
```

### 2E. PostHog Implementation

**Create a shared PostHog helper (`consumers/src/posthog.ts`):**

```typescript
interface PostHogEvent {
  event: string;
  distinct_id: string;  // npub
  properties: Record<string, any>;
  timestamp?: string;
}

export async function captureEvents(
  events: PostHogEvent[],
  apiKey: string
): Promise<void> {
  // Always batch — never individual calls
  await fetch('https://app.posthog.com/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, batch: events })
  });
}

export function standardProperties(
  traceId: string,
  service: string,
  extra: Record<string, any> = {}
): Record<string, any> {
  return {
    trace_id: traceId,
    service_name: service,
    $lib: 'avatok-server',
    ...extra
  };
}
```

**Capture points (add to existing code, not new Workers):**

- API Worker: capture auth events, upload events, errors — via `ctx.waitUntil` sending to Q_ANALYTICS queue
- Relay DO: capture message_sent/delivered/failed — via Q_ANALYTICS
- Push Consumer: capture push_sent/failed — direct batch call (already in consumer)
- Brain Consumer: capture brain_memory_created — direct batch call
- UserBrain DO: capture brain_query/response/investigate — via Q_ANALYTICS

**Q_ANALYTICS consumer collects all events and sends one batch POST to PostHog every queue batch (up to 50 events at once).**

### 2F. PostHog Dashboards (7 dashboards)

Use the PostHog MCP to create these after event instrumentation is deployed:

**1. System Health**
- Error rate over time (system_error events, grouped by severity)
- Error breakdown by service
- Error breakdown by app_name
- P99 latency trend (from Analytics Engine, not PostHog — display separately)

**2. Authentication Health**
- Login success rate (login_success / (login_success + login_failed))
- Failure reasons breakdown (pie chart)
- Session duration distribution
- Logins by device type

**3. User Journey Funnel**
- signup_completed → phone_verified → profile_completed → first_message_sent → first_reply_received
- Conversion rates between each step
- Time between steps
- Drop-off analysis

**4. Messaging Health**
- Messages sent per day
- Delivery success rate
- message_failed reasons breakdown
- Delivery latency distribution

**5. AI / AvaBrain Health**
- Brain queries per day
- Query latency distribution
- Memory hit rate (entities_found > 0)
- Top question types
- Briefing open rate

**6. Mobile Stability**
- system_error events filtered by app_name
- Errors by app_version (detect bad releases)
- Errors by device_type
- Crash-free session rate

**7. Cross-App Intelligence**
- Events by app_name (which apps are used most)
- Users active across multiple apps
- Feature adoption (first_* milestones)
- Push delivery rates by notification type

### 2G. AvaBrain Investigate Flow (PostHog Integration)

The `investigate()` method on UserBrain DO queries PostHog to debug user complaints.

**Implementation:**

```typescript
async investigate(complaint: string, npub: string): Promise<string> {
  // 1. Determine which PostHog events to search
  const eventTypes = classifyComplaint(complaint);
  // "can't log in" → ['login_failed', 'session_expired', 'system_error']
  // "messages not sending" → ['message_failed', 'system_error']
  // "stream failed" → ['stream_ended', 'system_error']

  // 2. Query PostHog events for this user (last 24h)
  // Use PostHog /api/event endpoint with filters
  const events = await queryPostHog(npub, eventTypes, '24h');

  // 3. Also check system-wide errors (is this user-specific or platform-wide?)
  const systemErrors = await queryPostHog(null, ['system_error'], '1h');

  // 4. Send to Workers AI for root cause analysis
  const diagnosis = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{
      role: 'system',
      content: 'You are a technical support AI. Given the user complaint and the event log, identify the root cause and suggest a fix. Be specific and helpful.'
    }, {
      role: 'user',
      content: `Complaint: "${complaint}"\n\nUser events (last 24h):\n${JSON.stringify(events)}\n\nSystem errors (last 1h):\n${JSON.stringify(systemErrors)}`
    }]
  });

  return diagnosis.response;
}
```

---

## PART 3: WIRING IT ALL TOGETHER

### 3A. New files to create

```
worker/src/do/user_brain.ts        — UserBrain DO (reasoning engine)
worker/src/routes/brain.ts         — /api/brain/* route handlers
worker/migrations/brain.sql        — knowledge graph + memory schema
consumers/src/brain.ts             — Q_BRAIN consumer (event processing)
consumers/src/posthog.ts           — PostHog batch helper
```

### 3B. Files to modify

```
worker/wrangler.toml               — add Q_BRAIN queue, UserBrain DO binding
worker/src/index.ts                — add brain routes, trace ID generation
relay/src/relay_do.ts              — add Q_BRAIN dispatch in onEventSaved
consumers/src/index.ts             — add brain queue consumer, wire PostHog batch
consumers/wrangler.toml            — add Q_BRAIN consumer binding, DB_META binding (for brain tables)
```

### 3C. Secrets needed

```
POSTHOG_API_KEY                    — already staged in deploy.sh
```

No new secrets. Everything runs on Workers AI (existing binding), D1 (existing databases), Vectorize (existing index), and PostHog (key already known).

### 3D. New Queue

```bash
# Create via Cloudflare MCP or wrangler
wrangler queues create brain-events
```

### 3E. Deploy order

1. Run brain.sql migration on DB_META
2. Create brain-events queue
3. Deploy consumers (with brain consumer + PostHog helper)
4. Deploy relay (with Q_BRAIN dispatch)
5. Deploy API worker (with brain routes + UserBrain DO + trace ID)
6. Create PostHog dashboards via PostHog MCP
7. Test: send a message in AvaChat → verify brain_events table gets a row → verify entity extraction → ask "what happened?" via /api/brain/ask

---

## Rules for this session

1. **Do NOT rebuild existing Workers.** Add to them.
2. **Brain tables go in DB_META** (same database, same free tier). They're small — text and JSON, not media.
3. **The brain consumer must be idempotent.** Processing the same event twice should not create duplicate entities — always upsert.
4. **Workers AI calls in the brain consumer must be async (Queue).** Never block a request on LLM inference. The user sends a message → it appears instantly → the brain processes it in the background.
5. **PostHog events go through Q_ANALYTICS** (existing queue), not direct HTTP calls from Workers. The analytics consumer batches them.
6. **Analytics Engine calls use `ctx.waitUntil`** — fire and forget, never block.
7. **Trace ID is a request header, not a body field.** Generate on client, pass as `X-Trace-Id`, read in Worker, attach to all downstream calls.
8. **Test the investigate flow.** Create a deliberate error (e.g., fail a login), wait for it to appear in PostHog, then call `/api/brain/investigate` with "I can't log in" — verify it finds the error and explains it.
9. **Each major piece gets its own commit.** "Add brain schema", "Add brain consumer", "Add UserBrain DO", "Wire PostHog instrumentation", "Create dashboards".
10. **Update BACKEND_REBUILD_HANDOFF.md** with a Session 4 section documenting AvaBrain + Observability.

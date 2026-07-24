// UserBrain — per-user reasoning DO (keyed by uid). Reached via stub.fetch from
// the /api/brain/* routes with a JSON body { op, uid, ... }. Reads the user's
// knowledge graph from DB_BRAIN, recalls semantically-similar memories from
// Vectorize (uid-scoped), and answers with Gemma 4 26B-A4B (MoE: ~4B-class cost,
// native thinking-mode for better reasoning). Importance is decayed LAZILY at read
// time. It holds no JS-heap in-memory state between requests, so it idles to
// nothing when unused — but it now DOES use its own transactional
// `state.storage` (AVABRAIN-SESSION-1: canonical session records + a bounded-TTL
// recentFacts cache), which is durable KV, not memory, and costs nothing while idle.
import type { Env } from "../types";
import { json, aiText, geminiRun } from "../util";
import { avaReasonRaw } from "../lib/ava_reason"; // One Brain B1: gateway for embeddings
import { aiRunOpts } from "../lib/ai_gate";       // AI Gateway cost-logging opts
// AVABRAIN-SESSION-1: consent gating for the citation-bearing recall packet
// (recallPacket() below) — the registry is the ONLY authority for domain scope/
// basis (bible §2.1); we never trust a caller-supplied domain string.
import { isBrainDomain, basisFor, consentKeyFor } from "../lib/brain_domains";

const DECAY_PER_DAY = 0.995;

// ── AVABRAIN-SESSION-1 wire shapes ───────────────────────────────────────────
// One canonical AvaBrainSession + recall-packet contract shared by every
// personal-AI surface (Ask Ava / Companion / @ava thread / voice — bible §9.3).
// Sessions persist in THIS DO's own transactional storage (state.storage),
// keyed by (surface, sub_key) — never a new store, never cross-account (this DO
// is already idFromName(uid)-scoped). History is hard-bounded so a long-running
// companion thread can never grow an unbounded prompt. lib/ava_session.ts is the
// thin service other routes call; it imports ONLY these types (no runtime
// import of this DO class — `import type` is erased at build time).
const SESSION_HISTORY_MAX = 20;
const RECALL_TOKEN_BUDGET = 1200;   // bible §4.2/§P1.4 hard cap
const LOW_CONFIDENCE_THRESHOLD = 0.55;
const FACTS_CACHE_TTL_MS = 60_000;  // bible §11 — never recompute all memory per turn

// ── AVABRAIN-SESSION-1 (SHOULD-FIX 8): bounded session growth ───────────────
// One `session:<surface>:<subKey>` storage key per (surface, subKey) — thread
// (conv id) and voice (call id) subKeys accumulate one key per distinct
// thread/call FOREVER with no eviction, so a long-lived account slowly grows
// an unbounded storage footprint in this DO. This DO has no alarm handler
// anywhere today (checked — grep for "alarm" in this file returns nothing),
// so bolting on an alarm-based sweep would be a new lifecycle primitive for a
// DO that has otherwise stayed alarm-free by design (idles to nothing between
// requests, per the file header). An opportunistic sweep piggybacked on the
// one op that already touches session storage (sessionGetOrCreate) is the
// cleaner fit: no new wake-up path, no risk of an alarm firing after the DO
// would otherwise have gone fully idle, and the cost is trivially bounded
// (see pruneSessions below) so it's cheap enough to run on every call.
const SESSION_MAX_AGE_MS = 30 * 86_400_000; // 30 days
const SESSION_MAX_TOTAL = 200;              // cap per user (this DO is already uid-scoped)
const SESSION_SWEEP_LIMIT = 20;             // max keys deleted per call — amortized, O(small)

export interface SessionTurnWire { role: "user" | "assistant"; text: string; ts: number; trace_id?: string; }
export interface ModelUsageWire {
  provider: string; model: string; input_tokens: number; output_tokens: number;
  latency_ms: number; operation_id: string; ts: number;
}
export interface AvaBrainSessionWire {
  session_id: string;
  uid: string;
  surface: string;           // 'companion' | 'ask_ava' | 'thread' | 'voice'
  sub_key: string;           // '' for companion/ask_ava; conv id (thread) / call id (voice)
  context_hint: string;
  privacy_mode: string;      // 'standard' | 'private_export' | 'restricted'
  created_at: number;
  updated_at: number;
  turn_count: number;
  history: SessionTurnWire[];
  wallet_op_ids: string[];
  last_usage: ModelUsageWire | null;
}
export interface RecallCitationWire {
  source_domain: string;
  source_id: string;
  snippet: string;           // ≤200 chars
  confidence: number;        // 0..1
  ts: number | null;
  low_confidence: boolean;
}
export interface RecallPacketWire {
  hits: RecallCitationWire[];
  token_estimate: number;
  degraded: boolean;
  degraded_reason?: string;
  latency_ms: number;
}

export class UserBrain {
  private env: Env;
  private state: DurableObjectState;
  constructor(state: DurableObjectState, env: Env) { this.state = state; this.env = env; }

  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const uid: string = body.uid;
    if (!uid) return json({ error: "uid required" }, 400);
    switch (body.op) {
      case "ask": return json({ answer: await this.ask(uid, String(body.question || "")) });
      case "chat": return json(await this.chat(uid, String(body.message || "")));
      case "briefing": return json({ briefing: await this.briefing(uid) });
      case "recall": return json(await this.recall(uid, String(body.query || ""), { domains: body.domains, k: body.k }));
      case "remember": return json(await this.remember(uid, body.facts || [], body.entities || []));
      case "investigate": return json({ diagnosis: await this.investigate(uid, String(body.complaint || "")) });
      case "forget": return json(await this.forget(uid, String(body.entity_id || "")));
      case "entities": return json({ entities: await this.topEntities(uid, 50) });
      case "timeline": return json({ events: await this.timeline(uid) });
      // ── AVABRAIN-SESSION-1: canonical session + recall-packet ops. Additive —
      // no existing op's request/response shape is touched. ──────────────────
      case "session_get_or_create":
        return json(await this.sessionGetOrCreate(uid, String(body.surface || "companion"), {
          sub_key: body.sub_key, context_hint: body.context_hint, privacy_mode: body.privacy_mode,
        }));
      case "session_record_turn": {
        const s = await this.sessionRecordTurn(
          String(body.session_id || ""), String(body.surface || ""), String(body.sub_key || ""),
          String(body.role || "user"), String(body.text || ""), body.trace_id ? String(body.trace_id) : undefined,
        );
        return s ? json(s) : json({ error: "session not found" }, 404);
      }
      case "session_note_usage": {
        const s = await this.sessionNoteUsage(
          String(body.session_id || ""), String(body.surface || ""), String(body.sub_key || ""),
          body.usage || {}, body.op_id ? String(body.op_id) : undefined,
        );
        return s ? json(s) : json({ error: "session not found" }, 404);
      }
      case "recall_packet":
        return json(await this.recallPacket(uid, String(body.query || ""), { domains: body.domains, k: body.k }));
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // ---- reads (lazy decay) ----
  private effImportance(importance: number, lastSeen: number): number {
    const days = Math.max(0, (Date.now() - lastSeen) / 86_400_000);
    return importance * Math.pow(DECAY_PER_DAY, days);
  }

  private async topEntities(uid: string, limit: number): Promise<any[]> {
    // Pull a generous slice by raw importance, then re-rank by decayed importance.
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT id, entity_type, name, summary, importance, last_seen FROM brain_entities WHERE uid=?1 ORDER BY importance DESC LIMIT 200",
    ).bind(uid).all();
    return (rs.results ?? [])
      .map((r: any) => ({ ...r, eff: this.effImportance(r.importance, r.last_seen) }))
      .sort((a, b) => b.eff - a.eff)
      .slice(0, limit);
  }

  private async recentFacts(uid: string, limit: number): Promise<any[]> {
    // `id` added (AVABRAIN-SESSION-1) so the recall packet can cite a stable
    // fact id — purely additive column; existing callers (ask/briefing/chat)
    // only read `.content` and are unaffected.
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT id, fact_type, content, scope, source_app, confidence, updated_at FROM brain_facts WHERE uid=?1 ORDER BY updated_at DESC LIMIT ?2",
    ).bind(uid, limit).all();
    return (rs.results ?? []) as any[];
  }

  // ── AVABRAIN-SESSION-1: bounded-TTL cache of recentFacts in DO storage ──────
  // bible §11: "cache stable profile/memory summaries in UserBrainDO storage;
  // never recompute all memory per turn." recentFacts() is query-independent
  // (unlike the Vectorize ANN lookup), so it is the one piece of the recall
  // packet's cost we CAN cache across turns. Invalidated by TTL and by
  // remember() (a new fact should be visible on the next recall, not up to 60s
  // stale). This does not change recentFacts()'s own behavior/contract.
  private async cachedRecentFacts(uid: string, limit: number): Promise<any[]> {
    const key = "cache:recent_facts";
    const now = Date.now();
    try {
      const cached = await this.state.storage.get<{ ts: number; rows: any[] }>(key);
      if (cached && now - cached.ts < FACTS_CACHE_TTL_MS) return cached.rows;
    } catch { /* fall through to a live read */ }
    const rows = await this.recentFacts(uid, limit);
    try { await this.state.storage.put(key, { ts: now, rows }); } catch { /* best-effort cache */ }
    return rows;
  }

  private async recentSummaries(uid: string, limit: number): Promise<any[]> {
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT date, summary FROM brain_daily_summaries WHERE uid=?1 ORDER BY date DESC LIMIT ?2",
    ).bind(uid, limit).all();
    return (rs.results ?? []) as any[];
  }

  private async timeline(uid: string): Promise<any[]> {
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT event_type, source_app, created_at FROM brain_events WHERE uid=?1 ORDER BY created_at DESC LIMIT 50",
    ).bind(uid).all();
    return (rs.results ?? []) as any[];
  }

  // ---- semantic recall (uid-scoped) ----
  // Formats Vectorize matches as context strings for `ask`. Shares the ONE
  // embed+query primitive (rawMatches) with `chat` and `serverRecall` — no
  // duplicate embedding call (B4 refactor).
  private async vectorRecall(uid: string, query: string): Promise<string[]> {
    const matches = await this.rawMatches(uid, query, 6);
    return matches
      .map((m: any) => {
        const md = m.metadata ?? {};
        // Library file vectors carry media_id → cite as a deep-linkable file so
        // the answer can open it in AvaLibrary. Entity vectors stay name: summary.
        if (md.media_id) {
          const where = [md.app, md.category].filter(Boolean).join("/");
          return `File "${md.name ?? "file"}"${where ? ` (${where})` : ""}: ${md.summary ?? ""} [file:${md.media_id}]`;
        }
        return [md.name, md.summary].filter(Boolean).join(": ");
      })
      .filter((s: string) => s);
  }

  // ── One Brain B4 (SPEC-2026-07-17 §6, §8-B4) — unified SERVER-lane recall ────
  // brainRecall(uid, query, {domains?, k}) over the ACCOUNT-PRIVATE server stores
  // only: Vectorize semantic matches + brain_facts. Every server hit is, by
  // construction, scope:'account_private' — device_private data never reaches the
  // server (§2.1), so the server can only ever return account_private hits. The
  // DEVICE lane is merged CLIENT-side (B4-app); this deliberately returns
  // server-lane hits only. Reuses the SAME retrieval internals as `ask`/`chat`
  // (rawMatches embed+query; recentFacts) — no duplicated retrieval path.
  private async serverRecall(
    uid: string,
    query: string,
    opts: { domains?: unknown; k?: unknown } = {},
  ): Promise<Array<{ text: string; domain: string; scope: "account_private"; score: number; ts: number | null }>> {
    if (!query.trim()) return [];
    const k = Math.max(1, Math.min(24, Number(opts.k) || 8));
    const domainSet = Array.isArray(opts.domains) && opts.domains.length
      ? new Set((opts.domains as unknown[]).map((d) => String(d)))
      : null;
    const hits: Array<{ text: string; domain: string; scope: "account_private"; score: number; ts: number | null }> = [];

    // 1. Semantic matches from Vectorize (uid-scoped). Domain derived from the
    //    vector's own metadata (voicemail / library file / entity memory).
    const matches = await this.rawMatches(uid, query, Math.max(k, 12));
    for (const m of matches) {
      const md = (m as any).metadata ?? {};
      const domain =
        md.kind === "voicemail" || md.type === "voicemail" ? "voicemail"
        : md.media_id || md.type === "library" ? "files"
        : "memory";
      if (domainSet && !domainSet.has(domain)) continue;
      const text = String(md.snippet ?? md.summary ?? [md.name, md.summary].filter(Boolean).join(": ")).slice(0, 480);
      if (!text) continue;
      hits.push({ text, domain, scope: "account_private", score: Number((m as any).score ?? 0), ts: md.ts != null ? Number(md.ts) : null });
    }

    // 2. Structured facts (server-derived). Lexically scored against the query so a
    //    recall over the graph surfaces even without a vector hit. `source_app` is
    //    the registry domain / consent key (files, voicemail, listings, …).
    const facts = await this.recentFacts(uid, 60);
    const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    for (const f of facts as any[]) {
      const content = String(f.content ?? "");
      if (!content) continue;
      const domain = String(f.source_app ?? "memory");
      if (domainSet && !domainSet.has(domain)) continue;
      if (!terms.length) continue;
      const lc = content.toLowerCase();
      let overlap = 0;
      for (const t of terms) if (lc.includes(t)) overlap++;
      const score = overlap / terms.length;
      if (score <= 0) continue; // lexical matches only — the vector lane covers semantics
      hits.push({ text: content.slice(0, 480), domain, scope: "account_private", score: 0.3 + 0.4 * score, ts: f.updated_at != null ? Number(f.updated_at) : null });
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  private async recall(uid: string, query: string, opts: { domains?: unknown; k?: unknown }): Promise<{ hits: Array<{ text: string; domain: string; scope: "account_private"; score: number; ts: number | null }> }> {
    return { hits: await this.serverRecall(uid, query, opts) };
  }

  // ---- Phase 9: AvaChat — RAG answer + tappable source chips ----------------
  // Sources: [{app, kind, ref, media_ref, conv, name, snippet}] — the client
  // renders them as cards (open thread / open file in AvaLibrary / play voicemail).
  private async rawMatches(uid: string, query: string, topK: number): Promise<any[]> {
    if (!this.env.VECTOR_INDEX) return [];
    try {
      const emb = (await avaReasonRaw(this.env, {
        role: "brain", capability: "embed", trigger: "recall", feature: "brain_embed",
        verb: "embed", model: this.env.BRAIN_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5", uid,
        raw: { text: query }, aiRunOpts: aiRunOpts(this.env, uid),
      })) as any;
      const vec: number[] | undefined = emb.data?.[0];
      if (!vec) return [];
      // HARD tenant isolation: every query is uid-filtered. 'kind' is filtered
      // in code below (uid is the only indexed metadata field on the index).
      const res = await this.env.VECTOR_INDEX.query(vec, { topK, filter: { uid }, returnMetadata: true } as any);
      return res.matches ?? [];
    } catch { return []; }
  }

  private async chat(uid: string, message: string): Promise<{ answer: string; sources: any[] }> {
    if (!message) return { answer: "Ask me anything about your own messages, files and voice notes.", sources: [] };

    // Voicemail-search intent → restrict to kind=voicemail, return playable refs.
    const vmIntent = /\b(voice\s?-?mails?|voice\s?-?notes?|voice\s?messages?)\b/i.test(message);
    const matches = await this.rawMatches(uid, message, vmIntent ? 24 : 12);
    const filtered = vmIntent ? matches.filter((m: any) => (m.metadata?.kind ?? m.metadata?.type) === "voicemail") : matches;

    const sources: any[] = [];
    const ctxLines: string[] = [];
    for (const m of filtered.slice(0, 8)) {
      const md = m.metadata ?? {};
      const kind = String(md.kind ?? md.type ?? (md.media_id ? "file" : "memory"));
      const snippet = String(md.snippet ?? md.summary ?? "").slice(0, 300);
      if (kind === "voicemail") {
        sources.push({ app: "avatok", kind, conv: md.conv ?? null, media_ref: md.media_ref ?? null, ref: md.media_ref ?? null, name: "Voice note", snippet, ts: md.ts ?? null });
        ctxLines.push(`[voicemail from conversation ${md.conv ?? "?"}] ${snippet}`);
      } else if (kind === "message") {
        sources.push({ app: "avatok", kind, conv: md.conv ?? null, ref: md.conv ?? null, name: md.peer ? `Message (${String(md.peer).slice(0, 12)}…)` : "Message", snippet, ts: md.ts ?? null });
        ctxLines.push(`[message in ${md.conv ?? "?"}] ${snippet}`);
      } else if (md.media_id) {
        sources.push({ app: String(md.app ?? "avalibrary"), kind: "file", ref: md.media_id, media_id: md.media_id, name: md.name ?? "File", snippet, ts: null });
        ctxLines.push(`[file "${md.name ?? "file"}"] ${snippet}`);
      } else if (md.name || md.summary) {
        ctxLines.push(`[memory] ${[md.name, md.summary].filter(Boolean).join(": ").slice(0, 300)}`);
      }
    }

    if (vmIntent && sources.length) {
      // Don't over-think it: the user asked to FIND voicemails — list what matched.
      const n = sources.length;
      return { answer: n === 1 ? "I found this voice note — tap to play it." : `I found ${n} voice notes that match — tap one to play it.`, sources };
    }

    const [facts, summaries] = await Promise.all([this.recentFacts(uid, 20), this.recentSummaries(uid, 3)]);
    const context = JSON.stringify({
      retrieved: ctxLines,
      facts: facts.map((f) => f.content).slice(0, 20),
      recent_days: summaries,
    }).slice(0, 12_000);

    // NOTE: /api/brain/chat is the server-readable SEARCH lane (HttpServerLane) —
    // its caller uses `sources`, not `answer`. Keep it LEAN: a single grounded
    // reasoner call (no tool loop), so a search never triggers an LLM agent or
    // image generation as a side effect. The unified tool-calling brain lives in
    // ChatAVA (routes/ava_gemini.ts) and Messenger @ava (do/ava_agent.ts).
    const answer = await this.reason(
      "You are AvaChat, the user's personal AI over THEIR OWN content (messages, files, voice notes). Answer ONLY from the provided context — never invent facts. When the answer comes from a retrieved item, mention it naturally (the app shows tappable source cards). If the context doesn't contain the answer, say so plainly.",
      `Question: ${message}\n\nContext: ${context}`,
    );
    return { answer, sources };
  }

  // ---- ops ----
  private async ask(uid: string, question: string): Promise<string> {
    if (!question) return "Ask me something about your world.";
    const [entities, facts, summaries, recalls] = await Promise.all([
      this.topEntities(uid, 25), this.recentFacts(uid, 30), this.recentSummaries(uid, 5), this.vectorRecall(uid, question),
    ]);
    const context = JSON.stringify({
      entities: entities.map((e) => ({ name: e.name, type: e.entity_type, summary: e.summary })),
      facts: facts.map((f) => f.content),
      recent_days: summaries,
      related: recalls,
    }).slice(0, 12_000);
    return this.reason(
      "You are the user's personal AI. Answer using ONLY the provided context. If the context doesn't contain the answer, say you don't know. Never invent facts.",
      `Question: ${question}\n\nContext: ${context}`,
    );
  }

  private async briefing(uid: string): Promise<string> {
    const [facts, summaries, entities] = await Promise.all([
      this.recentFacts(uid, 40), this.recentSummaries(uid, 3), this.topEntities(uid, 15),
    ]);
    const context = JSON.stringify({ facts: facts.map((f) => f.content), recent_days: summaries, key_people_projects: entities.map((e) => e.name) }).slice(0, 12_000);
    return this.reason(
      "You write a concise daily briefing for the user. Use ONLY the context. Cover what's recent, pending items, and anything that needs attention. 4-6 sentences.",
      `Context: ${context}`,
    );
  }

  private async remember(uid: string, facts: any[], entities: any[]): Promise<{ stored: number }> {
    const now = Date.now();
    let stored = 0;
    // Client-synced (e.g. DM-derived) memory — stored as scope='private'.
    for (const f of Array.isArray(facts) ? facts.slice(0, 50) : []) {
      const content = String(f.content || f).trim();
      if (!content) continue;
      // B4 (§5.3): stamp derived_from_max_ts + last_confirmed_at so the nightly
      // fact-decay job can age this out (18 mo) / refresh it on re-observation.
      await this.env.DB_BRAIN.prepare(
        `INSERT INTO brain_facts (id, uid, fact_type, content, scope, source_app, confidence, expires_at, created_at, updated_at, derived_from_max_ts, last_confirmed_at)
         VALUES (?1,?2,?3,?4,'private',?5,?6,?7,?8,?8,?8,?8)`,
      ).bind(crypto.randomUUID(), uid, String(f.fact_type || "insight"), content, String(f.source_app || "client"), 0.9, f.expires_at ?? null, now).run();
      stored++;
    }
    for (const e of Array.isArray(entities) ? entities.slice(0, 50) : []) {
      const name = String(e.name || "").trim();
      if (!name) continue;
      const type = String(e.entity_type || "person");
      const existing = await this.env.DB_BRAIN.prepare(
        "SELECT id, importance FROM brain_entities WHERE uid=?1 AND name=?2 AND entity_type=?3",
      ).bind(uid, name, type).first<{ id: string; importance: number }>();
      if (existing) {
        await this.env.DB_BRAIN.prepare("UPDATE brain_entities SET importance=?2, last_seen=?3, updated_at=?3 WHERE id=?1")
          .bind(existing.id, Math.min(1, (existing.importance ?? 0.5) + 0.05), now).run();
      } else {
        await this.env.DB_BRAIN.prepare(
          `INSERT INTO brain_entities (id, uid, entity_type, name, summary, metadata, scope, importance, first_seen, last_seen, updated_at)
           VALUES (?1,?2,?3,?4,?5,NULL,'private',0.6,?6,?6,?6)`,
        ).bind(crypto.randomUUID(), uid, type, name, e.summary ?? null, now).run();
      }
      stored++;
    }
    // AVABRAIN-SESSION-1: a newly-remembered fact must be visible on the very
    // next recall, not up to FACTS_CACHE_TTL_MS stale — drop the cache rather
    // than waiting it out.
    if (stored) { try { await this.state.storage.delete("cache:recent_facts"); } catch { /* best-effort */ } }
    return { stored };
  }

  private async forget(uid: string, entityId: string): Promise<{ ok: boolean }> {
    if (!entityId) return { ok: false };
    await this.env.DB_BRAIN.batch([
      this.env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE id=?1 AND uid=?2").bind(entityId, uid),
      this.env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE uid=?2 AND (from_entity_id=?1 OR to_entity_id=?1)").bind(entityId, uid),
    ]);
    return { ok: true };
  }

  private async investigate(uid: string, complaint: string): Promise<string> {
    const key = this.env.POSTHOG_PERSONAL_API_KEY;
    if (!key) return "Diagnostics are temporarily unavailable.";
    const host = this.env.POSTHOG_QUERY_HOST || "https://us.posthog.com";
    const project = this.env.POSTHOG_PROJECT_ID || "";
    // uid is a safe charset (npub1… / hex); inline guarded.
    const safeNpub = uid.replace(/[^a-z0-9]/gi, "");
    const hogql = `SELECT event, timestamp, properties FROM events WHERE distinct_id = '${safeNpub}' AND timestamp > now() - INTERVAL 1 DAY ORDER BY timestamp DESC LIMIT 100`;
    let events = "[]";
    try {
      const res = await fetch(`${host}/api/projects/${project}/query/`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql } }),
      });
      if (res.ok) { const d = (await res.json()) as any; events = JSON.stringify(d.results ?? d).slice(0, 8000); }
      else return "I couldn't reach the diagnostics service just now — please try again shortly.";
    } catch { return "I couldn't reach the diagnostics service just now — please try again shortly."; }
    return this.reason(
      "You are a technical support AI. Given the user complaint and their recent event log, identify the likely root cause and a concrete next step. Be specific, brief, and reassuring. If the log shows no relevant errors, say it looks healthy.",
      `Complaint: "${complaint}"\n\nRecent events (last 24h): ${events}`,
    );
  }

  // ── AVABRAIN-SESSION-1: canonical session storage (state.storage) ───────────
  // One session per (surface, sub_key). sub_key is '' for companion/ask_ava
  // (one session per user per surface) and a conv/call id for thread/voice
  // (one session per thread/call). No new store — this DO's own transactional
  // storage, already uid-scoped by idFromName(uid).
  private sessionKey(surface: string, subKey: string): string {
    return `session:${surface}:${subKey || "_"}`;
  }

  // ── SHOULD-FIX 8: bounded, amortized sweep ──────────────────────────────────
  // Two independent bounds, both capped to SESSION_SWEEP_LIMIT deletes per call
  // so a single sessionGetOrCreate never does more than one small bounded read
  // + up to 20 deletes of local DO storage (no network I/O, no D1/Vectorize
  // involved) — cheap enough to run unconditionally rather than sampling it:
  //   1. TTL — anything not touched in 30 days is swept first (it is very
  //      unlikely to ever be read again — a stale thread/call session).
  //   2. Cap — if the user is still over SESSION_MAX_TOTAL after the TTL pass,
  //      evict the oldest-by-updated_at survivors until back under the cap
  //      (bounded by whatever sweep budget the TTL pass didn't use).
  // storage.list({prefix, limit}) itself is capped to MAX_TOTAL + SWEEP_LIMIT + 1
  // keys/values so the read side is bounded too — this never scans the user's
  // entire session history no matter how large it has grown historically.
  private async pruneSessions(): Promise<void> {
    try {
      const all = await this.state.storage.list<AvaBrainSessionWire>({
        prefix: "session:", limit: SESSION_MAX_TOTAL + SESSION_SWEEP_LIMIT + 1,
      });
      if (all.size === 0) return;
      const now = Date.now();
      const entries = Array.from(all.entries());

      const toDelete: string[] = [];
      for (const [k, v] of entries) {
        if (toDelete.length >= SESSION_SWEEP_LIMIT) break;
        if (now - (v?.updated_at ?? 0) > SESSION_MAX_AGE_MS) toDelete.push(k);
      }

      const survivingCount = entries.length - toDelete.length;
      if (survivingCount > SESSION_MAX_TOTAL && toDelete.length < SESSION_SWEEP_LIMIT) {
        const deleted = new Set(toDelete);
        const survivors = entries
          .filter(([k]) => !deleted.has(k))
          .sort((a, b) => (a[1]?.updated_at ?? 0) - (b[1]?.updated_at ?? 0));
        const overBy = survivingCount - SESSION_MAX_TOTAL;
        const budget = SESSION_SWEEP_LIMIT - toDelete.length;
        for (const [k] of survivors.slice(0, Math.min(overBy, budget))) toDelete.push(k);
      }

      if (toDelete.length) await this.state.storage.delete(toDelete);
    } catch { /* best-effort — pruning must never block a session read/write */ }
  }

  private async sessionGetOrCreate(
    uid: string, surface: string, opts: { sub_key?: unknown; context_hint?: unknown; privacy_mode?: unknown },
  ): Promise<AvaBrainSessionWire> {
    const subKey = String(opts.sub_key ?? "").slice(0, 128);
    const key = this.sessionKey(surface, subKey);
    const now = Date.now();
    // Opportunistic, amortized sweep (SHOULD-FIX 8) — runs before the read/write
    // below so a freshly-created session never gets swept as its own oldest
    // entry, and so the cap check reflects storage state as of THIS call.
    await this.pruneSessions();
    const existing = await this.state.storage.get<AvaBrainSessionWire>(key);
    if (existing) {
      let changed = false;
      if (opts.context_hint != null) { existing.context_hint = String(opts.context_hint).slice(0, 500); changed = true; }
      if (opts.privacy_mode != null) { existing.privacy_mode = String(opts.privacy_mode).slice(0, 40); changed = true; }
      if (changed) { existing.updated_at = now; await this.state.storage.put(key, existing); }
      return existing;
    }
    const fresh: AvaBrainSessionWire = {
      session_id: crypto.randomUUID(), uid, surface, sub_key: subKey,
      context_hint: String(opts.context_hint ?? "").slice(0, 500),
      privacy_mode: String(opts.privacy_mode ?? "standard").slice(0, 40),
      created_at: now, updated_at: now, turn_count: 0, history: [], wallet_op_ids: [], last_usage: null,
    };
    await this.state.storage.put(key, fresh);
    return fresh;
  }

  private async sessionRecordTurn(
    sessionId: string, surface: string, subKey: string, role: string, text: string, traceId?: string,
  ): Promise<AvaBrainSessionWire | null> {
    if (!sessionId || !surface) return null;
    const key = this.sessionKey(surface, subKey);
    const existing = await this.state.storage.get<AvaBrainSessionWire>(key);
    if (!existing || existing.session_id !== sessionId) return null;
    existing.history.push({
      role: role === "user" ? "user" : "assistant",
      text: String(text).slice(0, 2000),
      ts: Date.now(),
      ...(traceId ? { trace_id: traceId } : {}),
    });
    if (existing.history.length > SESSION_HISTORY_MAX) existing.history = existing.history.slice(-SESSION_HISTORY_MAX);
    existing.turn_count += 1;
    existing.updated_at = Date.now();
    await this.state.storage.put(key, existing);
    return existing;
  }

  private async sessionNoteUsage(
    sessionId: string, surface: string, subKey: string, usage: any, opId?: string,
  ): Promise<AvaBrainSessionWire | null> {
    if (!sessionId || !surface) return null;
    const key = this.sessionKey(surface, subKey);
    const existing = await this.state.storage.get<AvaBrainSessionWire>(key);
    if (!existing || existing.session_id !== sessionId) return null;
    existing.last_usage = {
      provider: String(usage?.provider ?? ""), model: String(usage?.model ?? ""),
      input_tokens: Number(usage?.input_tokens ?? 0), output_tokens: Number(usage?.output_tokens ?? 0),
      latency_ms: Number(usage?.latency_ms ?? 0), operation_id: String(usage?.operation_id ?? opId ?? ""),
      ts: Date.now(),
    };
    if (opId) {
      existing.wallet_op_ids.push(String(opId).slice(0, 80));
      if (existing.wallet_op_ids.length > 20) existing.wallet_op_ids = existing.wallet_op_ids.slice(-20);
    }
    existing.updated_at = Date.now();
    await this.state.storage.put(key, existing);
    return existing;
  }

  // ── AVABRAIN-SESSION-1: consent-gated recall packet (bible §4.2/§P1.4) ──────
  // Per-hit consent check against brain_consent, registry-derived (never a
  // caller-supplied scope — bible §2.1). Legal-basis domains (safety/guardian)
  // are excluded unconditionally: they are never routed through brainIngest/
  // Vectorize in the first place (brain_domains.ts), but this is a deliberate
  // belt-and-suspenders filter so a future accidental producer can't leak one
  // into a citation. This is a SEPARATE method from serverRecall()/recall() —
  // the existing "recall" op's response shape is a live client contract
  // (routes/brain.ts, B4-app device-lane merge) and is deliberately left
  // untouched; this new op is additive.
  private async consentMap(uid: string): Promise<Map<string, boolean>> {
    const m = new Map<string, boolean>();
    try {
      const rs = await this.env.DB_BRAIN.prepare(
        "SELECT capability, enabled FROM brain_consent WHERE uid=?1",
      ).bind(uid).all();
      for (const r of (rs.results ?? []) as any[]) m.set(String(r.capability), Number(r.enabled) === 1);
    } catch { /* default-ON (opt-out model) applies below when the map is empty */ }
    return m;
  }

  private domainConsentOk(domain: string, consent: Map<string, boolean>): boolean {
    if (consent.get("master") === false) return false;
    if (!isBrainDomain(domain)) return true; // internally-derived (e.g. generic 'memory' entity) — governed by master only
    if (basisFor(domain) === "legal") return false; // safety/guardian — never recallable here (§10.3)
    const key = consentKeyFor(domain);
    if (!key) return true;
    return consent.get(key) !== false; // absent row = default ON (opt-out model)
  }

  private async recallPacket(
    uid: string, query: string, opts: { domains?: unknown; k?: unknown },
  ): Promise<RecallPacketWire> {
    const t0 = Date.now();
    const q = (query || "").trim();
    if (!q) return { hits: [], token_estimate: 0, degraded: false, latency_ms: Date.now() - t0 };
    const k = Math.max(1, Math.min(16, Number(opts.k) || 6));
    const domainSet = Array.isArray(opts.domains) && (opts.domains as unknown[]).length
      ? new Set((opts.domains as unknown[]).map((d) => String(d)))
      : null;

    let consent: Map<string, boolean>;
    let matches: any[];
    let facts: any[];
    let degraded = false;
    let degradedReason: string | undefined;
    try {
      [consent, matches, facts] = await Promise.all([
        this.consentMap(uid),
        this.rawMatches(uid, q, Math.max(k * 2, 16)),
        this.cachedRecentFacts(uid, 60),
      ]);
    } catch (e: any) {
      // rawMatches/cachedRecentFacts already swallow their own errors → [];
      // this catch is belt-and-suspenders so a packet is ALWAYS returned
      // (never throws) with a truthful degraded flag instead of a 500.
      consent = new Map(); matches = []; facts = [];
      degraded = true; degradedReason = String(e?.message ?? e).slice(0, 160);
    }

    type Cand = { domain: string; source_id: string; text: string; score: number; ts: number | null };
    const cands: Cand[] = [];

    for (const m of matches) {
      const md = (m as any).metadata ?? {};
      // NIT 9: media_memory vectors (consumers/src/brain.ts ingestMediaMemory,
      // ~line 847: `{ kind: "media_memory", app: "media_memory", media_id, type:
      // "media_memory", ... }`) carry media_id JUST like an AvaLibrary file
      // vector — so without this branch they fell into the generic media_id
      // check below and were mislabeled domain:'files'. That's the WRONG
      // consent key (files vs. media_memory — two separate Settings toggles,
      // BRAIN_DOMAINS in lib/brain_domains.ts) and the wrong citation tag
      // ([files:<id>] instead of [media_memory:<id>]) in the prompt block.
      // Check media_memory BEFORE the media_id/library fallback so it wins.
      const domain = md.kind === "voicemail" || md.type === "voicemail" ? "voicemail"
        : md.kind === "media_memory" || md.type === "media_memory" ? "media_memory"
        : md.media_id || md.type === "library" ? "files"
        : "memory";
      if (domainSet && !domainSet.has(domain)) continue;
      if (!this.domainConsentOk(domain, consent)) continue;
      const text = String(md.snippet ?? md.summary ?? [md.name, md.summary].filter(Boolean).join(": ")).trim();
      if (!text) continue;
      const sourceId = md.media_id ? String(md.media_id) : md.conv ? String(md.conv) : String((m as any).id ?? "");
      cands.push({ domain, source_id: sourceId, text, score: Number((m as any).score ?? 0), ts: md.ts != null ? Number(md.ts) : null });
    }

    const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    if (terms.length) {
      for (const f of facts as any[]) {
        const content = String(f.content ?? "");
        if (!content) continue;
        const domain = String(f.source_app ?? "memory");
        if (domainSet && !domainSet.has(domain)) continue;
        if (!this.domainConsentOk(domain, consent)) continue;
        const lc = content.toLowerCase();
        let overlap = 0;
        for (const t of terms) if (lc.includes(t)) overlap++;
        const score = overlap / terms.length;
        if (score <= 0) continue; // lexical matches only — the vector lane covers semantics
        cands.push({
          domain, source_id: f.id ? String(f.id) : `fact:${domain}:${cands.length}`,
          text: content, score: 0.3 + 0.4 * score, ts: f.updated_at != null ? Number(f.updated_at) : null,
        });
      }
    }

    cands.sort((a, b) => b.score - a.score);

    const hits: RecallCitationWire[] = [];
    let tokenBudget = RECALL_TOKEN_BUDGET;
    for (const c of cands) {
      const snippet = c.text.slice(0, 200);
      const estTokens = Math.ceil(snippet.length / 4) + 8; // + small per-citation overhead (tag/braces)
      if (tokenBudget - estTokens < 0) break;
      const confidence = Math.max(0, Math.min(1, c.score));
      hits.push({
        source_domain: c.domain,
        source_id: c.source_id || `${c.domain}:${hits.length}`,
        snippet, confidence, ts: c.ts,
        low_confidence: confidence < LOW_CONFIDENCE_THRESHOLD,
      });
      tokenBudget -= estTokens;
      if (hits.length >= k) break;
    }

    return {
      hits, token_estimate: RECALL_TOKEN_BUDGET - tokenBudget, degraded, degraded_reason: degradedReason,
      latency_ms: Date.now() - t0,
    };
  }

  private async reason(system: string, user: string): Promise<string> {
    // gemini-3-flash-preview via the DIRECT Google API (the partner route 7003s).
    const started = Date.now();
    try {
      const text = await geminiRun(this.env, system, user, 1536, 0.2);
      try { this.env.ANALYTICS?.writeDataPoint({ blobs: ["brain_reason", "gemini-3-flash-preview"], doubles: [Date.now() - started, 1], indexes: ["brain"] }); } catch { /* noop */ }
      return text || "I don't have enough in memory to answer that yet.";
    } catch {
      return "I couldn't think that through just now — please try again.";
    }
  }
}

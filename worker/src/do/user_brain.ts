// UserBrain — per-user reasoning DO (keyed by uid). Reached via stub.fetch from
// the /api/brain/* routes with a JSON body { op, uid, ... }. Reads the user's
// knowledge graph from DB_BRAIN, recalls semantically-similar memories from
// Vectorize (uid-scoped), and answers with Gemma 4 26B-A4B (MoE: ~4B-class cost,
// native thinking-mode for better reasoning). Importance is decayed LAZILY at read
// time. It holds no in-memory state, so it idles to nothing between requests.
import type { Env } from "../types";
import { json, aiText, geminiRun } from "../util";
import { avaReasonRaw } from "../lib/ava_reason"; // One Brain B1: gateway for embeddings
import { aiRunOpts } from "../lib/ai_gate";       // AI Gateway cost-logging opts

const DECAY_PER_DAY = 0.995;

export class UserBrain {
  private env: Env;
  constructor(_state: DurableObjectState, env: Env) { this.env = env; }

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
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT fact_type, content, scope, source_app, confidence, updated_at FROM brain_facts WHERE uid=?1 ORDER BY updated_at DESC LIMIT ?2",
    ).bind(uid, limit).all();
    return (rs.results ?? []) as any[];
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

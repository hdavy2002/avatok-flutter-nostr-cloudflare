// UserBrain — per-user reasoning DO (keyed by npub). Reached via stub.fetch from
// the /api/brain/* routes with a JSON body { op, npub, ... }. Reads the user's
// knowledge graph from DB_BRAIN, recalls semantically-similar memories from
// Vectorize (npub-scoped), and answers with Gemma 4 26B-A4B (MoE: ~4B-class cost,
// native thinking-mode for better reasoning). Importance is decayed LAZILY at read
// time. It holds no in-memory state, so it idles to nothing between requests.
import type { Env } from "../types";
import { json, aiText } from "../util";

const DECAY_PER_DAY = 0.995;

export class UserBrain {
  private env: Env;
  constructor(_state: DurableObjectState, env: Env) { this.env = env; }

  async fetch(req: Request): Promise<Response> {
    let body: any = {};
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const npub: string = body.npub;
    if (!npub) return json({ error: "npub required" }, 400);
    switch (body.op) {
      case "ask": return json({ answer: await this.ask(npub, String(body.question || "")) });
      case "briefing": return json({ briefing: await this.briefing(npub) });
      case "remember": return json(await this.remember(npub, body.facts || [], body.entities || []));
      case "investigate": return json({ diagnosis: await this.investigate(npub, String(body.complaint || "")) });
      case "forget": return json(await this.forget(npub, String(body.entity_id || "")));
      case "entities": return json({ entities: await this.topEntities(npub, 50) });
      case "timeline": return json({ events: await this.timeline(npub) });
      default: return json({ error: "unknown op" }, 400);
    }
  }

  // ---- reads (lazy decay) ----
  private effImportance(importance: number, lastSeen: number): number {
    const days = Math.max(0, (Date.now() - lastSeen) / 86_400_000);
    return importance * Math.pow(DECAY_PER_DAY, days);
  }

  private async topEntities(npub: string, limit: number): Promise<any[]> {
    // Pull a generous slice by raw importance, then re-rank by decayed importance.
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT id, entity_type, name, summary, importance, last_seen FROM brain_entities WHERE npub=?1 ORDER BY importance DESC LIMIT 200",
    ).bind(npub).all();
    return (rs.results ?? [])
      .map((r: any) => ({ ...r, eff: this.effImportance(r.importance, r.last_seen) }))
      .sort((a, b) => b.eff - a.eff)
      .slice(0, limit);
  }

  private async recentFacts(npub: string, limit: number): Promise<any[]> {
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT fact_type, content, scope, confidence, updated_at FROM brain_facts WHERE npub=?1 ORDER BY updated_at DESC LIMIT ?2",
    ).bind(npub, limit).all();
    return (rs.results ?? []) as any[];
  }

  private async recentSummaries(npub: string, limit: number): Promise<any[]> {
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT date, summary FROM brain_daily_summaries WHERE npub=?1 ORDER BY date DESC LIMIT ?2",
    ).bind(npub, limit).all();
    return (rs.results ?? []) as any[];
  }

  private async timeline(npub: string): Promise<any[]> {
    const rs = await this.env.DB_BRAIN.prepare(
      "SELECT event_type, source_app, created_at FROM brain_events WHERE npub=?1 ORDER BY created_at DESC LIMIT 50",
    ).bind(npub).all();
    return (rs.results ?? []) as any[];
  }

  // ---- semantic recall (npub-scoped) ----
  private async vectorRecall(npub: string, query: string): Promise<string[]> {
    if (!this.env.VECTOR_INDEX) return [];
    try {
      const emb = (await this.env.AI.run((this.env.BRAIN_EMBED_MODEL || "@cf/baai/bge-small-en-v1.5") as any, { text: query })) as any;
      const vec: number[] | undefined = emb.data?.[0];
      if (!vec) return [];
      // Vectors are per-entity; metadata carries name+summary, so no D1 round-trip.
      const res = await this.env.VECTOR_INDEX.query(vec, { topK: 6, filter: { npub }, returnMetadata: true } as any);
      return (res.matches ?? [])
        .map((m: any) => [m.metadata?.name, m.metadata?.summary].filter(Boolean).join(": "))
        .filter((s: string) => s);
    } catch { return []; }
  }

  // ---- ops ----
  private async ask(npub: string, question: string): Promise<string> {
    if (!question) return "Ask me something about your world.";
    const [entities, facts, summaries, recalls] = await Promise.all([
      this.topEntities(npub, 25), this.recentFacts(npub, 30), this.recentSummaries(npub, 5), this.vectorRecall(npub, question),
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

  private async briefing(npub: string): Promise<string> {
    const [facts, summaries, entities] = await Promise.all([
      this.recentFacts(npub, 40), this.recentSummaries(npub, 3), this.topEntities(npub, 15),
    ]);
    const context = JSON.stringify({ facts: facts.map((f) => f.content), recent_days: summaries, key_people_projects: entities.map((e) => e.name) }).slice(0, 12_000);
    return this.reason(
      "You write a concise daily briefing for the user. Use ONLY the context. Cover what's recent, pending items, and anything that needs attention. 4-6 sentences.",
      `Context: ${context}`,
    );
  }

  private async remember(npub: string, facts: any[], entities: any[]): Promise<{ stored: number }> {
    const now = Date.now();
    let stored = 0;
    // Client-synced (e.g. DM-derived) memory — stored as scope='private'.
    for (const f of Array.isArray(facts) ? facts.slice(0, 50) : []) {
      const content = String(f.content || f).trim();
      if (!content) continue;
      await this.env.DB_BRAIN.prepare(
        `INSERT INTO brain_facts (id, npub, fact_type, content, scope, source_app, confidence, expires_at, created_at, updated_at)
         VALUES (?1,?2,?3,?4,'private',?5,?6,?7,?8,?8)`,
      ).bind(crypto.randomUUID(), npub, String(f.fact_type || "insight"), content, String(f.source_app || "client"), 0.9, f.expires_at ?? null, now).run();
      stored++;
    }
    for (const e of Array.isArray(entities) ? entities.slice(0, 50) : []) {
      const name = String(e.name || "").trim();
      if (!name) continue;
      const type = String(e.entity_type || "person");
      const existing = await this.env.DB_BRAIN.prepare(
        "SELECT id, importance FROM brain_entities WHERE npub=?1 AND name=?2 AND entity_type=?3",
      ).bind(npub, name, type).first<{ id: string; importance: number }>();
      if (existing) {
        await this.env.DB_BRAIN.prepare("UPDATE brain_entities SET importance=?2, last_seen=?3, updated_at=?3 WHERE id=?1")
          .bind(existing.id, Math.min(1, (existing.importance ?? 0.5) + 0.05), now).run();
      } else {
        await this.env.DB_BRAIN.prepare(
          `INSERT INTO brain_entities (id, npub, entity_type, name, summary, metadata, scope, importance, first_seen, last_seen, updated_at)
           VALUES (?1,?2,?3,?4,?5,NULL,'private',0.6,?6,?6,?6)`,
        ).bind(crypto.randomUUID(), npub, type, name, e.summary ?? null, now).run();
      }
      stored++;
    }
    return { stored };
  }

  private async forget(npub: string, entityId: string): Promise<{ ok: boolean }> {
    if (!entityId) return { ok: false };
    await this.env.DB_BRAIN.batch([
      this.env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE id=?1 AND npub=?2").bind(entityId, npub),
      this.env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE npub=?2 AND (from_entity_id=?1 OR to_entity_id=?1)").bind(entityId, npub),
    ]);
    return { ok: true };
  }

  private async investigate(npub: string, complaint: string): Promise<string> {
    const key = this.env.POSTHOG_PERSONAL_API_KEY;
    if (!key) return "Diagnostics are temporarily unavailable.";
    const host = this.env.POSTHOG_QUERY_HOST || "https://us.posthog.com";
    const project = this.env.POSTHOG_PROJECT_ID || "";
    // npub is a safe charset (npub1… / hex); inline guarded.
    const safeNpub = npub.replace(/[^a-z0-9]/gi, "");
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
    const model = this.env.BRAIN_REASONER_MODEL || "@cf/google/gemma-4-26b-a4b-it";
    const started = Date.now();
    try {
      // Single user message (sys + ask): portable to Gemma 4 (no system role).
      // max_tokens leaves room for thinking-mode before the answer; aiText reads
      // the final content out of the choices/message shape.
      const out = (await this.env.AI.run(model as any, {
        messages: [{ role: "user", content: `${system}\n\n${user}` }],
        max_tokens: 1536, temperature: 0.2,
      })) as unknown;
      try { this.env.ANALYTICS?.writeDataPoint({ blobs: ["brain_reason", model], doubles: [Date.now() - started, 1], indexes: ["brain"] }); } catch { /* noop */ }
      return aiText(out).trim() || "I don't have enough in memory to answer that yet.";
    } catch {
      return "I couldn't think that through just now — please try again.";
    }
  }
}

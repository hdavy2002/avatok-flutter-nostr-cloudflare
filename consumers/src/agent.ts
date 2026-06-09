// agent-tasks consumer (Phase 7). 'converse' triggers the per-conversation
// ConversationDO turn loop (cross-script DO in avatok-api). 'task' is reserved for
// per-app hooks (Phase 8). The heavy AI work lives in the DO; this is a thin trigger.
import type { Env, AgentMsg } from "./types";

export async function handleAgent(msg: AgentMsg, env: Env): Promise<void> {
  if (msg.type === "converse") {
    if (!env.CONVERSATION_DO || !msg.conversation_id || !msg.peer_npub) return;
    const stub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(msg.conversation_id));
    const res = await stub.fetch("https://conv/run", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "run", conversation_id: msg.conversation_id, uid: msg.uid, app: msg.app, peer_npub: msg.peer_npub }),
    });
    if (!res.ok) throw new Error("conversation run failed: " + res.status); // retry
    return;
  }
  // 'task' (per-app hooks, Phase 8). Each app's hook proposes a scoped action; we
  // surface it as an Agent Inbox 'action' item so the user approves (no auto-commit).
  if (msg.type === "task") {
    if (!env.DB_META) return;
    // Per-app proposed action mapping (§20 hooks).
    const ACTIONS: Record<string, string> = {
      find_matches: "connect", negotiate: "buy", propose_booking: "book",
      draft_reply: "reply", outreach: "connect", promote: "post",
    };
    const proposed = ACTIONS[msg.kind || ""] || "review";
    // Respect the persona's auto_approve for the 1h-undo window.
    const persona = await env.DB_META.prepare("SELECT auto_approve, enabled FROM agent_personas WHERE uid=?1 AND app_name=?2")
      .bind(msg.uid, msg.app).first<any>().catch(() => null);
    if (!persona || !persona.enabled) return; // no active persona for this app → no-op
    const auto = persona.auto_approve === 1 && proposed !== "buy"; // never auto a coin spend (§22)
    const now = Date.now();
    const title: Record<string, string> = {
      find_matches: "Your agent found people to connect with",
      negotiate: "Your agent negotiated a deal", propose_booking: "Your agent proposes a booking",
      draft_reply: "Your agent drafted a reply", outreach: "Your agent reached out", promote: "Your agent prepared a post",
    };
    await env.DB_META.prepare(
      `INSERT INTO agent_inbox (id, uid, app_name, conversation_id, type, title, body, summary, proposed_action, status, undo_until, data, created_at)
       VALUES (?1,?2,?3,NULL,'action',?4,?5,?6,?7,?8,?9,?10,?11)`,
    ).bind(
      crypto.randomUUID(), msg.uid, msg.app,
      title[msg.kind || ""] || "Your agent has a suggestion",
      JSON.stringify(msg.payload ?? {}).slice(0, 500), null, proposed,
      auto ? "auto_approved" : "pending", auto ? now + 3600_000 : null,
      JSON.stringify(msg.payload ?? {}), now,
    ).run();
  }
}

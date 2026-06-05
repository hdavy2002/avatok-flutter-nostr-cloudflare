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
      body: JSON.stringify({ op: "run", conversation_id: msg.conversation_id, npub: msg.npub, app: msg.app, peer_npub: msg.peer_npub }),
    });
    if (!res.ok) throw new Error("conversation run failed: " + res.status); // retry
    return;
  }
  // 'task' (per-app hooks) — Phase 8.
}

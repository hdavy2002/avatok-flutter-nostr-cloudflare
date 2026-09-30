// [SAATHUM-PREETI-1 2026-09-30] Daily chat-side maintenance (12-month retention purge + spend-alert re-check).
// The cron ticks every 5 minutes, so this self-throttles to once per IST day through KV. The knowledge side
// (site sync) is runPreetiDailyMaintenance in knowledge.ts and is called separately from scheduled().
import type { Env } from "../../types";
import { track } from "../../hooks";
import { checkSpendAlerts } from "./spend";
import { purgeOldChats } from "./store";

export async function runPreetiChatMaintenance(env: Env): Promise<void> {
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const key = `preeti_chat_maint:${day}`;
  if (await env.TOKENS.get(key)) return;
  await env.TOKENS.put(key, "1", { expirationTtl: 2 * 24 * 3600 });
  const r = await purgeOldChats(env);
  await checkSpendAlerts(env);
  await track(env, "system", "preeti_retention_purge", "saathum", { day, messages_deleted: r.messages, conversations_deleted: r.conversations });
}

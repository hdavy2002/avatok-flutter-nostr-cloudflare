// [AUMFE-CONSULT-FOUNDATION-1] One cron entry for Real Consultants (called from index.ts scheduled(), every 5 min).
// Each step lives in its lane's file; this list is append-only. Every step must be cheap when there is nothing to do.
import type { Env } from "../../types";
import { expireHeldBookings } from "./payment";     // lane W1
import { runPrepareJobs } from "./prepare";         // lane W2
import { runConsultReminders } from "./notify";     // lane W3
import { settleDueSessions } from "./settle";       // lane W3

export async function runConsultCron(env: Env): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["expire", () => expireHeldBookings(env)],
    ["prepare", () => runPrepareJobs(env)],
    ["remind", () => runConsultReminders(env)],
    ["settle", () => settleDueSessions(env)],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { console.error(`[consult-cron:${name}]`, String(e)); }
  }
}

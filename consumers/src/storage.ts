// AvaStorage billing + snapshots (Phase 4) — runs from the consumers cron.
//
//   storageSnapshots()  — daily: upsert this month's used_bytes per user into
//                         storage_snapshots (AvaStorage trend mini-bars).
//   storageBilling()    — monthly (1st, UTC midnight tick): every user over the
//                         free quota pays 20 AvaCoins/GB/month from the AvaWallet
//                         (WalletDO `spend`, idempotent op_id `storage:<uid>:<YYYY-MM>`,
//                         double-entry ledger row type `storage_charge`).
//                         Empty wallet ⇒ state read_only — files are NEVER deleted
//                         (rulebook §3); topping up + next upload/recompute unblocks.
import type { Env } from "./types";

const GB = 1024 * 1024 * 1024;

function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/** Daily: snapshot every user's current usage into this month's row. */
export async function storageSnapshots(env: Env): Promise<void> {
  await env.DB_MEDIA.prepare(
    `INSERT INTO storage_snapshots (uid, month, used_bytes)
     SELECT uid, ?1, used_bytes FROM storage_quota
     ON CONFLICT(uid, month) DO UPDATE SET used_bytes=excluded.used_bytes`,
  ).bind(monthKey()).run();
}

/** Monthly: meter over-quota users. Returns {charged, locked} for the cron log. */
export async function storageBilling(env: Env): Promise<{ charged: number; locked: number }> {
  if (!env.WALLET_DO) return { charged: 0, locked: 0 }; // wallet DO not bound → skip
  const coinsPerGb = Number(env.STORAGE_COINS_PER_GB || "20");
  const month = monthKey();
  const over = await env.DB_MEDIA.prepare(
    "SELECT uid, used_bytes, quota_bytes, state FROM storage_quota WHERE used_bytes > quota_bytes LIMIT 2000",
  ).all();
  let charged = 0, locked = 0;
  for (const r of (over.results ?? []) as any[]) {
    const uid = String(r.uid);
    const gbOver = Math.ceil((Number(r.used_bytes) - Number(r.quota_bytes)) / GB);
    const amount = gbOver * coinsPerGb;
    if (amount <= 0) continue;
    let status = 0;
    try {
      const stub = env.WALLET_DO.get(env.WALLET_DO.idFromName(uid));
      const resp = await stub.fetch("https://wallet/op", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "spend", uid, amount, type: "spend", app_name: "avastorage",
          ref: `storage:${month}`, op_id: `storage:${uid}:${month}`, // idempotent — one charge per month
          ledger: {
            debit: `user:${uid}`, credit: "platform:storage", type: "storage_charge", ref: `storage:${month}`,
            meta: JSON.stringify({ gb_over: gbOver, coins_per_gb: coinsPerGb, used_bytes: r.used_bytes, quota_bytes: r.quota_bytes }),
          },
        }),
      });
      status = resp.status;
    } catch { status = 0; } // transient — leave state as-is, retried next month
    const newState = status === 200 ? "over_quota_paying" : status === 402 ? "read_only" : String(r.state);
    if (newState !== r.state) {
      await env.DB_MEDIA.prepare("UPDATE storage_quota SET state=?2, updated_at=?3 WHERE uid=?1")
        .bind(uid, newState, Date.now()).run();
      try {
        await env.Q_ANALYTICS?.send({
          event: "quota_state_changed", uid, ts: Date.now(),
          props: { state: newState, app_name: "avastorage", app: "avastorage", app_version: "server", service_name: "avatok-consumers", worker: true, account_id: uid, trace_id: crypto.randomUUID() },
        });
      } catch { /* best-effort */ }
    }
    if (status === 200) charged++;
    if (status === 402) locked++;
    try {
      await env.Q_ANALYTICS?.send({
        event: "storage_charge", uid, ts: Date.now(),
        props: { amount, gb_over: gbOver, ok: status === 200, app_name: "avastorage", app: "avastorage", app_version: "server", service_name: "avatok-consumers", worker: true, account_id: uid, trace_id: crypto.randomUUID() },
      });
    } catch { /* best-effort */ }
  }
  return { charged, locked };
}

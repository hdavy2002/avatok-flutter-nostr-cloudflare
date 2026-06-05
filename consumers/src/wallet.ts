// wallet-transactions consumer (Phase 2) — writes the D1 audit trail for balance
// mutations that happen authoritatively inside WalletDO. Idempotent on tx id.
import type { Env, WalletTxMsg } from "./types";

export async function handleWalletTx(msg: WalletTxMsg, env: Env): Promise<void> {
  if (!env.DB_WALLET) return;
  const now = msg.ts ?? Date.now();

  // Ledger row (idempotent: id is the PK; ignore replays).
  await env.DB_WALLET.prepare(
    `INSERT INTO wallet_transactions (id, npub, type, amount, balance_after, app_name, counterparty_npub, commission, ref, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'settled',?10)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    msg.id, msg.npub, msg.type, msg.amount, msg.balance_after ?? null,
    msg.app_name ?? null, msg.counterparty_npub ?? null, msg.commission ?? 0, msg.ref ?? null, now,
  ).run();

  // Earnings hold mirror (for the /earnings route).
  if (msg.type === "earn" && msg.hold_until) {
    await env.DB_WALLET.prepare(
      "INSERT INTO earning_holds (id, npub, amount, source_app, source_tx_id, available_at, released, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7) ON CONFLICT(id) DO NOTHING",
    ).bind(crypto.randomUUID(), msg.npub, msg.amount, msg.app_name ?? null, msg.id, msg.hold_until, now).run();
  }

  // Balance mirror (eventually-consistent; DO is the source of truth).
  if (typeof msg.balance_after === "number" && (msg.type === "topup" || msg.type === "spend" || msg.type === "refund" || msg.type === "payout")) {
    await env.DB_WALLET.prepare(
      "INSERT INTO wallet_balances (npub, balance, updated_at) VALUES (?1,?2,?3) ON CONFLICT(npub) DO UPDATE SET balance=?2, updated_at=?3",
    ).bind(msg.npub, msg.balance_after, now).run();
  } else if (msg.type === "earn") {
    await env.DB_WALLET.prepare(
      "INSERT INTO wallet_balances (npub, held, updated_at) VALUES (?1,?2,?3) ON CONFLICT(npub) DO UPDATE SET held=held+?2, updated_at=?3",
    ).bind(msg.npub, msg.amount, now).run();
  }
}

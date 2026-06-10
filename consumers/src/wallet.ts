// wallet-transactions consumer (Phase 2) — writes the D1 audit trail for balance
// mutations that happen authoritatively inside WalletDO. Idempotent on tx id.
//
// Double-entry layer: when the message carries `ledger`, ONE atomic D1 batch
// inserts the wallet_ledger row (PK = op_id → replay no-op) and RECOMPUTES the
// touched escrow/platform bucket balances from the ledger itself — fully
// idempotent, no read-modify-write races, recon-friendly.
import type { Env, WalletTxMsg } from "./types";

const isBucket = (acct: string) => acct.startsWith("escrow:") || acct.startsWith("platform:");

async function applyLedger(msg: WalletTxMsg, env: Env, now: number): Promise<void> {
  const l = msg.ledger!;
  const buckets = [l.debit, l.credit].filter(isBucket);
  const stmts = [
    env.DB_WALLET!.prepare(
      `INSERT INTO wallet_ledger (id, debit, credit, amount, type, ref, meta, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO NOTHING`,
    ).bind(msg.id, l.debit, l.credit, Math.abs(Number(msg.amount ?? 0)) || extractAmount(l), l.type, l.ref ?? null, l.meta ?? null, now),
  ];
  for (const b of buckets) {
    stmts.push(env.DB_WALLET!.prepare(
      "INSERT INTO wallet_accounts (id, kind, balance, updated_at) VALUES (?1,?2,0,?3) ON CONFLICT(id) DO NOTHING",
    ).bind(b, b.startsWith("escrow:") ? "escrow" : "platform", now));
    stmts.push(env.DB_WALLET!.prepare(
      `UPDATE wallet_accounts SET balance =
         COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE credit=?1),0)
       - COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE debit=?1),0),
       updated_at=?2 WHERE id=?1`,
    ).bind(b, now));
  }
  await env.DB_WALLET!.batch(stmts);
}

// Ledger-only fee rows carry the amount inside meta (gross*rate) — fall back hard.
function extractAmount(l: NonNullable<WalletTxMsg["ledger"]>): number {
  try { const m = l.meta ? JSON.parse(l.meta) : {}; return Math.abs(Number(m.fee ?? m.amount ?? m.gross ?? 0)); } catch { return 0; }
}

export async function handleWalletTx(msg: WalletTxMsg, env: Env): Promise<void> {
  if (!env.DB_WALLET) return;
  const now = msg.ts ?? Date.now();

  // Phase 2: double-entry row + bucket recompute (atomic batch).
  if (msg.ledger?.debit && msg.ledger?.credit) await applyLedger(msg, env, now);

  // Ledger-only message (no user-account side): done.
  if (!msg.uid || !msg.type) return;

  // Ledger row (idempotent: id is the PK; ignore replays).
  await env.DB_WALLET.prepare(
    `INSERT INTO wallet_transactions (id, uid, type, amount, balance_after, app_name, counterparty_npub, commission, ref, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'settled',?10)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(
    msg.id, msg.uid, msg.type, msg.amount, msg.balance_after ?? null,
    msg.app_name ?? null, msg.counterparty_npub ?? null, msg.commission ?? 0, msg.ref ?? null, now,
  ).run();

  // Earnings hold mirror (for the /earnings route).
  if (msg.type === "earn" && msg.hold_until) {
    await env.DB_WALLET.prepare(
      "INSERT INTO earning_holds (id, uid, amount, source_app, source_tx_id, available_at, released, created_at) VALUES (?1,?2,?3,?4,?5,?6,0,?7) ON CONFLICT(id) DO NOTHING",
    ).bind(crypto.randomUUID(), msg.uid, msg.amount, msg.app_name ?? null, msg.id, msg.hold_until, now).run();
  }

  // Balance mirror (eventually-consistent; DO is the source of truth).
  if (typeof msg.balance_after === "number" && (msg.type === "topup" || msg.type === "spend" || msg.type === "refund" || msg.type === "payout")) {
    await env.DB_WALLET.prepare(
      "INSERT INTO wallet_balances (uid, balance, updated_at) VALUES (?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET balance=?2, updated_at=?3",
    ).bind(msg.uid, msg.balance_after, now).run();
  } else if (msg.type === "earn") {
    await env.DB_WALLET.prepare(
      "INSERT INTO wallet_balances (uid, held, updated_at) VALUES (?1,?2,?3) ON CONFLICT(uid) DO UPDATE SET held=held+?2, updated_at=?3",
    ).bind(msg.uid, msg.amount, now).run();
  }
}

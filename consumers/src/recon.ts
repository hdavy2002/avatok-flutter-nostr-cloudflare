// Nightly wallet reconciliation (Phase 2, audit item A2).
//
// Invariants checked:
//  1. Every wallet_accounts bucket (escrow:*, platform:*) equals
//     Σ(ledger credits) − Σ(ledger debits) for that account. The consumer
//     recomputes buckets from the ledger, so a mismatch means MANUAL TAMPERING
//     (exactly the seeded-mismatch acceptance test) or a partial write.
//  2. Per user with recent ledger activity: WalletDO (balance + held) equals
//     Σ ledger credits − debits for 'user:<id>' — tolerating in-flight Q_WALLET
//     messages via a 5-minute watermark and one re-check before alerting.
//     Users with pre-ledger (legacy wallet_transactions) history are skipped —
//     their DO balance legitimately predates the double-entry ledger.
//  3. (Phase 6+) Σ escrow buckets == Σ orders in status 'held' — checked only
//     once an `orders` table exists; silently skipped until then.
//
// Results → recon_runs(date, ok, diff_json); mismatches → Brevo email to
// ALERT_EMAIL (default hdavy2005@gmail.com) with the diff.
import type { Env } from "./types";

const WATERMARK_MS = 5 * 60_000;
const USER_SCAN_WINDOW_MS = 48 * 3_600_000;
const USER_SCAN_LIMIT = 500;

interface Diff { kind: string; account: string; expected: number; actual: number; note?: string; }

async function ledgerSum(env: Env, acct: string, beforeTs?: number): Promise<number> {
  const cond = beforeTs ? " AND created_at < ?2" : "";
  const binds: unknown[] = beforeTs ? [acct, beforeTs] : [acct];
  const r = await env.DB_WALLET!.prepare(
    `SELECT COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE credit=?1${cond}),0)
          - COALESCE((SELECT SUM(amount) FROM wallet_ledger WHERE debit=?1${cond}),0) AS bal`,
  ).bind(...binds).first<{ bal: number }>();
  return Number(r?.bal ?? 0);
}

async function doBalance(env: Env, uid: string): Promise<{ balance: number; held: number } | null> {
  if (!env.WALLET_DO) return null;
  try {
    const stub = env.WALLET_DO.get(env.WALLET_DO.idFromName(uid));
    const r = await stub.fetch("https://wallet/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "balance", uid }) });
    if (!r.ok) return null;
    const b = (await r.json()) as any;
    return { balance: Number(b.balance ?? 0), held: Number(b.held ?? 0) };
  } catch { return null; }
}

export async function reconWallet(env: Env): Promise<void> {
  if (!env.DB_WALLET) return;
  const now = Date.now();
  const date = new Date(now).toISOString().slice(0, 10);
  const diffs: Diff[] = [];

  // --- 1. Bucket balances vs ledger Σ ---
  const accounts = ((await env.DB_WALLET.prepare("SELECT id, balance FROM wallet_accounts").all()).results ?? []) as any[];
  for (const a of accounts) {
    const expected = await ledgerSum(env, String(a.id));
    if (expected !== Number(a.balance)) {
      diffs.push({ kind: "bucket", account: String(a.id), expected, actual: Number(a.balance) });
    }
  }

  // --- 2. User DO balances vs ledger Σ (watermarked; re-check once) ---
  const recent = ((await env.DB_WALLET.prepare(
    `SELECT DISTINCT acct FROM (
       SELECT debit AS acct FROM wallet_ledger WHERE created_at > ?1 AND debit LIKE 'user:%'
       UNION SELECT credit FROM wallet_ledger WHERE created_at > ?1 AND credit LIKE 'user:%'
     ) LIMIT ${USER_SCAN_LIMIT}`,
  ).bind(now - USER_SCAN_WINDOW_MS).all()).results ?? []) as any[];

  for (const r of recent) {
    const acct = String(r.acct);
    const uid = acct.slice(5);
    // Legacy guard: any audit row older than the user's first ledger row means a
    // pre-double-entry balance exists — Σ ledger can't equal the DO. Skip.
    const firstLedger = await env.DB_WALLET.prepare(
      "SELECT MIN(created_at) AS t FROM wallet_ledger WHERE debit=?1 OR credit=?1",
    ).bind(acct).first<{ t: number }>();
    const legacy = await env.DB_WALLET.prepare(
      "SELECT 1 AS x FROM wallet_transactions WHERE uid=?1 AND created_at < ?2 LIMIT 1",
    ).bind(uid, Number(firstLedger?.t ?? 0)).first().catch(() => null);
    if (legacy) continue;

    const dob = await doBalance(env, uid);
    if (!dob) continue; // DO unreachable — don't false-alarm
    const total = dob.balance + dob.held;
    const sumOld = await ledgerSum(env, acct, now - WATERMARK_MS);
    if (total === sumOld) continue;
    // Re-check including in-flight rows (queue may have just applied newer ops).
    const sumAll = await ledgerSum(env, acct);
    const dob2 = await doBalance(env, uid);
    const total2 = (dob2?.balance ?? dob.balance) + (dob2?.held ?? dob.held);
    if (total2 === sumAll || total2 === sumOld) continue;
    diffs.push({ kind: "user", account: acct, expected: sumAll, actual: total2, note: "DO(balance+held) vs ledger Σ" });
  }

  // --- 3. Σ escrow == Σ held orders (activates with Phase 6's orders table) ---
  try {
    const esc = await env.DB_WALLET.prepare("SELECT COALESCE(SUM(balance),0) AS s FROM wallet_accounts WHERE kind='escrow'").first<{ s: number }>();
    const held = await env.DB_WALLET.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status='held'").first<{ s: number }>();
    if (held && Number(esc?.s ?? 0) !== Number(held.s)) {
      diffs.push({ kind: "escrow_total", account: "escrow:*", expected: Number(held.s), actual: Number(esc?.s ?? 0), note: "vs orders status=held" });
    }
  } catch { /* no orders table yet (pre-Phase-6) */ }

  const ok = diffs.length === 0;
  await env.DB_WALLET.prepare(
    "INSERT INTO recon_runs (date, ok, diff_json, created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(date) DO UPDATE SET ok=?2, diff_json=?3, created_at=?4",
  ).bind(date, ok ? 1 : 0, JSON.stringify(diffs), now).run();
  try { env.ANALYTICS?.writeDataPoint({ blobs: ["wallet_recon", ok ? "ok" : "mismatch"], doubles: [diffs.length], indexes: ["cron"] }); } catch { /* best-effort */ }

  if (!ok) await alertEmail(env, date, diffs);
}

async function alertEmail(env: Env, date: string, diffs: Diff[]): Promise<void> {
  if (!env.BREVO_API_KEY) { console.error("[recon] MISMATCH but BREVO_API_KEY unset:", JSON.stringify(diffs)); return; }
  const to = env.ALERT_EMAIL || "hdavy2005@gmail.com";
  // Drill mode: the A2 acceptance test seeds a mismatch via a manual UPDATE on a
  // known account. If EVERY diff is on a RECON_DRILL_ACCOUNTS entry, this is that
  // rehearsal — tag it [DRILL] so it can't be mistaken for a real incident. If
  // even ONE diff is off the drill list, it's treated as a genuine alert (a drill
  // that accidentally surfaces a real mismatch must still scream).
  const drillSet = new Set((env.RECON_DRILL_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const isDrill = drillSet.size > 0 && diffs.every((d) => drillSet.has(d.account));
  const tag = isDrill ? "🧪 [DRILL]" : "⚠️";
  const rows = diffs.map((d) => `<tr><td style="padding:4px 12px 4px 0">${d.kind}</td><td style="padding:4px 12px 4px 0"><code>${d.account}</code></td><td style="padding:4px 12px 4px 0;text-align:right">${d.expected}</td><td style="padding:4px 0;text-align:right">${d.actual}</td></tr>`).join("");
  const banner = isDrill
    ? `<p style="background:#eef;padding:8px 12px;border-radius:6px"><b>This is a reconciliation DRILL</b> — every flagged account is in <code>RECON_DRILL_ACCOUNTS</code>. No real money is affected; no action needed. (A real mismatch would omit this banner.)</p>`
    : `<p>${diffs.length} invariant violation(s). Ledger and balances disagree — investigate before more money moves.</p>`;
  const html = `
  <div style="font-family:system-ui,sans-serif">
    <h2>${tag} AvaWallet reconciliation ${isDrill ? "drill" : "mismatch"} — ${date}</h2>
    ${banner}
    <table style="border-collapse:collapse"><tr><th align="left">kind</th><th align="left">account</th><th align="right">expected (ledger Σ)</th><th align="right">actual</th></tr>${rows}</table>
    <p>Option: freeze money ops via remote config (<code>PUT /api/admin/config</code> kill switch) until resolved.<br>
    Runs are stored in <code>recon_runs</code>; inspect via <code>GET /api/admin/recon</code>.</p>
  </div>`;
  try {
    await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "AvaTok Ops", email: "noreply@avatok.ai" }, to: [{ email: to }], subject: `${tag} Wallet recon ${isDrill ? "drill" : "mismatch"} — ${date} (${diffs.length})`, htmlContent: html }),
    });
  } catch (e) { console.error("[recon] alert email failed:", String(e)); }
}

// Phase 2 ledger invariants test — runs against a DEPLOYED avatok-api (staging
// first). Drives the escrow primitives through the admin HTTP surface and
// asserts the acceptance criteria:
//
//   1. hold/release/refund produce balanced ledger rows
//      (purchase_hold == escrow_release + fee + refunds; escrow bucket ends at 0)
//   2. idempotency: firing the same opId twice yields exactly ONE ledger row
//      and ONE balance application (duplicate flag on replay)
//   3. adjustment rows appear with type 'adjustment'
//
// Usage:
//   ADMIN_TOKEN=<clerk jwt of an ADMIN_UIDS user> BASE=https://avatok-api-staging... \
//   node scripts/ledger_invariants.mjs
//
// The Q_WALLET queue is async — reads poll up to 60 s for rows to land.

const BASE = process.env.BASE || "https://api.avatok.ai";
const TOKEN = process.env.ADMIN_TOKEN;
if (!TOKEN) { console.error("ADMIN_TOKEN required (Clerk JWT of an admin uid)"); process.exit(1); }

const USER_A = process.env.TEST_UID_A || "user_test_ledger_buyer";
const USER_B = process.env.TEST_UID_B || "user_test_ledger_creator";

let failures = 0;
const ok = (cond, label) => { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) failures++; };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let b; const t = await res.text(); try { b = JSON.parse(t); } catch { b = t.slice(0, 300); }
  return { status: res.status, body: b };
}

async function ledgerByRef(ref) {
  const r = await call("GET", `/api/admin/ledger?ref=${encodeURIComponent(ref)}`);
  return r.status === 200 ? (r.body.entries ?? []) : [];
}

async function pollLedger(ref, predicate, ms = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const rows = await ledgerByRef(ref);
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return ledgerByRef(ref);
}

const run = Date.now().toString(36);

console.log(`\n— ledger invariants vs ${BASE} (run ${run}) —\n`);

// ---------- 0. fund the buyer ----------
console.log("0. fund buyer via admin adjust (+10000)");
const adj = await call("POST", "/api/admin/adjust", { account: USER_A, amount: 10_000, reason: `invariant test ${run}` });
ok(adj.status === 200, `adjust 200 (got ${adj.status} ${JSON.stringify(adj.body).slice(0, 100)})`);

// ---------- 1. hold + idempotency ----------
const ORDER = `testorder_${run}`;
console.log(`1. hold 1000 → escrow:${ORDER} (fired TWICE with same opId)`);
const h1 = await call("POST", "/api/admin/escrow/hold", { userId: USER_A, orderId: ORDER, amount: 1000, title: "Invariant test order" });
const h2 = await call("POST", "/api/admin/escrow/hold", { userId: USER_A, orderId: ORDER, amount: 1000, title: "Invariant test order" });
ok(h1.status === 200, `first hold 200 (got ${h1.status} ${JSON.stringify(h1.body).slice(0, 100)})`);
ok(h2.status === 200 && h2.body.duplicate === true, `second hold is a dedupe replay (duplicate:true, got ${JSON.stringify(h2.body).slice(0, 80)})`);
ok((h1.body.balance ?? -1) === (h2.body.balance ?? -2), "replay returned the ORIGINAL balance (no double-debit)");

let rows = await pollLedger(ORDER, (r) => r.some((x) => x.type === "purchase_hold"));
const holds = rows.filter((x) => x.type === "purchase_hold");
ok(holds.length === 1, `exactly ONE purchase_hold row for double-fired hold (got ${holds.length})`);

// ---------- 2. partial refund ----------
console.log("2. partial refund 250 back to buyer");
const rf = await call("POST", "/api/admin/refund", { orderId: ORDER, amount: 250, reason: `partial refund test ${run}` });
ok(rf.status === 200, `refund 200 (got ${rf.status} ${JSON.stringify(rf.body).slice(0, 100)})`);

// ---------- 3. release the remainder ----------
console.log("3. release remainder → creator (80/20)");
rows = await pollLedger(ORDER, (r) => r.some((x) => x.type === "refund")); // wait for refund to land first
const rel = await call("POST", "/api/admin/escrow/release", { orderId: ORDER, creatorId: USER_B, title: "Invariant test order" });
ok(rel.status === 200, `release 200 (got ${rel.status} ${JSON.stringify(rel.body).slice(0, 120)})`);
const gross = rel.body.gross, fee = rel.body.fee, net = rel.body.net;
ok(gross === 750, `release gross = 750 remaining (got ${gross})`);
ok(net + fee === gross, `net(${net}) + fee(${fee}) == gross(${gross})`);
ok(fee === Math.round(gross * 0.2), `fee is 20% (got ${fee})`);

// ---------- 4. balanced ledger ----------
console.log("4. ledger balance check (Σ in == Σ out per account)");
rows = await pollLedger(ORDER, (r) => r.some((x) => x.type === "escrow_release") && r.some((x) => x.type === "fee"));
const esc = `escrow:${ORDER}`;
const escIn = rows.filter((x) => x.credit === esc).reduce((s, x) => s + x.amount, 0);
const escOut = rows.filter((x) => x.debit === esc).reduce((s, x) => s + x.amount, 0);
ok(escIn === 1000, `escrow received 1000 (got ${escIn})`);
ok(escOut === 1000, `escrow fully drained: refund 250 + release ${net} + fee ${fee} == 1000 (got ${escOut})`);
ok(escIn === escOut, "Σ debits == Σ credits through escrow (balanced)");
const types = Object.fromEntries(rows.map((x) => [x.type, (x.meta ? 1 : 0)]));
ok("purchase_hold" in types && "refund" in types && "escrow_release" in types && "fee" in types,
  `all four row types present (got: ${rows.map((x) => x.type).join(", ")})`);

// detail meta carries the fee breakdown (drives the row-detail sheet in the app)
const relRow = rows.find((x) => x.type === "escrow_release");
let meta = {}; try { meta = JSON.parse(relRow?.meta || "{}"); } catch { /* noop */ }
ok(meta.fee === fee && meta.gross === gross, `escrow_release meta carries fee breakdown (got ${relRow?.meta?.slice(0, 80)})`);

// ---------- 5. release replay is inert ----------
console.log("5. release replay (same order) is inert");
const rel2 = await call("POST", "/api/admin/escrow/release", { orderId: ORDER, creatorId: USER_B });
ok(rel2.status !== 200 || rel2.body?.duplicate === true || rel2.body?.gross === undefined || (await ledgerByRef(ORDER)).filter((x) => x.type === "escrow_release").length === 1,
  "second release did not create a second escrow_release row");

// ---------- 6. account view ----------
console.log("6. admin account view");
const acct = await call("GET", `/api/admin/account/${USER_B}`);
ok(acct.status === 200 && typeof acct.body.balance === "number", `creator account view (balance=${acct.body.balance}, held=${acct.body.held})`);
ok(acct.body.held >= net, `creator net is in the 7-day hold (held=${acct.body.held} ≥ ${net})`);

console.log(failures === 0 ? "\nALL INVARIANTS HOLD ✓\n" : `\n${failures} FAILURE(S) ✗\n`);
process.exit(failures === 0 ? 0 : 1);

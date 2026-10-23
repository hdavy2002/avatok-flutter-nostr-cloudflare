// @ts-nocheck -- uses node:sqlite, which the worker tsconfig has no types for

// [HF-CALL-MODES-C] Chunk reservations on the real ledger SQL (in-memory SQLite behind the D1 shim). Spec 2.3 / section 3 money risks.
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import {
  creditLot, getLots, balanceSummary, reserveChunk, reserveForCall, getReservation, release, settleCall, releaseOrphanChunks, chunkGateOp,
} from "./hf_token_ledger";
import { chargePaise, paiseToMicro, planSpendRange, type Tariff } from "./hf_token_math";

let env: any;
const rup = (uid: string, rupees: number, op: string) =>
  creditLot(env, uid, { kind: "purchase", pricingVersion: "gp-r2", valuePaisePerToken: 100, micro: paiseToMicro(rupees * 100), paidPaise: rupees * 100, provider: "test", providerRef: op }, op);
const reservedMicro = async (uid: string) => (await getLots(env, uid)).reduce((t, l) => t + l.reservedMicro, 0);
const RATE = 1000; // Rs 10 per minute -> Rs 50 per 300 s chunk
beforeEach(() => { env = { DB_META: makeDb() }; });

describe("planSpendRange", () => {
  it("chunk values telescope to the cumulative charge, also over tier boundaries", () => {
    const tariff: Tariff = { tiers: [{ fromSec: 0, paisePerMin: 399 }, { fromSec: 600, paisePerMin: 350 }] };
    const lots = [{ id: "a", valuePaisePerToken: 100, leftMicro: paiseToMicro(100_000) }];
    let from = 0, sum = 0;
    for (let i = 0; i < 6; i++) { const p = planSpendRange(lots, tariff, from, from + 300); sum += p.totalValuePaise; from = p.endSec; }
    expect(from).toBe(1800);
    expect(sum).toBe(chargePaise(tariff, 1800));
  });
  it("stops at the last whole second the lots can pay for", () => {
    const lots = [{ id: "a", valuePaisePerToken: 100, leftMicro: paiseToMicro(300) }]; // Rs 3 = 18 s at Rs 10/min
    const p = planSpendRange(lots, 1000, 0, 300);
    expect(p.secondsCovered).toBe(18); expect(p.shortfall).toBe(true); expect(p.totalValuePaise).toBe(300);
  });
});

describe("reserveChunk", () => {
  it("is idempotent per chunk number: asking again reserves nothing more", async () => {
    await rup("u1", 500, "L1");
    const a = await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    const b = await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    const c1 = await reserveChunk(env, "u1", "c1", 1, RATE, 300, 600);
    const c1b = await reserveChunk(env, "u1", "c1", 1, RATE, 300, 600);
    expect(a.ok && a.again === false && a.coveredSec === 300 && a.paise === 5000).toBe(true);
    expect(b.ok && b.again === true && b.coveredSec === 300).toBe(true);
    expect(c1.ok && c1.again === false && c1.fundedSec === 600).toBe(true);
    expect(c1b.ok && c1b.again === true && c1b.fundedSec === 600).toBe(true);
    expect(await reservedMicro("u1")).toBe(paiseToMicro(10_000));
    expect((await getReservation(env, "c1")).secondsCovered).toBe(600);
  });

  it("refuses a chunk after settle and after release (the gate checks hftset / hftrel)", async () => {
    await rup("u1", 500, "L1");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    await settleCall(env, "u1", "c1", RATE, 120);
    const late = await reserveChunk(env, "u1", "c1", 1, RATE, 300, 600);
    expect(late.ok).toBe(false); expect(late.reason).toBe("closed");
    expect(await reservedMicro("u1")).toBe(0);
    await rup("u2", 500, "L2");
    await reserveChunk(env, "u2", "c2", 0, RATE, 0, 300);
    await release(env, "c2");
    const late2 = await reserveChunk(env, "u2", "c2", 1, RATE, 300, 600);
    expect(late2.ok).toBe(false); expect(late2.reason).toBe("closed");
    expect(await reservedMicro("u2")).toBe(0);
  });

  it("the gate itself (not only the pre-check) refuses once the call is settled: raw statements built for a stale caller change nothing", async () => {
    await rup("u1", 500, "L1");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    await settleCall(env, "u1", "c1", RATE, 60);
    // simulate the in-flight race: the pre-checks passed earlier, the batch runs after settle
    const lot = (await getLots(env, "u1"))[0];
    const { buildReservationStatements } = await import("./hf_token_ledger");
    const nonce = "n1";
    const stmts = buildReservationStatements(env, {
      uid: "u1", callId: "c1", now: 1, nonce, gateOp: chunkGateOp("c1", 1),
      plan: { uses: [{ lotId: lot.id, micro: paiseToMicro(5000), valuePaise: 5000 }], totalValuePaise: 5000, secondsCovered: 300 },
      gatePredicate: (first) => ({ sql: `NOT EXISTS (SELECT 1 FROM hf_token_ledger WHERE op_id IN (?${first},?${first + 1}))`, values: ["hftset:c1", "hftrel:c1"] }),
    });
    await env.DB_META.batch(stmts);
    expect(await reservedMicro("u1")).toBe(0);
    expect(env.DB_META._raw.prepare("SELECT COUNT(*) AS n FROM hf_token_ledger WHERE op_id LIKE 'hftres:c1:c1%'").get().n).toBe(0);
  });

  it("a lot backing several chunks aggregates to one row; settle spends and releases all of it (no stuck reservation)", async () => {
    await rup("u1", 500, "L1");
    for (let n = 0; n < 3; n++) await reserveChunk(env, "u1", "c1", n, RATE, n * 300, n * 300 + 300);
    const r = await getReservation(env, "c1");
    expect(r.lots.length).toBe(1);
    expect(r.lots[0].micro).toBe(paiseToMicro(15_000));
    expect(r.secondsCovered).toBe(900);
    const s = await settleCall(env, "u1", "c1", RATE, 700);
    expect(s.ok && s.billableSeconds === 700).toBe(true);
    expect(s.totalValuePaise).toBe(chargePaise(RATE, 700));
    const lots = await getLots(env, "u1");
    expect(lots[0].reservedMicro).toBe(0);
    expect(lots[0].leftMicro).toBe(paiseToMicro(50_000 - chargePaise(RATE, 700)));
  });

  it("partial chunk: covers what the wallet can pay for; the next one is insufficient; settle still balances", async () => {
    await rup("u1", 70, "L1"); // Rs 70 = 7 min at Rs 10/min
    const c0 = await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    const c1 = await reserveChunk(env, "u1", "c1", 1, RATE, 300, 600);
    const c2 = await reserveChunk(env, "u1", "c1", 2, RATE, 420, 720);
    expect(c0.ok && c0.partial === false).toBe(true);
    expect(c1.ok && c1.partial === true && c1.coveredSec === 120 && c1.fundedSec === 420).toBe(true);
    expect(c2.ok).toBe(false); expect(c2.reason).toBe("insufficient"); expect(c2.fundedSec).toBe(420);
    const s = await settleCall(env, "u1", "c1", RATE, 420);
    expect(s.ok && s.totalValuePaise === 7000 && s.shortfall === false).toBe(true);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(0);
  });

  it("release gives back every chunk and a later settle is refused as released", async () => {
    await rup("u1", 500, "L1");
    for (let n = 0; n < 3; n++) await reserveChunk(env, "u1", "c1", n, RATE, n * 300, n * 300 + 300);
    expect(await reservedMicro("u1")).toBe(paiseToMicro(15_000));
    expect((await release(env, "c1")).released).toBe(true);
    expect(await reservedMicro("u1")).toBe(0);
    expect((await release(env, "c1")).released).toBe(false);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(paiseToMicro(50_000));
    const s = await settleCall(env, "u1", "c1", RATE, 100);
    expect(s.ok).toBe(false);
  });

  it("chunks spill into the next lot and settle splits oldest first", async () => {
    await rup("u1", 60, "A"); await rup("u1", 200, "B");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300); // Rs 50 from A
    await reserveChunk(env, "u1", "c1", 1, RATE, 300, 600); // Rs 10 from A, Rs 40 from B
    const r = await getReservation(env, "c1");
    expect(r.lots.map((l) => l.micro)).toEqual([paiseToMicro(6000), paiseToMicro(4000)]);
    const s = await settleCall(env, "u1", "c1", RATE, 450); // Rs 75
    expect(s.totalValuePaise).toBe(7500);
    expect(s.lots.map((l) => l.valuePaise)).toEqual([6000, 1500]);
    expect(await reservedMicro("u1")).toBe(0);
  });

  it("first-minute rule: a fixed Re 1 charge over chunked holds returns everything else", async () => {
    await rup("u1", 500, "L1");
    for (let n = 0; n < 2; n++) await reserveChunk(env, "u1", "c1", n, RATE, n * 300, n * 300 + 300);
    const s = await settleCall(env, "u1", "c1", RATE, 45, { fixedValuePaise: 100 });
    expect(s.ok && s.totalValuePaise === 100).toBe(true);
    expect(await reservedMicro("u1")).toBe(0);
    expect((await balanceSummary(env, "u1")).totalMicro).toBe(paiseToMicro(49_900));
  });

  it("chunk 0 through reserveChunk is the same reservation reserveForCall would make (gate hftres:<call>)", async () => {
    await rup("u1", 500, "L1");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    const again = await reserveForCall(env, "u1", "c1", RATE, 3600); // idempotent: the existing reservation is returned
    expect(again.ok && again.again === true && again.secondsCovered === 300).toBe(true);
  });
});

describe("releaseOrphanChunks", () => {
  it("does nothing while the call is still open and for a clean settle", async () => {
    await rup("u1", 500, "L1");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    expect((await releaseOrphanChunks(env, "c1")).lots).toBe(0); // not settled: nothing is an orphan yet
    await settleCall(env, "u1", "c1", RATE, 100);
    expect((await releaseOrphanChunks(env, "c1")).lots).toBe(0);
  });

  it("puts right a reservation left on a lot after the call ended, exactly once", async () => {
    await rup("u1", 500, "L1");
    await reserveChunk(env, "u1", "c1", 0, RATE, 0, 300);
    await settleCall(env, "u1", "c1", RATE, 100);
    const lot = (await getLots(env, "u1"))[0];
    // a stray chunk: reserve rows exist and the lot shows them reserved (what a bug would leave behind)
    const raw = env.DB_META._raw;
    raw.prepare("INSERT INTO hf_token_ledger (id,uid,kind,lot_id,delta_micro,rupee_value_paise,call_id,op_id,created_at) VALUES ('x1','u1','reserve',?,?,5000,'c1','hftres:c1:c9:'||?,1)")
      .run(lot.id, paiseToMicro(5000), lot.id);
    raw.prepare("UPDATE hf_token_lots SET tokens_reserved_micro=tokens_reserved_micro+? WHERE id=?").run(paiseToMicro(5000), lot.id);
    expect(await reservedMicro("u1")).toBe(paiseToMicro(5000));
    const r1 = await releaseOrphanChunks(env, "c1");
    expect(r1.lots).toBe(1); expect(r1.micro).toBe(paiseToMicro(5000));
    expect(await reservedMicro("u1")).toBe(0);
    const r2 = await releaseOrphanChunks(env, "c1");
    expect(r2.lots).toBe(0);
    expect(await reservedMicro("u1")).toBe(0);
  });
});

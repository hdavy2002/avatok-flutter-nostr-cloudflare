// @ts-nocheck -- uses node:sqlite via the shim
// [HF-PRESENCE-NUDGE-1] 3-hourly "you're offline" reminder for a live host (rulebook HF-HOST-NUDGE-1).
import { describe, it, expect, beforeEach, vi } from "vitest";

const sent = vi.hoisted(() => ({
  wa: [] as any[], push: [] as string[], events: [] as any[], waResult: { ok: true } as any, phone: "+919876543210" as string | null,
  flag: true, closing: false, pushResult: true,
}));
vi.mock("./whatsapp_send", () => ({ sendWhatsAppText: async (_e: any, to: string, text: string) => { sent.wa.push({ to, text }); return sent.waResult; } }));
vi.mock("./whatsapp_notify", () => ({ verifiedWhatsAppNumber: async () => sent.phone }));
vi.mock("./hf_push", () => ({ pushPresenceNudge: async (_e: any, _c: any, uid: string) => { sent.push.push(uid); return sent.pushResult; } }));
vi.mock("./hf_exit", () => ({ isClosing: async () => sent.closing }));
vi.mock("../routes/config", () => ({ readConfig: async () => ({ hfPresenceNudgeEnabled: sent.flag }) }));
vi.mock("../hooks", () => ({ track: async (_e: any, uid: string, event: string, _a: any, props: any) => { sent.events.push({ uid, event, ...props }); }, trackException: async () => {} }));

import { makeDb } from "./hf_token_d1_shim";
import { runHfPresenceNudge, inNudgeWindow, presenceNudgeText } from "./hf_presence_nudge";

const H = 3600_000;
// 2026-10-11 10:00 IST = 04:30 UTC
const T0 = Date.UTC(2026, 9, 11, 4, 30);
let env: any;
const run = (now = T0) => runHfPresenceNudge(env, now, { gapMs: 0 });
const host = (uid: string, o: Record<string, unknown> = {}) => {
  const r = { status: "live", presence: "offline", nudge_paused: 0, nudge_last_at: null, display_name: "Priya", ...o };
  env.DB_META._raw.prepare("INSERT INTO hf_hosts (uid, slug, status, display_name, presence, nudge_paused, nudge_last_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,1,1)")
    .run(uid, "s-" + uid, r.status, r.display_name, r.presence, r.nudge_paused, r.nudge_last_at);
};
const last = (uid: string) => env.DB_META._raw.prepare("SELECT nudge_last_at AS n FROM hf_hosts WHERE uid=?").get(uid).n;

beforeEach(() => {
  env = { DB_META: makeDb(["2026-10-09-hf-hosts.sql", "2026-10-09-hf-presence.sql", "2026-10-11-hf-presence-nudge.sql"], { alters: true }) };
  sent.wa.length = 0; sent.push.length = 0; sent.events.length = 0;
  sent.waResult = { ok: true }; sent.phone = "+919876543210"; sent.flag = true; sent.closing = false; sent.pushResult = true;
});

describe("window and copy", () => {
  it("08:00 to 23:00 IST only", () => {
    expect(inNudgeWindow(Date.UTC(2026, 9, 11, 2, 29))).toBe(false); // 07:59 IST
    expect(inNudgeWindow(Date.UTC(2026, 9, 11, 2, 30))).toBe(true);  // 08:00 IST
    expect(inNudgeWindow(Date.UTC(2026, 9, 11, 17, 29))).toBe(true); // 22:59 IST
    expect(inNudgeWindow(Date.UTC(2026, 9, 11, 17, 30))).toBe(false); // 23:00 IST
    expect(inNudgeWindow(Date.UTC(2026, 9, 11, 20, 0))).toBe(false); // 01:30 IST
  });
  it("text names the host and the brand and says how to switch on", () => {
    const t = presenceNudgeText("Priya");
    expect(t).toContain("Hi Priya");
    expect(t).toContain("Hello Fraands");
    expect(t).toContain("Host tab");
    expect(t).toContain("Reply STOP");
    expect(presenceNudgeText("  ")).toContain("Hi there");
  });
});

describe("runHfPresenceNudge", () => {
  it("sends once to an offline live host, then not again within 3 hours", async () => {
    host("u1");
    const r1 = await run();
    expect(r1).toMatchObject({ scanned: 1, ok: 1 });
    expect(sent.wa).toHaveLength(1);
    expect(sent.wa[0].to).toBe("+919876543210");
    expect(sent.wa[0].text).toContain("Hi Priya");
    expect(sent.push).toEqual(["u1"]);
    expect(last("u1")).toBe(T0);
    expect(sent.events.find((e) => e.event === "hf_presence_nudge_sent")).toMatchObject({ uid: "u1", outcome: "ok", reason: "whatsapp_push" });
    await run(T0 + 2 * H + 59 * 60_000);
    expect(sent.wa).toHaveLength(1);
    await run(T0 + 3 * H + 1);
    expect(sent.wa).toHaveLength(2);
  });
  it("does nothing outside 08:00-23:00 IST", async () => {
    host("u1");
    const r = await run(Date.UTC(2026, 9, 11, 19, 0)); // 00:30 IST
    expect(r.reason).toBe("outside_hours");
    expect(sent.wa).toHaveLength(0);
    expect(last("u1")).toBeNull();
  });
  it("does nothing when the flag is off", async () => {
    host("u1"); sent.flag = false;
    expect((await run()).reason).toBe("flag_off");
    expect(sent.wa).toHaveLength(0);
  });
  it("skips a host who paused the reminders", async () => {
    host("u1", { nudge_paused: 1 });
    await run();
    expect(sent.wa).toHaveLength(0);
  });
  it("skips hosts who are not live or not offline", async () => {
    host("draft", { status: "draft" }); host("paused", { status: "paused" }); host("pending", { status: "pending_review" });
    host("on", { presence: "online" }); host("busy", { presence: "busy" });
    const r = await run();
    expect(r.scanned).toBe(0);
    expect(sent.wa).toHaveLength(0);
  });
  it("no verified WhatsApp: still pushes, keeps the 3 hour slot, reports ok via push", async () => {
    host("u1"); sent.phone = null;
    const r = await run();
    expect(r.ok).toBe(1);
    expect(sent.wa).toHaveLength(0);
    expect(sent.events[0]).toMatchObject({ outcome: "ok", reason: "push" });
    expect(last("u1")).toBe(T0);
  });
  it("no number and no push device: skipped, slot kept", async () => {
    host("u1"); sent.phone = null; sent.pushResult = false;
    const r = await run();
    expect(r.skipped).toBe(1);
    expect(sent.events[0]).toMatchObject({ outcome: "skipped", reason: "no_verified_whatsapp" });
    expect(last("u1")).toBe(T0);
  });
  it("a provider error gives the slot back so the next tick retries, and stops after 3", async () => {
    for (const u of ["a", "b", "c", "d"]) host(u);
    sent.waResult = { ok: false, reason: "provider_error", detail: "500" };
    const r = await run();
    expect(r.failed).toBe(3);
    expect(sent.wa).toHaveLength(3);
    expect(last("a")).toBeNull();
    expect(sent.push).toHaveLength(0);
    expect(sent.events[0]).toMatchObject({ outcome: "failed", reason: "provider_error" });
  });
  it("a rate limit stops the run at once", async () => {
    host("a"); host("b");
    sent.waResult = { ok: false, reason: "rate_limited", detail: "429" };
    await run();
    expect(sent.wa).toHaveLength(1);
  });
  it("not on WhatsApp is skipped and the slot is kept", async () => {
    host("u1"); sent.waResult = { ok: false, reason: "not_on_whatsapp", detail: "x" }; sent.pushResult = false;
    const r = await run();
    expect(r.skipped).toBe(1);
    expect(last("u1")).toBe(T0);
  });
  it("a host whose account is closing gets nothing", async () => {
    host("u1"); sent.closing = true;
    await run();
    expect(sent.wa).toHaveLength(0);
    expect(sent.push).toHaveLength(0);
  });
  it("caps one run at 200 hosts", async () => {
    for (let i = 0; i < 205; i++) host("h" + i);
    const r = await run();
    expect(r.scanned).toBe(200);
  });
});

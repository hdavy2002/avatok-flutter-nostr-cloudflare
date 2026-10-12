// [HF-REF-FINAL-1] A delayed teardown must never release a newer call's busy state.
import { beforeEach, describe, expect, it } from "vitest";
import { makeDb } from "./hf_token_d1_shim";
import { claimHost, releaseHost } from "./hf_calls_store";

let env: any;

beforeEach(() => {
  env = {
    DB_META: makeDb([
      "2026-10-09-hf-hosts.sql",
      "2026-10-09-hf-presence.sql",
      "2026-10-09-hf-calls.sql",
      "2026-10-12-hf-call-presence-owner.sql",
    ], { alters: true }),
  };
  const now = Date.now();
  env.DB_META._raw.prepare(
    "INSERT INTO hf_hosts(uid,slug,display_name,status,presence,presence_at,created_at,updated_at) VALUES ('host','host-aaaa','Host','live','online',?,?,?)",
  ).run(now, now, now);
});

describe("call-owned host presence", () => {
  it("only the owning call can release a busy host", async () => {
    expect(await claimHost(env, "host", "call-old")).toBe(true);
    await releaseHost(env, "host", "call-new");
    expect(env.DB_META._raw.prepare("SELECT presence,presence_call_id FROM hf_hosts WHERE uid='host'").get())
      .toMatchObject({ presence: "busy", presence_call_id: "call-old" });

    await releaseHost(env, "host", "call-old");
    expect(env.DB_META._raw.prepare("SELECT presence,presence_call_id FROM hf_hosts WHERE uid='host'").get())
      .toMatchObject({ presence: "online", presence_call_id: null });
  });
});

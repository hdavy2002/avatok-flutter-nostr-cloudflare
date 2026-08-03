import { describe, expect, it } from "vitest";
import {
  callerContactPolicy,
  shouldRouteUnknownAvatokCaller,
} from "../src/lib/call_contact_directory";

function envWith(rows: {
  synced?: boolean;
  direct?: boolean;
  callerHash?: string | null;
  phone?: boolean;
  fail?: boolean;
}) {
  return {
    DB_META: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                if (rows.fail) throw new Error("D1 unavailable");
                if (sql.includes("call_contact_directory_sync")) return rows.synced ? { x: 1 } : null;
                if (sql.includes("contact_uid=?2")) return rows.direct ? { x: 1 } : null;
                if (sql.includes("SELECT phone_hash FROM users")) {
                  return rows.callerHash ? { phone_hash: rows.callerHash } : null;
                }
                if (sql.includes("phone_hash=?2")) return rows.phone ? { x: 1 } : null;
                throw new Error(`unexpected query: ${sql}`);
              },
            };
          },
        };
      },
    },
  } as never;
}

describe("server unknown-caller policy", () => {
  it("fails open until the device directory has synced", async () => {
    const result = await callerContactPolicy(envWith({}), "owner", "caller");
    expect(result).toEqual({
      known: false, saved: false, reason: "device_directory_not_synced",
    });
  });

  it("recognises a saved AvaTOK uid", async () => {
    const result = await callerContactPolicy(
      envWith({ synced: true, direct: true }), "owner", "caller",
    );
    expect(result).toEqual({ known: true, saved: true, matched_by: "uid" });
  });

  it("recognises a saved device contact by privacy-safe phone hash", async () => {
    const result = await callerContactPolicy(
      envWith({ synced: true, callerHash: "abc", phone: true }), "owner", "caller",
    );
    expect(result).toEqual({ known: true, saved: true, matched_by: "phone" });
  });

  it("routes only an authoritatively unsaved caller", async () => {
    const result = await callerContactPolicy(
      envWith({ synced: true, callerHash: "abc", phone: false }), "owner", "caller",
    );
    expect(result).toEqual({ known: true, saved: false, matched_by: "none" });
  });

  it("does not divert an unsaved authenticated caller without explicit policy", () => {
    expect(shouldRouteUnknownAvatokCaller(
      { known: true, saved: false, matched_by: "none" },
      false,
    )).toBe(false);
  });

  it("diverts an authoritatively unsaved caller only when policy is enabled", () => {
    expect(shouldRouteUnknownAvatokCaller(
      { known: true, saved: false, matched_by: "none" },
      true,
    )).toBe(true);
    expect(shouldRouteUnknownAvatokCaller(
      { known: false, saved: false, reason: "lookup_failed" },
      true,
    )).toBe(false);
  });

  it("fails open on a directory outage", async () => {
    const result = await callerContactPolicy(
      envWith({ fail: true }), "owner", "caller",
    );
    expect(result).toEqual({ known: false, saved: false, reason: "lookup_failed" });
  });
});

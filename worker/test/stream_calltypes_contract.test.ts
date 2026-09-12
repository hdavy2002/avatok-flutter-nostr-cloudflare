// [STREAM-CALLTYPES-1] The call types this route provisions must be exactly the
// ones the commercial lane mints. If `commercialProviderIdentity` ever renames a
// call type and this list is not updated, production goes back to the 2026-09-12
// failure: every /join 502s with "provider call unavailable" and not one row is
// written to commercial_sessions.
import { describe, expect, it } from "vitest";
import {
  AVATOK_CALL_TYPES,
  CALL_TYPE_TEMPLATE,
  settingsFor,
  settingsFallbacks,
} from "../src/routes/admin_stream_calltypes";
import { commercialProviderIdentity } from "../src/lib/commercial_stream_sessions";

describe("[STREAM-CALLTYPES-1] provisioned call types match the minted ones", () => {
  it("covers every call type commercialProviderIdentity can mint", () => {
    const live = commercialProviderIdentity({ kind: "live_event", listingId: "listing-1" });
    const consult = commercialProviderIdentity({
      kind: "consult_1to1", listingId: "listing-1", bookingId: "booking-1",
    });
    expect(AVATOK_CALL_TYPES).toContain(live.callType);
    expect(AVATOK_CALL_TYPES).toContain(consult.callType);
    expect([...AVATOK_CALL_TYPES].sort()).toEqual([live.callType, consult.callType].sort());
  });

  it("clones each one from a built-in Stream call type", () => {
    for (const name of AVATOK_CALL_TYPES) {
      expect(["default", "livestream", "audio_room", "development"]).toContain(CALL_TYPE_TEMPLATE[name]);
    }
  });

  it("gives the livestream type the switches prepare-host and go-live depend on", () => {
    const s = settingsFor("avatok_livestream") as Record<string, any>;
    // commercialLivePrepareHost parks the session in 'backstage'.
    expect(s.backstage.enabled).toBe(true);
    // runControl posts { start_hls: true } on go_live.
    expect(s.broadcasting.enabled).toBe(true);
    expect(s.broadcasting.hls.enabled).toBe(true);
  });

  it("never records or transcribes — both product flags are off in production", () => {
    for (const name of AVATOK_CALL_TYPES) {
      const s = settingsFor(name) as Record<string, any>;
      expect(s.recording.mode).toBe("disabled");
      expect(s.transcription.mode).toBe("disabled");
    }
  });

  it("caps a 1:1 consult at two participants", () => {
    const s = settingsFor("avatok_consult_1to1") as Record<string, any>;
    expect(s.limits.max_participants).toBe(2);
  });

  it("falls back to smaller settings bodies, ending with an empty one", () => {
    for (const name of AVATOK_CALL_TYPES) {
      const shapes = settingsFallbacks(name);
      expect(shapes.length).toBeGreaterThanOrEqual(2);
      expect(shapes[0]).toEqual(settingsFor(name));
      expect(shapes[shapes.length - 1]).toEqual({});
    }
  });
});

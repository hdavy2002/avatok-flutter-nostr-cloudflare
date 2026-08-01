# Native-audio feasibility spike — 2026-08-01

Status: implementation prerequisites added; device-lab gate remains open.

This spike is the Wave 9 decision input for subscribe-early/render-late call
migration. It is deliberately separate from the migration code: a failed native
audio result must stop Waves 10–16 rather than leaving a half-migrated call path.

## What is now implemented

- The conference controller can receive a call-owned capture stream and will not
  stop or dispose that stream when its conference leg leaves.
- Conference audio subscriptions follow the server's loudest-speaker set and
  close stale remote pulls instead of permanently keeping the first six roster
  entries.
- Join-ticket nonces are consumed by `GroupCallRoom`; reconnects obtain a fresh
  ticket through the authenticated rejoin route.
- The 1:1 call session exposes RFC 4733 DTMF insertion through the negotiated
  WebRTC audio sender. Unsupported native/plugin/SFU behavior returns a failed
  feasibility result and emits telemetry; it does not alter call state.

## Required device matrix

Run on representative real devices after the normal CI build flow is available:

| Case | Pass condition | Evidence |
|---|---|---|
| Android mid-tier, earpiece | capture starts without a second permission prompt | audio-route event + ≤1 s stats samples |
| Android low-end, speaker | remote audio can remain subscribed while muted at zero gain | native mixer log + continuity counters |
| iPhone speaker | route changes do not recreate the capture stream | route transitions + track identity |
| Bluetooth headset | connect/disconnect preserves the same call-owned source | route transitions + track identity |
| wired headset | no speaker fallback or duplicate audio | route transitions + one active output |
| Wi-Fi → cellular | packet loss/reconnect does not promote a stale ticket | WS generation + continuity samples |
| DTMF to a WebRTC peer | peer receives each digit once | RFC 4733 receiver log |
| DTMF through the conference/SFU path | behavior is explicitly supported or marked unsupported | SFU/peer receiver result |

## Decision rule

Pass Wave 9 only if shared capture, route control, zero-gain/render timing, and
≤1-second health sampling are all demonstrated on the representative device
matrix. A DTMF pass on a 1:1 WebRTC peer does not imply a conference/SFU pass;
that path needs its own evidence. Until this matrix is green, migration-specific
room work remains gated.


# Conference Waves 10–17 implementation record

The production path is split deliberately:

- `GroupCallRoom` remains the Cloudflare Realtime media authority.
- `ConferenceRoomDO` owns ad-hoc migration identity, reservation, provisional
  membership, commit/abort, participant tenure, capabilities, immutable
  sponsorship, append-only billing segments, and host election.
- Audio conferences are free. Video conferences use the server-owned
  `conferenceVideoTokensPerHour` tariff, currently 20 tokens per started hour;
  `conferenceBillingEnabled` is enabled by default and remains a kill switch.

Protocol guarantees:

1. Only one migration reservation exists per room; stale reservations abort.
2. Preparation requires the current call generation and does not ring or admit a
   new participant.
3. Commit requires explicit `sfu_ready`; otherwise the existing call remains the
   source of truth and the migration can be aborted.
4. Provisional participants cannot join the committed conference until the
   server changes their membership state.
5. The initiator remains the immutable sponsor. Host election does not transfer
   billing liability. A departing sponsor gets a bounded grace period and a new
   sponsor must explicitly authorize a fresh reserve.
6. Billing is append-only by segment and idempotent by conference call/hour;
   unused escrow is refunded on room end. Video is reserved and settled in
   started-hour units; audio never creates an escrow hold.
7. Host election uses longest-preserved participant tenure, including reconnect
   tenure stored by the room, and does not grant billing visibility merely by
   becoming host.

Wave 13 device-lab execution is represented by
`scripts/conference-device-lab.sh`. It captures Android audio routing, Bluetooth,
connectivity, and WebRTC log evidence without building or deploying anything.
The matrix remains a release gate until representative Android/iOS/SFU evidence
is attached; static code changes do not satisfy that gate.

// [AUMFE-CONSULT-FOUNDATION-1] ConsultCallDO — one per booking (idFromName(bookingId)). Signalling relay + presence clock for
// plain-WebRTC 1:1 audio. Lane W3 implements it (Specs/SPEC-2026-10-02-REAL-CONSULTANTS-BUILD.md §Call).
import type { Env } from "../types";

export class ConsultCallDO {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(_req: Request): Promise<Response> {
    return new Response(JSON.stringify({ error: "not_implemented" }), { status: 501, headers: { "content-type": "application/json" } });
  }
}

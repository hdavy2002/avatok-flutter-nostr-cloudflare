// [SAATHUM-PREETI-EGRESS-1 2026-09-30] Send Gemini API (generativelanguage.googleapis.com) calls
// from a US-pinned Durable Object instead of the Worker's own colo.
//
// WHY: the Worker runs in the Cloudflare colo nearest the visitor. Some of those colos egress from
// regions Google does not serve, and the Gemini API then answers 400 FAILED_PRECONDITION
// "User location is not supported for the API use." — intermittently, per colo. Seen live on
// 2026-09-30: Preeti failed ~half her turns with it. do/party.ts already proves the fix for Gemini
// TTS: a PartyDO created with locationHint 'wnam' lives (and egresses) in the US.
//
// The DO route is internal: PartyDO is only reachable from outside through wsParty's fixed
// https://party/ws URL, and /gemini-egress also refuses any host other than the Gemini API.
import type { Env } from "../types";

const SHARDS = 4; // spread concurrent streams over a few US-pinned instances

/** Drop-in for fetch(url, init) when url is on generativelanguage.googleapis.com. */
export function geminiFetch(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const name = `gemini-egress-wnam-${Math.floor(Math.random() * SHARDS)}`;
  const stub = env.PARTY.get(env.PARTY.idFromName(name), { locationHint: "wnam" });
  return stub.fetch(`https://party/gemini-egress?u=${encodeURIComponent(url)}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body ?? null,
    signal: init.signal ?? undefined,
  } as RequestInit);
}

// ava_lane.ts — Ava Copilot Phase A: the ONE shared helper for posting into a
// user's PRIVATE Ava lane (Specs/AVA-COPILOT-FINAL-PLAN §6, decisions D2/D19).
//
// Privacy is structural in the fan-out-per-user architecture: "the other party
// never sees it" = "we never write it to their InboxDO". postAvaPrivate writes
// the Ava row ONLY to the requesting user's own inbox by delegating to the
// existing P3 mechanism `postAvaMessage(..., private:true)` in ava_thread.ts —
// the SAME path ava_guardian.ts (warnPrivately) and ava_image.ts already use.
// We wrap it (never duplicate it) so every copilot capability shares one
// envelope shape and one telemetry event.
//
// Envelope (plan §6): the row lands as kind:"ava" scoped to the owner only
// (the DO's private post), with the structured body extras (moment / guardian /
// sources / reply_to_copy) carried in `meta` alongside `lane:"private"` so the
// client renders the orchid "Ava ✨ — only you can see this" bubble. Old clients
// ignore unknown kinds/meta → no forced upgrade (bible §5).

import type { Env } from "../types";
import { postAvaMessage } from "../routes/ava_thread";
import { track, trackUser } from "../hooks";

// FNV-1a (32-bit) → hex, for telemetry-safe conv hashing (I7: "never send raw
// gid"). Same local-copy idiom as ava_odl.ts/ava_group_policy.ts — see those
// files' headers for why it isn't a shared import.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface AvaPrivatePost {
  /** The user whose private lane receives the row (and ONLY this user). */
  uid: string;
  /** Server conversation id (dm_<lo>__<hi> or g_<uuid>) the lane is attached to. */
  conv: string;
  /** Ava's message text. */
  text: string;
  /** Optional Moment payload (D10) — rendered as a tappable card. */
  moment?: Record<string, unknown>;
  /** Optional Guardian accent { severity, category } (D19 — one lane for all of Ava). */
  guardian?: Record<string, unknown>;
  /** Optional source attributions (doc names, message refs) shown under the bubble. */
  sources?: unknown[];
  /** Copy-on-quote (D5): a frozen copy of the message Ava is talking about. */
  replyToCopy?: { text: string; sender: string };
  /** Optional media reference (e.g. a translated file) — public blossom URL. */
  media_ref?: string;
  /** Producing capability, for telemetry + the client's "why" chip (e.g. doc_summarize). */
  capability?: string;
  /** postAvaMessage source tag; defaults to "copilot". */
  source?: string;
  /** Telemetry identity (best-effort). */
  email?: string | null;
}

/**
 * Post an Ava message into `uid`'s PRIVATE lane for `conv`. Never fans out.
 * Returns { ok } — failures are reported, never thrown (callers decide whether
 * a lane-post failure should fail their request; usually it should not).
 * Emits `ava_private_lane_posted { capability, conv }` on success.
 */
export async function postAvaPrivate(env: Env, args: AvaPrivatePost): Promise<{ ok: boolean; error?: string }> {
  if (!args.uid || !args.conv || !args.text) return { ok: false, error: "uid, conv, text required" };

  // Structured body extras ride in meta; lane:"private" is the client's render
  // switch for the orchid bubble + "only you can see this" copy (plan §6).
  const meta: Record<string, unknown> = { lane: "private" };
  if (args.moment) meta.moment = args.moment;
  if (args.guardian) meta.guardian = args.guardian;
  if (args.sources && args.sources.length) meta.sources = args.sources;
  if (args.replyToCopy) meta.reply_to_copy = { text: String(args.replyToCopy.text ?? "").slice(0, 500), sender: String(args.replyToCopy.sender ?? "") };
  if (args.capability) meta.capability = args.capability;

  const res = await postAvaMessage(env, {
    ownerUid: args.uid,
    conv: args.conv,
    text: args.text,
    private: true,                    // structural privacy: row written to uid's InboxDO ONLY
    source: args.source ?? "copilot",
    media_ref: args.media_ref,
    meta,
  });

  // Telemetry (best-effort, never blocks): one event per private-lane post so
  // "how often does Ava speak privately, from which capability" is queryable.
  try {
    const props = { capability: args.capability ?? args.source ?? "copilot", conv: args.conv, ok: res.ok };
    if (args.email) void trackUser(env, args.uid, args.email, "ava_private_lane_posted", "ava_core", props);
    else void track(env, args.uid, "ava_private_lane_posted", "ava_core", props);
  } catch { /* best-effort */ }

  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// [AVA-GROUP-COMPANION-1] postAvaGroup — the PUBLIC group-post primitive (I2:
// "Public group output must use a group-scoped message envelope with gid,
// source=ava, lane=group, decision_id, and a visible Ava sender identity. It
// must never impersonate a human group member.").
//
// CHOSEN FAN-OUT MECHANISM: this reuses the EXISTING production fan-out —
// postAvaMessage(..., private:false) → AvaAgentDO.postAva() (worker/src/do/
// ava_agent.ts, NOT in this issue's file set, so it is called, never edited).
// postAva() already does exactly what I2/I7 require for a group post:
//   • re-reads CURRENT membership from D1 (`this.members(conv, uid)`) at post
//     time — never a stale/cached member list;
//   • fans out via each member's InboxDO append (the same primitive the
//     normal group message path uses);
//   • stamps the envelope `sender:"ava", kind:"ava"` — a distinct identity
//     the client already renders specially (never a member's uid/kind).
// An alternative was hand-rolling a second InboxDO fan-out loop directly in
// this file (or exporting messaging.ts's private `appendTo`/`members`
// helpers, which this issue's file set does not permit touching). That would
// duplicate — and risk drifting from — the ALREADY-TESTED group fan-out
// AvaAgentDO owns. Reusing it is strictly less code and less risk.
//
// `ownerUid` (the AvaAgentDO instance that performs the fan-out) is resolved
// to the group's owner, falling back to any current member — postAva()'s own
// membership re-read means the choice of DO instance does not change WHO
// receives the message, only whose DO namespace momentarily executes it.
// ─────────────────────────────────────────────────────────────────────────────

export interface AvaGroupPost {
  /** Server group conversation id (g_<uuid>). */
  conv: string;
  /** Ava's message text. */
  text: string;
  /** The ODL decision ledger id this post fulfills (ava_odl.ts groupDecisionIdFor). */
  decisionId: string;
  /** Producing capability (ava_capabilities.ts id), for the client's "why" chip + telemetry. */
  capability?: string;
  /** Optional Moment payload — carries provenance:'current_message' (I3/I6). */
  moment?: Record<string, unknown>;
}

async function authorUidFor(env: Env, conv: string): Promise<string | null> {
  try {
    const owner = await env.DB_META.prepare(
      `SELECT uid FROM conversation_members WHERE conv_id=?1 AND role='owner' LIMIT 1`,
    ).bind(conv).first<{ uid: string }>();
    if (owner?.uid) return owner.uid;
    const any = await env.DB_META.prepare(
      `SELECT uid FROM conversation_members WHERE conv_id=?1 LIMIT 1`,
    ).bind(conv).first<{ uid: string }>();
    return any?.uid ?? null;
  } catch {
    return null;
  }
}

/**
 * Post a group-visible Ava message into every CURRENT member's InboxDO for
 * `conv`. Never impersonates a member (sender:"ava", kind:"ava" — see the
 * header). Returns { ok } — failures are reported, never thrown; the caller
 * (ava_odl.ts) leaves the ledger row 'reserved' on failure so the 24h TTL
 * sweep can reclaim it for a future retry, exactly like the 1:1 private path.
 */
export async function postAvaGroup(env: Env, args: AvaGroupPost): Promise<{ ok: boolean; error?: string }> {
  if (!args.conv || !args.text || !args.decisionId) return { ok: false, error: "conv, text, decision_id required" };

  const ownerUid = await authorUidFor(env, args.conv);
  if (!ownerUid) return { ok: false, error: "no_members" };

  const meta: Record<string, unknown> = { lane: "group", decision_id: args.decisionId };
  if (args.capability) meta.capability = args.capability;
  if (args.moment) meta.moment = args.moment;

  const res = await postAvaMessage(env, {
    ownerUid,
    conv: args.conv,
    text: args.text,
    private: false, // → AvaAgentDO.postAva() fans out to every CURRENT member, kind:"ava"
    source: "group_companion",
    meta,
  });

  // Lane-level telemetry (mirrors postAvaPrivate's "ava_private_lane_posted"
  // below) — a distinct event from the domain-level "group_ava_posted" (I7)
  // that ava_odl.ts emits itself AFTER it confirms the ledger row flipped to
  // 'posted', exactly mirroring how "ava_moment_posted" is emitted from
  // odlProcess rather than from postAvaPrivate for the 1:1 path.
  try {
    const props = {
      capability: args.capability ?? "group_companion",
      conv_hash: fnv1aHex(args.conv), // I7 — never send raw gid
      decision_id: args.decisionId,
      ok: res.ok,
    };
    void track(env, ownerUid, "ava_group_lane_posted", "ava_core", props);
  } catch { /* best-effort */ }

  return res;
}

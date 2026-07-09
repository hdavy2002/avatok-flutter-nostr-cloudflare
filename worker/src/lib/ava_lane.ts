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

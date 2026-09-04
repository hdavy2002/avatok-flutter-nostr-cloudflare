// [MKT-STATUS-GATE-1] The one place a listing's status STATE MACHINE is decided.
//
// WHY THIS FILE EXISTS
// ---------------------
// `setListingStatus` (routes/listings.ts:1658-1688) is the "owner glue" endpoint a
// creator's client calls to flip a listing to live/completed/cancelled/draft. As of
// this writing it validates the TARGET (`["live","completed","cancelled","draft"]`)
// and rejects only ONE source status — `draft` — via `if (l.status === "draft") return
// 409` at listings.ts:1678. It does not check the source status for any other target.
// That means, from the client's point of view, every one of these is currently legal:
//
//     pending_review -> live      (skips admin review entirely)
//     rejected       -> live      (a rejected listing goes live anyway)
//     approved       -> live      (skips the publish gate + entitlement charge at
//                                  publishListing(), listings.ts:1459-1655)
//     completed      -> live      ("un-completing" a finished session)
//     cancelled      -> live      ("un-cancelling" — resurrects a dead listing)
//     rejected       -> draft     (see below)
//
// `status='live'` is not cosmetic. `commercial_checkout.ts:366` and
// `commercial_stream_sessions.ts:553` both gate purchase/join on `status === 'live'`,
// so any of the paths above puts a SELLABLE, JOINABLE listing on the marketplace
// having skipped `publishListing()`'s KYC gate, category/photo checks, section gate,
// and — for marketplace kinds — the entitlement charge. This is the exact hole this
// module closes: it is impossible to express "creator sets live" as an allowed
// transition, because `live` never appears as a target with actor `"creator"` in
// `TRANSITIONS`, only with actor `"system"` under the `"provider_confirmed"` check.
//
// `rejected -> draft` is separately narrowed here from what a naive "creators can
// always go back to draft" rule would allow. It IS kept as a legal transition (a
// creator revising a rejected listing has to land somewhere editable), but it is
// documented — and MUST be enforced by the caller, not this module — as a REVISION:
// re-entering `draft` from `rejected` has to clear any stale `approved`/poster-approved
// state and force the listing through `pending_review` again on the next submit.
// Without that, a creator could get one field rejected, bounce to draft, "fix" nothing
// load-bearing, and resubmit while some cached approval flag still reads true. This
// module only says the STATUS transition is allowed; it carries no opinion on `attrs`
// and does no I/O, so it cannot enforce the attrs-clearing itself.
//
// `live` is PROVIDER-CONFIRMED, NEVER CREATOR-SETTABLE. Say it here so nobody
// "simplifies" this table later and re-opens the hole: a creator's requested status is
// a REQUEST, not a fact about whether a GetStream (or any other provider) session is
// actually running. Only `actor: "system"` — the backend, after the provider confirms
// the session started — may move a listing to `live`, and only from `published`, and
// only through the `"provider_confirmed"` check. If a future caller wants to let a
// creator "start" their own session, the correct shape is: creator action triggers a
// provider call, the provider's callback/poll result is what flips the DB row, and that
// write goes through THIS table's `system` + `provider_confirmed` rule — never a new
// `creator` rule that lands on `to: "live"`.
//
// WHAT THIS FILE DOES NOT DO
// ---------------------------
// Pure data + two pure functions. No D1, no `env`, no fetch, no Cloudflare runtime
// import. `checkTransition`/`allowedTargets` are meant to be called from
// `setListingStatus` (and from `adminListingAction`, whose current `next = ...`
// if-chain at admin_listings.ts:201-215 is the same kind of ad hoc logic this table
// replaces) with the extra checks (`publish_gate`, `provider_confirmed`) satisfied by
// the CALLER before or after consulting this table — this module only tells you
// whether the (from, to, actor) triple is shaped like a legal transition, and if it
// requires something more than actor authorization, which check that is.

/** Every status a listing row can be in. */
export type ListingStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "published"
  | "live"
  | "completed"
  | "cancelled";

/** Who is asking for the transition. */
export type Actor = "creator" | "admin" | "system";

/**
 * Extra authorization the CALLER must satisfy before applying a transition this
 * table says is actor-legal:
 *   - "publish_gate"        — approved -> published only after publishListing()'s KYC /
 *                              category / photo / section / entitlement gates all pass.
 *   - "provider_confirmed"  — published -> live and live -> completed only after the
 *                              media provider (GetStream) has actually confirmed the
 *                              session state; never on a bare client request.
 *   - "none"                — actor authorization alone is sufficient.
 */
export type TransitionCheck = "publish_gate" | "provider_confirmed" | "none";

export type TransitionRule = {
  from: ListingStatus;
  to: ListingStatus;
  actors: Actor[];
  /** Extra authorization the CALLER must satisfy before applying this. */
  requires: TransitionCheck;
  /** Short machine-readable reason used in refusals and telemetry. */
  id: string;
};

const ALL_STATUSES: readonly ListingStatus[] = [
  "draft", "pending_review", "approved", "rejected", "published", "live", "completed", "cancelled",
];
const STATUS_SET: ReadonlySet<string> = new Set(ALL_STATUSES);

/** completed and cancelled are TERMINAL for everyone — no transition out of them. */
export const TERMINAL_STATUSES: readonly ListingStatus[] = ["completed", "cancelled"];

// ---------------------------------------------------------------------------
// THE TABLE. Every legal transition is a row here — checkTransition/allowedTargets
// read this data, they never branch on status strings themselves.
// ---------------------------------------------------------------------------
export const TRANSITIONS: readonly TransitionRule[] = [
  // --- creator ---
  { from: "draft", to: "pending_review", actors: ["creator"], requires: "none", id: "creator_submit" },
  // Revision path. Caller MUST clear stale approval / poster-approved state and force
  // a fresh pending_review on next submit — see the file header. This table only says
  // the status move itself is legal.
  { from: "rejected", to: "draft", actors: ["creator"], requires: "none", id: "creator_revise" },
  { from: "approved", to: "published", actors: ["creator"], requires: "publish_gate", id: "creator_publish" },
  { from: "draft", to: "cancelled", actors: ["creator"], requires: "none", id: "creator_cancel_draft" },
  { from: "published", to: "cancelled", actors: ["creator"], requires: "none", id: "creator_cancel_published" },
  { from: "published", to: "completed", actors: ["creator"], requires: "none", id: "creator_complete" },
  // ARCHIVE RESTORE. `cancelled`/`completed` are terminal for every OTHER purpose, but
  // pulling an archived listing back to draft to reuse it is a real, shipped creator
  // feature — the old `setListingStatus` served it from the same `to === "draft"` branch
  // that carried the rejection-laundering hole (listings.ts, pre-fix ~1667-1677, comment
  // "RESTORE from Archived → back to draft"). An earlier draft of this table made both
  // statuses absolutely terminal, which would have 409'd the restore button in
  // production. These two rows are why the terminal check below runs AFTER the table
  // lookup instead of before it: terminal means "no exit except this one", not "no exit".
  { from: "cancelled", to: "draft", actors: ["creator"], requires: "none", id: "creator_restore_cancelled" },
  { from: "completed", to: "draft", actors: ["creator"], requires: "none", id: "creator_restore_completed" },

  // --- admin ---
  { from: "draft", to: "approved", actors: ["admin"], requires: "none", id: "admin_approve_draft" },
  { from: "pending_review", to: "approved", actors: ["admin"], requires: "none", id: "admin_approve_pending" },
  { from: "approved", to: "published", actors: ["admin"], requires: "publish_gate", id: "admin_publish" },
  { from: "published", to: "cancelled", actors: ["admin"], requires: "none", id: "admin_cancel_published" },
  { from: "live", to: "cancelled", actors: ["admin"], requires: "none", id: "admin_cancel_live" },
  // "any non-terminal -> rejected", spelled out one row per source so the table stays
  // pure data (no runtime "is this terminal" branch inside checkTransition).
  { from: "draft", to: "rejected", actors: ["admin"], requires: "none", id: "admin_reject_draft" },
  { from: "pending_review", to: "rejected", actors: ["admin"], requires: "none", id: "admin_reject_pending" },
  { from: "approved", to: "rejected", actors: ["admin"], requires: "none", id: "admin_reject_approved" },
  { from: "published", to: "rejected", actors: ["admin"], requires: "none", id: "admin_reject_published" },
  { from: "live", to: "rejected", actors: ["admin"], requires: "none", id: "admin_reject_live" },

  // --- system (provider-confirmed only) ---
  // THE core fix: `live` is reachable ONLY via this row. No creator/admin row targets
  // "live" anywhere in this table — do not add one.
  { from: "published", to: "live", actors: ["system"], requires: "provider_confirmed", id: "system_go_live" },
  { from: "live", to: "completed", actors: ["system"], requires: "provider_confirmed", id: "system_complete" },

  // --- system: review binding ([LIST-REVIEW-BINDING-1]) ---
  // Every OTHER row in this table models a human decision. These three model a fact:
  // the content changed out from under an approval, so the approval no longer describes
  // what is on the page. `reviewed_content_hash` is recorded when an admin approves, and
  // updateListing re-hashes the material fields on every edit; a mismatch demotes the
  // listing back into the queue. Without these rows the invalidation path had to bypass
  // checkTransition with a literal SQL fragment, which is exactly the "two authorities"
  // shape that made setListingStatus a bypass in the first place — see this file's header.
  //
  // published/live only reach here when the listing has NO sold entitlements. With
  // tickets outstanding, updateListing refuses the edit (409) instead of demoting, because
  // stranding a paying buyer is worse than refusing a title change. That check lives in
  // hasSoldEntitlements(); this table only says the status move itself is legal.
  { from: "approved", to: "pending_review", actors: ["system"], requires: "none", id: "system_review_invalidated_approved" },
  { from: "published", to: "pending_review", actors: ["system"], requires: "none", id: "system_review_invalidated_published" },
  { from: "live", to: "pending_review", actors: ["system"], requires: "none", id: "system_review_invalidated_live" },
];

function isKnownStatus(s: string): s is ListingStatus {
  return STATUS_SET.has(s);
}

/**
 * Returns the matching rule, or a refusal with a stable machine reason.
 * Never throws — an unknown/garbage status string is just another refusal.
 */
export function checkTransition(
  from: string,
  to: string,
  actor: Actor,
): { ok: true; rule: TransitionRule } | { ok: false; reason: string; allowedTargets: ListingStatus[] } {
  if (!isKnownStatus(from) || !isKnownStatus(to)) {
    return { ok: false, reason: "unknown_status", allowedTargets: [] };
  }
  if (from === to) {
    return { ok: false, reason: "noop_transition", allowedTargets: allowedTargets(from, actor) };
  }
  if (to === "live" && actor !== "system") {
    // Named explicitly rather than falling through to the generic refusal below —
    // this is the one wrong answer this whole module exists to prevent, and it should
    // read that way in logs/telemetry, not as an anonymous "transition_not_allowed".
    return { ok: false, reason: "live_is_provider_confirmed", allowedTargets: allowedTargets(from, actor) };
  }
  const rule = TRANSITIONS.find((r) => r.from === from && r.to === to && r.actors.includes(actor));
  if (!rule) {
    // Terminal is reported as its own reason so a refused "un-cancel" reads differently
    // from a refused ordinary move in telemetry. It is checked HERE, after the table, so
    // the archive-restore rows above still resolve — see the comment on those rows.
    if (TERMINAL_STATUSES.includes(from)) {
      return { ok: false, reason: "terminal_status", allowedTargets: allowedTargets(from, actor) };
    }
    return { ok: false, reason: "transition_not_allowed", allowedTargets: allowedTargets(from, actor) };
  }
  return { ok: true, rule };
}

/** Targets this actor may move `from` to. For UI and error messages. */
export function allowedTargets(from: string, actor: Actor): ListingStatus[] {
  if (!isKnownStatus(from)) return [];
  return TRANSITIONS.filter((r) => r.from === from && r.actors.includes(actor)).map((r) => r.to);
}

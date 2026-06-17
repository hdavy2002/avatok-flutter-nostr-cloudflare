// Ava message-kind + visibility-scope CONTRACT (Phase 0 — Foundations).
//
// This is the single source of truth shared by the worker (InboxDO append,
// the agent loop in P3, Guardian in P8, image gen in P9) for the new Ava
// message kinds and how they are scoped/visible. The Flutter client mirrors
// these string constants in app/lib/core/ava_contracts.dart — keep the two in
// sync (string values are the wire contract; do NOT rename casually).
//
// Backward compatibility: the existing kinds ('text', 'media', 'sticker',
// 'loc', 'card', 'poll', 'gcall', …) are untouched. These are ADDITIVE.

/** The three Ava-authored message kinds (master-plan §4). */
export type AvaKind =
  | "ava" // Ava posts into the thread — feminine bubble, visible to all participants.
  | "ava_private" // Ava posts to ONE recipient only (Guardian warning / just-for-me answer).
  | "ava_status"; // Transient "Ava is working…" chip — broadcast only, NEVER persisted.

export const AVA_KINDS: readonly AvaKind[] = ["ava", "ava_private", "ava_status"] as const;

export function isAvaKind(k: string | undefined | null): k is AvaKind {
  return k === "ava" || k === "ava_private" || k === "ava_status";
}

/**
 * Visibility scope on an InboxDO append.
 *  - 'thread'    → normal fan-out to every conversation participant (the default).
 *  - `to:<uid>`  → private: the worker only appends to that uid's InboxDO, and the
 *                  stored row carries audience=<uid> so the client renders/withholds
 *                  correctly. A private warning must NEVER route to the other party —
 *                  enforced server-side (the worker chooses which InboxDO to write).
 */
export type MessageScope = "thread" | `to:${string}`;

export const SCOPE_THREAD = "thread" as const;

/** `to:<uid>` → the target uid, else null (a thread-scoped message). */
export function scopeAudience(scope: MessageScope | undefined): string | null {
  if (!scope || scope === "thread") return null;
  return scope.startsWith("to:") ? scope.slice(3) : null;
}

// ---------------------------------------------------------------------------
// JSON body shapes. The `body` column on a message row is a JSON string; for
// Ava kinds it parses to one of these. Phases that POST a kind build one of
// these; chat_thread.dart renders them generically.
// ---------------------------------------------------------------------------

/** body for kind 'ava' / 'ava_private' — Ava's rendered turn. */
export interface AvaBody {
  /** Markdown/plain text Ava is saying. */
  text: string;
  /** Optional media reference (image gen, fetched file) — same media_ref pipeline. */
  media_ref?: string;
  /** What produced this turn: 'chat' | 'guardian' | 'image' | 'companion' | 'delegate' | 'tool'. */
  source?: string;
  /** For ava_private: who it is for (mirror of the scope target; display only). */
  for_uid?: string;
  /** Free-form metadata for the producing phase (tool name, cost preview, …). */
  meta?: Record<string, unknown>;
}

/** body for the transient 'ava_status' chip ("Ava is working…"). */
export interface AvaStatusBody {
  /** Human label, e.g. "Ava is working…", "Ava is generating an image…". */
  label: string;
  /** Stable id so the client can replace/clear the chip when the turn lands. */
  status_id?: string;
  /** 'start' (show the chip) | 'end' (clear it). Defaults to 'start'. */
  phase?: "start" | "end";
  source?: string;
}

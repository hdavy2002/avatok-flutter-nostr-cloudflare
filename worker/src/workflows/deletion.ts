// [DYNW-FLOWS-1] Account-deletion cascade — DARK PARALLEL Cloudflare Workflow.
// Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §WS-3.
//
// THE LIVE PATH IS STILL consumers/src/deletion.ts (handleDeletion), triggered by
// the `account-deletions` queue (worker/src/routes/account.ts, admin_delete_user.ts)
// and the 6-hourly cron backstop in consumers/src/index.ts. THIS FILE CHANGES
// NOTHING ABOUT THAT PATH. It is a from-scratch, staging-only, flag-gated port of
// the exact same 15-store cascade into a Cloudflare Workflow living in the WORKER
// deployment (avatok-api), so the cascade gets durable per-step retries, a resume
// point on a mid-run crash, and no re-deletion of already-completed stores —
// properties the queue+cron path does not have (a killed consumer re-runs the
// WHOLE handler from the top on next delivery, relying on every store already
// being idempotent-by-accident rather than by workflow-level design).
//
// Enabled ONLY behind `deletionWorkflowEnabled` (routes/config.ts, DEFAULTS false).
// When on, worker/src/routes/account.ts calls env.WF_DELETION.create() INSTEAD of
// env.Q_DELETE.send() for NEW deletion requests; the queue send remains the
// fallback on any create() failure, and the queue consumer + cron backstop keep
// draining whatever they were already sent. See index.ts for the call site.
//
// Instance id convention: deterministic `deletion:<uid>` — this IS the idempotency
// key. A second create() for the same uid throws "already exists" and the caller
// (routes/account.ts) treats that as success (a double-trigger dedupes for free,
// matching the proposal's handoff contract §WS-3).
//
// PORT NOTES — where this intentionally duplicates rather than imports:
//   - The worker deployment CANNOT import from consumers/ (deployment boundary,
//     proposal §1.4) so `underLegalHold`, `recordDeletionRetention`, and
//     `deleteR2Prefix` are re-implemented here verbatim from consumers/src/
//     deletion.ts and consumers/src/retention.ts. Any future change to the legal
//     hold or retention rules must be applied to BOTH copies until the live path
//     itself migrates onto this Workflow — that is a known drift risk, called out
//     in the DYNW-FLOWS-1 report.
//   - Every store the consumer's cascade touches (DB_BRAIN, DB_WALLET, INBOX,
//     DB_MEDIA, BLOBS, VERIFICATION, DIGITAL, AGENT_AUDIO, DB_MODERATION, DB_META,
//     VECTOR_INDEX, AI_SEARCH, TOKENS, CLERK_SECRET_KEY, POSTHOG_*, STRIPE_SECRET_KEY,
//     ANALYTICS, Q_ANALYTICS) is ALREADY bound in worker/src/types.ts — the worker
//     deployment is a strict superset of the consumer's bindings for this cascade.
//     There is NO binding gap for this port (verified against worker/wrangler.toml
//     + worker/src/types.ts before writing this file).
//
// Idempotency discipline (required so a resumed/retried step is a no-op):
//   - every DELETE is `WHERE uid=?` (or the equivalent key) — deleting an
//     already-deleted row matches zero rows, never errors.
//   - every UPDATE writes the same value it would write on a clean run (e.g. the
//     wallet-ledger anonymize, deletion_requests status flips).
//   - INSERT OR REPLACE (retention snapshot) is safe to repeat.
//   - the WalletDO `clear_ai_remainder` op carries a deterministic op_id so a
//     replayed call returns the WalletDO's cached result instead of double-clearing.
//   - Vectorize / AI Search / KV / Clerk / PostHog deletes are all "delete if
//     exists" by construction (the underlying APIs no-op or 404 harmlessly).
import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../types";
import { voicemailR2Prefixes } from "../lib/deletion_prefixes"; // [DEL-VOICEMAIL-R2-1]

/** Params a `deletion:<uid>` instance is created with (routes/account.ts, admin_delete_user.ts). */
export interface DeletionWorkflowParams {
  uid: string;
}

// Uniform per-step retry policy per the WS-3 contract. NOTE: this is intentionally
// much shorter than the live path's "retry forever via queue redelivery + 6h cron
// backstop" for wallet-escrow blocks (see the wallet_gate step below) — a documented
// divergence, not a bug: this Workflow is a dark parallel, not yet the source of
// truth, so a bounded retry ceiling here is the safer failure mode (surfaces loudly
// in the Workflow's error state rather than silently retrying forever).
// TYPES-ONLY NOTE ([WORKER-TSC-1]): `delay` must keep its literal type. Without the
// `as const` it widens to `string`, which no longer satisfies `WorkflowDelayDuration`
// (a `${number} ${label}${"s"|""}` template-literal type in current
// @cloudflare/workers-types). That single widening made every `step.do(name, STEP_RETRY, cb)`
// pick the 2-arg overload, so `T` collapsed to `Serializable<unknown>` and every step
// result below lost its shape. Value is unchanged: still literally "10 seconds".
const STEP_RETRY = { retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const } };

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined, n = 0;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length) { await bucket.delete(keys); n += keys.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

// [DEL-VOICEMAIL-R2-1] Voicemail / receptionist recordings survived deletion:
// the r2_blobs step below wipes `u/<uid>/` and nothing else, but no voicemail
// has ever been stored under `u/`. The prefixes, the producers that write them,
// and the blast-radius guard on `uid` all live in lib/deletion_prefixes.ts
// (pure + unit-tested; deletion.ts itself cannot be imported by vitest because
// of `cloudflare:workers`). The r2_voicemail step below is the consumer.

/**
 * [AVA-IDGATE-1] Legal hold — ported verbatim from consumers/src/deletion.ts
 * `underLegalHold`. FAILS CLOSED: if we cannot determine whether a hold exists,
 * we do NOT delete.
 */
async function underLegalHold(env: Env, uid: string): Promise<boolean> {
  try {
    const r = await env.DB_META.prepare("SELECT legal_hold, legal_hold_reason FROM users WHERE uid=?1")
      .bind(uid).first<{ legal_hold: number; legal_hold_reason: string | null }>();
    if (Number(r?.legal_hold ?? 0) === 1) {
      try {
        env.ANALYTICS?.writeDataPoint({
          blobs: ["legal_hold_blocked_deletion", uid, r?.legal_hold_reason ?? "unknown"],
          doubles: [1], indexes: ["legal_hold"],
        });
      } catch { /* metrics best-effort */ }
      return true;
    }
    return false;
  } catch (e) {
    console.error("[DeletionWorkflow] legal_hold lookup failed — refusing to delete (fail closed)", uid, String(e));
    return true;
  }
}

export interface RetentionDecision {
  track: "extended" | "protective";
  keepVideo: boolean;
}

const RETENTION_DAYS = 256;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;

/**
 * [AVA-IDGATE-1] Retention snapshot — ported verbatim from consumers/src/retention.ts
 * `recordDeletionRetention`. Fails PROTECTIVE on any error (never assume the
 * permissive "extended" track when we can't read the real one).
 */
async function recordDeletionRetention(env: Env, uid: string): Promise<RetentionDecision> {
  const now = Date.now();
  try {
    const u = await env.DB_META.prepare(
      "SELECT email_hash, retention_track, created_at FROM users WHERE uid=?1",
    ).bind(uid).first<{ email_hash: string | null; retention_track: string | null; created_at: number | null }>();

    const l = await env.DB_META.prepare(
      "SELECT verified_at, provider, evidence_ref FROM identity_proofs WHERE uid=?1 AND proof='liveness'",
    ).bind(uid).first<{ verified_at: number | null; provider: string | null; evidence_ref: string | null }>();

    const track: "extended" | "protective" = u?.retention_track === "extended" ? "extended" : "protective";
    const keepVideo = track === "extended";

    await env.DB_META.prepare(
      `INSERT OR REPLACE INTO deleted_account_retention
         (uid, email_hash, liveness_passed_at, liveness_source, liveness_ref,
          retention_track, video_retained, created_at, deleted_at, purge_after)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    ).bind(
      uid, u?.email_hash ?? null, l?.verified_at ?? null, l?.provider ?? null, l?.evidence_ref ?? null,
      track, keepVideo ? 1 : 0, u?.created_at ?? null, now, now + RETENTION_MS,
    ).run();

    return { track, keepVideo };
  } catch (e) {
    console.error("[DeletionWorkflow] retention: snapshot failed — defaulting to PROTECTIVE (delete video)", uid, String(e));
    return { track: "protective", keepVideo: false };
  }
}

/** Everything the destructive steps below need, gathered BEFORE any store is touched. */
interface Collected {
  vectorIds: string[];
  verifKeys: string[];
}

export class DeletionWorkflow extends WorkflowEntrypoint<Env, DeletionWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<DeletionWorkflowParams>>, step: WorkflowStep) {
    const env = this.env;
    const uid = event.payload?.uid;
    if (!uid) throw new NonRetryableError("missing uid in DeletionWorkflow params", "bad_params");

    // ---- Guard 1: legal hold beats the deletion request. Mark held, don't fail. ----
    const hold = await step.do("legal_hold_check", STEP_RETRY, async () => ({
      held: await underLegalHold(env, uid),
    }));
    if (hold.held) {
      await step.do("mark_held", STEP_RETRY, async () => {
        await env.DB_META.prepare("UPDATE deletion_requests SET status='held' WHERE uid=?1").bind(uid).run().catch(() => {});
        return { ok: true };
      });
      return { aborted: true, reason: "legal_hold" };
    }

    // ---- Guard 2: snapshot the retention decision BEFORE the cascade destroys the
    // rows it reads from. `keepVideo` is honoured at the r2_verification step. ----
    const retention = await step.do("retention_snapshot", STEP_RETRY, async () => recordDeletionRetention(env, uid));

    // ---- Grace window: DURABLE SLEEP until scheduled_at. This is the whole point
    // of the Workflow port — the queue path had to emulate this with re-delays +
    // the 6h cron sweep. Without it, a fresh 30-day-grace request would burn the
    // status_check step's 3 retries in under a minute, fail the instance, and
    // poison the deterministic `deletion:<uid>` id (a later create() would look
    // "already exists" = success). Sleep first; the guards below then re-check
    // everything (a cancel during the sleep is honoured on wake). ----
    const sched = await step.do("read_schedule", STEP_RETRY, async () => {
      const req = await env.DB_META.prepare("SELECT scheduled_at FROM deletion_requests WHERE uid=?1")
        .bind(uid).first<{ scheduled_at: number }>();
      return { at: Number(req?.scheduled_at ?? 0) };
    });
    const graceMs = sched.at - Date.now();
    if (graceMs > 0) await step.sleep("grace_wait", `${Math.ceil(graceMs / 1000)} seconds`);

    // ---- Guard 3: honour cancelled/done/held/grace-not-elapsed exactly like the
    // queue path. After grace_wait this throw fires only if scheduled_at moved
    // LATER while we slept (re-request) — retryable, rare, and the queue+cron
    // path remains authoritative for anything this instance gives up on. ----
    const statusCheck = await step.do("status_check", STEP_RETRY, async () => {
      const req = await env.DB_META.prepare(
        "SELECT status, scheduled_at, clerk_user_id FROM deletion_requests WHERE uid=?1",
      ).bind(uid).first<{ status: string; scheduled_at: number; clerk_user_id: string | null }>();
      if (req && req.status === "cancelled") return { abort: "cancelled" as const, clerkId: null as string | null };
      if (req && req.status === "done") return { abort: "done" as const, clerkId: null as string | null };
      if (req && req.status === "held") return { abort: "held" as const, clerkId: null as string | null };
      if (req && Date.now() < req.scheduled_at) throw new Error("grace not elapsed — retry later");
      await env.DB_META.prepare("UPDATE deletion_requests SET status='processing' WHERE uid=?1").bind(uid).run();
      return { abort: null as null, clerkId: req?.clerk_user_id ?? null };
    });
    if (statusCheck.abort) return { aborted: true, reason: statusCheck.abort };
    const clerkId = statusCheck.clerkId;

    // ---- PRE-COLLECT: gather every id a later destructive step needs, before any
    // row is deleted. Vectorize ids derive from brain entities / library media /
    // the Phase 9 vector registry; verification keys from locked R2 selfie rows. ----
    const collected = await step.do("collect", STEP_RETRY, async (): Promise<Collected> => {
      let vectorIds: string[] = [];
      try {
        const er = await env.DB_BRAIN.prepare("SELECT id FROM brain_entities WHERE uid=?1").bind(uid).all();
        vectorIds = (er.results ?? []).map((r: any) => `${uid}:ent:${r.id}`);
      } catch { /* table may be empty */ }
      try {
        const lr = await env.DB_MEDIA.prepare("SELECT DISTINCT id FROM user_media WHERE uid=?1").bind(uid).all();
        for (const r of (lr.results ?? []) as any[]) for (let i = 0; i < 8; i++) vectorIds.push(`${uid}:lib:${r.id}:${i}`);
      } catch { /* table may be empty */ }
      try {
        const vr = await env.DB_BRAIN.prepare("SELECT vec_id FROM brain_vectors WHERE uid=?1").bind(uid).all();
        for (const r of (vr.results ?? []) as any[]) vectorIds.push(String(r.vec_id));
      } catch { /* table from brain_phase9.sql */ }

      let verifKeys: string[] = [];
      try {
        const v = await env.DB_META.prepare(
          "SELECT selfie_video_key FROM verification_status WHERE uid=?1 AND selfie_video_key IS NOT NULL",
        ).bind(uid).all();
        verifKeys = (v.results ?? []).map((r: any) => r.selfie_video_key).filter(Boolean);
      } catch { /* optional */ }

      return { vectorIds, verifKeys };
    });

    // ---- Phase 9 A1: WALLET GATE — pending escrow blocks deletion (retryable);
    // a positive balance after grace is forfeited (logged); AI debt remainder +
    // stray reservations are cleared via a deterministic op_id (idempotent replay). ----
    const done: string[] = [];
    if (env.WALLET_DO) {
      const walletDone = await step.do("wallet_gate", STEP_RETRY, async () => {
        const out: string[] = [];
        const walletStub = env.WALLET_DO.get(env.WALLET_DO.idFromName(uid));
        try {
          const res = await walletStub.fetch("https://wallet/op", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "balance", uid }),
          });
          const w = (await res.json()) as any;
          if (Number(w.held ?? 0) > 0) throw new Error("pending escrow blocks deletion — retry later");
          if (Number(w.balance ?? 0) > 0) out.push(`wallet_forfeited:${w.balance}`);
        } catch (e) {
          if (String(e).includes("escrow")) throw e;
          /* WalletDO unreachable → proceed (recon catches drift) */
        }
        try {
          const clearRes = await walletStub.fetch("https://wallet/op", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ op: "clear_ai_remainder", uid, op_id: `account_delete_ai_remainder:${uid}` }),
          });
          const cleared = (await clearRes.json().catch(() => ({}))) as any;
          out.push(`wallet_ai_remainder_cleared:${cleared.cleared_debt_micro_usd ?? 0}:${cleared.released_ai_reservations ?? 0}`);
        } catch (e) {
          console.error("[DeletionWorkflow] clear_ai_remainder failed:", uid, String(e));
          out.push("wallet_ai_remainder_clear_failed");
        }
        return out;
      });
      done.push(...walletDone);
    }

    // ---- 1. DB_BRAIN ----
    done.push(...await step.do("db_brain", STEP_RETRY, async () => {
      const out: string[] = [];
      await env.DB_BRAIN.batch([
        env.DB_BRAIN.prepare("DELETE FROM brain_entities WHERE uid=?1").bind(uid),
        env.DB_BRAIN.prepare("DELETE FROM brain_relationships WHERE uid=?1").bind(uid),
        env.DB_BRAIN.prepare("DELETE FROM brain_facts WHERE uid=?1").bind(uid),
        env.DB_BRAIN.prepare("DELETE FROM brain_daily_summaries WHERE uid=?1").bind(uid),
        env.DB_BRAIN.prepare("DELETE FROM brain_events WHERE uid=?1").bind(uid),
      ]); out.push("db_brain");
      try { await env.DB_BRAIN.prepare("DELETE FROM brain_consent WHERE uid=?1").bind(uid).run(); out.push("db_brain_consent"); } catch { /* table optional */ }
      // [AVABRAIN-ASSET-1] separate try/catch — migration may not have run yet.
      try {
        await env.DB_BRAIN.prepare("DELETE FROM brain_asset_derivatives WHERE owner_uid=?1").bind(uid).run();
        await env.DB_BRAIN.prepare("DELETE FROM brain_assets WHERE owner_uid=?1").bind(uid).run();
        out.push("db_brain_assets");
      } catch { /* table optional */ }
      // Phase 9: message/voicemail vector registry + transcripts. Ids were already
      // collected in the "collect" step above; this DELETE is idempotent on retry.
      try {
        await env.DB_BRAIN.prepare("DELETE FROM brain_vectors WHERE uid=?1").bind(uid).run();
        await env.DB_BRAIN.prepare("DELETE FROM brain_transcripts WHERE uid=?1").bind(uid).run();
        out.push("db_brain_vectors_transcripts");
      } catch { /* tables from brain_phase9.sql */ }
      return out;
    }));

    // ---- 2. DB_WALLET. A1: the LEDGER is RETAINED (finance-law retention) with
    // meta anonymized; only PII-bearing side tables are deleted. ----
    if (env.DB_WALLET) {
      done.push(...await step.do("db_wallet", STEP_RETRY, async () => {
        try {
          await env.DB_WALLET.batch([
            env.DB_WALLET.prepare("UPDATE wallet_transactions SET meta='{\"anonymized\":true}' WHERE uid=?1").bind(uid),
            env.DB_WALLET.prepare("DELETE FROM topup_records WHERE uid=?1").bind(uid),
            env.DB_WALLET.prepare("DELETE FROM earning_holds WHERE uid=?1").bind(uid),
            env.DB_WALLET.prepare("DELETE FROM wallet_balances WHERE uid=?1").bind(uid),
            env.DB_WALLET.prepare("DELETE FROM payout_accounts WHERE uid=?1").bind(uid),
            env.DB_WALLET.prepare("DELETE FROM payout_requests WHERE uid=?1").bind(uid),
          ]);
          return ["db_wallet_ledger_retained"];
        } catch { return []; /* tables may not exist yet */ }
      }));
    }

    // ---- 3. InboxDO — purge the user's own message log. Peers keep their side. ----
    if (env.INBOX) {
      done.push(...await step.do("inbox_do", STEP_RETRY, async () => {
        try {
          await env.INBOX.get(env.INBOX.idFromName(uid)).fetch("https://inbox/purge", { method: "POST" });
          return ["inbox_do"];
        } catch { return []; /* best-effort */ }
      }));
    }

    // ---- 4. DB_MEDIA ----
    done.push(...await step.do("db_media", STEP_RETRY, async () => {
      const out: string[] = [];
      await env.DB_MEDIA.batch([
        env.DB_MEDIA.prepare("DELETE FROM user_media WHERE uid=?1").bind(uid),
        env.DB_MEDIA.prepare("DELETE FROM user_media_hashes WHERE uid=?1").bind(uid),
      ]); out.push("db_media");
      try { await env.DB_MEDIA.prepare("DELETE FROM library_folders WHERE uid=?1").bind(uid).run(); out.push("db_media_folders"); } catch { /* optional */ }
      try {
        await env.DB_MEDIA.batch([
          env.DB_MEDIA.prepare("DELETE FROM olx_purchases WHERE buyer_npub=?1 OR seller_npub=?1").bind(uid),
          env.DB_MEDIA.prepare("DELETE FROM olx_digital_products WHERE seller_npub=?1").bind(uid),
          env.DB_MEDIA.prepare("DELETE FROM olx_listings WHERE seller_npub=?1").bind(uid),
        ]); out.push("db_media_olx");
      } catch { /* tables may not exist yet */ }
      return out;
    }));

    // ---- 5. R2 blobs (per-user prefix). ----
    done.push(...await step.do("r2_blobs", STEP_RETRY, async () => {
      try { return [`r2_blobs:${await deleteR2Prefix(env.BLOBS, `u/${uid}/`)}`]; } catch { return []; }
    }));

    // ---- 6. R2 verification (prefix + explicit keys) + 6b. R2 digital goods. ----
    if (env.VERIFICATION) {
      done.push(...await step.do("r2_verification", STEP_RETRY, async () => {
        const out: string[] = [];
        try { await deleteR2Prefix(env.VERIFICATION, `u/${uid}/`); } catch { /* best-effort */ }
        if (!retention.keepVideo) {
          try { await deleteR2Prefix(env.VERIFICATION, `liveness/${uid}/`); } catch { /* best-effort */ }
          try { await deleteR2Prefix(env.VERIFICATION, `didit/${uid}/`); } catch { /* best-effort */ } // [LIVE-DIDIT-5]
          try {
            env.ANALYTICS?.writeDataPoint({
              blobs: ["liveness_video_deleted", "account_deleted", retention.track],
              doubles: [1], indexes: ["retention"],
            });
          } catch { /* metrics best-effort */ }
          if (collected.verifKeys.length) { try { await env.VERIFICATION.delete(collected.verifKeys); } catch { /* best-effort */ } }
        } else {
          console.log("[DeletionWorkflow] retention: extended track — liveness video held until purge_after", uid);
        }
        out.push(`r2_verification:${retention.track}`);
        return out;
      }));
    }
    if (env.DIGITAL) {
      done.push(...await step.do("r2_digital", STEP_RETRY, async () => {
        try { await deleteR2Prefix(env.DIGITAL, `u/${uid}/`); return ["r2_digital"]; } catch { return []; }
      }));
    }

    // ---- 7. R2 agent-audio. ----
    if (env.AGENT_AUDIO) {
      done.push(...await step.do("r2_agent_audio", STEP_RETRY, async () => {
        try { await deleteR2Prefix(env.AGENT_AUDIO, `u/${uid}/`); return ["r2_agent_audio"]; } catch { return []; }
      }));
    }

    // ---- 7b. [DEL-VOICEMAIL-R2-1] R2 voicemail + receptionist recordings, in
    // BOTH buckets (see the block comment at the top of this file for why two).
    //
    // Idempotent and resumable by construction: deleteR2Prefix re-lists on every
    // run, so a replay after a partial sweep simply finds fewer (or zero) keys.
    // Every prefix/bucket pair is attempted independently — one failure never
    // abandons the others, and never abandons the rest of the cascade, matching
    // r2_verification / r2_digital above and the [DEL-LOUD-FAIL-1] idiom of
    // RECORDING a failure in `stores_done` instead of vanishing it. ----
    done.push(...await step.do("r2_voicemail", STEP_RETRY, async () => {
      const prefixes = voicemailR2Prefixes(uid);
      if (!prefixes.length) {
        // Cannot happen for a real account (the `!uid` throw above already fired,
        // and every minted uid matches UID_R2_SAFE). If it ever does, refusing is
        // the only safe answer — a wildcard prefix here deletes other users.
        console.error("[DeletionWorkflow] REFUSING voicemail R2 sweep — uid is not key-safe", uid);
        return ["r2_voicemail_skipped_unsafe_uid"];
      }
      const buckets: Array<[string, R2Bucket | undefined]> = [
        ["digital", env.DIGITAL],   // [RECEPT-PRIVBUCKET-1] current write target
        ["blossom", env.BLOBS],     // every recording taken before that change
      ];
      const out: string[] = [];
      for (const [label, bucket] of buckets) {
        if (!bucket) continue;
        for (const prefix of prefixes) {
          const tag = `${label}_${prefix.split("/")[0]}`;
          let deleted = 0, err: unknown = null;
          // Two attempts: a mid-listing R2 blip would otherwise leave the tail of
          // a prefix behind. Re-running is free — already-deleted keys no longer list.
          for (let attempt = 0; attempt < 2; attempt++) {
            try { deleted += await deleteR2Prefix(bucket, prefix); err = null; break; }
            catch (e) { err = e; }
          }
          if (err) {
            console.error("[DeletionWorkflow] voicemail R2 sweep FAILED", tag, prefix, String(err));
            try {
              env.ANALYTICS?.writeDataPoint({
                blobs: ["voicemail_erase_failed", uid.slice(0, 16), tag],
                doubles: [1], indexes: ["account_deletion"],
              });
            } catch { /* metrics best-effort */ }
            out.push(`r2_voicemail_${tag}_failed`);
          } else {
            out.push(`r2_voicemail_${tag}:${deleted}`);
          }
        }
      }
      return out;
    }));

    // ---- 8. DB_MODERATION — drop the user's own reports (keep reports filed AGAINST others). ----
    done.push(...await step.do("db_moderation", STEP_RETRY, async () => {
      try { await env.DB_MODERATION.prepare("DELETE FROM user_reports WHERE reporter_npub=?1").bind(uid).run(); return ["db_moderation"]; } catch { return []; }
    }));

    // ---- 9. DB_META — identity, social, settings, verification, deletion bookkeeping. ----
    done.push(...await step.do("db_meta", STEP_RETRY, async () => {
      const metaStmts = [
        // [DEL-USERS-TABLE-1] identity row lives in `users`; keep the `profiles`
        // statement for any environment that still has that legacy table.
        "DELETE FROM users WHERE uid=?1",
        "DELETE FROM profiles WHERE uid=?1",
        "DELETE FROM contact_phone_index WHERE uid=?1",
        "DELETE FROM follows WHERE uid=?1 OR follows_npub=?1",
        "DELETE FROM blocks WHERE uid=?1 OR blocked_npub=?1",
        "DELETE FROM mutes WHERE uid=?1 OR muted_npub=?1",
        "DELETE FROM user_settings WHERE uid=?1",
        "DELETE FROM push_tokens_v2 WHERE uid=?1",
        "DELETE FROM community_members WHERE uid=?1",
        "DELETE FROM communities WHERE owner_npub=?1",
        "DELETE FROM account_strikes WHERE uid=?1",
        "DELETE FROM live_streams WHERE uid=?1",
        "DELETE FROM notifications WHERE uid=?1",
        "DELETE FROM verification_status WHERE uid=?1",
        "DELETE FROM verification_attempts WHERE uid=?1",
        "DELETE FROM liveness_didit_records WHERE uid=?1", // [LIVE-DIDIT-5]
        "DELETE FROM identity_proofs WHERE uid=?1 AND proof='liveness'", // [LIVE-PURGE-1]
        "DELETE FROM calendar_slots WHERE uid=?1",
        // A1: bookings/orders KEEP their rows; the deleted party's id is replaced.
        "UPDATE calendar_events SET host_npub='deleted_user' WHERE host_npub=?1",
        "UPDATE calendar_events SET attendee_npub='deleted_user' WHERE attendee_npub=?1",
        "UPDATE bookings SET creator_id='deleted_user', updated_at=strftime('%s','now')*1000 WHERE creator_id=?1",
        "UPDATE bookings SET buyer_id='deleted_user', updated_at=strftime('%s','now')*1000 WHERE buyer_id=?1",
        "DELETE FROM availability_rules WHERE user_id=?1",
        "DELETE FROM booking_policies WHERE user_id=?1",
        "DELETE FROM calendar_blocks WHERE user_id=?1",
        "DELETE FROM gcal_accounts WHERE user_id=?1",
        "DELETE FROM listings WHERE creator_id=?1",
        "UPDATE reviews SET author_id='deleted_user' WHERE author_id=?1",
        "DELETE FROM creator_profiles WHERE uid=?1",
        "DELETE FROM agent_personas WHERE uid=?1",
        "DELETE FROM agent_conversations WHERE uid=?1",
        "DELETE FROM agent_inbox WHERE uid=?1",
        "DELETE FROM user_vault WHERE uid=?1",
        "DELETE FROM clerk_nostr_link WHERE uid=?1",
        "DELETE FROM account_status WHERE uid=?1",
      ];
      for (const q of metaStmts) { try { await env.DB_META.prepare(q).bind(uid).run(); } catch { /* table may not exist in this phase */ } }
      return ["db_meta"];
    }));

    // ---- 10. Vectorize. ----
    if (env.VECTOR_INDEX && collected.vectorIds.length) {
      done.push(...await step.do("vectorize", STEP_RETRY, async () => {
        try {
          for (let i = 0; i < collected.vectorIds.length; i += 1000) {
            await env.VECTOR_INDEX.deleteByIds(collected.vectorIds.slice(i, i + 1000));
          }
          return [`vectorize:${collected.vectorIds.length}`];
        } catch { return []; }
      }));
    }

    // ---- 10b. AI Search shard docs — delete per item id, decrement shard stats. ----
    if (env.AI_SEARCH) {
      done.push(...await step.do("ai_search", STEP_RETRY, async () => {
        try {
          const rows = await env.DB_META
            .prepare("SELECT shard, item_id FROM ava_search_items WHERE uid=?1")
            .bind(uid).all<{ shard: string; item_id: string }>();
          const byShard = new Map<string, string[]>();
          for (const r of (rows.results ?? []) as any[]) {
            if (!byShard.has(r.shard)) byShard.set(r.shard, []);
            byShard.get(r.shard)!.push(r.item_id);
          }
          let aiDeleted = 0;
          for (const [shard, ids] of byShard) {
            let inst: any = null;
            try { inst = await (env.AI_SEARCH as any).get(shard); } catch { inst = null; }
            if (!inst) continue;
            for (const id of ids) { try { await inst.items.delete(id); aiDeleted++; } catch { /* keep going */ } }
            try {
              await env.DB_META
                .prepare("UPDATE ava_search_shard_stats SET item_count=MAX(0,item_count-?2), updated_at=?3 WHERE shard=?1")
                .bind(shard, ids.length, Date.now()).run();
            } catch { /* best-effort */ }
          }
          try { await env.DB_META.prepare("DELETE FROM ava_search_items WHERE uid=?1").bind(uid).run(); } catch { /* best-effort */ }
          return [`ai_search:${aiDeleted}`];
        } catch { return []; }
      }));
    }

    // ---- 11. KV — verified cache + any per-user ephemeral keys. ----
    done.push(...await step.do("kv", STEP_RETRY, async () => {
      try { await env.TOKENS.delete(`verified:${uid}`); return ["kv"]; } catch { return []; }
    }));

    // ---- 12. DOs — UserBrain / Agent / Conversation DOs self-expire (hibernate to
    // nothing); no API to enumerate by name. Marked noted, matching the consumer. ----
    done.push("dos_noted");

    // ---- 13. Clerk user (Backend API) — IRREVERSIBLE. Re-check the deletion
    // request one last time: if the user reactivated mid-cascade, abort the Clerk
    // delete (everything else above is already idempotent-safe to have run). ----
    done.push(...await step.do("clerk", STEP_RETRY, async () => {
      const still = await env.DB_META.prepare("SELECT status FROM deletion_requests WHERE uid=?1")
        .bind(uid).first<{ status: string }>();
      if (still && still.status === "cancelled") return ["clerk_skipped_cancelled"];
      if (!env.CLERK_SECRET_KEY || !clerkId) return [clerkId ? "clerk_skipped_no_secret" : "clerk_skipped_no_id"];
      try {
        const r = await fetch(`https://api.clerk.com/v1/users/${clerkId}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
        });
        // [DEL-LOUD-FAIL-1] record failures instead of vanishing them.
        return [r.ok || r.status === 404 ? "clerk" : `clerk_failed:${r.status}`];
      } catch { return ["clerk_error"]; }
    }));

    // ---- 14. PostHog person. ----
    if (env.POSTHOG_PERSONAL_API_KEY && env.POSTHOG_PROJECT_ID) {
      done.push(...await step.do("posthog", STEP_RETRY, async () => {
        try {
          // [DEL-POSTHOG-EU-1] project lives on EU cloud.
          const pr = await fetch(
            `https://eu.posthog.com/api/projects/${env.POSTHOG_PROJECT_ID}/persons/?distinct_id=${encodeURIComponent(uid)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}` } },
          );
          return [pr.ok || pr.status === 404 ? "posthog" : `posthog_failed:${pr.status}`];
        } catch { return ["posthog_error"]; }
      }));
    }

    // ---- 15. Stripe customer — guarded placeholder (customer id lookup lives in
    // wallet rows, already deleted; no-op until a later phase wires it, exactly
    // like the consumer). ----
    if (env.STRIPE_SECRET_KEY) done.push("stripe_noted");

    // ---- Finalize: mark done, emit telemetry, exactly like the consumer. ----
    await step.do("finalize", STEP_RETRY, async () => {
      await env.DB_META.prepare(
        "UPDATE deletion_requests SET status='done', processed_at=?2, stores_done=?3 WHERE uid=?1",
      ).bind(uid, Date.now(), JSON.stringify(done)).run();
      try { env.ANALYTICS?.writeDataPoint({ blobs: ["account_deletion_workflow", uid.slice(0, 16)], doubles: [done.length], indexes: ["account_deletion"] }); } catch { /* best-effort */ }
      try {
        await env.Q_ANALYTICS?.send({
          event: "account_deleted", uid, ts: Date.now(),
          props: { stores: done.length, trace_id: crypto.randomUUID(), app_name: "platform", app_version: "server", service_name: "avatok-api-workflow" },
        });
      } catch { /* best-effort */ }
      return { ok: true };
    });

    return { aborted: false, stores_done: done };
  }
}

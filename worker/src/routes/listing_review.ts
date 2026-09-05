// [LISTING-REVIEW-1 2026-09-05] The listing review, made honest.
//
// WHAT WAS THERE BEFORE, AND WHY IT WAS A LIE
//
// Step 8 of the wizard showed a line reading "AI check of your listing —
// passed". Three things were wrong with it:
//
//   1. It was not a check of the listing. `/api/listings/copy-review` reads only
//      title, blurb and description, and its system prompt says so: "You edit
//      ONLY for length, clarity and sentence case." It never saw the schedule,
//      the price, the capacity or the category.
//   2. It had no verdict to report. The response shape carried suggested text
//      and nothing else — no pass, no fail — so there was nothing for the
//      checklist to read even if it had wanted to.
//   3. The tick was set by the request RETURNING. `onReviewed()` fired on
//      success regardless of what came back, and when the model was unavailable
//      the route fell back to a deterministic length clamp and still reported
//      `passed`.
//
// So a live_event with no start time — unbuyable, unjoinable, and refused by
// publish forever — was told it had passed an AI check. The owner's words on
// 2026-09-05: "the AI review at the end is fake ... I need proper form
// validation per step and ai review needs to be solid and no lies."
//
// WHAT THIS IS
//
// A verdict over the WHOLE listing, in two layers:
//
//   * The DETERMINISTIC layer is `listingBlockers()` — the same function publish
//     enforces. Anything it returns is a `fail`, full stop. This layer cannot be
//     wrong and cannot be unavailable, which is what makes a `fail` trustworthy.
//   * The MODEL layer looks for the things rules cannot see: a description that
//     contradicts the title, a price that does not match what is being offered,
//     a category that is not what the listing describes, missing information a
//     buyer would need. It can only ever add `warn` items.
//
// THE MODEL CAN NEVER PRODUCE A PASS ON ITS OWN, AND ITS ABSENCE IS NEVER A
// PASS. If the model is unavailable the response says so — `model: "unavailable"`
// — and the verdict is computed from the deterministic layer alone. That is the
// one rule that stops this becoming the thing it replaced: a review is allowed
// to be less thorough than we hoped, and is never allowed to claim it ran when
// it did not.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { readConfig } from "./config";
import { avaReason } from "../lib/ava_reason";
import { guardInput, guardOutput } from "../lib/ai_gate";
import { listingBlockers, type ListingBlocker } from "../lib/listing_blockers";

export type ReviewIssue = {
  severity: "fail" | "warn";
  /** Wizard-draft field name, or null for a whole-listing observation. */
  field: string | null;
  message: string;
  /** "rules" = the deterministic layer publish also enforces. "ai" = the model. */
  source: "rules" | "ai";
};

function parseJsonObject(raw: string): Record<string, any> | null {
  const cleaned = String(raw || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  try { const v = JSON.parse(cleaned); return v && typeof v === "object" ? v : null; } catch { /* fall through */ }
  const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { const v = JSON.parse(cleaned.slice(a, b + 1)); return v && typeof v === "object" ? v : null; } catch { /* ignore */ }
  }
  return null;
}

const s = (v: unknown, n = 400) => String(v ?? "").trim().slice(0, n);

/**
 * POST /api/listings/:id/review — is this listing actually ready?
 *
 * Returns `{ verdict, issues[], model }`:
 *   fail — cannot publish. At least one deterministic blocker.
 *   warn — publishable, but the model found something worth a second look.
 *   pass — no blockers, and the model (if it ran) had nothing to add.
 *
 * `model` is "ok" | "unavailable" | "off" so the client can say which of those
 * happened instead of implying a full review either way.
 */
export async function listingReview(req: Request, env: Env, id: string): Promise<Response> {
  const u = await requireUser(req, env);
  if (isFail(u)) return json({ error: u.error }, u.status);

  const row = await metaDb(env).prepare("SELECT * FROM listings WHERE id=?1").bind(id).first<any>();
  if (!row) return json({ error: "not found" }, 404);
  const admins = (env.ADMIN_UIDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (row.creator_id !== u.uid && !admins.includes(u.uid)) return json({ error: "not found" }, 404);

  // ---- layer 1: deterministic, and identical to what publish enforces ----
  const blockers: ListingBlocker[] = await listingBlockers(env, row);
  const issues: ReviewIssue[] = blockers.map((b) => ({
    severity: "fail" as const,
    field: b.field,
    message: b.message,
    source: "rules" as const,
  }));

  // ---- layer 2: the model, advisory only ----
  const cfg = await readConfig(env);
  const modelAllowed = (cfg as any).aiEnabled === true
    && (cfg as any).listingAiReviewEnabled !== false;
  let model: "ok" | "unavailable" | "off" = modelAllowed ? "unavailable" : "off";

  if (modelAllowed) {
    const facts = [
      `kind: ${s(row.kind, 40)}`,
      `category: ${s(row.category, 60)}`,
      `title: ${JSON.stringify(s(row.title, 140))}`,
      `one-liner: ${JSON.stringify(s(row.blurb, 200))}`,
      `description: ${JSON.stringify(s(row.description, 2000))}`,
      `price per hour (tokens, 1 token = 1 rupee): ${Number(row.price) || 0}`,
      `free entry: ${Number(row.free_entry ?? 0) === 1}`,
      `schedule mode: ${s(row.schedule_mode, 40) || "fixed_date"}`,
      row.starts_at ? `starts: ${new Date(Number(row.starts_at)).toISOString()}` : "starts: not set",
      `length (minutes): ${Number(row.duration_min) || 0}`,
      `capacity: ${Number(row.capacity) || 0}`,
      `spoken languages: ${s(row.spoken_lang, 120) || "not set"}`,
      `location: ${s(row.location, 120) || "not set"}`,
    ].join("\n");

    const system = [
      "You are reviewing a listing for avaTOK, an Indian marketplace where people",
      "sell live sessions and 1:1 consultations, priced per hour in rupees.",
      "Your job is to find problems a BUYER would hit — not to rewrite the copy.",
      "Report ONLY things that are actually wrong or missing in what you are shown:",
      "the description contradicting the title, the category not matching what is",
      "described, a price that makes no sense for what is offered, a promise the",
      "listing cannot keep, or information a buyer plainly needs and does not have.",
      "Do NOT comment on tone, grammar, capitalisation or length — a different",
      "check handles those. Do NOT invent facts about the seller.",
      "An empty optional field is not a problem. Say nothing rather than padding.",
      "Hinglish is normal here and is never a problem.",
    ].join(" ");
    const user = [
      "Here is the listing:", "", facts, "",
      'Respond with ONLY JSON: {"issues":[{"field":"<one of title, blurb, description,',
      'category, price, starts_at, duration_min, capacity, or null>","message":"<one short',
      'sentence a creator can act on>"}]}',
      "Return an empty array when you find nothing. An empty array is the expected",
      "answer for a good listing — do not manufacture an issue to look useful.",
    ].join("\n");

    try {
      const gate = await guardInput(env, `${s(row.title, 140)}\n${s(row.blurb, 200)}\n${s(row.description, 2000)}`);
      if (gate.ok) {
        const raw = await avaReason(env, {
          role: "listing", capability: "listing_review", trigger: "wizard_review",
          feature: "listing_review", uid: u.uid,
          system, user, temperature: 0.1, maxTokens: 700, timeoutMs: 20000,
        });
        const parsed = parseJsonObject(String(raw ?? ""));
        if (parsed && Array.isArray(parsed.issues)) {
          const outGate = await guardOutput(env, parsed.issues.map((i: any) => s(i?.message, 200)).join(" "));
          if (outGate.ok) {
            model = "ok";
            for (const i of parsed.issues.slice(0, 8)) {
              const message = s(i?.message, 200);
              if (!message) continue;
              issues.push({
                severity: "warn",
                field: i?.field ? s(i.field, 40) : null,
                message,
                source: "ai",
              });
            }
          }
        }
      }
    } catch {
      // Left as "unavailable". Deliberately NOT folded into a pass — see the
      // header. The whole point of this rewrite is that a review which did not
      // happen must never render as one that did.
    }
  }

  const verdict = issues.some((i) => i.severity === "fail")
    ? "fail"
    : issues.length ? "warn" : "pass";

  return json({
    ok: true,
    listing_id: id,
    verdict,
    model,
    issues,
    // The deterministic list on its own, so a client can show "publish will
    // refuse this" separately from "a model thinks you could do better".
    blockers,
    checked_at: Date.now(),
  });
}

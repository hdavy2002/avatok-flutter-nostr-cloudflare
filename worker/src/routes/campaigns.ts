// worker/src/routes/campaigns.ts — [AVA-CAMP-B2-ROUTES] Minimal campaign
// control API for outbound AI calling campaigns (Specs/
// OUTBOUND-AI-CALLING-CAMPAIGNS.md §3 "Data model", §6 "Campaign engine",
// §11 "Inbox & user experience" wizard's final Review&Launch step, §13
// "Security & multi-tenancy", §17 Phase B2 "Beta behind campaignOwnerAllowlist").
//
// Scope for B2 (per task): draft creation, launch (freezes a MINIMAL compiled
// prompt — full prompt compilation with KB/tools/persona is Phase C, see the
// TODO in campaignLaunch below), pause/resume/cancel forwarding to CampaignDO,
// and read (get/list). Contact ingestion, KB upload, analytics, and the full
// wizard are later phases.
//
// AUTH/GATING — mirrors routes/config.ts's putConfig() pattern:
//   - requireUser(req, env) for the caller's uid (Clerk JWT, never client-
//     supplied uid).
//   - readConfig(env).campaignsEnabled must be true, else 503 (matches the
//     "disabled" contract other flag-gated routes use, e.g. pstn.ts's
//     handleExpect on cfg.pstnVoicemail).
//   - if readConfig(env).campaignOwnerAllowlist is true, the caller's uid must
//     be in env.ADMIN_UIDS (comma/space-split, same parsing as putConfig's
//     admin check) — the beta allowlist per §17 Phase B2.
//   - every :id route re-verifies campaigns.uid === caller uid from D1 before
//     any read or mutation — the client never supplies a trusted owner.
import type { Env } from "../types";
import { json } from "../util";
import { isFail, requireUser } from "../authz";
import { readConfig } from "./config";
import { metaDb } from "../db/shard";
import { compileCampaignPrompt, PROMPT_VERSION, type CampaignPromptInput } from "../lib/campaign_prompt";
import { track } from "../hooks";

// ---------------------------------------------------------------------------
// Gating helpers
// ---------------------------------------------------------------------------

function parseUidList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** Returns an AuthFail-shaped object on any gate failure, or null when clear
 *  to proceed. Combines the flag gate + beta allowlist gate in one place so
 *  every handler below applies both consistently. */
async function gate(env: Env, uid: string): Promise<{ error: string; status: number } | null> {
  const cfg = await readConfig(env);
  if (cfg.campaignsEnabled !== true) return { error: "disabled", status: 503 };
  if (cfg.campaignOwnerAllowlist === true) {
    const admins = parseUidList(env.ADMIN_UIDS);
    if (!admins.includes(uid)) return { error: "beta access required", status: 403 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  uid: string;
  name: string;
  goal_text: string;
  status: string;
  spend_cap_tokens: number;
  did_e164: string | null;
  concurrency: number;
  window_start_min: number;
  window_end_min: number;
  compiled_prompt: string | null;
  compiled_prompt_hash: string | null;
  prompt_version: number | null;
  language_hint: string | null;
  voice_persona: string | null;
  kb_store: string | null;
  booking_enabled: number; // SQLite 0/1
  handover_enabled: number; // SQLite 0/1
  n_total: number;
  n_done: number;
  n_answered: number;
  n_missed: number;
  n_busy: number;
  n_machine: number;
  n_failed: number;
  n_dnc: number;
  tokens_spent: number;
  seconds_talked: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

function campaignSummary(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    goal_text: row.goal_text,
    status: row.status,
    spend_cap_tokens: row.spend_cap_tokens,
    did_e164: row.did_e164,
    concurrency: row.concurrency,
    window_start_min: row.window_start_min,
    window_end_min: row.window_end_min,
    prompt_version: row.prompt_version,
    compiled_prompt_hash: row.compiled_prompt_hash,
    counters: {
      n_total: row.n_total, n_done: row.n_done, n_answered: row.n_answered,
      n_missed: row.n_missed, n_busy: row.n_busy, n_machine: row.n_machine,
      n_failed: row.n_failed, n_dnc: row.n_dnc,
    },
    tokens_spent: row.tokens_spent,
    seconds_talked: row.seconds_talked,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

/** Ownership-checked single-row fetch — every :id route uses this instead of
 *  trusting a client-supplied uid (§13 "Security & multi-tenancy"). */
async function loadOwnedCampaign(env: Env, id: string, uid: string): Promise<CampaignRow | null | "forbidden"> {
  const row = await metaDb(env)
    .prepare(`SELECT * FROM campaigns WHERE id=?1`)
    .bind(id)
    .first<CampaignRow>();
  if (!row) return null;
  if (row.uid !== uid) return "forbidden";
  return row;
}

function campaignDoStub(env: Env, campaignId: string): { fetch: (url: string, init?: RequestInit) => Promise<Response> } | null {
  // CAMPAIGN_DO isn't declared in types.ts yet (wired by a separate task per
  // the B2 route-authoring scope) — read it defensively so this file compiles
  // and degrades gracefully (an op still updates D1 status; the DO catches up
  // once it exists / once the binding lands) instead of throwing.
  const ns = (env as unknown as { CAMPAIGN_DO?: DurableObjectNamespace }).CAMPAIGN_DO;
  if (!ns) return null;
  return ns.get(ns.idFromName(campaignId));
}

// ---------------------------------------------------------------------------
// POST /api/campaigns — create a draft
// ---------------------------------------------------------------------------
async function createCampaign(req: Request, env: Env, uid: string): Promise<Response> {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const name = String(body.name ?? "").trim();
  const goalText = String(body.goal_text ?? "").trim();
  const spendCapTokens = Math.trunc(Number(body.spend_cap_tokens));

  if (!name) return json({ error: "name required" }, 400);
  if (!goalText) return json({ error: "goal_text required" }, 400);
  if (!(Number.isFinite(spendCapTokens) && spendCapTokens > 0)) {
    return json({ error: "spend_cap_tokens must be a positive integer" }, 400);
  }

  const cfg = await readConfig(env);
  const maxContacts = Number(cfg.campaignMaxContacts ?? 2000);

  const id = crypto.randomUUID();
  const now = Date.now();
  // Defaults per spec §3 (window 10:00-19:00 IST = 600..1140 minutes,
  // concurrency 1) — the migration's column defaults already match these, but
  // we bind explicitly here so a future column-default change can't silently
  // shift what a freshly created draft looks like.
  const windowStartMin = Number.isFinite(Number(body.window_start_min)) ? Math.trunc(Number(body.window_start_min)) : 600;
  const windowEndMin = Number.isFinite(Number(body.window_end_min)) ? Math.trunc(Number(body.window_end_min)) : 1140;
  const concurrency = Number.isFinite(Number(body.concurrency)) && Number(body.concurrency) > 0
    ? Math.trunc(Number(body.concurrency)) : 1;
  const didE164 = typeof body.did_e164 === "string" && body.did_e164.trim() ? body.did_e164.trim() : null;
  const languageHint = typeof body.language_hint === "string" ? body.language_hint.trim() || null : null;
  const voicePersona = typeof body.voice_persona === "string" ? body.voice_persona.trim() || null : null;

  try {
    await metaDb(env)
      .prepare(
        `INSERT INTO campaigns
           (id, uid, name, goal_text, did_e164, language_hint, voice_persona,
            status, concurrency, window_start_min, window_end_min, spend_cap_tokens,
            created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(id, uid, name, goalText, didE164, languageHint, voicePersona,
        concurrency, windowStartMin, windowEndMin, spendCapTokens, uid, now)
      .run();
  } catch (e) {
    return json({ error: "create failed", detail: String(e).slice(0, 200) }, 500);
  }

  return json({ ok: true, id, status: "draft", max_contacts: maxContacts }, 201);
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/launch
// ---------------------------------------------------------------------------

async function launchCampaign(env: Env, uid: string, id: string): Promise<Response> {
  const row = await loadOwnedCampaign(env, id, uid);
  if (row === null) return json({ error: "not found" }, 404);
  if (row === "forbidden") return json({ error: "forbidden" }, 403);
  if (row.status !== "draft" && row.status !== "ready") {
    return json({ error: `cannot launch from status '${row.status}'` }, 409);
  }

  // [AVA-CAMP-C-WIRE] Real server-side prompt compiler (spec §8) — immutable
  // identity+purpose disclosure preamble, KB grounding, tool declarations,
  // persona/language, handover. Replaces the B2 minimal inline build.
  const promptInput: CampaignPromptInput = {
    name: row.name,
    goal_text: row.goal_text,
    language_hint: row.language_hint ?? null,
    voice_persona: row.voice_persona ?? null,
    owner_display_name: null, // best-effort; no owner display-name column on campaigns
    business_name: null, // unknown at this scope
    hasKb: !!row.kb_store,
    toolNames: row.booking_enabled ? ["check_availability", "book_appointment"] : [],
    bookingEnabled: !!row.booking_enabled,
    handoverEnabled: !!row.handover_enabled,
  };
  const compiled = await compileCampaignPrompt(promptInput);
  const compiledPrompt = compiled.text;
  const compiledPromptHash = compiled.hash;
  const promptVersion = compiled.version;
  const now = Date.now();

  try {
    await metaDb(env)
      .prepare(
        `UPDATE campaigns
         SET compiled_prompt=?1, compiled_prompt_hash=?2, prompt_version=?3,
             status='running', started_at=?4
         WHERE id=?5`,
      )
      .bind(compiledPrompt, compiledPromptHash, promptVersion, now, id)
      .run();
  } catch (e) {
    return json({ error: "launch failed", detail: String(e).slice(0, 200) }, 500);
  }

  try {
    const stub = campaignDoStub(env, id);
    if (stub) {
      await stub.fetch("https://c/kick", { method: "POST" });
    }
    // else: CAMPAIGN_DO binding not wired yet — status is already 'running' in
    // D1; the DO will pick up the campaign on its first tick once it exists,
    // consistent with this repo's "D1 is authoritative, DOs reconstruct from
    // D1 on wake" design principle (spec §1.5).
  } catch { /* best-effort — D1 status change is the source of truth */ }

  // [AVA-CAMP-Q-BACKEND] One-time PostHog Group identify — registers the
  // `campaign` Group's display properties (PostHog's `$groupidentify` capture
  // convention: $group_type + $group_key + $group_set) so the PostHog UI can
  // show a readable name for this campaign_id, alongside the per-event
  // `$groups: {campaign: id}` association campaign_do.ts/campaign_pstn.ts
  // attach to every subsequent event. Best-effort, fires once at launch (not
  // on every draft edit) — harmless to re-send on a relaunch, PostHog just
  // overwrites $group_set with the latest values.
  void track(env, uid, "$groupidentify", "avatok", {
    $group_type: "campaign", $group_key: id,
    $group_set: { name: row.name, owner_uid: uid, launched_at: now },
  });

  return json({ ok: true, id, status: "running", compiled_prompt_hash: compiledPromptHash, prompt_version: promptVersion });
}

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/pause | /resume | /cancel
// ---------------------------------------------------------------------------
const OP_TARGET_STATUS: Record<"pause" | "resume" | "cancel", string> = {
  pause: "pausing",
  resume: "running",
  cancel: "cancelling",
};

async function controlCampaign(env: Env, uid: string, id: string, op: "pause" | "resume" | "cancel"): Promise<Response> {
  const row = await loadOwnedCampaign(env, id, uid);
  if (row === null) return json({ error: "not found" }, 404);
  if (row === "forbidden") return json({ error: "forbidden" }, 403);

  // Coarse legality check — the DO/CallFSM own the fine-grained rules (§6.6);
  // this route just refuses obviously-nonsensical requests (e.g. resuming a
  // completed campaign) before bothering the DO.
  const terminal = row.status === "completed" || row.status === "cancelled";
  if (terminal) return json({ error: `campaign is already ${row.status}` }, 409);
  if (op === "resume" && row.status !== "paused" && row.status !== "window_wait" && row.status !== "out_of_tokens") {
    return json({ error: `cannot resume from status '${row.status}'` }, 409);
  }
  if (op === "pause" && row.status !== "running") {
    return json({ error: `cannot pause from status '${row.status}'` }, 409);
  }

  const targetStatus = OP_TARGET_STATUS[op];
  try {
    await metaDb(env).prepare(`UPDATE campaigns SET status=?1 WHERE id=?2`).bind(targetStatus, id).run();
  } catch (e) {
    return json({ error: `${op} failed`, detail: String(e).slice(0, 200) }, 500);
  }

  try {
    const stub = campaignDoStub(env, id);
    if (stub) {
      await stub.fetch(`https://c/${op}`, { method: "POST" });
    }
  } catch { /* best-effort — D1 status change is the source of truth */ }

  return json({ ok: true, id, status: targetStatus });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id
// ---------------------------------------------------------------------------
async function getCampaign(env: Env, uid: string, id: string): Promise<Response> {
  const row = await loadOwnedCampaign(env, id, uid);
  if (row === null) return json({ error: "not found" }, 404);
  if (row === "forbidden") return json({ error: "forbidden" }, 403);
  return json({ ok: true, campaign: campaignSummary(row) });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns — list owner's campaigns
// ---------------------------------------------------------------------------
async function listCampaigns(env: Env, uid: string): Promise<Response> {
  const { results } = await metaDb(env)
    .prepare(`SELECT * FROM campaigns WHERE uid=?1 ORDER BY created_at DESC LIMIT 200`)
    .bind(uid)
    .all<CampaignRow>();
  return json({ ok: true, campaigns: (results ?? []).map(campaignSummary) });
}

// ---------------------------------------------------------------------------
// Dispatcher — mount at /api/campaigns (wiring agent's job; NOT done here per
// the task scope — see the report for the exact mount instructions).
// ---------------------------------------------------------------------------
export async function campaignsRoute(req: Request, env: Env, path: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const gated = await gate(env, ctx.uid);
  if (gated) return json({ error: gated.error }, gated.status);

  const rest = path.slice("/api/campaigns".length).replace(/^\/+/, ""); // "" | "<id>" | "<id>/launch" | ...
  const parts = rest.split("/").filter(Boolean);

  if (parts.length === 0) {
    if (req.method === "POST") return await createCampaign(req, env, ctx.uid);
    if (req.method === "GET") return await listCampaigns(env, ctx.uid);
    return json({ error: "method not allowed" }, 405);
  }

  const id = decodeURIComponent(parts[0]);
  const action = parts[1] || "";

  if (!action) {
    if (req.method === "GET") return await getCampaign(env, ctx.uid, id);
    return json({ error: "method not allowed" }, 405);
  }

  if (req.method === "POST" && action === "launch") return await launchCampaign(env, ctx.uid, id);
  if (req.method === "POST" && (action === "pause" || action === "resume" || action === "cancel")) {
    return await controlCampaign(env, ctx.uid, id, action);
  }

  return json({ error: "not found" }, 404);
}

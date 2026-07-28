// [DYNW-CORE-1] dyn_modules registry — the ONLY module allowed to read/write the
// dyn_modules table (Specs/PROPOSAL-DYNAMIC-WORKERS-2026-07-28.md §2.2).
//
// Hardening contract (owner-required, 2026-07-28):
//   • Size limit        — source > dynModuleMaxBytes (config, default 128 KB) is rejected
//                         at save AND re-checked at load.
//   • Owner authz       — saves require requester === owner_uid (admin may save
//                         first-party rows with owner_uid = null); owner-scoped loads
//                         verify the requesting uid matches owner_uid.
//   • Immutable + hash  — rows are never UPDATEd (source is INSERT-only; a change is a
//                         new code_id). Every load recomputes sha256 and refuses to run
//                         on mismatch, auto-disabling the row (tamper evidence).
//   • Lifecycle         — draft → pending_review → active → disabled. Only `active`
//                         loads. Rows are never DELETEd (audit trail).
import type { Env } from "../../types";
import { readConfig } from "../../routes/config";

export type DynModuleStatus = "draft" | "pending_review" | "active" | "disabled";

export interface DynModuleRow {
  code_id: string;
  area: string;
  owner_uid: string | null;
  source: string;
  sha256: string;
  status: DynModuleStatus;
  size_bytes: number;
  created_at: number;
  activated_at: number | null;
  activated_by: string | null;
}

let tableReady = false;
async function ensureTable(env: Env): Promise<void> {
  if (tableReady) return;
  await env.DB_META.prepare(
    `CREATE TABLE IF NOT EXISTS dyn_modules (
       code_id TEXT PRIMARY KEY,
       area TEXT NOT NULL,
       owner_uid TEXT,
       source TEXT NOT NULL,
       sha256 TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'draft',
       size_bytes INTEGER NOT NULL,
       created_at INTEGER NOT NULL,
       activated_at INTEGER,
       activated_by TEXT
     )`,
  ).run();
  tableReady = true;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type SaveResult =
  | { ok: true; code_id: string; sha256: string }
  | { ok: false; error: "too_large" | "not_owner" | "bad_area" | "exists" };

/**
 * Save a new module as `draft`. Immutable: saving identical (area, owner, source)
 * again returns the existing code_id; a changed source is a NEW code_id.
 */
export async function saveModule(
  env: Env,
  input: { area: string; ownerUid: string | null; source: string; requesterUid: string; requesterIsAdmin: boolean },
): Promise<SaveResult> {
  await ensureTable(env);
  if (!/^[a-z0-9_]{2,32}$/.test(input.area)) return { ok: false, error: "bad_area" };
  // Owner authz: a user may only save modules they own; only admins may save
  // first-party (owner_uid = null) rows.
  if (input.ownerUid === null) {
    if (!input.requesterIsAdmin) return { ok: false, error: "not_owner" };
  } else if (input.ownerUid !== input.requesterUid && !input.requesterIsAdmin) {
    return { ok: false, error: "not_owner" };
  }
  const size = new TextEncoder().encode(input.source).byteLength;
  const cfg = await readConfig(env);
  if (size > cfg.dynModuleMaxBytes) return { ok: false, error: "too_large" };

  const sha = await sha256Hex(input.source);
  const codeId = `${input.area}:${input.ownerUid ?? "platform"}:${sha.slice(0, 16)}`;
  const existing = await env.DB_META.prepare("SELECT code_id FROM dyn_modules WHERE code_id=?1")
    .bind(codeId).first<{ code_id: string }>();
  if (existing) return { ok: true, code_id: codeId, sha256: sha }; // idempotent re-save
  await env.DB_META.prepare(
    `INSERT INTO dyn_modules (code_id, area, owner_uid, source, sha256, status, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7)`,
  ).bind(codeId, input.area, input.ownerUid, input.source, sha, size, Date.now()).run();
  return { ok: true, code_id: codeId, sha256: sha };
}

const TRANSITIONS: Record<DynModuleStatus, DynModuleStatus[]> = {
  draft: ["pending_review", "disabled"],
  pending_review: ["active", "disabled"],
  active: ["disabled"],
  disabled: [], // disabled is terminal; re-enable = save + review a new code_id
};

export async function setStatus(
  env: Env,
  codeId: string,
  to: DynModuleStatus,
  by: string,
): Promise<{ ok: boolean; error?: string }> {
  await ensureTable(env);
  const row = await env.DB_META.prepare("SELECT status FROM dyn_modules WHERE code_id=?1")
    .bind(codeId).first<{ status: DynModuleStatus }>();
  if (!row) return { ok: false, error: "not_found" };
  if (!TRANSITIONS[row.status]?.includes(to)) return { ok: false, error: `bad_transition:${row.status}->${to}` };
  if (to === "active") {
    await env.DB_META.prepare(
      "UPDATE dyn_modules SET status='active', activated_at=?2, activated_by=?3 WHERE code_id=?1",
    ).bind(codeId, Date.now(), by).run();
  } else {
    await env.DB_META.prepare("UPDATE dyn_modules SET status=?2 WHERE code_id=?1")
      .bind(codeId, to).run();
  }
  return { ok: true };
}

export type LoadResult =
  | { ok: true; row: DynModuleRow }
  | { ok: false; error: "not_found" | "not_active" | "not_owner" | "too_large" | "sha_mismatch" };

/**
 * Load an ACTIVE module for execution. Fail-closed on every check; a sha mismatch
 * additionally disables the row (immutability was violated ⇒ never run it again).
 */
export async function loadActive(
  env: Env,
  codeId: string,
  opts: { requesterUid?: string } = {},
): Promise<LoadResult> {
  await ensureTable(env);
  const row = await env.DB_META.prepare("SELECT * FROM dyn_modules WHERE code_id=?1")
    .bind(codeId).first<DynModuleRow>();
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "active") return { ok: false, error: "not_active" };
  if (row.owner_uid !== null && opts.requesterUid !== undefined && row.owner_uid !== opts.requesterUid) {
    return { ok: false, error: "not_owner" };
  }
  const cfg = await readConfig(env);
  if (row.size_bytes > cfg.dynModuleMaxBytes) return { ok: false, error: "too_large" };
  const sha = await sha256Hex(row.source);
  if (sha !== row.sha256) {
    // Tamper evidence: refuse and kill the row. (No UPDATE of source ever happens
    // through this module, so a mismatch means out-of-band DB modification.)
    await env.DB_META.prepare("UPDATE dyn_modules SET status='disabled' WHERE code_id=?1")
      .bind(codeId).run();
    return { ok: false, error: "sha_mismatch" };
  }
  return { ok: true, row };
}

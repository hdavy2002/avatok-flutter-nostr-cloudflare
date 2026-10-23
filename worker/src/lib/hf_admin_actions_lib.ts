// [HF-ADMIN-COMPLETE-1] Small shared helpers for the admin desk (lists and actions): tolerant queries, the action timeline, report -> member lookup.
import type { Env } from "../types";

const n = (v: unknown) => Number(v ?? 0) || 0;
export type ReviewState = "reviewed" | "actioned" | "closed" | "open";
type Kind = "ticket" | "report" | "incident" | "member";

/** A query that may hit a table an older database does not have yet: absent means empty, never a 500. */
export async function rows<T = Record<string, any>>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try { return ((await env.DB_META.prepare(sql).bind(...binds).all<T>()).results ?? []) as T[]; } catch { return []; }
}
export async function one<T = Record<string, any>>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try { return (await env.DB_META.prepare(sql).bind(...binds).first<T>()) ?? null; } catch { return null; }
}

export interface ActionRow { id: string; subject_type: string; subject_id: string; action: string; body: string | null; channel: string | null; admin_uid: string; created_at: number }
export const actionOut = (a: ActionRow) => ({ id: a.id, action: a.action, body: a.body, channel: a.channel, adminUid: a.admin_uid, at: n(a.created_at) });

export async function actionsFor(env: Env, type: Kind, ids: string[]): Promise<Map<string, ReturnType<typeof actionOut>[]>> {
  const out = new Map<string, ReturnType<typeof actionOut>[]>();
  if (!ids.length) return out;
  const ph = ids.map((_, i) => `?${i + 2}`).join(",");
  const list = await rows<ActionRow>(env, `SELECT * FROM hf_admin_actions WHERE subject_type=?1 AND subject_id IN (${ph}) ORDER BY created_at ASC, rowid ASC LIMIT 500`, type, ...ids);
  for (const a of list) { const l = out.get(a.subject_id) ?? []; l.push(actionOut(a)); out.set(a.subject_id, l); }
  return out;
}
/** Review state of a subject with no status column of its own (a call incident): the newest review-type action wins. */
export function reviewStateOf(actions: { action: string }[] | undefined): ReviewState {
  for (let i = (actions?.length ?? 0) - 1; i >= 0; i--) {
    const a = actions![i].action;
    if (a === "reviewed" || a === "actioned" || a === "closed" || a === "open") return a;
  }
  return "open";
}

/** Best-effort: who a free-text /report form was about. Profile text first (slug, name, @username), then the call's other party. */
export async function reportedMember(env: Env, profile: string, callRef: string, reporterUid: string | null): Promise<{ uid: string; name: string | null } | null> {
  const p = profile.trim().replace(/^@/, "").toLowerCase();
  if (p.length >= 2) {
    const h = await one<{ uid: string; name: string | null }>(env, "SELECT uid, display_name AS name FROM hf_hosts WHERE lower(slug)=?1 OR lower(display_name)=?1 LIMIT 1", p);
    if (h) return h;
    const r = await one<{ uid: string; name: string | null }>(env, "SELECT uid, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM hf_user_registration WHERE lower(username)=?1 LIMIT 1", p);
    if (r) return r;
  }
  const c = callRef ? await one<{ caller_uid: string; host_uid: string }>(env, "SELECT caller_uid, host_uid FROM hf_calls WHERE id=?1", callRef.trim()) : null;
  if (c) {
    const uid = reporterUid && reporterUid === c.host_uid ? c.caller_uid : c.host_uid;
    return { uid, name: null };
  }
  return null;
}


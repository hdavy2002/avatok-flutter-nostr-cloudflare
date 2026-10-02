// [AUMFE-PREVIEW-GATE-1] One definition of "previewer": everything new (voice guides, wallet UI, home ad band, Explore
// guides, new help topics, new legal sections) stays hidden from customers until a payment gateway approves the site.
// Only uids on ADMIN_UIDS / AGENT_ADMIN_UIDS see it, until the owner flips the public switch `guidesPublic`.
import type { Env } from "../types";
import { readConfig } from "../routes/config";
import { parseUidList } from "./voice_agents/session_logic";

/** Comma/space separated ADMIN_UIDS + AGENT_ADMIN_UIDS, joined for APIs that take one raw list. */
export function previewerUidsRaw(env: Env): string {
  return [env.ADMIN_UIDS, env.AGENT_ADMIN_UIDS].filter(Boolean).join(",");
}

export function isAdminUid(env: Env, uid: string): boolean {
  return !!uid && parseUidList(env.ADMIN_UIDS).includes(uid);
}

export function isPreviewer(env: Env, uid: string): boolean {
  if (!uid) return false;
  return parseUidList(previewerUidsRaw(env)).includes(uid);
}

/** Public once guidesPublic is on; before that only previewers (signed-in) see the new surfaces. */
export async function canSeeGuides(env: Env, uid: string | null): Promise<boolean> {
  const cfg = await readConfig(env);
  if (cfg.guidesPublic === true) return true;
  return !!uid && isPreviewer(env, uid);
}

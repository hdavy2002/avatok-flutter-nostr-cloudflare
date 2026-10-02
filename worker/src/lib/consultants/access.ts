// [AUMFE-CONSULT-FOUNDATION-1] Who may see / use Real Consultants. Same preview gate as the voice guides:
// while `consultantsEnabled` is false only previewers (ADMIN_UIDS / AGENT_ADMIN_UIDS) see anything.
import type { Env } from "../../types";
import { readConfig } from "../../routes/config";
import { isPreviewer, isAdminUid } from "../preview";

export async function consultVisible(env: Env, uid: string | null): Promise<boolean> {
  const cfg = await readConfig(env);
  if (cfg.consultantsEnabled === true) return true;
  return !!uid && isPreviewer(env, uid);
}
export function isConsultAdmin(env: Env, uid: string): boolean { return isAdminUid(env, uid); }
/** Previewers see seed reviews (labelled `seed`); everyone else never does. */
export function seesSeed(env: Env, uid: string | null): boolean { return !!uid && isPreviewer(env, uid); }

// [AUMFE-PREVIEW-GATE-1] GET /api/me/preview — what may this visitor see of the hidden-until-gateway surfaces?
// Auth is OPTIONAL and the route never 401s: signed-out (or a bad token) simply answers all-false.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { readConfig } from "./config";
import { isAdminUid, isPreviewer } from "../lib/preview";

export async function mePreview(req: Request, env: Env): Promise<Response> {
  let uid = "";
  if (req.headers.get("authorization")) {
    try {
      const u = await requireUser(req, env);
      if (!isFail(u)) uid = u.uid;
    } catch { /* signed-out view */ }
  }
  const preview = isPreviewer(env, uid);
  let guidesPublic = false;
  try { guidesPublic = (await readConfig(env)).guidesPublic === true; } catch { /* default closed */ }
  return json({ preview, guides: guidesPublic || preview, admin: isAdminUid(env, uid) }, 200, { "cache-control": "private, no-store" });
}

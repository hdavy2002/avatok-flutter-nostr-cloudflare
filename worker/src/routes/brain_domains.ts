// GET /api/brain/domains — the BRAIN_DOMAINS registry as a wire contract
// (SPEC §3). Authenticated: the Settings UI is generated from this, so a toggle
// can never gate nothing and a capability can never exist without a toggle.
//
// Response: { domains: [{ key, consentKey, basis, deletable, label, default, scope }] }
// basis/deletable (§10.1) let the client render legal-basis rows (consentKey null) as
// a disclosure instead of a switch, and exclude them from delete-my-data.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { brainDomainList } from "../lib/brain_domains";

export async function brainDomains(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  return json({ domains: brainDomainList() });
}

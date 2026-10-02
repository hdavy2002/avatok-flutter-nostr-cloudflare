// [AUMFE-CONSULT-FOUNDATION-1] WebSocket entry (/api/consultants/ws?ticket=...) → ConsultCallDO. Lane W3 fills it.
import type { Env } from "../../types";
import { json } from "../../util";

export async function consultWs(_req: Request, _env: Env): Promise<Response> {
  return json({ error: "not_implemented" }, 501);
}

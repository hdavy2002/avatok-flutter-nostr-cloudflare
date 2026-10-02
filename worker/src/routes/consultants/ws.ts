// [AUMFE-CONSULT-W3-1 2026-10-02] GET /api/consultants/ws?ticket=  (Upgrade: websocket) -> ConsultCallDO.
// Consumes the single-use ticket minted by call.ts; the uid/role the DO trusts come from headers THIS worker sets from the ticket.
import type { Env } from "../../types";
import { trackException } from "../../hooks";
import { CONSULT_TICKET_PREFIX, type ConsultTicketRec } from "./call";

export const CONSULT_HDR_UID = "x-consult-uid";
export const CONSULT_HDR_ROLE = "x-consult-role";
export const CONSULT_HDR_BOOKING = "x-consult-booking";

export async function consultWs(req: Request, env: Env): Promise<Response> {
  const ticket = new URL(req.url).searchParams.get("ticket") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ticket)) return new Response("ticket required", { status: 400 });
  const key = CONSULT_TICKET_PREFIX + ticket;
  let rec: ConsultTicketRec | null = null;
  try {
    rec = (await env.TOKENS.get(key, "json")) as ConsultTicketRec | null;
    await env.TOKENS.delete(key); // single use, valid or not
  } catch (e) {
    await trackException(env, e, { route: "/api/consultants/ws", handled: true, app_name: "aumfe_consult" });
    return new Response("ticket check failed", { status: 503 });
  }
  if (!rec || !rec.booking_id || !rec.uid || (rec.role !== "customer" && rec.role !== "consultant") || Date.now() - Number(rec.ts) > 90_000) {
    return new Response("ticket invalid or expired", { status: 401 });
  }
  const headers = new Headers(req.headers);
  headers.delete(CONSULT_HDR_UID); headers.delete(CONSULT_HDR_ROLE); headers.delete(CONSULT_HDR_BOOKING);
  headers.set(CONSULT_HDR_UID, rec.uid);
  headers.set(CONSULT_HDR_ROLE, rec.role);
  headers.set(CONSULT_HDR_BOOKING, rec.booking_id);
  const stub = env.CONSULT_CALL.get(env.CONSULT_CALL.idFromName(rec.booking_id));
  return stub.fetch(new Request(req, { headers }));
}

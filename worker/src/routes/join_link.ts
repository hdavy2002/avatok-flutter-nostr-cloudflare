// [JOIN-LINK-1] POST /api/join-link/:token/session
//
// THE RULE (owner, 2026-09-12; RULEBOOK-PAID-SESSIONS §7): a customer who clicks
// the link in his booking/ticket email must NOT be asked to log in. The link
// itself carries his identity and drops him straight into the room. Arriving at a
// bare /live/:id or /session/:id from anywhere else still meets the email-code
// gate — that half is unchanged and lives in the web islands.
//
// WHAT THIS ENDPOINT DOES
//   1. verifies the v2 join token (cal/ics.ts) — HMAC over
//      { v:2, b:bookingId|null, l:listingId, u:accountId, k:kind, exp }
//   2. re-checks the LIVE state behind it: the booking must not be cancelled and
//      the `commercial_entitlements` row for (kind, listing, booking, account)
//      must still be one of reserved/held/active/consumed
//   3. mints a Clerk sign-in ticket for THAT account (lib/clerk_ticket.ts) — the
//      browser redeems it into exactly the session the email-code gate would
//      have produced
//   4. answers with the canonical room path for the kind
//
// NOT SINGLE-USE, DELIBERATELY. The owner's rule is that the same emailed link
// works on his phone and then again on his laptop. Security therefore does not
// rest on the token being spent: it rests on (a) the signature, (b) the account
// binding, (c) the expiry — session end + 24 h — and (d) step 2, which is
// re-evaluated on every call. A refunded ticket stops working the moment the
// refund lands, however many valid signatures are in the customer's inbox.
//
// 410 vs 404. 410 means "this WAS your link and it is over" (expired, cancelled,
// refunded, revoked) — the web page answers it with "sign in to see your
// bookings". 404 means the token is not ours at all.
import type { Env } from "../types";
import { json } from "../util";
import { metaDb } from "../db/shard";
import { verifyJoinTokenClaims } from "../cal/ics";
import { mintClerkSignInTicket, maskEmail } from "../lib/clerk_ticket";
import { clerkEmail } from "../ledger";
import { commercialEvent } from "../lib/commercial_telemetry";

const JOIN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Booking states that mean "there is nothing left to walk into". */
const DEAD_BOOKING = new Set(["cancelled", "canceled", "refunded", "expired", "declined", "rejected"]);
/** Entitlement states that still admit their holder (mirrors entitlement() in commercial_stream_sessions.ts). */
const LIVE_ENTITLEMENT = new Set(["reserved", "held", "active", "consumed"]);

type Kind = "live_event" | "consult_1to1";

interface Resolved {
  kind: Kind;
  listingId: string;
  bookingId: string | null;
  accountId: string;
  endsAt: number | null;
}

function destinationFor(r: Resolved): { kind: "live" | "consult"; path: string } | null {
  if (r.kind === "live_event") return { kind: "live", path: `/live/${encodeURIComponent(r.listingId)}` };
  if (!r.bookingId) return null;
  return { kind: "consult", path: `/session/${encodeURIComponent(r.bookingId)}` };
}

export async function joinLinkSession(req: Request, env: Env, token: string): Promise<Response> {
  const claims = await verifyJoinTokenClaims(env, token, { allowExpired: true });
  if (!claims) return json({ error: "invalid link", reason: "invalid" }, 404);
  if (claims.exp && Date.now() > claims.exp) {
    return json({ error: "this link has expired", reason: "expired" }, 410);
  }

  // ── resolve the four facts, from the token (v2) or the booking row (v1) ──
  let resolved: Resolved | null = null;
  if (claims.version === 2 && claims.listingId && claims.accountId && claims.kind) {
    resolved = {
      kind: claims.kind, listingId: claims.listingId,
      bookingId: claims.bookingId, accountId: claims.accountId, endsAt: null,
    };
  }
  if (claims.bookingId) {
    const bk = await metaDb(env).prepare(
      "SELECT id, listing_id, buyer_id, kind, ends_at, status FROM bookings WHERE id=?1",
    ).bind(claims.bookingId).first<{
      id: string; listing_id: string | null; buyer_id: string; kind: string | null;
      ends_at: number | null; status: string | null;
    }>();
    if (!bk) return json({ error: "not found", reason: "invalid" }, 404);
    if (DEAD_BOOKING.has(String(bk.status ?? "").toLowerCase())) {
      return json({ error: "this booking is no longer active", reason: "cancelled" }, 410);
    }
    // A v1 token names only the booking. Everything else comes from the row,
    // and the account is the BUYER — never a uid supplied by the caller.
    resolved = {
      kind: (resolved?.kind ?? (bk.kind === "live_event" ? "live_event" : "consult_1to1")) as Kind,
      listingId: resolved?.listingId ?? String(bk.listing_id ?? ""),
      bookingId: bk.id,
      accountId: resolved?.accountId ?? bk.buyer_id,
      endsAt: typeof bk.ends_at === "number" ? bk.ends_at : null,
    };
    // A v2 token must agree with the row it claims — a signature is not a licence
    // to point at somebody else's booking.
    if (claims.version === 2 && claims.accountId && claims.accountId !== bk.buyer_id) {
      return json({ error: "not your booking", reason: "invalid" }, 404);
    }
  }
  if (!resolved || !resolved.listingId || !resolved.accountId) {
    return json({ error: "invalid link", reason: "invalid" }, 404);
  }

  // ── the live entitlement, re-checked on every open ──────────────────────
  const grant = await metaDb(env).prepare(
    `SELECT entitlement_id, state, ends_at FROM commercial_entitlements
      WHERE kind=?1 AND listing_id=?2 AND COALESCE(booking_id,'')=COALESCE(?3,'')
        AND account_id=?4 AND role IN ('viewer','buyer')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(resolved.kind, resolved.listingId, resolved.bookingId ?? null, resolved.accountId)
    .first<{ entitlement_id: string; state: string; ends_at: number | null }>();
  if (!grant) return json({ error: "no ticket on this link", reason: "no_entitlement" }, 410);
  if (!LIVE_ENTITLEMENT.has(String(grant.state))) {
    return json({ error: "this ticket was cancelled or refunded", reason: "cancelled" }, 410);
  }

  // Independent of the token's own exp: an old link cannot outlive its session
  // by more than the grace window even if it was signed with a longer expiry.
  const endsAt = resolved.endsAt ?? (typeof grant.ends_at === "number" ? grant.ends_at : null);
  if (endsAt && Date.now() > endsAt + JOIN_GRACE_MS) {
    return json({ error: "this link has expired", reason: "expired" }, 410);
  }

  const destination = destinationFor(resolved);
  if (!destination) return json({ error: "invalid link", reason: "invalid" }, 404);

  const mint = await mintClerkSignInTicket(env, resolved.accountId);
  if (!mint.ok) {
    return json({ error: "could not start your session", reason: mint.reason },
      mint.reason === "unconfigured" ? 503 : 502);
  }

  const email = await clerkEmail(env, resolved.accountId).catch(() => null);
  commercialEvent(env, "join_link", resolved.accountId, {
    kind: destination.kind,
    token_version: claims.version,
    listing_id: resolved.listingId,
    booking_id: resolved.bookingId ?? "",
    outcome: "joined",
  });

  return json({
    // Named for what it is. It is NOT a session JWT — the Worker holds no Clerk
    // signing key (see lib/clerk_ticket.ts) — it is Clerk's own one-shot ticket,
    // redeemed in the browser into the same session the email-code gate mints.
    ticket: mint.ticket,
    ticket_kind: "clerk_sign_in_token",
    destination: destination.path,
    destination_kind: destination.kind,
    account_email_masked: maskEmail(email),
  }, 200, { "cache-control": "no-store" });
}

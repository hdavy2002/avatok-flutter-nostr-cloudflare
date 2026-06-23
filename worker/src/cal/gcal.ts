// Phase 5 — Google Calendar two-way sync (per-account OAuth).
//   Outbound: every confirmed block/booking → insert/patch/delete a gcal event,
//             marked with extendedProperties.private.avatok="1" (loop guard).
//   Inbound:  events.list with an incremental syncToken (webhook channel or the
//             15-min consumers cron calls importGcal) → busy gcal events become
//             source_app='gcal' calendar_blocks ⇒ external meetings grey out
//             platform slots.
// Refresh tokens are AES-GCM-encrypted with the GCAL_TOKEN_KEY secret in D1.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";

const GAUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GTOKEN = "https://oauth2.googleapis.com/token";
const GCAL = "https://www.googleapis.com/calendar/v3";
// One Google connection grants Calendar (booking sync) + Drive (drive.file =
// only files AvaTOK creates → the "AvaTOK" folder). The same access token serves
// both APIs; gcalAccessToken() is reused by lib/drive.ts. (Hybrid storage:
// own files → Drive; shared chat media stays on encrypted R2.)
const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.file";
const REDIRECT = "https://api.avatok.ai/api/calendar/gcal/callback";

// ---------------------------------------------------------------------------
// Token crypto — AES-GCM with key derived (SHA-256) from GCAL_TOKEN_KEY.
// ---------------------------------------------------------------------------
async function aesKey(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.GCAL_TOKEN_KEY || "dev-gcal-key"));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encToken(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(plain)));
  const all = new Uint8Array(iv.length + ct.length); all.set(iv); all.set(ct, 12);
  return btoa(String.fromCharCode(...all));
}
export async function decToken(env: Env, b64: string): Promise<string> {
  const all = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await aesKey(env), all.slice(12));
  return new TextDecoder().decode(pt);
}

// HMAC state for the OAuth round-trip (uid → callback, 10-min expiry).
async function hmacHex(env: Env, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GCAL_TOKEN_KEY || "dev-gcal-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** GET /api/calendar/gcal/connect → { url } the app opens in a browser. */
export async function gcalConnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "gcal not configured" }, 503);
  const exp = Date.now() + 600_000;
  // `?return=app` (AvaStorage Drive connect via flutter_web_auth_2) tags the
  // state with `.app` so the callback redirects to avatokauth:// (the in-app
  // auth sheet auto-closes). The HMAC still signs only uid+exp, so the extra
  // segment doesn't affect verification. Without it (AvaCalendar web connect)
  // the callback keeps showing the "you can close this window" page.
  const wantApp = new URL(req.url).searchParams.get("return") === "app";
  const sig = await hmacHex(env, ctx.uid + "." + exp);
  const state = `${ctx.uid}.${exp}.${sig}${wantApp ? ".app" : ""}`;
  const u = new URL(GAUTH);
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");          // always get a refresh_token
  u.searchParams.set("include_granted_scopes", "true"); // incremental consent
  u.searchParams.set("state", state);
  return json({ url: u.toString() });
}

/** GET /api/calendar/gcal/callback?code&state — browser redirect target. */
export async function gcalCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const [uid, expS, sig, flow] = state.split(".");
  const isApp = flow === "app"; // AvaStorage Drive connect → deep-link back
  // App flow auto-closes its in-app auth sheet via this deep link; the web
  // (calendar) flow renders an HTML page the user closes manually.
  const back = (err?: string) =>
    isApp
      ? new Response(null, {
          status: 302,
          headers: { Location: `avatokauth://drive-connected${err ? `?error=${err}` : ""}` },
        })
      : null;
  if (!uid || !sig || Number(expS) < Date.now() || sig !== await hmacHex(env, uid + "." + expS)) {
    return back("invalid_link") ??
      new Response("Invalid or expired link. Reopen from AvaCalendar settings.", { status: 400 });
  }
  const tr = await fetch(GTOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  if (!tr.ok) return back("token_exchange") ?? new Response("Google token exchange failed.", { status: 502 });
  const t = (await tr.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!t.refresh_token) return back("no_refresh") ?? new Response("No refresh token granted — disconnect AvaTOK in your Google account settings and retry.", { status: 400 });
  await metaDb(env).prepare(
    `INSERT INTO gcal_accounts (user_id, refresh_token_enc, access_token, access_expires_at, connected_at)
     VALUES (?1,?2,?3,?4,?5)
     ON CONFLICT(user_id) DO UPDATE SET refresh_token_enc=?2, access_token=?3, access_expires_at=?4, connected_at=?5, sync_token=NULL`,
  ).bind(uid, await encToken(env, t.refresh_token), t.access_token, Date.now() + (t.expires_in - 60) * 1000, Date.now()).run();
  try { await importGcal(env, uid); } catch { /* first import is best-effort */ }
  return back() ??
    new Response("<html><body style='font-family:system-ui;text-align:center;padding-top:80px'><h2>Google Calendar connected ✅</h2><p>You can close this window and return to AvaTOK.</p></body></html>",
      { headers: { "content-type": "text/html" } });
}

/** GET /api/calendar/gcal/status · DELETE /api/calendar/gcal */
export async function gcalStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await metaDb(env).prepare("SELECT connected_at, last_sync_at FROM gcal_accounts WHERE user_id=?1").bind(ctx.uid).first();
  return json({ connected: !!row, ...(row ?? {}) });
}
export async function gcalDisconnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  await metaDb(env).prepare("DELETE FROM gcal_accounts WHERE user_id=?1").bind(ctx.uid).run();
  await metaDb(env).prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal'").bind(ctx.uid).run();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Access tokens (refresh flow, cached in the row)
// ---------------------------------------------------------------------------
export async function gcalAccessToken(env: Env, uid: string): Promise<string | null> {
  const row = await metaDb(env).prepare(
    "SELECT refresh_token_enc, access_token, access_expires_at FROM gcal_accounts WHERE user_id=?1",
  ).bind(uid).first<{ refresh_token_enc: string; access_token: string | null; access_expires_at: number | null }>();
  if (!row) return null;
  if (row.access_token && (row.access_expires_at ?? 0) > Date.now()) return row.access_token;
  const r = await fetch(GTOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: await decToken(env, row.refresh_token_enc), client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: "refresh_token" }),
  });
  if (!r.ok) return null;
  const t = (await r.json()) as { access_token: string; expires_in: number };
  await metaDb(env).prepare("UPDATE gcal_accounts SET access_token=?2, access_expires_at=?3 WHERE user_id=?1")
    .bind(uid, t.access_token, Date.now() + (t.expires_in - 60) * 1000).run();
  return t.access_token;
}

// ---------------------------------------------------------------------------
// Outbound — block/booking → gcal event (best-effort, never blocks the API path)
// ---------------------------------------------------------------------------
export async function gcalExport(env: Env, uid: string, blockId: string, action: "upsert" | "delete"): Promise<void> {
  const tok = await gcalAccessToken(env, uid);
  if (!tok) return;
  const blk = await metaDb(env).prepare(
    "SELECT id, title, starts_at, ends_at, status, gcal_event_id, source_app FROM calendar_blocks WHERE id=?1",
  ).bind(blockId).first<any>();
  if (!blk || blk.source_app === "gcal") return; // never re-export imports
  const hdr = { Authorization: `Bearer ${tok}`, "content-type": "application/json" };
  if (action === "delete" || blk.status === "cancelled") {
    if (blk.gcal_event_id) await fetch(`${GCAL}/calendars/primary/events/${blk.gcal_event_id}`, { method: "DELETE", headers: hdr }).catch(() => {});
    return;
  }
  const body = JSON.stringify({
    summary: blk.title || "AvaTOK booking",
    start: { dateTime: new Date(blk.starts_at).toISOString() },
    end: { dateTime: new Date(blk.ends_at).toISOString() },
    extendedProperties: { private: { avatok: "1", block_id: blk.id } },  // loop guard
  });
  if (blk.gcal_event_id) {
    await fetch(`${GCAL}/calendars/primary/events/${blk.gcal_event_id}`, { method: "PATCH", headers: hdr, body }).catch(() => {});
  } else {
    const r = await fetch(`${GCAL}/calendars/primary/events`, { method: "POST", headers: hdr, body });
    if (r.ok) {
      const ev = (await r.json()) as { id: string };
      await metaDb(env).prepare("UPDATE calendar_blocks SET gcal_event_id=?2 WHERE id=?1").bind(blk.id, ev.id).run();
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound — gcal busy events → calendar_blocks (source_app='gcal').
// Incremental via sync_token; full window (now..+60d) on first run / 410.
// ---------------------------------------------------------------------------
export async function importGcal(env: Env, uid: string): Promise<number> {
  const tok = await gcalAccessToken(env, uid);
  if (!tok) return 0;
  const acct = await metaDb(env).prepare("SELECT sync_token FROM gcal_accounts WHERE user_id=?1").bind(uid).first<{ sync_token: string | null }>();
  let pageToken: string | undefined;
  let syncToken = acct?.sync_token ?? null;
  let imported = 0;

  for (let page = 0; page < 10; page++) {
    const u = new URL(`${GCAL}/calendars/primary/events`);
    u.searchParams.set("singleEvents", "true");
    u.searchParams.set("maxResults", "250");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    else if (syncToken) u.searchParams.set("syncToken", syncToken);
    else {
      u.searchParams.set("timeMin", new Date().toISOString());
      u.searchParams.set("timeMax", new Date(Date.now() + 60 * 86_400_000).toISOString());
    }
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 410) { // expired sync token → restart full
      await metaDb(env).prepare("UPDATE gcal_accounts SET sync_token=NULL WHERE user_id=?1").bind(uid).run();
      syncToken = null; pageToken = undefined; continue;
    }
    if (!r.ok) break;
    const data = (await r.json()) as any;
    for (const ev of data.items ?? []) {
      if (ev.extendedProperties?.private?.avatok === "1") continue;       // loop guard: ours
      const refId = `gcal:${ev.id}`;
      if (ev.status === "cancelled") {
        await metaDb(env).prepare("UPDATE calendar_blocks SET status='cancelled' WHERE user_id=?1 AND source_app='gcal' AND source_ref=?2").bind(uid, refId).run();
        continue;
      }
      if (ev.transparency === "transparent") continue;                    // free, not busy
      const s = Date.parse(ev.start?.dateTime ?? (ev.start?.date ? ev.start.date + "T00:00:00Z" : ""));
      const e = Date.parse(ev.end?.dateTime ?? (ev.end?.date ? ev.end.date + "T00:00:00Z" : ""));
      if (!(s > 0 && e > s)) continue;
      await metaDb(env).prepare(
        `INSERT INTO calendar_blocks (id, user_id, source_app, source_ref, starts_at, ends_at, title, status, created_at)
         VALUES (?1,?2,'gcal',?3,?4,?5,?6,'busy',?7)
         ON CONFLICT(id) DO UPDATE SET starts_at=?4, ends_at=?5, title=?6, status='busy'`,
      ).bind(`gcalblk:${uid}:${ev.id}`, uid, refId, s, e, ev.summary ?? "Google Calendar", Date.now()).run();
      imported++;
    }
    pageToken = data.nextPageToken;
    if (!pageToken) {
      if (data.nextSyncToken) await metaDb(env).prepare("UPDATE gcal_accounts SET sync_token=?2, last_sync_at=?3 WHERE user_id=?1").bind(uid, data.nextSyncToken, Date.now()).run();
      break;
    }
  }
  return imported;
}

/** POST /webhooks/gcal — push channel notification → import for that user. */
export async function gcalWebhook(req: Request, env: Env): Promise<Response> {
  const chan = req.headers.get("x-goog-channel-id");
  if (!chan) return json({ ok: true });
  const row = await metaDb(env).prepare("SELECT user_id FROM gcal_accounts WHERE channel_id=?1").bind(chan).first<{ user_id: string }>();
  if (row) { try { await importGcal(env, row.user_id); } catch { /* cron fallback covers */ } }
  return json({ ok: true });
}

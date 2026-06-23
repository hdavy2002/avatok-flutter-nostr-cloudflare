// AvaInvite — server-sent "invite a friend" email (2026-06-23).
//
// Companion to AvaReferral (routes/referral.ts). The Invite screen lets a user
// pick a phone contact and tap WhatsApp / SMS / Email. WhatsApp + SMS are device
// deep-links (the user taps Send in that app). EMAIL is the only channel that is
// truly auto-sent from the server, on behalf of the user:
//
//   • Sender stays the VERIFIED Brevo address (noreply@avatok.ai) so deliverability
//     holds, but the display name reads "<Name> via AvaTOK".
//   • Reply-To is the INVITER's own email, so a reply reaches them, not us.
//   • The CTA link carries the inviter's @handle (kInviteBase + handle) so the
//     existing referral claim credits them when the invitee joins.
//
// SERVER-AUTHORITATIVE for identity: the inviter's handle + email are resolved
// server-side from the authenticated uid. The client only passes the recipient
// (to_email / to_name) and an optional display name for the greeting.
import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { metaDb } from "../db/shard";
import { clerkEmail } from "../ledger";
import { track, metric } from "../hooks";

const APP = "avareferral";
const DOWNLOAD_URL = "https://avatok.ai/download";
const INVITE_BASE = "https://avatok.ai/i/"; // mirrors app kInviteBase

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

function firstName(n: string): string {
  const t = (n || "").trim().split(/\s+/)[0];
  return t || "A friend";
}

function inviteHtml(inviterName: string, link: string): string {
  const who = esc(inviterName);
  return `
  <div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 12px">${who} is inviting you to join AvaTOK 👋</h2>
    <p style="margin:0 0 12px;line-height:1.5">AvaTOK is an AI-powered messenger. Ava, your in-chat
      assistant, watches for scams, can reply for you when you're away, and pulls up files mid-chat —
      and you can talk with up to 25 people at once.</p>
    <p style="margin:0 0 12px;line-height:1.5">${who} thought you'd like it. Tap below to join with their link:</p>
    <p style="margin:20px 0"><a href="${esc(link)}"
      style="background:#08C4C4;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Join ${who} on AvaTOK</a></p>
    <p style="color:#999;font-size:12px;margin-top:20px">Sent on behalf of ${who} via AvaTOK · reply to reach them directly.
      Don't want these? Just ignore this email.</p>
  </div>`;
}

// POST /api/invite/email  { to_email, to_name?, from_name? }
// Auth required. Sends ONE invite email to an arbitrary external address on the
// authenticated user's behalf. Best-effort delivery via Q_EMAIL → Brevo.
export async function inviteEmail(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);

  const b = (await req.json().catch(() => ({}))) as { to_email?: string; to_name?: string; from_name?: string };
  const toEmail = String(b.to_email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(toEmail)) return json({ ok: false, reason: "bad_email" }, 400);

  // Resolve the inviter's @handle (drives the referral credit) + a friendly name.
  const me = await metaDb(env)
    .prepare("SELECT handle FROM users WHERE uid=?1 LIMIT 1")
    .bind(ctx.uid)
    .first<{ handle: string }>();
  const handle = (me?.handle || "").replace(/^@/, "");
  const inviterName = firstName(String(b.from_name || "").trim() || handle || "A friend");
  const link = handle ? `${INVITE_BASE}${handle}` : DOWNLOAD_URL;

  // Reply-To = the inviter's own email (best-effort; omitted if Clerk lookup fails).
  let replyTo: { email: string; name?: string } | undefined;
  try {
    const email = await clerkEmail(env, ctx.uid);
    if (email) replyTo = { email, name: inviterName };
  } catch { /* best-effort */ }

  const subject = `${inviterName} is inviting you to join AvaTOK`;
  try {
    await env.Q_EMAIL.send({
      to: toEmail,
      subject,
      html: inviteHtml(inviterName, link),
      from: `${inviterName} via AvaTOK <noreply@avatok.ai>`,
      ...(replyTo ? { replyTo } : {}),
    });
  } catch (e) {
    return json({ ok: false, reason: "queue_failed", detail: String(e).slice(0, 120) }, 502);
  }

  // Telemetry so we can see invites-by-email per inviter (pull by uid/email).
  try {
    track(env, ctx.uid, "invite_sent", APP, { channel: "email", has_handle: !!handle });
    metric(env, "invite_sent_email", [1]);
  } catch { /* best-effort */ }

  return json({ ok: true, channel: "email" });
}

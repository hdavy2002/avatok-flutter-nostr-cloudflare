// Shared outbound-mail helper for the avatok.ai Pages Functions (web/src/pages/api/*).
//
// Policy: Cloudflare Email Service REST API first, Brevo transactional API as
// fallback — see Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md
// §3.4. This module is deliberately independent from consumers/src/email_provider.ts
// (Workers binding + D1 outbox); Pages Functions have no send_email binding, so
// this talks to Cloudflare over REST instead. Do not import from consumers/.
//
// Cloudflare REST API: POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
//   Auth:   Authorization: Bearer <CF_EMAIL_API_TOKEN>  (token scope: Account -> Email Sending: Edit)
//   Body:   { to, from: string | { address, name }, subject, html, text?,
//             reply_to?: string | { address, name }, headers? }
//   (Note the REST API uses snake_case `reply_to` and `from.address` — NOT
//   `from.email` — unlike the Workers binding, which is camelCase `replyTo`
//   and accepts a bare string for `from`. Verified against the Cloudflare
//   Email Service docs, 2026-09-11.)
//   Response: { success, errors: [{ code, message }], result: { delivered: [],
//              permanent_bounces: [], queued: [], message_id? } }
//   REST errors carry a numeric `code` and a machine-readable `message` key,
//   e.g. 429 10004 "email.sending.error.throttled", 500 10002
//   "email.sending.error.internal_server", 400 10200
//   "email.sending.error.email.too_big" (NOT the Workers-binding E_* codes).
//   Total message size limit is 5 MiB including base64 attachments.

export interface MailEnv {
  CF_ACCOUNT_ID?: string;
  CF_EMAIL_API_TOKEN?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_NAME?: string;
  BREVO_SENDER_EMAIL?: string;
  EMAIL_PROVIDER?: string;
}

export interface OutboundMail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Defaults to { name: BREVO_SENDER_NAME || "avaTOK", email: BREVO_SENDER_EMAIL || "hello@avatok.ai" }.
   *  The BREVO_* env var names stay as the source of truth for the default sender
   *  (rather than adding CF_SENDER_* vars) so this migration needs zero Pages
   *  dashboard changes beyond adding CF_ACCOUNT_ID / CF_EMAIL_API_TOKEN. */
  from?: { name: string; email: string };
  replyTo?: { email: string; name?: string };
  /** Extension beyond the minimal policy interface: careers-apply.ts needs to
   *  attach the applicant's resume to the internal notification. `content` is
   *  base64. Mapped to Cloudflare's `{ filename, content, type, disposition }`
   *  and Brevo's `{ name, content }` shapes inside each adapter. */
  attachments?: { filename: string; content: string; type?: string }[];
  /** Brevo-only analytics tags (preserves the pre-migration `tags` on Brevo sends). */
  tags?: string[];
}

export type MailResult =
  | { ok: true; provider: 'cloudflare' | 'brevo'; messageId: string | null; fallbackUsed: boolean }
  | { ok: false; provider: 'cloudflare' | 'brevo'; retryable: boolean; error: string; fallbackUsed: boolean };

const DEFAULT_SENDER_NAME = 'avaTOK';
const DEFAULT_SENDER_EMAIL = 'hello@avatok.ai';

function defaultSender(env: MailEnv): { name: string; email: string } {
  return {
    name: env.BREVO_SENDER_NAME || DEFAULT_SENDER_NAME,
    email: env.BREVO_SENDER_EMAIL || DEFAULT_SENDER_EMAIL,
  };
}

/** Cheap tag-strip so every outbound mail carries a text/plain part. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function logEvent(event: string, data: Record<string, unknown>) {
  console.error(JSON.stringify({ event, ...data }));
}

// ---------------------------------------------------------------------------
// Cloudflare adapter
// ---------------------------------------------------------------------------

interface CloudflareApiError {
  code: number | string;
  message: string;
}

// Cloudflare's documented REST limit is 5 MiB for the whole message. Anything
// bigger (e.g. an 8 MB resume, ~10.7 MB once base64-encoded) is routed straight
// to the fallback instead of uploading it to Cloudflare only to get a 400.
const CLOUDFLARE_MAX_BODY_BYTES = 5 * 1024 * 1024;

const PERMANENT_BOUNCE = 'permanent bounce';

function isCloudflareRetryable(httpStatus: number, errors: CloudflareApiError[]): boolean {
  if (httpStatus === 429 || httpStatus >= 500) return true;
  return errors.some((e) => {
    const m = String(e.message || '').toUpperCase();
    return m.includes('THROTTLED') || m.includes('RATE_LIMIT') || m.includes('DAILY_LIMIT') || m.includes('INTERNAL');
  });
}

async function sendViaCloudflare(
  msg: OutboundMail,
  env: MailEnv,
  fetchImpl: typeof fetch,
): Promise<MailResult> {
  if (!env.CF_ACCOUNT_ID || !env.CF_EMAIL_API_TOKEN) {
    return { ok: false, provider: 'cloudflare', retryable: true, error: 'Cloudflare not configured', fallbackUsed: false };
  }

  const sender = msg.from || defaultSender(env);
  const body: Record<string, unknown> = {
    to: msg.to,
    from: { address: sender.email, name: sender.name },
    subject: msg.subject,
    html: msg.html,
    text: msg.text ?? htmlToText(msg.html),
  };
  if (msg.replyTo) {
    body.reply_to = msg.replyTo.name
      ? { address: msg.replyTo.email, name: msg.replyTo.name }
      : msg.replyTo.email;
  }
  if (msg.attachments?.length) {
    body.attachments = msg.attachments.map((a) => ({
      content: a.content,
      filename: a.filename,
      type: a.type || 'application/octet-stream',
      disposition: 'attachment',
    }));
  }

  const payload = JSON.stringify(body);
  if (new TextEncoder().encode(payload).byteLength > CLOUDFLARE_MAX_BODY_BYTES) {
    return { ok: false, provider: 'cloudflare', retryable: false, error: 'Cloudflare message exceeds 5 MiB limit', fallbackUsed: false };
  }

  let res: Response;
  try {
    res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`,
          'content-type': 'application/json',
        },
        body: payload,
      },
    );
  } catch (err) {
    return {
      ok: false,
      provider: 'cloudflare',
      retryable: true,
      error: `Cloudflare network error: ${err instanceof Error ? err.message : 'unknown'}`,
      fallbackUsed: false,
    };
  }

  let data: { success?: boolean; errors?: CloudflareApiError[]; result?: { delivered?: string[]; permanent_bounces?: string[]; queued?: string[]; message_id?: string } } = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON body — fall through with an empty errors array; http status still drives retryable.
  }

  const errors = data.errors ?? [];

  if (!res.ok || data.success === false) {
    // A suppressed recipient (hard bounce / complaint on Cloudflare's list) is
    // a bounce, not a transport failure: never re-mail it through Brevo.
    if (errors.some((e) => /suppress/i.test(String(e.message || '')))) {
      return { ok: false, provider: 'cloudflare', retryable: false, error: PERMANENT_BOUNCE, fallbackUsed: false };
    }
    const first = errors[0];
    const error = first
      ? `Cloudflare ${res.status} ${first.code}: ${first.message}`
      : `Cloudflare ${res.status}: request failed`;
    return { ok: false, provider: 'cloudflare', retryable: isCloudflareRetryable(res.status, errors), error, fallbackUsed: false };
  }

  const permanentBounces = (data.result?.permanent_bounces ?? []).map((a) => String(a).toLowerCase());
  if (permanentBounces.includes(msg.to.toLowerCase())) {
    return { ok: false, provider: 'cloudflare', retryable: false, error: PERMANENT_BOUNCE, fallbackUsed: false };
  }

  return { ok: true, provider: 'cloudflare', messageId: data.result?.message_id ?? null, fallbackUsed: false };
}

// ---------------------------------------------------------------------------
// Brevo adapter (existing behaviour, ported as-is)
// ---------------------------------------------------------------------------

function isBrevoRetryable(httpStatus: number): boolean {
  return httpStatus === 429 || httpStatus >= 500;
}

async function sendViaBrevo(
  msg: OutboundMail,
  env: MailEnv,
  fetchImpl: typeof fetch,
): Promise<MailResult> {
  if (!env.BREVO_API_KEY) {
    return { ok: false, provider: 'brevo', retryable: false, error: 'Brevo not configured', fallbackUsed: false };
  }

  const sender = msg.from || defaultSender(env);
  const body: Record<string, unknown> = {
    sender,
    to: [{ email: msg.to }],
    subject: msg.subject,
    htmlContent: msg.html,
    textContent: msg.text ?? htmlToText(msg.html),
  };
  if (msg.replyTo) body.replyTo = msg.replyTo;
  if (msg.tags?.length) body.tags = msg.tags;
  if (msg.attachments?.length) {
    body.attachment = msg.attachments.map((a) => ({ name: a.filename, content: a.content }));
  }

  let res: Response;
  try {
    res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      provider: 'brevo',
      retryable: true,
      error: `Brevo network error: ${err instanceof Error ? err.message : 'unknown'}`,
      fallbackUsed: false,
    };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const data: any = await res.json();
      detail = data?.message ? `: ${data.message}` : '';
    } catch {
      // ignore — body wasn't JSON
    }
    return {
      ok: false,
      provider: 'brevo',
      retryable: isBrevoRetryable(res.status),
      error: `Brevo ${res.status}${detail}`,
      fallbackUsed: false,
    };
  }

  let messageId: string | null = null;
  try {
    const data: any = await res.json();
    messageId = data?.messageId ?? null;
  } catch {
    // Brevo returns 201 with a JSON body on success; tolerate a missing/odd body.
  }

  return { ok: true, provider: 'brevo', messageId, fallbackUsed: false };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Send one mail through the configured provider policy.
 *
 * env.EMAIL_PROVIDER:
 *   "cloudflare_then_brevo" — Cloudflare first; on ANY Cloudflare failure other
 *      than a permanent bounce / suppressed recipient (retryable 429/5xx/network,
 *      not configured, auth/entitlement 401/403, over-size or schema 400), retry
 *      the same message via Brevo. These are synchronous, user-facing form
 *      submissions with no retry queue, so losing the message is worse than
 *      masking a Cloudflare-side config bug (which is still logged as
 *      mail_send_failed with the Cloudflare error key). This is the
 *      DEFAULT whenever CF_EMAIL_API_TOKEN is set (so cutover needs no other
 *      config change); with no CF_EMAIL_API_TOKEN it degrades to "brevo",
 *      which is today's behaviour.
 *   "brevo"      — Brevo only (rollback switch).
 *   "cloudflare" — Cloudflare only, no fallback.
 *
 * A Cloudflare permanent-bounce outcome is never retried via Brevo (sending a
 * known-bad address through a second provider only hurts deliverability).
 */
export async function sendMail(msg: OutboundMail, env: MailEnv, fetchImpl: typeof fetch = fetch): Promise<MailResult> {
  const explicitPolicy = env.EMAIL_PROVIDER;
  const policy = explicitPolicy || (env.CF_EMAIL_API_TOKEN ? 'cloudflare_then_brevo' : 'brevo');

  if (policy === 'brevo') {
    const out = await sendViaBrevo(msg, env, fetchImpl);
    if (!out.ok) logEvent('mail_send_failed', { provider: out.provider, fallbackUsed: false, status: out.error });
    return out;
  }

  if (policy === 'cloudflare') {
    const out = await sendViaCloudflare(msg, env, fetchImpl);
    if (!out.ok) logEvent('mail_send_failed', { provider: out.provider, fallbackUsed: false, status: out.error });
    return out;
  }

  // cloudflare_then_brevo (default)
  const cf = await sendViaCloudflare(msg, env, fetchImpl);
  if (cf.ok) return cf;

  // Permanent bounce: never fall back.
  if (!cf.retryable && cf.error === PERMANENT_BOUNCE) {
    logEvent('mail_send_failed', { provider: cf.provider, fallbackUsed: false, status: cf.error });
    return cf;
  }

  // Any other Cloudflare failure (retryable, or not-configured, or a hard
  // config error like sender-not-verified) falls back to Brevo.
  logEvent('mail_send_failed', { provider: cf.provider, fallbackUsed: false, status: cf.error });
  const brevo = await sendViaBrevo(msg, env, fetchImpl);
  if (brevo.ok) {
    logEvent('mail_fallback_used', { provider: brevo.provider, fallbackUsed: true, status: cf.error });
    return { ...brevo, fallbackUsed: true };
  }

  logEvent('mail_send_failed', { provider: brevo.provider, fallbackUsed: true, status: brevo.error });
  return { ...brevo, fallbackUsed: true };
}

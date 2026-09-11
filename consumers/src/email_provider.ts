import type { Env } from "./types";

/**
 * [EMAIL-CF-1] Cloudflare Email Service primary / Brevo fallback.
 *
 * One call site (sendWithPolicy) decides, per env.EMAIL_PROVIDER:
 *   - "brevo"                today's behaviour (rollback switch)
 *   - "cloudflare"            Cloudflare only (Brevo fully decommissioned / incident)
 *   - "cloudflare_then_brevo" target: Cloudflare first; on a retryable error, or a
 *     sender-config error, or "not configured", fall back to Brevo in the SAME attempt.
 * A Cloudflare success is NEVER followed by a Brevo send. A suppressed or payload
 * (validation) error is NEVER retried anywhere - those are terminal/non-retryable
 * as returned.
 *
 * See Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md section 3.1.
 */

export type ProviderName = "cloudflare" | "brevo";

export type SendOutcome =
  | { ok: true; provider: ProviderName; messageId: string | null }
  | { ok: false; provider: ProviderName; retryable: boolean; terminal?: "bounced"; error: string };

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // "Name <addr>" or a bare address; default "AvaTok <noreply@avatok.ai>"
  // (env.EMAIL_FROM_DEFAULT overrides the default, msg.from overrides both).
  from?: string;
  replyTo?: { email: string; name?: string };
  attachments?: { name: string; content: string; type?: string }[]; // content = base64
  headers?: Record<string, string>;
}

export type ProviderPolicy = "brevo" | "cloudflare" | "cloudflare_then_brevo";

/** [EMAIL-CF-2] env.EMAIL_PROVIDER drives the policy; default "brevo" (today's behaviour). */
export function resolvePolicy(env: Env): ProviderPolicy {
  const value = (env.EMAIL_PROVIDER ?? "").trim();
  if (value === "cloudflare" || value === "cloudflare_then_brevo") return value;
  return "brevo";
}

/** Parses "Name <addr>" / a bare address; falls back to the account default. */
export function parseSender(from: string | undefined, env: Env): { name: string; email: string } {
  const fallback = { name: "AvaTok", email: "noreply@avatok.ai" };
  const configured = (env.EMAIL_FROM_DEFAULT ?? "").trim();
  const base = configured ? parseSenderString(configured, fallback) : fallback;
  if (!from) return base;
  return parseSenderString(from, base);
}

function parseSenderString(value: string, fallback: { name: string; email: string }): { name: string; email: string } {
  const match = value.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (match) return { name: (match[1] || fallback.name).trim(), email: match[2].trim() };
  return { name: fallback.name, email: value.trim() };
}

/** Cheap tag-strip for the required `text` alternative part. Not full HTML parsing. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mimeFor(name: string, type?: string): string {
  if (type) return type;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  // Plain type: the ICS body carries its own METHOD (REQUEST for bookings,
  // CANCEL for cancel.ics) — a hard-coded method=REQUEST param would contradict it.
  if (ext === "ics") return "text/calendar";
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "application/octet-stream";
}

// [EMAIL-CF-3] Cloudflare error-code classification (plan section 2). Sender-config
// errors ALSO console.error loudly - they mean our domain/config is wrong, not a
// transient provider condition, so they must not go unnoticed even though the
// fallback masks the user-facing impact.
// Retryable (and therefore eligible for the Brevo fallback): E_RATE_LIMIT_EXCEEDED,
// E_DAILY_LIMIT_EXCEEDED, E_INTERNAL_SERVER_ERROR, E_DELIVERY_FAILED, the sender-
// config codes, AND any code we do not recognise (or a throw with no code at all):
// failing closed on an unknown error would permanently drop a booking/receipt mail.
// Only the documented payload/allowlist errors below are non-retryable.
const NON_RETRYABLE_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_RECIPIENT_NOT_ALLOWED", // staging allowlist - must never fall back to Brevo
]);
function isNonRetryableCloudflareCode(code: string): boolean {
  return NON_RETRYABLE_CODES.has(code) || code.startsWith("E_HEADER");
}
const SENDER_CONFIG_CODES = new Set(["E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE"]);

export async function sendViaCloudflare(msg: OutboundEmail, env: Env): Promise<SendOutcome> {
  if (!env.EMAIL) {
    return { ok: false, provider: "cloudflare", retryable: false, error: "EMAIL binding not configured" };
  }
  const from = parseSender(msg.from, env);
  const attachments = (msg.attachments ?? []).map((a) => ({
    filename: a.name,
    content: a.content,
    type: mimeFor(a.name, a.type),
    disposition: "attachment" as const,
  }));
  try {
    const result = await env.EMAIL.send({
      from: { email: from.email, name: from.name },
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text ?? htmlToText(msg.html),
      // Bare string when there is no display name - avoids sending an empty `name`.
      ...(msg.replyTo?.email ? { replyTo: msg.replyTo.name ? { email: msg.replyTo.email, name: msg.replyTo.name } : msg.replyTo.email } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(msg.headers ? { headers: msg.headers } : {}),
    });
    return { ok: true, provider: "cloudflare", messageId: result.messageId ?? null };
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
    const message = error instanceof Error ? error.message : String(error);
    if (SENDER_CONFIG_CODES.has(code)) {
      // eslint-disable-next-line no-console
      console.error(`[EMAIL-CF-3] Cloudflare sender config error ${code}: ${message}`);
    }
    if (code === "E_RECIPIENT_SUPPRESSED") {
      return { ok: false, provider: "cloudflare", retryable: false, terminal: "bounced", error: `Cloudflare ${code}: ${message}`.slice(0, 500) };
    }
    const retryable = !isNonRetryableCloudflareCode(code);
    return { ok: false, provider: "cloudflare", retryable, error: `Cloudflare ${code || "unknown"}: ${message}`.slice(0, 500) };
  }
}

export async function sendViaBrevo(msg: OutboundEmail, env: Env): Promise<SendOutcome> {
  if (!env.BREVO_API_KEY) {
    return { ok: false, provider: "brevo", retryable: false, error: "BREVO_API_KEY not configured" };
  }
  const from = parseSender(msg.from, env);
  let response: Response;
  let responseText = "";
  try {
    response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: from,
        to: [{ email: msg.to }],
        ...(msg.replyTo?.email ? { replyTo: { email: msg.replyTo.email, ...(msg.replyTo.name ? { name: msg.replyTo.name } : {}) } } : {}),
        subject: msg.subject,
        htmlContent: msg.html,
        ...(msg.attachments?.length ? { attachment: msg.attachments.map((item) => ({ name: item.name, content: item.content })) } : {}),
      }),
    });
    // Read exactly once - a second .text() read returns an empty body.
    responseText = (await response.text()).slice(0, 2000);
  } catch (error) {
    return { ok: false, provider: "brevo", retryable: true, error: `Brevo network error: ${String(error)}`.slice(0, 500) };
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    return { ok: false, provider: "brevo", retryable, error: `Brevo ${response.status}: ${responseText}`.slice(0, 500) };
  }
  let messageId: string | null = null;
  try { messageId = (JSON.parse(responseText) as { messageId?: string }).messageId ?? null; } catch { /* Brevo may return an empty 2xx body */ }
  return { ok: true, provider: "brevo", messageId };
}

/** [EMAIL-CF-4] email_suppressions table may not exist yet (pre-Phase-5 migration) - treat any query error as "not suppressed" rather than blocking sends. */
export async function isLocallySuppressed(env: Env, email: string): Promise<boolean> {
  try {
    const row = await env.DB_META.prepare("SELECT 1 FROM email_suppressions WHERE email=?1").bind(email.trim().toLowerCase()).first();
    return row != null;
  } catch {
    return false;
  }
}

function shouldFallBackFromCloudflare(cf: SendOutcome): boolean {
  if (cf.ok || cf.terminal) return false;
  if (cf.retryable) return true;
  return /E_SENDER_NOT_VERIFIED|E_SENDER_DOMAIN_NOT_AVAILABLE|not configured/.test(cf.error);
}

export async function sendWithPolicy(msg: OutboundEmail, env: Env): Promise<SendOutcome & { fallbackUsed: boolean }> {
  if (await isLocallySuppressed(env, msg.to)) {
    return { ok: false, provider: "cloudflare", retryable: false, terminal: "bounced", error: "recipient locally suppressed", fallbackUsed: false };
  }

  const policy = resolvePolicy(env);

  if (policy === "brevo") {
    const out = await sendViaBrevo(msg, env);
    return { ...out, fallbackUsed: false };
  }

  if (policy === "cloudflare") {
    const out = await sendViaCloudflare(msg, env);
    return { ...out, fallbackUsed: false };
  }

  // cloudflare_then_brevo
  const cf = await sendViaCloudflare(msg, env);
  if (cf.ok) return { ...cf, fallbackUsed: false };
  if (!shouldFallBackFromCloudflare(cf)) return { ...cf, fallbackUsed: false };

  const brevo = await sendViaBrevo(msg, env);
  if (brevo.ok) return { ...brevo, fallbackUsed: true };
  // Both failed: report Brevo's outcome (the last attempt), merging retryability + errors.
  return {
    ...brevo,
    retryable: cf.retryable || brevo.retryable,
    error: `${cf.error} | ${brevo.error}`.slice(0, 500),
    fallbackUsed: true,
  };
}

import type { APIRoute } from 'astro';
import { sendMail } from '../../lib/sendMail';
import { ORG } from '../../lib/org';
import { BRAND } from '../../lib/brand';

// On-demand (SSR) endpoint — runs in the avatok-app Pages worker on the Cloudflare
// edge. Receives the /contact form and sends the message to support@saathum.com via
// sendMail() — Cloudflare Email Service REST API first, Brevo as fallback (see
// Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md §3.4). Requires
// CF_EMAIL_API_TOKEN and/or BREVO_API_KEY on the avatok-app Pages project.
// [SAATHUM-EMAIL-1] support@saathum.com also needs an inbound Email Routing
// rule (separate from Email Sending) before this address can receive anything
// - see Specs/PLAN-2026-09-20-SAATHUM-EMAIL-DOMAIN-CUTOVER.md §Inbound routing.
// Brand name comes from ORG per SPEC hard rule 3; only the sender/reply
// addresses stay literal (this lane's own domain-cutover fact).
export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');


// ─── [WEB-CONTACT-GUARD-1 2026-09-27] Bot guard ────────────────────────────────
// Spam was reaching support@saathum.com through the old careers form, so the
// contact form now has TWO server-verified checks in front of sendMail(), both
// FAIL-CLOSED (a missing secret means the form refuses, never that it skips):
//   1. A maths question. GET /api/contact issues { question, token }; the token is
//      an HMAC-SHA256 (CONTACT_CAPTCHA_SECRET) over the two numbers + expiry, so
//      the page can stay prerendered and the server stays stateless.
//   2. Cloudflare Turnstile (widget "saathum-contact", sitekey in
//      pages/contact.astro). Verified with TURNSTILE_SECRET_KEY via siteverify;
//      Turnstile tokens are single-use, which also stops maths-token replay.
// Both secrets are Pages production secrets on the avatok-app project.
const CAPTCHA_TTL_MS = 20 * 60 * 1000;
const TURNSTILE_HOSTS = new Set([BRAND.domain, `www.${BRAND.domain}`, 'avatok-app.pages.dev']);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function checkMaths(secret: string, token: unknown, answer: unknown): Promise<boolean> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 4) return false;
  const [a, b, exp, sig] = parts;
  if (!/^\d{1,2}$/.test(a) || !/^\d{1,2}$/.test(b) || !/^\d{13}$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  if (!safeEqual(await hmac(secret, `${a}.${b}.${exp}`), sig)) return false;
  const given = String(answer ?? '').trim();
  return /^\d{1,3}$/.test(given) && Number(given) === Number(a) + Number(b);
}

async function checkTurnstile(secret: string, response: unknown, ip: string | null): Promise<boolean> {
  const token = String(response ?? '');
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = (await res.json()) as { success?: boolean; hostname?: string; 'error-codes'?: string[] };
    if (!out.success) {
      console.warn(JSON.stringify({ event: 'contact_turnstile_rejected', codes: out['error-codes'] ?? [] }));
      return false;
    }
    return !out.hostname || TURNSTILE_HOSTS.has(out.hostname);
  } catch (err) {
    console.error(JSON.stringify({ event: 'contact_turnstile_error', message: err instanceof Error ? err.message : 'unknown' }));
    return false;
  }
}

type RuntimeLocals = { runtime?: { env?: Record<string, string | undefined> } };

/** Issue a fresh maths question. Called by pages/contact.astro on load and after each send. */
export const GET: APIRoute = async (context) => {
  const env = (context.locals as unknown as RuntimeLocals).runtime?.env ?? {};
  if (!env.CONTACT_CAPTCHA_SECRET) return json({ ok: false, error: 'The form is unavailable right now.' }, 503);
  const r = new Uint8Array(2);
  crypto.getRandomValues(r);
  const a = 2 + (r[0] % 11); // 2..12
  const b = 1 + (r[1] % 9); // 1..9
  const exp = Date.now() + CAPTCHA_TTL_MS;
  const token = `${a}.${b}.${exp}.${await hmac(env.CONTACT_CAPTCHA_SECRET, `${a}.${b}.${exp}`)}`;
  return json({ ok: true, question: `What is ${a} + ${b}?`, token });
};

export const POST: APIRoute = async (context) => {
  const contentLength = Number(context.request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 16_000) {
    return json({ ok: false, error: 'Message is too large.' }, 413);
  }

  // Cloudflare runtime env is exposed by the Astro adapter at locals.runtime.env.
  const env = (context.locals as unknown as RuntimeLocals).runtime?.env ?? {};

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await context.request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ ok: false, error: 'Invalid request.' }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  const oneLine = (value: unknown, max: number) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
  const name = oneLine(body.name, 120);
  const email = (body.email ?? '').toString().trim().slice(0, 200);
  const category = oneLine(body.category ?? 'Support', 80);
  const subject = oneLine(body.subject, 160);
  const message = (body.message ?? '').toString().trim().slice(0, 5000);
  const company = (body.company ?? '').toString().trim();

  // Quietly accept bot submissions caught by the hidden field without sending mail.
  if (company) return json({ ok: true });

  if (!name || !email || !message) {
    return json({ ok: false, error: 'Please fill in your name, email, and message.' }, 400);
  }
  if (!isEmail(email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  // [WEB-CONTACT-GUARD-1] Fail closed: no secrets = no mail.
  if (!env.CONTACT_CAPTCHA_SECRET || !env.TURNSTILE_SECRET_KEY) {
    console.error(JSON.stringify({ event: 'contact_guard_not_configured', captcha: !!env.CONTACT_CAPTCHA_SECRET, turnstile: !!env.TURNSTILE_SECRET_KEY }));
    return json({ ok: false, error: `The form is unavailable right now. Please email support (@) ${BRAND.domain} directly.` }, 503);
  }
  if (!(await checkMaths(env.CONTACT_CAPTCHA_SECRET, body.captcha_token, body.captcha_answer))) {
    console.warn(JSON.stringify({ event: 'contact_maths_rejected' }));
    return json({ ok: false, error: 'That answer to the maths question is not right. Please try the new question.', retry: 'captcha' }, 400);
  }
  if (!(await checkTurnstile(env.TURNSTILE_SECRET_KEY, body['cf-turnstile-response'], context.request.headers.get('cf-connecting-ip')))) {
    return json({ ok: false, error: 'We could not confirm you are human. Please complete the check and try again.', retry: 'turnstile' }, 400);
  }

  if (!env.BREVO_API_KEY && !env.CF_EMAIL_API_TOKEN) {
    // Don't fail silently in a way that loses the message; surface a clear error.
    return json(
      { ok: false, error: `Email is not configured yet. Please email ${BRAND.emails.support} directly.` },
      503,
    );
  }

  const subjectLine = `[${ORG.name} ${category || 'Support'}] ${subject || 'New message'} — from ${name}`;
  const textContent = [
    `New ${ORG.name} contact form submission`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Category: ${category || 'Support'}`,
    `Subject: ${subject || '(none)'}`,
    '',
    message,
  ].join('\n');
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#231b14">
      <h2 style="margin:0 0 12px">New contact form submission</h2>
      <p><strong>Name:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      <p><strong>Category:</strong> ${esc(category || 'Support')}</p>
      <p><strong>Subject:</strong> ${esc(subject || '(none)')}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;border-left:3px solid #007d7f;padding-left:12px">${esc(message)}</p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
      <p style="color:#777;font-size:13px">Sent from the ${BRAND.domain} contact form.</p>
    </div>`;

  try {
    const out = await sendMail(
      {
        to: BRAND.emails.support,
        subject: subjectLine,
        html: htmlContent,
        text: textContent,
        from: { name: env.BREVO_SENDER_NAME || `${ORG.name} Support`, email: env.BREVO_SENDER_EMAIL || BRAND.emails.hello },
        replyTo: { email, name },
        tags: ['website-contact'],
      },
      env,
    );

    if (!out.ok) {
      console.error(JSON.stringify({ event: 'contact_send_failed', provider: out.provider, fallbackUsed: out.fallbackUsed, status: out.error }));
      return json({ ok: false, error: 'Could not send your message. Please try again.' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error(JSON.stringify({ event: 'contact_endpoint_error', message: err instanceof Error ? err.message : 'unknown' }));
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
};

import type { APIRoute } from 'astro';
import { sendMail } from '../../lib/sendMail';

// On-demand (SSR) endpoint — runs in the avatok-app Pages worker on the Cloudflare
// edge. Receives the /contact form and sends the message to support@avatok.ai via
// sendMail() — Cloudflare Email Service REST API first, Brevo as fallback (see
// Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md §3.4). Requires
// CF_EMAIL_API_TOKEN and/or BREVO_API_KEY on the avatok-app Pages project.
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

export const POST: APIRoute = async (context) => {
  const contentLength = Number(context.request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 16_000) {
    return json({ ok: false, error: 'Message is too large.' }, 413);
  }

  // Cloudflare runtime env is exposed by the Astro adapter at locals.runtime.env.
  type RuntimeLocals = { runtime?: { env?: Record<string, string | undefined> } };
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

  if (!env.BREVO_API_KEY && !env.CF_EMAIL_API_TOKEN) {
    // Don't fail silently in a way that loses the message; surface a clear error.
    return json(
      { ok: false, error: 'Email is not configured yet. Please email support@avatok.ai directly.' },
      503,
    );
  }

  const subjectLine = `[avaTOK ${category || 'Support'}] ${subject || 'New message'} — from ${name}`;
  const textContent = [
    'New avaTOK contact form submission',
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
      <p style="color:#777;font-size:13px">Sent from the avatok.ai contact form.</p>
    </div>`;

  try {
    const out = await sendMail(
      {
        to: 'support@avatok.ai',
        subject: subjectLine,
        html: htmlContent,
        text: textContent,
        from: { name: env.BREVO_SENDER_NAME || 'avaTOK Website', email: env.BREVO_SENDER_EMAIL || 'hello@avatok.ai' },
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

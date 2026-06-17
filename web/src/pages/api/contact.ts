import type { APIRoute } from 'astro';

// On-demand (SSR) endpoint — runs in the avatok-app Pages worker on the Cloudflare
// edge. Receives the /contact form and sends the message to support@avatok.ai via
// Brevo's transactional email API. Requires the BREVO_API_KEY secret on the
// avatok-app Pages project (same key pattern as the consumers worker).
export const prerender = false;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const POST: APIRoute = async (context) => {
  // Cloudflare runtime env (BREVO_API_KEY) is exposed via locals.runtime.env.
  const env = (context.locals as any)?.runtime?.env ?? {};
  const BREVO_API_KEY: string | undefined = env.BREVO_API_KEY;

  let body: Record<string, string> = {};
  try {
    body = await context.request.json();
  } catch {
    return json({ ok: false, error: 'Invalid request.' }, 400);
  }

  const name = (body.name ?? '').toString().trim().slice(0, 120);
  const email = (body.email ?? '').toString().trim().slice(0, 200);
  const subject = (body.subject ?? '').toString().trim().slice(0, 160);
  const message = (body.message ?? '').toString().trim().slice(0, 5000);

  if (!name || !email || !message) {
    return json({ ok: false, error: 'Please fill in your name, email, and message.' }, 400);
  }
  if (!isEmail(email)) {
    return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  }

  if (!BREVO_API_KEY) {
    // Don't fail silently in a way that loses the message; surface a clear error.
    return json(
      { ok: false, error: 'Email is not configured yet. Please email support@avatok.ai directly.' },
      503,
    );
  }

  const subjectLine = `[avaTOK Contact] ${subject || 'New message'} — from ${name}`;
  const htmlContent = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#231b14">
      <h2 style="margin:0 0 12px">New contact form submission</h2>
      <p><strong>Name:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      <p><strong>Subject:</strong> ${esc(subject || '(none)')}</p>
      <p><strong>Message:</strong></p>
      <p style="white-space:pre-wrap;border-left:3px solid #007d7f;padding-left:12px">${esc(message)}</p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #ddd">
      <p style="color:#777;font-size:13px">Sent from the avatok.ai contact form.</p>
    </div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'avaTOK Website', email: 'noreply@avatok.ai' },
        to: [{ email: 'support@avatok.ai', name: 'avaTOK Support' }],
        replyTo: { email, name },
        subject: subjectLine,
        htmlContent,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('Brevo send failed', res.status, detail);
      return json({ ok: false, error: 'Could not send your message. Please try again.' }, 502);
    }

    return json({ ok: true });
  } catch (err) {
    console.error('contact endpoint error', err);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
};

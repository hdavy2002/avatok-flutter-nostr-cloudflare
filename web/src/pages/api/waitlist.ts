import type { APIRoute } from 'astro';

// On-demand (SSR) endpoint — runs in the avatok-app Pages worker on the Cloudflare
// edge. POST /api/waitlist adds the email to Brevo (list via BREVO_LIST_ID) and
// sends a branded welcome email via Brevo's transactional API. Ported from the
// standalone marketing site's _worker.js so the homepage waitlist form works on
// avatok-app. The Brevo key lives only as the BREVO_API_KEY secret on this Pages
// project (same pattern as api/contact.ts).
export const prerender = false;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function welcomeHtml(): string {
  return `<!doctype html><html><body style="margin:0;background:#f7f3ea;">
  <div style="background:#f7f3ea;padding:30px 16px;font-family:Arial,Helvetica,sans-serif;color:#25211b;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:2px solid #25211b;border-radius:20px;overflow:hidden;">
      <img src="https://avatok.ai/og.jpg" alt="avaTOK" width="520" style="display:block;width:100%;height:auto;border-bottom:2px solid #25211b;" />
      <div style="padding:30px 32px;">
        <h1 style="margin:0 0 12px;font-size:26px;color:#25211b;">You're on the list 🎉</h1>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">Thanks for joining the <b>avaTOK</b> waitlist — your everything-AI, living in your messenger, with your data under your own Google account.</p>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">We're letting people in gradually. We'll email you the moment your spot opens so you can claim your <b>@handle</b> before it's gone.</p>
        <p style="margin:0 0 4px;font-size:16px;line-height:1.55;">Until then — real people only, 44+ apps and counting, and an AI that works for you. 💚</p>
        <p style="margin:24px 0 0;font-size:14px;color:#6e6c5c;">— The avaTOK team</p>
      </div>
    </div>
    <p style="max-width:520px;margin:16px auto 0;text-align:center;font-size:12px;color:#9a9684;line-height:1.5;">avaTOK · AvaGlobal International, Inc. — a Delaware corporation, USA.<br/>You received this because you joined the waitlist at avatok.ai.</p>
  </div></body></html>`;
}

async function sendWelcome(env: Record<string, string | undefined>, email: string) {
  const sender = {
    name: env.BREVO_SENDER_NAME || 'AvaTOK Joinlist',
    email: env.BREVO_SENDER_EMAIL || 'hello@avatok.ai',
  };
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY as string, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender,
        to: [{ email }],
        replyTo: { email: 'hello@avatok.ai', name: 'avaTOK' },
        subject: "You're on the avaTOK waitlist 🎉",
        htmlContent: welcomeHtml(),
      }),
    });
    return r.status;
  } catch {
    return 'error';
  }
}

export const POST: APIRoute = async (context) => {
  // Cloudflare runtime env (BREVO_API_KEY, BREVO_LIST_ID, …) via locals.runtime.env.
  const env = ((context.locals as any)?.runtime?.env ?? {}) as Record<string, string | undefined>;

  let email = '';
  let source = 'landing';
  try {
    const body = (await context.request.json()) as Record<string, unknown>;
    email = String(body.email || '').trim().toLowerCase();
    if (body.source) source = String(body.source).slice(0, 40);
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: 'invalid_email' }, 400);
  if (!env.BREVO_API_KEY) return json({ error: 'not_configured' }, 503);

  const payload: Record<string, unknown> = {
    email,
    updateEnabled: true,
    attributes: { SIGNUP_SOURCE: 'avatok-waitlist', SIGNUP_PAGE: source },
  };
  if (env.BREVO_LIST_ID) {
    const ids = String(env.BREVO_LIST_ID)
      .split(',')
      .map((n) => Number(n.trim()))
      .filter(Boolean);
    if (ids.length) payload.listIds = ids;
  }

  let res: Response;
  try {
    res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }

  // 201 created or 204 updated/added-to-list → send the welcome email (so existing
  // Brevo contacts who join the waitlist get it too).
  if (res.ok || res.status === 204) {
    const mail = await sendWelcome(env, email);
    return json({ ok: true, mail });
  }

  let data: any = {};
  try {
    data = await res.json();
  } catch {}
  if (res.status === 400 && data && data.code === 'duplicate_parameter') {
    return json({ ok: true, duplicate: true });
  }
  return json({ error: 'brevo_error', status: res.status, code: data && data.code }, 502);
};

import type { APIRoute } from 'astro';

export const prerender = false;

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const esc = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clean = (value: FormDataEntryValue | null, max: number) =>
  String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const safeFilename = (value: string) => {
  const name = value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 120);
  return name || 'resume';
};

const acknowledgementHtml = (name: string, role: string) => `
  <div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#231b14;max-width:620px">
    <h2 style="margin:0 0 18px;color:#4d5cff">We received your application</h2>
    <p>Hi ${esc(name)},</p>
    <p>Thank you for applying for the <strong>${esc(role)}</strong> role at avaTOK. We’ve received your resume and our team will review it carefully.</p>
    <p>If your experience is a match for the next step, we’ll be in touch. If not, we still wish you every success in what comes next.</p>
    <p style="margin-top:24px">Warmly,<br /><strong>The avaTOK team</strong></p>
  </div>`;

export const POST: APIRoute = async (context) => {
  const contentLength = Number(context.request.headers.get('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES + 256_000) {
    return json({ ok: false, error: 'Please keep your resume under 8 MB.' }, 413);
  }

  const env = ((context.locals as any)?.runtime?.env ?? {}) as Record<string, string | undefined>;
  if (!env.BREVO_API_KEY) return json({ ok: false, error: 'Applications are temporarily unavailable. Please email support@avatok.ai.' }, 503);

  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return json({ ok: false, error: 'Please complete the form and try again.' }, 400);
  }

  // Honeypot: quietly accept obvious bot submissions without sending mail.
  if (clean(form.get('company'), 120)) return json({ ok: true });

  const name = clean(form.get('name'), 120);
  const email = clean(form.get('email'), 200).toLowerCase();
  const role = clean(form.get('role'), 160) || 'AvaTOK role';
  const portfolio = clean(form.get('portfolio'), 300);
  const note = clean(form.get('note'), 2000);
  const resume = form.get('resume');

  if (!name || !email || !isEmail(email) || !(resume instanceof File) || resume.size === 0) {
    return json({ ok: false, error: 'Please add your name, a valid email, and your resume.' }, 400);
  }
  if (resume.size > MAX_FILE_BYTES) return json({ ok: false, error: 'Please keep your resume under 8 MB.' }, 413);
  if (!ALLOWED_TYPES.has(resume.type)) return json({ ok: false, error: 'Please upload a PDF, DOC, or DOCX resume.' }, 415);

  const bytes = new Uint8Array(await resume.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const attachment = { name: safeFilename(resume.name), content: btoa(binary) };
  const sender = {
    name: env.BREVO_SENDER_NAME || 'avaTOK Careers',
    email: env.BREVO_SENDER_EMAIL || 'hello@avatok.ai',
  };
  const headers = { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' };

  const internalHtml = `
    <div style="font-family:Arial,sans-serif;font-size:15px;color:#231b14">
      <h2>New avaTOK careers application</h2>
      <p><strong>Role:</strong> ${esc(role)}</p>
      <p><strong>Name:</strong> ${esc(name)}</p>
      <p><strong>Email:</strong> ${esc(email)}</p>
      ${portfolio ? `<p><strong>Portfolio / LinkedIn:</strong> ${esc(portfolio)}</p>` : ''}
      ${note ? `<p><strong>Note:</strong></p><p style="white-space:pre-wrap">${esc(note)}</p>` : ''}
    </div>`;

  try {
    const internal = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sender,
        to: [{ email: 'support@avatok.ai', name: 'avaTOK Careers' }],
        replyTo: { email, name },
        subject: `[avaTOK Careers] ${role} — ${name}`,
        htmlContent: internalHtml,
        textContent: `New application for ${role}\n\nName: ${name}\nEmail: ${email}\nPortfolio: ${portfolio || '(none)'}\n\n${note || ''}`,
        attachment: [attachment],
        tags: ['website-careers'],
      }),
    });
    if (!internal.ok) return json({ ok: false, error: 'We could not send your application. Please try again.' }, 502);

    const acknowledgement = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sender,
        to: [{ email, name }],
        replyTo: { email: 'support@avatok.ai', name: 'avaTOK Careers' },
        subject: 'We received your avaTOK application',
        htmlContent: acknowledgementHtml(name, role),
        textContent: `Hi ${name},\n\nThank you for applying for the ${role} role at avaTOK. We’ve received your resume and our team will review it carefully. If your experience is a match for the next step, we’ll be in touch. If not, we still wish you every success in what comes next.\n\nWarmly,\nThe avaTOK team`,
        tags: ['website-careers-acknowledgement'],
      }),
    });
    if (!acknowledgement.ok) console.error(JSON.stringify({ event: 'brevo_careers_ack_failed', status: acknowledgement.status }));
    return json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ event: 'careers_apply_endpoint_error', message: error instanceof Error ? error.message : 'unknown' }));
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
};

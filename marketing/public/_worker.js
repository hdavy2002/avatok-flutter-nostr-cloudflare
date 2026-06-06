// Cloudflare Pages advanced-mode worker.
// POST /api/waitlist -> adds the email to Brevo (list via BREVO_LIST_ID) and, for
// brand-new signups, sends a branded thank-you email via Brevo transactional API.
// The Brevo API key lives ONLY here as an encrypted env var (BREVO_API_KEY).

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function welcomeHtml() {
  return `<!doctype html><html><body style="margin:0;background:#f7f3ea;">
  <div style="background:#f7f3ea;padding:30px 16px;font-family:Arial,Helvetica,sans-serif;color:#25211b;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:2px solid #25211b;border-radius:20px;overflow:hidden;">
      <img src="https://avatok.ai/og.png" alt="avaTOK" width="520" style="display:block;width:100%;height:auto;border-bottom:2px solid #25211b;" />
      <div style="padding:30px 32px;">
        <h1 style="margin:0 0 12px;font-size:26px;color:#25211b;">You're on the list 🎉</h1>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">Thanks for joining the <b>avaTOK</b> waitlist — your whole social life in one app, with your data locked under your own key.</p>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.55;">We're letting people in gradually. We'll email you the moment your spot opens so you can claim your <b>@handle</b> before it's gone.</p>
        <p style="margin:0 0 4px;font-size:16px;line-height:1.55;">Until then — real people only, 44+ apps and counting, and an AI that works for you. 💚</p>
        <p style="margin:24px 0 0;font-size:14px;color:#6e6c5c;">— The avaTOK team</p>
      </div>
    </div>
    <p style="max-width:520px;margin:16px auto 0;text-align:center;font-size:12px;color:#9a9684;line-height:1.5;">avaTOK · AvaGlobal International, Inc. — a Delaware corporation, USA.<br/>You received this because you joined the waitlist at avatok.ai.</p>
  </div></body></html>`;
}

async function sendWelcome(env, email) {
  const sender = {
    name: env.BREVO_SENDER_NAME || "AvaTOK Joinlist",
    email: env.BREVO_SENDER_EMAIL || "hello@avatok.ai",
  };
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender,
        to: [{ email }],
        replyTo: { email: "hello@avatok.ai", name: "avaTOK" },
        subject: "You're on the avaTOK waitlist 🎉",
        htmlContent: welcomeHtml(),
      }),
    });
    return r.status;
  } catch {
    return "error";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/waitlist") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

      let email = "";
      let source = "landing";
      try {
        const body = await request.json();
        email = String(body.email || "").trim().toLowerCase();
        if (body.source) source = String(body.source).slice(0, 40);
      } catch {
        return json({ error: "bad_request" }, 400);
      }
      if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "invalid_email" }, 400);
      if (!env.BREVO_API_KEY) return json({ error: "not_configured" }, 503);

      const payload = {
        email,
        updateEnabled: true,
        attributes: { SIGNUP_SOURCE: "avatok-waitlist", SIGNUP_PAGE: source },
      };
      if (env.BREVO_LIST_ID) {
        const ids = String(env.BREVO_LIST_ID).split(",").map((n) => Number(n.trim())).filter(Boolean);
        if (ids.length) payload.listIds = ids;
      }

      let res;
      try {
        res = await fetch("https://api.brevo.com/v3/contacts", {
          method: "POST",
          headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        return json({ error: "upstream_unreachable" }, 502);
      }

      // 201 = newly created -> send the welcome email. 204 = already existed (don't re-email).
      if (res.status === 201) {
        const mail = await sendWelcome(env, email);
        return json({ ok: true, mail });
      }
      if (res.ok || res.status === 204) return json({ ok: true, mail: "skipped_existing" });

      let data = {};
      try { data = await res.json(); } catch {}
      if (res.status === 400 && data && data.code === "duplicate_parameter") {
        return json({ ok: true, duplicate: true });
      }
      return json({ error: "brevo_error", status: res.status, code: data && data.code }, 502);
    }

    return env.ASSETS.fetch(request);
  },
};

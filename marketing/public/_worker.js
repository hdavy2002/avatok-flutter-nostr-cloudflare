// Cloudflare Pages advanced-mode worker.
// POST /api/waitlist -> adds the email to Brevo (list via BREVO_LIST_ID; unchanged,
// out of scope for the email-provider migration) and, for brand-new signups, sends
// a branded thank-you email.
//
// Thank-you email transport (only the transactional send, not the list-add):
// Cloudflare Email Sending REST API first, Brevo transactional API as fallback.
// See Specs/PLAN-2026-09-11-EMAIL-CLOUDFLARE-PRIMARY-BREVO-FALLBACK.md (row F, S3.4).
//   - CF_ACCOUNT_ID / CF_EMAIL_API_TOKEN unset -> Brevo only (today's behaviour).
//   - Cloudflare throws / returns a non-2xx or success:false for any reason other
//     than a suppressed recipient -> fall back to Brevo (same policy as
//     web/src/lib/sendMail.ts: a lost welcome email is worse than masking a CF
//     config bug, which is still logged as mail_send_failed).
//   - Cloudflare succeeds -> Brevo is never called for that message.
//   - Recipient is in Cloudflare's permanent_bounces -> do NOT fall back to Brevo
//     (sending a known-dead address through another provider only hurts
//     reputation); the signup still succeeds from the caller's point of view.
// The Brevo API key lives ONLY here as an encrypted env var (BREVO_API_KEY); the
// Cloudflare token (CF_EMAIL_API_TOKEN) is likewise an encrypted env var, scoped
// to Account -> Email Sending -> Edit only.

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

const WELCOME_SUBJECT = "You're on the avaTOK waitlist 🎉";
const WELCOME_TEXT =
  "You're on the avaTOK waitlist! We're letting people in gradually and will " +
  "email you the moment your spot opens so you can claim your @handle.";

// Structured event logs for the two failure/fallback signals this endpoint can
// produce. Cloudflare Pages ships console output to the dashboard's real-time
// logs / any connected log sink, so keep these one-line JSON objects.
function logMailEvent(event, fields) {
  try {
    console.log(JSON.stringify({ event, ...fields }));
  } catch {
    // logging must never break the request
  }
}

// REST API error messages are keys like "email.sending.error.throttled" (429)
// or "email.sending.error.internal_server" (500). Used for log attribution only;
// the fallback decision below is "anything but a suppressed/bounced recipient".
const CF_RETRYABLE_CODE_RE = /THROTTLED|RATE_LIMIT|DAILY_LIMIT|INTERNAL/i;

async function sendViaCloudflare(env, email, sender) {
  let r;
  try {
    r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CF_EMAIL_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: email,
          // REST API shape: `from` is a bare address or { address, name };
          // "Name <addr>" strings are not a documented form. Reply-To is
          // snake_case `reply_to` on REST (camelCase only on the binding).
          from: { address: sender.email, name: sender.name },
          reply_to: { address: "hello@avatok.ai", name: "avaTOK" },
          subject: WELCOME_SUBJECT,
          html: welcomeHtml(),
          text: WELCOME_TEXT,
        }),
      }
    );
  } catch (err) {
    return { ok: false, status: "network_error", retryable: true, errors: [String((err && err.message) || err)] };
  }

  let data = {};
  try {
    data = await r.json();
  } catch {
    // non-JSON body; fall through with data = {}
  }

  const result = data && data.result;
  const errs = data && Array.isArray(data.errors) ? data.errors : [];
  const permanentBounce =
    !!(
      result &&
      Array.isArray(result.permanent_bounces) &&
      result.permanent_bounces.some((a) => String(a).toLowerCase() === email.toLowerCase())
    ) || errs.some((e) => /suppress/i.test(String((e && e.message) || "")));
  if (permanentBounce) {
    return { ok: false, status: r.status, permanentBounce: true, errors: data && data.errors };
  }

  if (r.ok && data && data.success === true) {
    return { ok: true, status: r.status, messageId: (result && result.message_id) || null };
  }

  const errors = (data && Array.isArray(data.errors) ? data.errors : []) || [];
  const codes = errors.map((e) => String((e && (e.code || e.message)) || ""));
  const retryable = r.status === 429 || r.status >= 500 || codes.some((c) => CF_RETRYABLE_CODE_RE.test(c));
  return { ok: false, status: r.status, retryable, errors };
}

async function sendViaBrevo(env, email, sender) {
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender,
        to: [{ email }],
        replyTo: { email: "hello@avatok.ai", name: "avaTOK" },
        subject: WELCOME_SUBJECT,
        htmlContent: welcomeHtml(),
      }),
    });
    return r.status;
  } catch {
    return "error";
  }
}

async function sendWelcome(env, email) {
  const sender = {
    name: env.BREVO_SENDER_NAME || "AvaTOK Joinlist",
    email: env.BREVO_SENDER_EMAIL || "hello@avatok.ai",
  };
  const cfConfigured = !!(env.CF_EMAIL_API_TOKEN && env.CF_ACCOUNT_ID);

  if (!cfConfigured) {
    // Cloudflare not set up yet on this environment -- today's Brevo-only path.
    return sendViaBrevo(env, email, sender);
  }

  const cf = await sendViaCloudflare(env, email, sender);
  if (cf.ok) {
    // Cloudflare succeeded: Brevo must never be sent for this message.
    return `cloudflare:${cf.status}`;
  }

  if (cf.permanentBounce) {
    logMailEvent("mail_send_failed", {
      provider: "cloudflare",
      reason: "permanent_bounce",
      status: cf.status,
    });
    return "cloudflare:permanent_bounce";
  }

  logMailEvent("mail_send_failed", {
    provider: "cloudflare",
    status: cf.status,
    retryable: !!cf.retryable,
    errors: cf.errors,
  });

  logMailEvent("mail_fallback_used", { from: "cloudflare", to: "brevo", cfStatus: cf.status });
  const brevoStatus = await sendViaBrevo(env, email, sender);
  return `brevo:${brevoStatus}`;
}

// --- Phase 5 (A1): join-link web fallback -----------------------------------
// avatok.ai/j/<token> — tiny no-framework page. Shows event/consult title, time
// in the VIEWER's local timezone, creator name, and two buttons: "Open in
// AvaTOK app" (intent URL → app via App Links) and "Get the app". Display data
// comes from the public worker endpoint GET api.avatok.ai/api/join-info/:token
// (no PII beyond title/time/names; joining still requires the app + auth).
function joinPage(token) {
  const t = JSON.stringify(String(token));
  return `<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your AvaTOK booking</title>
<style>
 body{margin:0;background:#f7f3ea;font-family:system-ui,-apple-system,Arial,sans-serif;color:#25211b}
 .card{max-width:420px;margin:60px auto;background:#fff;border:2px solid #25211b;border-radius:20px;padding:32px;text-align:center}
 h1{font-size:22px;margin:0 0 6px} .muted{color:#6e6c5c;font-size:14px;margin:4px 0}
 .btn{display:block;margin:10px auto 0;max-width:280px;padding:14px 18px;border-radius:12px;text-decoration:none;font-weight:700}
 .primary{background:#08C4C4;color:#fff}.secondary{background:#fff;color:#25211b;border:2px solid #25211b}
 #err{color:#b3261e;display:none}
</style></head><body>
<div class="card">
  <h1 id="title">Loading…</h1>
  <p class="muted" id="when"></p>
  <p class="muted" id="who"></p>
  <p id="err">This link is invalid or has expired.</p>
  <a class="btn primary" id="open" href="#" style="display:none">Open in AvaTOK app</a>
  <a class="btn secondary" id="store" href="https://play.google.com/store/apps/details?id=ai.avatok.avatok_call" style="display:none">Get the app</a>
</div>
<script>
(async()=>{
  const token=${t};
  try{
    const r=await fetch("https://api.avatok.ai/api/join-info/"+encodeURIComponent(token));
    if(!r.ok)throw 0;
    const j=await r.json();
    document.getElementById("title").textContent=j.title||"AvaTOK session";
    const s=new Date(j.starts_at),e=new Date(j.ends_at);
    const f=new Intl.DateTimeFormat(undefined,{dateStyle:"full",timeStyle:"short"});
    const tf=new Intl.DateTimeFormat(undefined,{timeStyle:"short"});
    document.getElementById("when").textContent=f.format(s)+" – "+tf.format(e)+" (your time)";
    document.getElementById("who").textContent="with "+(j.creator_name||"a creator")+(j.status!=="confirmed"?" · "+j.status:"");
    const open=document.getElementById("open");
    open.href="intent://j/"+encodeURIComponent(token)+"#Intent;scheme=https;package=ai.avatok.avatok_call;S.browser_fallback_url="+encodeURIComponent(location.href)+";end";
    open.style.display="block";
    document.getElementById("store").style.display="block";
  }catch(_){
    document.getElementById("title").textContent="Booking unavailable";
    document.getElementById("err").style.display="block";
  }
})();
</script></body></html>`;
}

// Android App Links: the app's release-key SHA-256 fingerprint goes in
// ASSETLINKS_SHA256 (Pages env var, comma-separated for multiple keys) so a
// key rotation never needs a code change.
function assetlinks(env) {
  const prints = String(env.ASSETLINKS_SHA256 || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return JSON.stringify([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: "ai.avatok.avatok_call", sha256_cert_fingerprints: prints },
  }]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Phase 5 (A1): join-link fallback page + Android App Links statement.
    const jm = url.pathname.match(/^\/j\/([A-Za-z0-9._-]{1,512})$/);
    if (jm) {
      return new Response(joinPage(jm[1]), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/.well-known/assetlinks.json") {
      return new Response(assetlinks(env), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
      });
    }

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

      // Any successful add/update (201 created, or 204 updated/added-to-list) sends the
      // welcome email — so existing Brevo contacts who join the waitlist get it too.
      if (res.ok || res.status === 204) {
        const mail = await sendWelcome(env, email);
        return json({ ok: true, mail });
      }

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

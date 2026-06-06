// Cloudflare Pages advanced-mode worker.
// Handles POST /api/waitlist by adding the email to Brevo as a contact.
// The Brevo API key lives ONLY here, as an encrypted env var (BREVO_API_KEY) —
// it is never shipped to the browser. Everything else is served as a static asset.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
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
        updateEnabled: true, // idempotent: existing contacts are updated, not rejected
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
          headers: {
            "api-key": env.BREVO_API_KEY,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
      } catch {
        return json({ error: "upstream_unreachable" }, 502);
      }

      if (res.ok || res.status === 204) return json({ ok: true });

      let data = {};
      try { data = await res.json(); } catch {}
      // Already on the list = success from the user's point of view.
      if (res.status === 400 && data && data.code === "duplicate_parameter") {
        return json({ ok: true, duplicate: true });
      }
      return json({ error: "brevo_error", status: res.status, code: data && data.code }, 502);
    }

    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};

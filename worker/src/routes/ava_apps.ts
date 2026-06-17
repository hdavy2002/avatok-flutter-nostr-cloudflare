// ava_apps.ts — AvaApps: drive the user's connected Google apps (via Klavis MCP)
// from natural language, with the model running on the USER's own Gemini key.
//   POST /api/ava/apps/connect  {}            → { strataServerUrl, oauthUrls, servers }
//   GET  /api/ava/apps/status                 → { connected, servers }
//   POST /api/ava/apps/run      { query }     → { answer }   (X-Ava-Gemini-Key)
//
// Gemini decides which tools to call; Klavis (our account-wide key) executes them
// against the user's OAuth-connected accounts. We persist only the Strata URL.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { createStrata, getStrataUrl, listTools, callTool, KLAVIS_FREE_SERVERS } from "../lib/klavis";

// Function-calling runs on a Gemini model (Gemma can't); Flash-Lite is free.
const APPS_MODEL = "gemini-2.5-flash-lite";
const MAX_STEPS = 8;

function geminiKey(req: Request): string {
  return (req.headers.get("x-ava-gemini-key") || "").trim();
}

// POST /api/ava/apps/connect — create (or reuse) the user's Strata server for the
// free Google set and return the per-app OAuth URLs the client should open.
export async function avaAppsConnect(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.KLAVIS_API_KEY) return json({ error: "AvaApps not configured" }, 503);
  try {
    const r = await createStrata(env, ctx.uid, KLAVIS_FREE_SERVERS);
    return json({ ok: true, strataServerUrl: r.strataServerUrl, oauthUrls: r.oauthUrls, servers: KLAVIS_FREE_SERVERS });
  } catch (e: any) {
    return json({ error: "connect failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// GET /api/ava/apps/status — whether the user has a Strata server yet + the set.
export async function avaAppsStatus(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const url = await getStrataUrl(env, ctx.uid);
  return json({ ok: true, connected: !!url, servers: KLAVIS_FREE_SERVERS });
}

// POST /api/ava/apps/run — natural-language action across the user's apps.
export async function avaAppsRun(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!env.KLAVIS_API_KEY) return json({ error: "AvaApps not configured" }, 503);

  const key = geminiKey(req);
  if (!key) return json({ error: "connect Google AI Studio first (no key)" }, 400);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const query = String(b.query ?? "").trim();
  if (!query) return json({ error: "query required" }, 400);

  const strata = await getStrataUrl(env, ctx.uid);
  if (!strata) return json({ error: "no apps connected — tap Connect first" }, 400);

  try {
    const tools = await listTools(env, strata, "gemini");
    const answer = await runToolLoop(env, key, tools, strata, query);
    return json({ ok: true, answer });
  } catch (e: any) {
    return json({ error: "apps run failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// The Gemini function-calling loop: generate → execute any tool calls via Klavis
// → feed results back → repeat until the model returns a final text answer.
async function runToolLoop(env: Env, key: string, tools: any[], strata: string, query: string): Promise<string> {
  const sys = "You are Ava, a concise assistant that operates the user's connected apps (Gmail, Google Calendar/Docs/Drive/Sheets/Forms, etc.) via tools. Use tools to fulfil the request, then reply briefly with what you did or found.";
  const contents: any[] = [{ role: "user", parts: [{ text: query }] }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${APPS_MODEL}:generateContent`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents,
        ...(tools.length ? { tools } : {}),
      }),
    });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`gemini ${res.status}: ${JSON.stringify(out?.error ?? out).slice(0, 200)}`);

    const content = out?.candidates?.[0]?.content;
    if (!content?.parts) return "I couldn't generate a response.";
    contents.push(content);

    const calls = content.parts.filter((p: any) => p?.functionCall);
    if (calls.length === 0) {
      return content.parts
        .filter((p: any) => p?.thought !== true)
        .map((p: any) => String(p?.text ?? ""))
        .join("")
        .trim() || "Done.";
    }

    // Execute each requested tool against the user's Klavis Strata server.
    for (const c of calls) {
      const name = String(c.functionCall.name);
      let result: unknown;
      try {
        result = await callTool(env, strata, name, c.functionCall.args ?? {});
      } catch (e: any) {
        result = { error: String(e?.message ?? e).slice(0, 200) };
      }
      contents.push({ role: "tool", parts: [{ functionResponse: { name, response: { result } } }] });
    }
  }
  return "I reached the step limit before finishing that request.";
}

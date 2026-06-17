// ava_rag.ts — RAG ingestion routes (File Search under the user's own key).
//   POST /api/ava/rag/ingest   { text? , name?, mime?, contentB64? }   (key header)
//   GET  /api/ava/rag/store                                            (key header)
//
// The user's BYO Gemini key is forwarded via `X-Ava-Gemini-Key` (same header the
// gemini proxy + @ava turn use). The Worker is a pass-through: it creates the
// user's File Search store on first use and uploads the given text/bytes into it.
// Nothing is stored on our side except the store NAME (a string) in KV.

import type { Env } from "../types";
import { json } from "../util";
import { requireUser, isFail } from "../authz";
import { ensureStore, getStoreName, ingestText, ingestBytes } from "../lib/ava_rag";

function keyOf(req: Request): string {
  return (req.headers.get("x-ava-gemini-key") || "").trim();
}

// POST /api/ava/rag/ingest — index a note/chat-batch (text) or a file (base64).
export async function avaRagIngest(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const key = keyOf(req);
  if (!key) return json({ error: "connect Google AI Studio first (no key)" }, 400);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  const text = typeof b.text === "string" ? b.text.trim() : "";
  const name = String(b.name || "ava-memory").slice(0, 80);
  const b64 = typeof b.contentB64 === "string" ? b.contentB64 : "";
  if (!text && !b64) return json({ error: "text or contentB64 required" }, 400);

  try {
    const out = text
      ? await ingestText(env, ctx.uid, key, name, text)
      : await ingestBytes(env, ctx.uid, key, name, String(b.mime || "application/octet-stream"), b64);
    return json({ ok: true, ...out });
  } catch (e: any) {
    return json({ error: "ingest failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

// GET /api/ava/rag/store — get-or-create the user's store; returns its name.
export async function avaRagStore(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const key = keyOf(req);
  try {
    if (!key) {
      const existing = await getStoreName(env, ctx.uid);
      return json({ ok: true, store: existing });
    }
    const store = await ensureStore(env, ctx.uid, key);
    return json({ ok: true, store });
  } catch (e: any) {
    return json({ error: "store failed", detail: String(e?.message ?? e).slice(0, 200) }, 502);
  }
}

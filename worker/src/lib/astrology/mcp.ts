// [AUMFE-ASTRO-CLIENT-1] Minimal MCP (Streamable HTTP, JSON-RPC 2.0) client for mcp.astrologyapi.com: ~111 tools
// the LLM can call directly. Stateless: each call initializes, then runs one request (the server answered with
// plain application/json when probed; text/event-stream "data:" lines are handled defensively).
import type { Env } from "../../types";
import { track, trackException } from "../../hooks";

const MCP_URL = "https://mcp.astrologyapi.com/mcp";
const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 10_000;
const LIST_TTL_MS = 10 * 60_000;

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, any> }

let listCache: { at: number; tools: McpTool[] } | null = null;
let rpcId = 0;

/** POST one JSON-RPC message; returns the parsed JSON-RPC response object. Throws on transport problems. */
async function rpc(env: Env, method: string, params: unknown, session?: string): Promise<{ msg: any; session: string | null }> {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "x-astrologyapi-key": env.ASTROLOGYAPI_KEY as string,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": PROTOCOL } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mcp_http_${res.status}`);
  const text = await res.text();
  let msg: any;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const datas = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    msg = datas.map((d) => JSON.parse(d)).find((m) => m && ("result" in m || "error" in m));
  } else {
    msg = JSON.parse(text);
  }
  if (!msg) throw new Error("mcp_empty_response");
  return { msg, session: res.headers.get("Mcp-Session-Id") };
}

async function session(env: Env): Promise<string | undefined> {
  const init = await rpc(env, "initialize", {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "saathum-worker", version: "1" },
  });
  if (init.msg.error) throw new Error(`mcp_init_${init.msg.error.code ?? "err"}`);
  return init.session ?? undefined;
}

export async function mcpListTools(env: Env): Promise<McpTool[] | { error: string }> {
  if (!env.ASTROLOGYAPI_KEY) return { error: "astro_not_configured" };
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.tools;
  try {
    const s = await session(env);
    const { msg } = await rpc(env, "tools/list", {}, s);
    if (msg.error) return { error: String(msg.error.message ?? "mcp_error") };
    const tools: McpTool[] = Array.isArray(msg.result?.tools) ? msg.result.tools : [];
    listCache = { at: Date.now(), tools };
    return tools;
  } catch (e) {
    void trackException(env, e, { handled: true, route: "astro_mcp_list" });
    return { error: "astro_mcp_unavailable" };
  }
}

/** Runs one tool; returns the parsed JSON the tool produced, or { error }. */
export async function mcpCallTool(env: Env, name: string, args: Record<string, unknown>, uid = "system"): Promise<any> {
  if (!env.ASTROLOGYAPI_KEY) return { error: "astro_not_configured" };
  const t0 = Date.now();
  let out: any;
  try {
    const s = await session(env);
    const { msg } = await rpc(env, "tools/call", { name, arguments: args }, s);
    if (msg.error) out = { error: String(msg.error.message ?? "mcp_error") };
    else {
      const text = msg.result?.content?.[0]?.text;
      try { out = JSON.parse(text); } catch { out = msg.result?.isError ? { error: String(text ?? "mcp_tool_error") } : { text: String(text ?? "") }; }
      if (msg.result?.isError && !out.error) out = { error: String(text ?? "mcp_tool_error") };
    }
  } catch (e) {
    void trackException(env, e, { handled: true, route: "astro_mcp_call", extra: { tool: name } });
    out = { error: (e as { name?: string })?.name === "TimeoutError" ? "astro_timeout" : "astro_mcp_unavailable" };
  }
  void track(env, uid, "astro_api_call", "saathum", { endpoint: `mcp:${name}`, cached: false, ms: Date.now() - t0, ok: !out?.error, status: out?.error ? 0 : 200 });
  return out;
}

// Gemini accepts a subset of OpenAPI: UPPERCASE types, no $schema/additionalProperties/etc.
const GEMINI_KEEP = new Set(["type", "description", "properties", "required", "items", "enum", "format", "nullable"]);

export function toGeminiSchema(s: any): any {
  if (!s || typeof s !== "object") return { type: "STRING" };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!GEMINI_KEEP.has(k)) continue;
    if (k === "type") out.type = String(Array.isArray(v) ? (v.find((t) => t !== "null") ?? "string") : v).toUpperCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === "items") out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (!out.type) out.type = out.properties ? "OBJECT" : "STRING";
  return out;
}

export function toGeminiFunctionDeclarations(tools: McpTool[], allowlist: string[]) {
  const allowed = new Set(allowlist);
  return tools.filter((t) => allowed.has(t.name)).map((t) => {
    const params = toGeminiSchema({ type: "object", ...(t.inputSchema ?? {}) });
    return {
      name: t.name,
      description: (t.description ?? t.name).slice(0, 1000),
      // Gemini rejects an OBJECT with no properties
      ...(params.properties && Object.keys(params.properties).length ? { parameters: params } : {}),
    };
  });
}

/** Test hook. */
export function _resetMcpCache(): void { listCache = null; }

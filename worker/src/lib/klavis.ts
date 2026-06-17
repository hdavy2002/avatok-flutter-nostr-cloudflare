// klavis.ts — Klavis MCP integration for AvaApps.
//
// Klavis hosts MCP servers for 100+ SaaS apps and handles their OAuth. We bundle
// the free Google set into ONE per-user "Strata" server, then drive it from
// Gemini function-calling (the model runs on the USER's own Gemini key; Klavis —
// our account-wide key — executes the tool calls against the user's connected
// accounts). Docs: https://www.klavis.ai/docs/ai-platform-integration/gemini
//
// We persist only the per-user Strata server URL (KV) — never the user's app data.

import type { Env } from "../types";

const KLAVIS = "https://api.klavis.ai";

/// The free tier of AvaApps — Klavis server names (case-insensitive on their end).
export const KLAVIS_FREE_SERVERS = [
  "Gmail",
  "Google Calendar",
  "Google Docs",
  "Google Drive",
  "Google Sheets",
  "Google Forms",
  "Google Jobs",
  "Google Cloud",
];

function strataKey(uid: string): string {
  return `ava_apps_strata:${uid}`;
}

async function kfetch(env: Env, path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${KLAVIS}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.KLAVIS_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || j?.success === false) {
    throw new Error(`klavis ${path} ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  }
  return j;
}

/** The remembered Strata server URL for a user (null if not created yet). */
export async function getStrataUrl(env: Env, uid: string): Promise<string | null> {
  try { return (await env.TOKENS.get(strataKey(uid))) || null; } catch { return null; }
}

export interface StrataResult {
  strataServerUrl: string;
  oauthUrls: Record<string, string>; // serverName → OAuth URL (empty when already authed)
}

/** Get-or-create the user's Strata server bundling [servers]; returns OAuth URLs. */
export async function createStrata(env: Env, uid: string, servers: string[]): Promise<StrataResult> {
  const j = await kfetch(env, "/mcp-server/strata/create", {
    method: "POST",
    body: JSON.stringify({ servers, userId: uid }),
  });
  const url = String(j.strataServerUrl ?? j.strata_server_url ?? "");
  const oauth = (j.oauthUrls ?? j.oauth_urls ?? {}) as Record<string, string>;
  if (url) await env.TOKENS.put(strataKey(uid), url);
  return { strataServerUrl: url, oauthUrls: oauth };
}

/** List the Strata server's tools in a given LLM format (default Gemini). */
export async function listTools(env: Env, serverUrl: string, format = "gemini"): Promise<any[]> {
  const j = await kfetch(env, "/mcp-server/list-tools", {
    method: "POST",
    body: JSON.stringify({ serverUrl, format }),
  });
  return Array.isArray(j.tools) ? j.tools : [];
}

/** Execute one tool on the Strata server. Returns Klavis's CallToolResult. */
export async function callTool(env: Env, serverUrl: string, toolName: string, toolArgs: unknown): Promise<any> {
  const j = await kfetch(env, "/mcp-server/call-tool", {
    method: "POST",
    body: JSON.stringify({ serverUrl, toolName, toolArgs: toolArgs ?? {} }),
  });
  return j.result ?? j;
}

// Commercial observability contract. Only bounded, non-secret dimensions leave
// the Worker. Provider tokens, API keys, signed URLs, raw payloads and provider
// credentials are rejected before they reach PostHog or Analytics Engine.

import type { Env } from "../types";
import { metric, track } from "../hooks";

const SECRET_KEY = /(token|secret|password|authorization|credential|api[_-]?key|jwt|signature|payload|raw|url)/i;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_STRING = 160;

function safeValue(value: unknown): string | number | boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const compact = value.trim().slice(0, MAX_STRING);
    if (/eyJ[A-Za-z0-9_-]{6,}\./i.test(compact) || /bearer\s+/i.test(compact)
      || /(?:sk|rk|pk)_[A-Za-z0-9]{10,}/.test(compact)) return "[redacted]";
    return compact;
  }
  return null;
}

/** Emit one structured commercial event with a strict scalar-only allowlist. */
export function commercialEvent(
  env: Env,
  event: string,
  uid: string | null,
  props: Record<string, unknown> = {},
): void {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!SAFE_KEY.test(key) || SECRET_KEY.test(key)) continue;
    const scalar = safeValue(value);
    if (scalar !== null) safe[key] = scalar;
  }
  safe.lane = "commercial";
  safe.schema_version = 1;
  const name = event.replace(/[^a-z0-9_]/gi, "_").slice(0, 64);
  void track(env, uid ?? "server", `commercial_${name}`, "commercial", safe).catch(() => undefined);
  metric(env, `commercial_${name}`, [1], [String(safe.kind ?? "unknown"), String(safe.outcome ?? "unknown")]);
}


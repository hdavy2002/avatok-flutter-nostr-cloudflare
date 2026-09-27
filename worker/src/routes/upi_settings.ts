// [SAATHUM-UPI-SETTINGS 2026-09-27] /admin → UPI settings.
//   GET /api/admin/upi-settings   admin — saved value, what checkout is using
//                                 right now, rail status, last bank SMS seen.
//   PUT /api/admin/upi-settings   admin — { vpa, payee_name }; empty vpa
//                                 clears the admin value (secret fallback).
import type { Env } from "../types";
import { json } from "../util";
import { requireAdmin } from "./admin_money";
import { track } from "../hooks";
import { metaDb } from "../db/shard";
import { policy } from "../lib/hdfc_sms_smoke";
import { UPI_SETTINGS_KEY, VPA_RE, clearUpiSettingsCache, readUpiSettings, type UpiSettings } from "../lib/upi_settings";

const NO_STORE = { "cache-control": "private, no-store" };

async function status(env: Env) {
  const [saved, p] = await Promise.all([readUpiSettings(env), policy(env)]);
  let lastSmsAt: number | null = null;
  try {
    const r = await metaDb(env).prepare("SELECT MAX(ingested_at) AS at FROM hdfc_sms_smoke_receipts").first<{ at: number | null }>();
    lastSmsAt = r?.at ?? null;
  } catch { /* table missing on a fresh env */ }
  return {
    saved,
    active: { vpa: p.vpa || null, payee_name: p.payee_name, source: p.vpa_source },
    rail: { enabled: p.enabled, reason: p.reason },
    last_bank_sms_at: lastSmsAt,
  };
}

export async function getUpiSettings(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  return json(await status(env), 200, NO_STORE);
}

export async function putUpiSettings(req: Request, env: Env): Promise<Response> {
  const a = await requireAdmin(req, env); if (a instanceof Response) return a;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return json({ error: "bad_request", message: "Send the UPI details as JSON." }, 400);
  const vpa = typeof body.vpa === "string" ? body.vpa.trim() : "";
  const payee = typeof body.payee_name === "string" ? body.payee_name.trim() : "";
  if (vpa && !VPA_RE.test(vpa)) return json({ error: "bad_vpa", field: "vpa", message: "That doesn’t look like a UPI ID. It should look like name@bank, e.g. saathum@hdfcbank." }, 400);
  if (payee.length > 60 || /[\u0000-\u001f\u007f]/.test(payee)) return json({ error: "bad_payee", field: "payee_name", message: "Payee name must be 60 characters or fewer." }, 400);

  const before = await readUpiSettings(env);
  const next: UpiSettings = { vpa: vpa || null, payee_name: payee || null, updated_at: Date.now(), updated_by: a.uid };
  await env.TOKENS.put(UPI_SETTINGS_KEY, JSON.stringify(next));
  clearUpiSettingsCache();
  try {
    await env.DB_WALLET.prepare(
      "INSERT INTO admin_audit (id, admin_id, action, target, meta, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ).bind(crypto.randomUUID(), a.uid, "upi_settings_update", "upi_settings", JSON.stringify({ before, after: next }), next.updated_at).run();
  } catch { /* best-effort, like pricing */ }
  try {
    await track(env, a.uid, "admin_upi_settings_updated", "admin_upi_settings", {
      admin_id: a.uid, vpa_set: Boolean(next.vpa), vpa_changed: before.vpa !== next.vpa, payee_changed: before.payee_name !== next.payee_name,
    });
  } catch { /* best-effort */ }
  return json({ ok: true, ...(await status(env)) }, 200, NO_STORE);
}

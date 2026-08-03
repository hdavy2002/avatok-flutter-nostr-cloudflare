import type { Env } from "../types";
import { normalizePhone, sha256Hex } from "../util";

export type ContactPolicy =
  | { known: false; saved: false; reason: "device_directory_not_synced" | "lookup_failed" }
  | { known: true; saved: boolean; matched_by: "uid" | "phone" | "none" };

/**
 * An address-book result is classification, not permission to divert a call.
 * Automatic receptionist routing is a separate, explicit policy switch. Keeping
 * this decision pure makes it impossible for a completed contact sync to
 * silently change ordinary AvaTOK calling behaviour again.
 */
export function shouldRouteUnknownAvatokCaller(
  policy: ContactPolicy,
  enabled: boolean,
): boolean {
  return enabled && policy.known && !policy.saved;
}

const UID_RE = /^user_[A-Za-z0-9_-]{4,160}$/;

function validPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e164 = normalizePhone(raw);
  return e164.replace(/\D/g, "").length >= 6 ? e164 : null;
}

async function replaceSource(
  env: Env,
  ownerUid: string,
  source: "avatok" | "device",
  rows: Array<{ key: string; uid: string | null; hash: string | null }>,
): Promise<void> {
  const now = Date.now();
  // Remove the authority marker first. A partial/failed rebuild therefore
  // fails open to a normal human ring; it can never misclassify someone as an
  // unknown caller from an incomplete directory.
  await env.DB_META.batch([
    env.DB_META.prepare(
      "DELETE FROM call_contact_directory_sync WHERE owner_uid=?1 AND source=?2",
    ).bind(ownerUid, source),
    env.DB_META.prepare(
      "DELETE FROM call_contact_directory WHERE owner_uid=?1 AND source=?2",
    ).bind(ownerUid, source),
  ]);
  for (let i = 0; i < rows.length; i += 80) {
    await env.DB_META.batch(rows.slice(i, i + 80).map((r) => env.DB_META.prepare(
      `INSERT INTO call_contact_directory
       (owner_uid, contact_key, contact_uid, phone_hash, source, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(ownerUid, r.key, r.uid, r.hash, source, now)));
  }
  await env.DB_META.prepare(
    `INSERT INTO call_contact_directory_sync(owner_uid, source, count, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(owner_uid, source) DO UPDATE SET count=?3, updated_at=?4`,
  ).bind(ownerUid, source, rows.length, now).run();
}

export async function replaceDeviceCallDirectory(
  env: Env,
  ownerUid: string,
  contacts: unknown[],
): Promise<number> {
  const hashes = new Set<string>();
  for (const value of contacts) {
    const c = value as { number?: unknown; avatokNumber?: unknown } | null;
    for (const raw of [c?.number, c?.avatokNumber]) {
      const phone = validPhone(raw);
      if (phone) hashes.add(await sha256Hex(phone));
    }
  }
  const rows = Array.from(hashes).map((hash) => ({
    key: `phone:${hash}`, uid: null, hash,
  }));
  await replaceSource(env, ownerUid, "device", rows);
  return rows.length;
}

export async function replaceAvatokCallDirectory(
  env: Env,
  ownerUid: string,
  contactUids: unknown[],
): Promise<number> {
  const uids = Array.from(new Set(contactUids
    .filter((v): v is string => typeof v === "string" && UID_RE.test(v))
    .filter((uid) => uid !== ownerUid)))
    .slice(0, 5000);
  await replaceSource(env, ownerUid, "avatok", uids.map((uid) => ({
    key: `uid:${uid}`, uid, hash: null,
  })));
  return uids.length;
}

/** Authoritative only after the device directory has completed one sync. */
export async function callerContactPolicy(
  env: Env,
  ownerUid: string,
  callerUid: string,
): Promise<ContactPolicy> {
  try {
    const synced = await env.DB_META.prepare(
      "SELECT 1 AS x FROM call_contact_directory_sync WHERE owner_uid=?1 AND source='device' LIMIT 1",
    ).bind(ownerUid).first<{ x: number }>();
    if (!synced) return { known: false, saved: false, reason: "device_directory_not_synced" };

    const direct = await env.DB_META.prepare(
      "SELECT 1 AS x FROM call_contact_directory WHERE owner_uid=?1 AND contact_uid=?2 LIMIT 1",
    ).bind(ownerUid, callerUid).first<{ x: number }>();
    if (direct) return { known: true, saved: true, matched_by: "uid" };

    const caller = await env.DB_META.prepare(
      "SELECT phone_hash FROM users WHERE uid=?1 LIMIT 1",
    ).bind(callerUid).first<{ phone_hash: string | null }>();
    if (caller?.phone_hash) {
      const phone = await env.DB_META.prepare(
        "SELECT 1 AS x FROM call_contact_directory WHERE owner_uid=?1 AND phone_hash=?2 LIMIT 1",
      ).bind(ownerUid, caller.phone_hash).first<{ x: number }>();
      if (phone) return { known: true, saved: true, matched_by: "phone" };
    }
    return { known: true, saved: false, matched_by: "none" };
  } catch {
    return { known: false, saved: false, reason: "lookup_failed" };
  }
}

// CSAM gate — runs BEFORE any AI scan, fail-closed when configured.
//
// IMPORTANT POSTURE:
//  • While UNCONFIGURED (csam_hashes table empty AND CSAM_API_URL unset) the gate
//    is a no-op — it bypasses, so it doesn't block uploads until you have access.
//  • Once you load NCMEC/PhotoDNA hash lists into csam_hashes and/or set
//    CSAM_API_URL (PhotoDNA proxy / Thorn Safer), it activates automatically.
//  • When the external matcher is configured but ERRORS, we FAIL CLOSED
//    (quarantine for human review) rather than publish.
//
// This is NOT a model decision. CSAM is detected by hash-matching against vetted
// databases and is a legal compliance flow (US 18 U.S.C. §2258A → NCMEC
// CyberTipline; India POCSO Act + IT Rules). The exact report + evidence-
// PRESERVATION flow (you may be legally required to preserve bytes, not delete
// them) must be finalized with counsel — see handleCsam() notes.
import type { Env } from "./types";

export interface CsamResult { match: boolean; source?: string; failClosed?: boolean }

// Exact-hash check against an admin/NCMEC-loaded list. Cheap, indexed, runs on
// every scan. Empty table ⇒ always null ⇒ effectively bypassed.
export async function csamCheckHash(env: Env, sha256: string): Promise<string | null> {
  try {
    const row = await env.DB_MODERATION.prepare(
      "SELECT source FROM csam_hashes WHERE algo='sha256' AND value=?1 LIMIT 1",
    ).bind(sha256).first<{ source: string }>();
    return row?.source ?? null;
  } catch { return null; } // table not migrated yet → bypass
}

// External robust-hash matcher (PhotoDNA / Thorn Safer). Bypasses when unset;
// fail-closed on error when set.
export async function csamGate(env: Env, sha256: string, bytes: Uint8Array): Promise<CsamResult> {
  if (!env.CSAM_API_URL) return { match: false }; // not configured → bypass
  try {
    const res = await fetch(env.CSAM_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.CSAM_API_KEY ? { Authorization: `Bearer ${env.CSAM_API_KEY}` } : {}),
      },
      // Adapter contract: send the image; vendors differ — tweak this body + the
      // match parse for your provider (PhotoDNA proxy / Thorn Safer).
      body: JSON.stringify({ sha256, image_base64: toBase64(bytes) }),
    });
    if (!res.ok) { console.error("CSAM matcher error", res.status); return { match: false, failClosed: true }; }
    const j = (await res.json()) as any;
    const match = j.match === true || j.is_csam === true || j.result === "match";
    return match ? { match: true, source: "external_matcher" } : { match: false };
  } catch (e) {
    console.error("CSAM matcher exception", String(e));
    return { match: false, failClosed: true }; // configured but unreachable → quarantine
  }
}

// On a confirmed CSAM match: stop serving, perm-ban, file a report, blocklist the
// hash. NOTE ON PRESERVATION: US law generally requires PRESERVING the content
// (not deleting) and reporting to NCMEC. Here we delete from the PUBLIC bucket to
// stop serving; wiring a locked evidence copy + the NCMEC CyberTipline filing is a
// legal decision — do it with counsel before this path goes live. We do NOT
// notify the uploader (no tipping-off).
export async function handleCsam(
  env: Env, args: { hash: string; r2Key: string; media_id: string; uid: string; source: string },
): Promise<void> {
  const { hash, r2Key, media_id, uid, source } = args;
  const now = Date.now();

  // TODO(legal): before delete, copy bytes to a locked evidence bucket for
  // preservation per NCMEC/§2258A. Left out deliberately pending counsel sign-off.
  await env.BLOBS.delete(r2Key);
  await env.DB_MEDIA.prepare("UPDATE user_media SET moderation_status='rejected' WHERE id=?1").bind(media_id).run();

  // Catch re-uploads via the normal blocklist (category csam).
  await env.DB_MODERATION.prepare(
    `INSERT OR IGNORE INTO blocked_media_hashes (id,hash_type,hash_value,category,source,original_uploader_npub,created_at)
     VALUES (?1,'sha256',?2,'csam',?3,?4,?5)`,
  ).bind(crypto.randomUUID(), hash, source, uid, now).run();

  // P1 report row (1-hour SLA) + permanent ban.
  await env.DB_MODERATION.prepare(
    `INSERT INTO user_reports (id,reporter_npub,reported_npub,content_kind,content_id,category,description,status,priority,created_at)
     VALUES (?1,'system',?2,'image',?3,'csam',?4,'open',1,?5)`,
  ).bind(crypto.randomUUID(), uid, hash, `auto:${source}`, now).run();
  await permBan(env, uid, "csam");

  try { env.ANALYTICS?.writeDataPoint({ blobs: ["csam_block", source], doubles: [1], indexes: ["csam"] }); } catch { /* best-effort */ }
  await reportCsam(env, { hash, uid, source, ts: now });
}

async function permBan(env: Env, uid: string, reason: string): Promise<void> {
  const link = await env.DB_META.prepare("SELECT clerk_user_id FROM clerk_nostr_link WHERE uid=?1")
    .bind(uid).first<{ clerk_user_id: string }>();
  const clerkId = link?.clerk_user_id ?? uid;
  await env.DB_META.prepare(
    `INSERT INTO account_status (clerk_user_id,uid,status,reason,blocked_until,blocked_at)
     VALUES (?1,?2,'perm_banned',?3,NULL,?4)
     ON CONFLICT(clerk_user_id) DO UPDATE SET status='perm_banned', reason=?3, blocked_at=?4`,
  ).bind(clerkId, uid, reason, Date.now()).run();
}

// Report hook. Wire CSAM_REPORT_URL to your NCMEC-filing service. Sends metadata
// only (hash/uid/ts) — NOT the bytes — by default.
async function reportCsam(env: Env, r: { hash: string; uid: string; source: string; ts: number }): Promise<void> {
  if (!env.CSAM_REPORT_URL) { console.error("CSAM detected but CSAM_REPORT_URL unset — report NOT filed", r.hash); return; }
  try {
    await fetch(env.CSAM_REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(env.CSAM_REPORT_KEY ? { Authorization: `Bearer ${env.CSAM_REPORT_KEY}` } : {}) },
      body: JSON.stringify(r),
    });
  } catch (e) { console.error("CSAM report POST failed", String(e)); }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

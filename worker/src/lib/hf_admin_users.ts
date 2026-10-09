// [HF-ADMIN-CREDIT-1] Admin lookup of a caller by WhatsApp number, email, name or uid, for test credits.
// Storage facts: users.phone_hash / contact_verification.phone_hash are sha256(E.164 with "+"); the readable number is the
// latest verified phone_otp.e164 (or users.private_number). Email exists in D1 only as a sha256 hash, so a partial email
// is resolved through Clerk's own search and the readable email comes from emailFor (KV cached).
import type { Env } from "../types";
import { sha256Hex } from "../util";
import { emailFor } from "./identity";
import { phoneSql, personName } from "./admin2_people_data";
import { hfWalletBalance } from "./hf_calls_store";
import { clerkSearch } from "../routes/admin2_users";
import { escapeLike, searchable, type AdminQuery } from "./hf_admin_search";

export interface AdminUserHit {
  uid: string; name: string | null; phone: string | null; email: string | null; whatsappVerified: boolean;
  isHost: boolean; hostSlug?: string; balanceRupees: number; createdAt: number | null;
}
interface Row {
  uid: string; display_name: string | null; first_name: string | null; last_name: string | null; created_at: number | null;
  phone: string | null; wa: number | null; host_slug: string | null; host_uid: string | null;
}

/** Candidate uids only (no balances / emails), at most `limit`. */
async function findRows(env: Env, q: AdminQuery, limit: number): Promise<Row[]> {
  if (!searchable(q)) return [];
  const binds: unknown[] = [];
  const ref = (v: unknown) => { binds.push(v); return `?${binds.length}`; };
  const ors: string[] = [];
  if (q.type === "uid") {
    ors.push(`u.uid=${ref(q.text)}`);
    if (q.text.length >= 8) ors.push(`u.uid LIKE ${ref(`${escapeLike(q.text)}%`)} ESCAPE '\\'`);
  } else if (q.type === "phone") {
    const h = ref(await sha256Hex(q.e164!));
    const suf = ref(`%${q.suffix}`);
    ors.push(
      `u.phone_hash=${h}`,
      `u.uid IN (SELECT cv.uid FROM contact_verification cv WHERE cv.phone_hash=${h})`,
      `u.uid IN (SELECT po.uid FROM phone_otp po WHERE po.status='verified' AND (po.phone_hash=${h} OR po.e164 LIKE ${suf}))`,
      `u.private_number LIKE ${suf}`,
    );
  } else if (q.type === "email") {
    const h = ref(await sha256Hex(q.text));
    ors.push(`u.email_hash=${h}`, `u.uid IN (SELECT cv.uid FROM contact_verification cv WHERE cv.email_hash=${h})`);
    if (q.text.length >= 3) {
      const ids = (await clerkSearch(env, q.text).catch(() => [] as string[])).slice(0, 40);
      if (ids.length) ors.push(`u.uid IN (${ids.map((id) => ref(id)).join(",")})`);
    }
  } else {
    const like = ref(`%${escapeLike(q.text.toLowerCase())}%`);
    ors.push(
      `lower(COALESCE(u.display_name,'')) LIKE ${like} ESCAPE '\\'`,
      `lower(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) LIKE ${like} ESCAPE '\\'`,
      `u.uid IN (SELECT hh.uid FROM hf_hosts hh WHERE lower(COALESCE(hh.display_name,'')) LIKE ${like} ESCAPE '\\')`,
    );
  }
  const lim = ref(limit);
  const rs = await env.DB_META.prepare(
    `SELECT u.uid AS uid, u.display_name, u.first_name, u.last_name, u.created_at, ${phoneSql("u.uid", "u")} AS phone,
            (SELECT cv.phone_verified FROM contact_verification cv WHERE cv.uid=u.uid) AS wa,
            h.slug AS host_slug, h.uid AS host_uid
       FROM users u LEFT JOIN hf_hosts h ON h.uid=u.uid
      WHERE ${ors.join(" OR ")} ORDER BY u.created_at DESC LIMIT ${lim}`,
  ).bind(...binds).all<Row>();
  return rs.results ?? [];
}

/** Search for the admin picker: up to 20 users with full phone, email and wallet balance. */
export async function searchHfUsers(env: Env, q: AdminQuery): Promise<AdminUserHit[]> {
  const rows = await findRows(env, q, 20);
  const out: AdminUserHit[] = [];
  for (let i = 0; i < rows.length; i += 8) {
    const chunk = rows.slice(i, i + 8);
    const got = await Promise.all(chunk.map(async (r) => {
      const [email, bal] = await Promise.all([emailFor(env, r.uid).catch(() => null), hfWalletBalance(env, r.uid).catch(() => 0)]);
      const hit: AdminUserHit = {
        uid: r.uid, name: personName(r), phone: r.phone ?? null, email, whatsappVerified: Number(r.wa) === 1,
        isHost: !!r.host_uid, balanceRupees: bal, createdAt: r.created_at != null ? Number(r.created_at) : null,
      };
      if (r.host_slug) hit.hostSlug = r.host_slug;
      return hit;
    }));
    out.push(...got);
  }
  return out;
}

/** Resolves a phone to exactly one user for the credit route (up to 2 rows is enough to detect ambiguity). */
export async function resolvePhone(env: Env, q: AdminQuery): Promise<{ uid: string; name: string | null }[]> {
  return (await findRows(env, q, 2)).map((r) => ({ uid: r.uid, name: personName(r) }));
}

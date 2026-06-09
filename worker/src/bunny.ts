// Bunny.net Stream helper — per-user organization + deletion.
// Each user's videos live in their OWN Bunny "collection" (folder), keyed by uid
// in bunny_collections (DB_META). The actual video-upload flow (TUS/resumable) is
// a future client feature; it must call ensureUserCollection() so every video is
// filed under the right user. deleteUserVideos() removes everything on account delete.
// All functions are gated: no BUNNY_API_KEY / BUNNY_LIBRARY_ID → no-op.
import type { Env } from "./types";
import { metaDb } from "./db/shard";

const BASE = "https://video.bunnycdn.com";

function configured(env: Env): boolean {
  return !!(env.BUNNY_API_KEY && env.BUNNY_LIBRARY_ID);
}
function headers(env: Env): Record<string, string> {
  return { AccessKey: env.BUNNY_API_KEY!, accept: "application/json", "content-type": "application/json" };
}

/** Get (or create) the user's Bunny collection GUID. Returns null if unconfigured. */
export async function ensureUserCollection(env: Env, uid: string): Promise<string | null> {
  if (!configured(env)) return null;
  const row = await metaDb(env).prepare("SELECT collection_id FROM bunny_collections WHERE uid=?1").bind(uid).first<{ collection_id: string }>();
  if (row?.collection_id) return row.collection_id;
  try {
    const res = await fetch(`${BASE}/library/${env.BUNNY_LIBRARY_ID}/collections`, {
      method: "POST", headers: headers(env), body: JSON.stringify({ name: uid }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const id = data.guid || data.Guid;
    if (!id) return null;
    await metaDb(env).prepare("INSERT OR REPLACE INTO bunny_collections (uid, collection_id, created_at) VALUES (?1,?2,?3)")
      .bind(uid, id, Date.now()).run();
    return id;
  } catch { return null; }
}

/** Delete every video in the user's collection, then the collection + the mapping. */
export async function deleteUserVideos(env: Env, uid: string): Promise<number> {
  if (!configured(env)) return 0;
  const row = await metaDb(env).prepare("SELECT collection_id FROM bunny_collections WHERE uid=?1").bind(uid).first<{ collection_id: string }>();
  const lib = env.BUNNY_LIBRARY_ID;
  let deleted = 0;
  if (row?.collection_id) {
    try {
      // List videos in the collection (paged) and delete each.
      for (let page = 1; page <= 50; page++) {
        const res = await fetch(`${BASE}/library/${lib}/videos?page=${page}&itemsPerPage=100&collection=${row.collection_id}`, { headers: headers(env) });
        if (!res.ok) break;
        const data = (await res.json()) as any;
        const items: any[] = data.items || data.Items || [];
        if (!items.length) break;
        for (const v of items) {
          const vid = v.guid || v.Guid;
          if (!vid) continue;
          try { await fetch(`${BASE}/library/${lib}/videos/${vid}`, { method: "DELETE", headers: headers(env) }); deleted++; } catch { /* continue */ }
        }
        if (items.length < 100) break;
      }
      // Delete the (now-empty) collection.
      try { await fetch(`${BASE}/library/${lib}/collections/${row.collection_id}`, { method: "DELETE", headers: headers(env) }); } catch { /* noop */ }
    } catch { /* best-effort */ }
    await metaDb(env).prepare("DELETE FROM bunny_collections WHERE uid=?1").bind(uid).run();
  }
  return deleted;
}

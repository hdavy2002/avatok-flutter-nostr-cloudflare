// [AUMFE-DESIGN-MATCH-1 2026-10-01] Keep the catalog vector in step with a shop product after an admin save.
// One small call from routes/admin2_shop_catalog.ts. A failure here is reported but never breaks the save.
import type { Env } from "../../types";
import { track, trackException } from "../../hooks";
import { APP } from "./common";
import { getNote, indexSubjectNote, removeSubject } from "./catalog";

/** The product fields that decide whether an approved note still describes the product. */
export interface ProductSnapshot {
  name: string; images_json: string; colours_json: string; print_type: string; status: string; archived_at: number | null;
}
export type SyncAction = "none" | "remove" | "reindex" | "revert_draft";

export const isLive = (p: Pick<ProductSnapshot, "status" | "archived_at"> | null | undefined): boolean =>
  !!p && p.status === "live" && !p.archived_at;

/** Name, images, colours or print type changed: the approved note was written for different content. */
export function designChanged(prev: ProductSnapshot | null, cur: ProductSnapshot): boolean {
  if (!prev) return false;
  return prev.name !== cur.name || prev.images_json !== cur.images_json || prev.colours_json !== cur.colours_json || prev.print_type !== cur.print_type;
}

/**
 * Pure decision. `note` is the existing note's status + whether a vector is recorded (null = no note).
 *  - not live anymore            -> remove the vector (only when a note/vector exists)
 *  - live, approved, design edit -> back to draft + remove the vector
 *  - live, approved              -> re-index so active/in_stock metadata stays right
 */
export function decideSync(prev: ProductSnapshot | null, cur: ProductSnapshot | null, note: { status: string; vector_id: string | null } | null): SyncAction {
  if (!note) return "none";
  if (!cur || !isLive(cur)) return note.status === "approved" || note.vector_id ? "remove" : "none";
  if (note.status !== "approved") return "none";
  return designChanged(prev, cur) ? "revert_draft" : "reindex";
}

export interface ProductChange { prev: ProductSnapshot | null }

export async function onShopProductChanged(env: Env, id: string, change: ProductChange): Promise<SyncAction | "error"> {
  try {
    const cur = await env.DB_META.prepare(
      `SELECT name, images_json, colours_json, print_type, status, archived_at FROM shop_products WHERE id=?1`,
    ).bind(id).first<ProductSnapshot>();
    const note = await getNote(env, "shop_product", id);
    const action = decideSync(change.prev, cur ?? null, note ? { status: note.status, vector_id: note.vector_id } : null);
    if (action === "remove") await removeSubject(env, "shop_product", id);
    else if (action === "reindex") await indexSubjectNote(env, "shop_product", id);
    else if (action === "revert_draft") {
      await env.DB_META.prepare(
        `UPDATE product_tradition_notes SET status='draft', approved_by=NULL, approved_at=NULL, updated_at=?1 WHERE subject_kind='shop_product' AND subject_id=?2`,
      ).bind(Date.now(), id).run();
      await removeSubject(env, "shop_product", id);
    }
    if (action !== "none") void track(env, "server", "knowledge_product_synced", APP, { product_id: id, action });
    return action;
  } catch (e) {
    void trackException(env, e, { route: "knowledge.onShopProductChanged", handled: true, app_name: APP, extra: { product_id: id } });
    return "error";
  }
}

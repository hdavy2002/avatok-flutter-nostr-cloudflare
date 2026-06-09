// AvaOLX (Phase 5, §10.6). Tables in DB_MEDIA. Physical = free classifieds (contact
// via AvaChat). Digital = AvaCoins-priced, Tier-2 to list, signed R2 download, 24h
// refund if not downloaded. Browse = Tier 1 (open); list/sell = Tier 2.
//   POST   /api/olx/listings              create (digital body = bytes after JSON header? no — separate upload)
//   GET    /api/olx/listings              browse (?kind=&category=&seller=)
//   GET    /api/olx/listings/:id          one listing
//   PUT    /api/olx/listings/:id          edit
//   DELETE /api/olx/listings/:id          close
//   POST   /api/olx/listings/:id/file     upload the digital deliverable (seller only)
//   POST   /api/olx/buy                   buy a digital product { listing_id }
//   GET    /api/olx/downloads             my purchases
//   GET    /api/olx/downloads/:id/file    signed download (marks downloaded)
import type { Env } from "../types";
import { json, sha256Hex } from "../util";
import { requireUser, isFail, kycVerified } from "../authz";
import { mediaSession, mediaDb } from "../db/shard";
import { transferCoins } from "./wallet";
import { presignGetUrl } from "../aws/sigv4";
import { track, brainFact } from "../hooks";
import { notifyUser } from "../notify";

const APP = "avaolx";
const REFUND_WINDOW = 24 * 60 * 60_000;

// Auto-generate a tidy "2-page" listing body from short input (§10.6).
function autoListing(title: string, kind: string, notes: string, category?: string, price?: number): string {
  const head = `# ${title}\n\n`;
  const meta = `**Type:** ${kind === "digital" ? "Digital product" : "For sale (physical)"}` +
    (category ? `  ·  **Category:** ${category}` : "") +
    (kind === "digital" && price ? `  ·  **Price:** ${price} AvaCoins` : "") + "\n\n";
  const body = (notes || "").trim() ||
    "The seller hasn't added details yet. Contact them via AvaChat for more information.";
  const footer = kind === "digital"
    ? "\n\n---\n*Instant delivery after purchase. 24-hour refund if you haven't downloaded.*"
    : "\n\n---\n*Physical item — arrange payment & pickup directly with the seller via AvaChat. AvaTalk does not process money for physical goods.*";
  return head + meta + body + footer;
}

// POST /api/olx/listings  { kind, title, notes, category, price_coins?, location?, image_hashes? }
export async function olxCreate(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  if (!(await kycVerified(env, ctx.uid))) return json({ error: "verification required to list", reason: "tier2" }, 403);

  const b = (await req.json().catch(() => ({}))) as any;
  const kind = b.kind === "digital" ? "digital" : "physical";
  if (!b.title) return json({ error: "title required" }, 400);
  const price = kind === "digital" ? Math.max(1, Math.trunc(Number(b.price_coins || 0))) : 0;
  if (kind === "digital" && !(price >= 1)) return json({ error: "digital products need price_coins>=1" }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();
  const desc = autoListing(String(b.title), kind, String(b.notes || b.description || ""), b.category, price);
  await mediaDb(env).prepare(
    `INSERT INTO olx_listings (id, seller_npub, kind, title, description, category, price_coins, location, image_hashes, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'active',?10,?10)`,
  ).bind(id, ctx.uid, kind, String(b.title), desc, b.category ?? null, price, kind === "physical" ? (b.location ?? null) : null, b.image_hashes ? JSON.stringify(b.image_hashes) : null, now).run();

  track(env, ctx.uid, "olx_listing_created", APP, { kind, price });
  brainFact(env, ctx.uid, "olx_listed", APP, { kind, title: b.title, price });
  return json({ ok: true, listing_id: id, kind, needs_file: kind === "digital" });
}

// GET /api/olx/listings — browse (open / Tier 1).
export async function olxBrowse(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url).searchParams;
  const kind = u.get("kind"); const category = u.get("category"); const seller = u.get("seller");
  const where: string[] = ["status='active'"]; const binds: any[] = [];
  if (kind) { binds.push(kind); where.push(`kind=?${binds.length}`); }
  if (category) { binds.push(category); where.push(`category=?${binds.length}`); }
  if (seller) { binds.push(seller); where.push(`seller_npub=?${binds.length}`); }
  const rs = await mediaSession(env).prepare(
    `SELECT id, seller_npub, kind, title, description, category, price_coins, location, image_hashes, created_at FROM olx_listings WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 50`,
  ).bind(...binds).all();
  return json({ listings: rs.results ?? [] });
}

export async function olxGet(req: Request, env: Env, id: string): Promise<Response> {
  const row = await mediaSession(env).prepare(
    "SELECT id, seller_npub, kind, title, description, category, price_coins, location, image_hashes, status, created_at FROM olx_listings WHERE id=?1",
  ).bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  return json({ listing: row });
}

export async function olxUpdate(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await mediaDb(env).prepare("SELECT seller_npub, kind FROM olx_listings WHERE id=?1").bind(id).first<any>();
  if (!row || row.seller_npub !== ctx.uid) return json({ error: "not found" }, 404);
  const b = (await req.json().catch(() => ({}))) as any;
  const desc = b.title || b.notes ? autoListing(String(b.title || ""), row.kind, String(b.notes || ""), b.category, b.price_coins) : null;
  await mediaDb(env).prepare(
    "UPDATE olx_listings SET title=COALESCE(?2,title), description=COALESCE(?3,description), category=COALESCE(?4,category), price_coins=COALESCE(?5,price_coins), location=COALESCE(?6,location), updated_at=?7 WHERE id=?1",
  ).bind(id, b.title ?? null, desc, b.category ?? null, b.price_coins ?? null, b.location ?? null, Date.now()).run();
  return json({ ok: true });
}

export async function olxDelete(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const row = await mediaDb(env).prepare("SELECT seller_npub FROM olx_listings WHERE id=?1").bind(id).first<any>();
  if (!row || row.seller_npub !== ctx.uid) return json({ error: "not found" }, 404);
  await mediaDb(env).prepare("UPDATE olx_listings SET status='closed', updated_at=?2 WHERE id=?1").bind(id, Date.now()).run();
  return json({ ok: true });
}

// POST /api/olx/listings/:id/file — seller uploads the digital deliverable (bytes).
export async function olxUploadFile(req: Request, env: Env, id: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const listing = await mediaDb(env).prepare("SELECT seller_npub, kind FROM olx_listings WHERE id=?1").bind(id).first<any>();
  if (!listing || listing.seller_npub !== ctx.uid) return json({ error: "not found" }, 404);
  if (listing.kind !== "digital") return json({ error: "not a digital product" }, 400);

  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "empty body" }, 400);
  const fileName = req.headers.get("x-file-name") || "download.bin";
  const mime = req.headers.get("x-content-type") || "application/octet-stream";
  const r2Key = `u/${ctx.uid}/digital/${id}/${await sha256Hex(bytes)}`;
  await env.DIGITAL.put(r2Key, bytes, { httpMetadata: { contentType: mime } });

  await mediaDb(env).prepare(
    `INSERT INTO olx_digital_products (listing_id, seller_npub, r2_key, file_name, mime, size_bytes, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7)
     ON CONFLICT(listing_id) DO UPDATE SET r2_key=?3, file_name=?4, mime=?5, size_bytes=?6`,
  ).bind(id, ctx.uid, r2Key, fileName, mime, bytes.byteLength, Date.now()).run();
  return json({ ok: true, size_bytes: bytes.byteLength });
}

// POST /api/olx/buy  { listing_id }
export async function olxBuy(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const listingId = String(b.listing_id || "");
  const listing = await mediaDb(env).prepare(
    "SELECT id, seller_npub, kind, title, price_coins, status FROM olx_listings WHERE id=?1",
  ).bind(listingId).first<any>();
  if (!listing || listing.status !== "active") return json({ error: "listing not available" }, 404);
  if (listing.kind !== "digital") return json({ error: "physical goods: contact the seller via AvaChat", contact: listing.seller_npub }, 400);
  if (listing.seller_npub === ctx.uid) return json({ error: "cannot buy your own product" }, 400);

  const product = await mediaDb(env).prepare("SELECT r2_key FROM olx_digital_products WHERE listing_id=?1").bind(listingId).first<any>();
  if (!product) return json({ error: "product file not uploaded yet" }, 409);

  // Pay: debit buyer → credit seller minus 15% commission (avaolx), 7-day hold.
  const t = await transferCoins(env, ctx.uid, listing.seller_npub, listing.price_coins, APP, `olx:${listingId}`);
  if (!t.ok) return json({ error: "payment failed", detail: t.body }, t.status === 402 ? 402 : 502);

  const purchaseId = crypto.randomUUID();
  const now = Date.now();
  await mediaDb(env).prepare(
    `INSERT INTO olx_purchases (id, listing_id, buyer_npub, seller_npub, price_coins, commission, status, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,'paid',?7)`,
  ).bind(purchaseId, listingId, ctx.uid, listing.seller_npub, listing.price_coins, t.commission, now).run();

  brainFact(env, ctx.uid, "olx_purchased", APP, { title: listing.title, price: listing.price_coins });
  track(env, ctx.uid, "olx_purchase", APP, { price: listing.price_coins, commission: t.commission });
  try { await notifyUser(env, listing.seller_npub, { type: "wallet", title: "Product sold", body: listing.title, data: { deeplink: "/wallet" } }); } catch { /* best-effort */ }
  return json({ ok: true, purchase_id: purchaseId, download_path: `/api/olx/downloads/${purchaseId}/file` });
}

// POST /api/olx/refund { purchase_id } — 24h refund if NOT downloaded (§10.6).
export async function olxRefund(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const b = (await req.json().catch(() => ({}))) as any;
  const pur = await mediaDb(env).prepare(
    "SELECT id, buyer_npub, seller_npub, price_coins, commission, status, created_at FROM olx_purchases WHERE id=?1",
  ).bind(String(b.purchase_id || "")).first<any>();
  if (!pur || pur.buyer_npub !== ctx.uid) return json({ error: "purchase not found" }, 404);
  if (pur.status !== "paid") return json({ error: "not refundable", reason: pur.status }, 409); // downloaded/refunded
  if (Date.now() - pur.created_at > REFUND_WINDOW) return json({ error: "refund window (24h) expired" }, 409);

  // Refund the buyer; claw the seller's held net back.
  const sellerNet = pur.price_coins - pur.commission;
  await walletOpRefund(env, ctx.uid, pur.price_coins, pur.id);
  await env.WALLET_DO.get(env.WALLET_DO.idFromName(pur.seller_npub)).fetch("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "debit_hold", uid: pur.seller_npub, amount: sellerNet, app_name: APP, ref: pur.id }),
  });
  await mediaDb(env).prepare("UPDATE olx_purchases SET status='refunded' WHERE id=?1").bind(pur.id).run();
  track(env, ctx.uid, "olx_refund", APP, { price: pur.price_coins });
  return json({ ok: true, refunded: pur.price_coins });
}

async function walletOpRefund(env: Env, uid: string, amount: number, ref: string): Promise<void> {
  await env.WALLET_DO.get(env.WALLET_DO.idFromName(uid)).fetch("https://wallet/op", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "credit", uid, amount, type: "refund", app_name: APP, ref }),
  });
}

// GET /api/olx/downloads — my purchases.
export async function olxDownloads(req: Request, env: Env): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const rs = await mediaSession(env).prepare(
    "SELECT id, listing_id, price_coins, status, downloaded_at, created_at FROM olx_purchases WHERE buyer_npub=?1 ORDER BY created_at DESC LIMIT 50",
  ).bind(ctx.uid).all();
  return json({ purchases: rs.results ?? [] });
}

// GET /api/olx/downloads/:id/file — signed download; marks downloaded (ends refund window).
export async function olxDownloadFile(req: Request, env: Env, purchaseId: string): Promise<Response> {
  const ctx = await requireUser(req, env);
  if (isFail(ctx)) return json({ error: ctx.error }, ctx.status);
  const pur = await mediaDb(env).prepare(
    "SELECT id, listing_id, buyer_npub, status FROM olx_purchases WHERE id=?1",
  ).bind(purchaseId).first<any>();
  if (!pur || pur.buyer_npub !== ctx.uid) return json({ error: "not found" }, 404);
  if (pur.status === "refunded") return json({ error: "purchase was refunded" }, 410);

  const product = await mediaDb(env).prepare("SELECT r2_key, file_name, mime FROM olx_digital_products WHERE listing_id=?1").bind(pur.listing_id).first<any>();
  if (!product) return json({ error: "file missing" }, 404);

  // Mark downloaded (closes the 24h refund window) on first download.
  if (pur.status !== "downloaded") {
    await mediaDb(env).prepare("UPDATE olx_purchases SET status='downloaded', downloaded_at=?2 WHERE id=?1").bind(purchaseId, Date.now()).run();
  }
  track(env, ctx.uid, "olx_download", APP, {});

  // Preferred: a presigned R2 URL (bytes never through the Worker). Fallback: stream.
  if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ACCOUNT_ID) {
    const url = await presignGetUrl({
      url: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/avatok-digital/${product.r2_key}`,
      region: "auto", service: "s3",
      accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      expiresSec: 300,
    });
    return json({ url, expires_sec: 300, file_name: product.file_name });
  }
  // Fallback (R2 S3 creds unset): stream the object through the Worker.
  const obj = await env.DIGITAL.get(product.r2_key);
  if (!obj) return json({ error: "file missing" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": product.mime || "application/octet-stream",
      "content-disposition": `attachment; filename="${(product.file_name || "download.bin").replace(/"/g, "")}"`,
    },
  });
}

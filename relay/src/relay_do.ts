// RelayRoom — single global Nostr relay DO. Uses the WebSocket HIBERNATION API
// (state.acceptWebSocket) so idle chat connections do NOT keep the DO resident /
// billed: the runtime can evict it from memory and wake it on the next message.
// Per-connection state (auth, challenge, subscriptions) therefore can't live in
// an in-memory Map — it rides in each socket's serialized attachment (survives
// hibernation). All events persist to D1 (DB_RELAY). NIP-42 gates private kinds;
// PUSH_KINDS enqueue Q_PUSH for DM/call events.
import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hexToNpub } from "./nip19";
import type { Env } from "./index";

interface NostrEvent {
  id: string; pubkey: string; created_at: number; kind: number;
  tags: string[][]; content: string; sig: string;
}
type Filter = {
  ids?: string[]; authors?: string[]; kinds?: number[];
  since?: number; until?: number; limit?: number; [tag: string]: unknown;
};
// Stored in the socket attachment (must be JSON/structured-clone friendly, so
// `subs` is a plain Record, not a Map). Attachment cap is ~2 KB — ample for the
// handful of filters a Nostr client subscribes with.
interface ConnState { authed: boolean; pubkey: string | null; challenge: string; subs: Record<string, Filter[]>; }

// Private kinds: only readable/writable by the authed owner (NIP-42).
const PRIVATE_KINDS = new Set([13, 14, 1059, 25050, 10050, 10443]);
// Kinds that wake a recipient via push (DM gift wrap, call signaling).
const PUSH_KINDS = new Set([1059, 25050]);
// PUBLIC kinds the brain may learn from (plaintext, server-visible). NEVER DM
// kinds — DM facts are extracted client-side and synced via /api/brain/remember.
const BRAIN_KINDS = new Set([1, 30023]); // public post, long-form article

function hex(b: Uint8Array): string { let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s; }
function serializeId(e: NostrEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]));
}
function verifyEvent(e: NostrEvent): boolean {
  try { if (hex(sha256(serializeId(e))) !== e.id) return false; return schnorr.verify(e.sig, e.id, e.pubkey); }
  catch { return false; }
}
function jsonResp(d: unknown, status = 200): Response {
  return new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

export class RelayRoom {
  private env: Env;
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) { this.env = env; this.state = state; }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/export") return this.handleExport(url);
    // Internal fan-out: another user's DO forwards a DM/mention here for real-time
    // delivery to this user's connected devices. Not reachable from the public
    // router (called only via DO stub).
    if (url.pathname === "/deliver" && req.method === "POST") {
      const e = (await req.json().catch(() => null)) as NostrEvent | null;
      if (e && e.id) this.localDeliver(e);
      return jsonResp({ ok: true });
    }
    // Internal: a system notification for this user — push a ["NOTIF", …] frame to
    // their authed sockets (in-app realtime; not Nostr, not E2E). Called by the API/
    // consumer Workers via a cross-script DO binding.
    if (url.pathname === "/notify" && req.method === "POST") {
      const n = await req.json().catch(() => null);
      if (n) for (const sock of this.state.getWebSockets()) {
        if (this.getConn(sock).authed) this.send(sock, ["NOTIF", n]);
      }
      return jsonResp({ ok: true });
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    // Hibernation: hand the socket to the runtime instead of accept() + listeners.
    this.state.acceptWebSocket(server);
    const challenge = crypto.randomUUID();
    this.setConn(server, { authed: false, pubkey: null, challenge, subs: {} });
    this.send(server, ["AUTH", challenge]); // NIP-42 challenge up front
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- per-connection state via socket attachment (survives hibernation) ----
  private getConn(ws: WebSocket): ConnState {
    return (ws.deserializeAttachment() as ConnState) ?? { authed: false, pubkey: null, challenge: "", subs: {} };
  }
  private setConn(ws: WebSocket, c: ConnState) { ws.serializeAttachment(c); }

  private send(ws: WebSocket, msg: unknown) { try { ws.send(JSON.stringify(msg)); } catch { /* gone */ } }

  // ---- Hibernation handlers (called by the runtime; wake the DO on demand) ----
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg: unknown[];
    try { msg = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case "EVENT": return void this.handleEvent(ws, msg[1] as NostrEvent);
      case "REQ": return void this.handleReq(ws, msg[1] as string, msg.slice(2) as Filter[]);
      case "CLOSE": {
        const conn = this.getConn(ws);
        if (conn.subs[msg[1] as string]) { delete conn.subs[msg[1] as string]; this.setConn(ws, conn); }
        return;
      }
      case "AUTH": return this.handleAuth(ws, msg[1] as NostrEvent);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    try { ws.close(code <= 1000 || code >= 3000 ? code : 1000); } catch { /* already closed */ }
  }

  async webSocketError(_ws: WebSocket, _err: unknown) { /* socket dropped; nothing to clean up (state is in the attachment) */ }

  // NIP-42: client returns a kind-22242 event echoing our challenge.
  private handleAuth(ws: WebSocket, e: NostrEvent) {
    const conn = this.getConn(ws);
    if (!e || e.kind !== 22242 || !verifyEvent(e)) { this.send(ws, ["OK", e?.id ?? "", false, "auth: invalid"]); return; }
    const challenge = e.tags.find((t) => t[0] === "challenge")?.[1];
    if (challenge !== conn.challenge) { this.send(ws, ["OK", e.id, false, "auth: challenge mismatch"]); return; }
    if (Math.abs(Math.floor(Date.now() / 1000) - e.created_at) > 600) { this.send(ws, ["OK", e.id, false, "auth: stale"]); return; }
    conn.authed = true; conn.pubkey = e.pubkey;
    this.setConn(ws, conn);
    this.send(ws, ["OK", e.id, true, ""]);
  }

  private async handleEvent(ws: WebSocket, e: NostrEvent) {
    const conn = this.getConn(ws);
    if (!e || !e.id || !e.sig || !verifyEvent(e)) { this.send(ws, ["OK", e?.id ?? "", false, "invalid: bad id or signature"]); return; }
    if (PRIVATE_KINDS.has(e.kind) && !conn.authed) {
      this.send(ws, ["OK", e.id, false, "auth-required: AUTH before publishing this kind"]); return;
    }
    try { await this.persist(e); }
    catch { this.send(ws, ["OK", e.id, false, "error: storage"]); return; }
    this.send(ws, ["OK", e.id, true, ""]);
    try { this.env.ANALYTICS?.writeDataPoint({ blobs: ["relay_event", String(e.kind)], doubles: [1], indexes: ["relay"] }); } catch { /* best-effort */ }
    this.localDeliver(e);   // this user's other devices (same inbox DO)
    await this.fanOut(e);   // DM/mention recipients (other users' inbox DOs)
    if (PUSH_KINDS.has(e.kind)) await this.enqueuePush(e);
    if (BRAIN_KINDS.has(e.kind) && !PRIVATE_KINDS.has(e.kind)) await this.enqueueBrain(e);
  }

  // AvaBrain learns from PUBLIC content only. content is already plaintext for
  // these kinds; we never enqueue DM/private kinds.
  private async enqueueBrain(e: NostrEvent) {
    const npub = hexToNpub(e.pubkey);
    if (!npub) return;
    try {
      await this.env.Q_BRAIN.send({
        npub,
        event_type: e.kind === 30023 ? "article_created" : "post_created",
        source_app: "avatweet",
        payload: { kind: e.kind, content: (e.content || "").slice(0, 4000), tags: e.tags.filter((t) => t[0] === "t" || t[0] === "title") },
        ts: Date.now(),
      });
    } catch { /* queue best-effort */ }
  }

  // Real-time fan-out to #p recipients' inbox DOs. Public posts (no #p) need no
  // fan-out — readers pick them up via REQ→D1. Self (#p == publisher) is already
  // covered by localDeliver, so we skip it here.
  private async fanOut(e: NostrEvent) {
    const recipients = new Set(
      e.tags.filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1] || "")).map((t) => t[1]),
    );
    recipients.delete(e.pubkey);
    for (const pk of recipients) {
      try {
        const stub = this.env.RELAY.get(this.env.RELAY.idFromName(pk));
        await stub.fetch("https://relay/deliver", { method: "POST", body: JSON.stringify(e) });
      } catch { /* recipient offline / no DO — push (Q_PUSH) still wakes them */ }
    }
  }

  private async persist(e: NostrEvent) {
    const db = this.env.DB_RELAY;
    const stmts: D1PreparedStatement[] = [];

    // Replaceable (NIP-01): kind 0, 3, 10000-19999 — keep only newest per (pubkey, kind).
    if (e.kind === 0 || e.kind === 3 || (e.kind >= 10000 && e.kind < 20000)) {
      stmts.push(db.prepare("DELETE FROM nostr_tags WHERE event_id IN (SELECT id FROM nostr_events WHERE pubkey=?1 AND kind=?2)").bind(e.pubkey, e.kind));
      stmts.push(db.prepare("DELETE FROM nostr_events WHERE pubkey=?1 AND kind=?2").bind(e.pubkey, e.kind));
    }
    // Parameterized replaceable: 30000-39999 — newest per (pubkey, kind, d-tag).
    else if (e.kind >= 30000 && e.kind < 40000) {
      const d = e.tags.find((t) => t[0] === "d")?.[1] ?? "";
      stmts.push(db.prepare(
        "DELETE FROM nostr_tags WHERE event_id IN (SELECT ev.id FROM nostr_events ev JOIN nostr_tags t ON t.event_id=ev.id WHERE ev.pubkey=?1 AND ev.kind=?2 AND t.tag='d' AND t.value=?3)",
      ).bind(e.pubkey, e.kind, d));
      stmts.push(db.prepare(
        "DELETE FROM nostr_events WHERE id IN (SELECT ev.id FROM nostr_events ev JOIN nostr_tags t ON t.event_id=ev.id WHERE ev.pubkey=?1 AND ev.kind=?2 AND t.tag='d' AND t.value=?3)",
      ).bind(e.pubkey, e.kind, d));
    }
    // NIP-09 deletion: mark referenced events (same author) deleted.
    if (e.kind === 5) {
      for (const t of e.tags) if (t[0] === "e" && t[1]) {
        stmts.push(db.prepare("UPDATE nostr_events SET deleted=1 WHERE id=?1 AND pubkey=?2").bind(t[1], e.pubkey));
      }
    }

    stmts.push(db.prepare(
      "INSERT OR IGNORE INTO nostr_events (id,pubkey,created_at,kind,tags,content,sig,deleted) VALUES (?1,?2,?3,?4,?5,?6,?7,0)",
    ).bind(e.id, e.pubkey, e.created_at, e.kind, JSON.stringify(e.tags), e.content, e.sig));

    for (const t of e.tags) {
      if (typeof t[0] === "string" && t[0].length === 1 && typeof t[1] === "string") {
        stmts.push(db.prepare(
          "INSERT OR IGNORE INTO nostr_tags (event_id,tag,value,kind,created_at) VALUES (?1,?2,?3,?4,?5)",
        ).bind(e.id, t[0], t[1], e.kind, e.created_at));
      }
    }
    await db.batch(stmts);
  }

  // Deliver to the sockets connected to THIS inbox DO (one user's 1-3 devices) —
  // O(devices), not O(all connections). Used for the publisher's own echo and for
  // events forwarded here from another user's DO via /deliver.
  private localDeliver(e: NostrEvent) {
    for (const sock of this.state.getWebSockets()) {
      const conn = this.getConn(sock);
      if (!this.canReceive(conn, e)) continue;
      for (const subId of Object.keys(conn.subs)) {
        if (conn.subs[subId].some((f) => matches(f, e))) this.send(sock, ["EVENT", subId, e]);
      }
    }
  }

  // Private events only reach their author or a #p recipient who is authed.
  private canReceive(conn: ConnState, e: NostrEvent): boolean {
    if (!PRIVATE_KINDS.has(e.kind)) return true;
    if (!conn.authed || !conn.pubkey) return false;
    if (e.pubkey === conn.pubkey) return true;
    return e.tags.some((t) => t[0] === "p" && t[1] === conn.pubkey);
  }

  private async enqueuePush(e: NostrEvent) {
    const recipients = e.tags.filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]);
    for (const pk of recipients) {
      try {
        await this.env.Q_PUSH.send({
          kind: "relay-event", event_kind: e.kind, event_id: e.id,
          to_pubkey: pk, to_npub: hexToNpub(pk), from_pubkey: e.pubkey, ts: Date.now(),
        });
      } catch { /* queue best-effort */ }
    }
  }

  private async handleReq(ws: WebSocket, subId: string, filters: Filter[]) {
    const conn = this.getConn(ws);
    conn.subs[subId] = filters;
    this.setConn(ws, conn);
    const seen = new Set<string>();
    for (const f of filters) {
      for (const e of await this.queryFilter(f, conn)) {
        if (!seen.has(e.id)) { seen.add(e.id); this.send(ws, ["EVENT", subId, e]); }
      }
    }
    this.send(ws, ["EOSE", subId]);
  }

  // D1 caps a query at 100 bound parameters. A single REQ filter can carry large
  // arrays (authors for a feed, ids, #p/#e tag values), so we chunk every array
  // dimension and run the cartesian of chunks, merging + deduping by event id.
  // Chunk size is sized so the SUM of array params per query stays under 100.
  private async queryFilter(f: Filter, conn: ConnState): Promise<NostrEvent[]> {
    const kinds = Array.isArray(f.kinds) ? f.kinds : [];
    const wantsPrivate = kinds.some((k) => PRIVATE_KINDS.has(k));
    if (wantsPrivate && (!conn.authed || !conn.pubkey)) return []; // NIP-42 gate

    const limit = Math.min(typeof f.limit === "number" ? f.limit : 100, 500);

    // Active array dimensions (kinds is kept whole — always small).
    const dims: { kind: "ids" | "authors" | "tag"; letter?: string; vals: string[] }[] = [];
    if (Array.isArray(f.ids) && f.ids.length) dims.push({ kind: "ids", vals: f.ids as string[] });
    if (Array.isArray(f.authors) && f.authors.length) dims.push({ kind: "authors", vals: f.authors as string[] });
    for (const key of Object.keys(f)) {
      if (key.length !== 2 || !key.startsWith("#")) continue;
      const vals = f[key];
      if (Array.isArray(vals) && vals.length) dims.push({ kind: "tag", letter: key.slice(1), vals: vals as string[] });
    }

    const fixed = kinds.length + (typeof f.since === "number" ? 1 : 0) + (typeof f.until === "number" ? 1 : 0) + (wantsPrivate ? 2 : 0);
    const per = dims.length ? Math.max(1, Math.floor((95 - fixed) / dims.length)) : 90;
    const perDimChunks = dims.map((d) => chunk(d.vals, per).map((c) => ({ d, c })));
    const combos = cartesian(perDimChunks); // [] dims → [[]]
    if (combos.length > 64) combos.length = 64; // safety cap against pathological filters

    const merged = new Map<string, NostrEvent>();
    for (const combo of combos) {
      const where: string[] = ["e.deleted=0"];
      const params: unknown[] = [];
      let i = 1;
      for (const { d, c } of combo) {
        if (d.kind === "ids") { where.push(`e.id IN (${c.map(() => `?${i++}`).join(",")})`); params.push(...c); }
        else if (d.kind === "authors") { where.push(`e.pubkey IN (${c.map(() => `?${i++}`).join(",")})`); params.push(...c); }
        else { where.push(`EXISTS (SELECT 1 FROM nostr_tags t WHERE t.event_id=e.id AND t.tag=?${i++} AND t.value IN (${c.map(() => `?${i++}`).join(",")}))`); params.push(d.letter, ...c); }
      }
      if (kinds.length) { where.push(`e.kind IN (${kinds.map(() => `?${i++}`).join(",")})`); params.push(...kinds); }
      if (typeof f.since === "number") { where.push(`e.created_at >= ?${i++}`); params.push(f.since); }
      if (typeof f.until === "number") { where.push(`e.created_at <= ?${i++}`); params.push(f.until); }
      if (wantsPrivate) {
        where.push(`(e.pubkey=?${i++} OR EXISTS (SELECT 1 FROM nostr_tags tp WHERE tp.event_id=e.id AND tp.tag='p' AND tp.value=?${i++}))`);
        params.push(conn.pubkey, conn.pubkey);
      }
      const sql = `SELECT e.id,e.pubkey,e.created_at,e.kind,e.tags,e.content,e.sig FROM nostr_events e WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT ${limit}`;
      const rs = await this.env.DB_RELAY.prepare(sql).bind(...params).all();
      for (const row of rs.results ?? []) { const e = rowToEvent(row); if (!merged.has(e.id)) merged.set(e.id, e); }
    }
    return [...merged.values()].sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }

  private async handleExport(url: URL): Promise<Response> {
    const pubkey = (url.searchParams.get("pubkey") || "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(pubkey)) return jsonResp({ error: "bad pubkey" }, 400);
    const rs = await this.env.DB_RELAY.prepare(
      `SELECT DISTINCT e.id,e.pubkey,e.created_at,e.kind,e.tags,e.content,e.sig
       FROM nostr_events e LEFT JOIN nostr_tags t ON t.event_id=e.id
       WHERE e.deleted=0 AND (e.pubkey=?1 OR (e.kind=1059 AND t.tag='p' AND t.value=?1))
       ORDER BY e.created_at DESC LIMIT 10000`,
    ).bind(pubkey).all();
    const events = (rs.results ?? []).map(rowToEvent);
    return jsonResp({ pubkey, count: events.length, exported_at: Date.now(), events });
  }
}

function rowToEvent(r: any): NostrEvent {
  return { id: r.id, pubkey: r.pubkey, created_at: r.created_at, kind: r.kind, tags: JSON.parse(r.tags), content: r.content, sig: r.sig };
}

// Split an array into batches (D1 ≤100 bound params per query).
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += Math.max(1, size)) out.push(arr.slice(i, i + Math.max(1, size)));
  return out;
}
// Cartesian product of per-dimension chunk lists. Empty input → [[]].
function cartesian<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((acc, list) => acc.flatMap((prefix) => list.map((item) => [...prefix, item])), [[]]);
}

function matches(f: Filter, e: NostrEvent): boolean {
  if (Array.isArray(f.ids) && f.ids.length && !f.ids.includes(e.id)) return false;
  if (Array.isArray(f.authors) && f.authors.length && !f.authors.includes(e.pubkey)) return false;
  if (Array.isArray(f.kinds) && f.kinds.length && !f.kinds.includes(e.kind)) return false;
  if (typeof f.since === "number" && e.created_at < f.since) return false;
  if (typeof f.until === "number" && e.created_at > f.until) return false;
  for (const k of Object.keys(f)) {
    if (k.length !== 2 || !k.startsWith("#")) continue;
    const vals = f[k]; if (!Array.isArray(vals)) continue;
    const letter = k.slice(1);
    if (!e.tags.some((t) => t[0] === letter && (vals as string[]).includes(t[1]))) return false;
  }
  return true;
}
